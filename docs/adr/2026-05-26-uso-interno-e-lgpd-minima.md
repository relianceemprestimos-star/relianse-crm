# ADR 2026-05-26 — Uso Interno e Correcoes LGPD Minimas

## Status

Aceito.

## Decisao

Manter o CRM Reliance como USO_PROPRIO / USO INTERNO CONTROLADO.

## Contexto

A investigacao Yntelli indicou que o projeto funciona para operacao interna, mas nao esta pronto para SaaS. Os riscos principais estavam em consentimento, logs, rate limit, auditoria e protecao de dados.

## Consequencias

- Nao transformar em SaaS sem nova investigacao.
- Corrigir opt-in, opt-out, audit log, rate limits e protecoes basicas antes de novas features.
- Manter refatoracoes grandes fora deste bloco.

