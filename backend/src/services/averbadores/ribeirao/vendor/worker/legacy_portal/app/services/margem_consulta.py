import asyncio
from dataclasses import dataclass
from datetime import datetime

from playwright.async_api import async_playwright

from app.core.config import Settings, get_settings
from app.services.portal_padrao_service import coletar_detalhes_portal_padrao
from app.services.portal_login import login_portal
from app.utils.cpf import mask_cpf
from app.utils.logger import get_logger
from app.utils.screenshots import save_evidence_pdf, save_evidence_screenshot


@dataclass
class ConsultaResultado:
    status: str
    margem_disponivel: str | None = None
    margem_cartao: str | None = None
    margem_cartao_beneficio: str | None = None
    detalhe_erro: str | None = None
    evidencia_path: str | None = None
    payload_extra: dict | None = None
    consultado_em: datetime | None = None
    tentativas: int = 0


class MargemConsultaService:
    def __init__(self, lote_id: int, settings: Settings | None = None):
        self.settings = settings or get_settings()
        self.logger = get_logger("motor-automacao")
        self.lote_id = lote_id
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None
        self.is_ready = False

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
        os_module = __import__("os")
        return bool(os_module.getenv("DISPLAY") or os_module.getenv("WAYLAND_DISPLAY"))

    def _resolve_headless(self) -> bool:
        os_module = __import__("os")
        if str(os_module.getenv("NODE_ENV") or "").strip().lower() == "production":
            return True

        requested = bool(self.settings.headless)
        env_raw = os_module.getenv("RIBEIRAO_HEADLESS")
        if env_raw is not None and str(env_raw).strip():
            text = str(env_raw).strip().lower()
            if text in {"1", "true", "yes", "on"}:
                requested = True
            elif text in {"0", "false", "no", "off"}:
                requested = False
        if not requested and not self._has_graphical_display():
            return True
        return requested

    def _log_playwright_diagnostics(self, stage: str) -> None:
        executable_path = ""
        try:
            executable_path = str(getattr(getattr(self.playwright, "chromium", None), "executable_path", "") or "")
        except Exception:
            executable_path = ""
        print(f"[PLAYWRIGHT] stage: {stage}", file=sys.stderr, flush=True)
        print(f"[PLAYWRIGHT] executablePath: {executable_path}", file=sys.stderr, flush=True)
        print(f"[PLAYWRIGHT] headless efetivo: {self._resolve_headless()}", file=sys.stderr, flush=True)

    @staticmethod
    def _is_transient_navigation_error(error_text: str) -> bool:
        text = (error_text or "").lower()
        markers = [
            "chrome-error://chromewebdata",
            "net::err",
            "navigation failed",
            "target page, context or browser has been closed",
            "execution context was destroyed",
            "page crashed",
            "timeout",
        ]
        return any(marker in text for marker in markers)

    @staticmethod
    def _selector_options(raw: str) -> list[str]:
        return [item.strip() for item in str(raw or "").split("||") if item.strip()]

    def _scopes(self):
        scopes = [self.page]
        try:
            scopes.extend(self.page.frames)
        except Exception:
            pass
        return scopes

    @staticmethod
    def _now_loop_seconds() -> float:
        return asyncio.get_running_loop().time()

    @staticmethod
    def _remaining_ms(deadline_seconds: float) -> int:
        remaining = int((deadline_seconds - asyncio.get_running_loop().time()) * 1000)
        return max(0, remaining)

    async def _click_any(self, raw_selector: str, timeout_ms: int) -> bool:
        selectors = self._selector_options(raw_selector)
        if not selectors:
            return False

        deadline = self._now_loop_seconds() + max(500, timeout_ms) / 1000
        while self._now_loop_seconds() < deadline:
            for selector in selectors:
                for scope in self._scopes():
                    remaining_ms = self._remaining_ms(deadline)
                    if remaining_ms <= 0:
                        return False
                    per_try = min(1500, max(300, remaining_ms))
                    try:
                        locator = scope.locator(selector).first
                        await locator.wait_for(state="visible", timeout=per_try)
                        await locator.click(timeout=per_try)
                        return True
                    except Exception:
                        continue
            await self.page.wait_for_timeout(150)
        return False

    async def _fill_any(self, raw_selector: str, value: str, timeout_ms: int) -> bool:
        selectors = self._selector_options(raw_selector)
        deadline = self._now_loop_seconds() + max(500, timeout_ms) / 1000

        while self._now_loop_seconds() < deadline:
            for selector in selectors:
                for scope in self._scopes():
                    remaining_ms = self._remaining_ms(deadline)
                    if remaining_ms <= 0:
                        return False
                    per_try = min(1200, max(250, remaining_ms))
                    try:
                        locator = scope.locator(selector).first
                        await locator.wait_for(state="visible", timeout=per_try)
                        await locator.fill("")
                        await locator.fill(value, timeout=per_try)
                        return True
                    except Exception:
                        continue

            # Fallback por heuristica: procura qualquer input visivel com indicio de CPF.
            for scope in self._scopes():
                remaining_ms = self._remaining_ms(deadline)
                if remaining_ms <= 0:
                    return False
                per_try = min(1000, max(250, remaining_ms))
                try:
                    locator = scope.locator(
                        "input[placeholder*='CPF' i], input[name*='cpf' i], input[id*='cpf' i]"
                    ).first
                    await locator.wait_for(state="visible", timeout=per_try)
                    await locator.fill("")
                    await locator.fill(value, timeout=per_try)
                    return True
                except Exception:
                    continue
            await self.page.wait_for_timeout(120)
        return False

    async def _wait_any(self, raw_selector: str, timeout_ms: int) -> bool:
        selectors = self._selector_options(raw_selector)
        if not selectors:
            return False

        deadline = self._now_loop_seconds() + max(500, timeout_ms) / 1000
        while self._now_loop_seconds() < deadline:
            for selector in selectors:
                for scope in self._scopes():
                    remaining_ms = self._remaining_ms(deadline)
                    if remaining_ms <= 0:
                        return False
                    per_try = min(1200, max(250, remaining_ms))
                    try:
                        await scope.locator(selector).first.wait_for(state="visible", timeout=per_try)
                        return True
                    except Exception:
                        continue
            await self.page.wait_for_timeout(150)
        return False

    async def _press_enter_on_any(self, raw_selector: str, timeout_ms: int) -> bool:
        selectors = self._selector_options(raw_selector)
        if not selectors:
            return False

        deadline = self._now_loop_seconds() + max(500, timeout_ms) / 1000
        while self._now_loop_seconds() < deadline:
            for selector in selectors:
                for scope in self._scopes():
                    remaining_ms = self._remaining_ms(deadline)
                    if remaining_ms <= 0:
                        return False
                    per_try = min(1000, max(250, remaining_ms))
                    try:
                        locator = scope.locator(selector).first
                        await locator.wait_for(state="visible", timeout=per_try)
                        await locator.focus(timeout=per_try)
                        await locator.press("Enter", timeout=per_try)
                        return True
                    except Exception:
                        continue
            await self.page.wait_for_timeout(120)
        return False

    async def _safe_text_any(self, raw_selector: str) -> str | None:
        for selector in self._selector_options(raw_selector):
            for scope in self._scopes():
                try:
                    value = await scope.locator(selector).first.inner_text(timeout=1200)
                    value = value.strip()
                    if value:
                        return value
                except Exception:
                    continue
        return None

    async def _fill_cpf_search_input(self, cpf: str, timeout_ms: int) -> bool:
        if await self._is_login_page():
            return False

        filled = await self._fill_any(self.settings.selector_cpf_input, cpf, timeout_ms)
        if filled:
            return True

        # Fallback para tela "Servidores": campo texto ao lado do botao "Pesquisar".
        try:
            ok = await self.page.evaluate(
                """(cpfValue) => {
                    const normalize = (v) => String(v || "").toLowerCase();
                    const buttons = Array.from(document.querySelectorAll("button, a"));
                    for (const b of buttons) {
                      const txt = normalize(b.textContent || "");
                      if (!txt.includes("pesquisar")) continue;

                      const host = b.closest("form, .row, .input-group, .card, .card-body, .container, .container-fluid") || document.body;
                      const input =
                        host.querySelector("input[name*='cpf' i]") ||
                        host.querySelector("input[id*='cpf' i]") ||
                        host.querySelector("input[placeholder*='cpf' i]") ||
                        host.querySelector("input[type='text']") ||
                        document.querySelector("input[name*='cpf' i], input[id*='cpf' i], input[placeholder*='cpf' i]");
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

    async def _is_login_page(self) -> bool:
        url = (self.page.url or "").lower()
        if "/login" in url:
            return True

        try:
            return bool(
                await self.page.evaluate(
                    """() => {
                        const text = String(document.body?.innerText || "").toLowerCase();
                        const hasPassword = !!document.querySelector("input[type='password']");
                        const hasCpf = !!document.querySelector("input[name='cpf'], input#cpf");
                        const loginHints =
                          text.includes("portal_padrao") ||
                          text.includes("consignataria") ||
                          text.includes("esqueci minha senha") ||
                          text.includes("entrar com gov.br");
                        return hasPassword && hasCpf && loginHints;
                    }"""
                )
            )
        except Exception:
            return False

    async def _recover_session_if_logged_out(self) -> None:
        if not await self._is_login_page():
            return

        self.logger.info("Sessao deslogada detectada, realizando novo login no portal")
        await login_portal(self.page, self.settings)
        await self.page.goto(
            self.settings.margem_url,
            wait_until="domcontentloaded",
            timeout=max(self.settings.timeout_ms, 45000),
        )
        await self.page.wait_for_timeout(600)

    async def _wait_search_outcome(self, timeout_ms: int) -> str:
        deadline = self._now_loop_seconds() + max(1000, timeout_ms) / 1000
        while self._now_loop_seconds() < deadline:
            if await self._wait_any(self.settings.selector_detalhes_button, 700):
                return "com_resultado"

            if await self._wait_any(self.settings.selector_sem_resultado, 500):
                return "sem_resultado"

            await self.page.wait_for_timeout(200)
        return "timeout"

    async def _trigger_search_by_js(self) -> bool:
        try:
            ok = await self.page.evaluate(
                """() => {
                    const buttons = Array.from(document.querySelectorAll("button, a"));
                    for (const b of buttons) {
                      const txt = String(b.textContent || "").toLowerCase();
                      if (!txt.includes("pesquisar")) continue;
                      b.click();
                      return true;
                    }
                    return false;
                }"""
            )
            return bool(ok)
        except Exception:
            return False

    async def _click_detalhes_por_cpf(self, cpf: str, timeout_ms: int) -> bool:
        cpf = (cpf or "").strip()
        cpf_fmt = cpf
        if len(cpf) == 11 and cpf.isdigit():
            cpf_fmt = f"{cpf[:3]}.{cpf[3:6]}.{cpf[6:9]}-{cpf[9:]}"
        search_tokens = [token for token in [cpf, cpf_fmt, cpf[-6:] if len(cpf) >= 6 else ""] if token]

        deadline = self._now_loop_seconds() + max(1000, timeout_ms) / 1000
        while self._now_loop_seconds() < deadline:
            for token in search_tokens:
                try:
                    row = self.page.locator(f"tr:has-text('{token}')").first
                    if await row.count() > 0:
                        for sel in [
                            "a:has-text('Detalhes')",
                            "button:has-text('Detalhes')",
                            "[title*='Detalhes' i]",
                            "[aria-label*='Detalhes' i]",
                        ]:
                            btn = row.locator(sel).first
                            if await btn.count() > 0:
                                await btn.click(timeout=1200)
                                return True

                        clicked_by_js = await self.page.evaluate(
                            """(needle) => {
                                const normalize = (v) => String(v || "").toLowerCase();
                                const rows = Array.from(document.querySelectorAll("tr"));
                                for (const row of rows) {
                                  const txt = normalize(row.textContent || "");
                                  if (!txt.includes(normalize(needle))) continue;
                                  const controls = Array.from(row.querySelectorAll("a,button,[title],[aria-label]"));
                                  for (const c of controls) {
                                    const cText = normalize(c.textContent || "");
                                    const cTitle = normalize(c.getAttribute("title") || c.getAttribute("aria-label") || "");
                                    if (cText.includes("detalhes") || cTitle.includes("detalhes")) {
                                      c.click();
                                      return true;
                                    }
                                  }
                                }
                                return false;
                            }""",
                            token,
                        )
                        if clicked_by_js:
                            return True
                except Exception:
                    continue

            # Fallback: primeira acao "Detalhes" visivel da tabela.
            if await self._click_any(self.settings.selector_detalhes_button, 1200):
                return True

            await self.page.wait_for_timeout(220)
        return False

    async def _try_open_detalhes_by_direct_search(self, cpf: str) -> bool:
        try:
            await self._recover_session_if_logged_out()
            await self.page.goto(
                f"https://consignataria.portal_padrao.ap.gov.br/servidores?q={cpf}",
                wait_until="domcontentloaded",
                timeout=max(self.settings.timeout_ms, 30000),
            )
            await self.page.wait_for_timeout(900)
            return await self._click_detalhes_por_cpf(cpf, 5000)
        except Exception:
            return False

    async def _extract_value_by_label(self, label: str) -> str | None:
        try:
            value = await self.page.evaluate(
                """(targetLabel) => {
                    const normalize = (v) => String(v || "")
                      .normalize("NFD")
                      .replace(/[\\u0300-\\u036f]/g, "")
                      .toLowerCase()
                      .trim();
                    const isMarginLike = (raw) => {
                      const t = String(raw || "").replace(/\\s+/g, " ").trim();
                      if (!t || t.length > 40) return false;
                      if (/^\\d{1,2}\\/\\d{4}$/.test(t)) return false;
                      if (/r\\$\\s*-?\\d/i.test(t)) return true;
                      if (/^-?\\d{1,3}(\\.\\d{3})*,\\d{2}$/.test(t)) return true;
                      if (/^-?\\d+,\\d{2}$/.test(t)) return true;
                      if (/^-?\\d+(\\.\\d+)?$/.test(t)) return true;
                      return false;
                    };
                    const wanted = normalize(targetLabel);
                    if (!wanted) return "";

                    const nodes = Array.from(document.querySelectorAll("body *"));
                    for (const el of nodes) {
                      const txt = normalize(el.textContent || "");
                      if (!txt || txt.length > 220) continue;
                      if (!(txt === wanted || txt === `${wanted}:` || txt.startsWith(`${wanted} `))) continue;

                      const container = el.closest("div,section,article,fieldset,tr,li,td") || el.parentElement;
                      if (!container) continue;

                      const candidates = Array.from(
                        container.querySelectorAll("input, textarea, select, [data-value], .value, .valor")
                      );
                      for (const c of candidates) {
                        let raw = "";
                        if (c instanceof HTMLInputElement || c instanceof HTMLTextAreaElement || c instanceof HTMLSelectElement) {
                          raw = c.value || "";
                        } else {
                          raw = (c.textContent || "").trim();
                        }
                        const n = normalize(raw);
                        if (!n || n === wanted) continue;
                        if (isMarginLike(raw)) return String(raw).trim();
                      }
                    }
                    return "";
                }""",
                label,
            )
            value = (value or "").strip()
            return value or None
        except Exception:
            return None

    async def _extract_value_by_labels(self, raw_labels: str) -> str | None:
        for label in self._selector_options(raw_labels):
            value = await self._extract_value_by_label(label)
            if value:
                return value
        return None

    async def _extract_fields_from_section(self, section_title: str, labels: list[str]) -> dict[str, str]:
        try:
            payload = await self.page.evaluate(
                """({ sectionTitle, labels }) => {
                    const normalize = (v) =>
                      String(v || "")
                        .normalize("NFD")
                        .replace(/[\\u0300-\\u036f]/g, "")
                        .toLowerCase()
                        .trim();
                    const isMarginLike = (raw) => {
                      const t = String(raw || "").replace(/\\s+/g, " ").trim();
                      if (!t || t.length > 40) return false;
                      if (/^\\d{1,2}\\/\\d{4}$/.test(t)) return false;
                      if (/r\\$\\s*-?\\d/i.test(t)) return true;
                      if (/^-?\\d{1,3}(\\.\\d{3})*,\\d{2}$/.test(t)) return true;
                      if (/^-?\\d+,\\d{2}$/.test(t)) return true;
                      if (/^-?\\d+(\\.\\d+)?$/.test(t)) return true;
                      return false;
                    };
                    const valueOf = (node) => {
                      if (!node) return "";
                      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
                        return String(node.value || "").trim();
                      }
                      return String(node.textContent || "").trim();
                    };
                    const hasSectionTitle = (node, wanted) => {
                      const own = normalize(node.textContent || "");
                      if (own.includes(wanted)) return true;
                      const headings = Array.from(
                        node.querySelectorAll("h1,h2,h3,h4,h5,h6,.card-header,.panel-heading,legend,strong")
                      );
                      return headings.some((h) => normalize(h.textContent || "").includes(wanted));
                    };
                    const firstMarginLike = (nodes) => {
                      for (const n of nodes) {
                        const raw = valueOf(n);
                        if (isMarginLike(raw)) return raw;
                      }
                      return "";
                    };

                    const wantedSection = normalize(sectionTitle);
                    const labelMap = labels.map((lbl) => ({ raw: lbl, norm: normalize(lbl) }));
                    const result = {};
                    for (const item of labelMap) result[item.raw] = "";

                    const nodes = Array.from(document.querySelectorAll("body *"));
                    let sectionEl = null;
                    for (const el of nodes) {
                      const txt = normalize(el.textContent || "");
                      if (!txt) continue;
                      if (txt.length > 120) continue;
                      if (txt !== wantedSection && !txt.includes(wantedSection)) continue;

                      let probe = el;
                      while (probe && probe !== document.body) {
                        const inputs = probe.querySelectorAll("input, textarea, select");
                        if (inputs.length >= 2 && hasSectionTitle(probe, wantedSection)) {
                          sectionEl = probe;
                          break;
                        }
                        probe = probe.parentElement;
                      }
                      if (!sectionEl) {
                        sectionEl = el.closest("section, article, .card, .panel, .ibox, .box, form") || el;
                      }
                      if (sectionEl) {
                        break;
                      }
                    }
                    if (!sectionEl) return result;

                    for (const { raw, norm } of labelMap) {
                      const labelNodes = Array.from(sectionEl.querySelectorAll("label, strong, span, div, h5, h6, p, th"));
                      for (const lblNode of labelNodes) {
                        const txt = normalize(lblNode.textContent || "");
                        if (!txt) continue;
                        if (txt.length > 48) continue;
                        if (!(txt === norm || txt === `${norm}:` || txt.startsWith(`${norm} `))) continue;

                        const scope = lblNode.closest("div, section, article, fieldset, tr, li, td") || lblNode.parentElement;
                        if (!scope) continue;
                        const localCandidates = Array.from(
                          scope.querySelectorAll("input, textarea, select, [data-value], .value, .valor")
                        );
                        const siblingCandidates = [];
                        let sibling = scope.nextElementSibling;
                        let hops = 0;
                        while (sibling && hops < 2) {
                          siblingCandidates.push(...Array.from(sibling.querySelectorAll("input, textarea, select, [data-value], .value, .valor")));
                          sibling = sibling.nextElementSibling;
                          hops += 1;
                        }
                        const rawValue = firstMarginLike([...localCandidates, ...siblingCandidates]);
                        if (rawValue) {
                          result[raw] = String(rawValue).trim();
                          break;
                        }
                      }

                      if (!result[raw]) {
                        const blocks = Array.from(sectionEl.querySelectorAll("div, td, th, tr, li"));
                        for (const block of blocks) {
                          const txt = normalize(block.textContent || "");
                          if (!txt.includes(norm)) continue;
                          const rawValue = firstMarginLike(
                            Array.from(block.querySelectorAll("input, textarea, select, [data-value], .value, .valor"))
                          );
                          if (rawValue) {
                            result[raw] = String(rawValue).trim();
                            break;
                          }
                        }
                      }
                    }
                    return result;
                }""",
                {"sectionTitle": section_title, "labels": labels},
            )
            return {k: (v or "").strip() for k, v in (payload or {}).items()}
        except Exception:
            return {label: "" for label in labels}

    async def _extract_label_value_in_section(self, section_title: str, label: str) -> str | None:
        try:
            value = await self.page.evaluate(
                """({ sectionTitle, label }) => {
                    const normalize = (v) =>
                      String(v || "")
                        .normalize("NFD")
                        .replace(/[\\u0300-\\u036f]/g, "")
                        .toLowerCase()
                        .trim();
                    const isMarginLike = (raw) => {
                      const t = String(raw || "").replace(/\\s+/g, " ").trim();
                      if (!t || t.length > 40) return false;
                      if (/^\\d{1,2}\\/\\d{4}$/.test(t)) return false;
                      if (/r\\$\\s*-?\\d/i.test(t)) return true;
                      if (/^-?\\d{1,3}(\\.\\d{3})*,\\d{2}$/.test(t)) return true;
                      if (/^-?\\d+,\\d{2}$/.test(t)) return true;
                      if (/^-?\\d+(\\.\\d+)?$/.test(t)) return true;
                      return false;
                    };
                    const valueOf = (node) => {
                      if (!node) return "";
                      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
                        return String(node.value || "").trim();
                      }
                      return String(node.textContent || "").trim();
                    };

                    const wantedSection = normalize(sectionTitle);
                    const wantedLabel = normalize(label);
                    if (!wantedSection || !wantedLabel) return "";

                    const nodes = Array.from(document.querySelectorAll("body *"));
                    let sectionEl = null;
                    for (const el of nodes) {
                      const txt = normalize(el.textContent || "");
                      if (!txt || txt.length > 120) continue;
                      if (txt !== wantedSection && !txt.includes(wantedSection)) continue;
                      sectionEl = el.closest("section, article, .card, .panel, .ibox, .box, form, div") || el;
                      if (sectionEl) break;
                    }
                    if (!sectionEl) return "";

                    const labelNodes = Array.from(sectionEl.querySelectorAll("label, strong, span, div, h5, h6, p, th"));
                    for (const lblNode of labelNodes) {
                      const txt = normalize(lblNode.textContent || "");
                      if (!txt || txt.length > 48) continue;
                      if (!(txt === wantedLabel || txt === `${wantedLabel}:` || txt.startsWith(`${wantedLabel} `))) {
                        continue;
                      }

                      let scope = lblNode.closest("div, section, article, fieldset, tr, li, td") || lblNode.parentElement;
                      let hops = 0;
                      while (scope && hops < 4) {
                        const candidates = Array.from(scope.querySelectorAll("input, textarea, select, [data-value], .value, .valor"));
                        for (const c of candidates) {
                          const rawValue = valueOf(c);
                          if (isMarginLike(rawValue)) return rawValue;
                        }
                        scope = scope.nextElementSibling;
                        hops += 1;
                      }
                    }
                    return "";
                }""",
                {"sectionTitle": section_title, "label": label},
            )
            value = (value or "").strip()
            return value or None
        except Exception:
            return None

    async def _switch_to_new_page_if_opened(self) -> None:
        if not self.context:
            return
        pages = [p for p in self.context.pages if not p.is_closed()]
        if len(pages) <= 1:
            return
        maybe_new = pages[-1]
        if maybe_new != self.page:
            self.page = maybe_new
            await self.page.bring_to_front()
            await self.page.wait_for_load_state("domcontentloaded", timeout=max(10000, self.settings.timeout_ms))

    async def _submit_reauth_if_needed(self) -> None:
        if not self.settings.portal_password:
            return
        needs_reauth = await self._wait_any(self.settings.selector_reauth_password, 1800)
        if not needs_reauth:
            return

        self.logger.info("Reautenticacao detectada, enviando senha do portal")
        filled = await self._fill_any(self.settings.selector_reauth_password, self.settings.portal_password, 5000)
        if not filled:
            raise RuntimeError("Tela pediu senha novamente, mas nao encontrei campo de senha")

        clicked_submit = await self._click_any(self.settings.selector_reauth_submit, 5000)
        if not clicked_submit:
            try:
                await self.page.keyboard.press("Enter")
            except Exception:
                raise RuntimeError("Tela pediu senha novamente, mas nao encontrei botao de confirmacao")
        await self.page.wait_for_timeout(700)

    async def _extract_nome_servidor(self) -> str | None:
        try:
            value = await self.page.evaluate(
                """() => {
                    const normalize = (v) =>
                      String(v || "")
                        .normalize("NFD")
                        .replace(/[\\u0300-\\u036f]/g, "")
                        .toLowerCase()
                        .trim();
                    const isNameLike = (v) => {
                      const t = String(v || "").trim();
                      if (!t) return false;
                      if (t.length < 6 || t.length > 120) return false;
                      if (/^\\d{1,2}\\/\\d{4}$/.test(t)) return false;
                      if (/^\\d+(,\\d+)?$/.test(t)) return false;
                      return /[A-Za-z]/.test(t);
                    };

                    const labelNodes = Array.from(document.querySelectorAll("label,strong,span,div,h5,h6"));
                    for (const label of labelNodes) {
                      const txt = normalize(label.textContent || "");
                      if (txt !== "nome") continue;
                      const scope = label.closest("div, section, article, fieldset, tr, td") || label.parentElement;
                      if (!scope) continue;
                      const input =
                        scope.querySelector("input[type='text'], input:not([type]), textarea") ||
                        scope.querySelector("input, textarea");
                      if (!input) continue;
                      const v = String(input.value || "").trim();
                      if (isNameLike(v)) return v;
                    }

                    const named = Array.from(document.querySelectorAll("input[name*='nome' i], input[id*='nome' i], textarea[name*='nome' i], textarea[id*='nome' i]"));
                    for (const i of named) {
                      const v = String(i.value || "").trim();
                      if (isNameLike(v)) return v;
                    }

                    const inputs = Array.from(document.querySelectorAll("input[type='text'], input:not([type]), textarea"));
                    for (const i of inputs) {
                      const v = String(i.value || "").trim();
                      if (isNameLike(v)) return v;
                    }
                    return "";
                }"""
            )
            value = (value or "").strip()
            return value or None
        except Exception:
            return None

    async def _go_to_servidores_margem(self) -> None:
        await self._recover_session_if_logged_out()

        current_url = (self.page.url or "").strip()
        if current_url.startswith("chrome-error://"):
            raise RuntimeError(
                "Falha de navegacao: a pagina caiu em erro do Chromium (chrome-error://chromewebdata)."
            )

        if "sso.acesso.gov.br" in (self.page.url or ""):
            raise RuntimeError(
                "Sessao ainda no Gov.br (SSO). Verifique captcha/autenticacao antes de consultar a margem."
            )

        # Se ja estamos na tela de busca por CPF, nao precisa navegar no menu.
        if await self._wait_any(self.settings.selector_cpf_input, 1500):
            return

        # Fluxo solicitado: entrar em Servidores para pesquisar CPF.
        clicked_servidor = await self._click_any(self.settings.selector_menu_servidores, 5000)
        if clicked_servidor:
            self.logger.info("Fluxo inicial: menu Servidores acionado")
            await self.page.wait_for_timeout(400)
            if await self._wait_any(self.settings.selector_cpf_input, 1800):
                return

        ok = await self._wait_any(self.settings.selector_cpf_input, min(self.settings.timeout_ms, 12000))
        if ok:
            return

        url_atual = self.page.url
        try:
            titulo = await self.page.title()
        except Exception:
            titulo = "desconhecido"

        try:
            await save_evidence_screenshot(self.page, self.lote_id, "startup", "erro_fluxo_inicial")
        except Exception:
            pass

        raise RuntimeError("Nao encontrei campo CPF no fluxo de Servidores " f"(url={url_atual}, titulo={titulo})")

    async def start(self) -> None:
        self.logger.info("Iniciando navegador e sessao do portal")
        self.playwright = await async_playwright().start()
        self._log_playwright_diagnostics("margem_consulta_start")
        self.browser = await self.playwright.chromium.launch(
            headless=self._resolve_headless(),
            args=self._browser_launch_args(),
        )
        print("[PLAYWRIGHT] chromium launch ok true", file=sys.stderr, flush=True)
        self.context = await self.browser.new_context()
        self.page = await self.context.new_page()
        self.logger.info("Realizando login no portal")
        await login_portal(self.page, self.settings)
        self.logger.info("Abrindo pagina de margem")
        await self.page.goto(
            self.settings.margem_url,
            wait_until="domcontentloaded",
            timeout=max(self.settings.timeout_ms, 45000),
        )
        await self._go_to_servidores_margem()
        self.logger.info("Fluxo inicial concluido, pronto para consultar CPFs")
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
        # Fluxo solicitado:
        # Servidores -> CPF -> Pesquisar -> Detalhes -> Aba Margem -> visualizar margem do servidor
        await self._go_to_servidores_margem()
        filled = await self._fill_cpf_search_input(cpf, self.settings.timeout_ms)
        if not filled:
            raise RuntimeError("Nao encontrei campo CPF no fluxo de Servidores")

        clicked_search = await self._click_any(
            f"{self.settings.selector_pesquisar_button} || {self.settings.selector_consultar_button}",
            self.settings.timeout_ms,
        )
        if not clicked_search:
            self.logger.info("Nao encontrei botao Pesquisar/Consultar; tentando Enter no campo CPF")
            clicked_js_search = await self._trigger_search_by_js()
            if clicked_js_search:
                clicked_search = True

        if not clicked_search:
            pressed_enter = await self._press_enter_on_any(self.settings.selector_cpf_input, 3000)
            if not pressed_enter:
                try:
                    await self.page.keyboard.press("Enter")
                    pressed_enter = True
                except Exception:
                    pressed_enter = False
            if not pressed_enter:
                raise RuntimeError("Nao encontrei botao Pesquisar/Consultar e Enter nao funcionou")

        await self.page.wait_for_timeout(self.settings.intervalo_entre_consultas_ms)
        search_outcome = await self._wait_search_outcome(12000)
        if search_outcome == "sem_resultado":
            raise RuntimeError("CPF nao localizado na lista de Servidores")
        if search_outcome == "timeout":
            self.logger.info("Busca por CPF sem retorno claro; tentando clicar em Detalhes mesmo assim")

        clicked_details = await self._click_detalhes_por_cpf(cpf, 9000)
        if not clicked_details:
            clicked_details = await self._try_open_detalhes_by_direct_search(cpf)
        if not clicked_details:
            raise RuntimeError("Nao encontrei botao Detalhes apos pesquisar CPF")
        await self.page.wait_for_timeout(500)
        clicked_tab = await self._click_any(self.settings.selector_aba_margem, 6000)
        if not clicked_tab:
            raise RuntimeError("Nao encontrei a aba Margem na tela de detalhes")
        await self.page.wait_for_timeout(500)
        clicked_view = await self._click_any(self.settings.selector_visualizar_margem_link, 7000)
        if not clicked_view:
            raise RuntimeError("Nao encontrei o link para visualizar margem do servidor")
        await self.page.wait_for_timeout(500)
        await self._switch_to_new_page_if_opened()
        await self._submit_reauth_if_needed()

        if self.settings.selector_result_ready:
            ok = await self._wait_any(self.settings.selector_result_ready, self.settings.timeout_ms)
            if not ok:
                raise RuntimeError("Pagina de resultado de margem nao carregou")

        erro_tela = await self._safe_text_any(self.settings.selector_error)
        if erro_tela:
            raise RuntimeError(erro_tela)

        nome_servidor = await self._extract_nome_servidor()
        margem_disponivel = await self._safe_text_any(self.settings.selector_margem_disponivel)
        margem_cartao = await self._safe_text_any(self.settings.selector_margem_cartao)
        margem_cartao_beneficio = await self._safe_text_any(self.settings.selector_margem_cartao_beneficio)

        facultativa = await self._extract_fields_from_section(
            "Margem Facultativa", ["Margem Consignavel", "Disponivel"]
        )
        cartao = await self._extract_fields_from_section("Margem Consignavel de Cartao", ["Margem", "Disponivel"])
        cartao_beneficio = await self._extract_fields_from_section(
            "Margem consignavel de Cartao Beneficio", ["Margem", "Disponivel"]
        )

        if not facultativa.get("Disponivel"):
            fac_disp = await self._extract_label_value_in_section("Margem Facultativa", "Disponivel")
            if fac_disp:
                facultativa["Disponivel"] = fac_disp

        if not cartao.get("Disponivel"):
            cart_disp = await self._extract_label_value_in_section("Margem Consignavel de Cartao", "Disponivel")
            if cart_disp:
                cartao["Disponivel"] = cart_disp

        if not cartao_beneficio.get("Disponivel"):
            cart_ben_disp = await self._extract_label_value_in_section(
                "Margem consignavel de Cartao Beneficio", "Disponivel"
            )
            if cart_ben_disp:
                cartao_beneficio["Disponivel"] = cart_ben_disp

        # Regra principal: margem_disponivel = Disponivel da Margem Facultativa.
        margem_disponivel = facultativa.get("Disponivel") or margem_disponivel
        margem_cartao = cartao.get("Disponivel") or margem_cartao
        margem_cartao_beneficio = cartao_beneficio.get("Disponivel") or margem_cartao_beneficio

        if not margem_disponivel:
            margem_disponivel = await self._extract_label_value_in_section("Margem Facultativa", "Disponivel")
        if not margem_cartao:
            margem_cartao = await self._extract_label_value_in_section("Margem Consignavel de Cartao", "Disponivel")
        if not margem_cartao_beneficio:
            margem_cartao_beneficio = await self._extract_label_value_in_section(
                "Margem consignavel de Cartao Beneficio", "Disponivel"
            )

        payload_extra = await coletar_detalhes_portal_padrao(self.page, self.settings)
        payload_extra = payload_extra or {}
        payload_extra.update(
            {
                "nome_portal": nome_servidor or "",
                "facultativa_margem_consignavel": facultativa.get("Margem Consignavel", ""),
                "facultativa_disponivel": facultativa.get("Disponivel", ""),
                "cartao_margem_consignavel": cartao.get("Margem", ""),
                "cartao_disponivel": cartao.get("Disponivel", ""),
                "cartao_beneficio_margem_consignavel": cartao_beneficio.get("Margem", ""),
                "cartao_beneficio_disponivel": cartao_beneficio.get("Disponivel", ""),
            }
        )

        evidencia_png = None
        if self.settings.capture_screenshot_on_success:
            evidencia_png = await save_evidence_screenshot(self.page, self.lote_id, cpf, "sucesso")
        if self.settings.capture_pdf:
            await save_evidence_pdf(self.page, self.lote_id, cpf, "sucesso")

        return ConsultaResultado(
            status="sucesso",
            margem_disponivel=margem_disponivel,
            margem_cartao=margem_cartao,
            margem_cartao_beneficio=margem_cartao_beneficio,
            payload_extra=payload_extra,
            evidencia_path=evidencia_png,
            consultado_em=datetime.utcnow(),
        )

    async def consultar_cliente(self, cpf: str) -> ConsultaResultado:
        if not self.is_ready:
            await self.start()

        tentativas = max(1, self.settings.retry_attempts)
        last_error = None
        masked_cpf = mask_cpf(cpf) if self.settings.mascarar_cpf_logs else cpf

        for attempt in range(1, tentativas + 1):
            try:
                resultado = await self._consultar_uma_vez(cpf)
                resultado.tentativas = attempt
                self.logger.info("Consulta concluida | cpf=%s | status=sucesso | tentativas=%s", masked_cpf, attempt)
                return resultado
            except Exception as exc:
                last_error = str(exc)
                self.logger.warning(
                    "Falha na consulta | cpf=%s | tentativa=%s/%s | erro=%s",
                    masked_cpf,
                    attempt,
                    tentativas,
                    last_error,
                )

                if self._is_transient_navigation_error(last_error):
                    self.logger.warning(
                        "Falha de navegacao/conexao detectada | cpf=%s | reiniciando sessao do navegador",
                        masked_cpf,
                    )
                    try:
                        await self.close()
                    except Exception:
                        pass
                    try:
                        await self.start()
                    except Exception as restart_exc:
                        last_error = f"{last_error} | falha ao recuperar sessao: {restart_exc}"

                if attempt < tentativas:
                    await asyncio.sleep(0.8)

        evidencia_erro = None
        try:
            evidencia_erro = await save_evidence_screenshot(self.page, self.lote_id, cpf, "erro")
            if self.settings.capture_pdf:
                await save_evidence_pdf(self.page, self.lote_id, cpf, "erro")
        except Exception:
            evidencia_erro = None

        return ConsultaResultado(
            status="erro",
            detalhe_erro=last_error or "Erro desconhecido na consulta",
            evidencia_path=evidencia_erro,
            consultado_em=datetime.utcnow(),
            tentativas=tentativas,
        )


