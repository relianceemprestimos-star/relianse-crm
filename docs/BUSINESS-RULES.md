# Regras de Negocio

## Consentimento

- BR-CONSENT-001: nenhum envio de WhatsApp, email ou SMS deve ocorrer sem opt-in ativo do cliente para o canal.
- BR-CONSENT-002: opt-out bloqueia novos envios no canal revogado.

## Seguranca

- BR-SEC-001: logs nao podem conter CPF, telefone, conta, agencia, token, senha ou payload completo de cliente em texto puro.
- BR-SEC-002: rotas sensiveis devem ter rate limit, incluindo login, envio de comunicacao, consulta de telefone e consulta de margem.

## LGPD

- BR-LGPD-001: o CRM permanece como uso interno ate nova investigacao especifica aprovar outro modelo.
- BR-LGPD-002: dados pessoais devem ser usados somente para finalidade comercial autorizada e com minimo necessario para a operacao.
- BR-LGPD-003: exportacoes e relatorios devem evitar exposicao desnecessaria de dados completos.

## Operacao

- BR-OPS-001: nao fazer deploy automatico de correcao LGPD/seguranca sem aprovacao explicita.
- BR-OPS-002: nao transformar o produto em SaaS sem ADR de multi-tenancy, isolamento de dados e revisao juridica.
