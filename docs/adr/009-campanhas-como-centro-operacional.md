# ADR 009 — Campanhas como centro operacional

## Status

Aceito em 2026-07-07.

## Contexto

O CRM acumulou atalhos operacionais separados para clientes, filas, atendimentos, bases, uploads, campanhas e WhatsApp. Isso dificultou a operacao diaria, porque o usuario precisa escolher primeiro o convenio ou orgao que vai trabalhar e depois seguir para atendimento, base, consulta ou relatorio.

O uso atual continua sendo **USO_PROPRIO / USO INTERNO**, sem aprovacao SaaS.

## Decisao

Campanhas passa a ser o centro operacional do CRM.

O operador deve escolher um grupo de campanha, como Prefeitura de Ribeirao Preto, Governo de SP, MP/MPSP ou outro convenio, e trabalhar os clientes a partir desse contexto.

Clientes, atendimentos, upload, bases e WhatsApp continuam existindo como rotas internas ou telas de apoio, mas deixam de ser atalhos principais do menu lateral.

Credenciais permanece como menu gerencial para cadastro de logins dos averbadores. Consulta de margem em lote e consulta de telefones continuam visiveis porque sao ferramentas recorrentes da operacao.

## Consequencias

- Menos itens no menu lateral.
- Menos risco de usuario cair em uma fila sem contexto.
- Campanhas pode evoluir para filtros por prefeitura, governo, orgao e mes.
- Dados existentes nao sao apagados nem migrados nesta fase.
- Qualquer automacao de WhatsApp continua bloqueada sem opt-in ativo.

## Fora do escopo

- Migração destrutiva de dados.
- Deploy automatico.
- Transformar o CRM em SaaS.
- Reescrever o backend de campanhas.
