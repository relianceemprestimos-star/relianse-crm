from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.connectors import normalize_averbadora_codigo
from app.core.database import get_db
from app.models.averbadora import Averbadora
from app.services.credenciais_service import (
    atualizar_credencial,
    criar_credencial,
    excluir_credencial,
    listar_credenciais,
    marcar_status,
    resetar_consumo,
)
from app.utils.security import require_auth
from app.utils.url_tools import normalize_portal_url, slugify_text, suggest_code_from_url, suggest_name_from_url

router = APIRouter(prefix="/credenciais", tags=["credenciais"], dependencies=[Depends(require_auth)])


def _next_available_code(db: Session, base_code: str) -> str:
    base = (base_code or "averbadora").strip("_")[:72] or "averbadora"
    candidate = base
    suffix = 2
    while db.get(Averbadora, candidate):
        candidate = f"{base}_{suffix}"[:80]
        suffix += 1
    return candidate


def _resolve_averbadora_for_credencial(db: Session, payload: "CredencialCreateIn") -> Averbadora:
    if payload.averbadora_codigo:
        codigo = normalize_averbadora_codigo(payload.averbadora_codigo)
        av = db.get(Averbadora, codigo)
        if av:
            return av
        raise HTTPException(status_code=404, detail="Averbadora vinculada nao encontrada.")

    url_base = ""
    if payload.averbadora_link:
        try:
            url_base = normalize_portal_url(payload.averbadora_link)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not url_base:
        raise HTTPException(
            status_code=400,
            detail="Informe o link da averbadora ou selecione um codigo de averbadora existente.",
        )

    exists = db.query(Averbadora).filter(Averbadora.url_base == url_base).first()
    if exists:
        return exists

    nome = (payload.averbadora_nome or "").strip() or suggest_name_from_url(url_base)
    codigo_base = suggest_code_from_url(url_base) or slugify_text(nome)
    codigo = _next_available_code(db, codigo_base)
    nova = Averbadora(
        codigo=codigo,
        nome=nome,
        url_base=url_base,
        descricao="Criada automaticamente via cadastro de credencial.",
        ativa=True,
    )
    db.add(nova)
    db.commit()
    db.refresh(nova)
    return nova


def _attach_averbadora_fields(db: Session, itens: list[dict]) -> list[dict]:
    if not itens:
        return itens

    codigos = list({item["averbadora_codigo"] for item in itens if item.get("averbadora_codigo")})
    averbadoras = db.query(Averbadora).filter(Averbadora.codigo.in_(codigos)).all()
    av_map = {av.codigo: av for av in averbadoras}

    for item in itens:
        av = av_map.get(item.get("averbadora_codigo", ""))
        item["averbadora_nome"] = av.nome if av else item.get("averbadora_codigo", "")
        item["averbadora_url"] = av.url_base if av else ""
    return itens


class CredencialCreateIn(BaseModel):
    averbadora_codigo: str | None = Field(default=None)
    averbadora_link: str | None = Field(default=None)
    averbadora_nome: str | None = Field(default=None)
    usuario: str
    senha: str
    nome_credencial: str = ""
    limite_consultas: int = 450
    ativa: bool = True


class CredencialUpdateIn(BaseModel):
    usuario: str | None = None
    senha: str | None = None
    nome_credencial: str | None = None
    limite_consultas: int | None = None
    ativa: bool | None = None
    status: str | None = None


class StatusIn(BaseModel):
    status: str


@router.get("")
def listar(averbadora_codigo: str | None = None, db: Session = Depends(get_db)):
    codigo = normalize_averbadora_codigo(averbadora_codigo) if averbadora_codigo else None
    itens = listar_credenciais(db, codigo)
    return {"itens": _attach_averbadora_fields(db, itens)}


@router.post("")
def criar(payload: CredencialCreateIn, db: Session = Depends(get_db)):
    if not payload.usuario.strip() or not payload.senha.strip():
        raise HTTPException(status_code=400, detail="Usuario e senha sao obrigatorios")

    av = _resolve_averbadora_for_credencial(db, payload)
    item = criar_credencial(
        db,
        averbadora_codigo=av.codigo,
        usuario=payload.usuario,
        senha=payload.senha,
        nome_credencial=payload.nome_credencial,
        limite_consultas=payload.limite_consultas,
        ativa=payload.ativa,
    )
    return _attach_averbadora_fields(db, [item])[0]


@router.put("/{credencial_id}")
def atualizar(credencial_id: int, payload: CredencialUpdateIn, db: Session = Depends(get_db)):
    try:
        item = atualizar_credencial(
            db,
            credencial_id=credencial_id,
            usuario=payload.usuario,
            senha=payload.senha,
            nome_credencial=payload.nome_credencial,
            limite_consultas=payload.limite_consultas,
            ativa=payload.ativa,
            status=payload.status,
        )
        return _attach_averbadora_fields(db, [item])[0]
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.delete("/{credencial_id}")
def excluir(credencial_id: int, db: Session = Depends(get_db)):
    try:
        excluir_credencial(db, credencial_id)
        return {"ok": True}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{credencial_id}/status")
def atualizar_status(credencial_id: int, payload: StatusIn, db: Session = Depends(get_db)):
    try:
        item = marcar_status(db, credencial_id, payload.status)
        return _attach_averbadora_fields(db, [item])[0]
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/{credencial_id}/reset-consumo")
def reset_consumo(credencial_id: int, db: Session = Depends(get_db)):
    try:
        item = resetar_consumo(db, credencial_id)
        return _attach_averbadora_fields(db, [item])[0]
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
