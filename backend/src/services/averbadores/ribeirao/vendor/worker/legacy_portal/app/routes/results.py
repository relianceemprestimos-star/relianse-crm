from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.connectors import get_averbadora, normalize_averbadora_codigo
from app.core.config import get_settings
from app.core.database import get_db
from app.models.cliente import Cliente
from app.models.consulta import Consulta
from app.models.lote import Lote
from app.services.export_service import build_export_filename, build_export_rows, export_csv, export_xlsx
from app.utils.security import require_auth

router = APIRouter(prefix="/results", tags=["results"], dependencies=[Depends(require_auth)])


@router.get("/{lote_id}")
def listar_resultados(lote_id: int, db: Session = Depends(get_db)):
    lote = db.get(Lote, lote_id)
    if not lote:
        raise HTTPException(status_code=404, detail="Lote nao encontrado")
    normalized = normalize_averbadora_codigo(lote.averbadora_codigo)
    try:
        av = get_averbadora(normalized)
        averbadora = {"codigo": av.codigo, "nome": av.nome}
    except Exception:
        averbadora = {"codigo": normalized, "nome": normalized}

    query = (
        db.query(Cliente, Consulta)
        .join(Consulta, Consulta.cliente_id == Cliente.id)
        .filter(Cliente.lote_id == lote_id)
        .order_by(Cliente.id.asc())
    )
    rows = []
    for cliente, consulta in query.all():
        payload = consulta.payload_extra or {}
        margem_consignavel = payload.get("facultativa_margem_consignavel")
        margem_disponivel = payload.get("facultativa_disponivel") or consulta.margem_disponivel
        rows.append(
            {
                "cpf": cliente.cpf,
                "nome": payload.get("nome_portal") or cliente.nome,
                "matricula": cliente.matricula,
                "orgao": cliente.orgao,
                "margem_bruta": payload.get("margem_bruta"),
                "margem_consignavel": margem_consignavel,
                "margem_disponivel": margem_disponivel,
                "margem_cartao": consulta.margem_cartao,
                "margem_cartao_beneficio": consulta.margem_cartao_beneficio,
                "facultativa_margem_consignavel": payload.get("facultativa_margem_consignavel"),
                "facultativa_disponivel": payload.get("facultativa_disponivel"),
                "cartao_margem_consignavel": payload.get("cartao_margem_consignavel"),
                "cartao_disponivel": payload.get("cartao_disponivel"),
                "cartao_beneficio_margem_consignavel": payload.get("cartao_beneficio_margem_consignavel"),
                "cartao_beneficio_disponivel": payload.get("cartao_beneficio_disponivel"),
                "status": consulta.status,
                "detalhe_erro": consulta.detalhe_erro,
                "consultado_em": consulta.consultado_em.isoformat() if consulta.consultado_em else None,
                "evidencia_path": consulta.evidencia_path,
            }
        )
    return {"lote_id": lote_id, "averbadora": averbadora, "status_lote": lote.status, "itens": rows}


@router.get("/{lote_id}/export")
def exportar_resultado(lote_id: int, formato: str = "csv", db: Session = Depends(get_db)):
    lote = db.get(Lote, lote_id)
    if not lote:
        raise HTTPException(status_code=404, detail="Lote nao encontrado")

    settings = get_settings()
    rows = build_export_rows(db, lote_id)
    if not rows:
        raise HTTPException(status_code=400, detail="Nao ha resultados para exportar")

    formato = formato.lower()
    if formato not in {"csv", "xlsx"}:
        raise HTTPException(status_code=400, detail="Formato invalido. Use csv ou xlsx")

    filename = build_export_filename(f"lote_{lote_id}", formato)
    target = Path(settings.exports_dir) / filename

    if formato == "csv":
        export_csv(target, rows)
        media = "text/csv"
    else:
        export_xlsx(target, rows)
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

    return FileResponse(path=target, media_type=media, filename=filename)
