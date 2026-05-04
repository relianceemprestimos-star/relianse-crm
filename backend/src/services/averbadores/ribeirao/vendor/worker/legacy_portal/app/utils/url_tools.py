from __future__ import annotations

from urllib.parse import urlparse, urlunparse


def slugify_text(raw: str) -> str:
    text = (raw or "").strip().lower()
    keep: list[str] = []
    for ch in text:
        if ch.isalnum():
            keep.append(ch)
        elif ch in {" ", "-", "_", "."}:
            keep.append("_")
    slug = "".join(keep).strip("_")
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug or "averbadora"


def normalize_portal_url(raw: str | None) -> str:
    value = (raw or "").strip()
    if not value:
        return ""

    if "://" not in value:
        value = f"https://{value}"

    parsed = urlparse(value)
    if not parsed.netloc:
        raise ValueError("Link da averbadora invalido.")

    scheme = (parsed.scheme or "https").lower()
    if scheme not in {"http", "https"}:
        raise ValueError("Link da averbadora deve iniciar com http:// ou https://")

    normalized = urlunparse(
        (
            scheme,
            parsed.netloc.lower(),
            (parsed.path or "").rstrip("/"),
            "",
            "",
            "",
        )
    )
    return normalized


def suggest_code_from_url(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.netloc.split("@")[-1].split(":")[0]
    path = "_".join(part for part in parsed.path.split("/") if part)
    seed = f"{host}_{path}" if path else host
    return slugify_text(seed)[:80]


def suggest_name_from_url(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.netloc.split("@")[-1].split(":")[0]
    host = host.removeprefix("www.")
    words = host.replace(".", " ").replace("-", " ").split()
    cleaned = " ".join(words[:4]).strip()
    return cleaned.title() or "Nova Averbadora"
