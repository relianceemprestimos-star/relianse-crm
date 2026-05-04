from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import inspect, text
from sqlalchemy.orm import Session
from fastapi.templating import Jinja2Templates

from app.core.config import get_settings
from app.core.database import Base, SessionLocal, engine
from app.models.averbadora import Averbadora
from app.models.consulta import Consulta
from app.models.credencial import Credencial
from app.models.lote import Lote
from app.models.mailing import Mailing
from app.routes.averbadoras import router as averbadoras_router
from app.routes.credenciais import router as credenciais_router
from app.routes.jobs import router as jobs_router
from app.routes.mailings import router as mailings_router
from app.routes.manual_auth import router as manual_auth_router
from app.routes.results import router as results_router
from app.routes.upload import router as upload_router
from app.services.credenciais_service import criar_credencial
from app.services.job_service import JobService
from app.services.manual_auth_service import ManualAuthManager
from app.services.mailing_service import MailingProcessor, cleanup_expired_mailings
from app.utils.security import require_auth

settings = get_settings()
app = FastAPI(title=settings.app_name, debug=settings.app_debug)
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))


def _apply_runtime_migrations() -> None:
    inspector = inspect(engine)
    table_names = set(inspector.get_table_names())

    if "lotes" in table_names:
        lote_columns = {item["name"] for item in inspector.get_columns("lotes")}
        if "averbadora_codigo" not in lote_columns:
            with engine.begin() as conn:
                conn.execute(
                    text("ALTER TABLE lotes ADD COLUMN averbadora_codigo VARCHAR(80) DEFAULT 'portal_padrao'")
                )
                conn.execute(
                    text(
                        "UPDATE lotes SET averbadora_codigo = 'portal_padrao' "
                        "WHERE averbadora_codigo IS NULL OR TRIM(averbadora_codigo) = ''"
                    )
                )

    if "averbadoras" in table_names:
        averbadora_columns = {item["name"] for item in inspector.get_columns("averbadoras")}
        if "url_base" not in averbadora_columns:
            with engine.begin() as conn:
                conn.execute(text("ALTER TABLE averbadoras ADD COLUMN url_base VARCHAR(255)"))

def _seed_default_averbadoras(db: Session) -> None:
    defaults = [
        {
            "codigo": "portal_secundario_legacy",
            "nome": "Portal Secundario",
            "url_base": "https://portal-secundario.exemplo.local/consulta",
            "descricao": "Estrutura pronta para consulta por CPF/matricula.",
            "ativa": True,
        },
        {
            "codigo": "portal_padrao",
            "nome": "Portal Padrao",
            "url_base": "https://consignataria.portal_padrao.ap.gov.br/",
            "descricao": "Estrutura pronta para consulta por CPF/matricula.",
            "ativa": True,
        },
    ]
    for item in defaults:
        exists = db.get(Averbadora, item["codigo"])
        if exists:
            if not exists.url_base and item.get("url_base"):
                exists.url_base = item["url_base"]
            continue
        db.add(Averbadora(**item))
    db.commit()


@app.on_event("startup")
async def startup_event():
    Base.metadata.create_all(bind=engine)
    _apply_runtime_migrations()
    db = SessionLocal()
    try:
        _seed_default_averbadoras(db)
        cleanup_expired_mailings(db)
        if settings.pdc_username and settings.pdc_password:
            exists_pdc = (
                db.query(Credencial)
                .filter(Credencial.averbadora_codigo == "portal_secundario_legacy", Credencial.usuario == settings.pdc_username)
                .first()
            )
            if not exists_pdc:
                criar_credencial(
                    db,
                    averbadora_codigo="portal_secundario_legacy",
                    usuario=settings.pdc_username,
                    senha=settings.pdc_password,
                    nome_credencial="Padrao (.env)",
                    limite_consultas=450,
                )

        # Evita lotes "travados" como em_execucao apos reinicio do servidor.
        lotes = db.query(Lote).filter(Lote.status == "em_execucao").all()
        for lote in lotes:
            lote.status = "pendente"
            lote.iniciado_em = None
            pendentes = db.query(Consulta).filter(Consulta.lote_id == lote.id, Consulta.status == "pendente").count()
            lote.pendentes = pendentes
        db.commit()
    finally:
        db.close()
    app.state.job_service = JobService()
    app.state.mailing_processor = MailingProcessor()
    app.state.manual_auth_manager = ManualAuthManager()


@app.get("/", response_class=HTMLResponse, dependencies=[Depends(require_auth)])
def dashboard(request: Request):
    return templates.TemplateResponse(
        "dashboard.html",
        {
            "request": request,
            "app_name": settings.app_name,
            "sp_streamlit_url": settings.sp_streamlit_url,
        },
    )


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/integracao/sp", dependencies=[Depends(require_auth)])
def abrir_modulo_sp():
    return RedirectResponse(url=settings.sp_streamlit_url, status_code=307)


app.include_router(upload_router)
app.include_router(jobs_router)
app.include_router(results_router)
app.include_router(credenciais_router)
app.include_router(averbadoras_router)
app.include_router(mailings_router)
app.include_router(manual_auth_router)


