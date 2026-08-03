from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any
from urllib import request as urllib_request

from playwright.async_api import Page, async_playwright


PORTAL_URL = "https://santana.rf1consig.com.br/"
SESSION_DIR = Path(os.getenv("SANTANA_SESSION_DIR") or "data/santana_sessions")
SESSION_FILE = SESSION_DIR / "storage-state.json"


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def digits(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def capsolver_key() -> str:
    return (
        os.getenv("CAPSOLVER_API_KEY")
        or os.getenv("CAPSOLVE_API_KEY")
        or os.getenv("CAPTCHA_SOLVER_API_KEY")
        or ""
    ).strip()


def post_json(url: str, payload: dict[str, Any], timeout: int = 30) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib_request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8") or "{}")


async def solve_recaptcha(page: Page) -> str:
    key = capsolver_key()
    if not key:
        raise RuntimeError("CAPSOLVER_API_KEY não configurada.")
    metadata = await page.evaluate(
        """() => {
          for (const frame of document.querySelectorAll("iframe[src*='recaptcha']")) {
            try {
              const url = new URL(frame.src, location.href);
              const siteKey = url.searchParams.get("k");
              if (siteKey) return { siteKey, pageUrl: location.href };
            } catch (_) {}
          }
          const node = document.querySelector("[data-sitekey]");
          return { siteKey: node?.getAttribute("data-sitekey") || "", pageUrl: location.href };
        }"""
    )
    if not metadata.get("siteKey"):
        raise RuntimeError("Sitekey do reCAPTCHA de Santana não encontrada.")
    created = await asyncio.to_thread(
        post_json,
        "https://api.capsolver.com/createTask",
        {
            "clientKey": key,
            "task": {
                "type": "ReCaptchaV2TaskProxyLess",
                "websiteURL": metadata["pageUrl"],
                "websiteKey": metadata["siteKey"],
            },
        },
    )
    if created.get("errorId") or not created.get("taskId"):
        raise RuntimeError(created.get("errorDescription") or "CapSolver não iniciou a tarefa.")
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        await asyncio.sleep(3)
        result = await asyncio.to_thread(
            post_json,
            "https://api.capsolver.com/getTaskResult",
            {"clientKey": key, "taskId": created["taskId"]},
        )
        if result.get("errorId"):
            raise RuntimeError(result.get("errorDescription") or "CapSolver falhou.")
        if result.get("status") == "ready":
            token = str((result.get("solution") or {}).get("gRecaptchaResponse") or "")
            if token:
                return token
    raise RuntimeError("Tempo limite aguardando o CapSolver.")


async def inject_recaptcha(page: Page, token: str) -> None:
    await page.evaluate(
        """token => {
          const setValue = el => {
            if (!el) return;
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, token);
            el.innerHTML = token;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          };
          let target = document.querySelector("textarea[name='g-recaptcha-response'], #g-recaptcha-response");
          if (!target) {
            target = document.createElement("textarea");
            target.name = "g-recaptcha-response";
            target.id = "g-recaptcha-response";
            target.style.display = "none";
            (document.querySelector("form") || document.body).appendChild(target);
          }
          setValue(target);
          document.querySelectorAll("textarea[name='g-recaptcha-response']").forEach(setValue);
          const seen = new Set();
          const callbacks = [];
          const walk = obj => {
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
          callbacks.forEach(callback => { try { callback(token); } catch (_) {} });
        }""",
        token,
    )


async def login(page: Page, login_value: str, password: str) -> None:
    await page.goto(PORTAL_URL, wait_until="domcontentloaded", timeout=60_000)
    await page.wait_for_timeout(2_000)
    if not await page.locator("input[name='Input.Cpf']").count():
        return
    await page.locator("input[name='Input.Cpf']").fill(login_value)
    await page.locator("input[name='Input.Senha']").fill(password)
    token = await solve_recaptcha(page)
    await inject_recaptcha(page, token)
    submit = page.locator("button[type='submit'], input[type='submit']")
    if not await submit.count():
        raise RuntimeError("Botão Entrar de Santana não encontrado.")
    await submit.first.click()
    await page.wait_for_timeout(4_000)
    if await page.locator("input[name='Input.Cpf']").count():
        body = (await page.locator("body").inner_text()).strip()
        raise RuntimeError(body[-500:] or "O portal permaneceu na tela de login.")


async def inspect_page(page: Page) -> dict[str, Any]:
    return await page.evaluate(
        """() => ({
          url: location.href,
          title: document.title,
          text: (document.body?.innerText || "").slice(0, 12000),
          links: Array.from(document.querySelectorAll("a")).slice(0, 100).map(a => ({
            text: (a.innerText || a.textContent || "").trim(),
            href: a.href
          })).filter(x => x.text || x.href),
          buttons: Array.from(document.querySelectorAll("button")).slice(0, 100).map(b => ({
            text: (b.innerText || b.textContent || "").trim(),
            type: b.type
          })),
          inputs: Array.from(document.querySelectorAll("input,select,textarea")).slice(0, 100).map(e => ({
            tag: e.tagName,
            id: e.id,
            name: e.getAttribute("name") || "",
            type: e.getAttribute("type") || "",
            placeholder: e.getAttribute("placeholder") || ""
          })),
          dataBlocks: Array.from(document.querySelectorAll("label,dt,th,p,span,div"))
            .filter(e => /^(Matrícula|Secretaria|Vínculo Empregatício|Status|RG|Data Admissão|Data Nascimento|Data Fim Contrato|Margem)/i.test((e.innerText || "").trim()))
            .slice(0, 80)
            .map(e => ({
              tag: e.tagName,
              text: (e.innerText || "").trim(),
              parent: (e.parentElement?.innerText || "").trim().slice(0, 500),
              html: e.outerHTML.slice(0, 800)
            })),
          identityBlocks: Array.from(document.querySelectorAll("p,span,div,h1,h2,h3,h4,h5,h6"))
            .filter(e => /^\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}$/.test((e.innerText || "").trim()))
            .slice(0, 20)
            .map(e => ({
              tag: e.tagName,
              text: (e.innerText || "").trim(),
              parent: (e.parentElement?.innerText || "").trim().slice(0, 1000),
              html: e.parentElement?.outerHTML.slice(0, 1800) || ""
            }))
        })"""
    )


def parse_money(value: str) -> float | None:
    text = str(value or "").strip()
    if not text or text == "-":
        return None
    normalized = re.sub(r"[^\d,.-]", "", text).replace(".", "").replace(",", ".")
    try:
        return float(normalized)
    except ValueError:
        return None


async def search_server(page: Page, cpf: str) -> dict[str, Any]:
    field = page.locator("input[name='_InputCpfOuMatricula.CpfOuMatricula']")
    await field.fill(digits(cpf).zfill(11))
    await page.get_by_role("button", name="Buscar", exact=True).click()
    await page.wait_for_timeout(2_000)
    text = (await page.locator("body").inner_text()).strip()
    if "servidor não encontrado" in text.lower():
        close_button = page.get_by_role("button", name="Fechar", exact=True)
        if await close_button.count():
            await close_button.click()
            await page.wait_for_timeout(300)
        return {
            "status": "nao_encontrado",
            "cpf": digits(cpf).zfill(11),
            "message": "Servidor não encontrado.",
        }
    data = await page.evaluate(
        """() => {
          const clean = value => String(value || "").replace(/\\s+/g, " ").trim();
          const body = clean(document.body?.innerText || "");
          const labels = ["Matrícula", "Secretaria", "Vínculo Empregatício", "Status", "RG", "Data Admissão", "Data Nascimento", "Data Fim Contrato"];
          const result = {};
          for (const label of labels) {
            const node = Array.from(document.querySelectorAll("label")).find(e => clean(e.innerText) === label);
            result[label] = clean(node?.nextElementSibling?.innerText || node?.parentElement?.querySelector("p")?.innerText || "");
          }
          for (const label of ["Margem Desconto Consignado:", "Margem Cartão de Crédito:", "Margem Cartão Benefício:", "Margem ACISESP:"]) {
            const node = Array.from(document.querySelectorAll("label")).find(e => clean(e.innerText) === label);
            result[label] = clean(node?.parentElement?.parentElement?.querySelector("p")?.innerText || "");
          }
          const cpfMatch = body.match(/\\b\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}\\b/);
          const cpfNode = Array.from(document.querySelectorAll("p,span,div"))
            .find(e => clean(e.innerText) === (cpfMatch?.[0] || ""));
          const identityLines = String(cpfNode?.parentElement?.innerText || "")
            .split(/\\n+/)
            .map(clean)
            .filter(Boolean);
          const name = identityLines.find(value => value !== (cpfMatch?.[0] || "") && !/^(Matrícula|Secretaria|Vínculo|Status|RG|Data |Margem )/i.test(value)) || "";
          return { body, name, cpf: cpfMatch?.[0] || "", fields: result };
        }"""
    )
    fields = data.get("fields") or {}
    return {
        "status": "sucesso",
        "cpf": digits(data.get("cpf") or cpf).zfill(11),
        "nome": data.get("name") or "",
        "matricula": fields.get("Matrícula") or "",
        "secretaria": fields.get("Secretaria") or "",
        "vinculo": fields.get("Vínculo Empregatício") or "",
        "situacao": fields.get("Status") or "",
        "rg": fields.get("RG") or "",
        "data_admissao": fields.get("Data Admissão") or "",
        "data_nascimento": fields.get("Data Nascimento") or "",
        "data_fim_contrato": fields.get("Data Fim Contrato") or "",
        "margem_consignado": parse_money(fields.get("Margem Desconto Consignado:") or ""),
        "margem_cartao": parse_money(fields.get("Margem Cartão de Crédito:") or ""),
        "margem_cartao_beneficio": parse_money(fields.get("Margem Cartão Benefício:") or ""),
        "margem_acisesp": parse_money(fields.get("Margem ACISESP:") or ""),
    }


async def run(payload: dict[str, Any]) -> dict[str, Any]:
    action = str(payload.get("action") or "inspect")
    login_value = str(payload.get("login") or "")
    password = str(payload.get("password") or "")
    SESSION_DIR.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=str(os.getenv("SANTANA_HEADLESS") or "true").lower() != "false",
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        context_options: dict[str, Any] = {}
        if SESSION_FILE.exists():
            context_options["storage_state"] = str(SESSION_FILE)
        context = await browser.new_context(**context_options)
        page = await context.new_page()
        try:
            await login(page, login_value, password)
            await context.storage_state(path=str(SESSION_FILE))
            if action == "inspect":
                return {"ok": True, "page": await inspect_page(page)}
            if action == "inspect_server":
                await page.goto(
                    "https://santana.rf1consig.com.br/servidor/principal",
                    wait_until="domcontentloaded",
                    timeout=60_000,
                )
                await page.wait_for_timeout(2_000)
                return {"ok": True, "page": await inspect_page(page)}
            if action == "inspect_query":
                await page.goto(
                    "https://santana.rf1consig.com.br/servidor/principal",
                    wait_until="domcontentloaded",
                    timeout=60_000,
                )
                await page.wait_for_timeout(1_500)
                cpf = digits(payload.get("cpf")).zfill(11)
                await page.locator("input[name='_InputCpfOuMatricula.CpfOuMatricula']").fill(cpf)
                await page.get_by_role("button", name="Buscar", exact=True).click()
                await page.wait_for_timeout(3_000)
                return {"ok": True, "page": await inspect_page(page)}
            if action == "inspect_sample":
                await page.goto(
                    "https://santana.rf1consig.com.br/servidor/principal",
                    wait_until="domcontentloaded",
                    timeout=60_000,
                )
                await page.wait_for_timeout(1_500)
                attempts = []
                for raw_cpf in list(payload.get("cpfs") or [])[:10]:
                    cpf = digits(raw_cpf).zfill(11)
                    field = page.locator("input[name='_InputCpfOuMatricula.CpfOuMatricula']")
                    await field.fill(cpf)
                    await page.get_by_role("button", name="Buscar", exact=True).click()
                    await page.wait_for_timeout(2_000)
                    snapshot = await inspect_page(page)
                    body_text = str(snapshot.get("text") or "")
                    found = "servidor não encontrado" not in body_text.lower()
                    attempts.append({"cpf_suffix": cpf[-2:], "found": found})
                    if found:
                        return {"ok": True, "attempts": attempts, "page": snapshot}
                    close_button = page.get_by_role("button", name="Fechar", exact=True)
                    if await close_button.count():
                        await close_button.click()
                        await page.wait_for_timeout(400)
                return {"ok": True, "attempts": attempts, "page": await inspect_page(page)}
            if action == "query":
                await page.goto(
                    "https://santana.rf1consig.com.br/servidor/principal",
                    wait_until="domcontentloaded",
                    timeout=60_000,
                )
                await page.wait_for_timeout(1_000)
                return {"ok": True, "result": await search_server(page, str(payload.get("cpf") or ""))}
            if action == "batch":
                await page.goto(
                    "https://santana.rf1consig.com.br/servidor/principal",
                    wait_until="domcontentloaded",
                    timeout=60_000,
                )
                await page.wait_for_timeout(1_000)
                results = []
                unique_cpfs = list(dict.fromkeys(digits(item).zfill(11) for item in list(payload.get("cpfs") or []) if digits(item)))
                for index, cpf in enumerate(unique_cpfs):
                    try:
                        result = await search_server(page, cpf)
                    except Exception as exc:
                        result = {"status": "erro", "cpf": cpf, "message": str(exc)}
                        await page.goto(
                            "https://santana.rf1consig.com.br/servidor/principal",
                            wait_until="domcontentloaded",
                            timeout=60_000,
                        )
                    results.append(result)
                    print(
                        json.dumps(
                            {
                                "event": "progress",
                                "processed": index + 1,
                                "total": len(unique_cpfs),
                                "status": result.get("status"),
                            }
                        ),
                        file=sys.stderr,
                        flush=True,
                    )
                    if index < len(unique_cpfs) - 1:
                        await page.wait_for_timeout(int(payload.get("delay_ms") or 1200))
                return {"ok": True, "total": len(unique_cpfs), "results": results}
            return {"ok": False, "code": "INVALID_ACTION", "message": "Ação Santana não reconhecida."}
        finally:
            await context.close()
            await browser.close()


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw or "{}")
        emit(asyncio.run(run(payload)))
    except Exception as exc:
        emit({"ok": False, "code": "SANTANA_WORKER_ERROR", "message": str(exc)})
        raise SystemExit(1)


if __name__ == "__main__":
    main()
