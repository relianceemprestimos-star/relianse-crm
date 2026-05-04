from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.credencial import Credencial
from app.services.credenciais_service import credencial_payload_login, marcar_status, registrar_inicio_login
from app.utils.security import require_auth

router = APIRouter(prefix="/manual-auth", tags=["manual-auth"], dependencies=[Depends(require_auth)])


class StartPortalManualAuthIn(BaseModel):
    credencial_id: int = Field(..., ge=1)


class ConfirmPortalManualAuthIn(BaseModel):
    session_id: str
    captcha_value: str
    credencial_id: int | None = Field(default=None, ge=1)


class CancelPortalManualAuthIn(BaseModel):
    session_id: str


@router.post("/portal/start")
async def start_portal_manual_auth(payload: StartPortalManualAuthIn, request: Request, db: Session = Depends(get_db)):
    credencial = db.get(Credencial, payload.credencial_id)
    if not credencial:
        raise HTTPException(status_code=404, detail="Credencial nao encontrada.")
    if not credencial.ativa:
        raise HTTPException(status_code=400, detail="Credencial inativa. Ative antes de iniciar o login manual.")
    if credencial.averbadora_codigo != "portal_secundario_legacy":
        raise HTTPException(
            status_code=400,
            detail="Login manual assistido disponivel apenas para Portal Secundario neste MVP.",
        )

    manager = request.app.state.manual_auth_manager
    cred_payload = credencial_payload_login(credencial)
    try:
        resp = await manager.start_portal_manual_auth(cred_payload)
        if resp.get("captcha_required"):
            marcar_status(db, credencial.id, "captcha_pendente")
        else:
            registrar_inicio_login(db, credencial.id)
            marcar_status(db, credencial.id, "disponivel")
        return resp
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/portal/confirm")
async def confirm_portal_manual_auth(payload: ConfirmPortalManualAuthIn, request: Request, db: Session = Depends(get_db)):
    manager = request.app.state.manual_auth_manager
    try:
        resp = await manager.confirm_portal_manual_auth(
            payload.session_id,
            payload.captcha_value,
            payload.credencial_id,
        )
        cred_id = int(resp.get("credencial_id") or 0)
        if cred_id > 0:
            registrar_inicio_login(db, cred_id)
            marcar_status(db, cred_id, "disponivel")
        return resp
    except Exception as exc:
        message = str(exc)
        lower = message.lower()
        recoverable = (
            "target page" in lower
            or "browser has been closed" in lower
            or "context or browser has been closed" in lower
        )
        if payload.credencial_id and recoverable:
            credencial = db.get(Credencial, payload.credencial_id)
            if credencial and credencial.ativa and credencial.averbadora_codigo == "portal_secundario_legacy":
                cred_payload = credencial_payload_login(credencial)
                resp = await manager.start_portal_manual_auth(cred_payload)
                if resp.get("captcha_required"):
                    marcar_status(db, credencial.id, "captcha_pendente")
                return {
                    **resp,
                    "mensagem": "Sessao anterior expirou. Nova sessao iniciada; digite o novo CAPTCHA para continuar.",
                }
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/portal/cancel")
async def cancel_portal_manual_auth(payload: CancelPortalManualAuthIn, request: Request):
    manager = request.app.state.manual_auth_manager
    await manager.cancel_portal_manual_auth(payload.session_id)
    return {"ok": True, "mensagem": "Login manual cancelado."}

