# Consulta de Telefones Nova Vida

O CRM possui uma aba própria chamada **Consulta de Telefones** para consultar telefones na fonte autorizada Nova Vida e salvar os resultados no cadastro do cliente.

## Menu

Acesse:

```text
Consulta de Telefones
```

Rota:

```text
/consulta-telefones
```

Permissão atual: perfil gerencial.

## Configuração

As credenciais ficam no `.env`, nunca no código:

```env
PHONE_LOOKUP_ENABLED=true
PHONE_LOOKUP_MAX_PER_RUN=50
PHONE_LOOKUP_DELAY_SECONDS=5
PHONE_LOOKUP_SOURCE=nova_vida
NOVA_VIDA_URL=https://congonhas.novavidati.com.br
NOVA_VIDA_USERNAME=
NOVA_VIDA_USER=
NOVA_VIDA_PASSWORD=
NOVA_VIDA_HEADLESS=false
```

Use `NOVA_VIDA_USERNAME` para o usuário do portal e `NOVA_VIDA_USER` quando houver campo separado de cliente/e-mail.

## Busca individual

Na aba **Consulta de Telefones**:

1. Selecione um cliente do CRM ou informe CPF/nome.
2. Clique em **Buscar no Nova Vida**.
3. Confira os telefones encontrados.
4. Clique em **Salvar todos no cliente** para gravar no cadastro.

Os telefones ficam disponíveis também na tela de **Atendimento**, seção **Telefones**.

## Busca em lote

Na tela **Fila de Clientes**, clique:

```text
Buscar telefones com margem
```

Regra de elegibilidade:

- CPF válido;
- margem maior que zero;
- sem telefone ativo;
- status diferente de sem interesse, bloqueado ou não abordar.

## Fila e worker

Tabela:

```text
phone_lookup_jobs
```

Status:

```text
pending
running
success
failed
not_found
requires_manual_login
blocked
```

Endpoint para processar fila:

```http
POST /api/phone-lookup/worker/run
```

## Histórico

Tabela:

```text
phone_lookup_logs
```

Endpoint:

```http
GET /api/phone-lookup/history
```

O histórico mostra data, cliente, CPF mascarado, status e quantidade de telefones encontrados.

## Login manual

Se o Nova Vida exigir reCAPTCHA, 2FA ou validação manual, o CRM não tenta burlar. O retorno será:

```text
requires_manual_login
```

Script preparado:

```bash
python scripts/login_nova_vida.py
```

Esse comando abre o navegador para login manual autorizado e salva sessão localmente fora do Git.

## Logs

Arquivo:

```text
logs/phone_lookup.log
```

O log registra CPF mascarado, status, quantidade de telefones, duração e erros. Senhas não são registradas.

## Exportação

Na fila, use:

```text
Exportar com telefones
```

Colunas adicionadas:

- telefone_principal;
- telefones_encontrados;
- origem_telefone;
- qualidade_telefone;
- data_busca_telefone.

## Segurança

- Não salvar senha no código.
- Não mostrar senha em log.
- Não consultar clientes sem finalidade comercial.
- Não buscar telefone de cliente bloqueado/sem interesse automaticamente.
- Não burlar CAPTCHA.
- Não disparar WhatsApp automaticamente.
- Registrar histórico para auditoria.
