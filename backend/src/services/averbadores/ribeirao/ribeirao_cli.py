from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import socket
import sys
import traceback
import unicodedata
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urljoin, urlparse

from playwright.async_api import TimeoutError as PlaywrightTimeoutError, async_playwright


class RibeiraoLoginError(RuntimeError):
    def __init__(self, code: str, message: str, stage: str | None = None):
        self.code = str(code or "UNKNOWN_LOGIN_ERROR").upper()
        self.stage = str(stage or "").strip() or None
        self.message = str(message or "")
        super().__init__(f"{self.code}: {self.message}")


def _read_json_stdin() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def _read_payload_from_file(path_value: str) -> dict:
    candidate = Path(path_value)
    if not candidate.exists():
      return {}
    return json.loads(candidate.read_text(encoding="utf-8"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_digits(value: object) -> str:
    return re.sub(r"\D", "", str(value or ""))


def _mask_login(login: str) -> str:
    text = str(login or "").strip()
    digits = re.sub(r"\D", "", text)
    if len(digits) >= 5:
        return f"{digits[:3]}***{digits[-2:]}"
    if len(text) >= 5:
        return f"{text[:3]}***{text[-2:]}"
    return "***"


def _safe_host(url: str) -> str:
    try:
        return urlparse(str(url or "")).hostname or ""
    except Exception:
        return ""


def _is_user_already_logged_message(*values: object) -> bool:
    normalized = " | ".join(_normalize_ribeirao_text(value) for value in values if value).strip()
    if not normalized:
        return False
    return any(
        term in normalized
        for term in [
            "usuario ja logado",
            "usuario já logado",
            "deseja desconectar seu usuario dos outros terminais",
            "deseja desconectar seu usuário dos outros terminais",
            "desconectar seu usuario dos outros terminais",
            "desconectar seu usuário dos outros terminais",
        ]
    )


def _is_placeholder_url(url: str) -> bool:
    normalized = str(url or "").strip().lower()
    return not normalized or "exemplo.local" in normalized or "example.local" in normalized


def _parse_bool(value: object, default: bool = True) -> bool:
    if value is None:
        return default
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return default


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
    body = json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
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


def _has_graphical_display() -> bool:
    return bool(os.getenv("DISPLAY") or os.getenv("WAYLAND_DISPLAY"))


def _chromium_launch_args(host: str | None = None, resolved_ips: list[str] | None = None) -> list[str]:
    args = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-features=UseDnsHttpsSvcb,AsyncDns,UseChromeOSDirectVideoDecoder",
        "--disable-quic",
    ]
    safe_host = str(host or "").strip()
    safe_ips = [str(ip).strip() for ip in (resolved_ips or []) if str(ip).strip()]
    if safe_host and safe_ips:
        args.append(f"--host-resolver-rules=MAP {safe_host} {safe_ips[0]}")
    return args


def _resolve_headless(payload: dict | None = None) -> bool:
    if str(os.getenv("NODE_ENV") or "").strip().lower() == "production":
        return True

    env_raw = os.getenv("RIBEIRAO_HEADLESS")
    if env_raw is not None and str(env_raw).strip():
        requested = _parse_bool(env_raw, True)
    else:
        requested = _parse_bool((payload or {}).get("headless"), True)

    if not requested and not _has_graphical_display():
        return True
    return requested


def _browser_launch_error_message(exc: Exception) -> tuple[str, str] | None:
    message = str(exc)
    lowered = message.lower()
    if (
        "missing x server" in lowered
        or "$display" in lowered
        or "headed browser" in lowered
        or "xvfb" in lowered
        or "browser.launch" in lowered
        or "browsertype.launch" in lowered
    ):
        return (
            "BROWSER_LAUNCH_ERROR",
            "Erro ao iniciar navegador de consulta no servidor. Verifique configuracao do Playwright/Chromium em producao.",
        )
    return None


def _log_playwright_diagnostics(playwright, headless: bool, stage: str) -> None:
    executable_path = ""
    try:
        executable_path = str(getattr(getattr(playwright, "chromium", None), "executable_path", "") or "")
    except Exception:
        executable_path = ""
    print(f"[PLAYWRIGHT] stage: {stage}", file=sys.stderr, flush=True)
    print(f"[PLAYWRIGHT] executablePath: {executable_path}", file=sys.stderr, flush=True)
    print(f"[PLAYWRIGHT] headless efetivo: {bool(headless)}", file=sys.stderr, flush=True)


LOGIN_ERROR_CODES = {
    "LOGIN_REJECTED",
    "LOGIN_FIELDS_NOT_FOUND",
    "LOGIN_BUTTON_NOT_FOUND",
    "LOGIN_PASSWORD_FIELD_NOT_FOUND",
    "LOGIN_TIMEOUT",
    "LOGIN_STILL_ON_SAME_PAGE",
    "CAPTCHA_REQUIRED",
    "PORTAL_CHANGED",
    "CONVENIO_ACTION_NOT_FOUND",
    "CONVENIO_SELECTION_FAILED",
    "CONVENIO_NOT_FOUND",
    "UNKNOWN_LOGIN_ERROR",
    "LOGIN_OK_NAVIGATION_FAILED",
    "MANUAL_AUTH_REQUIRED",
    "SELECTOR_ERROR",
    "DNS_RESOLUTION_FAILED",
    "CHROMIUM_DNS_FAILED",
    "WORKER_INTERNAL_ERROR",
    "USER_ALREADY_LOGGED_CONFIRM_FAILED",
}


def _normalize_ribeirao_text(value: object) -> str:
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return re.sub(r"\s+", " ", text).strip().lower()


def _normalize_portal_id(value: object) -> str:
    text = _normalize_ribeirao_text(value).replace("-", "_").replace(" ", "_")
    return re.sub(r"_+", "_", text).strip("_") or "prefeitura_ribeirao_preto"


def _portal_id(connector: object | None = None, payload: dict | None = None) -> str:
    if payload:
        return _normalize_portal_id(payload.get("portal_id") or payload.get("portalId") or "")
    return _normalize_portal_id(getattr(connector, "portal_id", "") if connector is not None else "")


def _convenio_target_terms(portal_id: str = "prefeitura_ribeirao_preto") -> list[str]:
    normalized_portal_id = _normalize_portal_id(portal_id)
    if normalized_portal_id == "governo_sp":
        configured_terms = [
            os.getenv("GOV_SP_ORGAO"),
            os.getenv("GOV_SP_CONVENIO"),
            os.getenv("GOVSP_ORGAO"),
            os.getenv("GOVSP_CONVENIO"),
        ]
        return [
            _normalize_ribeirao_text(term)
            for term in configured_terms
            if str(term or "").strip()
        ]
    return [
        _normalize_ribeirao_text("PREFEITURA RIBEIRAO PRETO SP - RIBEIRAO PRETO"),
        _normalize_ribeirao_text("PREFEITURA RIBEIRAO PRETO"),
        _normalize_ribeirao_text("RIBEIRAO PRETO"),
        _normalize_ribeirao_text("RIBEIRAO PRETO SP"),
        _normalize_ribeirao_text("PREFEITURA DE RIBEIRAO PRETO"),
    ]


def _portal_selection_steps(portal_id: str = "prefeitura_ribeirao_preto") -> list[dict]:
    normalized_portal_id = _normalize_portal_id(portal_id)
    if normalized_portal_id == "governo_sp":
        convenio_env = str(os.getenv("GOV_SP_ORGAO") or os.getenv("GOV_SP_CONVENIO") or os.getenv("GOVSP_ORGAO") or os.getenv("GOVSP_CONVENIO") or "").strip()
        return [
            {
                "label": convenio_env or "Perfil disponivel do Governo de SP",
                "terms": _convenio_target_terms(normalized_portal_id),
                "not_found_message": "O login foi aceito, mas o sistema nao conseguiu acessar o perfil disponivel do Governo de Sao Paulo.",
            },
        ]
    return [
        {
            "label": "Ribeirao Preto",
            "terms": _convenio_target_terms(normalized_portal_id),
            "not_found_message": "O login foi aceito, mas o convenio de Ribeirao Preto nao foi encontrado.",
        }
    ]


def _consulta_margem_url(portal_url: str, consulta_url: str | None = None) -> str:
    explicit_url = str(consulta_url or "").strip()
    if explicit_url and "ConsultaMargem.aspx" in explicit_url:
        return explicit_url
    base_url = str(explicit_url or portal_url or "").strip()
    parsed = urlparse(base_url)
    if parsed.scheme and parsed.netloc:
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if "ConsultaMargem.aspx" in base_url:
            return base_url
        if "Login.aspx" in base_url:
            return base_url.replace("/Login.aspx", "/Margem/ConsultaMargem.aspx")
        if "Inicial/Inicial.aspx" in base_url:
            return base_url.replace("/Inicial/Inicial.aspx", "/Margem/ConsultaMargem.aspx")
        return f"{origin}/Margem/ConsultaMargem.aspx"
    return "https://saec.consiglog.com.br/Margem/ConsultaMargem.aspx"


def _typed_login_error(code: str, message: str, stage: str | None = None) -> RibeiraoLoginError:
    return RibeiraoLoginError(code, message, stage)


def _split_typed_login_error(message: str | None) -> tuple[str | None, str]:
    raw = str(message or "").strip()
    if not raw:
        return None, ""
    upper = raw.upper()
    for code in LOGIN_ERROR_CODES:
        prefix = f"{code}:"
        if upper.startswith(prefix):
            return code, raw[len(prefix):].strip()
    return None, raw


def _login_scopes(connector: PortalSecundarioLegacyConnector):
    scopes = [connector.page]
    try:
        scopes.extend(list(connector.page.frames))
    except Exception:
        pass
    return scopes


async def _click_ok_popup(connector: PortalSecundarioLegacyConnector) -> bool:
    candidate_selectors = [
        "#ucAjaxModalPopup1_btnConfirmarPopup",
        "input[name='ucAjaxModalPopup1$btnConfirmarPopup']",
        "input[value='OK']",
        "button:has-text('OK')",
    ]
    for scope in _login_scopes(connector):
        for selector in candidate_selectors:
            try:
                await scope.locator(selector).first.click(timeout=2000)
                return True
            except Exception:
                pass
            try:
                await scope.locator(selector).first.click(timeout=2000, force=True)
                return True
            except Exception:
                pass
            try:
                clicked = await scope.evaluate(
                    """(selector) => {
                        try {
                            const el = document.querySelector(selector);
                            if (!el) return false;
                            el.click();
                            return true;
                        } catch (_) {
                            return false;
                        }
                    }""",
                    selector,
                )
                if clicked:
                    return True
            except Exception:
                pass
    try:
        if await connector.page.evaluate(
            """() => {
                try {
                    if (typeof __doPostBack === 'function') {
                        __doPostBack('ucAjaxModalPopup1$btnConfirmarPopup', '');
                        return true;
                    }
                    return false;
                } catch (_) {
                    return false;
                }
            }"""
        ):
            return True
    except Exception:
        pass
    return False


async def _probe_login_surface(
    scope,
    *,
    login_selectors: list[str],
    password_selectors: list[str],
    entry_selectors: list[str],
    submit_selectors: list[str],
    success_selectors: list[str],
    error_selectors: list[str],
    captcha_selectors: list[str],
) -> dict:
    return await scope.evaluate(
        """({ loginSelectors, passwordSelectors, entrySelectors, submitSelectors, successSelectors, errorSelectors, captchaSelectors }) => {
            const normalize = (v) => String(v || "")
              .normalize("NFD")
              .replace(/[\\u0300-\\u036f]/g, "")
              .replace(/\\s+/g, " ")
              .trim()
              .toLowerCase();
            const isVisible = (el) => {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              if (!style) return false;
              const rect = el.getBoundingClientRect();
              return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
            };
            const textMatches = (selector, el) => {
              const raw = String(selector || "").trim();
              if (!raw) return false;
              const textPrefix = raw.match(/^text=(.+)$/i);
              if (textPrefix) {
                const wanted = normalize(textPrefix[1]);
                const hay = normalize(`${el.innerText || el.textContent || el.value || ""}`);
                return wanted ? hay.includes(wanted) : false;
              }
              const hasTextMatch = raw.match(/^(.*?):has-text\\((['"])(.*)\\2\\)$/i);
              if (hasTextMatch) {
                const wanted = normalize(hasTextMatch[3]);
                const hay = normalize(`${el.innerText || el.textContent || el.value || ""}`);
                return wanted ? hay.includes(wanted) : false;
              }
              return false;
            };
            const safeQueryAll = (selector) => {
              const raw = String(selector || "").trim();
              if (!raw) return [];
              if (/^text=/i.test(raw) || /:has-text\\(/i.test(raw)) {
                const pool = Array.from(document.querySelectorAll("body *"));
                return pool.filter((el) => isVisible(el) && textMatches(raw, el));
              }
              try {
                return Array.from(document.querySelectorAll(raw));
              } catch (_) {
                return [];
              }
            };
            const firstVisibleSelector = (selectors) => {
              for (const selector of selectors || []) {
                const nodes = safeQueryAll(selector);
                const visible = nodes.find((node) => isVisible(node) && !(node.disabled || node.readOnly));
                if (visible) return selector;
              }
              return "";
            };
            const firstText = (selectors) => {
              for (const selector of selectors || []) {
                const node = safeQueryAll(selector).find((el) => isVisible(el));
                if (node) {
                  const text = String(node.textContent || node.value || "").replace(/\\s+/g, " ").trim();
                  if (text) return text;
                }
              }
              return "";
            };
            const formElement = document.querySelector("form") || document.body || document.documentElement;
            const bodyText = String(document.body?.innerText || document.body?.textContent || "").replace(/\\s+/g, " ").trim();
            const bodyNormalized = normalize(bodyText);
            const loginSelector = firstVisibleSelector(loginSelectors);
            const passwordSelector = firstVisibleSelector(passwordSelectors);
            const entrySelector = firstVisibleSelector(entrySelectors);
            const submitSelector = firstVisibleSelector(submitSelectors);
            const successSelector = firstVisibleSelector(successSelectors);
            const captchaSelector = firstVisibleSelector(captchaSelectors);
            const errorText = firstText(errorSelectors) || (
              /login|senha|certificado|captcha|nao autorizado|nÃ£o autorizado|inv[aÃ¡]lid/i.test(bodyText)
                ? bodyText.slice(0, 500)
                : ""
            );
            return {
              title: document.title || "",
              url: location.href || "",
              host: (() => {
                try { return new URL(location.href).hostname || ""; } catch { return ""; }
              })(),
              inputCount: document.querySelectorAll("input").length,
              loginFound: Boolean(loginSelector),
              loginSelector,
              passwordFound: Boolean(passwordSelector),
              passwordSelector,
              buttonFound: Boolean(entrySelector || submitSelector),
              buttonSelector: entrySelector || submitSelector,
              entryFound: Boolean(entrySelector),
              entrySelector,
              successFound: Boolean(successSelector),
              successSelector,
              operacionalFound: bodyNormalized.includes("operacional"),
              consultaMargemFound: bodyNormalized.includes("consulta de margem"),
              captchaFound: Boolean(captchaSelector),
              captchaSelector,
              errorText,
              bodySnippet: bodyText.slice(0, 500),
              bodyNormalized: bodyNormalized.slice(0, 500),
              loginPageVisible: Boolean(loginSelector) && bodyNormalized.includes("login"),
              formHtml: String(formElement.outerHTML || "").replace(/\\s+/g, " ").trim().slice(0, 5000),
              buttons: Array.from(formElement.querySelectorAll("button,input[type='submit'],input[type='button'],input[type='image'],a"))
                .filter((el) => isVisible(el))
                .map((el) => ({
                  tag: (el.tagName || "").toLowerCase(),
                  id: String(el.id || ""),
                  name: String(el.name || ""),
                  type: String(el.type || ""),
                  value: String(el.value || ""),
                  textContent: String(el.textContent || "").replace(/\\s+/g, " ").trim(),
                  className: String(el.className || ""),
                  title: String(el.getAttribute("title") || ""),
                })),
              inputs: Array.from(formElement.querySelectorAll("input[type='submit'],input[type='button']"))
                .filter((el) => isVisible(el))
                .map((el) => ({
                  id: String(el.id || ""),
                  name: String(el.name || ""),
                  type: String(el.type || ""),
                  value: String(el.value || ""),
                  className: String(el.className || ""),
                })),
              links: Array.from(formElement.querySelectorAll("a"))
                .filter((el) => isVisible(el))
                .map((el) => ({
                  href: String(el.href || ""),
                  id: String(el.id || ""),
                  name: String(el.name || ""),
                  textContent: String(el.textContent || "").replace(/\\s+/g, " ").trim(),
                  className: String(el.className || ""),
                })),
              certificateFound: Boolean(
                bodyNormalized.includes("certificado digital") ||
                bodyNormalized.includes("certificadodigital") ||
                bodyNormalized.includes("login-identific")
              ),
            };
        }""",
        {
            "loginSelectors": login_selectors,
            "passwordSelectors": password_selectors,
            "entrySelectors": entry_selectors,
            "submitSelectors": submit_selectors,
            "successSelectors": success_selectors,
            "errorSelectors": error_selectors,
            "captchaSelectors": captcha_selectors,
        },
    )


async def _capture_login_snapshot(connector: PortalSecundarioLegacyConnector) -> dict:
    login_selectors = connector._selector_options(connector.settings.pdc_selector_login_user)
    password_selectors = connector._selector_options(connector.settings.pdc_selector_login_password)
    entry_selectors = connector._selector_options(connector.settings.pdc_selector_login_entry)
    submit_selectors = connector._selector_options(connector.settings.pdc_selector_login_submit)
    success_selectors = [
        *connector._selector_options(getattr(connector.settings, "selector_logged_indicator", "")),
        *connector._selector_options(connector.settings.pdc_selector_profile_access_button),
        *connector._selector_options(connector.settings.pdc_selector_menu_consulta_margem),
        *connector._selector_options(connector.settings.pdc_selector_cpf_input),
    ]
    error_selectors = [
        "#lblMsgRH",
        "#mensagemLabel",
        ".alert-danger",
        ".error",
        ".msgErro",
        ".toast-error",
        ".invalid-feedback",
    ]
    captcha_selectors = [
        connector.settings.pdc_selector_captcha_input,
        "iframe[src*='captcha' i]",
        "iframe[src*='hcaptcha' i]",
        "iframe[title*='captcha' i]",
        "[id*='captcha' i]",
        "[name*='captcha' i]",
    ]

    snapshot = await connector.page.evaluate(
        """({ loginSelectors, passwordSelectors, entrySelectors, submitSelectors, successSelectors, errorSelectors, captchaSelectors }) => {
            const normalize = (v) => String(v || "")
              .normalize("NFD")
              .replace(/[\\u0300-\\u036f]/g, "")
              .replace(/\\s+/g, " ")
              .trim()
              .toLowerCase();
            const invalidSelectors = [];
            const isVisible = (el) => {
              if (!el) return false;
              const style = window.getComputedStyle(el);
              if (!style) return false;
              const rect = el.getBoundingClientRect();
              return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
            };
            const textMatches = (selector, el) => {
              const raw = String(selector || "").trim();
              if (!raw) return false;
              const textPrefix = raw.match(/^text=(.+)$/i);
              if (textPrefix) {
                const wanted = normalize(textPrefix[1]);
                const hay = normalize(`${el.innerText || el.textContent || el.value || ""}`);
                return wanted ? hay.includes(wanted) : false;
              }
              const hasTextMatch = raw.match(/^(.*?):has-text\\((['"])(.*)\\2\\)$/i);
              if (hasTextMatch) {
                const wanted = normalize(hasTextMatch[3]);
                const hay = normalize(`${el.innerText || el.textContent || el.value || ""}`);
                return wanted ? hay.includes(wanted) : false;
              }
              return false;
            };
            const safeQueryAll = (selector) => {
              const raw = String(selector || "").trim();
              if (!raw) return [];
              if (/^text=/i.test(raw) || /:has-text\\(/i.test(raw)) {
                const pool = Array.from(document.querySelectorAll("body *"));
                return pool.filter((el) => isVisible(el) && textMatches(raw, el));
              }
              try {
                return Array.from(document.querySelectorAll(raw));
              } catch (error) {
                invalidSelectors.push(raw);
                return [];
              }
            };
            const firstVisibleSelector = (selectors) => {
              for (const selector of selectors || []) {
                const nodes = safeQueryAll(selector);
                const visible = nodes.find((node) => isVisible(node) && !(node.disabled || node.readOnly));
                if (visible) {
                  return selector;
                }
              }
              return "";
            };
            const firstText = (selectors) => {
              for (const selector of selectors || []) {
                const node = safeQueryAll(selector).find((el) => isVisible(el));
                if (node) {
                  const text = String(node.textContent || node.value || "").replace(/\\s+/g, " ").trim();
                  if (text) return text;
                }
              }
              return "";
            };
            const bodyText = String(document.body?.innerText || document.body?.textContent || "").replace(/\\s+/g, " ").trim();
            const bodyNormalized = normalize(bodyText);
            const successSelector = firstVisibleSelector(successSelectors);
            const captchaSelector = firstVisibleSelector(captchaSelectors);
            const loginSelector = firstVisibleSelector(loginSelectors);
            const passwordSelector = firstVisibleSelector(passwordSelectors);
            const entrySelector = firstVisibleSelector(entrySelectors);
            const submitSelector = firstVisibleSelector(submitSelectors);
            const errorText = firstText(errorSelectors) || (
              /login|senha|certificado|captcha|nao autorizado|não autorizado|inv[aá]lid/i.test(bodyText)
                ? bodyText.slice(0, 500)
                : ""
            );
            return {
              title: document.title || "",
              url: location.href || "",
              host: (() => {
                try { return new URL(location.href).hostname || ""; } catch { return ""; }
              })(),
              inputCount: document.querySelectorAll("input").length,
              loginFound: Boolean(loginSelector),
              loginSelector,
              passwordFound: Boolean(passwordSelector),
              passwordSelector,
              buttonFound: Boolean(entrySelector || submitSelector),
              buttonSelector: entrySelector || submitSelector,
              entryFound: Boolean(entrySelector),
              entrySelector,
              successFound: Boolean(successSelector),
              successSelector,
              operacionalFound: bodyNormalized.includes("operacional"),
              consultaMargemFound: bodyNormalized.includes("consulta de margem"),
              captchaFound: Boolean(captchaSelector),
              captchaSelector,
              errorText,
              bodySnippet: bodyText.slice(0, 500),
              bodyNormalized: bodyNormalized.slice(0, 500),
              loginPageVisible: Boolean(loginSelector) && bodyNormalized.includes("login"),
              invalidSelectors,
            };
        }""",
        {
            "loginSelectors": login_selectors,
            "passwordSelectors": password_selectors,
            "entrySelectors": entry_selectors,
            "submitSelectors": submit_selectors,
            "successSelectors": success_selectors,
            "errorSelectors": error_selectors,
            "captchaSelectors": captcha_selectors,
        },
    )
    for selector in snapshot.get("invalidSelectors") or []:
        print(f"[LOGIN_FLOW] selector inválido ignorado: {selector}", file=sys.stderr, flush=True)
    frame_snapshots: list[dict] = []
    try:
        for frame in list(connector.page.frames)[1:]:
            try:
                frame_snapshot = await _probe_login_surface(
                    frame,
                    login_selectors=login_selectors,
                    password_selectors=password_selectors,
                    entry_selectors=entry_selectors,
                    submit_selectors=submit_selectors,
                    success_selectors=success_selectors,
                    error_selectors=error_selectors,
                    captcha_selectors=captcha_selectors,
                )
                frame_snapshots.append(frame_snapshot)
            except Exception as exc:
                frame_snapshots.append(
                    {
                        "url": getattr(frame, "url", ""),
                        "title": "",
                        "host": _safe_host(getattr(frame, "url", "")),
                        "inputCount": 0,
                        "loginFound": False,
                        "passwordFound": False,
                        "buttonFound": False,
                        "entryFound": False,
                        "successFound": False,
                        "operacionalFound": False,
                        "consultaMargemFound": False,
                        "captchaFound": False,
                        "certificateFound": False,
                        "loginSelector": "",
                        "passwordSelector": "",
                        "buttonSelector": "",
                        "entrySelector": "",
                        "successSelector": "",
                        "captchaSelector": "",
                        "errorText": str(exc),
                        "bodySnippet": "",
                        "bodyNormalized": "",
                        "formHtml": "",
                        "buttons": [],
                        "inputs": [],
                        "links": [],
                    }
                )
    except Exception:
        frame_snapshots = []

    snapshot["frameCount"] = len(frame_snapshots)
    snapshot["frameUrls"] = [str(item.get("url") or "") for item in frame_snapshots if item.get("url")]
    snapshot["framesInfo"] = [
        {
            "url": str(item.get("url") or ""),
            "title": str(item.get("title") or ""),
            "loginFound": bool(item.get("loginFound")),
            "buttonFound": bool(item.get("buttonFound")),
            "passwordFound": bool(item.get("passwordFound")),
            "captchaFound": bool(item.get("captchaFound")),
            "certificateFound": bool(item.get("certificateFound")),
            "inputCount": int(item.get("inputCount") or 0),
        }
        for item in frame_snapshots
    ]
    for frame_snapshot in frame_snapshots:
        snapshot["loginFound"] = bool(snapshot.get("loginFound")) or bool(frame_snapshot.get("loginFound"))
        snapshot["passwordFound"] = bool(snapshot.get("passwordFound")) or bool(frame_snapshot.get("passwordFound"))
        snapshot["buttonFound"] = bool(snapshot.get("buttonFound")) or bool(frame_snapshot.get("buttonFound"))
        snapshot["entryFound"] = bool(snapshot.get("entryFound")) or bool(frame_snapshot.get("entryFound"))
        snapshot["successFound"] = bool(snapshot.get("successFound")) or bool(frame_snapshot.get("successFound"))
        snapshot["operacionalFound"] = bool(snapshot.get("operacionalFound")) or bool(frame_snapshot.get("operacionalFound"))
        snapshot["consultaMargemFound"] = bool(snapshot.get("consultaMargemFound")) or bool(frame_snapshot.get("consultaMargemFound"))
        snapshot["captchaFound"] = bool(snapshot.get("captchaFound")) or bool(frame_snapshot.get("captchaFound"))
        snapshot["certificateFound"] = bool(snapshot.get("certificateFound")) or bool(frame_snapshot.get("certificateFound"))
        if not snapshot.get("loginSelector") and frame_snapshot.get("loginSelector"):
            snapshot["loginSelector"] = frame_snapshot.get("loginSelector")
        if not snapshot.get("passwordSelector") and frame_snapshot.get("passwordSelector"):
            snapshot["passwordSelector"] = frame_snapshot.get("passwordSelector")
        if not snapshot.get("buttonSelector") and frame_snapshot.get("buttonSelector"):
            snapshot["buttonSelector"] = frame_snapshot.get("buttonSelector")
        if not snapshot.get("entrySelector") and frame_snapshot.get("entrySelector"):
            snapshot["entrySelector"] = frame_snapshot.get("entrySelector")
        if not snapshot.get("successSelector") and frame_snapshot.get("successSelector"):
            snapshot["successSelector"] = frame_snapshot.get("successSelector")
        if not snapshot.get("captchaSelector") and frame_snapshot.get("captchaSelector"):
            snapshot["captchaSelector"] = frame_snapshot.get("captchaSelector")
        if not snapshot.get("errorText") and frame_snapshot.get("errorText"):
            snapshot["errorText"] = frame_snapshot.get("errorText")
        if not snapshot.get("bodySnippet") and frame_snapshot.get("bodySnippet"):
            snapshot["bodySnippet"] = frame_snapshot.get("bodySnippet")
        if not snapshot.get("bodyNormalized") and frame_snapshot.get("bodyNormalized"):
            snapshot["bodyNormalized"] = frame_snapshot.get("bodyNormalized")
        if not snapshot.get("formHtml") and frame_snapshot.get("formHtml"):
            snapshot["formHtml"] = frame_snapshot.get("formHtml")
        if not snapshot.get("buttons") and frame_snapshot.get("buttons"):
            snapshot["buttons"] = frame_snapshot.get("buttons")
        if not snapshot.get("inputs") and frame_snapshot.get("inputs"):
            snapshot["inputs"] = frame_snapshot.get("inputs")
        if not snapshot.get("links") and frame_snapshot.get("links"):
            snapshot["links"] = frame_snapshot.get("links")

    for selector in snapshot.get("invalidSelectors") or []:
        print(f"[LOGIN_FLOW] selector inválido ignorado: {selector}", file=sys.stderr, flush=True)
    return snapshot


async def _capture_login_button_debug(connector: PortalSecundarioLegacyConnector) -> dict:
    debug_scopes: list[dict] = []
    for index, scope in enumerate(_login_scopes(connector)):
        try:
            scope_debug = await _probe_login_surface(
                scope,
                login_selectors=[],
                password_selectors=[],
                entry_selectors=[],
                submit_selectors=[],
                success_selectors=[],
                error_selectors=[],
                captcha_selectors=[],
            )
        except Exception:
            scope_debug = {
                "url": getattr(scope, "url", ""),
                "title": "",
                "formHtml": "",
                "buttons": [],
                "inputs": [],
                "links": [],
                "certificateFound": False,
                "buttonCount": 0,
                "submitInputCount": 0,
                "linkCount": 0,
            }
        scope_debug["scopeIndex"] = index
        debug_scopes.append(scope_debug)

    if not debug_scopes:
        return {"formHtml": "", "buttons": [], "inputs": [], "links": [], "buttonCount": 0, "submitInputCount": 0, "linkCount": 0, "frameCount": 0, "scopeUrl": ""}

    best = max(
        debug_scopes,
        key=lambda item: int(item.get("buttonCount") or 0) + int(item.get("submitInputCount") or 0) + int(item.get("linkCount") or 0),
    )
    buttons = best.get("buttons") or []
    inputs = best.get("inputs") or []
    links = best.get("links") or []
    print(f"[LOGIN_FLOW] quantidade de frames: {max(0, len(debug_scopes) - 1)}", file=sys.stderr, flush=True)
    return {
        "formHtml": best.get("formHtml") or "",
        "buttons": buttons,
        "inputs": inputs,
        "links": links,
        "buttonCount": len(buttons),
        "submitInputCount": len(inputs),
        "linkCount": len(links),
        "certificateFound": any(bool(item.get("certificateFound")) for item in debug_scopes),
        "frameCount": max(0, len(debug_scopes) - 1),
        "debugScopes": [
            {
                "scopeIndex": item.get("scopeIndex"),
                "url": item.get("url") or "",
                "title": item.get("title") or "",
                "buttonCount": len(item.get("buttons") or []),
                "inputCount": len(item.get("inputs") or []),
                "linkCount": len(item.get("links") or []),
            }
            for item in debug_scopes
        ],
        "scopeUrl": best.get("url") or "",
        "scopeTitle": best.get("title") or "",
    }


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
          return {
            siteKey: key,
            pageUrl: location.href,
            enterprise: Boolean(node.closest("[data-enterprise='true']")),
            apiDomain: "google.com",
          };
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

    task_type = (
        "ReCaptchaV2EnterpriseTaskProxyLess"
        if metadata.get("enterprise")
        else "ReCaptchaV2TaskProxyLess"
    )
    task = {
        "type": task_type,
        "websiteURL": website_url,
        "websiteKey": site_key,
    }
    if str(metadata.get("apiDomain") or "").lower() == "recaptcha.net":
        task["apiDomain"] = "recaptcha.net"

    create_payload = {"clientKey": api_key, "task": task}
    create_result = await asyncio.to_thread(
        _post_json_sync,
        "https://api.capsolver.com/createTask",
        create_payload,
        30,
    )
    if create_result.get("errorId"):
        print(
            f"[CAPSOLVER] createTask falhou: {create_result.get('errorCode') or create_result.get('errorDescription') or 'erro'}",
            file=sys.stderr,
            flush=True,
        )
        return ""
    task_id = str(create_result.get("taskId") or "").strip()
    if not task_id:
        print("[CAPSOLVER] createTask sem taskId.", file=sys.stderr, flush=True)
        return ""

    deadline = asyncio.get_running_loop().time() + _capsolver_timeout_seconds()
    while asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(3)
        result_payload = {"clientKey": api_key, "taskId": task_id}
        result = await asyncio.to_thread(
            _post_json_sync,
            "https://api.capsolver.com/getTaskResult",
            result_payload,
            30,
        )
        if result.get("errorId"):
            print(
                f"[CAPSOLVER] getTaskResult falhou: {result.get('errorCode') or result.get('errorDescription') or 'erro'}",
                file=sys.stderr,
                flush=True,
            )
            return ""
        if result.get("status") == "ready":
            token = str((result.get("solution") or {}).get("gRecaptchaResponse") or "").strip()
            if token:
                return token
            return ""
    print("[CAPSOLVER] tempo limite aguardando token.", file=sys.stderr, flush=True)
    return ""


async def _capsolver_solve_image(image_base64: str, website_url: str = "") -> str:
    api_key = _capsolver_api_key()
    if not api_key or not image_base64:
        return ""
    payload = {
        "clientKey": api_key,
        "task": {
            "type": "ImageToTextTask",
            "websiteURL": website_url or "https://www.portaldoconsignado.com.br",
            "module": "common",
            "body": image_base64,
        },
    }
    create_result = await asyncio.to_thread(_post_json_sync, "https://api.capsolver.com/createTask", payload, 45)
    if create_result.get("errorId"):
        print(
            f"[CAPSOLVER] image createTask falhou: {create_result.get('errorCode') or create_result.get('errorDescription') or 'erro'}",
            file=sys.stderr,
            flush=True,
        )
        return ""
    immediate_text = str((create_result.get("solution") or {}).get("text") or create_result.get("text") or "").strip()
    if immediate_text:
        return immediate_text
    task_id = create_result.get("taskId")
    if not task_id:
        print("[CAPSOLVER] image createTask sem taskId.", file=sys.stderr, flush=True)
        return ""

    deadline = asyncio.get_running_loop().time() + _capsolver_timeout_seconds()
    while asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(2)
        result = await asyncio.to_thread(
            _post_json_sync,
            "https://api.capsolver.com/getTaskResult",
            {"clientKey": api_key, "taskId": task_id},
            45,
        )
        if result.get("errorId"):
            print(
                f"[CAPSOLVER] image getTaskResult falhou: {result.get('errorCode') or result.get('errorDescription') or 'erro'}",
                file=sys.stderr,
                flush=True,
            )
            return ""
        if result.get("status") == "ready":
            return str((result.get("solution") or {}).get("text") or result.get("text") or "").strip()
    print("[CAPSOLVER] image tempo limite aguardando texto.", file=sys.stderr, flush=True)
    return ""


async def _solve_image_captcha_with_capsolver(connector: PortalSecundarioLegacyConnector, stage: str) -> bool:
    if not _capsolver_enabled():
        print("[CAPSOLVER] imagem desativado ou sem chave; mantendo validacao manual.", file=sys.stderr, flush=True)
        return False
    try:
        image_locator = connector.page.locator("#cipCaptchaImg, img[alt='Captcha'], img[title='Captcha']").first
        await image_locator.wait_for(state="visible", timeout=5000)
        try:
            image_bytes = await image_locator.screenshot(timeout=10000)
        except Exception:
            captcha_src = str(await image_locator.get_attribute("src") or "").strip()
            if not captcha_src:
                raise
            captcha_url = urljoin(connector.page.url, captcha_src)
            response = await connector.page.context.request.get(captcha_url, timeout=10000)
            image_bytes = await response.body()
        image_base64 = base64.b64encode(image_bytes).decode("ascii")
    except Exception as exc:
        print(f"[CAPSOLVER] imagem captcha nao encontrada stage={stage}: {exc}", file=sys.stderr, flush=True)
        return False

    print(f"[CAPSOLVER] resolvendo captcha de imagem stage={stage}", file=sys.stderr, flush=True)
    text = await _capsolver_solve_image(image_base64, connector.page.url)
    captcha_text = re.sub(r"[^A-Za-z0-9]", "", text or "").upper()
    if not captcha_text:
        print("[CAPSOLVER] captcha de imagem sem texto.", file=sys.stderr, flush=True)
        return False
    try:
        await connector.page.locator("#captcha, input[name='captchaPanel:captcha'], input[title='Captcha']").first.fill(captcha_text, timeout=5000)
        print("[CAPSOLVER] captcha de imagem preenchido.", file=sys.stderr, flush=True)
        return True
    except Exception as exc:
        print(f"[CAPSOLVER] falha ao preencher captcha de imagem: {exc}", file=sys.stderr, flush=True)
        return False


def _gov_sp_server_login_url(login_url: str) -> str:
    parsed = urlparse(str(login_url or "https://www.portaldoconsignado.com.br/home?2"))
    if parsed.scheme and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}/home?0"
    return "https://www.portaldoconsignado.com.br/home?0"


async def _goto_gov_sp_admin_login(connector: PortalSecundarioLegacyConnector, login_url: str, timeout_ms: int) -> None:
    # O portal muda o painel por estado interno do Wicket; abrir /home?1 direto pode cair no login de servidor.
    if await connector.page.locator("#username, input[name='username']").count() and await connector.page.locator("#password, input[name='senha'], input[type='password']").count():
        return
    await connector.page.goto(_gov_sp_server_login_url(login_url), wait_until="domcontentloaded", timeout=timeout_ms)
    await connector.page.wait_for_timeout(1200)
    if await connector.page.locator("#username, input[name='username']").count() and await connector.page.locator("#password, input[name='senha'], input[type='password']").count():
        return
    try:
        await connector.page.get_by_text("Login Administrativo", exact=True).click(timeout=5000)
    except Exception:
        await connector.page.locator("span:has-text('Login Administrativo')").last.click(timeout=5000)
    try:
        await connector.page.locator("#username, input[name='username']").first.wait_for(state="visible", timeout=8000)
        await connector.page.locator("#password, input[name='senha'], input[type='password']").first.wait_for(state="visible", timeout=8000)
    except Exception:
        snapshot = await _capture_login_snapshot(connector)
        print(
            f"[LOGIN_FLOW] govsp admin_tab url: {snapshot.get('url') or ''} inputs={snapshot.get('inputCount') or 0} body={snapshot.get('bodySnippet') or ''}",
            file=sys.stderr,
            flush=True,
        )
        raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "O sistema nao encontrou o formulario administrativo do Governo de SP.", stage="govsp_admin_tab")


async def _fill_gov_sp_admin_credentials(connector: PortalSecundarioLegacyConnector, login: str, password: str) -> dict:
    login_digits = _clean_digits(login) or str(login or "").strip()
    result = await connector.page.evaluate(
        """({ login, password }) => {
          const setValue = (selector, value) => {
            const el = document.querySelector(selector);
            if (!el) return false;
            el.focus();
            el.value = value;
            for (const type of ["keydown", "input", "keyup", "change", "blur"]) {
              el.dispatchEvent(new Event(type, { bubbles: true }));
            }
            return true;
          };
          return {
            usernameSet: setValue("#username, input[name='username']", login),
            passwordSet: setValue("#password, input[name='senha'], input[type='password']", password),
            usernameValue: document.querySelector("#username, input[name='username']")?.value || "",
            passwordLength: (document.querySelector("#password, input[name='senha'], input[type='password']")?.value || "").length,
          };
        }""",
        {"login": login_digits, "password": password},
    )
    await connector.page.wait_for_timeout(300)
    return result if isinstance(result, dict) else {}


async def _click_gov_sp_profile_option(connector: PortalSecundarioLegacyConnector) -> bool:
    terms = list(dict.fromkeys(_convenio_target_terms("governo_sp")))
    try:
        selected = await connector.page.evaluate(
            """({ terms }) => {
              const normalize = (value) => String(value || "")
                .normalize("NFD")
                .replace(/[\\u0300-\\u036f]/g, "")
                .replace(/\\s+/g, " ")
                .trim()
                .toLowerCase();
              const wanted = (terms || []).map(normalize).filter(Boolean);
              const controls = Array.from(document.querySelectorAll("input[type='checkbox'], input[type='radio']"));
              const choose = (el) => {
                try {
                  el.checked = true;
                  el.setAttribute("checked", "checked");
                  el.dispatchEvent(new Event("input", { bubbles: true }));
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                  return true;
                } catch (_) {
                  return false;
                }
              };
              if (!controls.length) return wanted.length === 0;
              if (!wanted.length) return choose(controls[0]);
              for (const el of controls) {
                const row = el.closest("tr, li, div, label, section") || el.parentElement || el;
                const text = normalize(`${row.innerText || row.textContent || el.value || ""}`);
                if (wanted.some((term) => term && text.includes(term))) {
                  return choose(el);
                }
              }
              return false;
            }""",
            {"terms": terms},
        )
        if not selected:
            print("[LOGIN_FLOW] govsp perfil configurado nao encontrado na tela.", file=sys.stderr, flush=True)
            return False
    except Exception:
        return False
    for selector in [
        "#id16",
        "input[name='acessar'][value='Acessar']",
        "input.botaoAcessar[value='Acessar']",
    ]:
        try:
            locator = connector.page.locator(selector).first
            if await locator.count():
                await locator.click(timeout=5000)
                return True
        except Exception:
            pass
    for selector in [
        "a:has-text('Portal do Consignatário Financeiro')",
        "button:has-text('Portal do Consignatário Financeiro')",
        "input[value*='Portal do Consignatário Financeiro']",
    ]:
        try:
            locator = connector.page.locator(selector).first
            if await locator.count():
                await locator.click(timeout=5000)
                return True
        except Exception:
            pass
    try:
        direct_clicked = await connector.page.evaluate(
            """() => {
              const normalize = (value) => String(value || "")
                .normalize("NFD")
                .replace(/[\\u0300-\\u036f]/g, "")
                .replace(/\\s+/g, " ")
                .trim()
                .toLowerCase();
              const isVisible = (el) => {
                if (!el) return false;
                const style = getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
              };
              const matches = Array.from(document.querySelectorAll("a, button, input[type='button'], input[type='submit'], [onclick], span, div"))
                .filter(isVisible)
                .map((el) => ({ el, text: normalize(`${el.innerText || el.textContent || el.value || ""}`) }))
                .filter((item) => item.text.includes("portal do consignatario financeiro"))
                .sort((a, b) => a.text.length - b.text.length);
              const target = matches[0]?.el || null;
              if (!target) return false;
              target.click();
              return true;
            }"""
        )
        if direct_clicked:
            return True
    except Exception:
        pass
    try:
        return bool(
            await connector.page.evaluate(
                """({ terms }) => {
                  const normalize = (value) => String(value || "")
                    .normalize("NFD")
                    .replace(/[\\u0300-\\u036f]/g, "")
                    .replace(/\\s+/g, " ")
                    .trim()
                    .toLowerCase();
                  const wanted = (terms || []).map(normalize).filter(Boolean);
                  const isVisible = (el) => {
                    if (!el) return false;
                    const style = getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
                  };
                  const candidates = Array.from(document.querySelectorAll("tr, li, div, a, button, input[type='button'], input[type='submit'], [onclick]"))
                    .filter(isVisible);
                  const row = candidates.find((el) => {
                    const text = normalize(`${el.innerText || el.textContent || el.value || ""}`);
                    return wanted.some((term) => term && text.includes(term));
                  });
                  if (!row) return false;
                  const action = Array.from(row.querySelectorAll("a, button, input[type='button'], input[type='submit'], [onclick]"))
                    .filter(isVisible)
                    .find((el) => normalize(`${el.innerText || el.textContent || el.value || ""}`).includes("portal do consignatario financeiro"))
                    || Array.from(row.querySelectorAll("a, button, input[type='button'], input[type='submit'], [onclick]")).filter(isVisible).pop()
                    || row;
                  try {
                    action.click();
                    return true;
                  } catch (_) {
                    try {
                      row.click();
                      return true;
                    } catch (_) {
                      return false;
                    }
                  }
                }""",
                {"terms": terms},
            )
        )
    except Exception:
        return False


async def _click_text_option(connector: PortalSecundarioLegacyConnector, text: str) -> bool:
    try:
        clicked = bool(
            await connector.page.evaluate(
                """(wantedText) => {
                  const normalize = (value) => String(value || "")
                    .normalize("NFD")
                    .replace(/[\\u0300-\\u036f]/g, "")
                    .replace(/\\s+/g, " ")
                    .trim()
                    .toLowerCase();
                  const wanted = normalize(wantedText);
                  const isVisible = (el) => {
                    if (!el) return false;
                    const style = getComputedStyle(el);
                    const rect = el.getBoundingClientRect();
                    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
                  };
                  const candidates = Array.from(document.querySelectorAll("a, button, input[type='button'], input[type='submit'], [onclick], span, div, li"))
                    .filter(isVisible)
                    .map((el) => {
                      const clickable = el.matches("a, button, input[type='button'], input[type='submit'], [onclick]")
                        ? el
                        : el.closest("a, button, input[type='button'], input[type='submit'], [onclick]");
                      return { el, clickable, text: normalize(`${el.innerText || el.textContent || el.value || ""}`) };
                    })
                    .filter((item) => item.clickable && isVisible(item.clickable))
                    .filter((item) => item.text === wanted || item.text.includes(wanted))
                    .sort((a, b) => a.text.length - b.text.length);
                  const target = candidates[0]?.clickable || null;
                  if (!target) return false;
                  target.click();
                  return true;
                }""",
                text,
            )
        )
        if clicked:
            return True
    except Exception:
        pass
    try:
        await connector.page.get_by_text(text, exact=True).first.click(timeout=5000)
        return True
    except Exception:
        return False


async def _find_gov_sp_consulta_margem_href(connector: PortalSecundarioLegacyConnector) -> str:
    try:
        href = await connector.page.evaluate(
            """() => {
              const normalize = (value) => String(value || "")
                .normalize("NFD")
                .replace(/[\\u0300-\\u036f]/g, "")
                .replace(/\\s+/g, " ")
                .trim()
                .toLowerCase();
              const anchors = Array.from(document.querySelectorAll("a[href]"));
              const direct = anchors.find((el) => normalize(el.textContent || el.innerText || "").includes("consulta de margem")
                && String(el.getAttribute("href") || "").includes("pesquisarMargem"));
              if (direct) return direct.getAttribute("href") || "";
              const byHref = anchors.find((el) => String(el.getAttribute("href") || "").includes("pesquisarMargem"));
              return byHref ? byHref.getAttribute("href") || "" : "";
            }"""
        )
        return str(href or "").strip()
    except Exception:
        return ""


async def _open_gov_sp_consulta_margem(connector: PortalSecundarioLegacyConnector, timeout_ms: int) -> bool:
    for step in range(1, 5):
        try:
            if await connector._wait_any(connector.settings.pdc_selector_cpf_input, 1500):
                return True
        except Exception:
            pass

        href = await _find_gov_sp_consulta_margem_href(connector)
        if href:
            target_url = urljoin(connector.page.url, href)
            print(f"[LOGIN_FLOW] govsp abrindo rota Consulta de Margem: {_safe_host(target_url)}{urlparse(target_url).path}", file=sys.stderr, flush=True)
            try:
                await connector.page.goto(target_url, wait_until="domcontentloaded", timeout=timeout_ms)
                await connector.page.wait_for_timeout(1200)
                if await connector._wait_any(connector.settings.pdc_selector_cpf_input, 5000):
                    return True
            except Exception:
                pass

        clicked = await _click_text_option(connector, "Consulta de Margem")
        print(f"[LOGIN_FLOW] govsp clique Consulta de Margem etapa {step}: {str(clicked).lower()}", file=sys.stderr, flush=True)
        if not clicked:
            return False
        await connector.page.wait_for_timeout(1800)
    try:
        return bool(await connector._wait_any(connector.settings.pdc_selector_cpf_input, 3000))
    except Exception:
        return False


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
    print(
        f"[CAPSOLVER] resolvendo reCAPTCHA stage={stage} enterprise={bool(metadata.get('enterprise'))}",
        file=sys.stderr,
        flush=True,
    )
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


async def find_login_elements(connector: PortalSecundarioLegacyConnector) -> dict:
    return await _capture_login_button_debug(connector)


async def _click_login_initial_button(connector: PortalSecundarioLegacyConnector, *, timeout_ms: int = 2500) -> tuple[bool, str, dict]:
    debug = await find_login_elements(connector)
    candidate_selectors = [
        "#Entrar",
        "#btnEntrar",
        "#btnLogin",
        "#btnProxima",
        "input[name='Entrar']",
        "input[name='btnEntrar']",
        "input[name='btnLogin']",
        "input[type='submit']",
        "input[type='button']",
        "input[type='image']",
        "button[type='submit']",
        "button:has-text('Pr?xima')",
        "button:has-text('Proxima')",
        "a:has-text('Pr?xima')",
        "a:has-text('Proxima')",
        "input[value='Pr?xima']",
        "input[value='Proxima']",
        "input[value='Entrar']",
        "input[value='Acessar']",
    ]
    print(f"[LOGIN_FLOW] html do formul?rio de login, sem senha: {debug.get('formHtml') or ''}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] buttons encontrados: {json.dumps(debug.get('buttons') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] inputs submit/button encontrados: {json.dumps(debug.get('inputs') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] links encontrados pr?ximos ao form, se houver: {json.dumps(debug.get('links') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)

    attempts: list[dict] = []
    scopes = list(enumerate(_login_scopes(connector)))
    chosen_button = None
    chosen_selector = ""
    chosen_button_info = {}

    def _button_info_for_selector(selector: str) -> dict:
        raw = str(selector or "").strip()
        if not raw:
            return {}
        selector_lower = raw.lower()
        for btn in (debug.get('buttons') or []):
            candidates = [
                f"#{btn.get('id') or ''}".lower() if btn.get('id') else "",
                f"input[name='{btn.get('name') or ''}']".lower() if btn.get('name') else "",
                f"input[value='{btn.get('value') or ''}']".lower() if btn.get('value') else "",
                f"button:has-text('{str(btn.get('textContent') or '').strip()}')".lower() if btn.get('textContent') else "",
                f"a:has-text('{str(btn.get('textContent') or '').strip()}')".lower() if btn.get('textContent') else "",
            ]
            if any(candidate and candidate == selector_lower for candidate in candidates):
                return {
                    "tag": str(btn.get('tag') or ''),
                    "id": str(btn.get('id') or ''),
                    "name": str(btn.get('name') or ''),
                    "type": str(btn.get('type') or ''),
                    "value": str(btn.get('value') or ''),
                    "textContent": str(btn.get('textContent') or ''),
                    "className": str(btn.get('className') or ''),
                    "onclick": str(btn.get('onclick') or ''),
                }
        return {}

    async def _click_scope(scope, selector: str, method: str) -> bool:
        try:
            locator = scope.locator(selector).first
            await locator.wait_for(state='visible', timeout=timeout_ms)
            if method == 'js':
                await locator.evaluate(
                    """(el) => {
                        const fire = (type) => el.dispatchEvent(new MouseEvent(type, {
                            bubbles: true,
                            cancelable: true,
                            view: window,
                        }));
                        fire('mousedown');
                        fire('mouseup');
                        fire('click');
                        if (typeof el.click === 'function') {
                            el.click();
                        }
                    }"""
                )
            else:
                try:
                    await locator.click(timeout=timeout_ms, force=True, no_wait_after=True)
                except TypeError:
                    await locator.click(timeout=timeout_ms, force=True)
            return True
        except Exception:
            return False

    async def _submit_form(scope) -> bool:
        try:
            return bool(
                await scope.evaluate(
                    """() => {
                        const button = document.querySelector('#Entrar, #btnEntrar, #btnProxima, input[name="Entrar"], input[value="Próxima"], input[value="Proxima"]');
                        const form = button?.form || document.querySelector('form');
                        if (button && form && typeof form.requestSubmit === 'function') {
                            form.requestSubmit(button);
                            return true;
                        }
                        if (form) {
                            if (button && typeof button.click === 'function') {
                                button.click();
                                return true;
                            }
                            form.submit();
                            return true;
                        }
                        return false;
                    }"""
                )
            )
        except Exception:
            return False

    async def _do_postback(scope) -> bool:
        try:
            return bool(
                await scope.evaluate(
                    """() => {
                        const button = document.querySelector('#Entrar, #btnEntrar, #btnProxima, input[name="Entrar"], input[value="Próxima"], input[value="Proxima"]');
                        if (button && typeof button.click === 'function') {
                            button.click();
                            return true;
                        }
                        if (typeof __doPostBack === 'function') {
                            __doPostBack('Entrar', '');
                            return true;
                        }
                        return false;
                    }"""
                )
            )
        except Exception:
            return False

    async def _click_by_normalized_text(scope) -> tuple[bool, dict]:
        try:
            result = await scope.evaluate(
                """() => {
                    const normalize = (value) => String(value || '')
                        .normalize('NFD')
                        .replace(/[\\u0300-\\u036f]/g, '')
                        .replace(/\\s+/g, ' ')
                        .trim()
                        .toLowerCase();
                    const candidates = Array.from(document.querySelectorAll('button,input[type="button"],input[type="submit"],a,[role="button"]'));
                    for (const el of candidates) {
                        const text = normalize([
                            el.innerText,
                            el.textContent,
                            el.value,
                            el.getAttribute('aria-label'),
                            el.getAttribute('title'),
                            el.id,
                            el.name,
                        ].filter(Boolean).join(' '));
                        if (!text) continue;
                        if (['proxima', 'entrar', 'acessar', 'login', 'continuar'].some((token) => text.includes(token))) {
                            el.click();
                            return {
                                clicked: true,
                                tag: el.tagName,
                                id: el.id || '',
                                name: el.getAttribute('name') || '',
                                type: el.getAttribute('type') || '',
                                value: el.getAttribute('value') || '',
                                textContent: el.textContent || '',
                                className: el.className || '',
                                onclick: String(el.getAttribute('onclick') || ''),
                            };
                        }
                    }
                    return { clicked: false };
                }"""
            )
            return bool((result or {}).get("clicked")), result or {}
        except Exception:
            return False, {}

    for selector in candidate_selectors:
        for scope_index, scope in scopes:
            ok_normal = await _click_scope(scope, selector, 'click')
            attempts.append({"selector": selector, "scope": scope_index, "method": "click", "ok": ok_normal})
            if ok_normal:
                chosen_button = selector
                chosen_selector = selector
                chosen_button_info = _button_info_for_selector(selector)
                scope_label = 'page' if scope_index == 0 else f'frame-{scope_index}'
                print(f"[LOGIN_FLOW] botao clicado: {selector} ({scope_label})", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] tentou click normal: true", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] tentou click JS: false", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] tentou Enter: false", file=sys.stderr, flush=True)
                return True, selector, {**debug, "attempts": attempts, "chosenButton": chosen_button, "chosenSelector": chosen_selector, "chosenMethod": "click", "chosenButtonInfo": chosen_button_info}

    for selector in candidate_selectors:
        for scope_index, scope in scopes:
            ok_js = await _click_scope(scope, selector, 'js')
            attempts.append({"selector": selector, "scope": scope_index, "method": "js", "ok": ok_js})
            if ok_js:
                chosen_button = selector
                chosen_selector = selector
                chosen_button_info = _button_info_for_selector(selector)
                scope_label = 'page' if scope_index == 0 else f'frame-{scope_index}'
                print(f"[LOGIN_FLOW] botao clicado: {selector} ({scope_label}) via JS", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] tentou click normal: false", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] tentou click JS: true", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] tentou Enter: false", file=sys.stderr, flush=True)
                return True, selector, {**debug, "attempts": attempts, "chosenButton": chosen_button, "chosenSelector": chosen_selector, "chosenMethod": "js", "chosenButtonInfo": chosen_button_info}

    for scope_index, scope in scopes:
        ok_text, text_button_info = await _click_by_normalized_text(scope)
        attempts.append({"selector": "normalized_text", "scope": scope_index, "method": "normalized_text", "ok": ok_text})
        if ok_text:
            scope_label = 'page' if scope_index == 0 else f'frame-{scope_index}'
            print(f"[LOGIN_FLOW] botao clicado por texto normalizado ({scope_label})", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou click normal: false", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou click JS: true", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou Enter: false", file=sys.stderr, flush=True)
            return True, 'normalized_text', {**debug, "attempts": attempts, "chosenButton": 'normalized_text', "chosenSelector": 'normalized_text', "chosenMethod": "normalized_text", "chosenButtonInfo": text_button_info}

    for scope_index, scope in scopes:
        ok_postback = await _do_postback(scope)
        attempts.append({"selector": "#Entrar", "scope": scope_index, "method": "do_postback", "ok": ok_postback})
        if ok_postback:
            chosen_button = "#Entrar"
            chosen_selector = "#Entrar"
            chosen_button_info = _button_info_for_selector("#Entrar")
            scope_label = 'page' if scope_index == 0 else f'frame-{scope_index}'
            print(f"[LOGIN_FLOW] botao clicado: __doPostBack(Entrar) ({scope_label})", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou click normal: false", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou click JS: false", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou Enter: false", file=sys.stderr, flush=True)
            return True, '#Entrar', {**debug, "attempts": attempts, "chosenButton": chosen_button, "chosenSelector": chosen_selector, "chosenMethod": "do_postback", "chosenButtonInfo": chosen_button_info}

    for scope_index, scope in scopes:
        ok_submit = await _submit_form(scope)
        attempts.append({"selector": "form", "scope": scope_index, "method": "form_submit", "ok": ok_submit})
        if ok_submit:
            chosen_button = "#Entrar"
            chosen_selector = "#Entrar"
            chosen_button_info = _button_info_for_selector("#Entrar")
            scope_label = 'page' if scope_index == 0 else f'frame-{scope_index}'
            print(f"[LOGIN_FLOW] botao clicado: form.submit() ({scope_label})", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou click normal: false", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou click JS: false", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou Enter: false", file=sys.stderr, flush=True)
            return True, '#Entrar', {**debug, "attempts": attempts, "chosenButton": chosen_button, "chosenSelector": chosen_selector, "chosenMethod": "form_submit", "chosenButtonInfo": chosen_button_info}

    for scope_index, scope in scopes:
        try:
            login_locator = scope.locator('#txtLogin').first
            await login_locator.press('Enter', timeout=timeout_ms)
            scope_label = 'page' if scope_index == 0 else f'frame-{scope_index}'
            print(f"[LOGIN_FLOW] botao clicado: Enter no txtLogin ({scope_label})", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou click normal: false", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou click JS: false", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou Enter: true", file=sys.stderr, flush=True)
            return True, 'Enter', {**debug, "attempts": attempts, "chosenButton": 'Enter', "chosenSelector": '#txtLogin', "chosenMethod": 'enter', "chosenButtonInfo": {"tag": "input", "id": "txtLogin", "name": "", "type": "text", "value": "", "textContent": "", "className": "", "onclick": ""}}
        except Exception:
            continue

    try:
        form_buttons = [
            btn for btn in (debug.get('buttons') or [])
            if str(btn.get('tag') or '').lower() in {'button', 'input', 'a', 'img'}
        ]
        for btn in form_buttons:
            label = ' '.join(
                [
                    str(btn.get('id') or ''),
                    str(btn.get('name') or ''),
                    str(btn.get('value') or ''),
                    str(btn.get('textContent') or ''),
                ]
            ).strip()
            normalized = label.lower()
            if not any(token in normalized for token in ['pr?xima', 'proxima', 'entrar', 'acessar', 'login']):
                continue
            selector = ''
            if btn.get('id'):
                selector = f"#{btn.get('id')}"
            elif btn.get('name') and str(btn.get('tag') or '').lower() == 'input':
                selector = f"input[name='{btn.get('name')}']"
            elif str(btn.get('tag') or '').lower() == 'input' and btn.get('value'):
                selector = f"input[value='{btn.get('value')}']"
            elif str(btn.get('tag') or '').lower() == 'button' and btn.get('textContent'):
                button_text = str(btn.get('textContent') or '').replace("'", "\'")
                selector = f"button:has-text('{button_text}')"
            elif str(btn.get('tag') or '').lower() == 'a' and btn.get('textContent'):
                anchor_text = str(btn.get('textContent') or '').replace("'", "\'")
                selector = f"a:has-text('{anchor_text}')"
            if not selector:
                continue
            for scope_index, scope in scopes:
                ok_normal = await _click_scope(scope, selector, 'click')
                attempts.append({"selector": selector, "scope": scope_index, "method": "click-fallback", "ok": ok_normal})
                if ok_normal:
                    scope_label = 'page' if scope_index == 0 else f'frame-{scope_index}'
                    print(f"[LOGIN_FLOW] botao clicado via fallback: {selector} ({scope_label})", file=sys.stderr, flush=True)
                    print(f"[LOGIN_FLOW] tentou click normal: true", file=sys.stderr, flush=True)
                    print(f"[LOGIN_FLOW] tentou click JS: false", file=sys.stderr, flush=True)
                    print(f"[LOGIN_FLOW] tentou Enter: false", file=sys.stderr, flush=True)
                    return True, selector, {**debug, "attempts": attempts, "chosenButton": selector, "chosenSelector": selector, "chosenMethod": "click-fallback", "chosenButtonInfo": chosen_button_info}
        
    except Exception:
        pass

    print('[LOGIN_FLOW] selector inv?lido ignorado: button_login_fallback', file=sys.stderr, flush=True)
    return False, '', {**debug, "attempts": attempts, "chosenButton": '', "chosenSelector": '', "chosenMethod": ''}


async def _capture_login_modal_state(connector: PortalSecundarioLegacyConnector) -> dict:
    try:
        return await connector.page.evaluate(
            """() => {
                const normalize = (v) => String(v || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").replace(/\\s+/g, " ").trim().toLowerCase();
                const isVisible = (el) => {
                    if (!el) return false;
                    const style = window.getComputedStyle(el);
                    if (!style) return false;
                    const rect = el.getBoundingClientRect();
                    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
                };
                const textOf = (el) => String(el?.textContent || el?.value || "").replace(/\\s+/g, " ").trim();
                const selectors = [
                    "#ucAjaxModalPopup1_btnConfirmarPopup",
                    "#ucAjaxModalPopup1_lblMensagem",
                    "#mensagemLabel",
                    "span#mensagemLabel",
                    "#lblMsgRH",
                    "#messageLabel",
                    "[id*='Popup']",
                    "[class*='Popup']",
                    "[id*='popup']",
                    "[class*='popup']",
                ];
                const elements = [];
                for (const selector of selectors) {
                    try {
                        for (const el of document.querySelectorAll(selector)) {
                            if (isVisible(el)) {
                                elements.push(el);
                            }
                        }
                    } catch (_) {}
                }
                const popupOk = Array.from(document.querySelectorAll("button,input[type='submit'],input[type='button'],a")).find((el) => {
                    if (!isVisible(el)) return false;
                    const text = normalize(textOf(el));
                    return text === "ok" || text.includes("ok");
                }) || null;
                const messageLabel = Array.from(document.querySelectorAll("#mensagemLabel, span#mensagemLabel, #lblMsgRH, #messageLabel")).find((el) => isVisible(el)) || null;
                const popupText = elements.map(textOf).filter(Boolean).join(" | ");
                const popupElements = elements.slice(0, 20).map((el) => ({
                    tag: String(el.tagName || "").toLowerCase(),
                    id: String(el.id || ""),
                    name: String(el.name || ""),
                    type: String(el.type || ""),
                    value: String(el.value || ""),
                    textContent: textOf(el),
                    className: String(el.className || ""),
                    onclick: String(el.getAttribute("onclick") || ""),
                }));
                return {
                    popupFound: Boolean(elements.length || popupOk || messageLabel),
                    popupOkFound: Boolean(popupOk),
                    popupOkSelector: popupOk ? "#ucAjaxModalPopup1_btnConfirmarPopup" : "",
                    popupText: popupText.slice(0, 500),
                    messageLabelText: textOf(messageLabel),
                    hasDoPostBack: typeof __doPostBack === "function",
                    popupElements,
                };
            }""",
        )
    except Exception:
        return {
            "popupFound": False,
            "popupOkFound": False,
            "popupOkSelector": "",
            "popupText": "",
            "messageLabelText": "",
            "hasDoPostBack": False,
            "popupElements": [],
        }


async def _capture_second_stage_login_debug(connector: PortalSecundarioLegacyConnector) -> dict:
    password_selectors = [
        "#txtSenha",
        "input[name='txtSenha']",
        "input[type='password']",
        "input[id*='Senha']",
        "input[name*='Senha']",
        "input[id*='senha']",
        "input[name*='senha']",
    ]
    button_selectors = [
        "#Entrar",
        "#btnEntrar",
        "#btnLogin",
        "input[name='Entrar']",
        "input[name='btnEntrar']",
        "input[name='btnLogin']",
        "input[type='submit']",
        "input[type='button']",
        "button[type='submit']",
        "input[value='Entrar']",
        "input[value='Acessar']",
        "button:has-text('Entrar')",
        "button:has-text('Acessar')",
    ]

    aggregate = {
        "secondStageDetected": False,
        "url": "",
        "title": "",
        "passwordFound": False,
        "passwordSelector": "",
        "buttonFound": False,
        "buttonSelector": "",
        "inputCount": 0,
        "inputs": [],
        "buttons": [],
        "links": [],
        "scopes": [],
    }

    for scope_index, scope in enumerate(_login_scopes(connector)):
        try:
            scope_data = await scope.evaluate(
                """({ passwordSelectors, buttonSelectors }) => {
                    const normalize = (value) => String(value || "")
                      .normalize("NFD")
                      .replace(/[\\u0300-\\u036f]/g, "")
                      .replace(/\\s+/g, " ")
                      .trim()
                      .toLowerCase();
                    const isVisible = (el) => {
                      if (!el) return false;
                      const style = window.getComputedStyle(el);
                      if (!style) return false;
                      const rect = el.getBoundingClientRect();
                      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
                    };
                    const matchesAny = (el, selectors) => selectors.some((selector) => {
                      const raw = String(selector || "").trim();
                      if (!raw) return false;
                      const id = String(el.id || "");
                      const name = String(el.name || "");
                      const type = String(el.type || "");
                      const value = String(el.value || "");
                      const placeholder = String(el.getAttribute("placeholder") || "");
                      const text = normalize(String(el.textContent || ""));
                      if (raw === "#txtSenha") return id === "txtSenha";
                      if (raw === "input[name='txtSenha']") return name === "txtSenha";
                      if (raw === "input[type='password']") return type === "password";
                      if (raw === "input[id*='Senha']") return /senha/i.test(id);
                      if (raw === "input[name*='Senha']") return /senha/i.test(name);
                      if (raw === "input[id*='senha']") return /senha/i.test(id);
                      if (raw === "input[name*='senha']") return /senha/i.test(name);
                      if (raw === "#Entrar") return id === "Entrar";
                      if (raw === "#btnEntrar") return id === "btnEntrar";
                      if (raw === "#btnLogin") return id === "btnLogin";
                      if (raw === "input[name='Entrar']") return name === "Entrar";
                      if (raw === "input[name='btnEntrar']") return name === "btnEntrar";
                      if (raw === "input[name='btnLogin']") return name === "btnLogin";
                      if (raw === "input[type='submit']") return type === "submit";
                      if (raw === "input[type='button']") return type === "button";
                      if (raw === "button[type='submit']") return el.tagName && el.tagName.toLowerCase() === "button" && type === "submit";
                      if (raw === "input[value='Entrar']") return value === "Entrar";
                      if (raw === "input[value='Acessar']") return value === "Acessar";
                      if (raw === "button:has-text('Entrar')") return el.tagName && el.tagName.toLowerCase() === "button" && text.includes("entrar");
                      if (raw === "button:has-text('Acessar')") return el.tagName && el.tagName.toLowerCase() === "button" && text.includes("acessar");
                      return false;
                    });
                    const summarize = (el) => ({
                      tag: String(el.tagName || "").toLowerCase(),
                      id: String(el.id || ""),
                      name: String(el.name || ""),
                      type: String(el.type || ""),
                      placeholder: String(el.getAttribute("placeholder") || ""),
                      value: String(el.value || ""),
                      textContent: String(el.textContent || "").replace(/\\s+/g, " ").trim(),
                      className: String(el.className || ""),
                    });
                    const inputs = Array.from(document.querySelectorAll("input"))
                      .filter((el) => isVisible(el))
                      .map(summarize);
                    const buttons = Array.from(document.querySelectorAll("button,input[type='submit'],input[type='button'],input[type='image'],a"))
                      .filter((el) => isVisible(el))
                      .map(summarize);
                    const links = Array.from(document.querySelectorAll("a"))
                      .filter((el) => isVisible(el))
                      .map(summarize);
                    const passwordEl = Array.from(document.querySelectorAll("input,textarea"))
                      .find((el) => isVisible(el) && matchesAny(el, passwordSelectors)) || null;
                    const buttonEl = Array.from(document.querySelectorAll("button,input[type='submit'],input[type='button'],input[type='image'],a"))
                      .find((el) => isVisible(el) && matchesAny(el, buttonSelectors)) || null;
                    return {
                      url: String(location.href || ""),
                      title: String(document.title || ""),
                      secondStageDetected: /LoginSegundaEtapa\\.aspx/i.test(String(location.href || "")),
                      inputCount: inputs.length,
                      inputs,
                      buttons,
                      links,
                      passwordFound: Boolean(passwordEl),
                      passwordSelector: passwordEl ? (
                        passwordEl.id ? `#${passwordEl.id}` :
                        passwordEl.name ? `input[name='${String(passwordEl.name).replace(/'/g, "\\'")}']` :
                        passwordEl.type === "password" ? "input[type='password']" : ""
                      ) : "",
                      buttonFound: Boolean(buttonEl),
                      buttonSelector: buttonEl ? (
                        buttonEl.id ? `#${buttonEl.id}` :
                        buttonEl.name && String(buttonEl.tagName || "").toLowerCase() === "input" ? `input[name='${String(buttonEl.name).replace(/'/g, "\\'")}']` :
                        buttonEl.type ? `input[type='${String(buttonEl.type)}']` : ""
                      ) : "",
                    };
                }""",
                {"passwordSelectors": password_selectors, "buttonSelectors": button_selectors},
            )
        except Exception as exc:
            scope_data = {
                "url": "",
                "title": "",
                "secondStageDetected": False,
                "inputCount": 0,
                "inputs": [],
                "buttons": [],
                "links": [],
                "passwordFound": False,
                "passwordSelector": "",
                "buttonFound": False,
                "buttonSelector": "",
                "error": str(exc),
            }
        scope_data["scopeIndex"] = scope_index
        aggregate["scopes"].append(scope_data)
        aggregate["inputCount"] += int(scope_data.get("inputCount") or 0)
        aggregate["inputs"].extend(list(scope_data.get("inputs") or []))
        aggregate["buttons"].extend(list(scope_data.get("buttons") or []))
        aggregate["links"].extend(list(scope_data.get("links") or []))
        aggregate["secondStageDetected"] = bool(aggregate["secondStageDetected"] or scope_data.get("secondStageDetected"))
        aggregate["passwordFound"] = bool(aggregate["passwordFound"] or scope_data.get("passwordFound"))
        aggregate["buttonFound"] = bool(aggregate["buttonFound"] or scope_data.get("buttonFound"))
        if not aggregate["url"] and scope_data.get("url"):
            aggregate["url"] = str(scope_data.get("url") or "")
        if not aggregate["title"] and scope_data.get("title"):
            aggregate["title"] = str(scope_data.get("title") or "")
        if not aggregate["passwordSelector"] and scope_data.get("passwordSelector"):
            aggregate["passwordSelector"] = str(scope_data.get("passwordSelector") or "")
        if not aggregate["buttonSelector"] and scope_data.get("buttonSelector"):
            aggregate["buttonSelector"] = str(scope_data.get("buttonSelector") or "")

    return aggregate


async def _capture_convenio_selection_debug(connector: PortalSecundarioLegacyConnector, target_terms: list[str] | None = None) -> dict:
    target_terms = target_terms or _convenio_target_terms(_portal_id(connector))
    aggregate = {
        "selectionDetected": False,
        "url": "",
        "title": "",
        "bodySnippet": "",
        "bodyNormalized": "",
        "inputCount": 0,
        "inputs": [],
        "buttons": [],
        "links": [],
        "tables": [],
        "rows": [],
        "rowCount": 0,
        "targetFound": False,
        "actionFound": False,
        "singleConvenio": False,
        "multipleConvenios": False,
        "selectedRow": None,
        "selectedAction": None,
    }

    for scope_index, scope in enumerate(_login_scopes(connector)):
        try:
            scope_data = await scope.evaluate(
                """({ targetTerms }) => {
                    const normalize = (value) => String(value || "")
                      .normalize("NFD")
                      .replace(/[\\u0300-\\u036f]/g, "")
                      .replace(/\\s+/g, " ")
                      .trim()
                      .toLowerCase();
                    const isVisible = (el) => {
                      if (!el) return false;
                      const style = window.getComputedStyle(el);
                      if (!style) return false;
                      const rect = el.getBoundingClientRect();
                      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
                    };
                    const textOf = (el) => String(el?.textContent || el?.value || "").replace(/\\s+/g, " ").trim();
                    const q = (text) => String(text || "").replace(/\\\\/g, "\\\\\\\\").replace(/'/g, "\\\\'");
                    const matchesTarget = (text) => {
                      const hay = normalize(text);
                      return (targetTerms || []).some((term) => term && hay.includes(normalize(term)));
                    };
                    const summarizeElement = (el) => {
                      const tag = String(el.tagName || "").toLowerCase();
                      const textContent = textOf(el);
                      const onclick = String(el.getAttribute("onclick") || "");
                      const postbackMatch = onclick.match(/__doPostBack\\(['\"]([^'\"]*)['\"],['\"]([^'\"]*)['\"]\\)/i);
                      const selectorHints = [];
                      const domSelectors = [];
                      if (el.id) {
                        selectorHints.push(`#${q(el.id)}`);
                        domSelectors.push(`#${q(el.id)}`);
                      }
                      if (el.name) {
                        const byName = `${tag}[name='${q(el.name)}']`;
                        selectorHints.push(byName);
                        domSelectors.push(byName);
                      }
                      if (tag === "input" && el.value) {
                        const byValue = `input[value='${q(el.value)}']`;
                        selectorHints.push(byValue);
                        domSelectors.push(byValue);
                      }
                      if (tag === "a" && el.href) {
                        const byHref = `a[href='${q(el.href)}']`;
                        selectorHints.push(byHref);
                        domSelectors.push(byHref);
                      }
                      if (tag === "img") {
                        const alt = String(el.getAttribute("alt") || "").trim();
                        const title = String(el.getAttribute("title") || "").trim();
                        if (alt) {
                          const byAlt = `img[alt='${q(alt)}']`;
                          selectorHints.push(byAlt);
                          domSelectors.push(byAlt);
                        }
                        if (title) {
                          const byTitle = `img[title='${q(title)}']`;
                          selectorHints.push(byTitle);
                          domSelectors.push(byTitle);
                        }
                      }
                      if (tag === "button" && textContent) {
                        selectorHints.push(`button:has-text('${q(textContent)}')`);
                      }
                      if (tag === "a" && textContent) {
                        selectorHints.push(`a:has-text('${q(textContent)}')`);
                      }
                      return {
                        tag,
                        id: String(el.id || ""),
                        name: String(el.name || ""),
                        type: String(el.type || ""),
                        value: String(el.value || ""),
                        textContent,
                        className: String(el.className || ""),
                        href: String(el.href || ""),
                        onclick,
                        postbackTarget: postbackMatch ? String(postbackMatch[1] || "") : "",
                        postbackArg: postbackMatch ? String(postbackMatch[2] || "") : "",
                        selectorHints: Array.from(new Set(selectorHints)).slice(0, 12),
                        domSelectors: Array.from(new Set(domSelectors)).slice(0, 12),
                      };
                    };
                    const collect = (root) => {
                      const inputList = Array.from(root.querySelectorAll("input"))
                        .filter((el) => isVisible(el))
                        .map((el) => ({
                          tag: String(el.tagName || "").toLowerCase(),
                          id: String(el.id || ""),
                          name: String(el.name || ""),
                          type: String(el.type || ""),
                          placeholder: String(el.getAttribute("placeholder") || ""),
                          value: String(el.value || ""),
                          textContent: textOf(el),
                          className: String(el.className || ""),
                        }));
                      const buttonList = Array.from(root.querySelectorAll("button,input[type='submit'],input[type='button'],a"))
                        .filter((el) => isVisible(el))
                        .map((el) => ({
                          tag: String(el.tagName || "").toLowerCase(),
                          id: String(el.id || ""),
                          name: String(el.name || ""),
                          type: String(el.type || ""),
                          value: String(el.value || ""),
                          textContent: textOf(el),
                          className: String(el.className || ""),
                          href: String(el.href || ""),
                          onclick: String(el.getAttribute("onclick") || ""),
                        }));
                      const linkList = Array.from(root.querySelectorAll("a"))
                        .filter((el) => isVisible(el))
                        .map((el) => ({
                          href: String(el.href || ""),
                          id: String(el.id || ""),
                          name: String(el.name || ""),
                          textContent: textOf(el),
                          className: String(el.className || ""),
                        }));
                      const tables = [];
                      const rows = [];
                      let totalRows = 0;
                      const tableList = Array.from(root.querySelectorAll("table")).filter((el) => isVisible(el));
                      tableList.forEach((table, tableIndex) => {
                        const headerCells = Array.from(table.querySelectorAll("th"))
                          .filter((el) => isVisible(el))
                          .map(textOf)
                          .filter(Boolean);
                        const tableRows = Array.from(table.querySelectorAll("tr")).filter((el) => isVisible(el));
                        const rowSummaries = [];
                        const headerIndex = headerCells.findIndex((text) => normalize(text).includes("acao"));
                        tableRows.forEach((row, rowIndex) => {
                          const cells = Array.from(row.querySelectorAll("th,td")).filter((el) => isVisible(el));
                          const cellTexts = cells.map(textOf);
                          const rowText = cellTexts.join(" | ").replace(/\\s+/g, " ").trim();
                          const rowTextNormalized = normalize(rowText);
                          if (!rowTextNormalized) {
                            return;
                          }
                          const targetMatch = matchesTarget(rowText);
                          const actionCellIndex = headerIndex >= 0 ? headerIndex : Math.max(cells.length - 1, 0);
                          const actionCell = cells[actionCellIndex] || cells[cells.length - 1] || null;
                          const actionNodes = actionCell
                            ? Array.from(actionCell.querySelectorAll("a,button,input[type='submit'],input[type='button'],input[type='image'],img,[onclick]"))
                                .filter((el) => isVisible(el))
                            : [];
                          if (actionCell && isVisible(actionCell) && String(actionCell.getAttribute("onclick") || "").trim()) {
                            actionNodes.unshift(actionCell);
                          }
                          const actionCandidates = actionNodes.map(summarizeElement).slice(0, 8);
                          const actionFound = Boolean(actionCandidates.length);
                          const rowInfo = {
                            tableIndex,
                            rowIndex,
                            rowText,
                            rowTextNormalized,
                            targetMatch,
                            actionFound,
                            actionCellIndex,
                            cells: cellTexts.slice(0, 12),
                            actionCandidates,
                          };
                          rowSummaries.push(rowInfo);
                          rows.push(rowInfo);
                        });
                        tables.push({
                          tableIndex,
                          headers: headerCells.slice(0, 12),
                          rowCount: rowSummaries.length,
                          cellCount: rowSummaries.reduce((acc, item) => acc + (item.cells ? item.cells.length : 0), 0),
                          rows: rowSummaries.slice(0, 12),
                        });
                      });
                      const targetRows = rows.filter((row) => row.targetMatch);
                      let selectedRow = null;
                      if (targetRows.length) {
                        selectedRow = targetRows[0];
                      } else if (rows.length === 1) {
                        selectedRow = rows[0];
                      }
                      const selectedAction = selectedRow && selectedRow.actionCandidates && selectedRow.actionCandidates.length
                        ? selectedRow.actionCandidates[0]
                        : null;
                      return {
                        selectionDetected: /selecione o convenio|selecione o convênio|convenio sigla acao|convênio sigla ação|selecao de perfil|seleção de perfil|sua conta esta associada a mais de um perfil|sua conta está associada a mais de um perfil/i.test(String(root.body?.innerText || root.body?.textContent || "")) || /loginselecao\\.aspx|selecaoperfil/i.test(String(location.href || "")),
                        url: String(location.href || ""),
                        title: String(document.title || ""),
                        bodySnippet: String(root.body?.innerText || root.body?.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500),
                        bodyNormalized: normalize(String(root.body?.innerText || root.body?.textContent || "")).slice(0, 500),
                        inputCount: inputList.length,
                        inputs: inputList.slice(0, 30),
                        buttons: buttonList.slice(0, 30),
                        links: linkList.slice(0, 30),
                        tables,
                        rows: rows.slice(0, 60),
                        rowCount: rows.length,
                        targetFound: Boolean(targetRows.length),
                        actionFound: Boolean(selectedAction),
                        singleConvenio: rows.length === 1,
                        multipleConvenios: rows.length > 1,
                        selectedRow,
                        selectedAction,
                        targetCount: targetRows.length,
                      };
                    };
                    return collect(document);
                }""",
                {"targetTerms": target_terms},
            )
        except Exception as exc:
            scope_data = {
                "selectionDetected": False,
                "url": getattr(scope, "url", ""),
                "title": "",
                "bodySnippet": "",
                "bodyNormalized": "",
                "inputCount": 0,
                "inputs": [],
                "buttons": [],
                "links": [],
                "tables": [],
                "rows": [],
                "rowCount": 0,
                "targetFound": False,
                "actionFound": False,
                "singleConvenio": False,
                "multipleConvenios": False,
                "selectedRow": None,
                "selectedAction": None,
                "targetCount": 0,
                "error": str(exc),
            }
        scope_data["scopeIndex"] = scope_index
        aggregate["url"] = aggregate["url"] or str(scope_data.get("url") or "")
        aggregate["title"] = aggregate["title"] or str(scope_data.get("title") or "")
        aggregate["bodySnippet"] = aggregate["bodySnippet"] or str(scope_data.get("bodySnippet") or "")
        aggregate["bodyNormalized"] = aggregate["bodyNormalized"] or str(scope_data.get("bodyNormalized") or "")
        aggregate["selectionDetected"] = bool(aggregate["selectionDetected"] or scope_data.get("selectionDetected"))
        aggregate["inputCount"] += int(scope_data.get("inputCount") or 0)
        aggregate["inputs"].extend(list(scope_data.get("inputs") or []))
        aggregate["buttons"].extend(list(scope_data.get("buttons") or []))
        aggregate["links"].extend(list(scope_data.get("links") or []))
        aggregate["tables"].extend(list(scope_data.get("tables") or []))
        scoped_rows = []
        for row in list(scope_data.get("rows") or []):
            row_copy = dict(row or {})
            row_copy["scopeIndex"] = scope_index
            scoped_rows.append(row_copy)
        aggregate["rows"].extend(scoped_rows)
        aggregate["rowCount"] += int(scope_data.get("rowCount") or 0)
        aggregate["targetFound"] = bool(aggregate["targetFound"] or scope_data.get("targetFound"))
        aggregate["actionFound"] = bool(aggregate["actionFound"] or scope_data.get("actionFound"))
        aggregate["singleConvenio"] = bool(aggregate["singleConvenio"] or scope_data.get("singleConvenio"))
        aggregate["multipleConvenios"] = bool(aggregate["multipleConvenios"] or scope_data.get("multipleConvenios"))
        if not aggregate["selectedRow"] and scope_data.get("selectedRow"):
            selected_row = dict(scope_data.get("selectedRow") or {})
            selected_row["scopeIndex"] = scope_index
            aggregate["selectedRow"] = selected_row
        if not aggregate["selectedAction"] and scope_data.get("selectedAction"):
            selected_action = dict(scope_data.get("selectedAction") or {})
            selected_action["scopeIndex"] = scope_index
            aggregate["selectedAction"] = selected_action

    return aggregate


async def _click_convenio_action(
    connector: PortalSecundarioLegacyConnector,
    selection_debug: dict,
    timeout_ms: int,
    target_terms: list[str] | None = None,
) -> tuple[bool, str, dict]:
    selected_row = dict(selection_debug.get("selectedRow") or {})
    selected_action = dict(selection_debug.get("selectedAction") or {})
    selected_scope_index = int(selected_row.get("scopeIndex") or selected_action.get("scopeIndex") or 0)
    scopes = list(_login_scopes(connector))
    ordered_scopes = scopes[selected_scope_index:] + scopes[:selected_scope_index] if scopes else []
    if not ordered_scopes:
        ordered_scopes = scopes

    selector_hints = list(selected_action.get("selectorHints") or [])
    dom_selectors = list(selected_action.get("domSelectors") or [])
    postback_target = str(selected_action.get("postbackTarget") or "").strip()
    postback_arg = str(selected_action.get("postbackArg") or "").strip()
    row_text = str(selected_row.get("rowText") or "").strip()
    action_text = str(selected_action.get("textContent") or "").strip()

    async def _click_by_selector(scope, selector: str, *, force: bool = False, js: bool = False) -> bool:
        if not selector:
            return False
        try:
            if js:
                if selector.startswith("button:has-text(") or selector.startswith("a:has-text("):
                    return False
                return bool(
                    await scope.evaluate(
                        """(selector) => {
                            try {
                                const el = document.querySelector(selector);
                                if (!el) return false;
                                el.click();
                                return true;
                            } catch (_) {
                                return false;
                            }
                        }""",
                        selector,
                    )
                )
            await scope.locator(selector).first.click(timeout=timeout_ms, force=force)
            return True
        except Exception:
            return False

    async def _click_row(scope) -> bool:
        try:
            return bool(
                await scope.evaluate(
                    """({ rowText, actionText, postbackTarget, postbackArg, targetTerms }) => {
                        const normalize = (value) => String(value || "")
                          .normalize("NFD")
                          .replace(/[\\u0300-\\u036f]/g, "")
                          .replace(/\\s+/g, " ")
                          .trim()
                          .toLowerCase();
                        const wantedRow = normalize(rowText);
                        const wantedAction = normalize(actionText);
                        const terms = (targetTerms || []).map((term) => normalize(term)).filter(Boolean);
                        const isVisible = (el) => {
                          if (!el) return false;
                          const style = window.getComputedStyle(el);
                          if (!style) return false;
                          const rect = el.getBoundingClientRect();
                          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
                        };
                        const rows = Array.from(document.querySelectorAll("table tr")).filter((el) => isVisible(el));
                        const matchRow = rows.find((row) => {
                          const rowTextNow = normalize(String(row.innerText || row.textContent || ""));
                          if (wantedRow && rowTextNow.includes(wantedRow)) return true;
                          return terms.some((term) => term && rowTextNow.includes(term));
                        });
                        if (!matchRow) return false;
                        const actionNodes = Array.from(matchRow.querySelectorAll("a,button,input[type='submit'],input[type='button'],input[type='image'],img,[onclick]")).filter((el) => isVisible(el));
                        let chosen = actionNodes.find((el) => wantedAction && normalize(String(el.innerText || el.textContent || el.value || "")).includes(wantedAction)) || actionNodes[0] || null;
                        if (!chosen) {
                          chosen = matchRow;
                        }
                        const onclick = String(chosen.getAttribute ? chosen.getAttribute("onclick") || "" : "");
                        if (postbackTarget && typeof __doPostBack === "function") {
                          __doPostBack(postbackTarget, postbackArg || "");
                          return true;
                        }
                        try {
                          chosen.click();
                          return true;
                        } catch (_) {
                          try {
                            matchRow.click();
                            return true;
                          } catch (_) {
                            return false;
                          }
                        }
                    }""",
                    {
                        "rowText": row_text,
                        "actionText": action_text,
                        "postbackTarget": postback_target,
                        "postbackArg": postback_arg,
                        "targetTerms": target_terms or _convenio_target_terms(_portal_id(connector)),
                    },
                )
            )
        except Exception:
            return False

    async def _do_postback(scope) -> bool:
        if not postback_target:
            return False
        try:
            return bool(
                await scope.evaluate(
                    """({ postbackTarget, postbackArg }) => {
                        try {
                            if (typeof __doPostBack === "function") {
                                __doPostBack(postbackTarget, postbackArg || "");
                                return true;
                            }
                        } catch (_) {}
                        return false;
                    }""",
                    {"postbackTarget": postback_target, "postbackArg": postback_arg},
                )
            )
        except Exception:
            return False

    methods = [
        ("locator_click", False, False),
        ("page_click_force", True, False),
        ("js_click", False, True),
        ("do_postback", False, False),
        ("row_click_js", False, False),
    ]

    for scope_index, scope in enumerate(ordered_scopes or scopes):
        scope_label = "page" if scope_index == 0 else f"frame-{scope_index}"
        for selector in selector_hints:
            print(f"[LOGIN_FLOW] convenio action candidate: {selector} ({scope_label})", file=sys.stderr, flush=True)
        for method_name, force_click, js_click in methods:
            print(f"[LOGIN_FLOW] convenio clique tentativa: {method_name} ({scope_label})", file=sys.stderr, flush=True)
            action_ok = False
            if method_name == "do_postback":
                action_ok = await _do_postback(scope)
            elif method_name == "row_click_js":
                action_ok = await _click_row(scope)
            else:
                for selector in selector_hints or dom_selectors:
                    action_ok = await _click_by_selector(scope, selector, force=force_click, js=js_click)
                    if action_ok:
                        break
            print(f"[LOGIN_FLOW] convenio clique executado metodo={method_name}: {str(action_ok).lower()}", file=sys.stderr, flush=True)
            if action_ok:
                return True, method_name, {"scopeIndex": scope_index, "selectorHints": selector_hints, "domSelectors": dom_selectors, "postbackTarget": postback_target, "postbackArg": postback_arg}

    return False, "", {"scopeIndex": selected_scope_index, "selectorHints": selector_hints, "domSelectors": dom_selectors, "postbackTarget": postback_target, "postbackArg": postback_arg}


async def _handle_convenio_selection(
    connector: PortalSecundarioLegacyConnector,
    login: str,
    password: str,
    timeout_ms: int,
    snapshot: dict,
) -> tuple[dict, dict, bool]:
    steps = _portal_selection_steps(_portal_id(connector))
    post_snapshot = snapshot
    last_debug: dict = {}

    for step_index, step in enumerate(steps):
        target_terms = list(step.get("terms") or [])
        selection_debug = await _capture_convenio_selection_debug(connector, target_terms)
        last_debug = selection_debug
        if not selection_debug.get("selectionDetected"):
            return post_snapshot, selection_debug, step_index > 0

        print(f"[LOGIN_FLOW] selecao_convenio_detectada: true", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] etapa selecao convenio: {step.get('label') or step_index + 1}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] url selecao convenio: {selection_debug.get('url') or post_snapshot.get('url') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] body_text_sample selecao convenio: {selection_debug.get('bodySnippet') or post_snapshot.get('bodySnippet') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] inputs selecao convenio: {json.dumps(selection_debug.get('inputs') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] buttons selecao convenio: {json.dumps(selection_debug.get('buttons') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] links selecao convenio: {json.dumps(selection_debug.get('links') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] tabelas selecao convenio: {json.dumps(selection_debug.get('tables') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] convenio alvo encontrado: {str(bool(selection_debug.get('targetFound'))).lower()}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] acao convenio encontrada: {str(bool(selection_debug.get('actionFound'))).lower()}", file=sys.stderr, flush=True)

        selected_row = dict(selection_debug.get("selectedRow") or {})
        selected_action = dict(selection_debug.get("selectedAction") or {})
        if not selection_debug.get("targetFound") and not selection_debug.get("singleConvenio"):
            raise _typed_login_error(
                "CONVENIO_NOT_FOUND",
                str(step.get("not_found_message") or "O login foi aceito, mas o convenio esperado nao foi encontrado."),
                stage="selecionar_convenio",
            )
        if not selected_row:
            raise _typed_login_error(
                "CONVENIO_ACTION_NOT_FOUND",
                "O login foi aceito, mas o sistema nao encontrou o botao de acesso do convenio.",
                stage="selecionar_convenio",
            )
        if not selected_action or not selected_action.get("selectorHints") and not selected_action.get("domSelectors") and not selected_action.get("postbackTarget"):
            raise _typed_login_error(
                "CONVENIO_ACTION_NOT_FOUND",
                "O login foi aceito, mas o sistema nao encontrou o botao de acesso do convenio.",
                stage="selecionar_convenio",
            )

        print(f"[LOGIN_FLOW] convenio escolhido: {json.dumps(selected_row, ensure_ascii=False)}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] convenio action escolhido: {json.dumps(selected_action, ensure_ascii=False)}", file=sys.stderr, flush=True)
        if selection_debug.get("singleConvenio"):
            print("[LOGIN_FLOW] auto_select_first_convenio: true", file=sys.stderr, flush=True)

        clicked, method_name, click_debug = await _click_convenio_action(connector, selection_debug, timeout_ms, target_terms)
        print(f"[LOGIN_FLOW] convenio clique metodo final: {method_name or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] convenio clique executado: {str(clicked).lower()}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] convenio click debug: {json.dumps(click_debug or {}, ensure_ascii=False)}", file=sys.stderr, flush=True)
        if not clicked:
            raise _typed_login_error(
                "CONVENIO_SELECTION_FAILED",
                "O login foi aceito, mas o portal nao avancou apos selecionar o convenio.",
                stage="selecionar_convenio",
            )

        await connector.page.wait_for_timeout(2500)
        post_snapshot = await _capture_login_snapshot(connector)
        _log_login_snapshot(post_snapshot, login, password, f"apos-selecao-convenio-{step_index + 1}")
        _log_login_flow(post_snapshot, f"apos-selecao-convenio-{step_index + 1}", login, password, click_executed=True, final_code="PENDING")
        print(f"[LOGIN_FLOW] url depois selecao convenio: {post_snapshot.get('url') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] body_text_sample depois selecao convenio: {post_snapshot.get('bodySnippet') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] sucesso apos selecao convenio: {str(bool(post_snapshot.get('successFound') or post_snapshot.get('operacionalFound') or post_snapshot.get('consultaMargemFound'))).lower()}", file=sys.stderr, flush=True)

        if post_snapshot.get("captchaFound"):
            solved_captcha = await _solve_recaptcha_with_capsolver(connector, f"apos-selecao-convenio-{step_index + 1}")
            if not solved_captcha:
                raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="selecionar_convenio")
            post_snapshot = await _capture_login_snapshot(connector)
        if post_snapshot.get("certificateFound"):
            raise _typed_login_error("MANUAL_AUTH_REQUIRED", "O portal solicitou autenticacao manual/certificado digital.", stage="selecionar_convenio")
        if post_snapshot.get("errorText"):
            code, typed_message = _classify_login_issue(None, post_snapshot.get("errorText") or "", post_snapshot)
            if code == "CAPTCHA_REQUIRED":
                solved_captcha = await _solve_recaptcha_with_capsolver(connector, f"erro-texto-convenio-{step_index + 1}")
                if not solved_captcha:
                    raise _typed_login_error(code, typed_message, stage="selecionar_convenio")
                post_snapshot = await _capture_login_snapshot(connector)
            if code in {"LOGIN_REJECTED", "MANUAL_AUTH_REQUIRED"}:
                raise _typed_login_error(code, typed_message, stage="selecionar_convenio")

        if post_snapshot.get("successFound") or post_snapshot.get("operacionalFound") or post_snapshot.get("consultaMargemFound"):
            return post_snapshot, selection_debug, True

        post_url = str(post_snapshot.get("url") or "").lower()
        post_body = _normalize_ribeirao_text(post_snapshot.get("bodySnippet") or "")
        still_selection = (
            "loginselecao.aspx" in post_url
            or "selecaoperfil" in post_url
            or "selecione o convenio" in post_body
            or "convênio sigla ação" in post_body
            or "convenio sigla acao" in post_body
            or "selecao de perfil" in post_body
            or "sua conta esta associada a mais de um perfil" in post_body
        )
        if still_selection and step_index < len(steps) - 1:
            continue
        if still_selection:
            raise _typed_login_error(
                "CONVENIO_SELECTION_FAILED",
                "O login foi aceito, mas o portal nao avancou apos selecionar o convenio.",
                stage="selecionar_convenio",
            )
        return post_snapshot, selection_debug, True

    return post_snapshot, last_debug, True


async def _retry_login_post_click(
    connector: PortalSecundarioLegacyConnector,
    login: str,
    password: str,
    timeout_ms: int,
    snapshot: dict,
    button_debug: dict,
) -> tuple[dict, dict, str, bool]:
    methods = [
        ("locator_click", "click"),
        ("page_click_force", "page_click_force"),
        ("js_click", "js_click"),
        ("do_postback", "do_postback"),
        ("form_submit", "form_submit"),
        ("enter", "enter"),
    ]
    preferred_info = dict((button_debug or {}).get("chosenButtonInfo") or {})
    preferred_selector = str((button_debug or {}).get("chosenSelector") or (button_debug or {}).get("chosenButton") or "").strip()
    if not preferred_selector or ":has-text(" in preferred_selector.lower() or preferred_selector.lower().startswith("text="):
        button_id = str(preferred_info.get("id") or "").strip()
        button_name = str(preferred_info.get("name") or "").strip()
        button_value = str(preferred_info.get("value") or "").strip()
        if button_id:
            preferred_selector = f"#{button_id}"
        elif button_name:
            preferred_selector = f"input[name='{button_name}']"
        elif button_value:
            preferred_selector = f"input[value='{button_value}']"
        else:
            preferred_selector = "#Entrar"
    button_label = json.dumps(preferred_info, ensure_ascii=False)

    async def _click_selector(scope, selector: str, *, force: bool = False, js: bool = False) -> bool:
        try:
            if js:
                return bool(
                    await scope.evaluate(
                        """(selector) => {
                            try {
                                const el = document.querySelector(selector);
                                if (!el) return false;
                                el.click();
                                return true;
                            } catch (_) {
                                return false;
                            }
                        }""",
                        selector,
                    )
                )
            await scope.click(selector, force=force, timeout=timeout_ms)
            return True
        except Exception:
            return False

    async def _press_enter(scope) -> bool:
        try:
            login_locator = scope.locator("#txtLogin").first
            await login_locator.press("Enter", timeout=timeout_ms)
            return True
        except Exception:
            return False

    async def _submit_form(scope) -> bool:
        try:
            return bool(
                await scope.evaluate(
                    """() => {
                        const form = document.querySelector('form');
                        if (form) {
                            form.submit();
                            return true;
                        }
                        return false;
                    }"""
                )
            )
        except Exception:
            return False

    async def _do_postback(scope) -> bool:
        try:
            return bool(
                await scope.evaluate(
                    """() => {
                        if (typeof __doPostBack === 'function') {
                            __doPostBack('Entrar', '');
                            return true;
                        }
                        return false;
                    }"""
                )
            )
        except Exception:
            return False

    async def _click_ok_popup() -> bool:
        candidate_selectors = [
            "#ucAjaxModalPopup1_btnConfirmarPopup",
            "input[name='ucAjaxModalPopup1$btnConfirmarPopup']",
            "input[value='OK']",
            "button:has-text('OK')",
        ]
        for scope in _login_scopes(connector):
            for selector in candidate_selectors:
                try:
                    await scope.locator(selector).first.click(timeout=2000)
                    return True
                except Exception:
                    continue
                try:
                    await scope.locator(selector).first.click(timeout=2000, force=True)
                    return True
                except Exception:
                    continue
                try:
                    clicked = await scope.evaluate(
                        """(selector) => {
                            try {
                                const el = document.querySelector(selector);
                                if (!el) return false;
                                el.click();
                                return true;
                            } catch (_) {
                                return false;
                            }
                        }""",
                        selector,
                    )
                    if clicked:
                        return True
                except Exception:
                    continue
        try:
            if await connector.page.evaluate(
                """() => {
                    try {
                        if (typeof __doPostBack === 'function') {
                            __doPostBack('ucAjaxModalPopup1$btnConfirmarPopup', '');
                            return true;
                        }
                        return false;
                    } catch (_) {
                        return false;
                    }
                }"""
            ):
                return True
        except Exception:
            pass
        return False

    def _is_user_already_logged_message(*values: object) -> bool:
        normalized = " | ".join(_normalize_ribeirao_text(value) for value in values if value).strip()
        if not normalized:
            return False
        return any(
            term in normalized
            for term in [
                "usuario ja logado",
                "usuario já logado",
                "deseja desconectar seu usuario dos outros terminais",
                "deseja desconectar seu usuário dos outros terminais",
                "desconectar seu usuario dos outros terminais",
                "desconectar seu usuário dos outros terminais",
            ]
        )

    async def _run_method(method_name: str) -> bool:
        if method_name == "locator_click":
            for scope in _login_scopes(connector):
                if await _click_selector(scope, preferred_selector):
                    return True
            return False
        if method_name == "page_click_force":
            for scope in _login_scopes(connector):
                if await _click_selector(scope, preferred_selector, force=True):
                    return True
            return False
        if method_name == "js_click":
            for scope in _login_scopes(connector):
                if await _click_selector(scope, preferred_selector, js=True):
                    return True
            return False
        if method_name == "form_submit":
            for scope in _login_scopes(connector):
                if await _submit_form(scope):
                    return True
            return False
        if method_name == "do_postback":
            for scope in _login_scopes(connector):
                if await _do_postback(scope):
                    return True
            return False
        if method_name == "enter":
            for scope in _login_scopes(connector):
                if await _press_enter(scope):
                    return True
            return False
        return False

    last_snapshot = snapshot
    last_modal = await _capture_login_modal_state(connector)
    for method_name, label in methods:
        before_snapshot = await _capture_login_snapshot(connector)
        before_modal = await _capture_login_modal_state(connector)
        print(f"[LOGIN_FLOW] tentativa metodo: {label}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] url antes: {before_snapshot.get('url') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] body_text_sample antes: {before_snapshot.get('bodySnippet') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] __doPostBack existe: {bool(before_modal.get('hasDoPostBack'))}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] popup/modal encontrado: {bool(before_modal.get('popupFound'))}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] popup OK encontrado: {bool(before_modal.get('popupOkFound'))}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] mensagemLabel textContent: {before_modal.get('messageLabelText') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] popup text: {before_modal.get('popupText') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] botao escolhido: {json.dumps((button_debug or {}).get('chosenButtonInfo') or {}, ensure_ascii=False)}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] tentativa de seletor: {preferred_selector}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] botao escolhido detalhado: {button_label}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] tentou click normal: {str(label in {'locator_click', 'page_click_force'}).lower()}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] tentou click JS: {str(label == 'js_click').lower()}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] tentou Enter: {str(label == 'enter').lower()}", file=sys.stderr, flush=True)

        action_ok = await _run_method(method_name)
        print(f"[LOGIN_FLOW] clique executado metodo={label}: {str(action_ok).lower()}", file=sys.stderr, flush=True)
        await connector.page.wait_for_timeout(2500)
        last_snapshot = await _capture_login_snapshot(connector)
        last_modal = await _capture_login_modal_state(connector)
        print(f"[LOGIN_FLOW] url depois: {last_snapshot.get('url') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] body_text_sample depois: {last_snapshot.get('bodySnippet') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] senha encontrada depois: {bool(last_snapshot.get('passwordFound'))}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] certificado encontrado depois: {bool(last_snapshot.get('certificateFound'))}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] popup/modal encontrado depois: {bool(last_modal.get('popupFound'))}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] popup OK encontrado depois: {bool(last_modal.get('popupOkFound'))}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] mensagemLabel textContent depois: {last_modal.get('messageLabelText') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] popup text depois: {last_modal.get('popupText') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] mensagens do portal depois do clique: {last_snapshot.get('errorText') or ''}", file=sys.stderr, flush=True)

        popup_text = str(last_modal.get('popupText') or last_modal.get('messageLabelText') or '').lower()
        if (last_modal or {}).get("popupFound"):
            if any(term in popup_text for term in ["certificado digital", "certificadodigital", "login-identific"]):
                raise _typed_login_error("MANUAL_AUTH_REQUIRED", "O portal solicitou autenticacao manual/certificado digital.", stage="certificado_digital")
            if any(term in popup_text for term in ["login invalido", "usuario invalido", "acesso negado", "usuário inválido", "usuário nao encontrado", "login inválido", "informe usuario", "informe usuário"]):
                raise _typed_login_error("LOGIN_REJECTED", "O portal recusou o login/senha informados.", stage="popup_login")
            if (last_modal or {}).get("popupOkFound") and any(term in popup_text for term in ["ok", "confirm", "confirmar", "aviso", "mensagem", "informacao", "informação"]):
                print(f"[LOGIN_FLOW] popup OK button found: {last_modal.get('popupOkSelector') or '#ucAjaxModalPopup1_btnConfirmarPopup'}", file=sys.stderr, flush=True)
                await _click_ok_popup(connector)
                await connector.page.wait_for_timeout(1200)
                last_snapshot = await _capture_login_snapshot(connector)
                last_modal = await _capture_login_modal_state(connector)
                print(f"[LOGIN_FLOW] popup/modal encontrado apos OK: {bool(last_modal.get('popupFound'))}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] popup text apos OK: {last_modal.get('popupText') or ''}", file=sys.stderr, flush=True)
        if last_snapshot.get("successFound") or last_snapshot.get("operacionalFound") or last_snapshot.get("consultaMargemFound") or last_snapshot.get("passwordFound") or last_snapshot.get("captchaFound"):
            return last_snapshot, last_modal, label, action_ok

    return last_snapshot, last_modal, "", False


def _log_login_snapshot(snapshot: dict, login: str, password: str, stage: str) -> None:
    print(f"[RIBEIRAO_LOGIN] stage: {stage}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO_LOGIN] URL aberta: {snapshot.get('host') or ''}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO_LOGIN] URL depois do clique: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO_LOGIN] titulo da pagina: {snapshot.get('title') or ''}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO_LOGIN] inputs encontrados: {snapshot.get('inputCount') or 0}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO_LOGIN] campo login encontrado: {bool(snapshot.get('loginFound'))}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO_LOGIN] campo senha encontrado: {bool(snapshot.get('passwordFound'))}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO_LOGIN] botao login encontrado: {bool(snapshot.get('buttonFound'))}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO_LOGIN] texto de sucesso encontrado: {bool(snapshot.get('successFound'))}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO_LOGIN] menu Operacional encontrado: {bool(snapshot.get('operacionalFound'))}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO_LOGIN] login preenchido: {_mask_login(login)}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO_LOGIN] senha preenchida: {bool(password)}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO_LOGIN] passwordLength: {len(password or '')}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO_LOGIN] passwordHasValue: {bool(password)}", file=sys.stderr, flush=True)
    if snapshot.get('loginSelector'):
        print(f"[RIBEIRAO_LOGIN] seletor login usado: {snapshot.get('loginSelector')}", file=sys.stderr, flush=True)
    if snapshot.get('passwordSelector'):
        print(f"[RIBEIRAO_LOGIN] seletor senha usado: {snapshot.get('passwordSelector')}", file=sys.stderr, flush=True)
    if snapshot.get('buttonSelector'):
        print(f"[RIBEIRAO_LOGIN] seletor login button usado: {snapshot.get('buttonSelector')}", file=sys.stderr, flush=True)


def _log_login_flow(
    snapshot: dict,
    stage: str,
    login: str,
    password: str,
    *,
    click_executed: bool = False,
    final_code: str = "",
    certificate_alert: bool = False,
) -> None:
    body_sample = str(snapshot.get("bodySnippet") or "")[:500]
    print(f"[LOGIN_FLOW] stage: {stage}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] current_url: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] title: {snapshot.get('title') or ''}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] body_text_sample: {body_sample}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] txtLogin encontrado: {bool(snapshot.get('loginFound'))}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] botao_proxima encontrado: {bool(snapshot.get('buttonFound'))}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] clique_proxima executado: {bool(click_executed)}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] campo_senha encontrado: {bool(snapshot.get('passwordFound'))}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] alerta_certificado encontrado: {bool(certificate_alert)}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] error_code final: {str(final_code or '').upper()}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] login mascarado: {_mask_login(login)}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] senha informada: {bool(password)}", file=sys.stderr, flush=True)


def _resolve_dns_host(host: str) -> tuple[bool, list[str], str]:
    dns_ok = False
    resolved_ips: list[str] = []
    dns_error = ""
    print(f"[LOGIN_FLOW] dns_resolve_host: {host}", file=sys.stderr, flush=True)
    if not host:
        dns_error = "Host vazio."
        print("[LOGIN_FLOW] dns_resolve_ok: False", file=sys.stderr, flush=True)
        print("[LOGIN_FLOW] dns_resolved_ips: []", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] dns_error: {dns_error}", file=sys.stderr, flush=True)
        return False, resolved_ips, dns_error

    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        resolved_ips = sorted({
            str(info[4][0])
            for info in infos
            if info and len(info) > 4 and info[4] and info[4][0]
        })
        dns_ok = bool(resolved_ips)
    except Exception as exc:
        dns_error = str(exc)

    print(f"[LOGIN_FLOW] dns_resolve_ok {str(dns_ok).lower()}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] dns_resolved_ips {' '.join(resolved_ips) if resolved_ips else '[]'}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] dns_error: {dns_error}", file=sys.stderr, flush=True)
    return dns_ok, resolved_ips, dns_error


async def _capture_login_fallback_snapshot(connector: PortalSecundarioLegacyConnector) -> dict:
    try:
        title = await connector.page.title()
    except Exception:
        title = ""
    try:
        current_url = connector.page.url or ""
    except Exception:
        current_url = ""
    try:
        body_text = await connector.page.locator("body").inner_text(timeout=5000)
    except Exception:
        try:
            body_text = await connector.page.content()
        except Exception:
            body_text = ""
    body_sample = str(body_text or "")[:500]
    body_normalized = re.sub(r"\s+", " ", body_sample).strip().lower()
    try:
        login_found = await connector.page.locator("#txtLogin").count() > 0
    except Exception:
        login_found = False
    try:
        button_found = await connector.page.locator(
            "button:has-text('Próxima'), button:has-text('Proxima'), input[value='Próxima'], input[value='Proxima'], #Entrar"
        ).count() > 0
    except Exception:
        button_found = False
    try:
        password_found = await connector.page.locator("#txtSenha, input[type='password']").count() > 0
    except Exception:
        password_found = False
    try:
        input_count = await connector.page.locator("input").count()
    except Exception:
        input_count = 0

    return {
        "title": title,
        "url": current_url,
        "host": _safe_host(current_url),
        "inputCount": input_count,
        "loginFound": login_found,
        "loginSelector": "#txtLogin" if login_found else "",
        "passwordFound": password_found,
        "passwordSelector": "#txtSenha" if password_found else "",
        "buttonFound": button_found,
        "buttonSelector": "button:has-text('Próxima')" if button_found else "",
        "successFound": False,
        "successSelector": "",
        "operacionalFound": "operacional" in body_normalized,
        "consultaMargemFound": "consulta de margem" in body_normalized,
        "captchaFound": False,
        "captchaSelector": "",
        "errorText": "",
        "bodySnippet": body_sample,
        "bodyNormalized": body_normalized[:500],
        "loginPageVisible": bool(login_found) and "login" in body_normalized,
    }


async def _goto_login_with_fallback(
    connector: PortalSecundarioLegacyConnector,
    target_url: str,
    *,
    stage_label: str,
    timeout_ms: int,
) -> tuple[dict, object | None, bool, bool, list[str], str, bool]:
    print(f"[LOGIN_FLOW] {stage_label} goto iniciando", file=sys.stderr, flush=True)
    host = _safe_host(target_url)
    dns_ok, dns_ips, dns_error = _resolve_dns_host(host)
    if host and not dns_ok:
        print(
            f"[LOGIN_FLOW] {stage_label} DNS local falhou; tentando abrir o portal mesmo assim pelo Chromium",
            file=sys.stderr,
            flush=True,
        )

    response = None
    last_exc: Exception | None = None
    chromium_dns_failure = False
    chromium_args = _chromium_launch_args(host, dns_ips)
    print(f"[LOGIN_FLOW] chromium_args usados: {chromium_args}", file=sys.stderr, flush=True)
    for wait_until, timeout in (
        ("domcontentloaded", timeout_ms),
        ("commit", max(timeout_ms, 60000)),
        ("load", max(timeout_ms, 60000)),
    ):
        try:
            response = await connector.page.goto(
                target_url,
                wait_until=wait_until,
                timeout=timeout,
            )
            break
        except PlaywrightTimeoutError as exc:
            last_exc = exc
            print(f"[LOGIN_FLOW] {stage_label} goto timeout no wait_until={wait_until}", file=sys.stderr, flush=True)
        except Exception as exc:
            last_exc = exc
            print(f"[LOGIN_FLOW] {stage_label} goto falhou no wait_until={wait_until}: {exc}", file=sys.stderr, flush=True)
            if "err_name_not_resolved" in str(exc).lower():
                chromium_dns_failure = True
        try:
            await connector.page.wait_for_timeout(1200)
        except Exception:
            pass

    snapshot = await _capture_login_fallback_snapshot(connector)
    response_status = ""
    response_url = ""
    try:
        response_status = str(getattr(response, "status", "") or "")
    except Exception:
        response_status = ""
    try:
        response_url = str(getattr(response, "url", "") or "")
    except Exception:
        response_url = ""
    print(f"[LOGIN_FLOW] goto response status: {response_status}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] goto response url: {response_url}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] current_url: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] title: {snapshot.get('title') or ''}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] body_text_sample: {snapshot.get('bodySnippet') or ''}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] txtLogin encontrado: {bool(snapshot.get('loginFound'))}", file=sys.stderr, flush=True)
    if chromium_dns_failure:
        print("[LOGIN_FLOW] DNS ok no sistema, falha no Chromium", file=sys.stderr, flush=True)
    if snapshot.get("loginFound"):
        print(f"[LOGIN_FLOW] {stage_label} goto concluído", file=sys.stderr, flush=True)
        return snapshot, response, True, dns_ok, dns_ips, dns_error, chromium_dns_failure

    if last_exc is not None:
        print(f"[LOGIN_FLOW] {stage_label} goto excecao final: {last_exc}", file=sys.stderr, flush=True)
    return snapshot, response, False, dns_ok, dns_ips, dns_error if dns_error else ("chromium_dns_failed" if chromium_dns_failure else ""), chromium_dns_failure


def _classify_login_issue(code: str | None, message: str, snapshot: dict | None = None) -> tuple[str, str]:
    raw_message = str(message or '').strip()
    normalized = raw_message.lower()
    code_upper = str(code or '').strip().upper()
    snap = snapshot or {}
    error_text = str(snap.get('errorText') or '').strip()
    body_text = str(snap.get('bodySnippet') or '').strip()
    body_normalized = str(snap.get('bodyNormalized') or '').strip().lower()

    if code_upper in LOGIN_ERROR_CODES:
        if code_upper == 'LOGIN_REJECTED':
            return 'LOGIN_REJECTED', raw_message or 'O portal recusou o login/senha informados.'
        if code_upper == 'MANUAL_AUTH_REQUIRED':
            return 'MANUAL_AUTH_REQUIRED', raw_message or 'Autentica??o manual necess?ria.'
        if code_upper == 'CAPTCHA_REQUIRED':
            return 'CAPTCHA_REQUIRED', raw_message or 'O portal solicitou valida??o manual.'
        if code_upper == 'LOGIN_OK_NAVIGATION_FAILED':
            return 'LOGIN_OK_NAVIGATION_FAILED', raw_message or 'Login aceito, mas n?o foi poss?vel abrir Consulta de Margem.'
        if code_upper == 'DNS_RESOLUTION_FAILED':
            return 'DNS_RESOLUTION_FAILED', raw_message or 'N?o foi poss?vel resolver o endere?o do portal no servidor. Verifique DNS da VPS/container.'
        if code_upper == 'CHROMIUM_DNS_FAILED':
            return 'CHROMIUM_DNS_FAILED', raw_message or 'O navegador interno do servidor n?o conseguiu resolver o portal, mesmo com DNS do container funcionando.'
        if code_upper == 'WORKER_INTERNAL_ERROR':
            return 'WORKER_INTERNAL_ERROR', raw_message or 'Erro interno no worker de login.'
        if code_upper == 'USER_ALREADY_LOGGED_CONFIRM_FAILED':
            return 'USER_ALREADY_LOGGED_CONFIRM_FAILED', raw_message or 'O portal informou que o usu?rio j? estava logado, mas n?o foi poss?vel confirmar a desconex?o autom?tica.'
        if code_upper == 'LOGIN_FIELDS_NOT_FOUND':
            return 'LOGIN_FIELDS_NOT_FOUND', raw_message or 'O sistema n?o encontrou os campos de login do portal. O layout pode ter mudado.'
        if code_upper == 'LOGIN_BUTTON_NOT_FOUND':
            return 'LOGIN_BUTTON_NOT_FOUND', raw_message or 'O sistema n?o encontrou o bot?o de login do portal.'
        if code_upper == 'LOGIN_PASSWORD_FIELD_NOT_FOUND':
            return 'LOGIN_PASSWORD_FIELD_NOT_FOUND', raw_message or 'O sistema chegou na segunda etapa do login, mas n?o encontrou o campo de senha.'
        if code_upper == 'CONVENIO_ACTION_NOT_FOUND':
            return 'CONVENIO_ACTION_NOT_FOUND', raw_message or 'O login foi aceito, mas o sistema nao encontrou o botao de acesso do convenio.'
        if code_upper == 'CONVENIO_SELECTION_FAILED':
            return 'CONVENIO_SELECTION_FAILED', raw_message or 'O login foi aceito, mas o portal nao avancou apos selecionar o convenio.'
        if code_upper == 'CONVENIO_NOT_FOUND':
            return 'CONVENIO_NOT_FOUND', raw_message or 'O login foi aceito, mas o convenio de Ribeirao Preto nao foi encontrado.'
        if code_upper == 'LOGIN_TIMEOUT':
            return 'LOGIN_TIMEOUT', raw_message or 'O portal n?o respondeu ap?s tentar login.'
        if code_upper == 'LOGIN_STILL_ON_SAME_PAGE':
            return 'LOGIN_STILL_ON_SAME_PAGE', raw_message or 'O portal nao avancou apos informar o login. Pode ser validacao por JavaScript, certificado digital ou bloqueio do portal.'
        if code_upper == 'PORTAL_CHANGED':
            return 'PORTAL_CHANGED', raw_message or 'O layout do portal mudou e o fluxo de login n?o foi reconhecido.'
        return 'UNKNOWN_LOGIN_ERROR', raw_message or 'Erro inesperado no fluxo de login.'

    if snap.get('captchaFound'):
        return 'CAPTCHA_REQUIRED', raw_message or 'O portal solicitou valida??o manual.'
    if snap.get('loginFound') is False:
        return 'LOGIN_FIELDS_NOT_FOUND', raw_message or 'O sistema n?o encontrou os campos de login do portal. O layout pode ter mudado.'
    if snap.get('buttonFound') is False:
        return 'LOGIN_BUTTON_NOT_FOUND', raw_message or 'O sistema n?o encontrou o bot?o de login do portal.'

    if any(term in normalized for term in ['certificado digital', 'certificado', 'token', 'e-cpf', 'e cpf']):
        return 'MANUAL_AUTH_REQUIRED', raw_message or 'Autentica??o manual necess?ria.'
    if any(term in normalized for term in ['usuario ou senha', 'usu?rio ou senha', 'login ou senha', 'senha incorreta', 'senha invalida', 'senha inv?lida', 'credenciais invalidas', 'credenciais inv?lidas', 'acesso negado', 'dados incorretos', 'usuario nao encontrado', 'usu?rio n?o encontrado', 'informe usuario', 'informe usu?rio', 'pr?xima etapa', 'proxima etapa']):
        return 'LOGIN_REJECTED', raw_message or 'O portal recusou o login/senha informados.'
    if any(term in normalized for term in ['nao consegui', 'n?o consegui', 'falha ao preencher', 'falha ao clicar', 'timeout', 'tempo limite']):
        if snap.get('loginFound') and snap.get('buttonFound') and not snap.get('passwordFound'):
            return 'LOGIN_STILL_ON_SAME_PAGE', raw_message or 'O portal nao avancou apos informar o login. Pode ser validacao por JavaScript, certificado digital ou bloqueio do portal.'
        return 'LOGIN_TIMEOUT', raw_message or 'O portal n?o respondeu ap?s tentar login.'
    if snap.get('successFound'):
        return 'LOGIN_OK_NAVIGATION_FAILED', raw_message or 'Login aceito, mas n?o foi poss?vel abrir Consulta de Margem.'
    if 'certificado digital' in body_normalized or 'login-identific.certificadodigital.com.br' in body_normalized or 'certificadodigital' in body_normalized:
        return 'MANUAL_AUTH_REQUIRED', raw_message or 'Autentica??o manual necess?ria.'
    if error_text:
        if any(term in error_text.lower() for term in ['usuario ou senha', 'usu?rio ou senha', 'login ou senha', 'senha incorreta', 'senha invalida', 'senha inv?lida', 'credenciais invalidas', 'credenciais inv?lidas', 'acesso negado', 'dados incorretos', 'usuario nao encontrado', 'usu?rio n?o encontrado', 'informe usuario', 'informe usu?rio', 'pr?xima etapa', 'proxima etapa']):
            return 'LOGIN_REJECTED', error_text
        return 'UNKNOWN_LOGIN_ERROR', error_text
    if body_text and 'login' in body_text.lower() and not snap.get('successFound'):
        return 'LOGIN_STILL_ON_SAME_PAGE', raw_message or 'O portal nao avancou apos informar o login. Pode ser validacao por JavaScript, certificado digital ou bloqueio do portal.'

    return 'UNKNOWN_LOGIN_ERROR', raw_message or 'Erro inesperado no fluxo de login.'

def _candidate_worker_roots() -> list[Path]:
    env_root = os.getenv("RIBEIRAO_PROJECT_ROOT", "").strip()
    candidates: list[Path] = []
    if env_root:
      candidates.append(Path(env_root))

    here = Path(__file__).resolve()
    candidates.extend(
        [
            here.parent / "vendor" / "worker",
            Path.cwd() / ".." / "Basemargem" / "consignado-platform" / "worker",
            Path.cwd() / "Basemargem" / "consignado-platform" / "worker",
            here.parents[6] / "Basemargem" / "consignado-platform" / "worker",
        ]
    )
    return [candidate.resolve() for candidate in candidates]


def _resolve_worker_root() -> Path:
    for candidate in _candidate_worker_roots():
        if candidate.exists():
            return candidate
    raise RuntimeError("Nao encontrei o projeto antigo de Ribeirao no ambiente.")


WORKER_ROOT = _resolve_worker_root()
LEGACY_PORTAL_ROOT = WORKER_ROOT / "legacy_portal"
if str(LEGACY_PORTAL_ROOT) not in sys.path:
    sys.path.insert(0, str(LEGACY_PORTAL_ROOT))

from app.connectors.portal_secundario_legacy import PortalSecundarioLegacyConnector  # noqa: E402
from app.core.config import get_settings  # noqa: E402


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[5]


def _session_dir() -> Path:
    directory = _repo_root() / "data" / "ribeirao_sessions"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _status_path(session_id: str) -> Path:
    return _session_dir() / f"session_{session_id}.status.json"


def _write_status(session_id: str, status: str, message: str = "", extra: dict | None = None) -> None:
    payload = {
        "session_id": session_id,
        "status": status,
        "message": message,
        "updated_at": _now_iso(),
    }
    if extra:
        payload.update(extra)
    _status_path(session_id).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _make_settings(payload: dict):
    settings = get_settings()
    portal_id = _portal_id(payload=payload)
    settings.headless = _resolve_headless(payload)
    settings.timeout_ms = int(payload.get("timeout_ms") or settings.timeout_ms)
    settings.retry_attempts = int(payload.get("retry_attempts") or settings.retry_attempts)
    settings.intervalo_entre_consultas_ms = int(payload.get("intervalo_entre_consultas_ms") or settings.intervalo_entre_consultas_ms)

    if portal_id == "governo_sp":
        portal_url = str(
            payload.get("portal_url")
            or os.getenv("GOV_SP_AVERBADOR_URL")
            or os.getenv("GOVSP_AVERBADOR_URL")
            or "https://www.portaldoconsignado.com.br/home?2"
        )
    else:
        portal_url = str(payload.get("portal_url") or os.getenv("RIBEIRAO_AVERBADOR_URL") or settings.pdc_portal_url)
    if _is_placeholder_url(portal_url):
        raise RuntimeError(
            "Configure RIBEIRAO_AVERBADOR_URL com a URL real do averbador de Ribeirao antes de iniciar a sessao."
        )
    settings.pdc_portal_url = portal_url

    if portal_id == "governo_sp":
        consulta_url = str(payload.get("consulta_url") or os.getenv("GOV_SP_AVERBADOR_CONSULTA_URL") or os.getenv("GOVSP_AVERBADOR_CONSULTA_URL") or settings.pdc_portal_url)
    else:
        consulta_url = str(payload.get("consulta_url") or os.getenv("RIBEIRAO_AVERBADOR_CONSULTA_URL") or settings.pdc_portal_url)
    settings.pdc_portal_url = consulta_url

    orgao_nome = str(payload.get("orgao_nome") or os.getenv("RIBEIRAO_AVERBADOR_ORGAO") or settings.pdc_orgao_nome)
    settings.pdc_orgao_nome = orgao_nome

    sessions_dir = _session_dir()
    settings.sessions_dir = sessions_dir
    sessions_dir.mkdir(parents=True, exist_ok=True)
    return settings


def _build_credential_profile(payload: dict) -> dict:
    source = payload.get("credential_profile") or payload.get("credentialProfile") or payload.get("profile") or {}
    if not isinstance(source, dict):
        source = {}
    return {
        "department": str(source.get("department") or source.get("departamento") or payload.get("department") or payload.get("departamento") or "").strip(),
        "email": str(source.get("email") or payload.get("email") or "").strip(),
        "cellphone": str(source.get("cellphone") or source.get("celular") or payload.get("cellphone") or payload.get("celular") or "").strip(),
        "question_1": str(source.get("question_1") or source.get("question1") or source.get("pergunta_1") or source.get("pergunta1") or payload.get("question_1") or payload.get("question1") or payload.get("pergunta_1") or payload.get("pergunta1") or "").strip(),
        "answer_1": str(source.get("answer_1") or source.get("answer1") or source.get("resposta_1") or source.get("resposta1") or payload.get("answer_1") or payload.get("answer1") or payload.get("resposta_1") or payload.get("resposta1") or "").strip(),
        "question_2": str(source.get("question_2") or source.get("question2") or source.get("pergunta_2") or source.get("pergunta2") or payload.get("question_2") or payload.get("question2") or payload.get("pergunta_2") or payload.get("pergunta2") or "").strip(),
        "answer_2": str(source.get("answer_2") or source.get("answer2") or source.get("resposta_2") or source.get("resposta2") or payload.get("answer_2") or payload.get("answer2") or payload.get("resposta_2") or payload.get("resposta2") or "").strip(),
    }


def _has_credential_profile_data(profile: dict | None) -> bool:
    if not isinstance(profile, dict):
        return False
    return any(str(profile.get(key) or "").strip() for key in ["department", "email", "cellphone", "question_1", "answer_1", "question_2", "answer_2"])


def _build_connector(payload: dict, settings) -> PortalSecundarioLegacyConnector:
    session_id = str(payload.get("session_id") or payload.get("sessionId") or "1")
    credential_id = str(payload.get("credential_id") or payload.get("credentialId") or session_id)
    login = str(payload.get("login") or payload.get("username") or os.getenv("RIBEIRAO_AVERBADOR_LOGIN") or "").strip()
    password = str(payload.get("password") or os.getenv("RIBEIRAO_AVERBADOR_PASSWORD") or "")
    credencial = {
        "id": credential_id,
        "credential_id": credential_id,
        "username": login,
        "usuario": login,
        "password": password,
        "senha": password,
    }
    connector = PortalSecundarioLegacyConnector(lote_id=0, settings=settings, credencial=credencial)
    connector.portal_id = _portal_id(payload=payload)
    connector.portal_login_url = str(payload.get("portal_url") or settings.pdc_portal_url or "")
    connector.portal_consulta_url = str(payload.get("consulta_url") or settings.pdc_portal_url or "")
    connector.credential_profile = _build_credential_profile(payload)
    return connector


async def _open_gov_sp_login_browser(connector: PortalSecundarioLegacyConnector, login: str, password: str) -> None:
    timeout_ms = max(60000, connector.settings.timeout_ms)
    login_url = str(getattr(connector, "portal_login_url", "") or connector.settings.pdc_portal_url or "https://www.portaldoconsignado.com.br/home?2")
    snapshot, _response, login_found, dns_ok, _dns_ips, dns_error, chromium_dns_failed = await _goto_login_with_fallback(
        connector,
        login_url,
        stage_label="govsp-goto",
        timeout_ms=timeout_ms,
    )
    if not dns_ok:
        raise _typed_login_error(
            "DNS_RESOLUTION_FAILED",
            "Não foi possível resolver o endereço do portal no servidor. Verifique DNS da VPS/container.",
            stage="govsp_goto",
        )
    if chromium_dns_failed or "chromium_dns_failed" in str(dns_error or "").lower():
        raise _typed_login_error(
            "CHROMIUM_DNS_FAILED",
            "O navegador interno do servidor não conseguiu resolver o portal, mesmo com DNS do container funcionando.",
            stage="govsp_goto",
        )
    _log_login_snapshot(snapshot, login, password, "govsp-goto")

    for attempt in range(1, 7):
        try:
            await _goto_gov_sp_admin_login(connector, login_url, timeout_ms)
            credential_state = await _fill_gov_sp_admin_credentials(connector, login, password)
            if not credential_state.get("usernameValue") or not credential_state.get("passwordLength"):
                raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "O sistema nao conseguiu preencher os campos administrativos do Governo de SP.", stage="govsp_login_fields")
            solved = await _solve_image_captcha_with_capsolver(connector, f"govsp-login-{attempt}")
            if not solved:
                raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou captcha de imagem e o CapSolver nao retornou resposta.", stage="govsp_captcha")
            clicked_login, clicked_selector, _clicked_debug = await _click_login_initial_button(connector, timeout_ms=5000)
            if not clicked_login:
                raise _typed_login_error(
                    "LOGIN_BUTTON_NOT_FOUND",
                    "O sistema preencheu login/senha/captcha, mas nao encontrou o botao de entrada do Governo de SP.",
                    stage="govsp_login_button",
                )
            print(f"[LOGIN_FLOW] govsp botao login acionado: {clicked_selector}", file=sys.stderr, flush=True)
            await connector.page.wait_for_timeout(3500)
            post_snapshot = await _capture_login_snapshot(connector)
            _log_login_snapshot(post_snapshot, login, password, f"govsp-apos-login-{attempt}")
            _log_login_flow(post_snapshot, f"govsp-apos-login-{attempt}", login, password, click_executed=True, final_code="PENDING")

            if _is_user_already_logged_message(post_snapshot.get("bodySnippet"), post_snapshot.get("errorText")):
                clicked_confirm = await _click_ok_popup(connector)
                print(f"[LOGIN_FLOW] govsp clicou_confirmar_desconectar: {str(clicked_confirm).lower()}", file=sys.stderr, flush=True)
                await connector.page.wait_for_timeout(2500)
                post_snapshot = await _capture_login_snapshot(connector)

            post_body = _normalize_ribeirao_text(post_snapshot.get("bodySnippet") or "")
            post_url = str(post_snapshot.get("url") or "").lower()
            if (
                ("captcha" in post_body and ("invalido" in post_body or "inválido" in post_body or "incorreto" in post_body or "correspondem" in post_body))
                or ("cpf e obrigatorio" in post_body or "cpf é obrigatorio" in post_body or "cpf obrigatorio" in post_body)
            ):
                print("[LOGIN_FLOW] govsp validacao do portal falhou; reabrindo login administrativo e tentando novamente", file=sys.stderr, flush=True)
                continue

            if "selecaoperfil" in post_url or "selecao de perfil" in post_body or "selecao de perfil" in post_body or "sua conta esta associada a mais de um perfil" in post_body:
                clicked_profile = await _click_gov_sp_profile_option(connector)
                profile_label = str(os.getenv("GOV_SP_ORGAO") or os.getenv("GOV_SP_CONVENIO") or "disponivel").strip()
                print(f"[LOGIN_FLOW] govsp perfil {profile_label} clicado: {str(clicked_profile).lower()}", file=sys.stderr, flush=True)
                if not clicked_profile:
                    raise _typed_login_error("CONVENIO_ACTION_NOT_FOUND", f"O login foi aceito, mas o sistema nao conseguiu acessar o perfil {profile_label} no portal.", stage="selecionar_perfil")
                await connector.page.wait_for_timeout(2500)
                post_snapshot = await _capture_login_snapshot(connector)
                _log_login_snapshot(post_snapshot, login, password, "govsp-apos-selecao-perfil")
                _log_login_flow(post_snapshot, "govsp-apos-selecao-perfil", login, password, click_executed=True, final_code="PENDING")
                post_body = _normalize_ribeirao_text(post_snapshot.get("bodySnippet") or "")
                post_url = str(post_snapshot.get("url") or "").lower()

            if "login" in post_body and await connector.page.locator("#username").count():
                if attempt < 6:
                    continue
                raise _typed_login_error("LOGIN_REJECTED", "O portal Governo de SP nao aceitou login, senha ou captcha.", stage="govsp_login")

            if (
                "loginselecao.aspx" in post_url
                or "selecione o convenio" in post_body
                or "convenio sigla acao" in post_body
                or "selecao de perfil" in post_body
                or "sua conta esta associada a mais de um perfil" in post_body
            ):
                post_snapshot, selection_debug, selection_ok = await _handle_convenio_selection(
                    connector,
                    login,
                    password,
                    timeout_ms,
                    post_snapshot,
                )
                print(f"[LOGIN_FLOW] govsp selecao targetFound: {str(bool(selection_debug.get('targetFound'))).lower()}", file=sys.stderr, flush=True)
                if selection_ok:
                    print("[LOGIN_FLOW] govsp convenio/banco selecionado", file=sys.stderr, flush=True)

            print("[LOGIN_FLOW] govsp consulta_margem menu iniciando", file=sys.stderr, flush=True)
            consulta_ready = await _open_gov_sp_consulta_margem(connector, timeout_ms)
            if not consulta_ready:
                failed_snapshot = await _capture_login_snapshot(connector)
                _log_login_snapshot(failed_snapshot, login, password, "govsp-consulta-nao-encontrada")
                _log_login_flow(failed_snapshot, "govsp-consulta-nao-encontrada", login, password, click_executed=True, final_code="LOGIN_OK_NAVIGATION_FAILED")
                raise _typed_login_error("LOGIN_OK_NAVIGATION_FAILED", "Login aceito, mas nao foi possivel abrir Consulta de Margem Governo de SP.", stage="govsp_cpf_input")
            final_snapshot = await _capture_login_snapshot(connector)
            _log_login_snapshot(final_snapshot, login, password, "govsp-consulta-preparada")
            return
        except RibeiraoLoginError:
            raise
        except Exception as exc:
            if attempt >= 6:
                raise _typed_login_error("LOGIN_REJECTED", "Falha ao autenticar no Portal do Consignado Governo de SP.", stage="govsp_login") from exc
            print(f"[LOGIN_FLOW] govsp tentativa {attempt} falhou: {exc}", file=sys.stderr, flush=True)
            try:
                await connector.page.reload(wait_until="domcontentloaded", timeout=timeout_ms)
                await connector.page.wait_for_timeout(1200)
            except Exception:
                pass

    raise _typed_login_error("LOGIN_REJECTED", "Falha ao autenticar no Portal do Consignado Governo de SP.", stage="govsp_login")


def _requires_profile_completion(snapshot: dict | None) -> bool:
    body = _normalize_ribeirao_text((snapshot or {}).get("bodySnippet") or "")
    return "complete seu cadastro" in body and "departamento" in body and "pergunta 1" in body


async def _fill_profile_completion_form(connector: PortalSecundarioLegacyConnector) -> bool:
    profile = getattr(connector, "credential_profile", {}) or {}
    if not _has_credential_profile_data(profile):
        return False

    result = await connector.page.evaluate(
        """(profile) => {
            const normalize = (value) => String(value || '')
              .normalize('NFD')
              .replace(/[\\u0300-\\u036f]/g, '')
              .toLowerCase()
              .trim();
            const isVisible = (element) => {
              if (!element) return false;
              const style = window.getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
            };
            const controls = Array.from(document.querySelectorAll('input, select, textarea')).filter(isVisible);
            const rows = Array.from(document.querySelectorAll('tr, .row, .form-group, .campo, .field, div, td')).filter(isVisible);
            const fillInput = (el, value) => {
              if (!el || value === undefined || value === null || String(value).trim() === '') return false;
              el.focus();
              el.value = String(value);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            };
            const setSelect = (el, value) => {
              if (!el || !value) return false;
              const wanted = normalize(value);
              const options = Array.from(el.options || []);
              const match = options.find((option) => normalize(option.textContent || option.label || option.value).includes(wanted) || wanted.includes(normalize(option.textContent || option.label || option.value)));
              if (!match) return false;
              el.value = match.value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            };
            const locateField = (terms, tagName) => {
              const wanted = terms.map(normalize).filter(Boolean);
              const matchesTerms = (text) => wanted.every((term) => text.includes(term));
              const allowed = (control) => {
                if (!control || !isVisible(control)) return false;
                if (!control.matches(tagName || 'input,select,textarea')) return false;
                const attrs = normalize(`${control.name || ''} ${control.id || ''} ${control.placeholder || ''} ${control.getAttribute('aria-label') || ''}`);
                if (attrs.includes('senha') || attrs.includes('password') || attrs.includes('login') || attrs.includes('entrar')) return false;
                return true;
              };

              // ASP.NET pages wrap the entire form in broad divs. Prefer exact
              // id/name/placeholder matches so department/question fields do not
              // accidentally fill login/password inputs.
              for (const control of controls) {
                if (!allowed(control)) continue;
                const attrs = normalize(`${control.name || ''} ${control.id || ''} ${control.placeholder || ''} ${control.getAttribute('aria-label') || ''}`);
                if (matchesTerms(attrs)) return control;
              }

              for (const row of rows) {
                const fields = Array.from(row.querySelectorAll(tagName || 'input,select,textarea')).filter(allowed);
                if (!fields.length || fields.length > 3) continue;
                const text = normalize(row.textContent || '');
                if (!matchesTerms(text)) continue;
                const found = fields.find(Boolean);
                if (found) return found;
              }
              return null;
            };

            const mapped = [
              { key: 'department', terms: ['departamento'], tag: 'input,select,textarea' },
              { key: 'email', terms: ['email'], tag: 'input,textarea' },
              { key: 'cellphone', terms: ['celular'], tag: 'input,textarea' },
              { key: 'question_1', terms: ['pergunta', '1'], tag: 'select,input' },
              { key: 'answer_1', terms: ['resposta', '1'], tag: 'input,textarea' },
              { key: 'question_2', terms: ['pergunta', '2'], tag: 'select,input' },
              { key: 'answer_2', terms: ['resposta', '2'], tag: 'input,textarea' },
            ];

            let touched = 0;
            const filledFields = [];
            for (const item of mapped) {
              const value = String(profile?.[item.key] || '').trim();
              if (!value) continue;
              const control = locateField(item.terms, item.tag);
              if (!control) continue;
              const tag = String(control.tagName || '').toLowerCase();
              const ok = tag === 'select' ? setSelect(control, value) : fillInput(control, value);
              if (ok) {
                touched += 1;
                filledFields.push({ key: item.key, id: control.id || '', name: control.name || '', tag });
              }
            }

            if (!touched) return { touched: 0, submitted: false, filledFields };

            const actionButtons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a')).filter(isVisible);
            const submit = actionButtons.find((button) => {
              const text = normalize(button.textContent || button.value || button.getAttribute('title') || '');
              return text.includes('salvar') || text.includes('confirmar') || text.includes('continuar') || text.includes('prosseguir') || text.includes('gravar');
            });
            if (submit && typeof submit.click === 'function') {
              submit.click();
              return { touched, submitted: true, submitId: submit.id || '', submitName: submit.name || '', filledFields };
            }

            const form = controls.find((control) => control.form)?.form || document.querySelector('form');
            if (form) {
              form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              if (typeof form.submit === 'function') form.submit();
              return { touched, submitted: true, submitId: 'form.submit', filledFields };
            }
            return { touched, submitted: false, filledFields };
        }""",
        profile,
    )
    print(f"[LOGIN_FLOW] profile_completion_result: {json.dumps(result or {}, ensure_ascii=False)}", file=sys.stderr, flush=True)
    await connector.page.wait_for_timeout(2200)
    return bool((result or {}).get("touched"))


async def _handle_profile_completion_if_needed(connector: PortalSecundarioLegacyConnector, snapshot: dict) -> dict:
    if not _requires_profile_completion(snapshot):
        return snapshot
    if not _has_credential_profile_data(getattr(connector, "credential_profile", {}) or {}):
        raise _typed_login_error(
            "PROFILE_COMPLETION_REQUIRED",
            "O portal exigiu o preenchimento de cadastro complementar (Departamento, E-mail, Celular e perguntas de seguranca). Salve esses dados na credencial antes de reconectar.",
            stage="complete_cadastro",
        )
    filled = await _fill_profile_completion_form(connector)
    if not filled:
        raise _typed_login_error(
            "PROFILE_COMPLETION_REQUIRED",
            "O portal exibiu a tela Complete seu cadastro, mas os campos obrigatorios nao puderam ser preenchidos automaticamente.",
            stage="complete_cadastro",
        )
    refreshed_snapshot = await _capture_login_snapshot(connector)
    refreshed_url = str(refreshed_snapshot.get("url") or "").lower()
    refreshed_body = _normalize_ribeirao_text(refreshed_snapshot.get("bodySnippet") or "")
    if "erro.aspx" in refreshed_url and ("loginselecao.aspx" in refreshed_body or "voltar" in refreshed_body):
        print("[LOGIN_FLOW] erro apos salvar complemento; seguindo link Voltar/LoginSelecao", file=sys.stderr, flush=True)
        try:
            link_clicked = await connector.page.evaluate(
                """() => {
                    const links = Array.from(document.querySelectorAll('a'));
                    const target = links.find((link) => String(link.href || '').toLowerCase().includes('loginselecao.aspx'));
                    if (target && typeof target.click === 'function') { target.click(); return true; }
                    return false;
                }"""
            )
            if not link_clicked:
                await connector.page.goto("https://saec.consiglog.com.br/LoginSelecao.aspx", wait_until="domcontentloaded", timeout=max(30000, connector.settings.timeout_ms))
            await connector.page.wait_for_timeout(2500)
            refreshed_snapshot = await _capture_login_snapshot(connector)
        except Exception as exc:
            print(f"[LOGIN_FLOW] falha ao seguir Voltar/LoginSelecao: {exc}", file=sys.stderr, flush=True)
    if _requires_profile_completion(refreshed_snapshot):
        raise _typed_login_error(
            "PROFILE_COMPLETION_REQUIRED",
            "O portal permaneceu na tela Complete seu cadastro apos a tentativa automatica. Revise Departamento, E-mail, Celular e perguntas de seguranca da credencial.",
            stage="complete_cadastro",
        )
    return refreshed_snapshot


async def _open_login_browser(connector: PortalSecundarioLegacyConnector, login: str, password: str) -> None:
    if _portal_id(connector) == "governo_sp":
        await _open_gov_sp_login_browser(connector, login, password)
        return

    dialog_messages: list[str] = []
    last_modal: dict = {}

    async def on_dialog(dialog):
        dialog_messages.append(str(dialog.message or ''))
        try:
            await dialog.dismiss()
        except Exception:
            pass
    timeout_ms = max(60000, connector.settings.timeout_ms)
    snapshot, response, login_found, dns_ok, dns_ips, dns_error, chromium_dns_failed = await _goto_login_with_fallback(
        connector,
        connector.settings.pdc_portal_url,
        stage_label="goto",
        timeout_ms=timeout_ms,
    )
    if login_found:
        _log_login_snapshot(snapshot, login, password, "goto")
        _log_login_flow(snapshot, "goto", login, password, final_code="PENDING")
    elif not dns_ok:
        print("[LOGIN_FLOW] error_code final: DNS_RESOLUTION_FAILED", file=sys.stderr, flush=True)
        raise _typed_login_error(
            "DNS_RESOLUTION_FAILED",
            "Não foi possível resolver o endereço do portal no servidor. Verifique DNS da VPS/container.",
            stage="goto",
        )
    elif chromium_dns_failed or "chromium_dns_failed" in str(dns_error or "").lower():
        print("[LOGIN_FLOW] error_code final: CHROMIUM_DNS_FAILED", file=sys.stderr, flush=True)
        raise _typed_login_error(
            "CHROMIUM_DNS_FAILED",
            "O navegador interno do servidor não conseguiu resolver o portal, mesmo com DNS do container funcionando.",
            stage="goto",
        )
    elif not snapshot.get("bodySnippet") and not snapshot.get("inputCount"):
        print("[LOGIN_FLOW] error_code final: PORTAL_UNREACHABLE", file=sys.stderr, flush=True)
        raise _typed_login_error("PORTAL_UNREACHABLE", "Nao foi possivel abrir o portal da Prefeitura.", stage="goto")
    elif not snapshot.get("loginFound") and (snapshot.get("bodySnippet") or snapshot.get("inputCount")):
        print("[LOGIN_FLOW] error_code final: LOGIN_FIELDS_NOT_FOUND", file=sys.stderr, flush=True)
        raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "O sistema nao encontrou os campos de login do portal. O layout pode ter mudado.", stage="goto")

    await connector.page.wait_for_timeout(800)
    try:
        await connector.page.locator("#entendi-cookies").click(timeout=2000)
    except Exception:
        try:
            await connector.page.locator("button:has-text('Continuar e fechar')").click(timeout=2000)
        except Exception:
            pass

    connector.page.on("dialog", on_dialog)
    try:
        snapshot = await _capture_login_snapshot(connector)
        _log_login_snapshot(snapshot, login, password, "login-inicial")
        _log_login_flow(snapshot, "login-inicial", login, password, final_code="PENDING")

        login_ready = bool(snapshot.get("loginFound"))
        if login_ready:
            print("[LOGIN_FLOW] formulario de login ja estava visivel; pulando atalhos de entrada.", file=sys.stderr, flush=True)
        else:
            try:
                await connector._open_login_entry()
            except Exception as exc:
                raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "Nao foi possivel localizar a entrada de login do portal.", stage="open_login_entry") from exc
            snapshot = await _capture_login_snapshot(connector)
            _log_login_snapshot(snapshot, login, password, "open-login-entry")
            _log_login_flow(snapshot, "open-login-entry", login, password, final_code="PENDING")

            if not snapshot.get("loginFound"):
                try:
                    await connector._open_login_administrativo()
                except Exception as exc:
                    raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "Nao foi possivel abrir a tela de login do portal.", stage="open_login_administrativo") from exc
                snapshot = await _capture_login_snapshot(connector)
                _log_login_snapshot(snapshot, login, password, "open-login-administrativo")
                _log_login_flow(snapshot, "open-login-administrativo", login, password, final_code="PENDING")

        if not login:
            raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "Login ausente para a sessao Ribeirao.", stage="login_missing")

        snapshot = await _capture_login_snapshot(connector)
        _log_login_snapshot(snapshot, login, password, "abertura")
        _log_login_flow(snapshot, "abertura", login, password, final_code="PENDING")
        if not snapshot.get("loginFound"):
            raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "O sistema nao encontrou os campos de login do portal. O layout pode ter mudado.", stage="login_fields")
        try:
            filled_login = await connector._fill_login_user(login)
        except Exception as exc:
            raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "Nao consegui preencher o login.", stage="fill_login") from exc
        if not filled_login:
            try:
                await connector.page.locator("#txtLogin").fill(login, timeout=3000)
            except Exception as exc:
                raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "Nao consegui preencher o login.", stage="fill_login") from exc

        snapshot = await _capture_login_snapshot(connector)
        _log_login_snapshot(snapshot, login, password, "login-preenchido")
        _log_login_flow(snapshot, "login-preenchido", login, password, final_code="PENDING")
        print(f"[LOGIN_FLOW] url antes: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] body_text_sample antes: {snapshot.get('bodySnippet') or ''}", file=sys.stderr, flush=True)
        login_value_length = 0
        login_value_confirmed = False
        for scope in _login_scopes(connector):
            try:
                login_locator = scope.locator("#txtLogin").first
                current_login_value = await login_locator.input_value(timeout=3000)
                login_value_length = len(str(current_login_value or ""))
                login_value_confirmed = login_value_length > 0
                if login_value_confirmed:
                    break
            except Exception:
                continue
        print(f"[LOGIN_FLOW] login preenchido confirmado: {str(login_value_confirmed).lower()}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] login_value_length: {login_value_length}", file=sys.stderr, flush=True)
        button_debug = await _capture_login_button_debug(connector)
        print(f"[LOGIN_FLOW] html do formulário de login, sem senha: {button_debug.get('formHtml') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] buttons encontrados: {json.dumps(button_debug.get('buttons') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] inputs submit/button encontrados: {json.dumps(button_debug.get('inputs') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] links encontrados próximos ao form, se houver: {json.dumps(button_debug.get('links') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] current_url antes: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
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
        except Exception as exc:
            raise _typed_login_error("LOGIN_BUTTON_NOT_FOUND", "Nao consegui acionar o botao de login.", stage="button_login") from exc
        if not clicked_login:
            raise _typed_login_error(
                "LOGIN_BUTTON_NOT_FOUND",
                "O sistema nao encontrou o botao de login do portal.",
                stage="button_login",
            )

        print(f"[LOGIN_FLOW] clique de login executado: {clicked_selector or 'Enter'}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] botao escolhido: {json.dumps((click_debug or {}).get('chosenButtonInfo') or {}, ensure_ascii=False)}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] tentou click normal: {str((click_debug or {}).get('chosenMethod') in {'click', 'click-fallback'}).lower()}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] tentou click JS: {str((click_debug or {}).get('chosenMethod') == 'js').lower()}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] tentou Enter: {str((click_debug or {}).get('chosenMethod') == 'enter').lower()}", file=sys.stderr, flush=True)
        await connector.page.wait_for_timeout(1500)
        await connector.page.wait_for_timeout(2500)
        snapshot = await _capture_login_snapshot(connector)
        _log_login_snapshot(snapshot, login, password, "apos-primeiro-clique")
        _log_login_flow(snapshot, "apos-primeiro-clique", login, password, click_executed=True, final_code="PENDING", certificate_alert=bool(dialog_messages))
        snapshot = await _handle_profile_completion_if_needed(connector, snapshot)
        print(f"[LOGIN_FLOW] current_url depois: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] body_text_sample depois: {snapshot.get('bodySnippet') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] senha encontrada depois: {bool(snapshot.get('passwordFound'))}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] certificado encontrado depois: {bool(snapshot.get('certificateFound'))}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] mensagens do portal depois do clique: {snapshot.get('errorText') or ''}", file=sys.stderr, flush=True)

        if dialog_messages:
            joined = " | ".join(dialog_messages).lower()
            if "certificado" in joined or "login-identific" in joined or "nao encontrado" in joined or "n?o encontrado" in joined:
                raise _typed_login_error("MANUAL_AUTH_REQUIRED", "O portal solicitou autenticacao manual por certificado digital.", stage="alerta_certificado")

        if button_debug.get("certificateFound") or snapshot.get("certificateFound"):
            print(f"[LOGIN_FLOW] quantidade de frames: {button_debug.get('frameCount') or 0}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] buttons encontrados: {json.dumps(button_debug.get('buttons') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] inputs submit/button encontrados: {json.dumps(button_debug.get('inputs') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] links encontrados pr?ximos ao form, se houver: {json.dumps(button_debug.get('links') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
            print("[LOGIN_FLOW] error_code final: MANUAL_AUTH_REQUIRED", file=sys.stderr, flush=True)
            raise _typed_login_error("MANUAL_AUTH_REQUIRED", "O portal solicitou autentica??o manual/certificado digital.", stage="certificado_digital")

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

        handled_password_stage = False
        current_url_lower = str(snapshot.get("url") or "").lower()
        second_stage_detected = "loginsegundaetapa.aspx" in current_url_lower
        if second_stage_detected:
            second_stage_debug = await _capture_second_stage_login_debug(connector)
            print(f"[LOGIN_FLOW] segunda etapa detectada: true", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] url segunda etapa: {second_stage_debug.get('url') or snapshot.get('url') or ''}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] inputs segunda etapa: {json.dumps(second_stage_debug.get('inputs') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] campo senha encontrado: {bool(second_stage_debug.get('passwordFound') or snapshot.get('passwordFound'))}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] botao senha encontrado: {bool(second_stage_debug.get('buttonFound') or snapshot.get('buttonFound'))}", file=sys.stderr, flush=True)

            if not second_stage_debug.get("passwordFound") and not snapshot.get("passwordFound"):
                raise _typed_login_error(
                    "LOGIN_PASSWORD_FIELD_NOT_FOUND",
                    "O sistema chegou na segunda etapa do login, mas nao encontrou o campo de senha.",
                    stage="password_field",
                )

            password_selectors = [
                second_stage_debug.get("passwordSelector") or "",
                "#txtSenha",
                "input[name='txtSenha']",
                "input[type='password']",
                "input[id*='Senha']",
                "input[name*='Senha']",
                "input[id*='senha']",
                "input[name*='senha']",
            ]
            password_selector_used = ""
            password_filled = False
            for scope_index, scope in enumerate(_login_scopes(connector)):
                for selector in [item for item in password_selectors if item]:
                    try:
                        locator = scope.locator(selector).first
                        await locator.wait_for(state="visible", timeout=timeout_ms)
                        await locator.fill(password, timeout=3000)
                        password_selector_used = selector
                        password_filled = True
                        scope_label = 'page' if scope_index == 0 else f'frame-{scope_index}'
                        print(f"[LOGIN_FLOW] seletor senha usado: {selector} ({scope_label})", file=sys.stderr, flush=True)
                        break
                    except Exception:
                        continue
                if password_filled:
                    break

            if not password_filled:
                raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "Nao consegui preencher a senha na segunda etapa.", stage="fill_password")

            password_value_length = 0
            password_value_confirmed = False
            for scope_index, scope in enumerate(_login_scopes(connector)):
                for selector in [item for item in [password_selector_used, "#txtSenha", "input[name='txtSenha']", "input[type='password']"] if item]:
                    try:
                        locator = scope.locator(selector).first
                        current_password_value = await locator.input_value(timeout=3000)
                        password_value_length = len(str(current_password_value or ""))
                        password_value_confirmed = password_value_length > 0
                        if password_value_confirmed:
                            break
                    except Exception:
                        continue
                if password_value_confirmed:
                    break

            print(f"[LOGIN_FLOW] password_value_length: {password_value_length}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] password preenchida confirmada: {str(password_value_confirmed).lower()}", file=sys.stderr, flush=True)

            snapshot = await _capture_login_snapshot(connector)
            _log_login_snapshot(snapshot, login, password, "senha-preenchida-segunda-etapa")
            _log_login_flow(snapshot, "senha-preenchida-segunda-etapa", login, password, final_code="PENDING")
            print(f"[LOGIN_FLOW] url antes senha: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] password_submit_method: pending", file=sys.stderr, flush=True)
            if snapshot.get("captchaFound"):
                solved_captcha = await _solve_recaptcha_with_capsolver(connector, "segunda-etapa-antes-submit")
                if not solved_captcha:
                    raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="captcha")
                snapshot = await _capture_login_snapshot(connector)

            try:
                clicked_password, clicked_selector, click_debug = await _click_login_initial_button(connector)
            except Exception as exc:
                raise _typed_login_error("LOGIN_BUTTON_NOT_FOUND", "Nao consegui acionar o botao da segunda etapa.", stage="button_password") from exc
            if not clicked_password:
                raise _typed_login_error("LOGIN_BUTTON_NOT_FOUND", "O sistema nao encontrou o botao da segunda etapa do portal.", stage="button_password")

            handled_password_stage = True
            print(f"[LOGIN_FLOW] clique de senha executado: {clicked_selector or 'Enter'}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] password_submit_method: {str((click_debug or {}).get('chosenMethod') or clicked_selector or '').strip()}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] botao escolhido: {json.dumps((click_debug or {}).get('chosenButtonInfo') or {}, ensure_ascii=False)}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou click normal: {str((click_debug or {}).get('chosenMethod') in {'click', 'click-fallback'}).lower()}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou click JS: {str((click_debug or {}).get('chosenMethod') == 'js').lower()}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou Enter: {str((click_debug or {}).get('chosenMethod') == 'enter').lower()}", file=sys.stderr, flush=True)
            await connector.page.wait_for_timeout(2500)
            snapshot = await _capture_login_snapshot(connector)
            _log_login_snapshot(snapshot, login, password, "apos-segunda-etapa")
            _log_login_flow(snapshot, "apos-segunda-etapa", login, password, click_executed=True, final_code="PENDING", certificate_alert=bool(dialog_messages))
            print(f"[LOGIN_FLOW] current_url depois: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] body_text_sample depois: {snapshot.get('bodySnippet') or ''}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] mensagemLabel depois senha: {(last_modal or {}).get('messageLabelText') or ''}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] popupText depois senha: {(last_modal or {}).get('popupText') or ''}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] botao OK popup visivel: {bool((last_modal or {}).get('popupOkFound'))}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] senha encontrada depois: {bool(snapshot.get('passwordFound'))}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] certificado encontrado depois: {bool(snapshot.get('certificateFound'))}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] mensagens do portal depois do clique: {snapshot.get('errorText') or ''}", file=sys.stderr, flush=True)

            last_modal = await _capture_login_modal_state(connector)
            modal_text = str((last_modal or {}).get('popupText') or (last_modal or {}).get('messageLabelText') or '').strip()
            user_already_logged = _is_user_already_logged_message(
                modal_text,
                snapshot.get('errorText') or '',
                snapshot.get('bodySnippet') or '',
            )
            print(f"[LOGIN_FLOW] usuario_ja_logado_detectado: {str(user_already_logged).lower()}", file=sys.stderr, flush=True)
            if user_already_logged:
                clicked_confirm = await _click_ok_popup(connector)
                print(f"[LOGIN_FLOW] clicou_confirmar_desconectar: {str(clicked_confirm).lower()}", file=sys.stderr, flush=True)
                await connector.page.wait_for_timeout(3500)
                snapshot = await _capture_login_snapshot(connector)
                last_modal = await _capture_login_modal_state(connector)
                print(f"[LOGIN_FLOW] url depois confirmar desconectar: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] sucesso apos confirmar desconectar: {str(bool(snapshot.get('successFound') or snapshot.get('operacionalFound') or snapshot.get('consultaMargemFound'))).lower()}", file=sys.stderr, flush=True)
                confirm_body = _normalize_ribeirao_text(snapshot.get("bodySnippet") or "")
                confirm_url = str(snapshot.get("url") or "").lower()
                if "loginselecao.aspx" in confirm_url or "selecione o convenio" in confirm_body or "convenio sigla acao" in confirm_body:
                    selection_snapshot, selection_debug, selection_ok = await _handle_convenio_selection(
                        connector,
                        login,
                        password,
                        timeout_ms,
                        snapshot,
                    )
                    snapshot = selection_snapshot
                    if selection_ok:
                        print(f"[LOGIN_FLOW] convenios processados com sucesso: {str(bool(snapshot.get('successFound') or snapshot.get('operacionalFound') or snapshot.get('consultaMargemFound'))).lower()}", file=sys.stderr, flush=True)
                if not (snapshot.get('successFound') or snapshot.get('operacionalFound') or snapshot.get('consultaMargemFound')) and snapshot.get("passwordFound"):
                    print("[LOGIN_FLOW] usuario ja logado: tentando reenviar segunda etapa apos confirmar desconexao", file=sys.stderr, flush=True)
                    for retry_index in range(2):
                        try:
                            clicked_password_retry, clicked_selector_retry, click_debug_retry = await _click_login_initial_button(connector)
                        except Exception:
                            clicked_password_retry, clicked_selector_retry, click_debug_retry = False, "", {}
                        print(f"[LOGIN_FLOW] clique retry segunda etapa executado: {clicked_selector_retry or 'false'}", file=sys.stderr, flush=True)
                        print(f"[LOGIN_FLOW] retry metodo: {str((click_debug_retry or {}).get('chosenMethod') or '').strip()}", file=sys.stderr, flush=True)
                        print(f"[LOGIN_FLOW] retry indice usuario ja logado: {retry_index + 1}", file=sys.stderr, flush=True)
                        if not clicked_password_retry:
                            continue
                        await connector.page.wait_for_timeout(4500)
                        snapshot = await _capture_login_snapshot(connector)
                        last_modal = await _capture_login_modal_state(connector)
                        if _requires_profile_completion(snapshot):
                            print("[LOGIN_FLOW] complete cadastro detectado apos retry; preenchendo antes de novo clique", file=sys.stderr, flush=True)
                            snapshot = await _handle_profile_completion_if_needed(connector, snapshot)
                            if snapshot.get('successFound') or snapshot.get('operacionalFound') or snapshot.get('consultaMargemFound'):
                                break
                        confirm_body = _normalize_ribeirao_text(snapshot.get('bodySnippet') or '')
                        confirm_url = str(snapshot.get('url') or '').lower()
                        if "loginselecao.aspx" in confirm_url or "selecione o convenio" in confirm_body or "convenio sigla acao" in confirm_body:
                            selection_snapshot, selection_debug, selection_ok = await _handle_convenio_selection(
                                connector,
                                login,
                                password,
                                timeout_ms,
                                snapshot,
                            )
                            snapshot = selection_snapshot
                            if selection_ok:
                                print(f"[LOGIN_FLOW] convenios processados com sucesso apos retry: {str(bool(snapshot.get('successFound') or snapshot.get('operacionalFound') or snapshot.get('consultaMargemFound'))).lower()}", file=sys.stderr, flush=True)
                        if snapshot.get('successFound') or snapshot.get('operacionalFound') or snapshot.get('consultaMargemFound'):
                            break
                if not (snapshot.get('successFound') or snapshot.get('operacionalFound') or snapshot.get('consultaMargemFound')):
                    print("[LOGIN_FLOW] usuario ja logado permaneceu na segunda etapa; evitando reiniciar para nao derrubar a propria sessao", file=sys.stderr, flush=True)

        if not handled_password_stage and snapshot.get("passwordFound"):
            if not password:
                raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "O portal exibiu senha, mas a senha nao foi informada.", stage="senha_ausente")
            try:
                filled_password = await connector._fill_login_password(password)
            except Exception as exc:
                raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "Nao consegui preencher a senha.", stage="fill_password") from exc
            if not filled_password:
                try:
                    await connector.page.locator("#txtSenha").fill(password, timeout=3000)
                except Exception as exc:
                    raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "Nao consegui preencher a senha.", stage="fill_password") from exc

            snapshot = await _capture_login_snapshot(connector)
            _log_login_snapshot(snapshot, login, password, "senha-preenchida")
            _log_login_flow(snapshot, "senha-preenchida", login, password, final_code="PENDING")
            if snapshot.get("captchaFound"):
                solved_captcha = await _solve_recaptcha_with_capsolver(connector, "senha-preenchida-antes-submit")
                if not solved_captcha:
                    raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="captcha")
                snapshot = await _capture_login_snapshot(connector)
            try:
                clicked_password, clicked_selector, click_debug = await _click_login_initial_button(connector)
            except Exception as exc:
                raise _typed_login_error("LOGIN_BUTTON_NOT_FOUND", "Nao consegui acionar o botao de login.", stage="button_password") from exc
            if not clicked_password:
                raise _typed_login_error(
                    "LOGIN_BUTTON_NOT_FOUND",
                    "O sistema nao encontrou o botao de login do portal.",
                    stage="button_password",
                )

            print(f"[LOGIN_FLOW] clique de login executado: {clicked_selector or 'Enter'}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] botao escolhido: {json.dumps((click_debug or {}).get('chosenButtonInfo') or {}, ensure_ascii=False)}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou click normal: {str((click_debug or {}).get('chosenMethod') in {'click', 'click-fallback'}).lower()}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou click JS: {str((click_debug or {}).get('chosenMethod') == 'js').lower()}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou Enter: {str((click_debug or {}).get('chosenMethod') == 'enter').lower()}", file=sys.stderr, flush=True)
            await connector.page.wait_for_timeout(2500)
            snapshot = await _capture_login_snapshot(connector)
            _log_login_snapshot(snapshot, login, password, "apos-segundo-clique")
            _log_login_flow(snapshot, "apos-segundo-clique", login, password, click_executed=True, final_code="PENDING", certificate_alert=bool(dialog_messages))
            print(f"[LOGIN_FLOW] current_url depois: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] body_text_sample depois: {snapshot.get('bodySnippet') or ''}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] mensagemLabel depois senha: {(last_modal or {}).get('messageLabelText') or ''}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] popupText depois senha: {(last_modal or {}).get('popupText') or ''}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] botao OK popup visivel: {bool((last_modal or {}).get('popupOkFound'))}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] senha encontrada depois: {bool(snapshot.get('passwordFound'))}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] certificado encontrado depois: {bool(snapshot.get('certificateFound'))}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] mensagens do portal depois do clique: {snapshot.get('errorText') or ''}", file=sys.stderr, flush=True)
        else:
            await connector.page.wait_for_timeout(3000)
            snapshot = await _capture_login_snapshot(connector)
            _log_login_snapshot(snapshot, login, password, "apos-espera-sem-senha")
            _log_login_flow(snapshot, "apos-espera-sem-senha", login, password, click_executed=True, final_code="PENDING", certificate_alert=bool(dialog_messages))
            snapshot = await _handle_profile_completion_if_needed(connector, snapshot)
            print(f"[LOGIN_FLOW] current_url depois: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] body_text_sample depois: {snapshot.get('bodySnippet') or ''}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] senha encontrada depois: {bool(snapshot.get('passwordFound'))}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] certificado encontrado depois: {bool(snapshot.get('certificateFound'))}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] mensagens do portal depois do clique: {snapshot.get('errorText') or ''}", file=sys.stderr, flush=True)

        selection_snapshot = snapshot
        selection_body = _normalize_ribeirao_text(selection_snapshot.get("bodySnippet") or "")
        selection_url = str(selection_snapshot.get("url") or "").lower()
        if "loginselecao.aspx" in selection_url or "selecione o convenio" in selection_body or "convenio sigla acao" in selection_body:
            selection_snapshot, selection_debug, selection_ok = await _handle_convenio_selection(
                connector,
                login,
                password,
                timeout_ms,
                selection_snapshot,
            )
            snapshot = selection_snapshot
            current_url_lower = str(snapshot.get("url") or "").lower()
            if selection_ok:
                print(f"[LOGIN_FLOW] convenios processados com sucesso: {str(bool(snapshot.get('successFound') or snapshot.get('operacionalFound') or snapshot.get('consultaMargemFound'))).lower()}", file=sys.stderr, flush=True)

        if handled_password_stage and not (snapshot.get("successFound") or snapshot.get("operacionalFound") or snapshot.get("consultaMargemFound")):
            retry_message = "O portal nao avancou apos informar o login. Pode ser validacao por JavaScript, certificado digital ou bloqueio do portal."
            retry_popup_text = str((last_modal or {}).get("popupText") or (last_modal or {}).get("messageLabelText") or "").strip()
            retry_method_label = str(click_debug.get("chosenMethod") or "").strip()
            if retry_popup_text:
                retry_message = f"{retry_message} Detalhes do portal: {retry_popup_text[:250]}"
            if retry_method_label:
                retry_message = f"{retry_message} Metodo tentado: {retry_method_label}."
            if _is_user_already_logged_message(
                retry_popup_text,
                snapshot.get("errorText") or "",
                snapshot.get("bodySnippet") or "",
            ):
                clicked_confirm = await _click_ok_popup(connector)
                print(f"[LOGIN_FLOW] clicou_confirmar_desconectar: {str(clicked_confirm).lower()}", file=sys.stderr, flush=True)
                await connector.page.wait_for_timeout(2500)
                snapshot = await _capture_login_snapshot(connector)
                last_modal = await _capture_login_modal_state(connector)
                print(f"[LOGIN_FLOW] url depois confirmar desconectar: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] sucesso apos confirmar desconectar: {str(bool(snapshot.get('successFound') or snapshot.get('operacionalFound') or snapshot.get('consultaMargemFound'))).lower()}", file=sys.stderr, flush=True)
                confirm_body = _normalize_ribeirao_text(snapshot.get("bodySnippet") or "")
                confirm_url = str(snapshot.get("url") or "").lower()
                if "loginselecao.aspx" in confirm_url or "selecione o convenio" in confirm_body or "convenio sigla acao" in confirm_body:
                    selection_snapshot, selection_debug, selection_ok = await _handle_convenio_selection(
                        connector,
                        login,
                        password,
                        timeout_ms,
                        snapshot,
                    )
                    snapshot = selection_snapshot
                    if selection_ok:
                        print(f"[LOGIN_FLOW] convenios processados com sucesso: {str(bool(snapshot.get('successFound') or snapshot.get('operacionalFound') or snapshot.get('consultaMargemFound'))).lower()}", file=sys.stderr, flush=True)
                if snapshot.get("successFound") or snapshot.get("operacionalFound") or snapshot.get("consultaMargemFound"):
                    pass
                else:
                    print("[LOGIN_FLOW] usuario ja logado permaneceu apos confirmacao; seguindo sem reiniciar a sessao", file=sys.stderr, flush=True)
            if dialog_messages:
                joined_dialogs = " | ".join(dialog_messages).strip()
                if joined_dialogs:
                    dialog_code, dialog_message = _classify_login_issue(None, joined_dialogs, snapshot)
                    if dialog_code in {"LOGIN_REJECTED", "CAPTCHA_REQUIRED", "MANUAL_AUTH_REQUIRED"}:
                        raise _typed_login_error(dialog_code, dialog_message, stage="dialog_post_password")
            if snapshot.get("certificateFound") or "certificado" in str(snapshot.get("errorText") or "").lower():
                raise _typed_login_error("MANUAL_AUTH_REQUIRED", "O portal solicitou autenticacao manual por certificado digital.", stage="certificado_digital")
            if snapshot.get("errorText"):
                code, typed_message = _classify_login_issue(None, snapshot.get("errorText") or "", snapshot)
                if code in {"LOGIN_REJECTED", "CAPTCHA_REQUIRED", "MANUAL_AUTH_REQUIRED"}:
                    raise _typed_login_error(code, typed_message, stage="erro_texto_portal")
            raise _typed_login_error("LOGIN_STILL_ON_SAME_PAGE", retry_message, stage="password_submit")

        if dialog_messages:
            joined = " | ".join(dialog_messages).lower()
            if "certificado" in joined or "login-identific" in joined or "nao encontrado" in joined or "n?o encontrado" in joined:
                raise _typed_login_error("MANUAL_AUTH_REQUIRED", "O portal solicitou autenticacao manual por certificado digital.", stage="alerta_certificado")

        if snapshot.get("captchaFound"):
            solved_captcha = await _solve_recaptcha_with_capsolver(connector, "validacao-final-login")
            if not solved_captcha:
                raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="captcha")
            snapshot = await _capture_login_snapshot(connector)
        if snapshot.get("successFound") or snapshot.get("operacionalFound") or snapshot.get("consultaMargemFound"):
            pass
        elif snapshot.get("loginPageVisible") or snapshot.get("loginFound"):
            if snapshot.get("errorText"):
                code, typed_message = _classify_login_issue(None, snapshot.get("errorText") or '', snapshot)
                if code == "LOGIN_REJECTED":
                    raise _typed_login_error(code, typed_message, stage="erro_texto_portal")
                if code == "CAPTCHA_REQUIRED":
                    solved_captcha = await _solve_recaptcha_with_capsolver(connector, "erro-texto-portal")
                    if not solved_captcha:
                        raise _typed_login_error(code, typed_message, stage="erro_texto_portal")
                    snapshot = await _capture_login_snapshot(connector)
                if code == "MANUAL_AUTH_REQUIRED":
                    raise _typed_login_error(code, typed_message, stage="erro_texto_portal")
            if snapshot.get("host") and "login-identific" in str(snapshot.get("host") or '').lower():
                raise _typed_login_error("MANUAL_AUTH_REQUIRED", "O portal solicitou autenticacao manual por certificado digital.", stage="certificado")
            retry_snapshot, retry_modal, retry_label, retry_ok = await _retry_login_post_click(
                connector,
                login,
                password,
                timeout_ms,
                snapshot,
                click_debug or button_debug,
            )
            if retry_label or retry_ok:
                snapshot = retry_snapshot or snapshot
                last_modal = retry_modal or last_modal
                print(f"[LOGIN_FLOW] retry metodo final: {retry_label or ''}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] retry popup/modal encontrado: {bool(last_modal.get('popupFound'))}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] retry popup OK encontrado: {bool(last_modal.get('popupOkFound'))}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] retry mensagemLabel textContent: {last_modal.get('messageLabelText') or ''}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] retry popup text: {last_modal.get('popupText') or ''}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] retry current_url: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] retry body_text_sample: {snapshot.get('bodySnippet') or ''}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] retry senha encontrada: {bool(snapshot.get('passwordFound'))}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] retry certificado encontrado: {bool(snapshot.get('certificateFound'))}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] retry mensagens do portal: {snapshot.get('errorText') or ''}", file=sys.stderr, flush=True)

            if snapshot.get("successFound") or snapshot.get("operacionalFound") or snapshot.get("consultaMargemFound"):
                pass
            elif snapshot.get("passwordFound"):
                if not password:
                    raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "O portal exibiu senha, mas a senha nao foi informada.", stage="senha_ausente")
                try:
                    filled_password = await connector._fill_login_password(password)
                except Exception as exc:
                    raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "Nao consegui preencher a senha.", stage="fill_password") from exc
                if not filled_password:
                    try:
                        await connector.page.locator("#txtSenha").fill(password, timeout=3000)
                    except Exception as exc:
                        raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "Nao consegui preencher a senha.", stage="fill_password") from exc

                snapshot = await _capture_login_snapshot(connector)
                _log_login_snapshot(snapshot, login, password, "senha-preenchida-apos-retry")
                _log_login_flow(snapshot, "senha-preenchida-apos-retry", login, password, final_code="PENDING")

                try:
                    clicked_password, clicked_selector, click_debug = await _click_login_initial_button(connector)
                except Exception as exc:
                    raise _typed_login_error("LOGIN_BUTTON_NOT_FOUND", "Nao consegui acionar o botao de login.", stage="button_password") from exc
                if not clicked_password:
                    raise _typed_login_error(
                        "LOGIN_BUTTON_NOT_FOUND",
                        "O sistema nao encontrou o botao de login do portal.",
                        stage="button_password",
                    )

                print(f"[LOGIN_FLOW] clique de login executado: {clicked_selector or 'Enter'}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] botao escolhido: {json.dumps((click_debug or {}).get('chosenButtonInfo') or {}, ensure_ascii=False)}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] tentou click normal: {str((click_debug or {}).get('chosenMethod') in {'click', 'click-fallback'}).lower()}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] tentou click JS: {str((click_debug or {}).get('chosenMethod') == 'js').lower()}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] tentou Enter: {str((click_debug or {}).get('chosenMethod') == 'enter').lower()}", file=sys.stderr, flush=True)
                await connector.page.wait_for_timeout(2500)
                snapshot = await _capture_login_snapshot(connector)
                snapshot = await _handle_profile_completion_if_needed(connector, snapshot)
                _log_login_snapshot(snapshot, login, password, "apos-segundo-clique-pos-retry")
                _log_login_flow(snapshot, "apos-segundo-clique-pos-retry", login, password, click_executed=True, final_code="PENDING", certificate_alert=bool(dialog_messages))
                print(f"[LOGIN_FLOW] current_url depois: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] body_text_sample depois: {snapshot.get('bodySnippet') or ''}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] senha encontrada depois: {bool(snapshot.get('passwordFound'))}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] certificado encontrado depois: {bool(snapshot.get('certificateFound'))}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] mensagens do portal depois do clique: {snapshot.get('errorText') or ''}", file=sys.stderr, flush=True)

            selection_snapshot = snapshot
            selection_body = _normalize_ribeirao_text(selection_snapshot.get("bodySnippet") or "")
            selection_url = str(selection_snapshot.get("url") or "").lower()
            if "loginselecao.aspx" in selection_url or "selecione o convenio" in selection_body or "convenio sigla acao" in selection_body:
                selection_snapshot, selection_debug, selection_ok = await _handle_convenio_selection(
                    connector,
                    login,
                    password,
                    timeout_ms,
                    selection_snapshot,
                )
                snapshot = selection_snapshot
                current_url_lower = str(snapshot.get("url") or "").lower()
                if selection_ok:
                    print(f"[LOGIN_FLOW] convenios processados com sucesso: {str(bool(snapshot.get('successFound') or snapshot.get('operacionalFound') or snapshot.get('consultaMargemFound'))).lower()}", file=sys.stderr, flush=True)
            if snapshot.get("successFound") or snapshot.get("operacionalFound") or snapshot.get("consultaMargemFound"):
                pass
            elif snapshot.get("loginPageVisible") or snapshot.get("loginFound"):
                retry_message = "O portal nao avancou apos informar o login. Pode ser validacao por JavaScript, certificado digital ou bloqueio do portal."
                retry_popup_text = str((last_modal or {}).get("popupText") or (last_modal or {}).get("messageLabelText") or "").strip()
                retry_method_label = str(click_debug.get("chosenMethod") or "").strip()
                if retry_popup_text:
                    retry_message = f"{retry_message} Detalhes do portal: {retry_popup_text[:250]}"
                if retry_method_label:
                    retry_message = f"{retry_message} Metodo tentado: {retry_method_label}."
                raise _typed_login_error("LOGIN_STILL_ON_SAME_PAGE", retry_message, stage="mesma_tela")
            else:
                if snapshot.get("host") and ("login-identific" in str(snapshot.get("host") or "").lower() or "certificadodigital" in str(snapshot.get("url") or "").lower()):
                    raise _typed_login_error("MANUAL_AUTH_REQUIRED", "O portal solicitou autenticacao manual/certificado digital.", stage="certificado_digital")
                print(f"[LOGIN_FLOW] quantidade de frames: {button_debug.get('frameCount') or 0}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] buttons encontrados: {json.dumps(button_debug.get('buttons') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] inputs submit/button encontrados: {json.dumps(button_debug.get('inputs') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] links encontrados pr?ximos ao form, se houver: {json.dumps(button_debug.get('links') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] botao escolhido: {json.dumps((click_debug or {}).get('chosenButtonInfo') or {}, ensure_ascii=False)}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] tentou click normal: {str((click_debug or {}).get('chosenMethod') in {'click', 'click-fallback'}).lower()}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] tentou click JS: {str((click_debug or {}).get('chosenMethod') == 'js').lower()}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] tentou Enter: {str((click_debug or {}).get('chosenMethod') == 'enter').lower()}", file=sys.stderr, flush=True)
                print(f"[LOGIN_FLOW] current_url antes: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
                raise _typed_login_error("SELECTOR_ERROR", "O portal nao avancou apos informar o login. Pode ser validacao por JavaScript, certificado digital ou bloqueio do portal.", stage="selector_check")
        else:
            if snapshot.get("host") and ("login-identific" in str(snapshot.get("host") or "").lower() or "certificadodigital" in str(snapshot.get("url") or "").lower()):
                raise _typed_login_error("MANUAL_AUTH_REQUIRED", "O portal solicitou autenticacao manual/certificado digital.", stage="certificado_digital")
            print(f"[LOGIN_FLOW] quantidade de frames: {button_debug.get('frameCount') or 0}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] buttons encontrados: {json.dumps(button_debug.get('buttons') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] inputs submit/button encontrados: {json.dumps(button_debug.get('inputs') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] links encontrados pr?ximos ao form, se houver: {json.dumps(button_debug.get('links') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] botao escolhido: {json.dumps((click_debug or {}).get('chosenButtonInfo') or {}, ensure_ascii=False)}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou click normal: {str((click_debug or {}).get('chosenMethod') in {'click', 'click-fallback'}).lower()}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou click JS: {str((click_debug or {}).get('chosenMethod') == 'js').lower()}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] tentou Enter: {str((click_debug or {}).get('chosenMethod') == 'enter').lower()}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] current_url antes: {snapshot.get('url') or ''}", file=sys.stderr, flush=True)
            if handled_password_stage or second_stage_detected:
                raise _typed_login_error("LOGIN_STILL_ON_SAME_PAGE", "O portal nao avancou apos informar o login. Pode ser validacao por JavaScript, certificado digital ou bloqueio do portal.", stage="password_submit")
            raise _typed_login_error("SELECTOR_ERROR", "O portal nao avan?ou ap?s informar o login. Pode ser valida??o por JavaScript, certificado digital ou bloqueio do portal.", stage="selector_check")

        if await connector._wait_any(connector.settings.pdc_selector_cpf_input, 1200):
            print("[LOGIN_FLOW] tela de consulta ja estava aberta apos login; pulando select_profile_access", file=sys.stderr, flush=True)
        else:
            try:
                await connector._select_profile_access()
            except Exception as exc:
                raise _typed_login_error("PORTAL_CHANGED", "Nao foi possivel selecionar o perfil de acesso no portal.", stage="select_profile_access") from exc
        consulta_url = _consulta_margem_url(
            str(getattr(connector, "portal_login_url", "") or connector.settings.pdc_portal_url or ""),
            str(getattr(connector, "portal_consulta_url", "") or connector.settings.pdc_portal_url or ""),
        )
        print("[LOGIN_FLOW] consulta_margem goto iniciando", file=sys.stderr, flush=True)
        try:
            await connector.page.goto(
                consulta_url,
                wait_until="domcontentloaded",
                timeout=max(60000, connector.settings.timeout_ms),
            )
        except PlaywrightTimeoutError as exc:
            raise _typed_login_error("LOGIN_TIMEOUT", "O portal nao respondeu ao abrir Consulta de Margem.", stage="goto_consulta") from exc
        except Exception as exc:
            if "err_name_not_resolved" in str(exc).lower():
                print("[LOGIN_FLOW] DNS ok no sistema, falha no Chromium", file=sys.stderr, flush=True)
                raise _typed_login_error(
                    "DNS_RESOLUTION_FAILED",
                    "Não foi possível resolver o endereço do portal no servidor. Verifique DNS da VPS/container.",
                    stage="goto_consulta",
                ) from exc
            raise _typed_login_error("LOGIN_OK_NAVIGATION_FAILED", "Nao foi possivel abrir Consulta de Margem.", stage="goto_consulta") from exc
        print("[LOGIN_FLOW] consulta_margem goto concluído", file=sys.stderr, flush=True)
        await connector.page.wait_for_timeout(1200)
        try:
            await connector._prepare_consulta_context()
        except Exception as exc:
            raise _typed_login_error("LOGIN_OK_NAVIGATION_FAILED", "Login aceito, mas nao foi possivel preparar a tela de Consulta de Margem.", stage="prepare_consulta") from exc
        if not await connector._wait_any(connector.settings.pdc_selector_cpf_input, 5000):
            raise _typed_login_error("LOGIN_OK_NAVIGATION_FAILED", "Login aceito, mas nao foi possivel abrir Consulta de Margem.", stage="cpf_input")
        final_snapshot = await _capture_login_snapshot(connector)
        _log_login_snapshot(final_snapshot, login, password, "consulta-preparada")
        _log_login_flow(final_snapshot, "consulta-preparada", login, password, click_executed=True, final_code="OK", certificate_alert=bool(dialog_messages))
    finally:
        try:
            connector.page.remove_listener("dialog", on_dialog)
        except Exception:
            pass



async def _wait_for_session_login(connector: PortalSecundarioLegacyConnector, session_id: str, timeout_seconds: int) -> dict:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    captcha_seen = False

    while asyncio.get_running_loop().time() < deadline:
        if await connector.validate_session():
            if connector.context and connector.session_state_path:
                try:
                    await connector.context.storage_state(path=str(connector.session_state_path))
                except Exception:
                    pass
            _write_status(session_id, "conectado", "Sessao autenticada com sucesso.")
            return {"status": "conectado", "session_id": session_id}

        try:
            captcha_seen = captcha_seen or await connector._wait_any(connector.settings.pdc_selector_captcha_input, 700)
        except Exception:
            pass

        if captcha_seen:
            _write_status(
                session_id,
                "aguardando_captcha_manual",
                "Aguardando validacao manual da autenticacao.",
            )
        else:
            _write_status(session_id, "conectando", "Autenticando no averbador.")

        await connector.page.wait_for_timeout(1500)
        await connector.page.wait_for_timeout(2500)

    _write_status(session_id, "erro_login", "Tempo limite excedido aguardando autenticacao manual.")
    return {"status": "erro_login", "session_id": session_id, "message": "Tempo limite excedido aguardando autenticacao manual."}


async def start_session(payload: dict) -> dict:
    settings = _make_settings(payload)
    session_id = str(payload.get("session_id") or payload.get("sessionId") or "1")
    login = str(payload.get("login") or payload.get("username") or os.getenv("RIBEIRAO_AVERBADOR_LOGIN") or "").strip()
    password = str(payload.get("password") or os.getenv("RIBEIRAO_AVERBADOR_PASSWORD") or "")
    timeout_seconds = int(payload.get("timeout_seconds") or 900)

    connector = _build_connector(payload, settings)
    portal_host = _safe_host(connector.settings.pdc_portal_url)
    dns_ok, dns_ips, dns_error = _resolve_dns_host(portal_host)
    chromium_args = _chromium_launch_args(portal_host, dns_ips)
    connector.playwright = await async_playwright().start()
    browser_launch_kwargs = {
        "headless": settings.headless,
        "slow_mo": int(payload.get("slow_mo") or 0),
        "args": chromium_args,
    }

    print(f"[RIBEIRAO] BUILD: {os.getenv('RIBEIRAO_BUILD_VERSION', '')}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO] NODE_ENV: {os.getenv('NODE_ENV', '')}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO] RIBEIRAO_HEADLESS: {os.getenv('RIBEIRAO_HEADLESS', '')}", file=sys.stderr, flush=True)
    print(f"[RIBEIRAO] headless efetivo: {settings.headless}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] dns_resolve_ok {str(dns_ok).lower()}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] dns_resolved_ips {' '.join(dns_ips) if dns_ips else '[]'}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] dns_error: {dns_error}", file=sys.stderr, flush=True)
    print(f"[LOGIN_FLOW] chromium_args usados: {chromium_args}", file=sys.stderr, flush=True)
    _log_playwright_diagnostics(connector.playwright, settings.headless, "start_session")

    if portal_host and not dns_ok:
        _write_status(
            session_id,
            "login_error",
            "Não foi possível resolver o endereço do portal no servidor. Verifique DNS da VPS/container.",
            {"error_code": "DNS_RESOLUTION_FAILED"},
        )
        return {
            "status": "login_error",
            "session_id": session_id,
            "code": "DNS_RESOLUTION_FAILED",
            "stage": "goto",
            "message": "Não foi possível resolver o endereço do portal no servidor. Verifique DNS da VPS/container.",
        }

    try:
        connector.browser = await connector.playwright.chromium.launch(**browser_launch_kwargs)
        print("[PLAYWRIGHT] chromium launch ok true", file=sys.stderr, flush=True)
        if connector.session_state_path and connector.session_state_path.exists():
            connector.context = await connector.browser.new_context(storage_state=str(connector.session_state_path))
        else:
            connector.context = await connector.browser.new_context(viewport={"width": 1440, "height": 1100})
        connector.page = await connector.context.new_page()
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        print("[PLAYWRIGHT] chromium launch ok false", file=sys.stderr, flush=True)
        code_message = _browser_launch_error_message(exc)
        code = code_message[0] if code_message else "ERRO"
        message = code_message[1] if code_message else str(exc)
        _write_status(session_id, "browser_launch_error", message)
        return {"status": "browser_launch_error", "code": code, "session_id": session_id, "message": message}

    _write_status(session_id, "conectando", "Iniciando navegador e abrindo portal.")

    try:
        reused_session = False
        if connector.session_state_path and connector.session_state_path.exists():
            portal_url = str(getattr(connector, "portal_login_url", "") or connector.settings.pdc_portal_url or "")
            if _portal_id(connector) == "governo_sp":
                consulta_url = urljoin(portal_url, "/consignatario/pesquisarMargem")
            else:
                consulta_url = _consulta_margem_url(
                    portal_url,
                    str(getattr(connector, "portal_consulta_url", "") or connector.settings.pdc_portal_url or ""),
                )
            try:
                print("[RIBEIRAO_SESSION] tentativa de reutilizar sessao existente", file=sys.stderr, flush=True)
                await connector.page.goto(
                    consulta_url,
                    wait_until="domcontentloaded",
                    timeout=max(60000, connector.settings.timeout_ms),
                )
                await connector.page.wait_for_timeout(1200)
                reuse_snapshot = await _capture_login_snapshot(connector)
                reuse_snapshot = await _handle_profile_completion_if_needed(connector, reuse_snapshot)
                print(f"[RIBEIRAO_SESSION] reuse url: {reuse_snapshot.get('url') or ''}", file=sys.stderr, flush=True)
                print(f"[RIBEIRAO_SESSION] reuse body_text_sample: {reuse_snapshot.get('bodySnippet') or ''}", file=sys.stderr, flush=True)
                reuse_url = str(reuse_snapshot.get("url") or "").lower()
                reuse_body = _normalize_ribeirao_text(reuse_snapshot.get("bodySnippet") or "")
                if "loginselecao.aspx" in reuse_url or "selecione o convenio" in reuse_body or "convenio sigla acao" in reuse_body:
                    selection_snapshot, selection_debug, selection_ok = await _handle_convenio_selection(
                        connector,
                        login,
                        password,
                        max(60000, connector.settings.timeout_ms),
                        reuse_snapshot,
                    )
                    reuse_snapshot = selection_snapshot
                    print(f"[RIBEIRAO_SESSION] reuse convenio targetFound: {str(bool(selection_debug.get('targetFound'))).lower()}", file=sys.stderr, flush=True)
                    print(f"[RIBEIRAO_SESSION] reuse convenio actionFound: {str(bool(selection_debug.get('actionFound'))).lower()}", file=sys.stderr, flush=True)
                    if selection_ok:
                        print("[RIBEIRAO_SESSION] sessao reutilizada avancou via selecao de convenio", file=sys.stderr, flush=True)
                if _portal_id(connector) != "governo_sp":
                    await connector._prepare_consulta_context()
                elif not await connector._wait_any(connector.settings.pdc_selector_cpf_input, 2500):
                    await _open_gov_sp_consulta_margem(connector, max(60000, connector.settings.timeout_ms))
                if await connector._wait_any(connector.settings.pdc_selector_cpf_input, 5000):
                    reused_session = True
                    print("[RIBEIRAO_SESSION] sessao reutilizada com sucesso", file=sys.stderr, flush=True)
            except Exception as exc:
                print(f"[RIBEIRAO_SESSION] sessao reutilizada falhou: {exc}", file=sys.stderr, flush=True)

        if reused_session:
            if connector.context and connector.session_state_path:
                try:
                    await connector.context.storage_state(path=str(connector.session_state_path))
                except Exception:
                    pass
            _write_status(session_id, "conectado", "Sessao autenticada com sucesso.")
            return {"status": "conectado", "session_id": session_id, "reused": True}

        await _open_login_browser(connector, login, password)
        if connector.context and connector.session_state_path:
            try:
                await connector.context.storage_state(path=str(connector.session_state_path))
            except Exception:
                pass
        _write_status(session_id, "conectado", "Sessao autenticada com sucesso.")
        return {"status": "conectado", "session_id": session_id}
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        message = str(exc)
        code = getattr(exc, "code", None)
        stage = getattr(exc, "stage", None)
        if not code:
            code, message = _split_typed_login_error(message)
        clean_message = message
        status = "erro_login"
        extra = {"error_code": code} if code else None
        if stage:
            extra = {**(extra or {}), "stage": stage}

        if code == "MANUAL_AUTH_REQUIRED":
            status = "aguardando_validacao_manual"
        elif code == "CAPTCHA_REQUIRED":
            status = "aguardando_captcha_manual"
        elif code == "LOGIN_OK_NAVIGATION_FAILED":
            status = "erro_login"
        elif code == "LOGIN_REJECTED":
            status = "erro_login"
        elif code in {"LOGIN_FIELDS_NOT_FOUND", "LOGIN_BUTTON_NOT_FOUND", "LOGIN_PASSWORD_FIELD_NOT_FOUND", "LOGIN_TIMEOUT", "LOGIN_STILL_ON_SAME_PAGE", "PROFILE_COMPLETION_REQUIRED", "PORTAL_CHANGED", "CONVENIO_ACTION_NOT_FOUND", "CONVENIO_SELECTION_FAILED", "CONVENIO_NOT_FOUND", "UNKNOWN_LOGIN_ERROR", "PORTAL_UNREACHABLE", "DNS_RESOLUTION_FAILED", "CHROMIUM_DNS_FAILED"}:
            status = "erro_login"
        elif not code and not stage and ("browser" in message.lower() or "x server" in message.lower() or "$display" in message.lower()):
            status = "browser_launch_error"
            clean_message = "Erro ao iniciar navegador de consulta no servidor. Verifique configuracao do Playwright/Chromium em producao."
            code = code or "BROWSER_LAUNCH_ERROR"
        elif not code:
            status = "erro_login"
            clean_message = "Erro interno no worker de login."
            code = "WORKER_INTERNAL_ERROR"
            stage = stage or "worker_internal"

        _write_status(session_id, status, clean_message or message, extra)
        return {
            "status": status,
            "session_id": session_id,
            "code": code,
            "stage": stage,
            "message": clean_message or message,
        }
    finally:
        try:
            await connector.close()
        except Exception:
            pass


def _serialize_result(result) -> dict:
    if result is None:
        return {}
    if is_dataclass(result):
        return asdict(result)
    if isinstance(result, dict):
        return result
    return {
        key: getattr(result, key)
        for key in dir(result)
        if not key.startswith("_") and not callable(getattr(result, key))
    }


async def query_cpf(payload: dict) -> dict:
    settings = _make_settings(payload)
    session_id = str(payload.get("session_id") or payload.get("sessionId") or "1")
    cpf = _clean_digits(payload.get("cpf"))
    if cpf and len(cpf) < 11:
        cpf = cpf.zfill(11)
    login = str(payload.get("login") or payload.get("username") or os.getenv("RIBEIRAO_AVERBADOR_LOGIN") or "").strip()
    password = str(payload.get("password") or os.getenv("RIBEIRAO_AVERBADOR_PASSWORD") or "")

    connector = _build_connector(payload, settings)
    if not cpf:
        return {"status": "failed", "message": "CPF invalido", "cpf": ""}

    try:
        print(f"[RIBEIRAO] BUILD: {os.getenv('RIBEIRAO_BUILD_VERSION', '')}", file=sys.stderr, flush=True)
        print(f"[RIBEIRAO] NODE_ENV: {os.getenv('NODE_ENV', '')}", file=sys.stderr, flush=True)
        print(f"[RIBEIRAO] RIBEIRAO_HEADLESS: {os.getenv('RIBEIRAO_HEADLESS', '')}", file=sys.stderr, flush=True)
        print(f"[RIBEIRAO] headless efetivo: {settings.headless}", file=sys.stderr, flush=True)
        portal_host = _safe_host(connector.settings.pdc_portal_url)
        dns_ok, dns_ips, dns_error = _resolve_dns_host(portal_host)
        chromium_args = _chromium_launch_args(portal_host, dns_ips)
        connector.playwright = await async_playwright().start()
        _log_playwright_diagnostics(connector.playwright, settings.headless, "query_cpf")
        connector.browser = await connector.playwright.chromium.launch(
            headless=settings.headless,
            slow_mo=int(payload.get("slow_mo") or 0),
            args=chromium_args,
        )
        print("[PLAYWRIGHT] chromium launch ok true", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] dns_resolve_ok {str(dns_ok).lower()}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] dns_resolved_ips {' '.join(dns_ips) if dns_ips else '[]'}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] dns_error: {dns_error}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] chromium_args usados: {chromium_args}", file=sys.stderr, flush=True)
        if portal_host and not dns_ok:
            raise _typed_login_error(
                "DNS_RESOLUTION_FAILED",
                "Não foi possível resolver o endereço do portal no servidor. Verifique DNS da VPS/container.",
                stage="goto",
            )
        if connector.session_state_path and connector.session_state_path.exists():
            connector.context = await connector.browser.new_context(
                storage_state=str(connector.session_state_path),
                viewport={"width": 1440, "height": 1100},
            )
            print(f"[RIBEIRAO_QUERY] storage_state reutilizado: true", file=sys.stderr, flush=True)
        else:
            connector.context = await connector.browser.new_context(viewport={"width": 1440, "height": 1100})
            print(f"[RIBEIRAO_QUERY] storage_state reutilizado: false", file=sys.stderr, flush=True)
        connector.page = await connector.context.new_page()
        reused_session = False
        if connector.session_state_path and connector.session_state_path.exists():
            portal_url = str(getattr(connector, "portal_login_url", "") or connector.settings.pdc_portal_url or "")
            if _portal_id(connector) == "governo_sp":
                consulta_url = urljoin(portal_url, "/consignatario/pesquisarMargem")
            else:
                consulta_url = _consulta_margem_url(
                    portal_url,
                    str(getattr(connector, "portal_consulta_url", "") or connector.settings.pdc_portal_url or ""),
                )
            try:
                print("[RIBEIRAO_QUERY] tentativa de reutilizar sessao existente", file=sys.stderr, flush=True)
                await connector.page.goto(
                    consulta_url,
                    wait_until="domcontentloaded",
                    timeout=max(60000, connector.settings.timeout_ms),
                )
                await connector.page.wait_for_timeout(1200)
                reuse_snapshot = await _capture_login_snapshot(connector)
                print(f"[RIBEIRAO_QUERY] reuse url: {reuse_snapshot.get('url') or ''}", file=sys.stderr, flush=True)
                print(f"[RIBEIRAO_QUERY] reuse body_text_sample: {reuse_snapshot.get('bodySnippet') or ''}", file=sys.stderr, flush=True)
                reuse_url = str(reuse_snapshot.get("url") or "").lower()
                reuse_body = _normalize_ribeirao_text(reuse_snapshot.get("bodySnippet") or "")
                if "loginselecao.aspx" in reuse_url or "selecione o convenio" in reuse_body or "convenio sigla acao" in reuse_body:
                    selection_snapshot, selection_debug, selection_ok = await _handle_convenio_selection(
                        connector,
                        login,
                        password,
                        max(60000, connector.settings.timeout_ms),
                        reuse_snapshot,
                    )
                    reuse_snapshot = selection_snapshot
                    print(f"[RIBEIRAO_QUERY] reuse convenio targetFound: {str(bool(selection_debug.get('targetFound'))).lower()}", file=sys.stderr, flush=True)
                    print(f"[RIBEIRAO_QUERY] reuse convenio actionFound: {str(bool(selection_debug.get('actionFound'))).lower()}", file=sys.stderr, flush=True)
                    if selection_ok:
                        print("[RIBEIRAO_QUERY] sessao reutilizada avancou via selecao de convenio", file=sys.stderr, flush=True)
                if _portal_id(connector) != "governo_sp":
                    await connector._prepare_consulta_context()
                elif not await connector._wait_any(connector.settings.pdc_selector_cpf_input, 2500):
                    await _open_gov_sp_consulta_margem(connector, max(60000, connector.settings.timeout_ms))
                if await connector._wait_any(connector.settings.pdc_selector_cpf_input, 5000):
                    reused_session = True
                    print("[RIBEIRAO_QUERY] sessao reutilizada com sucesso", file=sys.stderr, flush=True)
            except Exception as exc:
                print(f"[RIBEIRAO_QUERY] sessao reutilizada falhou: {exc}", file=sys.stderr, flush=True)

        if not reused_session:
            await _open_login_browser(connector, login, password)
        connector.is_ready = True
        result = await connector.consultar_cliente(cpf)
        raw = _serialize_result(result)
        raw.setdefault("cpf", cpf)
        raw.setdefault("session_id", session_id)
        _write_status(session_id, "conectado", "Consulta executada com sucesso.")
        if connector.context and connector.session_state_path:
            try:
                await connector.context.storage_state(path=str(connector.session_state_path))
            except Exception:
                pass
        return {"ok": True, "cpf": cpf, "rawResult": raw, "session_id": session_id}
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        message = str(exc)
        code = getattr(exc, "code", None)
        stage = getattr(exc, "stage", None)
        if not code:
            code, message = _split_typed_login_error(message)
        clean_message = message
        status = "erro"
        extra = {"error_code": code} if code else None
        if stage:
            extra = {**(extra or {}), "stage": stage}
        if code == "MANUAL_AUTH_REQUIRED":
            status = "aguardando_validacao_manual"
        elif code == "CAPTCHA_REQUIRED":
            status = "captcha_required"
        elif code == "CPF_NOT_FOUND":
            status = "not_found"
            clean_message = "Dados de cadastro nao localizado."
        elif code == "CLIENT_QUERY_NOT_ALLOWED":
            status = "cliente_nao_permite_consulta"
            clean_message = "Cliente nao permite consulta."
        elif code == "LOGIN_REJECTED":
            status = "login_error"
        elif code == "LOGIN_OK_NAVIGATION_FAILED":
            status = "login_error"
        elif code == "LOGIN_FIELDS_NOT_FOUND" or code == "LOGIN_BUTTON_NOT_FOUND" or code == "LOGIN_PASSWORD_FIELD_NOT_FOUND" or code == "LOGIN_TIMEOUT" or code == "LOGIN_STILL_ON_SAME_PAGE" or code == "PROFILE_COMPLETION_REQUIRED" or code == "PORTAL_CHANGED" or code == "CONVENIO_ACTION_NOT_FOUND" or code == "CONVENIO_SELECTION_FAILED" or code == "CONVENIO_NOT_FOUND" or code == "UNKNOWN_LOGIN_ERROR" or code == "PORTAL_UNREACHABLE" or code == "DNS_RESOLUTION_FAILED" or code == "CHROMIUM_DNS_FAILED" or code == "WORKER_INTERNAL_ERROR" or code == "USER_ALREADY_LOGGED_CONFIRM_FAILED":
            status = "login_error"
        elif "sessao" in message.lower() and "expir" in message.lower():
            status = "session_expired"
        elif not code and not stage and ("browser" in message.lower() or "x server" in message.lower() or "$display" in message.lower()):
            status = "browser_launch_error"
            clean_message = "Erro ao iniciar navegador de consulta no servidor. Verifique configuracao do Playwright/Chromium em producao."
            code = code or "BROWSER_LAUNCH_ERROR"

        connection_alive_codes = {
            "CPF_NOT_FOUND",
            "CLIENT_QUERY_NOT_ALLOWED",
            "MARGIN_ROWS_NOT_FOUND",
        }
        if code in connection_alive_codes:
            _write_status(
                session_id,
                "conectado",
                "Sessao autenticada com sucesso.",
                {
                    **(extra or {}),
                    "last_query_status": status,
                    "last_query_code": code,
                    "last_query_message": clean_message or message,
                },
            )
        else:
            _write_status(session_id, status, clean_message or message, extra)
        return {
            "ok": False,
            "cpf": cpf,
            "session_id": session_id,
            "status": status,
            "code": code or ("BROWSER_LAUNCH_ERROR" if status == "browser_launch_error" else None),
            "stage": stage,
            "message": clean_message or message,
        }
    finally:
        try:
            await connector.close()
        except Exception:
            pass


async def get_session_status(payload: dict) -> dict:
    session_id = str(payload.get("session_id") or payload.get("sessionId") or "1")
    status_file = _status_path(session_id)
    if not status_file.exists():
        return {"session_id": session_id, "status": "desconhecido", "message": "Sessao nao localizada."}
    try:
        return json.loads(status_file.read_text(encoding="utf-8"))
    except Exception as exc:
        return {"session_id": session_id, "status": "erro", "message": str(exc)}


async def main_async() -> None:
    args = sys.argv[1:]
    payload = {}
    if "--payload-file" in args:
        index = args.index("--payload-file")
        if index + 1 < len(args):
            payload = _read_payload_from_file(args[index + 1])
    if not payload:
        payload = _read_json_stdin()
    action = str(payload.get("action") or "query").strip().lower()
    try:
        if action == "start_session":
            result = await start_session(payload)
        elif action == "session_status":
            result = await get_session_status(payload)
        else:
            result = await query_cpf(payload)
    except Exception as exc:
        session_id = str(payload.get("session_id") or payload.get("sessionId") or "1")
        message = str(exc)
        code = getattr(exc, "code", None)
        stage = getattr(exc, "stage", None)
        if action == "start_session":
            status = "erro_login"
        elif not code and "captcha" in message.lower():
            status = "captcha_required"
        elif not code and "login" in message.lower():
            status = "login_error"
        elif not code and not stage and ("browser" in message.lower() or "x server" in message.lower() or "$display" in message.lower() or "headed browser" in message.lower()):
            status = "browser_launch_error"
            code = "BROWSER_LAUNCH_ERROR"
            message = "Erro ao iniciar navegador de consulta no servidor. Verifique configuracao do Playwright/Chromium em producao."
        else:
            status = "erro"
        try:
            extra = {"error_code": code} if code else None
            if stage:
                extra = {**(extra or {}), "stage": stage}
            _write_status(session_id, status, message, extra)
        except Exception:
            pass
        result = {
            "ok": False,
            "session_id": session_id,
            "status": status,
            "code": code,
            "stage": stage,
            "message": message,
        }

    sys.stdout.write(json.dumps(result, ensure_ascii=False, default=str))
    sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main_async())
