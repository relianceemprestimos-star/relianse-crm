from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.averbadora import Averbadora
from app.models.credencial import Credencial
from app.models.mailing import Mailing
from app.utils.url_tools import normalize_portal_url, slugify_text, suggest_code_from_url, suggest_name_from_url
from app.utils.security import require_auth

router = APIRouter(prefix="/averbadoras", tags=["averbadoras"], dependencies=[Depends(require_auth)])


class AverbadoraCreateIn(BaseModel):
    nome: str
    codigo: str | None = None
    url_base: str | None = None
    descricao: str | None = None
    ativa: bool = True


@router.get("")
def listar(db: Session = Depends(get_db)):
    items = db.query(Averbadora).order_by(Averbadora.nome.asc()).all()
    response = []
    for item in items:
        credenciais_vinculadas = (
            db.query(Credencial)
            .filter(Credencial.averbadora_codigo == item.codigo, Credencial.ativa.is_(True))
            .count()
        )
        ultimo_mailing = (
            db.query(Mailing)
            .filter(Mailing.averbadora_codigo == item.codigo)
            .order_by(Mailing.criado_em.desc())
            .first()
        )
        response.append(
            {
                "codigo": item.codigo,
                "nome": item.nome,
                "url_base": item.url_base or "",
                "descricao": item.descricao or "",
                "ativa": item.ativa,
                "credenciais_vinculadas": credenciais_vinculadas,
                "ultimo_mailing": (
                    {
                        "id": ultimo_mailing.id,
                        "status": ultimo_mailing.status,
                        "resultado_disponivel": bool(ultimo_mailing.resultado_path),
                    }
                    if ultimo_mailing
                    else None
                ),
            }
        )
    return {"itens": response}


@router.post("")
def criar(payload: AverbadoraCreateIn, db: Session = Depends(get_db)):
    url_base = ""
    if payload.url_base:
        try:
            url_base = normalize_portal_url(payload.url_base)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    nome = (payload.nome or "").strip()
    if not nome and url_base:
        nome = suggest_name_from_url(url_base)
    if not nome:
        raise HTTPException(status_code=400, detail="Nome da averbadora e obrigatorio.")

    codigo = (payload.codigo or "").strip().lower()
    if not codigo:
        codigo = suggest_code_from_url(url_base) if url_base else slugify_text(nome)

    exists = db.get(Averbadora, codigo)
    if exists:
        raise HTTPException(status_code=409, detail="Codigo de averbadora ja existe.")

    nome_duplicado = db.query(Averbadora).filter(Averbadora.nome == nome).first()
    if nome_duplicado:
        raise HTTPException(status_code=409, detail="Ja existe uma averbadora com esse nome.")

    if url_base:
        url_duplicada = db.query(Averbadora).filter(Averbadora.url_base == url_base).first()
        if url_duplicada:
            raise HTTPException(status_code=409, detail="Ja existe uma averbadora com esse link.")

    item = Averbadora(
        codigo=codigo,
        nome=nome,
        url_base=url_base or None,
        descricao=(payload.descricao or "").strip() or None,
        ativa=payload.ativa,
    )
    db.add(item)
    db.commit()
    return {
        "codigo": item.codigo,
        "nome": item.nome,
        "url_base": item.url_base or "",
        "descricao": item.descricao or "",
        "ativa": item.ativa,
    }
