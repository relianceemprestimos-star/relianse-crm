from datetime import datetime
from pathlib import Path
from typing import Optional

from app.core.config import get_settings
from app.utils.cpf import normalize_cpf


def _target_dir(lote_id: int) -> Path:
    settings = get_settings()
    folder = settings.evidencias_dir / f"lote_{lote_id}"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _base_name(cpf: str) -> str:
    cleaned = normalize_cpf(cpf) or "sem_cpf"
    now = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{cleaned}_{now}"


async def save_evidence_screenshot(page, lote_id: int, cpf: str, suffix: str = "") -> Optional[str]:
    folder = _target_dir(lote_id)
    name = _base_name(cpf)
    suffix_text = f"_{suffix}" if suffix else ""
    target = folder / f"{name}{suffix_text}.png"
    await page.screenshot(path=str(target), full_page=True)
    return str(target)


async def save_evidence_pdf(page, lote_id: int, cpf: str, suffix: str = "") -> Optional[str]:
    folder = _target_dir(lote_id)
    name = _base_name(cpf)
    suffix_text = f"_{suffix}" if suffix else ""
    target = folder / f"{name}{suffix_text}.pdf"
    try:
        await page.pdf(path=str(target), print_background=True, format="A4")
        return str(target)
    except Exception:
        return None
