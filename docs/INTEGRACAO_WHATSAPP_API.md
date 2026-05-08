# Integração WhatsApp API

## Objetivo

O Reliance CRM possui uma camada interna para conectar provedores de WhatsApp sem expor token no frontend e sem acoplar a interface a uma API específica.

O frontend sempre chama o backend em `/api/whatsapp/*`. O backend decide qual provider usar:

- `unofficial`: API não oficial baseada em WhatsApp Web/QR Code.
- `meta`: Meta WhatsApp Business Platform.

## Variáveis de ambiente

Configure no `.env`:

```env
WHATSAPP_PROVIDER=unofficial
WHATSAPP_API_URL=
WHATSAPP_API_TOKEN=
WHATSAPP_TOKEN_ENCRYPTION_KEY=
WHATSAPP_DEFAULT_COUNTRY_CODE=55
WHATSAPP_DEFAULT_NUMBER=
WHATSAPP_SEND_DELAY_SECONDS=5
WHATSAPP_DAILY_LIMIT_PER_NUMBER=30
WHATSAPP_ENABLED=true

META_WHATSAPP_ACCESS_TOKEN=
META_WHATSAPP_PHONE_NUMBER_ID=
META_WHATSAPP_WABA_ID=
META_WHATSAPP_VERIFY_TOKEN=
```

Tokens também podem ser cadastrados pela aba **WhatsApp API**. Depois de salvos, o frontend recebe apenas `has_token=true`.

## Tela WhatsApp API

Rota:

```text
/whatsapp-api
```

A tela permite:

- configurar provedor;
- salvar API URL/token;
- conectar/reconectar;
- testar conexão;
- visualizar QR Code quando o provedor retornar;
- enviar mensagem manual;
- consultar histórico de mensagens e falhas.

## Endpoints

```text
GET  /api/whatsapp/status
GET  /api/whatsapp/config
POST /api/whatsapp/config
POST /api/whatsapp/connect
POST /api/whatsapp/reconnect
POST /api/whatsapp/test
POST /api/whatsapp/send
POST /api/whatsapp/send-template
GET  /api/whatsapp/messages
GET  /api/whatsapp/templates
POST /api/whatsapp/templates
GET  /api/whatsapp/webhook
POST /api/whatsapp/webhook
```

## Provider não oficial

O provider genérico espera estes endpoints no fornecedor configurado:

```text
GET  {WHATSAPP_API_URL}/status
POST {WHATSAPP_API_URL}/connect
POST {WHATSAPP_API_URL}/reconnect
POST {WHATSAPP_API_URL}/send-message
POST {WHATSAPP_API_URL}/send-media
```

Payload de envio padrão:

```json
{
  "phone": "+5516999999999",
  "number": "+5516999999999",
  "to": "+5516999999999",
  "message": "texto",
  "text": "texto",
  "instance_id": "opcional"
}
```

Se o fornecedor usar outro formato, ajuste apenas `backend/src/services/whatsapp/unofficial_whatsapp_provider.js`.

## Provider Meta

O provider Meta está preparado para envio de texto via Graph API usando:

- `META_WHATSAPP_ACCESS_TOKEN`
- `META_WHATSAPP_PHONE_NUMBER_ID`
- `META_WHATSAPP_VERIFY_TOKEN`

Templates oficiais da Meta podem ser adicionados depois no provider `meta_whatsapp_provider.js`.

## Regras de segurança e bloqueio

O backend bloqueia envio quando:

- cliente está com status `sem_interesse`;
- cliente está `bloqueado`;
- cliente está marcado como `nao_abordar` / `não abordar`;
- telefone está vazio ou inválido;
- limite diário por número foi atingido.

Toda tentativa bem-sucedida ou com falha gera registro em `whatsapp_messages`.

## Tabelas

- `whatsapp_configs`
- `whatsapp_templates`
- `whatsapp_messages`
- `whatsapp_send_jobs`

## Tela do cliente

Na tela de atendimento do cliente há uma seção **WhatsApp API** para envio manual. O envio registra uma interação no histórico do cliente.

## Webhook

Configure o fornecedor para enviar eventos para:

```text
https://SEU_DOMINIO/api/whatsapp/webhook
```

O webhook tenta associar mensagens recebidas ao cliente pelo telefone.

## Limitações atuais

- A fila `whatsapp_send_jobs` está modelada e pronta, mas o envio em lote agressivo não foi implementado por regra de segurança.
- A API não oficial é genérica. Cada fornecedor pode exigir ajuste fino no payload.
- A integração Meta inicial cobre status e envio de texto. Templates oficiais podem ser adicionados conforme o provedor for configurado.
