# Relianse CRM

CRM escuro e moderno para atendimento, com:

- login e perfis de acesso
- cadastro de usuarios e troca de senha
- upload e separacao de bases
- fila e atendimento cliente por cliente
- WhatsApp Web
- Consulta Ribeirao individual e em lote
- relatorios
- persistencia em SQLite

## Estrutura

- `frontend/` - React + Vite + TypeScript
- `backend/` - Node.js + Express + SQLite
- `docker-compose.yml` - stack de producao
- `Caddyfile` - proxy reverso com HTTPS automatico
- `scripts/backup.sh` - backup manual

## Dominios de producao

Dominio principal:

```text
https://reliancecrm.com.br
```

Redirecionamento:

```text
https://www.reliancecrm.com.br -> https://reliancecrm.com.br
```

## Execucao local

### Instalar dependencias

```bash
npm install
```

### Rodar em desenvolvimento

```bash
npm run dev
```

O frontend sobe em `http://localhost:5173` e o backend em `http://localhost:3001`.

## Produção com Docker

### 1. Preparar a VPS

```bash
ssh root@IP_DA_VPS
apt update && apt upgrade -y
apt install -y git docker.io docker-compose-plugin
systemctl enable --now docker
```

### 2. Clonar o projeto

```bash
cd /opt
git clone URL_DO_REPOSITORIO relianse-crm
cd relianse-crm
```

### 3. Configurar ambiente

```bash
cp .env.example .env
nano .env
```

Preencha pelo menos:

- `CRM_DOMAIN=reliancecrm.com.br`
- `CRM_WWW_DOMAIN=www.reliancecrm.com.br`
- `APP_URL=https://reliancecrm.com.br`
- `FRONTEND_URL=https://reliancecrm.com.br`
- `BACKEND_URL=https://reliancecrm.com.br/api`
- `CORS_ORIGIN=https://reliancecrm.com.br`
- `JWT_SECRET`
- `RIBEIRAO_AVERBADOR_URL`
- `RIBEIRAO_AVERBADOR_LOGIN`
- `RIBEIRAO_AVERBADOR_PASSWORD`

### 4. Subir a stack

```bash
docker compose up -d --build
```

### 5. Verificar

```bash
docker ps
docker compose logs -f
curl https://reliancecrm.com.br/api/health
```

### 6. Atualizar depois

```bash
git pull
docker compose up -d --build
```

## DNS

Crie os registros no provedor do dominio:

- Tipo: `A`
- Nome: `@`
- Valor: IP da VPS

- Tipo: `CNAME` ou `A`
- Nome: `www`
- Valor: `reliancecrm.com.br` ou IP da VPS

Depois acesse:

```text
https://reliancecrm.com.br
```

O `www.reliancecrm.com.br` redireciona automaticamente para o dominio principal.

## Banco e persistencia

O projeto usa SQLite e persiste os dados em:

- `./data`
- `./uploads`
- `./logs`

No Docker, esses diretorios ficam bind-montados no host para nao perder dados em reinicializacoes.

## Usuarios iniciais

- Gerencial: `magali@admin` / `12345`
- Vendedor: `vinicius@admin` / `12345`

Troque as senhas apos o primeiro acesso.

## Backup manual

O script `scripts/backup.sh` cria um `.tar.gz` com:

- `data`
- `uploads`
- `logs`
- `backend/data` se existir

Uso:

```bash
chmod +x scripts/backup.sh
./scripts/backup.sh
```

## Consulta Ribeirao em producao

A aba `Consulta Ribeirao` usa automacao com navegador.

URL real encontrada no legado:

```text
https://saec.consiglog.com.br/Login.aspx
```

Se `RIBEIRAO_AVERBADOR_URL` estiver vazia na VPS, o backend retorna `MISSING_RIBEIRAO_URL` e a tela de Consulta Ribeirao bloqueia o botao de iniciar sessao com uma mensagem clara.

Pontos importantes:

- nao burla CAPTCHA
- se houver validacao manual, o fluxo pausa e aguarda o operador
- a senha do portal nao e exposta no frontend
- o worker legado do Ribeirao foi vendorizado dentro do backend para facilitar o deploy
- Playwright e Python sao instalados na imagem do backend
- em VPS/Docker, use `RIBEIRAO_HEADLESS=true`; `false` so funciona com DISPLAY/Xvfb disponível
- se o Chromium nao subir, o backend retorna `BROWSER_LAUNCH_ERROR` com mensagem amigavel

Se o portal alterar o layout, apenas o modulo Ribeirao pode precisar de ajuste. O restante do CRM continua funcionando normalmente.

## Seguranca

- JWT com `JWT_SECRET` no `.env`
- senha com hash `bcrypt`
- `password_hash` nunca e devolvido ao frontend
- CORS limitado ao dominio oficial em producao
- upload limitado por tamanho e tipo
- logs nao devem exibir senha, token ou CPF completo

## Comandos rapidos

```bash
npm run migrate
npm run seed
npm run build:frontend
npm run dev
docker compose up -d --build
docker compose logs -f
docker compose restart
```
