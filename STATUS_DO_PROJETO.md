# Status do Projeto CRM Relianse

Atualizado para transferencia entre ambientes/Codex.

## Resumo tecnico

O CRM Relianse e uma aplicacao full stack com frontend React/Vite, backend Node/Express, persistencia SQLite via `sql.js`, automacoes Python/Playwright e deploy Docker Compose.

Repositorio:

```text
https://github.com/relianceemprestimos-star/relianse-crm.git
```

Branch:

```text
main
```

## Estado operacional

| Area | Status | Observacao |
| --- | --- | --- |
| Frontend | Funcional | Build Vite validado. |
| Backend | Funcional | Sintaxe Node validada. |
| Banco SQLite | Funcional | Schema criado em `backend/src/db.js`; dados reais ficam fora do Git. |
| Docker Compose | Funcional | Stack com backend, frontend e Caddy. |
| Login/usuarios | Funcional | Perfis gerencial/vendedor existentes. |
| Upload de listas | Funcional | Erro `observacao is not defined` corrigido. |
| Campanhas | Funcional/estruturado | Campanhas, detalhes e vinculacao com clientes. |
| Fila/Atendimento | Funcional | Atendimento cliente por cliente e historico. |
| Relatorios | Funcional/expandivel | Relatorios comerciais basicos. |
| Consulta Ribeirao | Funcional com dependencia externa | Requer credenciais e portal disponivel; nao burla CAPTCHA/certificado. |
| Consulta Nova Vida | Funcional | Busca telefones e dados cadastrais enriquecidos. |
| Exportacao | Funcional/expandida | Inclui dados Nova Vida quando disponiveis. |

## Integracao Nova Vida

Status: implementada e validada em smoke test real no backend Docker/VPS.

Dados capturados quando disponiveis:

- nome completo;
- CPF;
- nascimento;
- idade;
- sexo;
- nome da mae;
- nome do pai;
- e-mails;
- enderecos;
- telefones;
- qualidade/tipo de telefone;
- `raw_data`.

Tabela principal de enriquecimento:

```text
client_enrichment_data
```

Arquivos principais:

```text
backend/src/services/phone_lookup/nova_vida_cli.py
backend/src/services/phone_lookup/novaVidaProvider.js
backend/src/services/phone_lookup/phoneLookupService.js
frontend/src/pages/PhoneLookupPage.tsx
frontend/src/pages/AttendancePage.tsx
docs/CONSULTA_CADASTRAL_NOVA_VIDA.md
```

## Consulta Ribeirao

Status: modulo estruturado com muitos ajustes ja realizados.

Pontos ja tratados:

- headless em Docker/VPS;
- logs e diagnosticos;
- DNS/Chromium;
- login em etapas;
- selecao de convenio;
- parser de margem;
- exportacao com dados de lote.

Risco atual: o portal externo pode mudar layout, exigir validacao manual, certificado, CAPTCHA ou bloquear sessao. Nesses casos, o CRM deve retornar erro classificado e nao senha invalida generica.

## Banco e dados sensiveis

Nao versionar:

- `.env`;
- bancos `.sqlite`/`.db`;
- logs;
- uploads;
- sessoes Playwright/storage state;
- prints/evidencias;
- planilhas reais de clientes;
- tokens/cookies/senhas.

O `.gitignore` foi reforcado para esses itens.

## Como validar rapidamente

Local:

```bash
npm install
npm run build --workspace frontend
node --check backend/src/server.js
node --check backend/src/db.js
node --check backend/src/services/phone_lookup/novaVidaProvider.js
node --check backend/src/services/phone_lookup/phoneLookupService.js
python -m py_compile backend/src/services/phone_lookup/nova_vida_cli.py
docker compose config
docker compose up -d --build
docker compose ps
```

VPS:

```bash
cd /root/relianse-crm-main
git pull origin main
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 backend
curl https://SEU_DOMINIO_AQUI/api/health
```

## Prioridades recomendadas

1. Criar backup automatico da VPS.
2. Criar testes unitarios para parsers Nova Vida/Ribeirao.
3. Refinar permissoes de dados enriquecidos.
4. Adicionar tela de auditoria para consultas Nova Vida.
5. Consolidar exportacao `.xlsx`.
6. Revisar usuarios iniciais e trocar senhas padrao em producao.

## Observacao para novo executor

Antes de alterar producao, sempre verificar:

```bash
git status
docker compose ps
docker compose logs --tail=100 backend
ls -lah data uploads logs
```

Se houver dados reais, fazer backup antes de qualquer rebuild, migracao ou limpeza.
