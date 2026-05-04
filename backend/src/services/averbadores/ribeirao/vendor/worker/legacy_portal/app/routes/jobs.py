from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.connectors import get_averbadora, normalize_averbadora_codigo
from app.core.database import get_db
from app.models.consulta import Consulta
from app.models.lote import Lote
from app.utils.security import require_auth

router = APIRouter(prefix="/jobs", tags=["jobs"], dependencies=[Depends(require_auth)])


@router.get("")
def listar_lotes(db: Session = Depends(get_db)):
    lotes = db.query(Lote).order_by(Lote.id.desc()).limit(50).all()
    def _averbadora_info(codigo: str | None) -> dict:
        normalized = normalize_averbadora_codigo(codigo)
        try:
            info = get_averbadora(normalized)
            return {"codigo": info.codigo, "nome": info.nome}
        except Exception:
            return {"codigo": normalized, "nome": normalized}

    return [
        {
            "id": lote.id,
            "arquivo": lote.nome_arquivo,
            "averbadora": _averbadora_info(lote.averbadora_codigo),
            "status": lote.status,
            "total": lote.total_registros,
            "processados": lote.processados,
            "sucessos": lote.sucessos,
            "erros": lote.erros,
            "pendentes": lote.pendentes,
            "iniciado_em": lote.iniciado_em.isoformat() if lote.iniciado_em else None,
            "finalizado_em": lote.finalizado_em.isoformat() if lote.finalizado_em else None,
        }
        for lote in lotes
    ]


@router.post("/{lote_id}/start")
async def iniciar_lote(lote_id: int, request: Request, db: Session = Depends(get_db)):
    lote = db.get(Lote, lote_id)
    if not lote:
        raise HTTPException(status_code=404, detail="Lote nao encontrado")

    manager = request.app.state.job_service
    try:
        manager.start_job(lote_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    return {"ok": True, "mensagem": "Lote iniciado", "lote_id": lote_id}


@router.post("/{lote_id}/reprocessar-falhas")
async def reprocessar_falhas(lote_id: int, request: Request, db: Session = Depends(get_db)):
    lote = db.get(Lote, lote_id)
    if not lote:
        raise HTTPException(status_code=404, detail="Lote nao encontrado")

    erros = db.query(Consulta).filter(Consulta.lote_id == lote_id, Consulta.status == "erro").count()
    if erros == 0:
        raise HTTPException(status_code=400, detail="Nao ha falhas para reprocessar")

    manager = request.app.state.job_service
    try:
        manager.reprocessar_falhas(lote_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True, "mensagem": "Reprocessamento iniciado", "lote_id": lote_id, "falhas": erros}


@router.get("/{lote_id}/status")
def status_lote(lote_id: int, db: Session = Depends(get_db)):
    lote = db.get(Lote, lote_id)
    if not lote:
        raise HTTPException(status_code=404, detail="Lote nao encontrado")
    normalized = normalize_averbadora_codigo(lote.averbadora_codigo)
    try:
        av_info = get_averbadora(normalized)
        averbadora = {"codigo": av_info.codigo, "nome": av_info.nome}
    except Exception:
        averbadora = {"codigo": normalized, "nome": normalized}

    return {
        "id": lote.id,
        "arquivo": lote.nome_arquivo,
        "averbadora": averbadora,
        "status": lote.status,
        "total": lote.total_registros,
        "processados": lote.processados,
        "sucessos": lote.sucessos,
        "erros": lote.erros,
        "pendentes": lote.pendentes,
        "iniciado_em": lote.iniciado_em.isoformat() if lote.iniciado_em else None,
        "finalizado_em": lote.finalizado_em.isoformat() if lote.finalizado_em else None,
    }
