import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


SOURCE = "Nova Vida"


def clean_digits(value: Any) -> str:
    return re.sub(r"\D+", "", str(value or ""))


def bool_env(name: str, default: bool = True) -> bool:
    value = str(os.getenv(name, str(default))).strip().lower()
    return value not in ("0", "false", "no", "nao", "n")


def env_value(*names: str) -> str:
    for name in names:
        value = os.getenv(name)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def load_dotenv() -> None:
    candidates = [
        Path.cwd() / ".env",
        Path.cwd().parent / ".env",
        Path(__file__).resolve().parents[4] / ".env",
    ]
    for path in candidates:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


def output(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def sample_text(text: str, limit: int = 900) -> str:
    return re.sub(r"\s+", " ", text or "").strip()[:limit]


def mask_cpf(cpf: str) -> str:
    digits = clean_digits(cpf)
    if len(digits) != 11:
        return "***"
    return f"***{digits[-3:]}"


def normalize_phone_number(value: Any) -> str | None:
    digits = clean_digits(value)
    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("55"):
        digits = digits[2:]
    if len(digits) not in (10, 11):
        return None
    if digits[:2] == "00":
        return None
    return f"+55{digits}"


def phone_type(normalized: str, raw_label: str = "") -> str:
    local = clean_digits(normalized)
    if local.startswith("55"):
        local = local[2:]
    label = (raw_label or "").lower()
    if "whatsapp" in label:
        return "whatsapp"
    if "cel" in label:
        return "celular"
    if "fix" in label:
        return "fixo"
    if len(local) == 11 and local[2] == "9":
        return "celular"
    if len(local) == 10:
        return "fixo"
    return ""


def phone_quality(raw_label: str = "") -> str:
    text = (
        str(raw_label or "")
        .encode("ascii", "ignore")
        .decode("ascii")
        .lower()
    )
    if "bom" in text or "boa" in text or "alto" in text:
        return "bom"
    if "medio" in text or "regular" in text:
        return "regular"
    if "baixo" in text or "ruim" in text:
        return "baixo"
    if "invalid" in text:
        return "invalido"
    return str(raw_label or "").strip()


def collect_page(page) -> dict[str, Any]:
    return page.evaluate(
        """() => {
          const body = document.body ? document.body.innerText : "";
          return {
            url: location.href,
            title: document.title,
            bodySample: body.replace(/\\s+/g, " ").trim().slice(0, 900),
            hasRecaptcha: Boolean(document.querySelector("iframe[src*='recaptcha'], .g-recaptcha")) || body.toLowerCase().includes("recaptcha"),
            inputs: Array.from(document.querySelectorAll("input,textarea,select")).slice(0, 100).map((el) => ({
              tag: el.tagName,
              id: el.id || "",
              name: el.getAttribute("name") || "",
              type: el.getAttribute("type") || "",
              placeholder: el.getAttribute("placeholder") || "",
              valueLength: (el.value || "").length,
              className: el.className || ""
            })),
            actions: Array.from(document.querySelectorAll("button,input[type=submit],input[type=button],a")).slice(0, 120).map((el) => ({
              tag: el.tagName,
              id: el.id || "",
              name: el.getAttribute("name") || "",
              type: el.getAttribute("type") || "",
              text: ((el.innerText || el.value || "").trim()).slice(0, 120),
              href: el.getAttribute("href") || "",
              className: el.className || ""
            }))
          };
        }"""
    )


def status_from_login_page(page_data: dict[str, Any]) -> dict[str, Any] | None:
    text = str(page_data.get("bodySample") or "").lower()
    if "falha ao autenticar" in text or "usuario invalido" in text or "usuário inválido" in text:
        return {
            "status": "failed",
            "code": "NOVA_VIDA_AUTH_FAILED",
            "message": "O Nova Vida recusou a autenticacao com os dados configurados.",
        }
    if page_data.get("hasRecaptcha"):
        return {
            "status": "requires_manual_login",
            "code": "NOVA_VIDA_RECAPTCHA_OR_MANUAL_LOGIN",
            "message": "O Nova Vida exibiu reCAPTCHA/protecao manual. Salve uma sessao autorizada antes da busca automatica.",
        }
    return None


def credentials() -> dict[str, str]:
    username = env_value("NOVA_VIDA_USERNAME", "NOVA_VIDA_USER")
    user = env_value("NOVA_VIDA_USER")
    client = env_value("NOVA_VIDA_CLIENT", "NOVA_VIDA_CUSTOMER", "NOVA_VIDA_TENANT")
    password = env_value("NOVA_VIDA_PASSWORD")

    # The public form has Usuario, Senha and Cliente. If no explicit client is
    # provided, keep the older fallback so existing .env files still work.
    if not client and user and username and user != username:
        if "@" in username and "@" not in user:
            username, client = user, username
        else:
            client = user

    return {
        "url": env_value("NOVA_VIDA_URL") or "https://congonhas.novavidati.com.br/",
        "username": username,
        "client": client,
        "password": password,
    }


def storage_state_path() -> Path:
    raw = env_value("NOVA_VIDA_STORAGE_STATE") or "data/nova_vida_storage_state.json"
    return Path(raw).expanduser().resolve()


def launch_browser(playwright):
    headless = bool_env("NOVA_VIDA_HEADLESS", True)
    return playwright.chromium.launch(
        headless=headless,
        args=[
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-quic",
        ],
    )


def new_context(browser):
    state = storage_state_path()
    if state.exists():
        return browser.new_context(storage_state=str(state), ignore_https_errors=True)
    return browser.new_context(ignore_https_errors=True)


def is_logged_in(page) -> bool:
    data = collect_page(page)
    text = str(data.get("bodySample") or "").lower()
    if data["url"].lower().rstrip("/").endswith("/login/login?defaultbutton=submitbutton"):
        return False
    if page.locator("#sUsuario, #sSenha, #sCliente").count() > 0:
        return False
    keywords = ["sair", "logout", "consulta", "cliente", "telefone", "cpf", "dashboard", "menu"]
    return any(keyword in text for keyword in keywords)


def login_if_needed(page) -> dict[str, Any]:
    creds = credentials()
    response = page.goto(creds["url"], wait_until="domcontentloaded", timeout=60000)
    initial = collect_page(page)
    if is_logged_in(page):
        return {"ok": True, "stage": "session", "page": initial}

    if page.locator("#sUsuario").count() == 0:
        status = status_from_login_page(initial)
        if status:
            return {"ok": False, "stage": "login_page", **status, "page": initial}
        return {
            "ok": False,
            "stage": "login_page",
            "status": "failed",
            "code": "NOVA_VIDA_LOGIN_FORM_NOT_FOUND",
            "message": "Nao foi possivel localizar o formulario de login do Nova Vida.",
            "page": initial,
        }

    if not creds["username"] or not creds["password"]:
        return {
            "ok": False,
            "stage": "credentials",
            "status": "requires_manual_login",
            "code": "NOVA_VIDA_CREDENTIALS_MISSING",
            "message": "Credenciais Nova Vida incompletas no ambiente.",
            "page": initial,
        }

    page.fill("#sUsuario", creds["username"], timeout=10000)
    page.fill("#sSenha", creds["password"], timeout=10000)
    if page.locator("#sCliente").count() > 0:
        page.fill("#sCliente", creds["client"], timeout=10000)

    try:
        with page.expect_navigation(wait_until="domcontentloaded", timeout=15000):
            page.click("#submitEntrar", timeout=10000)
    except Exception:
        try:
            page.click("#submitEntrar", timeout=3000)
        except Exception:
            pass
        page.wait_for_timeout(5000)

    after = collect_page(page)
    if is_logged_in(page):
        storage_state_path().parent.mkdir(parents=True, exist_ok=True)
        page.context.storage_state(path=str(storage_state_path()))
        return {"ok": True, "stage": "login", "page": after}

    status = status_from_login_page(after) or {
        "status": "failed",
        "code": "NOVA_VIDA_LOGIN_NOT_CONFIRMED",
        "message": "O Nova Vida nao confirmou login e permaneceu fora da area autenticada.",
    }
    return {"ok": False, "stage": "login", **status, "page": after}


def find_search_navigation(page) -> list[dict[str, Any]]:
    return page.evaluate(
        """() => Array.from(document.querySelectorAll("a,button,input[type=button],input[type=submit]"))
          .map((el, index) => ({
            index,
            tag: el.tagName,
            id: el.id || "",
            name: el.getAttribute("name") || "",
            text: ((el.innerText || el.value || "").trim()).slice(0, 120),
            href: el.getAttribute("href") || "",
            className: el.className || ""
          }))
          .filter((item) => /consulta|telefone|fone|cliente|pessoa|pesquisa|buscar|localizar|cpf/i.test(`${item.text} ${item.href} ${item.id} ${item.name} ${item.className}`))
          .slice(0, 60)"""
    )


def extract_phones_from_page(page) -> list[dict[str, Any]]:
    rows = page.evaluate(
        """() => {
          const out = [];
          const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            const text = (node.nodeValue || "").replace(/\\s+/g, " ").trim();
            if (/(\\(?\\d{2}\\)?\\s*)?9?\\d{4}[-\\s]?\\d{4}/.test(text)) {
              const parent = node.parentElement;
              out.push({
                text,
                context: parent ? (parent.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 240) : text
              });
            }
          }
          return out.slice(0, 80);
        }"""
    )
    phones: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        context = str(row.get("context") or row.get("text") or "")
        for match in re.findall(r"(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?9?\d{4}[-\s]?\d{4}", context):
            normalized = normalize_phone_number(match)
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            phones.append(
                {
                    "number": match.strip(),
                    "normalized": normalized,
                    "type": phone_type(normalized, context),
                    "quality": phone_quality(context),
                    "is_whatsapp": True if "whatsapp" in context.lower() else None,
                    "raw_label": context[:180],
                    "source": SOURCE,
                }
            )
    return phones


def try_generic_search(page, cpf: str, name: str) -> dict[str, Any]:
    data = collect_page(page)
    nav = find_search_navigation(page)
    candidates = page.locator(
        "input[type=text], input[type=search], input:not([type]), textarea"
    )
    count = candidates.count()
    query = clean_digits(cpf) or name

    if not query:
        return {
            "status": "failed",
            "code": "NOVA_VIDA_SEARCH_INPUT_REQUIRED",
            "message": "Informe CPF ou nome para buscar.",
            "phones": [],
            "page": data,
            "navigationCandidates": nav,
        }

    for index in range(min(count, 25)):
        locator = candidates.nth(index)
        try:
            info = locator.evaluate(
                """el => ({
                  id: el.id || "",
                  name: el.getAttribute("name") || "",
                  placeholder: el.getAttribute("placeholder") || "",
                  type: el.getAttribute("type") || "",
                  visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
                })"""
            )
            haystack = " ".join(str(info.get(k) or "") for k in ("id", "name", "placeholder", "type")).lower()
            if not info.get("visible"):
                continue
            if not any(word in haystack for word in ("cpf", "nome", "cliente", "telefone", "fone", "busca", "pesquisa")):
                continue
            locator.fill(query, timeout=3000)
            locator.press("Enter", timeout=3000)
            page.wait_for_timeout(5000)
            phones = extract_phones_from_page(page)
            if phones:
                return {
                    "status": "success",
                    "code": "",
                    "message": "Telefones encontrados no Nova Vida.",
                    "phones": phones,
                    "searchInput": info,
                    "page": collect_page(page),
                }
        except Exception:
            continue

    return {
        "status": "requires_manual_login",
        "code": "NOVA_VIDA_SEARCH_FLOW_NOT_MAPPED",
        "message": "Login/sessao ok, mas o fluxo real de pesquisa ainda precisa ser mapeado na tela autenticada.",
        "phones": [],
        "page": data,
        "navigationCandidates": nav,
        "inputCount": count,
    }


def command_map() -> None:
    with sync_playwright() as playwright:
        browser = launch_browser(playwright)
        context = new_context(browser)
        page = context.new_page()
        try:
            login = login_if_needed(page)
            payload = {
                "status": "success" if login.get("ok") else login.get("status", "failed"),
                "source": SOURCE,
                "stage": login.get("stage"),
                "code": login.get("code", ""),
                "message": login.get("message", ""),
                "loginOk": bool(login.get("ok")),
                "page": login.get("page"),
                "navigationCandidates": find_search_navigation(page) if login.get("ok") else [],
            }
            output(payload)
        finally:
            context.close()
            browser.close()


def command_search(cpf: str, name: str) -> None:
    with sync_playwright() as playwright:
        browser = launch_browser(playwright)
        context = new_context(browser)
        page = context.new_page()
        try:
            login = login_if_needed(page)
            if not login.get("ok"):
                output(
                    {
                        "status": login.get("status", "failed"),
                        "source": SOURCE,
                        "cpf": clean_digits(cpf),
                        "name": name or "",
                        "phones": [],
                        "code": login.get("code", "NOVA_VIDA_LOGIN_FAILED"),
                        "message": login.get("message", "Falha no login Nova Vida."),
                        "stage": login.get("stage", "login"),
                    }
                )
                return

            result = try_generic_search(page, cpf, name)
            output(
                {
                    "source": SOURCE,
                    "cpf": clean_digits(cpf),
                    "name": name or "",
                    **result,
                }
            )
        except PlaywrightTimeoutError as exc:
            output(
                {
                    "status": "failed",
                    "source": SOURCE,
                    "cpf": clean_digits(cpf),
                    "name": name or "",
                    "phones": [],
                    "code": "NOVA_VIDA_TIMEOUT",
                    "message": str(exc)[:300],
                }
            )
        except Exception as exc:
            output(
                {
                    "status": "failed",
                    "source": SOURCE,
                    "cpf": clean_digits(cpf),
                    "name": name or "",
                    "phones": [],
                    "code": "NOVA_VIDA_WORKER_ERROR",
                    "message": f"{type(exc).__name__}: {str(exc)[:260]}",
                }
            )
        finally:
            context.close()
            browser.close()


def main() -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Nova Vida phone lookup worker")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("map")
    search = sub.add_parser("search")
    search.add_argument("--cpf", default="")
    search.add_argument("--name", default="")
    args = parser.parse_args()
    if args.command == "map":
        command_map()
    elif args.command == "search":
        command_search(args.cpf, args.name)


if __name__ == "__main__":
    main()
