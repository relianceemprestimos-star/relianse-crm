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


def normalize_birth_date(value: str) -> str:
    match = re.search(r"(\d{2})/(\d{2})/(\d{4})", value or "")
    if not match:
        return ""
    day, month, year = match.groups()
    return f"{year}-{month}-{day}"


def parse_address_parts(address_full: str) -> dict[str, Any]:
    text = re.sub(r"\s+", " ", address_full or "").strip()
    zipcode = ""
    state = ""
    city = ""
    before_city = text
    city_match = re.search(r"\s-\s([^-/]+?)\s*/\s*([A-Z]{2})\s-\s(\d{5}-?\d{3})$", text)
    if city_match:
        before_city = text[: city_match.start()].strip()
        city = city_match.group(1).strip()
        state = city_match.group(2).strip()
        zipcode = clean_digits(city_match.group(3))

    parts = [part.strip() for part in before_city.split(",")]
    street = parts[0] if parts else ""
    number = parts[1] if len(parts) > 1 else ""
    remainder = " ".join(parts[2:]).strip() if len(parts) > 2 else ""
    district = ""
    complement = remainder
    if remainder:
        words = remainder.split()
        if len(words) >= 2:
            district = " ".join(words[-2:])
            complement = " ".join(words[:-2]).strip()
        else:
            district = remainder
            complement = ""

    return {
        "address_full": text,
        "street": street,
        "number": number,
        "complement": complement,
        "district": district,
        "city": city,
        "state": state,
        "zipcode": zipcode,
    }


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
    headless = True if os.getenv("NODE_ENV") == "production" else bool_env("NOVA_VIDA_HEADLESS", True)
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


def extract_tables(page) -> list[str]:
    return page.evaluate(
        """() => Array.from(document.querySelectorAll("table"))
          .map((table) => (table.innerText || "").replace(/\\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 30)"""
    )


def extract_emails_from_text(text: str) -> list[str]:
    seen: set[str] = set()
    emails: list[str] = []
    for email in re.findall(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+", text or ""):
        lowered = email.lower()
        if lowered not in seen:
            seen.add(lowered)
            emails.append(email)
    return emails


def parse_addresses_from_text(text: str) -> list[dict[str, Any]]:
    chunk = ""
    match = re.search(r"Endereços\s+(.+?)(?:\s+mail\s+E-mails|\s+Indicadores|\s+Score|\Z)", text or "", re.I)
    if match:
        chunk = match.group(1)
    else:
        chunk = text or ""
    chunk = re.sub(r"\b(query_stats|cottage|person_search|call|location_on)\b", " | ", chunk)
    candidates = [re.sub(r"\s+", " ", item).strip(" |") for item in chunk.split("|")]
    addresses: list[dict[str, Any]] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or "/" not in candidate or not re.search(r"\b[A-Z]{2}\b\s*-\s*\d{5}-?\d{3}", candidate):
            continue
        parsed = parse_address_parts(candidate)
        key = parsed["address_full"].lower()
        if key and key not in seen:
            seen.add(key)
            addresses.append(parsed)
    return addresses


def parse_personal_data(page) -> dict[str, Any]:
    data = page.evaluate(
        """() => ({
          url: location.href,
          title: document.title,
          body: (document.body ? document.body.innerText : "").replace(/\\s+/g, " ").trim()
        })"""
    )
    body = str(data.get("body") or "")
    tables = extract_tables(page)
    all_text = " ".join([body, *tables])

    cpf = ""
    cpf_match = re.search(r"\bCPF\s+(\d{3}\.?\d{3}\.?\d{3}-?\d{2})", body, re.I)
    if cpf_match:
        cpf = clean_digits(cpf_match.group(1))

    full_name = ""
    name_source = body
    for marker in ("save print contact_page Cadastro ", "contact_page Cadastro ", "Cadastro "):
        if marker in body:
            name_source = body.split(marker)[-1]
            break
    name_match = re.search(r"^(.+?)\s+CPF\s+", name_source, re.I)
    if name_match:
        full_name = re.sub(r"\s+", " ", name_match.group(1)).strip()

    gender = ""
    gender_match = re.search(r"Gênero de identificação\s+(.+?)\s+RG\s+", body, re.I)
    if gender_match:
        gender = gender_match.group(1).strip()

    age = None
    age_match = re.search(r"Idade\s+(\d+)\s+anos", body, re.I)
    if age_match:
        age = int(age_match.group(1))

    birth_date = ""
    birth_match = re.search(r"Nascimento\s+(\d{2}/\d{2}/\d{4})", body, re.I)
    if birth_match:
        birth_date = normalize_birth_date(birth_match.group(1))

    mother_name = ""
    mother_match = re.search(r"Mãe\s+(.+?)\s+Pai\s+", body, re.I)
    if mother_match:
        mother_name = mother_match.group(1).strip()

    father_name = ""
    father_match = re.search(r"Pai\s+(.+?)(?:\s+call\s+Telefones|\s+Telefones\s+fixos)", body, re.I)
    if father_match:
        father_name = father_match.group(1).strip()

    emails = extract_emails_from_text(all_text)
    addresses = parse_addresses_from_text(all_text)

    extra: dict[str, Any] = {}
    for label, pattern in {
        "registration_status": r"Situação Cadastral\s+(.+?)\s+Idade\s+",
        "generation": r"Persona\s+(.+?)\s+done\s+Situação",
        "rg": r"RG\s+(.+?)\s+face_",
        "sign": r"Signo\s+(.+?)\s+Mãe\s+",
        "credit_score": r"Score de crédito NV\s+(.+?)\s+Score Digital",
    }.items():
        match = re.search(pattern, body, re.I)
        if match:
            extra[label] = match.group(1).strip()

    return {
        "cpf": cpf,
        "full_name": full_name,
        "birth_date": birth_date,
        "age": age,
        "gender": gender,
        "mother_name": mother_name,
        "father_name": father_name,
        "email": emails[0] if emails else "",
        "emails": emails,
        "addresses": addresses,
        "extra": extra,
        "raw_data": {
            "url": data.get("url"),
            "title": data.get("title"),
            "body_sample": sample_text(body, 5000),
            "tables": tables,
        },
    }


def try_generic_search(page, cpf: str, name: str) -> dict[str, Any]:
    data = collect_page(page)
    nav = find_search_navigation(page)
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

    if page.locator("#documento").count() > 0:
        page.fill("#documento", query, timeout=10000)
        try:
            with page.expect_navigation(wait_until="domcontentloaded", timeout=20000):
                page.locator("#buscaDashboard button[type=submit], #buscaDashboard input[type=submit]").first.click(timeout=10000)
        except Exception:
            page.wait_for_timeout(8000)

        page_data = collect_page(page)
        body = str(page_data.get("bodySample") or "").lower()
        if "documento inválido" in body or "documento invalido" in body:
            return {
                "status": "not_found",
                "code": "NOVA_VIDA_INVALID_DOCUMENT",
                "message": "O Nova Vida informou documento invalido.",
                "phones": [],
                "page": page_data,
                "searchInput": {"id": "documento", "name": "documento"},
            }

        phones = extract_phones_from_page(page)
        enrichment = parse_personal_data(page)
        if phones:
            return {
                "status": "success",
                "code": "",
                "message": "Telefones encontrados no Nova Vida.",
                "phones": phones,
                **enrichment,
                "searchInput": {"id": "documento", "name": "documento"},
                "page": page_data,
            }

        if "/pf/cadastro" in str(page.url).lower():
            return {
                "status": "not_found",
                "code": "NOVA_VIDA_NO_PHONES_FOUND",
                "message": "Cadastro encontrado no Nova Vida, mas nenhum telefone foi localizado.",
                "phones": [],
                **enrichment,
                "searchInput": {"id": "documento", "name": "documento"},
                "page": page_data,
            }

    candidates = page.locator(
        "input[type=text], input[type=search], input:not([type]), textarea"
    )
    count = candidates.count()

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
