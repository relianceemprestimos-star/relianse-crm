from __future__ import annotations

from app.connectors.base import AverbadoraConnector
from app.services.margem_consulta import ConsultaResultado


class TemplateOutraAverbadoraConnector(AverbadoraConnector):
    """
    Template base para novas averbadoras.

    Como usar:
    1. Duplique este arquivo e renomeie a classe para o nome da instituicao.
    2. Implemente `start`, `consultar_cliente` e `close`.
    3. Registre no app/connectors/registry.py.
    """

    def __init__(self, lote_id: int, credencial: dict | None = None):
        self.lote_id = lote_id

    async def start(self) -> None:
        # TODO: iniciar navegador/sessao e fazer login.
        raise RuntimeError(
            "Conector 'template_outra_averbadora' em implementacao. "
            "Configure o fluxo da instituicao antes de processar lotes."
        )

    async def consultar_cliente(self, cpf: str) -> ConsultaResultado:
        # TODO: executar fluxo completo por CPF e retornar sucesso/erro.
        return ConsultaResultado(
            status="erro",
            detalhe_erro=f"Conector template ainda nao implementado para CPF {cpf}",
        )

    async def close(self) -> None:
        # TODO: encerrar navegador/sessao.
        return None
