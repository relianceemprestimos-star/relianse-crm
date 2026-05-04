import csv
from datetime import datetime
from pathlib import Path

from openpyxl import Workbook
from sqlalchemy.orm import Session

from app.models.cliente import Cliente
from app.models.consulta import Consulta
from app.models.lote import Lote


EXPORT_HEADERS = [
    "averbadora_codigo",
    "cpf",
    "nome",
    "matricula",
    "orgao",
    "margem_bruta",
    "margem_consignavel",
    "margem_disponivel",
    "margem_cartao",
    "margem_cartao_beneficio",
    "facultativa_margem_consignavel",
    "facultativa_disponivel",
    "cartao_margem_consignavel",
    "cartao_disponivel",
    "cartao_beneficio_margem_consignavel",
    "cartao_beneficio_disponivel",
    "status",
    "detalhe_erro",
    "consultado_em",
    "evidencia_path",
]


def build_export_rows(db: Session, lote_id: int) -> list[dict]:
    rows = []
    lote = db.get(Lote, lote_id)
    averbadora_codigo = lote.averbadora_codigo if lote else "portal_padrao"
    query = (
        db.query(Cliente, Consulta)
        .join(Consulta, Consulta.cliente_id == Cliente.id)
        .filter(Cliente.lote_id == lote_id)
        .order_by(Cliente.id.asc())
    )
    for cliente, consulta in query.all():
        payload = consulta.payload_extra or {}
        margem_bruta = payload.get("margem_bruta") or ""
        margem_consignavel = payload.get("facultativa_margem_consignavel") or payload.get("facultativa") or ""
        margem_disponivel = payload.get("facultativa_disponivel") or consulta.margem_disponivel or ""
        rows.append(
            {
                "averbadora_codigo": averbadora_codigo or "portal_padrao",
                "cpf": cliente.cpf,
                "nome": payload.get("nome_portal") or cliente.nome or "",
                "matricula": cliente.matricula or "",
                "orgao": cliente.orgao or "",
                "margem_bruta": margem_bruta,
                "margem_consignavel": margem_consignavel,
                "margem_disponivel": margem_disponivel,
                "margem_cartao": consulta.margem_cartao or "",
                "margem_cartao_beneficio": consulta.margem_cartao_beneficio or "",
                "facultativa_margem_consignavel": payload.get("facultativa_margem_consignavel") or "",
                "facultativa_disponivel": payload.get("facultativa_disponivel") or "",
                "cartao_margem_consignavel": payload.get("cartao_margem_consignavel") or "",
                "cartao_disponivel": payload.get("cartao_disponivel") or "",
                "cartao_beneficio_margem_consignavel": payload.get("cartao_beneficio_margem_consignavel") or "",
                "cartao_beneficio_disponivel": payload.get("cartao_beneficio_disponivel") or "",
                "status": consulta.status,
                "detalhe_erro": consulta.detalhe_erro or "",
                "consultado_em": consulta.consultado_em.isoformat() if consulta.consultado_em else "",
                "evidencia_path": consulta.evidencia_path or "",
            }
        )
    return rows


def export_csv(file_path: Path, rows: list[dict]) -> Path:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    with file_path.open("w", newline="", encoding="utf-8") as fp:
        writer = csv.DictWriter(fp, fieldnames=EXPORT_HEADERS, delimiter=";")
        writer.writeheader()
        writer.writerows(rows)
    return file_path


def export_xlsx(file_path: Path, rows: list[dict]) -> Path:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    wb = Workbook()
    ws = wb.active
    ws.title = "resultado"
    ws.append(EXPORT_HEADERS)
    for row in rows:
        ws.append([row.get(column, "") for column in EXPORT_HEADERS])
    wb.save(file_path)
    return file_path


def build_export_filename(prefix: str, suffix: str) -> str:
    now = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{prefix}_{now}.{suffix}"

