from __future__ import annotations

import asyncio
import json
import os
import re
import socket
import sys
import traceback
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

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
    "LOGIN_TIMEOUT",
    "LOGIN_STILL_ON_SAME_PAGE",
    "CAPTCHA_REQUIRED",
    "PORTAL_CHANGED",
    "UNKNOWN_LOGIN_ERROR",
    "LOGIN_OK_NAVIGATION_FAILED",
    "MANUAL_AUTH_REQUIRED",
    "SELECTOR_ERROR",
    "DNS_RESOLUTION_FAILED",
    "CHROMIUM_DNS_FAILED",
}


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

    scopes = list(enumerate(_login_scopes(connector)))
    for selector in candidate_selectors:
        for scope_index, scope in scopes:
            try:
                locator = scope.locator(selector).first
                await locator.wait_for(state='visible', timeout=timeout_ms)
                await locator.click(timeout=timeout_ms)
                scope_label = 'page' if scope_index == 0 else f'frame-{scope_index}'
                print(f"[LOGIN_FLOW] botao clicado: {selector} ({scope_label})", file=sys.stderr, flush=True)
                return True, selector, debug
            except Exception:
                continue

    for scope_index, scope in scopes:
        try:
            login_locator = scope.locator('#txtLogin').first
            await login_locator.press('Enter', timeout=timeout_ms)
            scope_label = 'page' if scope_index == 0 else f'frame-{scope_index}'
            print(f"[LOGIN_FLOW] botao clicado: Enter no txtLogin ({scope_label})", file=sys.stderr, flush=True)
            return True, 'Enter', debug
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
                try:
                    locator = scope.locator(selector).first
                    await locator.wait_for(state='visible', timeout=timeout_ms)
                    await locator.click(timeout=timeout_ms)
                    scope_label = 'page' if scope_index == 0 else f'frame-{scope_index}'
                    print(f"[LOGIN_FLOW] botao clicado via fallback: {selector} ({scope_label})", file=sys.stderr, flush=True)
                    return True, selector, debug
                except Exception:
                    continue
    except Exception:
        pass

    print('[LOGIN_FLOW] selector inv?lido ignorado: button_login_fallback', file=sys.stderr, flush=True)
    return False, '', debug


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
        return await _capture_login_fallback_snapshot(connector), None, False, dns_ok, dns_ips, dns_error, False

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
        if code_upper == 'LOGIN_FIELDS_NOT_FOUND':
            return 'LOGIN_FIELDS_NOT_FOUND', raw_message or 'O sistema n?o encontrou os campos de login do portal. O layout pode ter mudado.'
        if code_upper == 'LOGIN_BUTTON_NOT_FOUND':
            return 'LOGIN_BUTTON_NOT_FOUND', raw_message or 'O sistema n?o encontrou o bot?o de login do portal.'
        if code_upper == 'LOGIN_TIMEOUT':
            return 'LOGIN_TIMEOUT', raw_message or 'O portal n?o respondeu ap?s tentar login.'
        if code_upper == 'LOGIN_STILL_ON_SAME_PAGE':
            return 'LOGIN_STILL_ON_SAME_PAGE', raw_message or 'O portal permaneceu na tela de login sem confirmar autentica??o.'
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
    if any(term in normalized for term in ['usuario ou senha', 'usu?rio ou senha', 'login ou senha', 'senha incorreta', 'senha invalida', 'senha inv?lida', 'credenciais invalidas', 'credenciais inv?lidas', 'acesso negado', 'dados incorretos']):
        return 'LOGIN_REJECTED', raw_message or 'O portal recusou o login/senha informados.'
    if any(term in normalized for term in ['nao consegui', 'n?o consegui', 'falha ao preencher', 'falha ao clicar', 'timeout', 'tempo limite']):
        if snap.get('loginFound') and snap.get('buttonFound') and not snap.get('passwordFound'):
            return 'LOGIN_STILL_ON_SAME_PAGE', raw_message or 'O portal permaneceu na tela de login sem confirmar autentica??o.'
        return 'LOGIN_TIMEOUT', raw_message or 'O portal n?o respondeu ap?s tentar login.'
    if snap.get('successFound'):
        return 'LOGIN_OK_NAVIGATION_FAILED', raw_message or 'Login aceito, mas n?o foi poss?vel abrir Consulta de Margem.'
    if 'certificado digital' in body_normalized or 'login-identific.certificadodigital.com.br' in body_normalized or 'certificadodigital' in body_normalized:
        return 'MANUAL_AUTH_REQUIRED', raw_message or 'Autentica??o manual necess?ria.'
    if error_text:
        if any(term in error_text.lower() for term in ['usuario ou senha', 'usu?rio ou senha', 'login ou senha', 'senha incorreta', 'senha invalida', 'senha inv?lida', 'credenciais invalidas', 'credenciais inv?lidas', 'acesso negado', 'dados incorretos']):
            return 'LOGIN_REJECTED', error_text
        return 'UNKNOWN_LOGIN_ERROR', error_text
    if body_text and 'login' in body_text.lower() and not snap.get('successFound'):
        return 'LOGIN_STILL_ON_SAME_PAGE', raw_message or 'O portal permaneceu na tela de login sem confirmar autentica??o.'

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
    settings.headless = _resolve_headless(payload)
    settings.timeout_ms = int(payload.get("timeout_ms") or settings.timeout_ms)
    settings.retry_attempts = int(payload.get("retry_attempts") or settings.retry_attempts)
    settings.intervalo_entre_consultas_ms = int(payload.get("intervalo_entre_consultas_ms") or settings.intervalo_entre_consultas_ms)

    portal_url = str(payload.get("portal_url") or os.getenv("RIBEIRAO_AVERBADOR_URL") or settings.pdc_portal_url)
    if _is_placeholder_url(portal_url):
        raise RuntimeError(
            "Configure RIBEIRAO_AVERBADOR_URL com a URL real do averbador de Ribeirao antes de iniciar a sessao."
        )
    settings.pdc_portal_url = portal_url

    consulta_url = str(payload.get("consulta_url") or os.getenv("RIBEIRAO_AVERBADOR_CONSULTA_URL") or settings.pdc_portal_url)
    settings.pdc_portal_url = consulta_url

    orgao_nome = str(payload.get("orgao_nome") or os.getenv("RIBEIRAO_AVERBADOR_ORGAO") or settings.pdc_orgao_nome)
    settings.pdc_orgao_nome = orgao_nome

    sessions_dir = _session_dir()
    settings.sessions_dir = sessions_dir
    sessions_dir.mkdir(parents=True, exist_ok=True)
    return settings


def _build_connector(payload: dict, settings) -> PortalSecundarioLegacyConnector:
    session_id = str(payload.get("session_id") or payload.get("sessionId") or "1")
    login = str(payload.get("login") or payload.get("username") or os.getenv("RIBEIRAO_AVERBADOR_LOGIN") or "").strip()
    password = str(payload.get("password") or os.getenv("RIBEIRAO_AVERBADOR_PASSWORD") or "")
    credencial = {
        "id": session_id,
        "credential_id": session_id,
        "username": login,
        "usuario": login,
        "password": password,
        "senha": password,
    }
    return PortalSecundarioLegacyConnector(lote_id=0, settings=settings, credencial=credencial)


async def _open_login_browser(connector: PortalSecundarioLegacyConnector, login: str, password: str) -> None:
    dialog_messages: list[str] = []

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
        try:
            await connector._open_login_entry()
        except Exception as exc:
            raise _typed_login_error("LOGIN_FIELDS_NOT_FOUND", "Nao foi possivel localizar a entrada de login do portal.", stage="open_login_entry") from exc
        snapshot = await _capture_login_snapshot(connector)
        _log_login_snapshot(snapshot, login, password, "open-login-entry")
        _log_login_flow(snapshot, "open-login-entry", login, password, final_code="PENDING")

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
        button_debug = await _capture_login_button_debug(connector)
        print(f"[LOGIN_FLOW] html do formulário de login, sem senha: {button_debug.get('formHtml') or ''}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] buttons encontrados: {json.dumps(button_debug.get('buttons') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] inputs submit/button encontrados: {json.dumps(button_debug.get('inputs') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
        print(f"[LOGIN_FLOW] links encontrados próximos ao form, se houver: {json.dumps(button_debug.get('links') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
        try:
            clicked_login, clicked_selector, _ = await _click_login_initial_button(connector)
        except Exception as exc:
            raise _typed_login_error("LOGIN_BUTTON_NOT_FOUND", "Nao consegui acionar o botao de login.", stage="button_login") from exc
        if not clicked_login:
            raise _typed_login_error(
                "LOGIN_BUTTON_NOT_FOUND",
                "O sistema nao encontrou o botao de login do portal.",
                stage="button_login",
            )

        print(f"[LOGIN_FLOW] clique de login executado: {clicked_selector or 'Enter'}", file=sys.stderr, flush=True)
        await connector.page.wait_for_timeout(1500)
        snapshot = await _capture_login_snapshot(connector)
        _log_login_snapshot(snapshot, login, password, "apos-primeiro-clique")
        _log_login_flow(snapshot, "apos-primeiro-clique", login, password, click_executed=True, final_code="PENDING", certificate_alert=bool(dialog_messages))

        if dialog_messages:
            joined = " | ".join(dialog_messages).lower()
            if "certificado" in joined or "login-identific" in joined or "nao encontrado" in joined or "n?o encontrado" in joined:
                raise _typed_login_error("MANUAL_AUTH_REQUIRED", "O portal solicitou autenticacao manual por certificado digital.", stage="alerta_certificado")

        if button_debug.get("certificateFound") or snapshot.get("certificateFound"):
            print(f"[LOGIN_FLOW] quantidade de frames: {button_debug.get('frameCount') or 0}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] buttons encontrados: {json.dumps(button_debug.get('buttons') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] inputs submit/button encontrados: {json.dumps(button_debug.get('inputs') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] links encontrados próximos ao form, se houver: {json.dumps(button_debug.get('links') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
            print("[LOGIN_FLOW] error_code final: MANUAL_AUTH_REQUIRED", file=sys.stderr, flush=True)
            raise _typed_login_error("MANUAL_AUTH_REQUIRED", "O portal solicitou autenticação manual/certificado digital.", stage="certificado_digital")

        if snapshot.get("captchaFound"):
            raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="captcha")
        if snapshot.get("errorText"):
            code, typed_message = _classify_login_issue(None, snapshot.get("errorText") or '', snapshot)
            if code in {"LOGIN_REJECTED", "CAPTCHA_REQUIRED", "MANUAL_AUTH_REQUIRED"}:
                raise _typed_login_error(code, typed_message, stage="erro_texto_portal")

        if snapshot.get("passwordFound"):
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
            try:
                clicked_password, clicked_selector, _ = await _click_login_initial_button(connector)
            except Exception as exc:
                raise _typed_login_error("LOGIN_BUTTON_NOT_FOUND", "Nao consegui acionar o botao de login.", stage="button_password") from exc
            if not clicked_password:
                raise _typed_login_error(
                    "LOGIN_BUTTON_NOT_FOUND",
                    "O sistema nao encontrou o botao de login do portal.",
                    stage="button_password",
                )

            print(f"[LOGIN_FLOW] clique de login executado: {clicked_selector or 'Enter'}", file=sys.stderr, flush=True)
            await connector.page.wait_for_timeout(1500)
            snapshot = await _capture_login_snapshot(connector)
            _log_login_snapshot(snapshot, login, password, "apos-segundo-clique")
            _log_login_flow(snapshot, "apos-segundo-clique", login, password, click_executed=True, final_code="PENDING", certificate_alert=bool(dialog_messages))
        else:
            await connector.page.wait_for_timeout(2500)
            snapshot = await _capture_login_snapshot(connector)
            _log_login_snapshot(snapshot, login, password, "apos-espera-sem-senha")
            _log_login_flow(snapshot, "apos-espera-sem-senha", login, password, click_executed=True, final_code="PENDING", certificate_alert=bool(dialog_messages))

        if dialog_messages:
            joined = " | ".join(dialog_messages).lower()
            if "certificado" in joined or "login-identific" in joined or "nao encontrado" in joined or "n?o encontrado" in joined:
                raise _typed_login_error("MANUAL_AUTH_REQUIRED", "O portal solicitou autenticacao manual por certificado digital.", stage="alerta_certificado")

        if snapshot.get("captchaFound"):
            raise _typed_login_error("CAPTCHA_REQUIRED", "O portal solicitou validacao manual.", stage="captcha")
        if snapshot.get("successFound") or snapshot.get("operacionalFound") or snapshot.get("consultaMargemFound"):
            pass
        elif snapshot.get("loginPageVisible") or snapshot.get("loginFound"):
            if snapshot.get("errorText"):
                code, typed_message = _classify_login_issue(None, snapshot.get("errorText") or '', snapshot)
                if code == "LOGIN_REJECTED":
                    raise _typed_login_error(code, typed_message, stage="erro_texto_portal")
                if code in {"MANUAL_AUTH_REQUIRED", "CAPTCHA_REQUIRED"}:
                    raise _typed_login_error(code, typed_message, stage="erro_texto_portal")
            if snapshot.get("host") and "login-identific" in str(snapshot.get("host") or '').lower():
                raise _typed_login_error("MANUAL_AUTH_REQUIRED", "O portal solicitou autenticacao manual por certificado digital.", stage="certificado")
            raise _typed_login_error("LOGIN_STILL_ON_SAME_PAGE", "O portal permaneceu na tela de login sem confirmar autenticacao.", stage="mesma_tela")
        else:
            if snapshot.get("host") and ("login-identific" in str(snapshot.get("host") or '').lower() or 'certificadodigital' in str(snapshot.get("url") or '').lower()):
                raise _typed_login_error("MANUAL_AUTH_REQUIRED", "O portal solicitou autenticação manual/certificado digital.", stage="certificado_digital")
            print(f"[LOGIN_FLOW] quantidade de frames: {button_debug.get('frameCount') or 0}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] buttons encontrados: {json.dumps(button_debug.get('buttons') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] inputs submit/button encontrados: {json.dumps(button_debug.get('inputs') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
            print(f"[LOGIN_FLOW] links encontrados próximos ao form, se houver: {json.dumps(button_debug.get('links') or [], ensure_ascii=False)}", file=sys.stderr, flush=True)
            raise _typed_login_error("SELECTOR_ERROR", "O layout do portal mudou e o fluxo de login nao foi reconhecido.", stage="selector_check")

        try:
            await connector._select_profile_access()
        except Exception as exc:
            raise _typed_login_error("PORTAL_CHANGED", "Nao foi possivel selecionar o perfil de acesso no portal.", stage="select_profile_access") from exc
        consulta_url = str(connector.settings.pdc_portal_url or "")
        if "Login.aspx" in consulta_url:
            consulta_url = consulta_url.replace("/Login.aspx", "/Margem/ConsultaMargem.aspx")
        elif "Inicial/Inicial.aspx" in consulta_url:
            consulta_url = consulta_url.replace("/Inicial/Inicial.aspx", "/Margem/ConsultaMargem.aspx")
        elif "ConsultaMargem.aspx" not in consulta_url:
            consulta_url = "https://saec.consiglog.com.br/Margem/ConsultaMargem.aspx"
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
        elif code in {"LOGIN_FIELDS_NOT_FOUND", "LOGIN_BUTTON_NOT_FOUND", "LOGIN_TIMEOUT", "LOGIN_STILL_ON_SAME_PAGE", "PORTAL_CHANGED", "UNKNOWN_LOGIN_ERROR", "PORTAL_UNREACHABLE", "DNS_RESOLUTION_FAILED", "CHROMIUM_DNS_FAILED"}:
            status = "erro_login"
        elif not code and not stage and ("browser" in message.lower() or "x server" in message.lower() or "$display" in message.lower()):
            status = "browser_launch_error"
            clean_message = "Erro ao iniciar navegador de consulta no servidor. Verifique configuracao do Playwright/Chromium em producao."
            code = code or "BROWSER_LAUNCH_ERROR"
        elif not code:
            status = "erro"

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
        connector.context = await connector.browser.new_context(viewport={"width": 1440, "height": 1100})
        connector.page = await connector.context.new_page()
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
        elif code == "LOGIN_REJECTED":
            status = "login_error"
        elif code == "LOGIN_OK_NAVIGATION_FAILED":
            status = "login_error"
        elif code == "LOGIN_FIELDS_NOT_FOUND" or code == "LOGIN_BUTTON_NOT_FOUND" or code == "LOGIN_TIMEOUT" or code == "LOGIN_STILL_ON_SAME_PAGE" or code == "PORTAL_CHANGED" or code == "UNKNOWN_LOGIN_ERROR" or code == "PORTAL_UNREACHABLE" or code == "DNS_RESOLUTION_FAILED" or code == "CHROMIUM_DNS_FAILED":
            status = "login_error"
        elif "sessao" in message.lower() and "expir" in message.lower():
            status = "session_expired"
        elif not code and not stage and ("browser" in message.lower() or "x server" in message.lower() or "$display" in message.lower()):
            status = "browser_launch_error"
            clean_message = "Erro ao iniciar navegador de consulta no servidor. Verifique configuracao do Playwright/Chromium em producao."
            code = code or "BROWSER_LAUNCH_ERROR"

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
