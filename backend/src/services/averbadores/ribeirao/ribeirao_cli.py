from __future__ import annotations

import asyncio
import json
import os
import re
import sys
from dataclasses import asdict, is_dataclass
from datetime import datetime, timezone
from pathlib import Path

from playwright.async_api import async_playwright


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


def _is_placeholder_url(url: str) -> bool:
    normalized = str(url or "").strip().lower()
    return not normalized or "exemplo.local" in normalized or "example.local" in normalized


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
    settings.headless = bool(payload.get("headless", False))
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
    password = str(payload.get("password") or os.getenv("RIBEIRAO_AVERBADOR_PASSWORD") or "").strip()
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
    await connector.page.goto(connector.settings.pdc_portal_url, wait_until="domcontentloaded", timeout=max(45000, connector.settings.timeout_ms))
    await connector.page.wait_for_timeout(800)
    try:
        await connector.page.locator("#entendi-cookies").click(timeout=2000)
    except Exception:
        try:
            await connector.page.locator("button:has-text('Continuar e fechar')").click(timeout=2000)
        except Exception:
            pass
    await connector._open_login_entry()
    await connector._open_login_administrativo()
    if not login or not password:
        raise RuntimeError("Login ou senha ausentes para a sessao Ribeirao.")
    if not await connector._fill_login_user(login):
        try:
            await connector.page.locator("#txtLogin").fill(login, timeout=3000)
        except Exception as exc:
            raise RuntimeError("Nao consegui preencher o login.") from exc
    if not await connector._click_login_submit():
        try:
            await connector.page.keyboard.press("Enter")
        except Exception:
            pass
    if not await connector._wait_any("#txtSenha, input[type='password']", 6000):
        raise RuntimeError("Nao consegui abrir a segunda etapa de login.")
    if not await connector._fill_login_password(password):
        try:
            await connector.page.locator("#txtSenha").fill(password, timeout=3000)
        except Exception as exc:
            raise RuntimeError("Nao consegui preencher a senha.") from exc
    if not await connector._click_login_submit():
        try:
            await connector.page.keyboard.press("Enter")
        except Exception:
            pass
    await connector.page.wait_for_timeout(1200)
    try:
        if await connector._wait_any("#ucAjaxModalPopupConfirmacao1_btnConfirmarPopup", 1200):
            await connector.page.locator("#ucAjaxModalPopupConfirmacao1_btnConfirmarPopup").click(timeout=3000)
            await connector.page.wait_for_timeout(1200)
    except Exception:
        pass
    await connector._select_profile_access()
    consulta_url = str(connector.settings.pdc_portal_url or "")
    if "Login.aspx" in consulta_url:
        consulta_url = consulta_url.replace("/Login.aspx", "/Margem/ConsultaMargem.aspx")
    elif "Inicial/Inicial.aspx" in consulta_url:
        consulta_url = consulta_url.replace("/Inicial/Inicial.aspx", "/Margem/ConsultaMargem.aspx")
    elif "ConsultaMargem.aspx" not in consulta_url:
        consulta_url = "https://saec.consiglog.com.br/Margem/ConsultaMargem.aspx"
    await connector.page.goto(
        consulta_url,
        wait_until="domcontentloaded",
        timeout=max(45000, connector.settings.timeout_ms),
    )
    await connector.page.wait_for_timeout(1200)
    await connector._prepare_consulta_context()


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
    password = str(payload.get("password") or os.getenv("RIBEIRAO_AVERBADOR_PASSWORD") or "").strip()
    timeout_seconds = int(payload.get("timeout_seconds") or 900)

    connector = _build_connector(payload, settings)
    connector.playwright = await async_playwright().start()
    connector.browser = await connector.playwright.chromium.launch(
        headless=False,
        slow_mo=int(payload.get("slow_mo") or 0),
    )
    if connector.session_state_path and connector.session_state_path.exists():
        connector.context = await connector.browser.new_context(storage_state=str(connector.session_state_path))
    else:
        connector.context = await connector.browser.new_context(viewport={"width": 1440, "height": 1100})
    connector.page = await connector.context.new_page()

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
        _write_status(session_id, "erro_login", str(exc))
        return {"status": "erro_login", "session_id": session_id, "message": str(exc)}
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
    password = str(payload.get("password") or os.getenv("RIBEIRAO_AVERBADOR_PASSWORD") or "").strip()

    connector = _build_connector(payload, settings)
    if not cpf:
        return {"status": "failed", "message": "CPF invalido", "cpf": ""}

    try:
        connector.playwright = await async_playwright().start()
        connector.browser = await connector.playwright.chromium.launch(
            headless=bool(payload.get("headless", True)),
            slow_mo=int(payload.get("slow_mo") or 0),
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
        message = str(exc)
        status = "erro"
        if "captcha" in message.lower():
            status = "captcha_required"
        elif "sessao" in message.lower() and "expir" in message.lower():
            status = "session_expired"
        elif "login" in message.lower():
            status = "login_error"

        _write_status(session_id, status, message)
        return {
            "ok": False,
            "cpf": cpf,
            "session_id": session_id,
            "status": status,
            "message": message,
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
        if action == "start_session":
            status = "erro_login"
        elif "captcha" in message.lower():
            status = "captcha_required"
        elif "login" in message.lower():
            status = "login_error"
        else:
            status = "erro"
        try:
            _write_status(session_id, status, message)
        except Exception:
            pass
        result = {
            "ok": False,
            "session_id": session_id,
            "status": status,
            "message": message,
        }

    sys.stdout.write(json.dumps(result, ensure_ascii=False, default=str))
    sys.stdout.flush()


if __name__ == "__main__":
    asyncio.run(main_async())
