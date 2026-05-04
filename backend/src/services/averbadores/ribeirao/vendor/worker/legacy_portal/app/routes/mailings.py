from datetime import datetime
from pathlib import Path

from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.connectors import create_connector
from app.core.config import get_settings
from app.core.database import get_db
from app.models.averbadora import Averbadora
from app.models.mailing import Mailing
from app.services.credenciais_service import (
    credencial_payload_login,
    marcar_status,
    registrar_inicio_login,
    registrar_uso_consulta,
    selecionar_credencial_para_execucao,
)
from app.services.mailing_service import (
    build_unit_error_row,
    build_unit_result_row,
    build_mailing_metadata,
    cleanup_expired_mailings,
    export_result_xlsx,
    extract_error_rows_from_result,
)
from app.utils.cpf import normalize_cpf
from app.utils.security import require_auth

router = APIRouter(prefix="/mailings", tags=["mailings"], dependencies=[Depends(require_auth)])


class ConsultaUnitariaIn(BaseModel):
    averbadora_codigo: str = Field(..., min_length=2, max_length=80)
    cpf: str = ""
    matricula: str = ""


def _resolve_status_exibicao(item: Mailing) -> tuple[str, str]:
    status = (item.status or "").strip().lower()
    if status in {"enviado", "processando"}:
        return "em_andamento", "Em andamento"
    if status == "falha_parcial":
        return "falha_parcial", "Falha parcial"
    if status == "erro":
        return "erro", "Erro"
    if status == "concluido":
        if int(item.erros or 0) > 0 and int(item.sucessos or 0) == 0:
            return "erro", "Erro"
        if int(item.erros or 0) > 0:
            return "falha_parcial", "Falha parcial"
        return "concluido", "Concluido"
    return "em_andamento", "Em andamento"


def _resolve_mensagem_final(item: Mailing) -> str:
    status_tipo, _ = _resolve_status_exibicao(item)
    if status_tipo == "em_andamento":
        return "Processamento em andamento."
    if status_tipo == "concluido":
        return "Processamento concluido com sucesso."
    if status_tipo == "falha_parcial":
        return "Processamento concluido com falhas parciais."
    return item.detalhe_erro or "Processamento finalizado com erro."


def _mailing_to_dict(item: Mailing) -> dict:
    resultado_disponivel = bool(item.resultado_path and Path(item.resultado_path).exists())
    total = max(0, int(item.total_registros or 0))
    processados = max(0, int(item.processados or 0))
    pendentes = max(0, total - processados)
    divisor = total if total > 0 else (processados if processados > 0 else 1)
    progresso_percentual = int(round((processados / divisor) * 100))
    status_tipo, status_exibicao = _resolve_status_exibicao(item)

    return {
        "id": item.id,
        "averbadora_codigo": item.averbadora_codigo,
        "arquivo": item.nome_arquivo,
        "status": item.status,
        "status_tipo": status_tipo,
        "status_exibicao": status_exibicao,
        "total_registros": item.total_registros,
        "processados": item.processados,
        "pendentes": pendentes,
        "progresso_percentual": progresso_percentual,
        "sucessos": item.sucessos,
        "erros": item.erros,
        "detalhe_erro": item.detalhe_erro,
        "mensagem_final": _resolve_mensagem_final(item),
        "criado_em": item.criado_em.isoformat() if item.criado_em else None,
        "processado_em": item.processado_em.isoformat() if item.processado_em else None,
        "expira_em": item.expira_em.isoformat() if item.expira_em else None,
        "resultado_disponivel": resultado_disponivel,
        "resultado_erros_disponivel": bool(resultado_disponivel and int(item.erros or 0) > 0),
    }


@router.get("")
def listar(db: Session = Depends(get_db)):
    cleanup_expired_mailings(db)
    items = db.query(Mailing).order_by(Mailing.criado_em.desc()).limit(200).all()
    return {"itens": [_mailing_to_dict(item) for item in items]}


@router.post("/upload")
async def upload(
    file: UploadFile = File(...),
    averbadora_codigo: str = Form(...),
    db: Session = Depends(get_db),
):
    cleanup_expired_mailings(db)
    averbadora_codigo = (averbadora_codigo or "").strip().lower()
    av = db.get(Averbadora, averbadora_codigo)
    if not av or not av.ativa:
        raise HTTPException(status_code=404, detail="Averbadora nao encontrada ou inativa.")

    filename = file.filename or f"mailing_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.xlsx"
    ext = filename.lower().rsplit(".", maxsplit=1)[-1] if "." in filename else ""
    if ext not in {"xlsx", "xlsm", "csv", "txt"}:
        raise HTTPException(status_code=400, detail="Formato invalido. Use .xlsx, .csv ou .txt")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Arquivo vazio.")

    settings = get_settings()
    tmp_path = settings.uploads_dir / f"mailing_tmp_{datetime.utcnow().strftime('%Y%m%d_%H%M%S_%f')}_{filename}"
    tmp_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path.write_bytes(raw)

    payload = build_mailing_metadata(filename, tmp_path)
    mailing = Mailing(averbadora_codigo=averbadora_codigo, **payload)
    db.add(mailing)
    db.flush()

    final_path = settings.uploads_dir / f"mailing_{mailing.id}_{filename}"
    final_path.write_bytes(raw)
    try:
        tmp_path.unlink(missing_ok=True)
    except Exception:
        pass

    mailing.arquivo_path = str(final_path)
    db.commit()
    db.refresh(mailing)
    return _mailing_to_dict(mailing)


@router.post("/{mailing_id}/processar")
async def processar(mailing_id: int, request: Request, db: Session = Depends(get_db)):
    cleanup_expired_mailings(db)
    mailing = db.get(Mailing, mailing_id)
    if not mailing:
        raise HTTPException(status_code=404, detail="Mailing nao encontrado.")
    if mailing.status == "processando":
        raise HTTPException(status_code=409, detail="Mailing ja esta em processamento.")

    manager = request.app.state.mailing_processor
    try:
        manager.start(mailing_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return {"ok": True, "mailing_id": mailing_id, "status": "processando"}


@router.get("/{mailing_id}")
def detalhe(mailing_id: int, db: Session = Depends(get_db)):
    cleanup_expired_mailings(db)
    mailing = db.get(Mailing, mailing_id)
    if not mailing:
        raise HTTPException(status_code=404, detail="Mailing nao encontrado.")
    return _mailing_to_dict(mailing)


@router.get("/{mailing_id}/download")
def download(mailing_id: int, db: Session = Depends(get_db)):
    cleanup_expired_mailings(db)
    mailing = db.get(Mailing, mailing_id)
    if not mailing:
        raise HTTPException(status_code=404, detail="Mailing nao encontrado.")
    if not mailing.resultado_path:
        raise HTTPException(status_code=400, detail="Resultado ainda nao disponivel.")
    path = Path(mailing.resultado_path)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Arquivo de resultado nao encontrado.")
    return FileResponse(
        path=path,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=path.name,
    )


@router.get("/{mailing_id}/download-erros")
def download_erros(mailing_id: int, db: Session = Depends(get_db)):
    cleanup_expired_mailings(db)
    mailing = db.get(Mailing, mailing_id)
    if not mailing:
        raise HTTPException(status_code=404, detail="Mailing nao encontrado.")
    if not mailing.resultado_path:
        raise HTTPException(status_code=400, detail="Resultado ainda nao disponivel.")

    source_path = Path(mailing.resultado_path)
    if not source_path.exists():
        raise HTTPException(status_code=404, detail="Arquivo de resultado nao encontrado.")

    rows = extract_error_rows_from_result(source_path)
    if not rows:
        raise HTTPException(status_code=400, detail="Nao existem registros com erro neste mailing.")

    settings = get_settings()
    out_path = settings.exports_dir / f"mailing_{mailing.id}_apenas_erros.xlsx"
    export_result_xlsx(out_path, rows)
    return FileResponse(
        path=out_path,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=out_path.name,
    )


@router.post("/consulta-unitaria")
async def consulta_unitaria(payload: ConsultaUnitariaIn, db: Session = Depends(get_db)):
    cleanup_expired_mailings(db)
    averbadora_codigo = (payload.averbadora_codigo or "").strip().lower()
    av = db.get(Averbadora, averbadora_codigo)
    if not av or not av.ativa:
        raise HTTPException(status_code=404, detail="Averbadora nao encontrada ou inativa.")

    cpf = normalize_cpf(payload.cpf)
    matricula = str(payload.matricula or "").strip()
    if not cpf:
        raise HTTPException(
            status_code=400,
            detail=(
                "Consulta unitaria requer CPF valido para o conector atual. "
                "Informe um CPF com 11 digitos."
            ),
        )

    credencial_id: int | None = None
    credencial_payload: dict | None = None
    credencial = selecionar_credencial_para_execucao(db, averbadora_codigo)
    if credencial:
        credencial_payload = credencial_payload_login(credencial)
        credencial_id = credencial.id
        registrar_inicio_login(db, credencial_id)
    elif averbadora_codigo == "portal_secundario_legacy":
        raise HTTPException(
            status_code=400,
            detail=(
                "Nao ha credencial ativa para esta averbadora. "
                "Cadastre/ative uma credencial e conclua o login manual assistido (captcha)."
            ),
        )

    connector = create_connector(averbadora_codigo, lote_id=0, credencial=credencial_payload)
    item = {"cpf": cpf, "matricula": matricula}
    try:
        await connector.start()
        consulta = await connector.consultar_cliente(cpf)
        row, has_error = build_unit_result_row(item, consulta)
        if credencial_id:
            registrar_uso_consulta(db, credencial_id, erro=consulta.detalhe_erro if has_error else None)
        return {"ok": not has_error, "resultado": row}
    except Exception as exc:
        error_text = str(exc or "Falha na consulta unitaria.")
        if credencial_id:
            try:
                registrar_uso_consulta(db, credencial_id, erro=error_text)
                lower = error_text.lower()
                if "captcha" in lower or "sessao" in lower:
                    marcar_status(db, credencial_id, "captcha_pendente")
            except Exception:
                pass
        row = build_unit_error_row(item, error_text)
        return {"ok": False, "resultado": row}
    finally:
        try:
            await connector.close()
        except Exception:
            pass

