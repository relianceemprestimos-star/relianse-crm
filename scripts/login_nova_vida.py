"""
Login manual autorizado no Nova Vida.

Este script abre o navegador para a usuaria concluir login manualmente.
Ele nao salva senha no repositorio. Use apenas em ambiente autorizado.
"""

import os
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> None:
    url = os.getenv("NOVA_VIDA_URL", "https://congonhas.novavidati.com.br")
    state_path = Path(os.getenv("NOVA_VIDA_STORAGE_STATE", "data/nova_vida_storage_state.json"))
    state_path.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        print("Conclua o login manual no Nova Vida. Pressione ENTER aqui quando terminar.")
        input()
        context.storage_state(path=str(state_path))
        browser.close()
        print(f"Sessao salva em: {state_path}")


if __name__ == "__main__":
    main()
