from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, JSON, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Consulta(Base):
    __tablename__ = "consultas"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    lote_id: Mapped[int] = mapped_column(ForeignKey("lotes.id", ondelete="CASCADE"), index=True)
    cliente_id: Mapped[int] = mapped_column(ForeignKey("clientes.id", ondelete="CASCADE"), unique=True, index=True)

    margem_disponivel: Mapped[str | None] = mapped_column(String(100), nullable=True)
    margem_cartao: Mapped[str | None] = mapped_column(String(100), nullable=True)
    margem_cartao_beneficio: Mapped[str | None] = mapped_column(String(100), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="pendente", index=True)
    detalhe_erro: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidencia_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    payload_extra: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    tentativas: Mapped[int] = mapped_column(Integer, default=0)
    consultado_em: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    atualizado_em: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    lote = relationship("Lote", back_populates="consultas")
    cliente = relationship("Cliente", back_populates="consulta")
