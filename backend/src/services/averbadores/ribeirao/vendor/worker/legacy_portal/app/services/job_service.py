import asyncio
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.connectors import create_connector, normalize_averbadora_codigo
from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.cliente import Cliente
from app.models.consulta import Consulta
from app.models.credencial import Credencial
from app.models.lote import Lote
from app.services.credenciais_service import (
    credencial_payload_login,
    registrar_inicio_login,
    registrar_uso_consulta,
    selecionar_credencial_disponivel,
)
from app.utils.logger import get_logger


class JobService:
    def __init__(self):
        self.active_jobs: dict[int, asyncio.Task] = {}
        self.settings = get_settings()
        self.logger = get_logger("job-service")

    def _refresh_metrics(self, db: Session, lote: Lote) -> None:
        total = db.query(func.count(Consulta.id)).filter(Consulta.lote_id == lote.id).scalar() or 0
        sucessos = (
            db.query(func.count(Consulta.id))
            .filter(Consulta.lote_id == lote.id, Consulta.status == "sucesso")
            .scalar()
            or 0
        )
        erros = (
            db.query(func.count(Consulta.id))
            .filter(Consulta.lote_id == lote.id, Consulta.status == "erro")
            .scalar()
            or 0
        )
        pendentes = (
            db.query(func.count(Consulta.id))
            .filter(Consulta.lote_id == lote.id, Consulta.status == "pendente")
            .scalar()
            or 0
        )
        lote.total_registros = total
        lote.sucessos = sucessos
        lote.erros = erros
        lote.pendentes = pendentes
        lote.processados = sucessos + erros

    async def _run(self, lote_id: int) -> None:
        db = SessionLocal()
        motor = None
        credencial_id: int | None = None
        try:
            lote = db.get(Lote, lote_id)
            if not lote:
                return
            lote.averbadora_codigo = normalize_averbadora_codigo(lote.averbadora_codigo)

            lote.status = "em_execucao"
            lote.iniciado_em = datetime.utcnow()
            db.commit()

            credencial_payload = None
            if lote.averbadora_codigo == "portal_secundario_legacy":
                credencial = selecionar_credencial_disponivel(db, lote.averbadora_codigo)
                if not credencial:
                    raise RuntimeError(
                        "Nao ha credencial disponivel para esta averbadora. "
                        "Cadastre ou marque uma credencial como disponivel."
                    )
                credencial_id = credencial.id
                credencial_payload = credencial_payload_login(credencial)
                registrar_inicio_login(db, credencial.id)

            motor = create_connector(lote.averbadora_codigo, lote_id=lote_id, credencial=credencial_payload)
            startup_timeout_seconds = max(60, int(self.settings.timeout_ms / 1000) * 5)
            await asyncio.wait_for(motor.start(), timeout=startup_timeout_seconds)
            query_pendentes = (
                db.query(Consulta, Cliente)
                .join(Cliente, Cliente.id == Consulta.cliente_id)
                .filter(Consulta.lote_id == lote_id, Consulta.status == "pendente")
                .order_by(Consulta.id.asc())
            )
            if self.settings.lote_maximo_default and self.settings.lote_maximo_default > 0:
                query_pendentes = query_pendentes.limit(self.settings.lote_maximo_default)
            pendentes = query_pendentes.all()

            for consulta, cliente in pendentes:
                result = await motor.consultar_cliente(cliente.cpf)
                consulta.status = result.status
                consulta.margem_disponivel = result.margem_disponivel
                consulta.margem_cartao = result.margem_cartao
                consulta.margem_cartao_beneficio = result.margem_cartao_beneficio
                consulta.detalhe_erro = result.detalhe_erro
                consulta.evidencia_path = result.evidencia_path
                consulta.payload_extra = result.payload_extra
                consulta.consultado_em = result.consultado_em
                consulta.tentativas = result.tentativas
                db.commit()
                if credencial_id:
                    registrar_uso_consulta(db, credencial_id, erro=result.detalhe_erro if result.status == "erro" else None)

                self._refresh_metrics(db, lote)
                db.commit()

            self._refresh_metrics(db, lote)
            if lote.pendentes > 0:
                lote.status = "parcial_pendente"
            elif lote.erros > 0:
                lote.status = "finalizado_com_erros"
            else:
                lote.status = "finalizado"
            lote.finalizado_em = datetime.utcnow()
            db.commit()
        except Exception as exc:
            error_text = str(exc).strip() or f"{exc.__class__.__name__}: {repr(exc)}"
            lowered_error = error_text.lower()
            lote = db.get(Lote, lote_id)
            if lote:
                if "captcha" in lowered_error:
                    lote.status = "aguardando_captcha"
                elif "credencial disponivel" in lowered_error:
                    lote.status = "aguardando_credencial"
                else:
                    lote.status = "falha_critica"
                lote.finalizado_em = datetime.utcnow()
                if lote.status not in {"aguardando_captcha", "aguardando_credencial"}:
                    pendentes = db.query(Consulta).filter(Consulta.lote_id == lote_id, Consulta.status == "pendente").all()
                    for consulta in pendentes:
                        consulta.status = "erro"
                        consulta.detalhe_erro = f"Falha critica do lote: {error_text}"
                elif credencial_id:
                    credencial = db.get(Credencial, credencial_id)
                    if credencial:
                        credencial.status = "captcha_pendente"
                        credencial.ultimo_erro = error_text
                db.commit()
            self.logger.exception("Erro critico na execucao do lote=%s | erro=%s", lote_id, error_text)
        finally:
            if motor:
                await motor.close()
            db.close()
            self.active_jobs.pop(lote_id, None)

    def start_job(self, lote_id: int) -> None:
        running_jobs = [job_id for job_id, task in self.active_jobs.items() if not task.done()]
        if running_jobs:
            raise RuntimeError(f"Ja existe um lote em execucao ({running_jobs[0]}). Aguarde finalizar.")
        if lote_id in self.active_jobs and not self.active_jobs[lote_id].done():
            raise RuntimeError("Este lote ja esta em execucao")
        task = asyncio.create_task(self._run(lote_id))
        self.active_jobs[lote_id] = task

    def reprocessar_falhas(self, lote_id: int) -> None:
        db = SessionLocal()
        try:
            consultas = db.query(Consulta).filter(Consulta.lote_id == lote_id, Consulta.status == "erro").all()
            for consulta in consultas:
                consulta.status = "pendente"
                consulta.detalhe_erro = None
                consulta.evidencia_path = None
                consulta.payload_extra = None
                consulta.margem_disponivel = None
                consulta.margem_cartao = None
                consulta.margem_cartao_beneficio = None
                consulta.consultado_em = None
                consulta.tentativas = 0
            lote = db.get(Lote, lote_id)
            if lote:
                lote.status = "pendente"
            db.commit()
        finally:
            db.close()
        self.start_job(lote_id)

