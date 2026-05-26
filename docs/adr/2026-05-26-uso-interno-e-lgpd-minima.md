# ADR: uso interno e LGPD minima

## Status

Aceito em 2026-05-26.

## Contexto

O CRM Reliance atende operacao interna de correspondente bancario e pode lidar com telefone, CPF, dados cadastrais, margem, convenios e informacoes de credito. A investigacao apontou que o sistema pode seguir como uso interno controlado, mas nao deve ser tratado como SaaS nesta fase.

## Decisao

- Manter o CRM Reliance como **USO_PROPRIO / USO INTERNO CONTROLADO**.
- Nao recomendar SaaS sem nova investigacao especifica.
- Aplicar correcoes criticas de LGPD e seguranca em PRs menores.
- Priorizar opt-in, rate limit, mascaramento, protecao de dados, audit log e testes minimos.
- Exigir novo ADR para multi-tenancy, isolamento de dados e operacao SaaS.

## Consequencias

- Novas features devem respeitar uso interno e minimo necessario de dados.
- Comunicacao ativa deve depender de consentimento.
- Dados sensiveis precisam de mascaramento e protecao progressiva.
- Vulnerabilidades herdadas devem ser tratadas sem misturar com PRs de documentacao.
