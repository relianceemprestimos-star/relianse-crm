import asyncio
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path


CURRENT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = Path(os.getenv("RIBEIRAO_PROJECT_ROOT") or CURRENT_DIR / "vendor" / "worker" / "legacy_portal")
if not (PROJECT_ROOT / "app").exists() and (PROJECT_ROOT / "legacy_portal" / "app").exists():
    PROJECT_ROOT = PROJECT_ROOT / "legacy_portal"
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.core.config import Settings  # noqa: E402
from app.services.margem_consulta import MargemConsultaService  # noqa: E402


def read_payload() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def safe_result(result) -> dict:
    payload = asdict(result)
    consultado = payload.get("consultado_em")
    if consultado is not None:
        payload["consultado_em"] = consultado.isoformat()
    return payload


async def run(payload: dict) -> dict:
    cpf = "".join(ch for ch in str(payload.get("cpf") or "") if ch.isdigit())
    if len(cpf) != 11:
        return {
            "status": "erro",
            "detalhe_erro": "CPF invalido para consulta no Amapa.",
            "payload_extra": {"code": "INVALID_CPF"},
        }

    login = str(payload.get("login") or payload.get("username") or os.getenv("AMAPA_USERNAME") or "").strip()
    password = str(payload.get("password") or os.getenv("AMAPA_PASSWORD") or "")
    if not login or not password:
        return {
            "status": "erro",
            "detalhe_erro": "Credencial do Governo do Amapa nao configurada.",
            "payload_extra": {"code": "CREDENTIAL_NOT_CONFIGURED"},
        }

    settings = Settings(
        portal_url=str(os.getenv("AMAPA_PORTAL_URL") or "https://consignataria.apconsig.ap.gov.br/login"),
        margem_url=str(os.getenv("AMAPA_MARGEM_URL") or "https://consignataria.apconsig.ap.gov.br/servidores"),
        portal_username=login,
        portal_password=password,
        timeout_ms=int(payload.get("timeout_ms") or os.getenv("AMAPA_TIMEOUT_MS") or 30000),
        retry_attempts=int(payload.get("retry_attempts") or 1),
        intervalo_entre_consultas_ms=int(payload.get("intervalo_ms") or 1000),
        headless=bool(payload.get("headless", True)),
        capture_pdf=False,
        capture_screenshot_on_success=False,
        mascarar_cpf_logs=True,
        selector_login_user="input[name='cpf'], input#cpf, #cpf, input[name='login']",
        selector_login_submit="button:has-text('Login'), button[type='submit']:not(:has-text('gov.br')), input[type='submit']",
        selector_logged_indicator="text=Servidor || text=Servidores || text=Margem",
        selector_menu_servidores="text=Servidores || text=Servidor || a[href*='servidores']",
        selector_cpf_input="input[name*='cpf' i], input[id*='cpf' i], input[placeholder*='CPF' i], input[type='text']",
    )

    service = MargemConsultaService(lote_id=int(payload.get("batch_id") or 0), settings=settings)
    try:
        await service.start()
        result = await service.consultar_cliente(cpf)
        data = safe_result(result)
        data["cpf"] = cpf
        return data
    finally:
        try:
            await service.close()
        except Exception:
            pass


def main() -> None:
    try:
        payload = read_payload()
        result = asyncio.run(run(payload))
        print(json.dumps(result, ensure_ascii=False), flush=True)
    except Exception as exc:
        print(
            json.dumps(
                {
                    "status": "erro",
                    "detalhe_erro": str(exc),
                    "payload_extra": {"code": "WORKER_INTERNAL_ERROR"},
                },
                ensure_ascii=False,
            ),
            flush=True,
        )


if __name__ == "__main__":
    main()
