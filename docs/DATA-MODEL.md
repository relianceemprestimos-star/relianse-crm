# Modelo de Dados

## Visao atual

O CRM Reliance usa SQLite/sql.js com tabelas de usuarios, campanhas, bases, clientes, atendimentos, retornos, consultas de margem e consulta cadastral/telefones. Este PR nao cria migration nem altera schema; ele registra o plano de protecao de dados para os proximos PRs.

## Dados sensiveis

Devem ser tratados como sensiveis:

- CPF/RG e documentos pessoais.
- Telefone e email.
- Endereco.
- Dados bancarios, conta e agencia.
- Beneficio INSS, matricula e dados de convenio.
- Dados de credito, margem, simulacao e proposta.

## Pendencias de modelo

### Consentimento/opt-in

Criar tabela ou estrutura equivalente para registrar consentimento por cliente e canal, com status ativo/revogado, origem, data/hora, texto/versao do consentimento e metadados seguros.

### Audit log

Criar trilha de auditoria para login, envio autorizado, envio bloqueado, opt-out, alteracao de status, consulta sensivel e criacao/alteracao de simulacao ou proposta. Metadata deve ser sanitizada.

### Criptografia e mascara

Definir utilitario central para hash de identificadores sensiveis, criptografia em repouso quando aplicavel e mascaramento para logs/telas. CPF e telefone completos nao devem aparecer em logs tecnicos.

## Fora do escopo deste PR

- Criacao de migrations.
- Alteracao de tabelas.
- Migracao de dados historicos.
- Implementacao backend de consentimento/auditoria.
