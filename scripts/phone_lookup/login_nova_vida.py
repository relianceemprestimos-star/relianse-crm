"""
Login manual autorizado no Nova Vida.

Este script abre o navegador para a usuaria concluir login manualmente.
Ele nao salva senha no repositorio. Use apenas em ambiente autorizado.
"""

import os
from pathlib import Path

from playwright.sync_api import sync_playwright


def load_dotenv() -> None:
    for path in (Path(".env"), Path(__file__).resolve().parents[1] / ".env"):
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def main() -> None:
    load_dotenv()
    url = os.getenv("NOVA_VIDA_URL", "https://congonhas.novavidati.com.br")
    state_path = Path(os.getenv("NOVA_VIDA_STORAGE_STATE", "data/nova_vida_storage_state.json"))
    state_path.parent.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        usuario = os.getenv("NOVA_VIDA_USER") or os.getenv("NOVA_VIDA_USERNAME") or ""
        cliente = os.getenv("NOVA_VIDA_CLIENT") or os.getenv("NOVA_VIDA_USERNAME") or ""
        if page.locator("#sUsuario").count() and usuario:
            page.fill("#sUsuario", usuario)
        if page.locator("#sCliente").count() and cliente:
            page.fill("#sCliente", cliente)
        print("Conclua o login manual no Nova Vida. Pressione ENTER aqui quando terminar.")
        input()
        context.storage_state(path=str(state_path))
        browser.close()
        print(f"Sessao salva em: {state_path}")


if __name__ == "__main__":
    main()
