# Regras de Negocio — CRM Reliance

## Classificacao

O CRM Reliance esta classificado como USO_PROPRIO / USO INTERNO CONTROLADO. Ele nao deve ser tratado como SaaS sem nova investigacao especifica.

## Consentimento e Comunicacao

- BR-CONSENT-001: nenhum envio ou abertura assistida de comunicacao por WhatsApp, email ou SMS deve ocorrer sem opt-in ativo para o canal.
- BR-CONSENT-002: opt-out revoga o consentimento do canal e bloqueia novas comunicacoes.
- BR-CONSENT-003: tentativas bloqueadas por falta de consentimento devem ser registradas em audit log sem PII em texto puro.

## Auditoria

- BR-AUDIT-001: login, mudanca de status, comunicacao, bloqueio por consentimento e revogacao de opt-in devem gerar trilha de auditoria.
- BR-AUDIT-002: metadados de auditoria nao devem conter CPF, telefone, conta, agencia, endereco ou payload bruto de cliente em texto puro.

## Protecao de Dados

- BR-DATA-001: logs devem usar CPF e telefone mascarados.
- BR-DATA-002: novos indices de busca para CPF/telefone/email devem preferir hash com segredo.
- BR-DATA-003: campos sensiveis novos que nao precisam ser lidos diretamente devem usar criptografia em repouso.
- BR-DATA-004: migracao completa de dados legados em texto puro exige backup e janela operacional aprovada.

