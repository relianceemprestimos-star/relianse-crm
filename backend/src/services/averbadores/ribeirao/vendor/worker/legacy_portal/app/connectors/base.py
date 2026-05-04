from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Callable

from app.services.margem_consulta import ConsultaResultado


class AverbadoraConnector(ABC):
    @abstractmethod
    async def start(self) -> None:
        raise NotImplementedError

    @abstractmethod
    async def consultar_cliente(self, cpf: str) -> ConsultaResultado:
        raise NotImplementedError

    @abstractmethod
    async def close(self) -> None:
        raise NotImplementedError


@dataclass(frozen=True)
class AverbadoraDef:
    codigo: str
    nome: str
    descricao: str
    connector_factory: Callable[[int, dict | None], AverbadoraConnector]
