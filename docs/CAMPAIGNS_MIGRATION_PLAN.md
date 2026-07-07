# Plano de migracao para Campanhas

## Objetivo

Organizar o CRM para que a operacao comece por Campanhas, sem perder dados, rotas antigas ou historico de consulta.

## Estado atual

- Campanhas ja existem no backend.
- Bases e clientes podem estar vinculados a campanhas.
- Rotas antigas de fila, atendimento, upload e bases seguem necessarias para compatibilidade.
- O operador precisa escolher o convenio antes de decidir atendimento, download, telefone ou disparo.

## Organizacao adotada

Grupos iniciais:

- Prefeitura de Ribeirao Preto.
- Governo de SP.
- MP / MPSP.
- TJSP.
- Prefeitura de Ananindeua.
- Governo do Amapa.
- Outros convenios.

## Regras de migracao segura

1. Nao apagar campanhas, bases ou clientes existentes.
2. Nao migrar dados automaticamente sem relatorio previo.
3. Manter rotas antigas funcionando enquanto o menu e simplificado.
4. Novas bases devem ser vinculadas a uma campanha sempre que possivel.
5. Campanhas mensais devem usar grupo fixo e nome por competencia, por exemplo `MP - Julho/2026`.

## Proximas fases

- Criar relatorio para campanhas sem grupo reconhecido.
- Vincular bases historicas aos grupos corretos.
- Criar filtros por competencia mensal.
- Permitir escolher vendedor ou disparo controlado somente depois da classificacao operacional.
