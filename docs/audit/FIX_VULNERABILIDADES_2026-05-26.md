# Fix Vulnerabilidades 2026-05-26

## Contexto

Projeto: CRM Reliance.

Classificacao: USO_PROPRIO / USO INTERNO.

Este PR trata somente vulnerabilidades herdadas de dependencias. Nao altera regra de negocio, nao transforma o projeto em SaaS, nao faz merge e nao faz deploy.

## Vulnerabilidades encontradas

### qs

- Severidade: moderada.
- Origem: dependencia transitiva.
- Caminho identificado: `express@5.2.1` -> `body-parser@2.2.2` / `qs`.
- Versao antes: `qs@6.15.1`.
- Problema: DoS remoto em `qs.stringify` com arrays em formato comma, `null`/`undefined` e `encodeValuesOnly`.
- Correcao disponivel: sim.

### xlsx

- Severidade: alta.
- Origem: dependencia direta em `backend/package.json`.
- Versao atual no npm: `0.18.5`.
- Problemas reportados:
  - Prototype Pollution in SheetJS.
  - SheetJS Regular Expression Denial of Service (ReDoS).
- Correcao disponivel via `npm audit`: nao.
- Versao corrigida compativel no pacote npm oficial: nao encontrada nesta investigacao.

## Uso de xlsx no projeto

`xlsx` e usado no backend para:

- leitura de planilhas importadas em `backend/src/utils.js`;
- exportacao de clientes com telefones em `backend/src/server.js`;
- exportacao de resultados de consulta de margem em `backend/src/services/averbadores/ribeirao/ribeiraoBatchService.js`.

Como a biblioteca ainda e essencial para importacao/exportacao de planilhas e nao ha fix seguro disponivel no pacote npm oficial, ela foi mantida neste PR.

## Acao tomada

### qs

- Executado `npm audit fix`.
- `qs` foi atualizado de `6.15.1` para `6.15.2` no `package-lock.json`.
- A vulnerabilidade de `qs` deixou de aparecer no `npm audit`.

### xlsx

- Mantido `xlsx@0.18.5`.
- Risco documentado como pendencia tecnica.
- Mitigacao operacional registrada:
  - uso restrito a rotas autenticadas do CRM;
  - upload com `multer.memoryStorage`;
  - limite de tamanho controlado por `MAX_UPLOAD_SIZE_MB`, padrao atual de 25 MB;
  - filtro de arquivos para `.xlsx`, `.xls` e `.csv`;
  - evitar processamento de arquivos de origem desconhecida ou nao confiavel;
  - planejar PR futuro para substituicao por alternativa mantida e auditada, com ADR e testes de importacao/exportacao.

## Impacto no build

`npm run build` passou.

Observacao: Vite manteve aviso nao bloqueante de bundle acima de 500 kB.

## Impacto nos testes

`npm test --if-present` executado. A branch `main` nao possui suite configurada.

`npm run test:e2e --if-present` executado. Nao ha suite E2E configurada.

## Resultado do audit

Antes:

- 2 vulnerabilidades: 1 moderada (`qs`) e 1 alta (`xlsx`).

Depois:

- 1 vulnerabilidade alta remanescente: `xlsx`.
- `qs` resolvido.

## Pendencias

- Substituir `xlsx` em PR futuro por alternativa mantida e auditada, ou adotar versao corrigida caso o pacote oficial volte a publicar fix no npm.
- Criar testes especificos para importacao/exportacao de planilhas antes de trocar a biblioteca.
- Avaliar reducao de `MAX_UPLOAD_SIZE_MB` por ambiente, se o uso operacional permitir.

## Recomendacao final

O PR e apto para revisao porque resolve a vulnerabilidade corrigivel (`qs`) e documenta a vulnerabilidade sem fix seguro (`xlsx`) sem improvisar troca de biblioteca. Para dados reais, manter uso de planilhas restrito a operadores internos e arquivos confiaveis ate a substituicao planejada.
