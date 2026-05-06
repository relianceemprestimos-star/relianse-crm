# Consulta de Telefones Nova Vida

O CRM possui uma aba propria chamada **Consulta de Telefones** para consultar telefones na fonte autorizada Nova Vida e salvar os resultados no cadastro do cliente.

## Menu

Rota:

```text
/consulta-telefones
```

Permissao atual: perfil gerencial.

## Configuracao

As credenciais ficam no `.env`, nunca no codigo:

```env
PHONE_LOOKUP_ENABLED=true
PHONE_LOOKUP_MAX_PER_RUN=50
PHONE_LOOKUP_DELAY_SECONDS=5
PHONE_LOOKUP_SOURCE=nova_vida
NOVA_VIDA_URL=https://congonhas.novavidati.com.br
NOVA_VIDA_USERNAME=
NOVA_VIDA_USER=
NOVA_VIDA_CLIENT=
NOVA_VIDA_PASSWORD=
NOVA_VIDA_HEADLESS=true
NOVA_VIDA_STORAGE_STATE=/app/data/nova_vida_storage_state.json
```

O formulario publico do Nova Vida usa os campos:

- `#sUsuario`: usuario do portal;
- `#sSenha`: senha;
- `#sCliente`: cliente/contrato/tenant.

Use `NOVA_VIDA_USER` ou `NOVA_VIDA_USERNAME` para o usuario e `NOVA_VIDA_CLIENT` para o campo Cliente. Senha nunca deve ir para o codigo.

## Mapeamento seguro

Antes de consultar clientes reais, rode o mapeamento tecnico:

```http
POST /api/phone-lookup/provider/map
```

Esse endpoint tenta autenticar ou reutilizar a sessao autorizada e retorna apenas estrutura segura da pagina: URL, titulo, campos, botoes e candidatos de navegacao. Ele nao pesquisa CPF.

## Busca individual

Na aba **Consulta de Telefones**:

1. Selecione um cliente do CRM ou informe CPF/nome.
2. Clique em **Buscar no Nova Vida**.
3. Confira os telefones encontrados.
4. Clique em **Salvar todos no cliente** para gravar no cadastro.

Os telefones ficam disponiveis tambem na tela de **Atendimento**, secao **Telefones**.

## Busca em lote

Na tela **Fila de Clientes**, clique:

```text
Buscar telefones com margem
```

Regra de elegibilidade:

- CPF valido;
- margem maior que zero;
- sem telefone ativo;
- status diferente de sem interesse, bloqueado ou nao abordar.

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

## Login manual e sessao

Se o Nova Vida exigir reCAPTCHA, 2FA ou validacao manual, o CRM nao tenta burlar. O retorno sera:

```text
requires_manual_login
```

Script preparado:

```bash
python scripts/login_nova_vida.py
```

Esse comando abre o navegador para login manual autorizado e salva sessao localmente fora do Git.

No Docker/VPS, a sessao padrao fica em:

```text
/app/data/nova_vida_storage_state.json
```

## Historico

Tabela:

```text
phone_lookup_logs
```

Endpoint:

```http
GET /api/phone-lookup/history
```

O historico mostra data, cliente, CPF mascarado, status e quantidade de telefones encontrados.

## Logs

Arquivo:

```text
logs/phone_lookup.log
```

O log registra CPF mascarado, status, quantidade de telefones, duracao e erros. Senhas nao sao registradas.

## Exportacao

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

## Seguranca

- Nao salvar senha no codigo.
- Nao mostrar senha em log.
- Nao consultar clientes sem finalidade comercial.
- Nao buscar telefone de cliente bloqueado/sem interesse automaticamente.
- Nao burlar CAPTCHA.
- Nao disparar WhatsApp automaticamente.
- Registrar historico para auditoria.
