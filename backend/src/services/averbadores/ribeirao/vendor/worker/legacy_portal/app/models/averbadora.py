from datetime import datetime

from sqlalchemy import Boolean, DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Averbadora(Base):
    __tablename__ = "averbadoras"

    codigo: Mapped[str] = mapped_column(String(80), primary_key=True, index=True)
    nome: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    url_base: Mapped[str | None] = mapped_column(String(255), nullable=True, unique=True)
    descricao: Mapped[str | None] = mapped_column(String(255), nullable=True)
    ativa: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    criado_em: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    atualizado_em: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
