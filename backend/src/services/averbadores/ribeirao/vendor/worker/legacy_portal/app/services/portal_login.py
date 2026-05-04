from playwright.async_api import Page

from app.core.config import Settings


async def login_portal(page: Page, settings: Settings) -> None:
    await page.goto(settings.portal_url, wait_until="domcontentloaded", timeout=settings.timeout_ms)

    if settings.portal_username and settings.portal_password:
        await page.fill(settings.selector_login_user, settings.portal_username)
        await page.fill(settings.selector_login_password, settings.portal_password)
        await page.click(settings.selector_login_submit)

        await page.wait_for_timeout(1200)
        if "sso.acesso.gov.br" in (page.url or ""):
            raise RuntimeError(
                "Login redirecionado para Gov.br. Confira CPF/senha do correspondente e o botao 'Login' do portal."
            )

        try:
            await page.wait_for_selector(settings.selector_logged_indicator, timeout=settings.timeout_ms)
        except Exception:
            if "sso.acesso.gov.br" in (page.url or ""):
                raise RuntimeError(
                    "Login redirecionado para Gov.br. Confira CPF/senha do correspondente e o botao 'Login' do portal."
                )
            # Falha de autenticacao no proprio ApConsig.
            error_selectors = [".alert-danger", ".error", ".invalid-feedback", ".toast-error"]
            for sel in error_selectors:
                try:
                    text = await page.locator(sel).first.inner_text(timeout=600)
                    text = (text or "").strip()
                    if text:
                        raise RuntimeError(f"Falha no login do correspondente: {text}")
                except RuntimeError:
                    raise
                except Exception:
                    continue

            if "/login" in (page.url or ""):
                raise RuntimeError("Falha no login do correspondente: verifique CPF e senha.")
