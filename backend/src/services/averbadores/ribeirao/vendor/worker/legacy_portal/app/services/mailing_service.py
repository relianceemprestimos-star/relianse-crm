from __future__ import annotations

import asyncio
import csv
from datetime import datetime, timedelta
from pathlib import Path

from openpyxl import Workbook, load_workbook
from sqlalchemy.orm import Session

from app.connectors import create_connector
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.mailing import Mailing
from app.services.credenciais_service import (
    credencial_payload_login,
    marcar_status,
    registrar_inicio_login,
    registrar_uso_consulta,
    selecionar_credencial_para_execucao,
)
from app.utils.cpf import normalize_cpf
from app.utils.logger import get_logger


RETENTION_DAYS = 15
RESULT_HEADERS = [
    "cpf",
    "matricula",
    "status_consulta",
    "mensagem",
    "nome",
    "margem_facultativa_consignavel",
    "margem_facultativa_disponivel",
    "margem_cartao_consignavel",
    "margem_cartao_disponivel",
    "margem_cartao_beneficio_consignavel",
    "margem_cartao_beneficio_disponivel",
    "margem_disponivel",
    "evidencia_path",
    "processado_em",
]


def _normalize_header(raw: str) -> str:
    return str(raw or "").strip().lower().replace(" ", "").replace("_", "")


def _detect_delimiter(sample: str) -> str:
    return ";" if sample.count(";") >= sample.count(",") else ","


def _find_dict_value(
    normalized: dict[str, str],
    *,
    exact_names: list[str],
    partial_names: list[str] | None = None,
) -> str:
    normalized_exact = {_normalize_header(item) for item in exact_names}
    for key, value in normalized.items():
        if key in normalized_exact:
            return str(value or "")

    if partial_names:
        partial = [_normalize_header(item) for item in partial_names]
        for key, value in normalized.items():
            if any(piece in key for piece in partial):
                return str(value or "")
    return ""


def _find_header_index(headers: list[str], names: list[str]) -> int | None:
    normalized_names = [_normalize_header(name) for name in names]
    for idx, header in enumerate(headers):
        if header in normalized_names:
            return idx
    for idx, header in enumerate(headers):
        if any(name in header for name in normalized_names):
            return idx
    return None


def _pick_first(source: dict[str, str], *keys: str) -> str:
    for key in keys:
        value = source.get(_normalize_header(key), "")
        if str(value or "").strip():
            return str(value).strip()
    return ""


def parse_input_rows(file_path: Path) -> list[dict]:
    ext = file_path.suffix.lower()
    if ext in {".xlsx", ".xlsm"}:
        return _parse_xlsx_rows(file_path)
    if ext in {".csv", ".txt"}:
        return _parse_csv_rows(file_path)
    raise ValueError("Formato nao suportado. Use .xlsx, .csv ou .txt")


def _parse_xlsx_rows(file_path: Path) -> list[dict]:
    wb = load_workbook(filename=file_path, read_only=True, data_only=True)
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    header_row = next(rows_iter, None)
    if not header_row:
        wb.close()
        return []

    headers = [_normalize_header(col) for col in header_row]
    idx_cpf = _find_header_index(headers, ["cpf", "cpf do servidor", "cpfdoservidor"])
    idx_matricula = _find_header_index(
        headers,
        ["matricula", "matrÃ­cula", "registro", "identificacao", "identificaÃ§Ã£o"],
    )

    items: list[dict] = []
    for row in rows_iter:
        cpf_value = row[idx_cpf] if idx_cpf is not None and idx_cpf < len(row) else ""
        matricula_value = row[idx_matricula] if idx_matricula is not None and idx_matricula < len(row) else ""
        cpf = normalize_cpf(str(cpf_value or ""))
        matricula = str(matricula_value or "").strip()

        if not cpf and not matricula and row:
            first_value = str(row[0] or "").strip()
            cpf = normalize_cpf(first_value)
            if not cpf:
                matricula = first_value

        items.append({"cpf": cpf, "matricula": matricula})
    wb.close()
    return items


def _parse_csv_rows(file_path: Path) -> list[dict]:
    content = file_path.read_text(encoding="utf-8-sig", errors="ignore")
    lines = [line for line in content.splitlines() if line.strip()]
    if not lines:
        return []

    if file_path.suffix.lower() == ".txt":
        items = []
        for line in lines:
            raw = line.strip()
            cpf = normalize_cpf(raw)
            items.append({"cpf": cpf, "matricula": "" if cpf else raw})
        return items

    delimiter = _detect_delimiter(lines[0])
    reader = csv.DictReader(lines, delimiter=delimiter)
    items: list[dict] = []

    for row in reader:
        normalized = {_normalize_header(k): str(v or "") for k, v in row.items() if k is not None}
        cpf_raw = _find_dict_value(
            normalized,
            exact_names=["cpf", "cpfdoservidor", "cpfservidor"],
            partial_names=["cpf"],
        )
        matricula_raw = _find_dict_value(
            normalized,
            exact_names=["matricula", "registro", "identificacao"],
            partial_names=["matricula", "registro", "identificacao"],
        )

        cpf = normalize_cpf(cpf_raw)
        matricula = matricula_raw.strip()

        if not cpf and not matricula and row:
            values = [str(v or "").strip() for v in row.values() if str(v or "").strip()]
            if values:
                cpf = normalize_cpf(values[0])
                if not cpf:
                    matricula = values[0]

        items.append({"cpf": cpf, "matricula": matricula})
    return items


def _build_result_row_from_portal(item: dict, consulta_result) -> tuple[dict, bool]:
    now_iso = datetime.utcnow().isoformat()
    cpf = normalize_cpf(item.get("cpf", ""))
    matricula = (item.get("matricula") or "").strip()
    payload = consulta_result.payload_extra or {}

    fac_consignavel = payload.get("facultativa_margem_consignavel") or ""
    fac_disponivel = payload.get("facultativa_disponivel") or consulta_result.margem_disponivel or ""
    cart_consignavel = payload.get("cartao_margem_consignavel") or ""
    cart_disponivel = payload.get("cartao_disponivel") or consulta_result.margem_cartao or ""
    ben_consignavel = payload.get("cartao_beneficio_margem_consignavel") or ""
    ben_disponivel = payload.get("cartao_beneficio_disponivel") or consulta_result.margem_cartao_beneficio or ""

    status_ok = str(consulta_result.status or "").lower() == "sucesso"
    detail = (consulta_result.detalhe_erro or "").strip()
    row = {
        "cpf": cpf,
        "matricula": matricula,
        "status_consulta": "sucesso" if status_ok else "erro",
        "mensagem": "Consulta concluida no portal." if status_ok else (detail or "Falha ao consultar no portal."),
        "nome": payload.get("nome_portal") or "",
        "margem_facultativa_consignavel": fac_consignavel,
        "margem_facultativa_disponivel": fac_disponivel,
        "margem_cartao_consignavel": cart_consignavel,
        "margem_cartao_disponivel": cart_disponivel,
        "margem_cartao_beneficio_consignavel": ben_consignavel,
        "margem_cartao_beneficio_disponivel": ben_disponivel,
        "margem_disponivel": fac_disponivel,
        "evidencia_path": consulta_result.evidencia_path or "",
        "processado_em": (consulta_result.consultado_em.isoformat() if consulta_result.consultado_em else now_iso),
    }
    return row, (not status_ok)


def _build_manual_error_row(item: dict, message: str) -> dict:
    return {
        "cpf": normalize_cpf(item.get("cpf", "")),
        "matricula": (item.get("matricula") or "").strip(),
        "status_consulta": "erro",
        "mensagem": message,
        "nome": "",
        "margem_facultativa_consignavel": "",
        "margem_facultativa_disponivel": "",
        "margem_cartao_consignavel": "",
        "margem_cartao_disponivel": "",
        "margem_cartao_beneficio_consignavel": "",
        "margem_cartao_beneficio_disponivel": "",
        "margem_disponivel": "",
        "evidencia_path": "",
        "processado_em": datetime.utcnow().isoformat(),
    }


def build_unit_result_row(item: dict, consulta_result) -> tuple[dict, bool]:
    """Wrapper publico para reaproveitar o mesmo formato do processamento em lote."""
    return _build_result_row_from_portal(item, consulta_result)


def build_unit_error_row(item: dict, message: str) -> dict:
    """Wrapper publico para linha de erro no mesmo padrao do lote."""
    return _build_manual_error_row(item, message)


def _final_status(sucessos: int, erros: int) -> str:
    if erros == 0:
        return "concluido"
    if sucessos == 0:
        return "erro"
    return "falha_parcial"


def export_result_xlsx(file_path: Path, rows: list[dict]) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "resultado"
    ws.append(RESULT_HEADERS)
    for row in rows:
        ws.append([row.get(col, "") for col in RESULT_HEADERS])
    file_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(file_path)


def extract_error_rows_from_result(file_path: Path) -> list[dict]:
    wb = load_workbook(filename=file_path, read_only=True, data_only=True)
    ws = wb.active
    rows_iter = ws.iter_rows(values_only=True)
    header_row = next(rows_iter, None)
    if not header_row:
        wb.close()
        return []

    headers = [str(item or "").strip() for item in header_row]
    normalized_headers = [_normalize_header(item) for item in headers]
    idx_status = _find_header_index(normalized_headers, ["status_consulta", "statusconsulta"])
    if idx_status is None:
        wb.close()
        return []

    output: list[dict] = []
    for raw_row in rows_iter:
        row_values = list(raw_row or [])
        status_value = str(row_values[idx_status] if idx_status < len(row_values) else "").strip().lower()
        if status_value != "erro":
            continue

        raw_dict: dict[str, str] = {}
        for idx, header in enumerate(headers):
            key = _normalize_header(header)
            raw_dict[key] = str(row_values[idx] if idx < len(row_values) else "")

        output.append(
            {
                "cpf": _pick_first(raw_dict, "cpf"),
                "matricula": _pick_first(raw_dict, "matricula"),
                "status_consulta": "erro",
                "mensagem": _pick_first(raw_dict, "mensagem", "detalhe_erro"),
                "nome": _pick_first(raw_dict, "nome"),
                "margem_facultativa_consignavel": _pick_first(
                    raw_dict,
                    "margem_facultativa_consignavel",
                    "margem_facultativa",
                    "facultativa_margem_consignavel",
                ),
                "margem_facultativa_disponivel": _pick_first(
                    raw_dict,
                    "margem_facultativa_disponivel",
                    "margem_disponivel",
                    "facultativa_disponivel",
                ),
                "margem_cartao_consignavel": _pick_first(
                    raw_dict,
                    "margem_cartao_consignavel",
                    "cartao_margem_consignavel",
                ),
                "margem_cartao_disponivel": _pick_first(
                    raw_dict,
                    "margem_cartao_disponivel",
                    "margem_cartao",
                    "cartao_disponivel",
                ),
                "margem_cartao_beneficio_consignavel": _pick_first(
                    raw_dict,
                    "margem_cartao_beneficio_consignavel",
                    "cartao_beneficio_margem_consignavel",
                ),
                "margem_cartao_beneficio_disponivel": _pick_first(
                    raw_dict,
                    "margem_cartao_beneficio_disponivel",
                    "margem_cartao_beneficio",
                    "cartao_beneficio_disponivel",
                ),
                "margem_disponivel": _pick_first(
                    raw_dict,
                    "margem_disponivel",
                    "margem_facultativa_disponivel",
                ),
                "evidencia_path": _pick_first(raw_dict, "evidencia_path"),
                "processado_em": _pick_first(raw_dict, "processado_em"),
            }
        )
    wb.close()
    return output


def cleanup_expired_mailings(db: Session) -> int:
    now = datetime.utcnow()
    expired = db.query(Mailing).filter(Mailing.expira_em <= now).all()
    deleted = 0
    for item in expired:
        for target in [item.arquivo_path, item.resultado_path]:
            if not target:
                continue
            try:
                path = Path(target)
                if path.exists():
                    path.unlink()
            except Exception:
                pass
        db.delete(item)
        deleted += 1
    if deleted:
        db.commit()
    return deleted


class MailingProcessor:
    def __init__(self):
        self.settings = get_settings()
        self.logger = get_logger("mailing-processor")
        self.active_tasks: dict[int, asyncio.Task] = {}

    async def _run(self, mailing_id: int) -> None:
        db = SessionLocal()
        connector = None
        credencial_id: int | None = None
        try:
            mailing = db.get(Mailing, mailing_id)
            if not mailing:
                return

            mailing.status = "processando"
            mailing.detalhe_erro = None
            mailing.processados = 0
            mailing.sucessos = 0
            mailing.erros = 0
            mailing.processado_em = None
            mailing.resultado_path = None
            db.commit()

            input_rows = parse_input_rows(Path(mailing.arquivo_path))
            total = len(input_rows)
            mailing.total_registros = total
            db.commit()

            if total == 0:
                mailing.status = "erro"
                mailing.detalhe_erro = "Arquivo sem registros para processar."
                mailing.processado_em = datetime.utcnow()
                db.commit()
                return

            credencial_payload = None
            credencial = selecionar_credencial_para_execucao(db, mailing.averbadora_codigo)
            if credencial:
                credencial_payload = credencial_payload_login(credencial)
                credencial_id = credencial.id
                registrar_inicio_login(db, credencial_id)
            elif mailing.averbadora_codigo == "portal_secundario_legacy":
                raise RuntimeError(
                    "Nao ha credencial ativa para esta averbadora. "
                    "Cadastre/ative uma credencial e conclua o login manual assistido (captcha)."
                )

            connector = create_connector(mailing.averbadora_codigo, lote_id=mailing_id, credencial=credencial_payload)
            startup_timeout_seconds = max(60, int(self.settings.timeout_ms / 1000) * 5)
            await asyncio.wait_for(connector.start(), timeout=startup_timeout_seconds)

            result_rows: list[dict] = []
            sucessos = 0
            erros = 0

            for idx, item in enumerate(input_rows, start=1):
                cpf = normalize_cpf(item.get("cpf", ""))
                if not cpf:
                    row = _build_manual_error_row(
                        item,
                        "Registro sem CPF. Consulta real requer CPF para essa averbadora.",
                    )
                    has_error = True
                    error_text = row["mensagem"]
                else:
                    consulta_result = await connector.consultar_cliente(cpf)
                    row, has_error = _build_result_row_from_portal(item, consulta_result)
                    error_text = consulta_result.detalhe_erro if has_error else None

                result_rows.append(row)
                if has_error:
                    erros += 1
                else:
                    sucessos += 1

                mailing.processados = idx
                mailing.sucessos = sucessos
                mailing.erros = erros
                db.commit()

                if credencial_id and cpf:
                    registrar_uso_consulta(db, credencial_id, erro=error_text if has_error else None)

                await asyncio.sleep(0)

            result_path = Path(self.settings.exports_dir) / f"mailing_{mailing.id}_resultado.xlsx"
            export_result_xlsx(result_path, result_rows)

            mailing.status = _final_status(sucessos, erros)
            mailing.resultado_path = str(result_path)
            mailing.processados = total
            mailing.sucessos = sucessos
            mailing.erros = erros
            mailing.processado_em = datetime.utcnow()
            if mailing.status == "falha_parcial":
                mailing.detalhe_erro = f"{erros} de {total} consultas com erro."
            elif mailing.status == "erro":
                mailing.detalhe_erro = f"Todas as consultas falharam ({erros}/{total})."
            else:
                mailing.detalhe_erro = None
            db.commit()
        except Exception as exc:
            error_text = str(exc or "")
            if credencial_id and error_text:
                lower = error_text.lower()
                if "captcha" in lower or "sessao" in lower or "sessao manual" in lower:
                    try:
                        marcar_status(db, credencial_id, "captcha_pendente")
                    except Exception:
                        pass
            mailing = db.get(Mailing, mailing_id)
            if mailing:
                mailing.status = "erro"
                mailing.detalhe_erro = error_text
                mailing.processado_em = datetime.utcnow()
                mailing.resultado_path = None
                db.commit()
            self.logger.exception("Falha no processamento do mailing=%s", mailing_id)
        finally:
            if connector:
                try:
                    await connector.close()
                except Exception:
                    pass
            db.close()
            self.active_tasks.pop(mailing_id, None)

    def start(self, mailing_id: int) -> None:
        if mailing_id in self.active_tasks and not self.active_tasks[mailing_id].done():
            raise RuntimeError("Este mailing ja esta sendo processado.")
        self.active_tasks[mailing_id] = asyncio.create_task(self._run(mailing_id))


def build_mailing_metadata(nome_arquivo: str, arquivo_path: Path) -> dict:
    now = datetime.utcnow()
    total = 0
    try:
        total = len(parse_input_rows(arquivo_path))
    except Exception:
        total = 0

    return {
        "nome_arquivo": nome_arquivo,
        "arquivo_path": str(arquivo_path),
        "status": "enviado",
        "total_registros": total,
        "processados": 0,
        "sucessos": 0,
        "erros": 0,
        "expira_em": now + timedelta(days=RETENTION_DAYS),
    }

