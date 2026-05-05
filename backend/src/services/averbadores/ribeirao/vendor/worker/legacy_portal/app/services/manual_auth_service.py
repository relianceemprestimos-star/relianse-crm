from __future__ import annotations

import base64
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta

from playwright.async_api import async_playwright

from app.connectors.portal_secundario_legacy import PortalSecundarioLegacyConnector
from app.utils.logger import get_logger


@dataclass
class PendingPortalAuth:
    session_id: str
    credencial_id: int
    usuario: str
    senha: str
    connector: PortalSecundarioLegacyConnector
    expires_at: datetime
    confirming: bool = False


class ManualAuthManager:
    def __init__(self):
        self.logger = get_logger("manual-auth")
        self.pending_sessions: dict[str, PendingPortalAuth] = {}

    def _find_pending_by_credencial(self, credencial_id: int) -> PendingPortalAuth | None:
        if credencial_id <= 0:
            return None
        now = datetime.utcnow()
        candidates = [
            item
            for item in self.pending_sessions.values()
            if item.credencial_id == credencial_id and item.expires_at > now
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda item: item.expires_at, reverse=True)
        return candidates[0]

    async def _close_connector(self, connector: PortalSecundarioLegacyConnector) -> None:
        try:
            await connector.close()
        except Exception:
            pass

    async def cleanup_expired(self) -> None:
        now = datetime.utcnow()
        expired_keys = [sid for sid, item in self.pending_sessions.items() if item.expires_at <= now]
        for sid in expired_keys:
            pending = self.pending_sessions.pop(sid, None)
            if pending:
                await self._close_connector(pending.connector)

    async def _capture_captcha_image_base64(self, connector: PortalSecundarioLegacyConnector) -> str:
        selectors = connector._selector_options(connector.settings.pdc_selector_captcha_input)
        extraction = await connector.page.evaluate(
            """(selectors) => {
                const isVisible = (el) => {
                  if (!el) return false;
                  const style = window.getComputedStyle(el);
                  if (!style) return false;
                  const r = el.getBoundingClientRect();
                  return style.visibility !== "hidden" && style.display !== "none" && r.width > 0 && r.height > 0;
                };
                const dist = (a, b) => {
                  const ax = a.left + (a.width / 2);
                  const ay = a.top + (a.height / 2);
                  const bx = b.left + (b.width / 2);
                  const by = b.top + (b.height / 2);
                  const dx = ax - bx;
                  const dy = ay - by;
                  return Math.sqrt(dx * dx + dy * dy);
                };
                let input = null;
                for (const selector of selectors || []) {
                  const nodes = Array.from(document.querySelectorAll(selector || ""));
                  const visible = nodes.find((el) => isVisible(el));
                  if (visible) {
                    input = visible;
                    break;
                  }
                }
                if (!input) return { directB64: "", rect: null };
                const inputRect = input.getBoundingClientRect();
                const scope = input.closest("form,fieldset,section,article,div,table") || document.body;
                const candidates = Array.from(scope.querySelectorAll("img,canvas"))
                  .filter((el) => isVisible(el))
                  .filter((el) => {
                    const r = el.getBoundingClientRect();
                    return r.width >= 80 && r.height >= 20;
                  });

                let targetRect = null;
                if (candidates.length) {
                  candidates.sort((a, b) => dist(a.getBoundingClientRect(), inputRect) - dist(b.getBoundingClientRect(), inputRect));
                  targetRect = candidates[0].getBoundingClientRect();
                } else {
                  targetRect = {
                    left: Math.max(0, inputRect.left - 10),
                    top: Math.max(0, inputRect.top - 90),
                    width: Math.max(320, inputRect.width + 220),
                    height: 160,
                  };
                }

                let directB64 = "";
                if (candidates.length) {
                  const target = candidates[0];
                  try {
                    if (target.tagName === "CANVAS") {
                      const raw = target.toDataURL("image/png");
                      if (raw && raw.includes(",")) directB64 = raw.split(",")[1] || "";
                    } else if (target.tagName === "IMG") {
                      const src = String(target.currentSrc || target.src || "");
                      if (src.startsWith("data:image") && src.includes(",")) {
                        directB64 = src.split(",")[1] || "";
                      }
                    }
                  } catch (_) {
                    directB64 = "";
                  }
                }

                const pad = 8;
                return {
                  directB64,
                  rect: {
                    x: Math.max(0, targetRect.left - pad),
                    y: Math.max(0, targetRect.top - pad),
                    width: Math.max(40, targetRect.width + (pad * 2)),
                    height: Math.max(24, targetRect.height + (pad * 2)),
                  },
                };
            }""",
            selectors,
        )

        direct_b64 = str((extraction or {}).get("directB64") or "").strip()
        if direct_b64:
            return direct_b64

        rect = (extraction or {}).get("rect")
        if rect:
            viewport = connector.page.viewport_size or {"width": 1280, "height": 720}
            x = max(0.0, float(rect.get("x", 0.0)))
            y = max(0.0, float(rect.get("y", 0.0)))
            width = max(20.0, float(rect.get("width", 20.0)))
            height = max(20.0, float(rect.get("height", 20.0)))
            max_width = max(20.0, float(viewport.get("width", 1280)) - x)
            max_height = max(20.0, float(viewport.get("height", 720)) - y)
            clip = {
                "x": x,
                "y": y,
                "width": min(width, max_width),
                "height": min(height, max_height),
            }
            shot = await connector.page.screenshot(clip=clip)
        else:
            shot = await connector.page.screenshot(full_page=True)
        return base64.b64encode(shot).decode("ascii")

    async def start_portal_manual_auth(self, credencial_payload: dict) -> dict:
        await self.cleanup_expired()

        connector = PortalSecundarioLegacyConnector(lote_id=0, credencial=credencial_payload)
        connector.playwright = await async_playwright().start()
        print(f"[PLAYWRIGHT] executablePath: {getattr(getattr(connector.playwright, 'chromium', None), 'executable_path', '') or ''}", file=sys.stderr, flush=True)
        print("[PLAYWRIGHT] headless efetivo: true", file=sys.stderr, flush=True)
        connector.browser = await connector.playwright.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-features=UseDnsHttpsSvcb,AsyncDns,UseChromeOSDirectVideoDecoder",
                "--disable-quic",
            ],
        )
        print("[PLAYWRIGHT] chromium launch ok true", file=sys.stderr, flush=True)
        connector.context = await connector.browser.new_context()
        connector.page = await connector.context.new_page()

        try:
            await connector.page.goto(
                connector.settings.pdc_portal_url,
                wait_until="domcontentloaded",
                timeout=max(connector.settings.timeout_ms, 45000),
            )
            await connector.page.wait_for_timeout(800)
            await connector._open_login_entry()
            await connector._open_login_administrativo()

            ready = await connector._wait_any(
                f"{connector.settings.pdc_selector_login_user} || {connector.settings.pdc_selector_login_password}",
                6000,
            )
            if not ready:
                raise RuntimeError("Nao foi possivel abrir a tela de login administrativo.")

            user = (credencial_payload.get("usuario") or "").strip()
            pwd = (credencial_payload.get("senha") or "").strip()
            if not user or not pwd:
                raise RuntimeError("Credencial sem usuario/senha validos.")

            digits_user = re.sub(r"\D+", "", user)
            user_candidates = [user]
            if len(digits_user) == 11 and digits_user != user:
                user_candidates.append(digits_user)

            ok_user = False
            ok_pwd = False
            for candidate in user_candidates:
                forced = await connector.page.evaluate(
                    """({ user, pwd }) => {
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
                        const setValue = (input, value) => {
                          if (!input) return false;
                          input.focus();
                          input.value = "";
                          input.dispatchEvent(new Event("input", { bubbles: true }));
                          const raw = String(value || "");
                          for (const ch of raw) {
                            input.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
                            input.value = (input.value || "") + ch;
                            input.dispatchEvent(new Event("input", { bubbles: true }));
                            input.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
                          }
                          input.dispatchEvent(new Event("change", { bubbles: true }));
                          input.blur();
                          return String(input.value || "").trim().length > 0;
                        };

                        const sections = Array.from(document.querySelectorAll("form,div,fieldset,section,article"));
                        const ranked = sections
                          .map((el) => ({ el, txt: normalize(el.textContent || "") }))
                          .filter((x) => x.txt.includes("dados de acesso") || (x.txt.includes("captcha") && x.txt.includes("senha")))
                          .map((x) => x.el);
                        const scopes = ranked.length ? ranked : [document.body];

                        for (const scope of scopes) {
                          const textInputs = Array.from(
                            scope.querySelectorAll(
                              "input[name*='cpf' i],input[id*='cpf' i],input[type='text'],input[type='tel'],input:not([type])"
                            )
                          ).filter((el) => isVisible(el) && !el.disabled && !el.readOnly);
                          const passInputs = Array.from(
                            scope.querySelectorAll("input[type='password']")
                          ).filter((el) => isVisible(el) && !el.disabled && !el.readOnly);

                          if (!textInputs.length || !passInputs.length) continue;

                          const senhaInput = passInputs[0];
                          const senhaTop = senhaInput.getBoundingClientRect().top;
                          const markerCpf = textInputs.find((el) => {
                              const marker = normalize(`${el.name || ""} ${el.id || ""} ${el.placeholder || ""}`);
                              return marker.includes("cpf");
                            });
                          const textBeforeSenha = textInputs
                            .filter((el) => el.getBoundingClientRect().top < (senhaTop - 2))
                            .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
                          const cpfInput = markerCpf || textBeforeSenha[0] || textInputs[0];
                          const cpfOk = setValue(cpfInput, user);
                          const senhaOk = setValue(senhaInput, pwd);
                          if (cpfOk || senhaOk) return { cpfOk, senhaOk };
                        }

                        return { cpfOk: false, senhaOk: false };
                    }""",
                    {"user": candidate, "pwd": pwd},
                )
                ok_user = ok_user or bool(forced.get("cpfOk"))
                ok_pwd = ok_pwd or bool(forced.get("senhaOk"))
                if ok_user and ok_pwd:
                    break

            if not ok_user:
                ok_user = await connector._fill_login_user(user)
            if not ok_pwd:
                ok_pwd = await connector._fill_login_password(pwd)

            if not (ok_user and ok_pwd):
                raise RuntimeError(
                    "Nao foi possivel preencher CPF/senha automaticamente na tela administrativa. "
                    "Revise os seletores configurados para essa averbadora."
                )

            login_values = await connector.page.evaluate(
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
                    const sections = Array.from(document.querySelectorAll("form,div,fieldset,section,article"));
                    const ranked = sections
                      .map((el) => ({ el, txt: normalize(el.textContent || "") }))
                      .filter((x) => x.txt.includes("dados de acesso") || (x.txt.includes("captcha") && x.txt.includes("senha")))
                      .map((x) => x.el);
                    const scope = ranked[0] || document.body;
                    const textInputs = Array.from(
                      scope.querySelectorAll("input[name*='cpf' i],input[id*='cpf' i],input[type='text'],input[type='tel'],input:not([type])")
                    ).filter((el) => isVisible(el));
                    const passInputs = Array.from(scope.querySelectorAll("input[type='password']")).filter((el) => isVisible(el));
                    const senhaInput = passInputs[0];
                    const senhaTop = senhaInput ? senhaInput.getBoundingClientRect().top : Number.POSITIVE_INFINITY;
                    const markerCpf = textInputs.find((el) => {
                      const marker = normalize(`${el.name || ""} ${el.id || ""} ${el.placeholder || ""}`);
                      return marker.includes("cpf");
                    });
                    const textBeforeSenha = textInputs
                      .filter((el) => el.getBoundingClientRect().top < (senhaTop - 2))
                      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
                    const cpfInput = markerCpf || textBeforeSenha[0] || textInputs[0];
                    const cpfValue = String(cpfInput?.value || "").trim();
                    const senhaValue = String(senhaInput?.value || "").trim();
                    return { cpfOk: cpfValue.length > 0, senhaOk: senhaValue.length > 0 };
                }"""
            )
            if not login_values.get("cpfOk"):
                raise RuntimeError(
                    "CPF nao foi preenchido no formulario de login. "
                    "Atualize a pagina e tente novamente."
                )

            captcha_visible = await connector._wait_any(connector.settings.pdc_selector_captcha_input, 1600)
            if not captcha_visible:
                clicked = await connector._click_login_submit()
                if not clicked:
                    await connector.page.keyboard.press("Enter")
                await connector.page.wait_for_timeout(1200)
                await connector._select_profile_access()
                await connector._prepare_consulta_context()
                if connector.context and connector.session_state_path:
                    connector.session_state_path.parent.mkdir(parents=True, exist_ok=True)
                    await connector.context.storage_state(path=str(connector.session_state_path))
                await self._close_connector(connector)
                return {
                    "status": "autenticado",
                    "captcha_required": False,
                    "credencial_id": int(credencial_payload.get("id") or 0),
                    "mensagem": "Sessao autenticada sem necessidade de captcha.",
                }

            captcha_b64 = await self._capture_captcha_image_base64(connector)
            session_id = secrets.token_urlsafe(16)
            expires = datetime.utcnow() + timedelta(minutes=12)
            self.pending_sessions[session_id] = PendingPortalAuth(
                session_id=session_id,
                credencial_id=int(credencial_payload.get("id") or 0),
                usuario=user,
                senha=pwd,
                connector=connector,
                expires_at=expires,
            )
            self.logger.info(
                "Sessao manual criada",
                extra={"credencial_id": int(credencial_payload.get("id") or 0), "session_id": session_id[:8]},
            )
            return {
                "status": "aguardando_captcha",
                "captcha_required": True,
                "session_id": session_id,
                "credencial_id": int(credencial_payload.get("id") or 0),
                "expira_em": expires.isoformat(),
                "captcha_image_base64": captcha_b64,
                "mensagem": "Digite o captcha exibido na imagem para concluir o login manual.",
            }
        except Exception:
            await self._close_connector(connector)
            raise

    async def confirm_portal_manual_auth(self, session_id: str, captcha_value: str, credencial_id: int | None = None) -> dict:
        await self.cleanup_expired()
        pending = self.pending_sessions.get(session_id)
        if not pending and credencial_id:
            pending = self._find_pending_by_credencial(int(credencial_id))
            if pending:
                self.logger.warning(
                    "Session_id desatualizado no confirm; usando sessao pendente da credencial",
                    extra={"credencial_id": int(credencial_id), "session_id_recebido": session_id[:8], "session_id_ativo": pending.session_id[:8]},
                )
        if not pending:
            self.logger.warning("Sessao manual nao encontrada no confirm", extra={"session_id": session_id[:8]})
            raise RuntimeError("Sessao manual expirada ou invalida. Inicie novamente.")
        if pending.confirming:
            raise RuntimeError("Confirmacao do CAPTCHA ja esta em andamento. Aguarde alguns segundos.")

        connector = pending.connector
        captcha = (captcha_value or "").strip()
        if not captcha:
            raise RuntimeError("Captcha obrigatorio para confirmar o login manual.")

        pending.confirming = True
        try:
            # Alguns portais limpam CPF/senha ao trocar CAPTCHA.
            # Reforca o preenchimento antes de confirmar para evitar loop de "captcha invalido".
            if pending.usuario:
                await connector._fill_login_user(pending.usuario)
            if pending.senha:
                await connector._fill_login_password(pending.senha)
            await connector.page.wait_for_timeout(140)

            filled = await connector._type_any(connector.settings.pdc_selector_captcha_input, captcha, delay_ms=70)
            if not filled:
                filled = await connector._fill_any(connector.settings.pdc_selector_captcha_input, captcha)
            if not filled:
                raise RuntimeError("Nao foi possivel preencher o captcha.")

            await connector.page.wait_for_timeout(220)
            disabled = await connector._is_login_submit_disabled()
            clicked = False
            if disabled is not True:
                clicked = await connector.page.evaluate(
                    """({ captchaSelectors, submitSelectors }) => {
                    const safeQueryAll = (root, selector) => {
                      try {
                        return Array.from(root.querySelectorAll(selector || ""));
                      } catch (_) {
                        return [];
                      }
                    };
                    const isVisible = (el) => {
                      if (!el) return false;
                      const style = window.getComputedStyle(el);
                      if (!style) return false;
                      const r = el.getBoundingClientRect();
                      return style.visibility !== "hidden" && style.display !== "none" && r.width > 0 && r.height > 0;
                    };
                    const canClick = (el) => {
                      if (!el) return false;
                      if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) return !el.disabled;
                      return true;
                    };
                    let captchaInput = null;
                    for (const sel of captchaSelectors || []) {
                      const node = safeQueryAll(document, sel).find((el) => isVisible(el));
                      if (node) { captchaInput = node; break; }
                    }
                    const localScopes = captchaInput
                      ? [captchaInput.closest("form,fieldset,section,article,div,table"), document.body]
                      : [document.body];
                    for (const scope of localScopes) {
                      if (!scope) continue;
                      for (const sel of submitSelectors || []) {
                        const btn = safeQueryAll(scope, sel).find((el) => isVisible(el) && canClick(el));
                        if (!btn) continue;
                        btn.click();
                        return true;
                      }
                      const generic = safeQueryAll(scope, "button,input[type='submit'],input[type='button']");
                      for (const btn of generic) {
                        if (!isVisible(btn) || !canClick(btn)) continue;
                        const txt = String(btn.textContent || btn.value || "").toLowerCase();
                        if (txt.includes("acessar") || txt.includes("entrar") || txt.includes("login")) {
                          btn.click();
                          return true;
                        }
                      }
                    }
                    return false;
                    }""",
                    {
                        "captchaSelectors": connector._selector_options(connector.settings.pdc_selector_captcha_input),
                        "submitSelectors": connector._selector_options(connector.settings.pdc_selector_login_submit),
                    },
                )
            if not clicked:
                clicked = await connector._click_login_submit()
            if not clicked:
                await connector.page.keyboard.press("Enter")

            progressed = await connector._wait_any(
                f"{connector.settings.pdc_selector_profile_access_button} || "
                f"{connector.settings.pdc_selector_cpf_input} || "
                f"{connector.settings.pdc_selector_menu_consulta_margem}",
                7000,
            )
            if not progressed:
                await connector.page.wait_for_timeout(1500)
            if await connector._wait_any(connector.settings.pdc_selector_captcha_input, 1200):
                captcha_b64 = await self._capture_captcha_image_base64(connector)
                pending.expires_at = datetime.utcnow() + timedelta(minutes=12)
                self.logger.info(
                    "CAPTCHA invalido; mantendo mesma sessao manual",
                    extra={"credencial_id": pending.credencial_id, "session_id": pending.session_id[:8]},
                )
                return {
                    "ok": False,
                    "status": "aguardando_captcha",
                    "captcha_required": True,
                    "session_id": pending.session_id,
                    "credencial_id": pending.credencial_id,
                    "expira_em": pending.expires_at.isoformat(),
                    "captcha_image_base64": captcha_b64,
                    "mensagem": (
                        "Captcha nao validado. Digite o novo CAPTCHA exibido e confirme novamente."
                    ),
                }
            await connector._select_profile_access()
            await connector._prepare_consulta_context()

            if connector.context and connector.session_state_path:
                connector.session_state_path.parent.mkdir(parents=True, exist_ok=True)
                await connector.context.storage_state(path=str(connector.session_state_path))

            self.pending_sessions.pop(session_id, None)
            await self._close_connector(connector)
            self.logger.info(
                "Login manual concluido com sucesso",
                extra={"credencial_id": pending.credencial_id, "session_id": pending.session_id[:8]},
            )
            return {
                "ok": True,
                "status": "autenticado",
                "credencial_id": pending.credencial_id,
                "mensagem": "Login manual concluido e sessao temporaria salva com sucesso.",
            }
        except Exception as exc:
            self.pending_sessions.pop(session_id, None)
            await self._close_connector(connector)
            raise RuntimeError(str(exc)) from exc
        finally:
            still_pending = self.pending_sessions.get(session_id)
            if still_pending:
                still_pending.confirming = False

    async def cancel_portal_manual_auth(self, session_id: str) -> None:
        pending = self.pending_sessions.pop(session_id, None)
        if pending:
            await self._close_connector(pending.connector)

