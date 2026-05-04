from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Session

from app.models.credencial import Credencial
from app.utils.crypto import decrypt_secret, encrypt_secret


VALID_STATUS = {"disponivel", "captcha_pendente", "indisponivel", "esgotada"}


def _normalize_status(status: str | None) -> str:
    raw = (status or "").strip().lower()
    if raw in VALID_STATUS:
        return raw
    return "disponivel"


def _credencial_to_dict(item: Credencial) -> dict:
    disponiveis = max(0, int(item.limite_consultas or 0) - int(item.consultas_realizadas or 0))
    return {
        "id": item.id,
        "averbadora_codigo": item.averbadora_codigo,
        "usuario": item.usuario,
        "senha": "********",
        "nome_credencial": item.nome_credencial or "",
        "consultas_disponiveis": disponiveis,
        "limite_consultas": item.limite_consultas,
        "consultas_realizadas": item.consultas_realizadas,
        "ativa": item.ativa,
        "status": item.status,
        "ultimo_login_em": item.ultimo_login_em.isoformat() if item.ultimo_login_em else None,
        "ultimo_uso_em": item.ultimo_uso_em.isoformat() if item.ultimo_uso_em else None,
        "ultimo_erro": item.ultimo_erro or "",
    }


def listar_credenciais(db: Session, averbadora_codigo: str | None = None) -> list[dict]:
    query = db.query(Credencial).order_by(Credencial.id.desc())
    if averbadora_codigo:
        query = query.filter(Credencial.averbadora_codigo == averbadora_codigo)
    return [_credencial_to_dict(item) for item in query.all()]


def criar_credencial(
    db: Session,
    *,
    averbadora_codigo: str,
    usuario: str,
    senha: str,
    nome_credencial: str,
    limite_consultas: int,
    ativa: bool = True,
) -> dict:
    is_ativa = bool(ativa)
    item = Credencial(
        averbadora_codigo=averbadora_codigo,
        usuario=(usuario or "").strip(),
        senha_criptografada=encrypt_secret(senha or ""),
        nome_credencial=(nome_credencial or "").strip(),
        limite_consultas=max(1, int(limite_consultas or 1)),
        consultas_realizadas=0,
        ativa=is_ativa,
        status="disponivel" if is_ativa else "indisponivel",
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    return _credencial_to_dict(item)


def atualizar_credencial(
    db: Session,
    *,
    credencial_id: int,
    usuario: str | None = None,
    senha: str | None = None,
    nome_credencial: str | None = None,
    limite_consultas: int | None = None,
    ativa: bool | None = None,
    status: str | None = None,
) -> dict:
    item = db.get(Credencial, credencial_id)
    if not item:
        raise ValueError("Credencial nao encontrada")

    if usuario is not None:
        item.usuario = usuario.strip()
    if senha is not None and senha.strip():
        item.senha_criptografada = encrypt_secret(senha.strip())
    if nome_credencial is not None:
        item.nome_credencial = nome_credencial.strip()
    if limite_consultas is not None:
        item.limite_consultas = max(1, int(limite_consultas))
    if ativa is not None:
        item.ativa = bool(ativa)
    if status is not None:
        item.status = _normalize_status(status)

    item.atualizado_em = datetime.utcnow()
    db.commit()
    db.refresh(item)
    return _credencial_to_dict(item)


def excluir_credencial(db: Session, credencial_id: int) -> None:
    item = db.get(Credencial, credencial_id)
    if not item:
        raise ValueError("Credencial nao encontrada")
    db.delete(item)
    db.commit()


def selecionar_credencial_disponivel(db: Session, averbadora_codigo: str) -> Credencial | None:
    query = (
        db.query(Credencial)
        .filter(
            Credencial.averbadora_codigo == averbadora_codigo,
            Credencial.ativa.is_(True),
            Credencial.status == "disponivel",
        )
        .order_by(Credencial.consultas_realizadas.asc(), Credencial.id.asc())
    )
    for item in query.all():
        if item.consultas_realizadas < item.limite_consultas:
            return item
    return None


def selecionar_credencial_para_execucao(db: Session, averbadora_codigo: str) -> Credencial | None:
    """Seleciona credencial para processamento.

    Para Portal Secundario, permite usar credencial em captcha_pendente
    para que o erro correto seja exibido (sessao manual ausente/expirada)
    ao inves de bloquear com "sem credencial disponivel".
    """
    item = selecionar_credencial_disponivel(db, averbadora_codigo)
    if item:
        return item

    if averbadora_codigo != "portal_secundario_legacy":
        return None

    query = (
        db.query(Credencial)
        .filter(
            Credencial.averbadora_codigo == averbadora_codigo,
            Credencial.ativa.is_(True),
            Credencial.status.in_(["captcha_pendente", "disponivel"]),
        )
        .order_by(Credencial.consultas_realizadas.asc(), Credencial.id.asc())
    )
    for candidate in query.all():
        if candidate.consultas_realizadas < candidate.limite_consultas:
            return candidate
    return None


def credencial_payload_login(item: Credencial) -> dict:
    return {
        "id": item.id,
        "usuario": item.usuario,
        "senha": decrypt_secret(item.senha_criptografada),
        "nome_credencial": item.nome_credencial or "",
    }


def registrar_inicio_login(db: Session, credencial_id: int) -> None:
    item = db.get(Credencial, credencial_id)
    if not item:
        return
    item.ultimo_login_em = datetime.utcnow()
    item.ultimo_erro = None
    db.commit()


def registrar_uso_consulta(db: Session, credencial_id: int, *, erro: str | None = None) -> None:
    item = db.get(Credencial, credencial_id)
    if not item:
        return

    item.consultas_realizadas = int(item.consultas_realizadas or 0) + 1
    item.ultimo_uso_em = datetime.utcnow()

    if item.consultas_realizadas >= item.limite_consultas:
        item.status = "esgotada"

    if erro:
        lower = erro.lower()
        item.ultimo_erro = erro
        if "captcha" in lower:
            item.status = "captcha_pendente"
        elif "bloque" in lower:
            item.status = "indisponivel"

    db.commit()


def marcar_status(db: Session, credencial_id: int, status: str) -> dict:
    item = db.get(Credencial, credencial_id)
    if not item:
        raise ValueError("Credencial nao encontrada")
    item.status = _normalize_status(status)
    if item.status == "disponivel":
        item.ultimo_erro = None
    db.commit()
    db.refresh(item)
    return _credencial_to_dict(item)


def resetar_consumo(db: Session, credencial_id: int) -> dict:
    item = db.get(Credencial, credencial_id)
    if not item:
        raise ValueError("Credencial nao encontrada")
    item.consultas_realizadas = 0
    if item.status == "esgotada":
        item.status = "disponivel"
    item.ultimo_erro = None
    db.commit()
    db.refresh(item)
    return _credencial_to_dict(item)

