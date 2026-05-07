# Instrucoes para outro Codex continuar o CRM Relianse

Este arquivo e o handoff tecnico para abrir o projeto em outra conta/Codex sem perder contexto.

## 1. Contexto do projeto

O projeto e o CRM operacional da Relianse para credito consignado. Ele organiza bases de clientes, campanhas, fila de atendimento, historico comercial, relatorios e integracoes com portais externos autorizados.

Repositorio GitHub:

```text
https://github.com/relianceemprestimos-star/relianse-crm.git
```

Branch principal:

```text
main
```

## 2. O que ja foi feito

- Frontend React/Vite com tema escuro e menu lateral.
- Backend Node/Express com SQLite via `sql.js`.
- Login, usuarios, perfis e protecao de rotas.
- Upload de listas Excel/CSV com preview.
- Campanhas e vinculacao de clientes a campanhas.
- Bases, fila de clientes e atendimento.
- Relatorios comerciais.
- WhatsApp Web estrutural.
- Consulta Ribeirao/SAEC com worker Python/Playwright.
- Consulta de Telefones via Nova Vida.
- Enriquecimento cadastral Nova Vida com telefones, e-mails, enderecos, nascimento, idade, sexo, mae/pai e `raw_data`.
- Docker Compose com backend, frontend e Caddy.
- `.env.example`, README e documentacao operacional.

## 3. O que esta funcionando

- Build do frontend: `npm run build --workspace frontend`.
- Sintaxe backend: `node --check backend/src/server.js` e `node --check backend/src/db.js`.
- Worker Nova Vida: `python -m py_compile backend/src/services/phone_lookup/nova_vida_cli.py`.
- Docker Compose: backend/frontend/caddy.
- Na VPS atual, o smoke test Nova Vida retornou:
  - status `success`;
  - nome completo correto;
  - nascimento;
  - idade;
  - sexo;
  - e-mails;
  - enderecos;
  - telefones;
  - `raw_data`.

## 4. Problemas importantes ja corrigidos

- `observacao is not defined` no upload de listas.
- Consulta Ribeirao em modo headed dentro da VPS/Docker.
- Diagnosticos de build e healthcheck.
- DNS/Chromium em Docker para portais externos.
- Fluxo de login Ribeirao em duas etapas.
- Parser/exportacao de margens Ribeirao.
- CSV/Excel com separador adequado.
- Integracao Nova Vida com seletores reais:
  - usuario;
  - senha;
  - cliente/tenant;
  - campo CPF/CNPJ;
  - pagina de resultado cadastral.
- Parser do nome completo Nova Vida, que antes capturava texto de menu junto.

## 5. Credenciais que precisam ser preenchidas manualmente

Nao ha credenciais reais versionadas. Preencher no `.env` local/VPS:

```text
JWT_SECRET
CRM_DOMAIN
CRM_WWW_DOMAIN
APP_URL
FRONTEND_URL
BACKEND_URL
CORS_ORIGIN
RIBEIRAO_AVERBADOR_URL
RIBEIRAO_AVERBADOR_CONSULTA_URL
RIBEIRAO_AVERBADOR_LOGIN
RIBEIRAO_AVERBADOR_PASSWORD
RIBEIRAO_AVERBADOR_ORGAO
NOVA_VIDA_URL
NOVA_VIDA_USERNAME
NOVA_VIDA_USER
NOVA_VIDA_CLIENT
NOVA_VIDA_PASSWORD
```

Use `.env.example` como base:

```bash
cp .env.example .env
```

## 6. Como rodar em outro Codex

```bash
git clone https://github.com/relianceemprestimos-star/relianse-crm.git
cd relianse-crm
cp .env.example .env
npm install
npm run build --workspace frontend
node --check backend/src/server.js
node --check backend/src/db.js
python -m py_compile backend/src/services/phone_lookup/nova_vida_cli.py
docker compose config
docker compose up -d --build
docker compose ps
```

Se usar Windows PowerShell, os mesmos comandos funcionam, exceto ferramentas Linux como `grep`. Use `Select-String` no Windows.

## 7. Como rodar na VPS

```bash
cd /root
git clone https://github.com/relianceemprestimos-star/relianse-crm.git relianse-crm-main
cd relianse-crm-main
cp .env.example .env
nano .env
docker compose up -d --build
docker compose ps
docker compose logs -f backend
```

Atualizar VPS existente:

```bash
cd /root/relianse-crm-main
git status
git pull origin main
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 backend
```

## 8. Cuidados antes de qualquer mudanca

- Nunca apagar `data/`, `uploads/`, `logs/` ou `.env` sem backup.
- Nunca commitar `.env`, bancos SQLite, sessoes de navegador, prints de evidencia, planilhas reais ou logs.
- Antes de mexer na VPS, criar backup:

```bash
tar -czf /root/backup-relianse-$(date +%Y%m%d-%H%M%S).tar.gz data uploads logs .env
```

- Nao sobrescrever dados manuais do cliente sem regra explicita.
- Nao disparar WhatsApp automaticamente.
- Nao burlar CAPTCHA, certificado digital ou bloqueios dos portais.
- Em logs tecnicos, evitar senha, token, cookie e dados pessoais completos.

## 9. Arquivos mais importantes

```text
backend/src/db.js
backend/src/server.js
backend/src/services/phone_lookup/nova_vida_cli.py
backend/src/services/phone_lookup/novaVidaProvider.js
backend/src/services/phone_lookup/phoneLookupService.js
backend/src/services/averbadores/ribeirao/ribeirao_cli.py
frontend/src/pages/PhoneLookupPage.tsx
frontend/src/pages/RibeiraoPage.tsx
frontend/src/pages/UploadPage.tsx
frontend/src/pages/AttendancePage.tsx
frontend/src/pages/CampaignsPage.tsx
docker-compose.yml
.env.example
README.md
```

## 10. Proximos passos recomendados

1. Criar testes automatizados pequenos para parsers Nova Vida e Ribeirao.
2. Criar tela administrativa para logs/filas de enriquecimento.
3. Revisar permissoes finas: `can_view_enriched_data`, `can_run_nova_vida_lookup`, `can_export_enriched_data`.
4. Melhorar exportacoes com opcao `.xlsx` real.
5. Criar rotina de backup agendada na VPS.
6. Documentar credenciais no cofre da empresa, nunca no repositorio.

## 11. Validacao rapida esperada

Depois de subir:

```bash
curl https://SEU_DOMINIO_AQUI/api/health
```

Resultado esperado:

```json
{
  "status": "ok",
  "app": "Relianse CRM"
}
```

No CRM:

- Login abre.
- Dashboard carrega.
- Upload de Listas abre preview.
- Consulta de Telefones abre.
- Consulta Ribeirao mostra diagnostico/configuracao.
