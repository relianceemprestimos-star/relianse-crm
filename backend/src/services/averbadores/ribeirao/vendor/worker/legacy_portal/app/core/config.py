from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Consulta Margem Portal"
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    app_debug: bool = False

    app_username: str = "admin"
    app_password: str = "admin123"
    credentials_secret: str = ""

    database_url: str = "sqlite:///./data/app.db"

    data_dir: Path = Path("data")
    uploads_dir: Path = Path("data/uploads")
    exports_dir: Path = Path("data/exports")
    evidencias_dir: Path = Path("data/evidencias")
    logs_dir: Path = Path("data/logs")
    sessions_dir: Path = Path("data/sessions")

    portal_url: str = "https://consignataria.portal_padrao.ap.gov.br/login"
    margem_url: str = "https://consignataria.portal_padrao.ap.gov.br/margem"
    portal_username: str = Field(default="", description="Usuario autorizado no portal")
    portal_password: str = Field(default="", description="Senha autorizada no portal")

    pdc_portal_url: str = "https://portal-secundario.exemplo.local/consulta"
    sp_streamlit_url: str = "https://portal-legado.local"
    pdc_username: str = Field(default="", description="Usuario/cpf do Portal Secundario")
    pdc_password: str = Field(default="", description="Senha do Portal Secundario")
    pdc_orgao_nome: str = "convenio estadual"

    selector_login_user: str = "input[name='cpf'], input[name='login'], #cpf"
    selector_login_password: str = "input[type='password']"
    selector_login_submit: str = (
        "button:has-text('Login'), "
        "button[type='submit']:not(:has-text('gov.br')), "
        "input[type='submit']"
    )
    selector_logged_indicator: str = "text=Servidor || text=Servidores || text=Margem"
    selector_govbr_cpf: str = "input[name='accountId'], #accountId, input[placeholder*='CPF' i]"
    selector_govbr_continue: str = "#enter-account-id, button:has-text('Continuar'), button[type='submit']"
    selector_govbr_captcha: str = "iframe[title*='hCaptcha' i], #hcaptcha, iframe[src*='hcaptcha' i]"

    selector_menu_servidores: str = "text=Servidores || text=Servidor"
    selector_menu_margem: str = "text=Margem"
    selector_pesquisar_button: str = "text=Pesquisar || button:has-text('Pesquisar')"
    selector_detalhes_button: str = "text=Detalhes || button:has-text('Detalhes') || a:has-text('Detalhes')"
    selector_sem_resultado: str = (
        "text=Nenhum registro encontrado || text=Nenhum registro || text=Sem resultados"
    )
    selector_aba_margem: str = "text=Aba - Margem || text=Margem"
    selector_visualizar_margem_link: str = (
        "text=Clique aqui para visualizar a margem do servidor || text=visualizar a margem do servidor"
    )
    selector_reauth_password: str = "input[type='password']"
    selector_reauth_submit: str = (
        "button:has-text('Entrar') || button:has-text('Confirmar') || "
        "button:has-text('Acessar') || button[type='submit']"
    )
    selector_cpf_input: str = "input[name='cpf'], #cpf, input[placeholder*='CPF']"
    selector_consultar_button: str = "button:has-text('Consultar'), button[type='submit']"
    selector_result_ready: str = (
        "text=Margem Facultativa || text=Margem facultativa || text=Margem Consignavel de Cartao || "
        "text=Margem Consignavel de Cartao Beneficio"
    )
    selector_error: str = ".alert-danger, .error, .toast-error"
    selector_margem_disponivel: str = "[data-field='margem-disponivel']"
    selector_margem_cartao: str = "[data-field='margem-cartao']"
    selector_margem_cartao_beneficio: str = "[data-field='margem-cartao-beneficio']"
    selector_portal_padrao_detalhes: str = "a:has-text('Acessar Sistema')"
    label_margem_facultativa: str = "Margem Facultativa || Margem facultativa"
    label_margem_cartao: str = "Margem Consignavel de Cartao || Margem Consignavel Cartao"
    label_margem_cartao_beneficio: str = (
        "Margem consignavel de Cartao Beneficio || Margem Consignavel de Cartao Beneficio"
    )

    pdc_captcha_value: str = Field(default="", description="Captcha de login administrativo do Portal Secundario")
    pdc_selector_login_entry: str = (
        "#Entrar, input#Entrar, input[name='Entrar'], input[value='Próxima'], input[value='Proxima'], "
        "button:has-text('Próxima'), button:has-text('Proxima'), button:has-text('Entrar')"
    )
    pdc_selector_login_user: str = (
        "#txtLogin, #username, #txtCPF, input[name='txtLogin'], input[name='username'], input[name='cpf'], "
        "input[name='login'], input[name='usuario'], #cpf, #login, #usuario, input[type='text']"
    )
    pdc_selector_login_password: str = "#txtSenha, #password, input[name='senha'], input[type='password']"
    pdc_selector_captcha_input: str = "#captcha, input[name*='captcha' i]"
    pdc_selector_login_submit: str = (
        "#id1e, #id6, input[id='id1e'], input[id='id6'], input[name='loginButton'], "
        "button:has-text('Acessar'), input[value*='Acessar' i], button:has-text('Entrar'), "
        "button:has-text('Login'), input[value*='Entrar' i], input[value*='Login' i], "
        "button[type='submit'], input[type='submit']"
    )
    pdc_selector_login_administrativo: str = (
        "text=LOGIN ADMINISTRATIVO || text=Login administrativo || a:has-text('Login administrativo') || "
        "button:has-text('Login administrativo')"
    )
    pdc_selector_profile_access_button: str = (
        "#gvOrgao_imgEntrar_0, input[name*='imgEntrar' i], input[type='image'][id*='imgEntrar' i], "
        "input[value='Acessar'], button:has-text('Acessar')"
    )
    pdc_selector_menu_consulta_margem: str = (
        "text=Consulta de margem || a:has-text('Consulta de margem') || button:has-text('Consulta de margem')"
    )
    pdc_selector_orgao_input: str = (
        "select[name*='orgao' i], select[id*='orgao' i], input[name*='orgao' i], input[id*='orgao' i]"
    )
    pdc_selector_cpf_input: str = (
        "#body_cpfTextBox, input[name*='cpfServidor' i], input[id*='cpfServidor' i], "
        "input[name='cpfConsulta'], input[name='cpf'], #cpfConsulta, #cpf, input[placeholder*='CPF' i]"
    )
    pdc_selector_search_submit: str = (
        "#body_pesquisarButton, button:has-text('Pesquisar'), input[value*='Pesquisar' i], button:has-text('Consultar'), "
        "input[value*='Consultar' i], button[type='submit'], input[type='submit']"
    )
    pdc_selector_result_ready: str = (
        "text=Resultado || text=Margem Bruta || text=Margem Disponivel - Total || text=Margem Disponivel"
    )
    pdc_selector_error: str = ".alert-danger, .error, .msgErro, .toast-error"
    pdc_label_margem_bruta: str = "Margem Bruta"
    pdc_label_margem_disponivel: str = "Margem Disponivel || Disponivel"
    pdc_label_facultativa: str = "Facultativa || Margem Consignavel"
    pdc_label_cartao: str = "Cartao || Margem Cartao"
    pdc_label_cartao_beneficio: str = "Cartao Beneficio || Margem Cartao Beneficio"

    retry_attempts: int = 2
    timeout_ms: int = 20000
    intervalo_entre_consultas_ms: int = 1000
    lote_maximo_default: int = 0
    headless: bool = True
    capture_pdf: bool = True
    capture_screenshot_on_success: bool = True
    mascarar_cpf_logs: bool = True


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    for folder in [
        settings.data_dir,
        settings.uploads_dir,
        settings.exports_dir,
        settings.evidencias_dir,
        settings.logs_dir,
        settings.sessions_dir,
    ]:
        folder.mkdir(parents=True, exist_ok=True)
    return settings


