
import asyncio
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from playwright.async_api import TimeoutError as PlaywrightTimeoutError, async_playwright

PORTAL_URL = os.getenv("SANTANA_PORTAL_URL") or "https://santana.rf1consig.com.br/servidor/principal"
LOGIN_URL = os.getenv("SANTANA_LOGIN_URL") or "https://santana.rf1consig.com.br/"
STORAGE_STATE = Path(os.getenv("SANTANA_STORAGE_STATE") or "/app/data/santana_storage_state.json")
CAPTCHA_ENGINE_ENABLED = str(os.getenv("CAPTCHA_ENGINE_ENABLED") or "false").lower() in {"1", "true", "yes", "sim", "on"}
CAPTCHA_EXTERNAL_PROVIDER = (os.getenv("CAPTCHA_EXTERNAL_PROVIDER") or "capsolver").strip().lower()
CAPTCHA_EXTERNAL_PROVIDER_ENABLED = str(os.getenv("CAPTCHA_EXTERNAL_PROVIDER_ENABLED") or "false").lower() in {"1", "true", "yes", "sim", "on"}
CAPTCHA_PROVIDER_TIMEOUT_SECONDS = int(int(os.getenv("CAPTCHA_PROVIDER_TIMEOUT_MS") or os.getenv("CAPSOLVER_TIMEOUT_MS") or "120000") / 1000)
CAPTCHA_PROVIDER_POLL_SECONDS = max(1, int(int(os.getenv("CAPTCHA_PROVIDER_POLL_INTERVAL_MS") or os.getenv("CAPSOLVER_POLL_INTERVAL_MS") or "3000") / 1000))
EXTERNAL_PROVIDER_API_KEY = os.getenv("CAPSOLVER_API_KEY") or os.getenv("CAPTCHA_CAPSOLVER_API_KEY") or ""
EXTERNAL_PROVIDER_TASK_TYPE = os.getenv("CAPSOLVER_TASK_TYPE") or "ReCaptchaV2TaskProxyLess"
DEFAULT_USER_AGENT = os.getenv("SANTANA_USER_AGENT") or (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

def read_payload():
    raw = sys.stdin.read()
    return json.loads(raw) if raw.strip() else {}

def clean_digits(value):
    return re.sub(r"\D", "", str(value or ""))

def parse_money(value):
    text = str(value or "").strip()
    if not text:
        return ""
    match = re.search(r"R\$\s*-?[\d.]+,\d{2}|-?[\d.]+,\d{2}", text)
    return match.group(0).replace("R$", "").strip() if match else ""

def money_after(label, text):
    pattern = re.compile(re.escape(label) + r"\s*:?\s*(R\$\s*-?[\d.]+,\d{2}|-?[\d.]+,\d{2})", re.I)
    match = pattern.search(text)
    return parse_money(match.group(1)) if match else ""

def text_after(label, text):
    pattern = re.compile(re.escape(label) + r"\s*\n\s*([^\n]+)", re.I)
    match = pattern.search(text)
    return match.group(1).strip() if match else ""

def normalize_result(cpf, page_text):
    not_found = re.search(r"nao localizado|não localizado|nao encontrado|não encontrado|nenhum", page_text, re.I)
    payload = {
        "nome_portal": "",
        "matricula": text_after("Matrícula", page_text),
        "orgao": text_after("Secretaria", page_text),
        "cargo": "",
        "vinculo": text_after("Vínculo Empregatício", page_text) or text_after("Vinculo Empregaticio", page_text),
        "status_servidor": text_after("Status", page_text),
        "margem_emprestimo_disponivel": money_after("Margem Desconto Consignado", page_text),
        "margem_cartao_disponivel": money_after("Margem Cartão de Crédito", page_text) or money_after("Margem Cartao de Credito", page_text),
        "cartao_beneficio_disponivel": money_after("Margem Cartão Benefício", page_text) or money_after("Margem Cartao Beneficio", page_text),
        "margem_acisesp_disponivel": money_after("Margem ACISESP", page_text),
    }
    lines = [line.strip() for line in page_text.splitlines() if line.strip()]
    for index, line in enumerate(lines):
        if cpf in clean_digits(line) and index > 0:
            payload["nome_portal"] = lines[index - 1]
            break
    has_margin_data = any(payload.get(key) for key in ["margem_emprestimo_disponivel", "margem_cartao_disponivel", "cartao_beneficio_disponivel", "margem_acisesp_disponivel"])
    if not_found and not has_margin_data:
        status, message = "not_found", "CPF nao localizado no portal Santana."
    elif has_margin_data:
        status, message = "success", "Consulta web Santana realizada."
    else:
        status, message = "erro", "Nao foi possivel identificar as margens na tela Santana."
    return {"status": status, "cpf": cpf, "message": message, "payload_extra": payload, "raw_data": {"page_text": page_text}}

def captcha_required(message="Portal Santana solicitou reCAPTCHA.", code="SANTANA_WEB_CAPTCHA_REQUIRED", captcha_meta=None):
    return {"status": "captcha_required", "detalhe_erro": message, "payload_extra": {"code": code, "captcha_engine": captcha_meta or {"status": "MANUAL_AUTH_REQUIRED", "provider": "MANUAL", "message": message}}}

def external_provider_post(path, payload):
    if CAPTCHA_EXTERNAL_PROVIDER != "capsolver":
        raise RuntimeError("Provider externo de CAPTCHA nao suportado neste adaptador.")
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(f"https://api.capsolver.com/{path}", data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Provider externo HTTP {exc.code}: {detail[:300]}") from exc

def solve_recaptcha_with_external_provider(site_key, website_url):
    if not CAPTCHA_ENGINE_ENABLED or not CAPTCHA_EXTERNAL_PROVIDER_ENABLED:
        raise RuntimeError("Provider externo de CAPTCHA desativado pelo Motor de CAPTCHA.")
    if not EXTERNAL_PROVIDER_API_KEY.strip():
        raise RuntimeError("API Key do provider externo nao configurada.")
    if not site_key:
        raise RuntimeError("Site key do reCAPTCHA nao encontrada no portal Santana.")
    created = external_provider_post("createTask", {"clientKey": EXTERNAL_PROVIDER_API_KEY.strip(), "task": {"type": EXTERNAL_PROVIDER_TASK_TYPE, "websiteURL": website_url, "websiteKey": site_key, "isInvisible": False}})
    if created.get("errorId"):
        raise RuntimeError(created.get("errorDescription") or created.get("errorCode") or "Falha ao criar tarefa no provider externo.")
    task_id = created.get("taskId")
    if not task_id:
        raise RuntimeError(f"Provider externo nao retornou taskId: {created}")
    deadline = time.monotonic() + CAPTCHA_PROVIDER_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        time.sleep(CAPTCHA_PROVIDER_POLL_SECONDS)
        result = external_provider_post("getTaskResult", {"clientKey": EXTERNAL_PROVIDER_API_KEY.strip(), "taskId": task_id})
        if result.get("errorId"):
            raise RuntimeError(result.get("errorDescription") or result.get("errorCode") or "Falha ao resolver captcha.")
        if result.get("status") == "ready":
            solution = result.get("solution") or {}
            token = solution.get("gRecaptchaResponse") or solution.get("token")
            if not token:
                raise RuntimeError(f"Provider externo retornou solucao sem token: {result}")
            return {"token": token, "task_id": task_id, "status": "EXTERNAL_PROVIDER_SOLVED", "provider": "CAPSOLVER"}
        if result.get("status") == "failed":
            raise RuntimeError(f"Provider externo falhou: {result}")
    raise RuntimeError("Tempo limite aguardando solucao do provider externo.")

async def is_logged(page):
    text = await page.locator("body").inner_text(timeout=5000)
    return "CPF/Matrícula" in text or "CPF/Matricula" in text or "Portal Consignatária" in text

async def recaptcha_present(page):
    return await page.evaluate('''() => Boolean(document.querySelector('#g-recaptcha-response, textarea[name="g-recaptcha-response"], iframe[src*="recaptcha/api2/anchor"]'))''')

async def get_recaptcha_site_key(page):
    return await page.evaluate('''() => {
      const keyed = document.querySelector('[data-sitekey]');
      if (keyed && keyed.getAttribute('data-sitekey')) return keyed.getAttribute('data-sitekey');
      const frame = Array.from(document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"]'))[0];
      if (!frame) return '';
      try { return new URL(frame.src).searchParams.get('k') || ''; } catch (_) { return ''; }
    }''')

async def inject_recaptcha_token(page, token):
    await page.evaluate('''(token) => {
      let field = document.querySelector('#g-recaptcha-response, textarea[name="g-recaptcha-response"]');
      if (!field) {
        field = document.createElement('textarea');
        field.id = 'g-recaptcha-response';
        field.name = 'g-recaptcha-response';
        field.style.display = 'none';
        const form = document.querySelector('form') || document.body;
        form.appendChild(field);
      }
      field.value = token;
      field.innerHTML = token;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }''', token)

async def solve_login_captcha(page):
    if not await recaptcha_present(page):
        return None
    if not CAPTCHA_ENGINE_ENABLED or not CAPTCHA_EXTERNAL_PROVIDER_ENABLED or not EXTERNAL_PROVIDER_API_KEY.strip():
        return captcha_required("Portal Santana pediu reCAPTCHA. Motor de CAPTCHA sem provider externo habilitado para este portal.", "SANTANA_CAPTCHA_PROVIDER_DISABLED")
    site_key = await get_recaptcha_site_key(page)
    try:
        solved = await asyncio.to_thread(solve_recaptcha_with_external_provider, site_key, LOGIN_URL)
        await inject_recaptcha_token(page, solved["token"])
        return {"status": "TOKEN_APPLIED", "provider": solved.get("provider") or "CAPSOLVER", "task_id": solved.get("task_id") or ""}
    except Exception as exc:
        return captcha_required(f"Falha ao resolver reCAPTCHA do portal Santana pelo Motor de CAPTCHA: {exc}", "SANTANA_CAPTCHA_PROVIDER_FAILED", {"status": "EXTERNAL_PROVIDER_FAILED", "provider": "CAPSOLVER", "message": str(exc)})

async def submit_login(page, timeout_ms):
    try:
        await page.get_by_text("Entrar", exact=True).click()
        await page.wait_for_load_state("networkidle", timeout=timeout_ms)
    except PlaywrightTimeoutError:
        await page.wait_for_timeout(3000)

async def run(payload):
    cpf = clean_digits(payload.get("cpf"))
    if len(cpf) != 11:
        return {"status": "erro", "detalhe_erro": "CPF invalido para consulta em Santana.", "payload_extra": {"code": "INVALID_CPF"}}
    login = clean_digits(payload.get("login") or payload.get("username"))
    password = str(payload.get("password") or "")
    headless = str(payload.get("headless", os.getenv("SANTANA_HEADLESS", "true"))).lower() not in {"0", "false", "no"}
    timeout_ms = int(payload.get("timeout_ms") or os.getenv("SANTANA_QUERY_TIMEOUT_MS") or 45000)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=headless, args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"])
        context_kwargs = {"user_agent": DEFAULT_USER_AGENT}
        if STORAGE_STATE.exists():
            context_kwargs["storage_state"] = str(STORAGE_STATE)
        context = await browser.new_context(**context_kwargs)
        page = await context.new_page()
        page.set_default_timeout(timeout_ms)
        captcha_engine_meta = None
        try:
            await page.goto(PORTAL_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(2500)
            if not await is_logged(page):
                if not login or not password:
                    return {"status": "login_error", "detalhe_erro": "Sessao Santana nao autenticada e credencial ausente.", "payload_extra": {"code": "SANTANA_WEB_SESSION_REQUIRED"}}
                await page.goto(LOGIN_URL, wait_until="networkidle")
                await page.locator("#inputCPF").fill(login)
                await page.locator("input[type='password']").fill(password)
                captcha_result = await solve_login_captcha(page)
                if captcha_result and captcha_result.get("status") == "captcha_required":
                    return captcha_result
                if captcha_result:
                    captcha_engine_meta = captcha_result
                await submit_login(page, timeout_ms)
                await page.wait_for_timeout(2500)
                if not await is_logged(page):
                    if await recaptcha_present(page):
                        return captcha_required("Portal Santana nao aceitou a validacao de reCAPTCHA.", "SANTANA_WEB_CAPTCHA_NOT_ACCEPTED", {"status": "TOKEN_REJECTED", "provider": captcha_engine_meta.get("provider") if captcha_engine_meta else "MANUAL", "task_id": captcha_engine_meta.get("task_id") if captcha_engine_meta else "", "message": "Token rejeitado pelo portal."})
                    return {"status": "login_error", "detalhe_erro": "Login Santana nao confirmou sessao ativa.", "payload_extra": {"code": "SANTANA_WEB_LOGIN_FAILED"}}
                STORAGE_STATE.parent.mkdir(parents=True, exist_ok=True)
                await context.storage_state(path=str(STORAGE_STATE))
            await page.goto(PORTAL_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(1500)
            await page.locator("#inputCPF").fill(cpf)
            await page.get_by_text("Buscar", exact=True).click()
            await page.wait_for_timeout(3500)
            page_text = await page.locator("body").inner_text(timeout=timeout_ms)
            result = normalize_result(cpf, page_text)
            if captcha_engine_meta:
                result.setdefault("payload_extra", {})["captcha_engine"] = captcha_engine_meta
            return result
        except PlaywrightTimeoutError as exc:
            return {"status": "erro", "detalhe_erro": f"Tempo limite na consulta web Santana: {exc}", "payload_extra": {"code": "SANTANA_WEB_TIMEOUT"}}
        finally:
            await context.close()
            await browser.close()

def main():
    try:
        result = asyncio.run(run(read_payload()))
        print(json.dumps(result, ensure_ascii=False), flush=True)
    except Exception as exc:
        print(json.dumps({"status": "erro", "detalhe_erro": str(exc), "payload_extra": {"code": "SANTANA_WEB_INTERNAL_ERROR"}}, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()
