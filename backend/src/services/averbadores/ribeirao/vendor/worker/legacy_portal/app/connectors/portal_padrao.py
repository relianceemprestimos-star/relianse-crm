from app.connectors.base import AverbadoraConnector
from app.services.margem_consulta import ConsultaResultado, MargemConsultaService


class PortalPadraoConnector(AverbadoraConnector):
    def __init__(self, lote_id: int, credencial: dict | None = None):
        self._service = MargemConsultaService(lote_id=lote_id)

    async def start(self) -> None:
        await self._service.start()

    async def consultar_cliente(self, cpf: str) -> ConsultaResultado:
        return await self._service.consultar_cliente(cpf)

    async def close(self) -> None:
        await self._service.close()


