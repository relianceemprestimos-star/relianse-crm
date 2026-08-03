# Arquitetura — CRM Reliance

## Classificacao

Uso interno controlado. Nao e SaaS nesta fase.

## Fluxo de Consentimento

1. Usuario interno registra opt-in do cliente por canal.
2. O CRM grava `customer_consents`.
3. Antes de abrir WhatsApp via CRM, o backend valida consentimento ativo.
4. Se nao houver opt-in, a acao e bloqueada e registrada em `audit_log`.
5. Opt-out marca consentimento como `revoked` e bloqueia novas comunicacoes.

## Fluxo de Protecao de Dados

- Mascaramento e sanitizacao ficam em `backend/src/dataProtection.js`.
- Hashes de CPF/telefone/email sao derivados com segredo.
- Criptografia AES-256-GCM esta disponivel para novos campos sensiveis.
- Dados legados ainda exigem plano de migracao controlado.

## Fluxo de Seguranca HTTP

- `helmet` adiciona headers de seguranca.
- `express-rate-limit` protege globalmente login, comunicacao e consultas sensiveis.
- JWT continua via Bearer token.

## Dividas Tecnicas

- `backend/src/db.js` ainda concentra schema, persistencia e regras.
- `backend/src/server.js` ainda concentra muitas rotas.
- Migrations ainda nao sao arquivos versionados independentes.
- Multi-tenant, isolamento por cliente e billing nao existem.

