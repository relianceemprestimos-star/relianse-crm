# Arquitetura

## Visao atual

O CRM Reliance e um sistema operacional de uso interno para correspondente bancario. A arquitetura atual combina frontend React/Vite, backend Node.js/Express, persistencia SQLite/sql.js e integracoes operacionais com portais de margem, consulta cadastral/telefones e WhatsApp Web.

## Classificacao de uso

O projeto permanece classificado como **USO_PROPRIO / USO INTERNO CONTROLADO**. Nao ha arquitetura SaaS ou multi-tenant aprovada nesta fase. Qualquer evolucao para SaaS exige nova investigacao, ADR especifico, isolamento de dados, segregacao de clientes, revisao LGPD e plano de operacao.

## Comunicacao e opt-in

Fluxos de WhatsApp, email ou SMS devem validar opt-in ativo antes de qualquer envio para cliente especifico. Tentativas sem consentimento devem ser bloqueadas e registradas sem dados pessoais completos.

## Dados sensiveis

CPF, telefone, conta, agencia, endereco, beneficio, matricula e dados de credito devem ser tratados como sensiveis. Logs, telas administrativas e relatorios operacionais devem mascarar ou reduzir exposicao sempre que o dado completo nao for estritamente necessario.

## Rotas sensiveis

Login, recuperacao de senha, consulta de telefone, consulta de margem, envio de comunicacao e webhooks devem ter rate limit proporcional ao risco. O objetivo e reduzir abuso, brute force e vazamento por volume.

## Limites conhecidos

- O schema ainda concentra muitas regras no backend principal.
- Migrations versionadas devem ser formalizadas em PR futuro.
- Audit log e consentimento precisam ser implementados no backend em PR separado.
- Vulnerabilidades herdadas `qs` e `xlsx` devem ser tratadas em PR separado.
