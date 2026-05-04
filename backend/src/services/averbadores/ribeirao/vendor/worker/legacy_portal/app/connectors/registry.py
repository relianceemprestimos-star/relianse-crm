from __future__ import annotations

from app.connectors.portal_padrao import PortalPadraoConnector
from app.connectors.base import AverbadoraConnector, AverbadoraDef
from app.connectors.portal_secundario_legacy import PortalSecundarioLegacyConnector
from app.connectors.template_outra_averbadora import TemplateOutraAverbadoraConnector

DEFAULT_AVERBADORA = "portal_padrao"

_AVERBADORAS: dict[str, AverbadoraDef] = {
    "portal_padrao": AverbadoraDef(
        codigo="portal_padrao",
        nome="Portal Padrao",
        descricao="Consulta de margem consignavel no portal consignataria.portal_padrao.ap.gov.br",
        connector_factory=lambda lote_id, credencial=None: PortalPadraoConnector(lote_id=lote_id, credencial=credencial),
    ),
    "portal_secundario_legacy": AverbadoraDef(
        codigo="portal_secundario_legacy",
        nome="Portal Secundario",
        descricao="Consulta de margem em portal secundario legado.",
        connector_factory=lambda lote_id, credencial=None: PortalSecundarioLegacyConnector(
            lote_id=lote_id, credencial=credencial
        ),
    ),
    "template_outra_averbadora": AverbadoraDef(
        codigo="template_outra_averbadora",
        nome="Template (nova averbadora)",
        descricao="Conector base para implementar novas instituicoes.",
        connector_factory=lambda lote_id, credencial=None: TemplateOutraAverbadoraConnector(
            lote_id=lote_id, credencial=credencial
        ),
    ),
}


def normalize_averbadora_codigo(codigo: str | None) -> str:
    raw = (codigo or "").strip().lower()
    if not raw:
        return DEFAULT_AVERBADORA
    return raw


def list_averbadoras() -> list[dict]:
    return [
        {
            "codigo": item.codigo,
            "nome": item.nome,
            "descricao": item.descricao,
        }
        for item in _AVERBADORAS.values()
    ]


def get_averbadora(codigo: str | None) -> AverbadoraDef:
    normalized = normalize_averbadora_codigo(codigo)
    item = _AVERBADORAS.get(normalized)
    if not item:
        available = ", ".join(sorted(_AVERBADORAS.keys()))
        raise ValueError(f"Averbadora '{normalized}' nao suportada. Disponiveis: {available}")
    return item


def create_connector(codigo: str | None, lote_id: int, credencial: dict | None = None) -> AverbadoraConnector:
    item = get_averbadora(codigo)
    return item.connector_factory(lote_id, credencial)


