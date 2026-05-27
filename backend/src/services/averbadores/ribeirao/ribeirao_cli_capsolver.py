"""Executes ribeirao_cli.py with Capsolver support injected at runtime.

The original worker is large and shared by several portal flows. This wrapper
keeps the base file intact and applies the smallest targeted patch needed for
portals that show reCAPTCHA during login, such as Santana de Parnaiba.
"""

from __future__ import annotations

from pathlib import Path


CAPSOLVER_HELPERS = r'''
def _capsolver_api_key() -> str:
    return (
        os.getenv("CAPSOLVER_API_KEY")
        or os.getenv("CAPSOLVE_API_KEY")
        or os.getenv("CAPTCHA_SOLVER_API_KEY")
        or ""
    ).strip()


def _capsolver_enabled() -> bool:
    key = _capsolver_api_key()
    if not key:
        return False
    return _parse_bool(
        os.getenv("CAPSOLVER_ENABLED")
        or os.getenv("CAPTCHA_SOLVER_ENABLED")
        or os.getenv("CAPTCHA_ENGINE_ENABLED"),
        True,
    )


def _capsolver_timeout_seconds() -> int:
    try:
        return max(30, min(240, int(os.getenv("CAPSOLVER_TIMEOUT_SECONDS") or "120")))
    except Exception:
        return 120


def _post_json_sync(url: str, payload: dict, timeout_seconds: int = 30) -> dict:
    from urllib import error as urllib_error
    from urllib import request as urllib_request

    body = json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib_request.urlopen(req, timeout=timeout_seconds) as response:
            raw = response.read().decode("utf-8", errors="replace")
            return json.loads(raw or "{}")
    except urllib_error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            return json.loads(raw or "{}")
        except Exception:
            return {"errorId": exc.code, "errorDescription": raw or str(exc)}


async def _extract_recaptcha_metadata(connector: PortalSecundarioLegacyConnector) -> dict:
    script = """() => {
      const pick = (value) => String(value || "").trim();
      const fromSrc = (src) => {
        try {
          const url = new URL(String(src || ""), location.href);
          const key = pick(url.searchParams.get("k") || url.searchParams.get("sitekey"));
          if (!key) return null;
          return {
            siteKey: key,
            pageUrl: location.href,
            enterprise: /recaptcha\\/enterprise/i.test(url.pathname + url.hostname),
            apiDomain: /recaptcha\\.net/i.test(url.hostname) ? "recaptcha.net" : "google.com",
          };
        } catch (_) {
          return null;
        }
      };
      for (const node of Array.from(document.querySelectorAll("[data-sitekey]"))) {
        const key = pick(node.getAttribute("data-sitekey"));
        if (key) {
          return { siteKey: key, pageUrl: location.href, enterprise: Boolean(node.closest("[data-enterprise='true']")), apiDomain: "google.com" };
        }
      }
      for (const frame of Array.from(document.querySelectorAll("iframe[src*='recaptcha' i], iframe[src*='google.com/recaptcha' i], iframe[src*='recaptcha.net' i]"))) {
        const found = fromSrc(frame.getAttribute("src"));
        if (found) return found;
      }
      return { siteKey: "", pageUrl: location.href, enterprise: false, apiDomain: "google.com" };
    }"""
    candidates: list[dict] = []
    try:
        candidates.append(await connector.page.evaluate(script))
    except Exception:
        pass
    try:
        for frame in list(connector.page.frames)[1:]:
            try:
                candidates.append(await frame.evaluate(script))
            except Exception:
                continue
    except Exception:
        pass
    for item in candidates:
        if item and item.get("siteKey"):
            return item
    return candidates[0] if candidates else {"siteKey": "", "pageUrl": "", "enterprise": False, "apiDomain": "google.com"}


async def _capsolver_solve_recaptcha(metadata: dict) -> str:
    api_key = _capsolver_api_key()
    site_key = str(metadata.get("siteKey") or "").strip()
    website_url = str(metadata.get("pageUrl") or "").strip()
    if not api_key or not site_key or not website_url:
        return ""

    task = {
        "type": "ReCaptchaV2EnterpriseTaskProxyLess" if metadata.get("enterprise") else "ReCaptchaV2TaskProxyLess",
        "websiteURL": website_url,
        "websiteKey": site_key,
    }
    if str(metadata.get("apiDomain") or "").lower() == "recaptcha.net":
        task["apiDomain"] = "recaptcha.net"

    create_result = await asyncio.to_thread(_post_json_sync, "https://api.capsolver.com/createTask", {"clientKey": api_key, "task": task}, 30)
    if create_result.get("errorId"):
        print(f"[CAPSOLVER] createTask falhou: {create_result.get('errorCode') or create_result.get('errorDescription') or 'erro'}", file=sys.stderr, flush=True)
        return ""
    task_id = str(create_result.get("taskId") or "").strip()
    if not task_id:
        print("[CAPSOLVER] createTask sem taskId.", file=sys.stderr, flush=True)
        return ""

    deadline = asyncio.get_running_loop().time() + _capsolver_timeout_seconds()
    while asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(3)
        result = await asyncio.to_thread(_post_json_sync, "https://api.capsolver.com/getTaskResult", {"clientKey": api_key, "taskId": task_id}, 30)
        if result.get("errorId"):
            print(f"[CAPSOLVER] getTaskResult falhou: {result.get('errorCode') or result.get('errorDescription') or 'erro'}", file=sys.stderr, flush=True)
            return ""
        if result.get("status") == "ready":
            return str((result.get("solution") or {}).get("gRecaptchaResponse") or "").strip()
    print("[CAPSOLVER] tempo limite aguardando token.", file=sys.stderr, flush=True)
    return ""


async def _inject_recaptcha_token(connector: PortalSecundarioLegacyConnector, token: str) -> bool:
    if not token:
        return False
    script = """(token) => {
      const setValue = (el) => {
        if (!el) return false;
        el.value = token;
        el.innerHTML = token;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      };
      const ensureTextarea = () => {
        let el = document.querySelector("textarea[name='g-recaptcha-response'], #g-recaptcha-response");
        if (!el) {
          el = document.createElement("textarea");
          el.name = "g-recaptcha-response";
          el.id = "g-recaptcha-response";
          el.style.display = "none";
          (document.querySelector("form") || document.body || document.documentElement).appendChild(el);
        }
        return el;
      };
      let changed = setValue(ensureTextarea());
      for (const el of Array.from(document.querySelectorAll("textarea[name='g-recaptcha-response'], textarea[id*='g-recaptcha-response']"))) {
        changed = setValue(el) || changed;
      }
      const seen = new Set();
      const callbacks = [];
      const walk = (obj) => {
        if (!obj || typeof obj !== "object" || seen.has(obj)) return;
        seen.add(obj);
        for (const key of Object.keys(obj)) {
          let value;
          try { value = obj[key]; } catch (_) { continue; }
          if (key === "callback" && typeof value === "function") callbacks.push(value);
          else if (value && typeof value === "object") walk(value);
        }
      };
      try { walk(window.___grecaptcha_cfg); } catch (_) {}
      for (const callback of callbacks) {
        try { callback(token); changed = true; } catch (_) {}
      }
      return changed;
    }"""
    injected = False
    try:
        injected = bool(await connector.page.evaluate(script, token)) or injected
    except Exception:
        pass
    try:
        for frame in list(connector.page.frames)[1:]:
            try:
                injected = bool(await frame.evaluate(script, token)) or injected
            except Exception:
                continue
    except Exception:
        pass
    return injected


async def _solve_recaptcha_with_capsolver(connector: PortalSecundarioLegacyConnector, stage: str) -> bool:
    if getattr(connector, "_capsolver_token_injected", False):
        return True
    if not _capsolver_enabled():
        print("[CAPSOLVER] desativado ou sem chave; mantendo validacao manual.", file=sys.stderr, flush=True)
        return False
    metadata = await _extract_recaptcha_metadata(connector)
    if not metadata.get("siteKey"):
        print("[CAPSOLVER] sitekey do reCAPTCHA nao encontrada.", file=sys.stderr, flush=True)
        return False
    print(f"[CAPSOLVER] resolvendo reCAPTCHA stage={stage} enterprise={bool(metadata.get('enterprise'))}", file=sys.stderr, flush=True)
    token = await _capsolver_solve_recaptcha(metadata)
    if not token:
        return False
    injected = await _inject_recaptcha_token(connector, token)
    if injected:
        setattr(connector, "_capsolver_token_injected", True)
        print("[CAPSOLVER] token injetado no portal.", file=sys.stderr, flush=True)
        await connector.page.wait_for_timeout(800)
        return True
    print("[CAPSOLVER] token recebido, mas nao foi possivel injetar no portal.", file=sys.stderr, flush=True)
    return False


async def _fill_password_if_visible(connector: PortalSecundarioLegacyConnector, password: str) -> bool:
    if not password:
        return False
    try:
        if await connector._fill_login_password(password):
            return True
    except Exception:
        pass
    for scope in _login_scopes(connector):
        for selector in ["#txtSenha", "input[name='txtSenha']", "input[type='password']", "input[id*='Senha']", "input[name*='Senha']", "input[id*='senha']", "input[name*='senha']"]:
            try:
                locator = scope.locator(selector).first
                await locator.wait_for(state="visible", timeout=1200)
                await locator.fill(password, timeout=3000)
                return True
            except Exception:
                continue
    return False

'''


REPLACEMENTS = [
    ('''
    if post_snapshot.get("captchaFound"):
        raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="selecionar_convenio")
''', '''
    if post_snapshot.get("captchaFound"):
        solved_captcha = await _solve_recaptcha_with_capsolver(connector, "apos-selecao-convenio")
        if not solved_captcha:
            raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="selecionar_convenio")
        post_snapshot = await _capture_login_snapshot(connector)
'''),
    ('''
        if code in {"LOGIN_REJECTED", "CAPTCHA_REQUIRED", "MANUAL_AUTH_REQUIRED"}:
            raise _typed_login_error(code, typed_message, stage="selecionar_convenio")
''', '''
        if code == "CAPTCHA_REQUIRED":
            solved_captcha = await _solve_recaptcha_with_capsolver(connector, "erro-texto-convenio")
            if not solved_captcha:
                raise _typed_login_error(code, typed_message, stage="selecionar_convenio")
            post_snapshot = await _capture_login_snapshot(connector)
        if code in {"LOGIN_REJECTED", "MANUAL_AUTH_REQUIRED"}:
            raise _typed_login_error(code, typed_message, stage="selecionar_convenio")
'''),
    ('''
        try:
            clicked_login, clicked_selector, click_debug = await _click_login_initial_button(connector)
''', '''
        if snapshot.get("passwordFound") and password:
            password_prefilled = await _fill_password_if_visible(connector, password)
            print(f"[LOGIN_FLOW] senha preenchida antes do primeiro submit: {str(password_prefilled).lower()}", file=sys.stderr, flush=True)
            if password_prefilled:
                snapshot = await _capture_login_snapshot(connector)
                _log_login_snapshot(snapshot, login, password, "senha-preenchida-antes-submit")
                _log_login_flow(snapshot, "senha-preenchida-antes-submit", login, password, final_code="PENDING")
        if snapshot.get("captchaFound"):
            solved_captcha = await _solve_recaptcha_with_capsolver(connector, "antes-primeiro-submit")
            if not solved_captcha:
                raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="captcha")
        try:
            clicked_login, clicked_selector, click_debug = await _click_login_initial_button(connector)
'''),
    ('''
        if snapshot.get("captchaFound"):
            raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="captcha")
        if snapshot.get("errorText"):
            code, typed_message = _classify_login_issue(None, snapshot.get("errorText") or '', snapshot)
            if code in {"LOGIN_REJECTED", "CAPTCHA_REQUIRED", "MANUAL_AUTH_REQUIRED"}:
                raise _typed_login_error(code, typed_message, stage="erro_texto_portal")
''', '''
        if snapshot.get("captchaFound"):
            solved_captcha = await _solve_recaptcha_with_capsolver(connector, "apos-primeiro-submit")
            if not solved_captcha:
                raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="captcha")
            snapshot = await _capture_login_snapshot(connector)
        if snapshot.get("errorText"):
            code, typed_message = _classify_login_issue(None, snapshot.get("errorText") or '', snapshot)
            if code == "CAPTCHA_REQUIRED":
                solved_captcha = await _solve_recaptcha_with_capsolver(connector, "erro-texto-apos-primeiro-submit")
                if not solved_captcha:
                    raise _typed_login_error(code, typed_message, stage="erro_texto_portal")
                snapshot = await _capture_login_snapshot(connector)
            if code in {"LOGIN_REJECTED", "MANUAL_AUTH_REQUIRED"}:
                raise _typed_login_error(code, typed_message, stage="erro_texto_portal")
'''),
    ('''
            try:
                clicked_password, clicked_selector, click_debug = await _click_login_initial_button(connector)
''', '''
            if snapshot.get("captchaFound"):
                solved_captcha = await _solve_recaptcha_with_capsolver(connector, "segunda-etapa-antes-submit")
                if not solved_captcha:
                    raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="captcha")
                snapshot = await _capture_login_snapshot(connector)

            try:
                clicked_password, clicked_selector, click_debug = await _click_login_initial_button(connector)
'''),
    ('''
            try:
                clicked_password, clicked_selector, click_debug = await _click_login_initial_button(connector)
''', '''
            if snapshot.get("captchaFound"):
                solved_captcha = await _solve_recaptcha_with_capsolver(connector, "senha-preenchida-antes-submit")
                if not solved_captcha:
                    raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="captcha")
                snapshot = await _capture_login_snapshot(connector)
            try:
                clicked_password, clicked_selector, click_debug = await _click_login_initial_button(connector)
'''),
    ('''
        if snapshot.get("captchaFound"):
            raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="captcha")
        if snapshot.get("successFound") or snapshot.get("operacionalFound") or snapshot.get("consultaMargemFound"):
''', '''
        if snapshot.get("captchaFound"):
            solved_captcha = await _solve_recaptcha_with_capsolver(connector, "validacao-final-login")
            if not solved_captcha:
                raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="captcha")
            snapshot = await _capture_login_snapshot(connector)
        if snapshot.get("successFound") or snapshot.get("operacionalFound") or snapshot.get("consultaMargemFound"):
'''),
    ('''
                if code in {"MANUAL_AUTH_REQUIRED", "CAPTCHA_REQUIRED"}:
                    raise _typed_login_error(code, typed_message, stage="erro_texto_portal")
''', '''
                if code == "CAPTCHA_REQUIRED":
                    solved_captcha = await _solve_recaptcha_with_capsolver(connector, "erro-texto-portal")
                    if not solved_captcha:
                        raise _typed_login_error(code, typed_message, stage="erro_texto_portal")
                    snapshot = await _capture_login_snapshot(connector)
                if code == "MANUAL_AUTH_REQUIRED":
                    raise _typed_login_error(code, typed_message, stage="erro_texto_portal")
'''),
]


def _replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count < 1:
        raise RuntimeError(f"Patch Capsolver falhou em {label}: trecho nao encontrado.")
    return source.replace(old, new, 1)


def _patched_source() -> str:
    cli_path = Path(__file__).with_name("ribeirao_cli.py")
    source = cli_path.read_text(encoding="utf-8")
    source = _replace_once(
        source,
        "\ndef _has_graphical_display() -> bool:\n",
        CAPSOLVER_HELPERS + "\ndef _has_graphical_display() -> bool:\n",
        "helpers",
    )
    for index, (old, new) in enumerate(REPLACEMENTS, start=1):
        source = _replace_once(source, old, new, f"replacement-{index}")
    return source


if __name__ == "__main__":
    original_path = Path(__file__).with_name("ribeirao_cli.py")
    compiled = compile(_patched_source(), str(original_path), "exec")
    exec(compiled, {"__name__": "__main__", "__file__": str(original_path)})
