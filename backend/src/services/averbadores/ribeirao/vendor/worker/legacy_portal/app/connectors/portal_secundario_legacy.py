from __future__ import annotations

import asyncio
import os
import re
import unicodedata
from datetime import datetime
from pathlib import Path

from playwright.async_api import async_playwright

from app.connectors.base import AverbadoraConnector
from app.core.config import Settings, get_settings
from app.services.margem_consulta import ConsultaResultado
from app.utils.cpf import mask_cpf
from app.utils.logger import get_logger
from app.utils.screenshots import save_evidence_pdf, save_evidence_screenshot


class PortalSecundarioLegacyConnector(AverbadoraConnector):
    """
    Conector para Portal Secundario com fluxo administrativo:
      1) Efetuar Login
      2) Aba Login Administrativo
      3) Perfil (Acessar)
      4) Menu Consulta de Margem
      5) Pesquisa por CPF e captura de margens
    """

    def __init__(self, lote_id: int, settings: Settings | None = None, credencial: dict | None = None):
        self.settings = settings or get_settings()
        self.logger = get_logger("connector-pdc")
        self.lote_id = lote_id
        self.credencial = credencial or {}
        cred_id = self.credencial.get("id")
        self.session_state_path: Path | None = None
        if cred_id:
            self.session_state_path = Path(self.settings.sessions_dir) / f"pdc_cred_{cred_id}.json"
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None
        self.is_ready = False

    @staticmethod
    def _selector_options(raw: str) -> list[str]:
        return [item.strip() for item in str(raw or "").split("||") if item.strip()]

    @staticmethod
    def _label_options(raw: str) -> list[str]:
        return [item.strip() for item in str(raw or "").split("||") if item.strip()]

    def _consulta_url(self) -> str:
        portal = str(self.settings.pdc_portal_url or "")
        if "Login.aspx" in portal:
            return portal.replace("/Login.aspx", "/Margem/ConsultaMargem.aspx")
        if "Inicial/Inicial.aspx" in portal:
            return portal.replace("/Inicial/Inicial.aspx", "/Margem/ConsultaMargem.aspx")
        if "ConsultaMargem.aspx" in portal:
            return portal
        return "https://saec.consiglog.com.br/Margem/ConsultaMargem.aspx"

    @staticmethod
    def _browser_launch_args() -> list[str]:
        return [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
        ]

    @staticmethod
    def _has_graphical_display() -> bool:
        return bool(os.getenv("DISPLAY") or os.getenv("WAYLAND_DISPLAY"))

    def _resolve_headless(self) -> bool:
        if str(os.getenv("NODE_ENV") or "").strip().lower() == "production":
            return True

        requested = bool(self.settings.headless)
        env_raw = os.getenv("RIBEIRAO_HEADLESS")
        if env_raw is not None and str(env_raw).strip():
            text = str(env_raw).strip().lower()
            if text in {"1", "true", "yes", "on"}:
                requested = True
            elif text in {"0", "false", "no", "off"}:
                requested = False
        if not requested and not self._has_graphical_display():
            return True
        return requested

    @staticmethod
    def _normalize_text(value: str) -> str:
        base = unicodedata.normalize("NFD", str(value or ""))
        without_marks = "".join(ch for ch in base if unicodedata.category(ch) != "Mn")
        return without_marks.upper()

    @staticmethod
    def _extract_money(section_text: str, product_patterns: list[str]) -> str | None:
        for product in product_patterns:
            pattern = rf"{product}\s+(-?\d{{1,3}}(?:\.\d{{3}})*,\d{{2}})"
            match = re.search(pattern, section_text, flags=re.IGNORECASE)
            if match:
                return match.group(1)
        return None

    @staticmethod
    def _normalize_money_text(value: str) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        text = re.sub(r"\s+", " ", text)
        match = re.search(r"-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}", text)
        return match.group(0) if match else text

    async def _extract_margin_table(self) -> dict:
        try:
            data = await self.page.evaluate(
                """() => {
                    const normalize = (value) => String(value || "")
                      .normalize("NFD")
                      .replace(/[\\u0300-\\u036f]/g, "")
                      .replace(/\\s+/g, " ")
                      .trim()
                      .toUpperCase();
                    const clean = (value) => String(value || "").replace(/\\s+/g, " ").trim();
                    const money = (value) => clean(value).match(/-?\\d{1,3}(?:\\.\\d{3})*,\\d{2}|-?\\d+,\\d{2}/)?.[0] || "";
                    const bodyText = normalize(document.body?.innerText || document.body?.textContent || "");
                    const notFound = /CPF\\/?MATRICULA NAO ENCONTRADO|CPF NAO ENCONTRADO|MATRICULA NAO ENCONTRADA/.test(bodyText);
                    const tables = Array.from(document.querySelectorAll("table"));
                    const rows = [];
                    let tableFound = false;

                    const mapHeader = (cells) => {
                      const headerMap = { service: 0, total: 1, reserved: 2, available: 3 };
                      cells.forEach((cell, index) => {
                        const normalized = normalize(cell);
                        if (normalized.includes("SERVICO")) headerMap.service = index;
                        if (normalized.includes("MARGEM TOTAL")) headerMap.total = index;
                        if (normalized.includes("MARGEM RESERVADA")) headerMap.reserved = index;
                        if (normalized.includes("MARGEM DISPONIVEL")) headerMap.available = index;
                      });
                      return headerMap;
                    };

                    for (const table of tables) {
                      const tableText = normalize(table.innerText || table.textContent || "");
                      if (!tableText.includes("DETALHES DA MARGEM")) continue;
                      tableFound = true;

                      const tableRows = Array.from(table.querySelectorAll("tr"))
                        .map((row) =>
                          Array.from(row.querySelectorAll("th,td"))
                            .map((cell) => clean(cell.innerText || cell.textContent || ""))
                            .filter((cell) => cell !== "")
                        )
                        .filter((cells) => cells.length);

                      if (!tableRows.length) {
                        continue;
                      }

                      let headerIndex = tableRows.findIndex((cells) => {
                        const normalizedCells = cells.map(normalize);
                        return (
                          normalizedCells.some((cell) => cell.includes("SERVICO")) &&
                          normalizedCells.some((cell) => cell.includes("MARGEM TOTAL")) &&
                          normalizedCells.some((cell) => cell.includes("MARGEM DISPONIVEL"))
                        );
                      });

                      if (headerIndex < 0) {
                        headerIndex = 0;
                      }

                      const headerMap = mapHeader(tableRows[headerIndex] || []);
                      for (let index = headerIndex + 1; index < tableRows.length; index += 1) {
                        const cells = tableRows[index];
                        const normalizedCells = cells.map(normalize);
                        const service = cells[headerMap.service] || cells[0] || "";
                        const normalizedService = normalize(service);
                        if (!normalizedService.includes("MARGEM")) continue;

                        rows.push({
                          service,
                          total: money(cells[headerMap.total] || cells[1] || ""),
                          reserved: money(cells[headerMap.reserved] || cells[2] || ""),
                          available: money(cells[headerMap.available] || cells[3] || cells[cells.length - 1] || ""),
                          raw_cells: cells,
                          raw_normalized_cells: normalizedCells,
                        });
                      }

                      if (rows.length) {
                        break;
                      }
                    }

                    return { notFound, tableFound, rows, bodyText };
                }"""
            )
            return data if isinstance(data, dict) else {"notFound": False, "tableFound": False, "rows": [], "bodyText": ""}
        except Exception:
            return {"notFound": False, "tableFound": False, "rows": [], "bodyText": ""}

    @classmethod
    def _slice_between(cls, normalized_text: str, start_marker: str, end_markers: list[str]) -> str:
        text = normalized_text or ""
        start = text.find(cls._normalize_text(start_marker))
        if start < 0:
            return ""

        end_pos = len(text)
        for marker in end_markers:
            pos = text.find(cls._normalize_text(marker), start + 1)
            if pos > start and pos < end_pos:
                end_pos = pos
        return text[start:end_pos]

    async def _fill_any(self, raw_selector: str, value: str) -> bool:
        for selector in self._selector_options(raw_selector):
            try:
                locator = self.page.locator(selector).first
                await locator.wait_for(state="visible", timeout=2400)
                await locator.fill("")
                await locator.fill(value, timeout=2800)
                return True
            except Exception:
                continue
        return False

    async def _type_any(self, raw_selector: str, value: str, delay_ms: int = 55) -> bool:
        for selector in self._selector_options(raw_selector):
            try:
                locator = self.page.locator(selector).first
                await locator.wait_for(state="visible", timeout=2400)
                await locator.click(timeout=2600)
                try:
                    await locator.press("Control+A", timeout=600)
                    await locator.press("Backspace", timeout=600)
                except Exception:
                    pass
                await locator.fill("")
                await locator.type(str(value or ""), delay=max(20, int(delay_ms)))
                await locator.blur()
                return True
            except Exception:
                continue
        return False

    async def _fill_input_by_label(self, labels: list[str], value: str, *, password: bool = False) -> bool:
        try:
            ok = await self.page.evaluate(
                """({ labels, value, password }) => {
                    const normalize = (v) =>
                      String(v || "")
                        .normalize("NFD")
                        .replace(/[\\u0300-\\u036f]/g, "")
                        .toLowerCase()
                        .trim();
                    const wanted = (labels || []).map(normalize).filter(Boolean);
                    const nodes = Array.from(document.querySelectorAll("label,span,strong,div,td,th,p,li"));
                    const isVisible = (el) => {
                      if (!el) return false;
                      const style = window.getComputedStyle(el);
                      return style && style.visibility !== "hidden" && style.display !== "none";
                    };
                    const setValue = (input) => {
                      input.focus();
                      input.value = "";
                      input.value = String(value || "");
                      input.dispatchEvent(new Event("input", { bubbles: true }));
                      input.dispatchEvent(new Event("change", { bubbles: true }));
                    };

                    for (const node of nodes) {
                      const txt = normalize(node.textContent || "");
                      if (!txt || !wanted.some((w) => txt.includes(w))) continue;
                      const scope = node.closest("div,fieldset,section,article,tr,td,form,table") || document.body;
                      const selector = password
                        ? "input[type='password']"
                        : "input[name*='cpf' i], input[id*='cpf' i], input[type='text'], input:not([type])";
                      const inputs = Array.from(scope.querySelectorAll(selector));
                      for (const input of inputs) {
                        if (!(input instanceof HTMLInputElement)) continue;
                        if (!isVisible(input)) continue;
                        if (password && input.type !== "password") continue;
                        if (!password && input.type === "password") continue;
                        setValue(input);
                        if ((input.value || "").trim().length > 0) return true;
                      }
                    }
                    return false;
                }""",
                {"labels": labels, "value": value, "password": password},
            )
            return bool(ok)
        except Exception:
            return False

    async def _has_login_user_value(self) -> bool:
        try:
            has_value = await self.page.evaluate(
                """() => {
                    const normalize = (v) =>
                      String(v || "")
                        .normalize("NFD")
                        .replace(/[\\u0300-\\u036f]/g, "")
                        .toLowerCase()
                        .trim();
                    const isVisible = (el) => {
                      if (!el) return false;
                      const style = window.getComputedStyle(el);
                      return style && style.visibility !== "hidden" && style.display !== "none";
                    };
                    const candidates = Array.from(
                      document.querySelectorAll("input[name*='cpf' i], input[id*='cpf' i], input[type='text'], input:not([type])")
                    );
                    for (const input of candidates) {
                      if (!(input instanceof HTMLInputElement)) continue;
                      if (!isVisible(input)) continue;
                      const scope = input.closest("div,fieldset,section,article,tr,td,form,table") || document.body;
                      const txt = normalize(scope.textContent || "");
                      if (!txt.includes("cpf")) continue;
                      if ((input.value || "").trim().length >= 3) return true;
                    }
                    return false;
                }"""
            )
            return bool(has_value)
        except Exception:
            return False

    @staticmethod
    def _format_cpf(cpf: str) -> str:
        digits = re.sub(r"\\D+", "", str(cpf or ""))
        if len(digits) != 11:
            return str(cpf or "")
        return f"{digits[0:3]}.{digits[3:6]}.{digits[6:9]}-{digits[9:11]}"

    async def _fill_login_user(self, user: str) -> bool:
        raw = str(user or "").strip()
        digits = re.sub(r"\\D+", "", raw)
        values = [raw]
        if len(digits) == 11:
            values.append(digits)
            values.append(self._format_cpf(digits))

        tried: set[str] = set()
        for value in values:
            if not value or value in tried:
                continue
            tried.add(value)
            if await self._fill_any(self.settings.pdc_selector_login_user, value):
                return True
            try:
                ok = await self.page.evaluate(
                    """(value) => {
                        const selectors = [
                          "#txtLogin",
                          "#username",
                          "#txtCPF",
                          "input[name='txtLogin']",
                          "input[name='username']",
                          "input[name='cpf']",
                          "input[name='login']",
                          "input[name='usuario']",
                          "#cpf",
                          "#login",
                          "#usuario",
                          "input[type='text']",
                        ];
                        const isVisible = (el) => {
                          if (!el) return false;
                          const style = window.getComputedStyle(el);
                          if (!style) return false;
                          const rect = el.getBoundingClientRect();
                          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
                        };
                        const setValue = (input) => {
                          if (!input) return false;
                          input.focus();
                          input.value = "";
                          input.dispatchEvent(new Event("input", { bubbles: true }));
                          input.value = String(value || "");
                          input.dispatchEvent(new Event("input", { bubbles: true }));
                          input.dispatchEvent(new Event("change", { bubbles: true }));
                          return String(input.value || "").trim().length > 0;
                        };
                        for (const selector of selectors) {
                          const input = Array.from(document.querySelectorAll(selector)).find((el) => el instanceof HTMLInputElement && isVisible(el) && !el.disabled && !el.readOnly);
                          if (input && setValue(input)) {
                            return true;
                          }
                        }
                        return false;
                    }""",
                    value,
                )
                if ok:
                    return True
            except Exception:
                pass
            if await self._fill_input_by_label(["cpf"], value, password=False):
                return True
        return False

    async def _fill_login_password(self, password: str) -> bool:
        value = str(password or "")
        ok = await self._fill_any(self.settings.pdc_selector_login_password, value)
        if ok:
            return True
        try:
            ok = await self.page.evaluate(
                """(value) => {
                    const selectors = [
                      "#txtSenha",
                      "#password",
                      "input[name='senha']",
                      "input[type='password']",
                    ];
                    const isVisible = (el) => {
                      if (!el) return false;
                      const style = window.getComputedStyle(el);
                      if (!style) return false;
                      const rect = el.getBoundingClientRect();
                      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
                    };
                    const setValue = (input) => {
                      if (!input) return false;
                      input.focus();
                      input.value = "";
                      input.dispatchEvent(new Event("input", { bubbles: true }));
                      input.value = String(value || "");
                      input.dispatchEvent(new Event("input", { bubbles: true }));
                      input.dispatchEvent(new Event("change", { bubbles: true }));
                      return String(input.value || "").trim().length > 0;
                    };
                    for (const selector of selectors) {
                      const input = Array.from(document.querySelectorAll(selector)).find((el) => el instanceof HTMLInputElement && isVisible(el) && !el.disabled && !el.readOnly);
                      if (input && setValue(input)) {
                        return true;
                      }
                    }
                    return false;
                }""",
                value,
            )
            if ok:
                return True
        except Exception:
            pass
        return await self._fill_input_by_label(["senha", "password"], value, password=True)

    async def _fill_cpf_servidor(self, cpf: str) -> bool:
        if await self._fill_any(self.settings.pdc_selector_cpf_input, cpf):
            return True

        try:
            ok = await self.page.evaluate(
                """(cpfValue) => {
                    const normalize = (v) => String(v || "")
                      .normalize("NFD")
                      .replace(/[\u0300-\u036f]/g, "")
                      .toLowerCase()
                      .trim();

                    const labels = Array.from(document.querySelectorAll("label, span, strong, td, div"));
                    for (const label of labels) {
                      const t = normalize(label.textContent || "");
                      if (!t.includes("cpf do servidor") && t !== "cpf" && !t.startsWith("cpf ")) continue;
                      const scope = label.closest("div,fieldset,section,article,tr,td,form") || document.body;
                      const input =
                        scope.querySelector("input[name*='cpf' i]") ||
                        scope.querySelector("input[id*='cpf' i]") ||
                        scope.querySelector("input[type='text']");
                      if (!input) continue;
                      input.focus();
                      input.value = cpfValue;
                      input.dispatchEvent(new Event("input", { bubbles: true }));
                      input.dispatchEvent(new Event("change", { bubbles: true }));
                      return true;
                    }
                    return false;
                }""",
                cpf,
            )
            return bool(ok)
        except Exception:
            return False

    async def _click_any(self, raw_selector: str) -> bool:
        for selector in self._selector_options(raw_selector):
            try:
                locator = self.page.locator(selector).first
                await locator.wait_for(state="visible", timeout=2200)
                await locator.click(timeout=2600)
                return True
            except Exception:
                continue
        return False

    async def _is_login_submit_disabled(self) -> bool | None:
        selectors = self._selector_options(self.settings.pdc_selector_login_submit)
        try:
            result = await self.page.evaluate(
                """(selectors) => {
                    const isVisible = (el) => {
                      if (!el) return false;
                      const style = window.getComputedStyle(el);
                      if (!style) return false;
                      const rect = el.getBoundingClientRect();
                      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
                    };
                    for (const selector of selectors || []) {
                      const nodes = Array.from(document.querySelectorAll(selector || ""));
                      for (const node of nodes) {
                        if (!isVisible(node)) continue;
                        if (node instanceof HTMLInputElement || node instanceof HTMLButtonElement) {
                          return !!node.disabled;
                        }
                        return false;
                      }
                    }
                    return null;
                }""",
                selectors,
            )
            if result is None:
                return None
            return bool(result)
        except Exception:
            return None

    async def _click_login_submit(self) -> bool:
        if await self._click_any(self.settings.pdc_selector_login_submit):
            return True
        selectors = self._selector_options(self.settings.pdc_selector_login_submit)
        try:
            clicked = await self.page.evaluate(
                """(selectors) => {
                    const normalize = (v) => String(v || "").toLowerCase();
                    const isVisible = (el) => {
                      if (!el) return false;
                      const style = window.getComputedStyle(el);
                      if (!style) return false;
                      const rect = el.getBoundingClientRect();
                      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
                    };
                    const canClick = (el) => {
                      if (!el) return false;
                      if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) {
                        return !el.disabled;
                      }
                      return true;
                    };
                    for (const selector of selectors || []) {
                      const nodes = Array.from(document.querySelectorAll(selector || ""));
                      for (const node of nodes) {
                        if (!isVisible(node) || !canClick(node)) continue;
                        if (typeof node.click === "function") {
                          node.click();
                          return true;
                        }
                      }
                    }
                    const generic = Array.from(document.querySelectorAll("button,input[type='submit'],input[type='button']"));
                    for (const node of generic) {
                      if (!isVisible(node) || !canClick(node)) continue;
                      const txt = normalize((node.textContent || node.value || node.getAttribute("title") || ""));
                      if (!(txt.includes("acessar") || txt.includes("login") || txt.includes("entrar"))) continue;
                      node.click();
                      return true;
                    }
                    return false;
                }""",
                selectors,
            )
            return bool(clicked)
        except Exception:
            return False

    async def _wait_any(self, raw_selector: str, timeout_ms: int) -> bool:
        deadline = asyncio.get_running_loop().time() + max(500, timeout_ms) / 1000
        selectors = self._selector_options(raw_selector)
        while asyncio.get_running_loop().time() < deadline:
            for selector in selectors:
                try:
                    await self.page.locator(selector).first.wait_for(state="visible", timeout=1000)
                    return True
                except Exception:
                    continue
            await self.page.wait_for_timeout(120)
        return False

    async def _extract_value_by_labels(self, labels: list[str]) -> str | None:
        try:
            value = await self.page.evaluate(
                """(labels) => {
                    const normalize = (v) =>
                      String(v || "")
                        .normalize("NFD")
                        .replace(/[\u0300-\u036f]/g, "")
                        .toLowerCase()
                        .trim();
                    const isMoney = (raw) => {
                      const t = String(raw || "").replace(/\s+/g, " ").trim();
                      if (!t || t.length > 40) return false;
                      if (/r\$\s*-?\d/i.test(t)) return true;
                      if (/^-?\d{1,3}(\.\d{3})*,\d{2}$/.test(t)) return true;
                      if (/^-?\d+,\d{2}$/.test(t)) return true;
                      return false;
                    };
                    const wanted = labels.map(normalize).filter(Boolean);
                    const nodes = Array.from(document.querySelectorAll("body *"));
                    for (const node of nodes) {
                      const txt = normalize(node.textContent || "");
                      if (!txt || txt.length > 220) continue;
                      if (!wanted.some((w) => txt === w || txt.includes(w))) continue;
                      const scope = node.closest("div,section,article,fieldset,tr,td,li") || node.parentElement;
                      if (!scope) continue;
                      const values = Array.from(scope.querySelectorAll("input,textarea,select,.value,.valor,[data-value],span,strong"));
                      for (const v of values) {
                        const raw =
                          v instanceof HTMLInputElement || v instanceof HTMLTextAreaElement || v instanceof HTMLSelectElement
                            ? String(v.value || "").trim()
                            : String(v.textContent || "").trim();
                        if (isMoney(raw)) return raw;
                      }
                    }
                    return "";
                }""",
                labels,
            )
            value = (value or "").strip()
            return value or None
        except Exception:
            return None

    async def _extract_value_by_raw_labels(self, raw_labels: str) -> str | None:
        labels = self._label_options(raw_labels)
        return await self._extract_value_by_labels(labels)

    async def _extract_margens_from_text(self) -> dict[str, str]:
        result = {
            "nome": "",
            "bruta_facultativa": "",
            "bruta_cartao": "",
            "bruta_cartao_beneficio": "",
            "disp_facultativa": "",
            "disp_cartao": "",
            "disp_cartao_beneficio": "",
        }
        try:
            raw_text = await self.page.inner_text("body")
        except Exception:
            raw_text = ""

        if not raw_text:
            return result

        nome_match = re.search(r"Nome\s*-\s*([^\n\r]+)", raw_text, flags=re.IGNORECASE)
        if nome_match:
            result["nome"] = nome_match.group(1).strip()

        normalized = self._normalize_text(raw_text)
        bruta = self._slice_between(
            normalized,
            "MARGEM BRUTA",
            ["MARGEM DISPONIVEL", "MARGEM DISPONIVEL - TOTAL", "MARGEM DISPONIVEL TOTAL"],
        )
        disponivel = self._slice_between(
            normalized,
            "MARGEM DISPONIVEL",
            ["IMPRIMIR", "VOLTAR", "DADOS FUNCIONAIS"],
        )

        result["bruta_facultativa"] = self._extract_money(bruta, [r"CONSIGNACOES\s+FACULTATIVAS"]) or ""
        result["bruta_cartao"] = self._extract_money(bruta, [r"CARTAO\s+DE\s+CREDITO", r"CARTAO\s+CREDITO"]) or ""
        result["bruta_cartao_beneficio"] = (
            self._extract_money(bruta, [r"CARTAO\s+DE\s+BENEFICIO", r"CARTAO\s+BENEFICIO"]) or ""
        )
        result["disp_facultativa"] = self._extract_money(disponivel, [r"CONSIGNACOES\s+FACULTATIVAS"]) or ""
        result["disp_cartao"] = (
            self._extract_money(disponivel, [r"CARTAO\s+DE\s+CREDITO", r"CARTAO\s+CREDITO"]) or ""
        )
        result["disp_cartao_beneficio"] = (
            self._extract_money(disponivel, [r"CARTAO\s+DE\s+BENEFICIO", r"CARTAO\s+BENEFICIO"]) or ""
        )
        return result

    async def _select_orgao_governo_sp(self) -> None:
        orgao_target = (self.settings.pdc_orgao_nome or "").strip()
        if not orgao_target:
            return

        selectors = self._selector_options(self.settings.pdc_selector_orgao_input)
        for selector in selectors:
            try:
                ok = await self.page.evaluate(
                    """({ selector, target }) => {
                        const normalize = (v) =>
                          String(v || "")
                            .normalize("NFD")
                            .replace(/[\u0300-\u036f]/g, "")
                            .toLowerCase()
                            .trim();
                        const el = document.querySelector(selector);
                        if (!el) return false;
                        const wanted = normalize(target);
                        if (!wanted) return false;

                        if (el.tagName.toLowerCase() === "select") {
                          const options = Array.from(el.querySelectorAll("option"));
                          const match = options.find((o) => normalize(o.textContent || o.value || "").includes(wanted));
                          if (!match) return false;
                          el.value = match.value;
                          el.dispatchEvent(new Event("change", { bubbles: true }));
                          el.dispatchEvent(new Event("input", { bubbles: true }));
                          return true;
                        }

                        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
                          el.focus();
                          el.value = target;
                          el.dispatchEvent(new Event("input", { bubbles: true }));
                          el.dispatchEvent(new Event("change", { bubbles: true }));
                          return true;
                        }
                        return false;
                    }""",
                    {"selector": selector, "target": orgao_target},
                )
                if ok:
                    await self.page.wait_for_timeout(450)
                    return
            except Exception:
                continue

    async def _open_login_entry(self) -> None:
        clicked = await self._click_any(self.settings.pdc_selector_login_entry)
        if clicked:
            await self.page.wait_for_timeout(900)
            return
        try:
            clicked_js = await self.page.evaluate(
                """() => {
                    const normalize = (v) => String(v || "").toLowerCase();
                    const controls = Array.from(document.querySelectorAll("button,input[type='button'],input[type='submit'],a"));
                    for (const c of controls) {
                      const txt = normalize(c.textContent || c.value || c.getAttribute("title") || "");
                      if (!txt.includes("efetuar login")) continue;
                      c.click();
                      return true;
                    }
                    return false;
                }"""
            )
            if clicked_js:
                await self.page.wait_for_timeout(900)
        except Exception:
            pass

    async def _open_login_administrativo(self) -> None:
        clicked = await self._click_any(self.settings.pdc_selector_login_administrativo)
        if clicked:
            await self.page.wait_for_timeout(700)
            return
        try:
            clicked_js = await self.page.evaluate(
                """() => {
                    const normalize = (v) => String(v || "").toLowerCase();
                    const controls = Array.from(document.querySelectorAll("a,button,li,span,div"));
                    for (const c of controls) {
                      const txt = normalize(c.textContent || "");
                      if (!txt.includes("login administrativo")) continue;
                      if (typeof c.click === "function") {
                        c.click();
                        return true;
                      }
                    }
                    return false;
                }"""
            )
            if clicked_js:
                await self.page.wait_for_timeout(700)
        except Exception:
            pass

    async def _select_profile_access(self) -> None:
        shown = await self._wait_any(self.settings.pdc_selector_profile_access_button, 2200)
        if not shown:
            return

        # Tenta marcar perfil alinhado ao orgao alvo antes de acessar.
        target = (self.settings.pdc_orgao_nome or "").strip().lower()
        if target:
            try:
                await self.page.evaluate(
                    """(target) => {
                        const normalize = (v) => String(v || "")
                          .normalize("NFD")
                          .replace(/[\u0300-\u036f]/g, "")
                          .toLowerCase();
                        const rows = Array.from(document.querySelectorAll("div, fieldset, section, tr"));
                        for (const row of rows) {
                          const txt = normalize(row.textContent || "");
                          if (!txt.includes(target)) continue;
                          const radio = row.querySelector("input[type='radio']");
                          if (radio) {
                            radio.click();
                            radio.dispatchEvent(new Event("change", { bubbles: true }));
                            return true;
                          }
                        }
                        return false;
                    }""",
                    target,
                )
            except Exception:
                pass

        clicked = await self._click_any(self.settings.pdc_selector_profile_access_button)
        if clicked:
            await self.page.wait_for_timeout(1100)

    async def _open_consulta_margem(self) -> None:
        # Em algumas telas o menu precisa de 2 cliques (expandir + entrar).
        clicked_once = await self._click_any(self.settings.pdc_selector_menu_consulta_margem)
        if clicked_once:
            await self.page.wait_for_timeout(350)
        try:
            clicked = await self.page.evaluate(
                """() => {
                    const normalize = (v) => String(v || "").normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().trim();
                    const candidates = Array.from(document.querySelectorAll("a,button,span,div,li"));
                    for (const node of candidates) {
                      const txt = normalize(`${node.textContent || ""} ${node.getAttribute("title") || ""} ${node.id || ""}`);
                      if (!txt.includes("consultar margem")) continue;
                      if (typeof node.click === "function") {
                        node.click();
                        return true;
                      }
                    }
                    return false;
                }"""
            )
            if not clicked:
                await self._click_any(self.settings.pdc_selector_menu_consulta_margem)
        except Exception:
            await self._click_any(self.settings.pdc_selector_menu_consulta_margem)
        await self.page.wait_for_timeout(700)
        try:
            await self.page.goto(self._consulta_url(), wait_until="domcontentloaded", timeout=max(self.settings.timeout_ms, 45000))
            await self.page.wait_for_timeout(700)
        except Exception:
            pass

    async def _prepare_consulta_context(self) -> None:
        if await self._wait_any(self.settings.pdc_selector_cpf_input, 1200):
            await self._select_orgao_governo_sp()
            return

        await self._open_consulta_margem()
        await self._select_orgao_governo_sp()
        ok = await self._wait_any(self.settings.pdc_selector_cpf_input, 8000)
        if not ok:
            try:
                await self.page.goto(self._consulta_url(), wait_until="domcontentloaded", timeout=max(self.settings.timeout_ms, 45000))
                await self.page.wait_for_timeout(800)
                ok = await self._wait_any(self.settings.pdc_selector_cpf_input, 8000)
            except Exception:
                ok = False
        if not ok:
            raise RuntimeError("Nao encontrei campo CPF do servidor na tela de consulta.")

    async def _is_login_screen(self) -> bool:
        url = (self.page.url or "").lower()
        if "naoautorizado" in url:
            return True
        if "/home?4" in url or "/home?1" in url:
            return True
        return await self._wait_any(
            f"{self.settings.pdc_selector_login_user} || {self.settings.pdc_selector_login_password}",
            900,
        )

    async def _ensure_consulta_ready(self) -> None:
        if await self._wait_any(self.settings.pdc_selector_cpf_input, 900):
            return
        if await self._is_login_screen():
            raise RuntimeError(
                "Sessao do portal voltou para login e exige nova autenticacao manual. "
                "Reinicie o lote apos autenticar novamente."
            )
        await self._prepare_consulta_context()
        if await self._wait_any(self.settings.pdc_selector_cpf_input, 1200):
            return
        if await self._is_login_screen():
            raise RuntimeError(
                "Sessao expirou e retornou para a tela de login administrativo."
            )
        raise RuntimeError("Nao consegui retornar para a tela de consulta de margem.")

    async def _ensure_logged_in(self) -> None:
        if not self.session_state_path or not self.session_state_path.exists():
            raise RuntimeError(
                "Sessao manual nao encontrada para esta credencial. "
                "Use o login manual assistido, preencha o captcha e tente novamente."
            )

        await self.page.goto(
            self.settings.pdc_portal_url,
            wait_until="domcontentloaded",
            timeout=max(self.settings.timeout_ms, 45000),
        )
        await self.page.wait_for_timeout(850)

        if await self._wait_any(self.settings.pdc_selector_cpf_input, 1200):
            await self._prepare_consulta_context()
            return

        await self._open_consulta_margem()
        if await self._wait_any(self.settings.pdc_selector_cpf_input, 1200):
            await self._prepare_consulta_context()
            return

        try:
            await self.page.goto(self._consulta_url(), wait_until="domcontentloaded", timeout=max(self.settings.timeout_ms, 45000))
            await self.page.wait_for_timeout(800)
        except Exception:
            pass
        if await self._wait_any(self.settings.pdc_selector_cpf_input, 1200):
            await self._prepare_consulta_context()
            return

        if await self._is_login_screen() or await self._wait_any(self.settings.pdc_selector_captcha_input, 900):
            try:
                await save_evidence_screenshot(self.page, self.lote_id, "startup", "sessao_expirada")
            except Exception:
                pass
            raise RuntimeError(
                "Sessao expirada no Portal Secundario. "
                "Faca novo login manual assistido novamente."
            )

        try:
            await save_evidence_screenshot(self.page, self.lote_id, "startup", "sessao_invalida")
        except Exception:
            pass
        raise RuntimeError(
            "Nao foi possivel validar a sessao manual para consulta. "
            "Inicie novo login manual assistido."
        )

    async def start(self) -> None:
        self.logger.info("Iniciando sessao do conector Portal Secundario")
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.launch(
            headless=self._resolve_headless(),
            args=self._browser_launch_args(),
        )
        if self.session_state_path and self.session_state_path.exists():
            self.context = await self.browser.new_context(storage_state=str(self.session_state_path))
        else:
            self.context = await self.browser.new_context()
        self.page = await self.context.new_page()
        await self._ensure_logged_in()
        self.is_ready = True

    async def close(self) -> None:
        if self.context:
            await self.context.close()
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()
        self.context = None
        self.browser = None
        self.playwright = None
        self.page = None
        self.is_ready = False

    async def _consultar_uma_vez(self, cpf: str) -> ConsultaResultado:
        if not self.is_ready:
            await self.start()

        await self._ensure_consulta_ready()

        filled = await self._fill_cpf_servidor(cpf)
        if not filled:
            raise RuntimeError("Nao encontrei campo CPF do servidor para pesquisa.")

        clicked_search = await self._click_any(self.settings.pdc_selector_search_submit)
        if not clicked_search:
            try:
                await self.page.keyboard.press("Enter")
                clicked_search = True
            except Exception:
                clicked_search = False
        if not clicked_search:
            raise RuntimeError("Nao consegui acionar a pesquisa do CPF.")

        await self.page.wait_for_timeout(self.settings.intervalo_entre_consultas_ms)
        await self._wait_any(self.settings.pdc_selector_result_ready, max(7000, self.settings.timeout_ms // 2))

        extracted_table = await self._extract_margin_table()
        if extracted_table.get("notFound"):
            raise RuntimeError("CPF_NOT_FOUND: CPF/Matricula nao encontrado.")

        table_rows = extracted_table.get("rows") or []
        table_found = bool(extracted_table.get("tableFound"))

        emprestimo_total = ""
        emprestimo_disponivel = ""
        cartao_total = ""
        cartao_disponivel = ""
        margem_rows = []

        for row in table_rows:
            service = self._normalize_text(row.get("service") or "")
            total = self._normalize_money_text(row.get("total") or "")
            reserved = self._normalize_money_text(row.get("reserved") or "")
            available = self._normalize_money_text(row.get("available") or "")
            if not service:
                continue

            margem_rows.append(
                {
                    "service": row.get("service") or "",
                    "total": total,
                    "reserved": reserved,
                    "available": available,
                }
            )

            if "EMPRESTIMO" in service:
                emprestimo_total = emprestimo_total or total
                emprestimo_disponivel = emprestimo_disponivel or available
            elif "CARTAO" in service:
                cartao_total = cartao_total or total
                cartao_disponivel = cartao_disponivel or available

        if not margem_rows and not table_found:
            fallback = await self._extract_margens_from_text()
            emprestimo_total = fallback.get("bruta_facultativa") or ""
            emprestimo_disponivel = fallback.get("disp_facultativa") or ""
            cartao_total = fallback.get("bruta_cartao") or fallback.get("bruta_cartao_beneficio") or ""
            cartao_disponivel = fallback.get("disp_cartao") or fallback.get("disp_cartao_beneficio") or ""
            if emprestimo_total or emprestimo_disponivel or cartao_total or cartao_disponivel:
                margem_rows = [
                    {
                        "service": "MARGEM EMPRESTIMO",
                        "total": emprestimo_total,
                        "reserved": "",
                        "available": emprestimo_disponivel,
                    },
                    {
                        "service": "MARGEM CARTAO",
                        "total": cartao_total,
                        "reserved": "",
                        "available": cartao_disponivel,
                    },
                ]

        if not margem_rows:
            raise RuntimeError("MARGIN_ROWS_NOT_FOUND: Nao encontrei linhas de margem na tela de detalhes.")

        has_positive_margin = any(
            any(
                (value := item.get(key)) and re.search(r"\d", str(value))
                and (number := float(str(value).replace("R$", "").replace(".", "").replace(",", ".").replace(" ", ""))) > 0
                for key in ("total", "available")
            )
            for item in margem_rows
        )
        has_any_value = any(
            bool(item.get("total")) or bool(item.get("available")) for item in margem_rows
        )

        # Se a tabela veio preenchida, mesmo com zeros, isso é sucesso com/s sem margem.
        if not has_any_value:
            raise RuntimeError("PARSE_MARGIN_ERROR: Encontrei a tabela, mas nao consegui extrair os valores de margem.")

        evidencia_png = None
        if self.settings.capture_screenshot_on_success:
            evidencia_png = await save_evidence_screenshot(self.page, self.lote_id, cpf, "sucesso")
        if self.settings.capture_pdf:
            await save_evidence_pdf(self.page, self.lote_id, cpf, "sucesso")

        return ConsultaResultado(
            status="sucesso" if has_positive_margin else "sem_marg",
            margem_disponivel=emprestimo_disponivel,
            margem_cartao=cartao_disponivel,
            margem_cartao_beneficio="",
            payload_extra={
                "nome_portal": "",
                "margem_emprestimo_total": emprestimo_total or "",
                "margem_emprestimo_disponivel": emprestimo_disponivel or "",
                "margem_cartao_total": cartao_total or "",
                "margem_cartao_disponivel": cartao_disponivel or "",
                "margem_bruta": emprestimo_total or "",
                "facultativa_margem_consignavel": emprestimo_total or "",
                "facultativa_disponivel": emprestimo_disponivel or "",
                "cartao_margem_consignavel": cartao_total or "",
                "cartao_disponivel": cartao_disponivel or "",
                "cartao_beneficio_margem_consignavel": "",
                "cartao_beneficio_disponivel": "",
                "detalhes_margem": {
                    "rows": margem_rows,
                    "table_found": table_found,
                },
            },
            evidencia_path=evidencia_png,
            consultado_em=datetime.utcnow(),
        )

    async def consultar_cliente(self, cpf: str) -> ConsultaResultado:
        tentativas = max(1, self.settings.retry_attempts)
        last_error = None
        masked_cpf = mask_cpf(cpf) if self.settings.mascarar_cpf_logs else cpf

        for attempt in range(1, tentativas + 1):
            try:
                result = await self._consultar_uma_vez(cpf)
                result.tentativas = attempt
                self.logger.info(
                    "Consulta concluida no Portal Secundario | cpf=%s | tentativas=%s",
                    masked_cpf,
                    attempt,
                )
                return result
            except Exception as exc:
                last_error = str(exc)
                self.logger.warning(
                    "Falha no Portal Secundario | cpf=%s | tentativa=%s/%s | erro=%s",
                    masked_cpf,
                    attempt,
                    tentativas,
                    last_error,
                )
                if attempt < tentativas:
                    await asyncio.sleep(1.0)

        evidencia_erro = None
        try:
            evidencia_erro = await save_evidence_screenshot(self.page, self.lote_id, cpf, "erro")
            if self.settings.capture_pdf:
                await save_evidence_pdf(self.page, self.lote_id, cpf, "erro")
        except Exception:
            evidencia_erro = None

        return ConsultaResultado(
            status="erro",
            detalhe_erro=last_error or "Erro desconhecido no Portal Secundario",
            evidencia_path=evidencia_erro,
            consultado_em=datetime.utcnow(),
            tentativas=tentativas,
        )

