from playwright.async_api import Page

from app.core.config import Settings


async def coletar_detalhes_portal_padrao(page: Page, settings: Settings) -> dict:
    data = {}
    opened_detail = False
    try:
        if await page.locator(settings.selector_portal_padrao_detalhes).count() > 0:
            async with page.expect_navigation(wait_until="domcontentloaded", timeout=settings.timeout_ms):
                await page.click(settings.selector_portal_padrao_detalhes)
            opened_detail = True
    except Exception:
        return data

    # Seletores abaixo devem ser ajustados para o HTML real do portal legado.
    candidates = {
        "portal_padrao_margem_disponivel": "[data-field='margem-disponivel']",
        "portal_padrao_margem_cartao": "[data-field='margem-cartao']",
        "portal_padrao_margem_cartao_beneficio": "[data-field='margem-cartao-beneficio']",
    }
    for key, selector in candidates.items():
        try:
            value = await page.locator(selector).first.inner_text(timeout=1500)
            data[key] = value.strip()
        except Exception:
            data[key] = ""

    if opened_detail:
        try:
            await page.go_back(wait_until="domcontentloaded", timeout=settings.timeout_ms)
        except Exception:
            pass
    return data


