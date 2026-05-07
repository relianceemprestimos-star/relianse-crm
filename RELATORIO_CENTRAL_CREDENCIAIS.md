# Relatório - Central de Credenciais

## Objetivo

Criar a aba **Credenciais** no Reliance CRM para centralizar conexão, teste, sessão e login assistido dos portais averbadores usados na Consulta de Margem.

## Nova rota e menu

- Rota criada: `/credenciais`
- Menu lateral: adicionada opção **Credenciais** próxima de Consulta de Margem, Consulta de Telefones, Usuários e Configurações.
- Acesso visual e ações de gerenciamento: restritos ao perfil `gerencial`.
- Consulta de Margem pode verificar status de credencial por portal sem receber senha.

## Portais configurados

- `prefeitura_ribeirao_preto`: Prefeitura de Ribeirão Preto
- `governo_sp`: Governo de SP
- `governo_amapa`: Governo do Amapá

URLs padrão:

- Prefeitura de Ribeirão Preto: `https://saec.consiglog.com.br/Login.aspx`
- Governo de SP: `https://www.portaldoconsignado.com.br/home?1`
- Governo do Amapá: `https://consignataria.apconsig.ap.gov.br/login`

## Banco de dados

Tabelas adicionadas no schema SQLite:

- `averbador_credentials`
- `averbador_sessions`
- `credential_connection_logs`

As senhas são armazenadas no campo `encrypted_password` com criptografia AES-256-GCM no backend. A chave deriva de `CREDENTIALS_ENCRYPTION_KEY`, com fallback para `JWT_SECRET`.

## Endpoints criados

- `GET /api/credentials/portals`
- `GET /api/credentials`
- `GET /api/credentials/:portalId`
- `POST /api/credentials`
- `PUT /api/credentials/:id`
- `POST /api/credentials/:id/test`
- `POST /api/credentials/:id/assisted-login/start`
- `POST /api/credentials/:id/assisted-login/confirm`
- `GET /api/credentials/logs`

## Fluxos antigos encontrados e reaproveitados

O projeto já possui o fluxo operacional de Ribeirão em:

- `backend/src/services/averbadores/ribeirao/ribeiraoService.js`
- `backend/src/services/averbadores/ribeirao/ribeiraoBatchService.js`
- `backend/src/services/averbadores/ribeirao/ribeiraoAdapter.js`
- `backend/src/services/averbadores/ribeirao/ribeirao_cli.py`

Também existem componentes legados dentro do worker vendorizado em:

- `backend/src/services/averbadores/ribeirao/vendor/worker/legacy_portal`

O lote de Ribeirão foi reaproveitado. Governo de SP e Governo do Amapá ficam configuráveis na Central de Credenciais, mas retornam "Fonte ainda não implementada" quando acionados na Consulta de Margem.

## Login assistido do Governo de SP

O Governo de SP exige CAPTCHA. O CRM não tenta burlar CAPTCHA.

Fluxo implementado:

1. Usuário salva a credencial.
2. Clica em **Iniciar login assistido**.
3. CRM abre o portal em nova aba.
4. Usuário resolve CAPTCHA/login manualmente.
5. Usuário confirma sessão ativa no CRM.
6. CRM registra sessão ativa por 8 horas e salva log.

## Integração com Consulta de Margem

A Consulta de Margem agora verifica a credencial selecionada antes de iniciar lote.

Regras:

- Prefeitura de Ribeirão Preto usa credencial `prefeitura_ribeirao_preto`.
- Governo do Amapá e Governo de SP ficam bloqueados com mensagem de fonte pendente.
- Se a credencial não existir, a tela orienta acessar **Credenciais**.
- Se não houver sessão Ribeirão ativa, o backend tenta iniciar sessão usando a credencial salva antes de iniciar o lote.

## Segurança

- Senha não é devolvida para o frontend.
- Senha não é registrada em log.
- Senha não fica em código.
- Gerenciamento restrito ao perfil gerencial.
- Logs não gravam tokens, cookies ou senha.
- CAPTCHA tratado apenas por login assistido.

## Arquivos alterados

- `backend/src/db.js`
- `backend/src/server.js`
- `backend/src/services/credentials/portalConfigs.js`
- `backend/src/services/credentials/credentialService.js`
- `frontend/src/App.tsx`
- `frontend/src/components/Shell.tsx`
- `frontend/src/lib/api.ts`
- `frontend/src/pages/CredentialsPage.tsx`
- `frontend/src/pages/RibeiraoPage.tsx`
- `frontend/src/types.ts`
- `RELATORIO_CENTRAL_CREDENCIAIS.md`

## Status final

Implementado localmente. Validações de build e deploy ficam registradas no retorno da execução.
