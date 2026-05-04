from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class Mailing(Base):
    __tablename__ = "mailings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    averbadora_codigo: Mapped[str] = mapped_column(String(80), index=True)
    nome_arquivo: Mapped[str] = mapped_column(String(255))
    arquivo_path: Mapped[str] = mapped_column(String(512))
    resultado_path: Mapped[str | None] = mapped_column(String(512), nullable=True)

    status: Mapped[str] = mapped_column(String(30), default="enviado", index=True)
    total_registros: Mapped[int] = mapped_column(Integer, default=0)
    processados: Mapped[int] = mapped_column(Integer, default=0)
    sucessos: Mapped[int] = mapped_column(Integer, default=0)
    erros: Mapped[int] = mapped_column(Integer, default=0)
    detalhe_erro: Mapped[str | None] = mapped_column(Text, nullable=True)

    criado_em: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    processado_em: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expira_em: Mapped[datetime] = mapped_column(DateTime, index=True)
