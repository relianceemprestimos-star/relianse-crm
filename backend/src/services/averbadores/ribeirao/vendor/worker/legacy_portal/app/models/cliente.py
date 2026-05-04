from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Cliente(Base):
    __tablename__ = "clientes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    lote_id: Mapped[int] = mapped_column(ForeignKey("lotes.id", ondelete="CASCADE"), index=True)

    cpf: Mapped[str] = mapped_column(String(11), index=True)
    nome: Mapped[str | None] = mapped_column(String(255), nullable=True)
    matricula: Mapped[str | None] = mapped_column(String(100), nullable=True)
    orgao: Mapped[str | None] = mapped_column(String(255), nullable=True)
    criado_em: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    lote = relationship("Lote", back_populates="clientes")
    consulta = relationship("Consulta", back_populates="cliente", uselist=False, cascade="all, delete-orphan")
