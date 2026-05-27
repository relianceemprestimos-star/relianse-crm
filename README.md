# Reliance CRM

CRM operacional para a Reliance, empresa de credito consignado para servidores publicos, prefeituras, governos e convenios. O sistema centraliza bases de clientes, campanhas, fila de atendimento, historico comercial, relatorios, Consulta Ribeirao e consulta cadastral/telefones via Nova Vida.

## Classificacao e plano LGPD

Classificacao atual: **USO_PROPRIO / USO INTERNO CONTROLADO**. O CRM Reliance nao esta aprovado para SaaS e nao deve ser tratado como multi-tenant sem nova investigacao, ADR especifico e plano de isolamento de dados.

As correcoes criticas de LGPD e seguranca estao sendo aplicadas em PRs menores para reduzir risco operacional. Este ciclo documenta o plano e prepara as proximas etapas de opt-in, rate limit, protecao de dados, auditoria e testes.

## Objetivo do projeto

- Importar bases Excel/CSV de clientes.
- Organizar clientes por campanhas e convenios.
- Priorizar atendimento por margem disponivel.
- Registrar atendimentos, retornos e status comerciais.
- Consultar margem no portal Ribeirao/SAEC quando configurado.
- Consultar telefones e dados cadastrais no Nova Vida quando configurado.
- Exportar dados operacionais para acompanhamento comercial.

## Tecnologias usadas

- Frontend: React, Vite, TypeScript, Tailwind CSS.
- Backend: Node.js, Express, sql.js/SQLite, JWT, bcrypt.
- Automacoes: Python, Playwright.
- Docker: Docker Compose com backend, frontend Nginx e Caddy.
- Banco: SQLite persistido em volume/pasta `data/`.

## Estrutura de pastas

```text
backend/                         Backend Node/Express
backend/src/db.js                 Schema, persistencia e regras principais
backend/src/server.js             Rotas HTTP da API
backend/src/services/             Integracoes e workers
backend/src/services/averbadores/ Consulta Ribeirao
backend/src/services/phone_lookup Consulta Nova Vida
frontend/                         Frontend React/Vite
frontend/src/pages/               Telas do CRM
docs/                             Documentacao operacional
scripts/                          Scripts auxiliares
data/                             Banco e sessoes locais, nao versionar
uploads/                          Uploads locais, nao versionar
logs/                             Logs locais, nao versionar
docker-compose.yml                Stack de producao/local Docker
Caddyfile                         Proxy HTTPS em producao
```

## Configuracao de ambiente

Copie o exemplo e preencha manualmente os valores reais:

```bash
cp .env.example .env
```

Variaveis principais:

```text
CRM_DOMAIN
CRM_WWW_DOMAIN
APP_URL
FRONTEND_URL
BACKEND_URL
CORS_ORIGIN
BACKEND_PORT
SQLITE_PATH
DATABASE_PATH
UPLOAD_DIR
LOG_DIR
JWT_SECRET
VITE_API_URL
PYTHON_BIN
RIBEIRAO_AVERBADOR_URL
RIBEIRAO_AVERBADOR_CONSULTA_URL
RIBEIRAO_AVERBADOR_LOGIN
RIBEIRAO_AVERBADOR_PASSWORD
RIBEIRAO_AVERBADOR_ORGAO
RIBEIRAO_HEADLESS
PHONE_LOOKUP_ENABLED
PHONE_LOOKUP_MAX_PER_RUN
PHONE_LOOKUP_DELAY_SECONDS
NOVA_VIDA_URL
NOVA_VIDA_USERNAME
NOVA_VIDA_USER
NOVA_VIDA_CLIENT
NOVA_VIDA_PASSWORD
NOVA_VIDA_HEADLESS
NOVA_VIDA_STORAGE_STATE
```

Nunca commite `.env`, bancos SQLite, logs, sessoes de navegador, planilhas reais ou arquivos de clientes.

## Instalar localmente

Requisitos:

- Node.js compativel com o projeto.
- npm.
- Python 3.

Instalacao:

```bash
npm install
```

Rodar em desenvolvimento:

```bash
npm run dev
```

Padrao local:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`

Scripts uteis:

```bash
npm run dev
npm run dev:backend
npm run dev:frontend
npm run build --workspace frontend
npm run migrate --workspace backend
npm run seed --workspace backend
```

## Rodar com Docker

Prepare o `.env` e execute:

```bash
docker compose up -d --build
```

Verificar containers:

```bash
docker compose ps
docker compose logs --tail=100 backend
docker compose logs --tail=100 frontend
```

Healthcheck:

```bash
curl http://localhost/api/health
```

Em VPS com dominio apontado para o servidor:

```bash
curl https://SEU_DOMINIO_AQUI/api/health
```

## Rodar na VPS

Instalar dependencias basicas:

```bash
apt update && apt upgrade -y
apt install -y git docker.io docker-compose-plugin
systemctl enable --now docker
```

Clonar:

```bash
cd /root
git clone https://github.com/relianceemprestimos-star/relianse-crm.git relianse-crm-main
cd relianse-crm-main
cp .env.example .env
nano .env
```

Subir:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f backend
```

Atualizar depois de novo commit:

```bash
cd /root/relianse-crm-main
git pull origin main
docker compose up -d --build
docker compose ps
```

## Backup antes de mexer em producao

Antes de atualizar VPS ou banco real:

```bash
mkdir -p /root/backups-relianse
tar -czf /root/backups-relianse/relianse-$(date +%Y%m%d-%H%M%S).tar.gz data uploads logs .env
```

Tambem existe:

```bash
chmod +x scripts/backup.sh
./scripts/backup.sh
```

## Funcionalidades principais

- Login e perfis gerencial/vendedor.
- Upload de listas com preview e importacao.
- Campanhas com clientes vinculados.
- Bases e fila de clientes.
- Atendimento cliente por cliente.
- Relatorios.
- WhatsApp Web estrutural.
- Consulta Ribeirao individual/lote.
- Consulta de Telefones/Dados Nova Vida.

## Consulta Ribeirao

Configurar no `.env`:

```env
RIBEIRAO_AVERBADOR_URL=
RIBEIRAO_AVERBADOR_CONSULTA_URL=
RIBEIRAO_AVERBADOR_LOGIN=
RIBEIRAO_AVERBADOR_PASSWORD=
RIBEIRAO_AVERBADOR_ORGAO=
RIBEIRAO_HEADLESS=true
CAPSOLVER_ENABLED=false
CAPSOLVER_API_KEY=
CAPSOLVER_TIMEOUT_SECONDS=120
RIBEIRAO_DISABLE_CAPSOLVER_WRAPPER=false
```

Observacoes:

- Em Docker/VPS, `RIBEIRAO_HEADLESS=true`.
- Para portais com reCAPTCHA operacional, como Santana de Parnaiba, o wrapper CapSolver fica habilitado por padrao quando `RIBEIRAO_DISABLE_CAPSOLVER_WRAPPER` nao esta como `true`.
- As variaveis CapSolver devem ser preservadas nos exemplos, sempre sem chave real.
- Sem `CAPSOLVER_API_KEY`, o fluxo volta para validacao manual quando o portal exigir CAPTCHA.
- O sistema nao deve contornar certificado digital ou bloqueio manual nao autorizado.
- Logs tecnicos ficam no backend; a UI deve mostrar mensagens classificadas.

## Consulta Nova Vida

Configurar no `.env`:

```env
PHONE_LOOKUP_ENABLED=true
NOVA_VIDA_URL=
NOVA_VIDA_USERNAME=
NOVA_VIDA_USER=
NOVA_VIDA_CLIENT=
NOVA_VIDA_PASSWORD=
NOVA_VIDA_HEADLESS=true
NOVA_VIDA_STORAGE_STATE=/app/data/nova_vida_storage_state.json
```

A aba **Consulta de Telefones** tambem exibe dados cadastrais enriquecidos, quando retornados pela fonte:

- nome completo;
- CPF;
- nascimento;
- idade;
- sexo;
- mae/pai;
- e-mails;
- enderecos;
- telefones;
- dados brutos em `raw_data` para auditoria tecnica.

Documentacao detalhada:

- `docs/CONSULTA_TELEFONES_NOVA_VIDA.md`
- `docs/CONSULTA_CADASTRAL_NOVA_VIDA.md`
- `docs/INTEGRACAO_NOVA_VIDA.md`

## Comandos de manutencao

```bash
git status
git pull origin main
npm install
npm run build --workspace frontend
node --check backend/src/server.js
node --check backend/src/db.js
python -m py_compile backend/src/services/phone_lookup/nova_vida_cli.py
python -m py_compile backend/src/services/averbadores/ribeirao/ribeirao_cli.py
docker compose config
docker compose up -d --build
docker compose logs -f backend
docker compose exec backend env | grep -E "RIBEIRAO|NOVA_VIDA|PHONE_LOOKUP"
```

## Seguranca

- Credenciais ficam somente em `.env` ou cofre seguro.
- `.env`, bancos, logs, sessoes e uploads estao no `.gitignore`.
- Nao enviar WhatsApp automaticamente sem comando humano.
- Nao apagar banco real sem backup.
- Nao consultar portais fora da finalidade comercial autorizada.
- Nao expor senha, token, cookie ou dados pessoais completos em logs tecnicos.

## Transferencia para outro Codex

Leia primeiro:

```text
INSTRUCOES_PARA_OUTRO_CODEX.md
STATUS_DO_PROJETO.md
```

Depois clone o repositorio, crie `.env` a partir de `.env.example`, instale dependencias e rode os comandos de validacao.
