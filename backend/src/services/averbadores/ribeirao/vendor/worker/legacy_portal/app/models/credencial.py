from datetime import datetime

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Credencial(Base):
    __tablename__ = "credenciais"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    averbadora_codigo: Mapped[str] = mapped_column(String(80), index=True)
    usuario: Mapped[str] = mapped_column(String(120), index=True)
    nome_credencial: Mapped[str] = mapped_column(String(120), default="")
    senha_criptografada: Mapped[str] = mapped_column(Text)

    ativa: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    status: Mapped[str] = mapped_column(String(30), default="disponivel", index=True)
    limite_consultas: Mapped[int] = mapped_column(Integer, default=450)
    consultas_realizadas: Mapped[int] = mapped_column(Integer, default=0)

    ultimo_login_em: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ultimo_uso_em: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    ultimo_erro: Mapped[str | None] = mapped_column(Text, nullable=True)

    criado_em: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    atualizado_em: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
