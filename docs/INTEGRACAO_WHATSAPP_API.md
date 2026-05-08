# Integracao WhatsApp API

## Objetivo

O Reliance CRM possui uma camada interna para conectar provedores de WhatsApp sem expor token no frontend e sem acoplamento a um fornecedor unico.

O frontend sempre chama `/api/whatsapp/*`. O backend decide qual provider usar:

- `unofficial`: API nao oficial baseada em WhatsApp Web/QR Code.
- `meta`: Meta WhatsApp Business Platform.

## Variaveis de ambiente

```env
WHATSAPP_PROVIDER=unofficial
WHATSAPP_API_URL=
WHATSAPP_API_TOKEN=
WHATSAPP_TOKEN_ENCRYPTION_KEY=
WHATSAPP_DEFAULT_COUNTRY_CODE=55
WHATSAPP_DEFAULT_NUMBER=
WHATSAPP_INSTANCE_ID=
WHATSAPP_SEND_DELAY_SECONDS=120
WHATSAPP_DAILY_LIMIT_PER_NUMBER=30
WHATSAPP_ENABLED=true
WHATSAPP_MANUAL_ONLY=true

META_WHATSAPP_ACCESS_TOKEN=
META_WHATSAPP_PHONE_NUMBER_ID=
META_WHATSAPP_WABA_ID=
META_WHATSAPP_VERIFY_TOKEN=
```

## Rotas de interface

- `WhatsApp API`: `/whatsapp-api`
- `Fluxos de WhatsApp`: `/whatsapp-fluxos`

## Endpoints

```text
GET  /api/whatsapp/status
GET  /api/whatsapp/config
POST /api/whatsapp/config
POST /api/whatsapp/connect
POST /api/whatsapp/reconnect
GET  /api/whatsapp/qrcode
POST /api/whatsapp/test
POST /api/whatsapp/send
POST /api/whatsapp/send-template
GET  /api/whatsapp/messages
GET  /api/whatsapp/templates
POST /api/whatsapp/templates
PUT  /api/whatsapp/templates/:id
GET  /api/whatsapp/flows
POST /api/whatsapp/flows
PUT  /api/whatsapp/flows/:id
POST /api/whatsapp/flows/start
POST /api/whatsapp/flows/stop
GET  /api/whatsapp/flows/executions
GET  /api/whatsapp/flows/logs
GET  /api/whatsapp/webhook
POST /api/whatsapp/webhook
```

## Regras de envio e bloqueio

O backend bloqueia envio quando:

- cliente esta sem interesse, bloqueado ou nao abordar;
- cliente sem telefone valido;
- cliente com opt-out;
- limite diario por numero excedido;
- intervalo minimo entre mensagens ainda nao cumprido.

Se bloqueado, o CRM registra tentativa com status `blocked_by_rule`.

## Fluxos WhatsApp

A implementacao de fluxo inclui:

- criacao/edicao de fluxo com gatilhos;
- resposta automatica por palavra-chave;
- fallback para resposta nao entendida;
- escalonamento para humano;
- atualizacao de status do cliente;
- logs completos de execucao.

Guia detalhado: `docs/FLUXOS_WHATSAPP.md`.

## Tabelas

- `whatsapp_configs`
- `whatsapp_templates`
- `whatsapp_messages`
- `whatsapp_send_jobs`
- `whatsapp_flows`
- `whatsapp_flow_steps`
- `whatsapp_flow_executions`
- `whatsapp_flow_logs`

## Provider nao oficial

O provider generico tenta os endpoints abaixo (quando existentes):

```text
GET  {WHATSAPP_API_URL}/status
POST {WHATSAPP_API_URL}/connect
POST {WHATSAPP_API_URL}/reconnect
POST {WHATSAPP_API_URL}/send-message
POST {WHATSAPP_API_URL}/send-media
```

Payload de envio padrao:

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

Se o fornecedor usar outro formato, ajuste somente:

- `backend/src/services/whatsapp/unofficial_whatsapp_provider.js`

## Webhook

Destino:

```text
https://SEU_DOMINIO/api/whatsapp/webhook
```

O webhook:

1. salva inbound/outbound status;
2. tenta associar cliente por telefone;
3. aplica fluxo ativo quando existir;
4. aplica fallback de intencao (interesse/opt-out) quando nao existir fluxo.
