# Relatório Correção Consulta de Margem Layout

## Resumo

A tela antiga exibida no CRM era renderizada pelo arquivo `frontend/src/pages/RibeiraoPage.tsx`, ligado à rota `/consulta-ribeirao`.

A correção substitui a experiência principal dessa rota pelo layout de **Consulta de Margem**, mantendo a integração Ribeirão existente como fonte operacional de `prefeitura_ribeirao_preto`.

## Arquivo que renderizava a tela antiga

- `frontend/src/pages/RibeiraoPage.tsx`

## Arquivo do menu lateral alterado

- `frontend/src/components/Shell.tsx`

## Rotas

- Rota antiga mantida: `/consulta-ribeirao`
- Rota nova adicionada: `/consulta-margem`
- Ambas renderizam `RibeiraoPage`, agora com layout de **Consulta de Margem**.
- O menu lateral agora aponta para `/consulta-margem`.

## Componentes alterados

- `Shell.tsx`
  - Menu lateral alterado de `Consulta Ribeirão` para `Consulta de Margem`.
  - Título superior alterado para `Consulta de Margem`.
  - Compatibilidade adicionada para `/consulta-ribeirao`.

- `App.tsx`
  - Adicionada rota `/consulta-margem`.
  - Rota `/consulta-ribeirao` mantida para compatibilidade.

- `RibeiraoPage.tsx`
  - Título principal alterado para `Consulta de Margem`.
  - Descrição alterada para `Consulte margens em lote por convênio, prefeitura ou governo.`
  - Removida a navegação principal por abas da experiência exibida.
  - Criado bloco `1. Conexão`.
  - Criado select com:
    - Prefeitura de Ribeirão Preto
    - Governo do Amapá
    - Governo de SP / Tribunal de Justiça de SP
  - Criado bloco `2. Arquivo CSV`.
  - Criado bloco `3. Retorno`.
  - Criado card `Resumo`.
  - Criado botão `Consultar Margem em Lote`.
  - Criada tabela `Consultas recentes`.

## Fontes

- `prefeitura_ribeirao_preto`: usa a lógica já existente de Ribeirão Preto.
- `governo_amapa`: fonte ainda não implementada.
- `governo_sp_tjsp`: fonte ainda não implementada.

Quando uma fonte não implementada for selecionada e o usuário tentar consultar, o sistema retorna:

`Fonte ainda não implementada.`

## Regras funcionais aplicadas

- O botão fica desabilitado sem conexão selecionada.
- O botão fica desabilitado sem arquivo CSV/TXT enviado.
- O botão fica desabilitado sem CPF válido.
- O resumo atualiza a conexão selecionada.
- O resumo atualiza a quantidade de CPFs após carregar arquivo.
- Upload aceita `.csv` e `.txt`.
- Validação de máximo de 450 CPFs no início da consulta.

## Busca realizada

Busca feita em `frontend/src` por:

- `Consulta Ribeirão`
- `Consulta RibeirÃ£o`
- `consulta-ribeirao`
- `Ribeirao`
- `ribeirao`

Resultado relevante:

- Não há mais `Consulta Ribeirão` como label/título no frontend.
- A rota antiga `/consulta-ribeirao` existe apenas como compatibilidade e renderiza a nova tela.

## Build

Comando executado:

```bash
npm run build --workspace frontend
```

Resultado:

- Build concluído com sucesso.
- Arquivo gerado: `dist/assets/index-CgNZiFgh.js`.
- Aviso apenas de chunk grande do Vite, sem falha de build.

## Status final

Pendente apenas deploy/rebuild da VPS após commit para a produção refletir a alteração.

