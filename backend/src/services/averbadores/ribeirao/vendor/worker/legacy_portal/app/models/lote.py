from datetime import datetime

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Lote(Base):
    __tablename__ = "lotes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    nome_arquivo: Mapped[str] = mapped_column(String(255))
    averbadora_codigo: Mapped[str] = mapped_column(String(80), default="portal_padrao", index=True)
    status: Mapped[str] = mapped_column(String(20), default="pendente", index=True)

    total_registros: Mapped[int] = mapped_column(Integer, default=0)
    processados: Mapped[int] = mapped_column(Integer, default=0)
    sucessos: Mapped[int] = mapped_column(Integer, default=0)
    erros: Mapped[int] = mapped_column(Integer, default=0)
    pendentes: Mapped[int] = mapped_column(Integer, default=0)

    criado_em: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    iniciado_em: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finalizado_em: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    clientes = relationship("Cliente", back_populates="lote", cascade="all, delete-orphan")
    consultas = relationship("Consulta", back_populates="lote", cascade="all, delete-orphan")

