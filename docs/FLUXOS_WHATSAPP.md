# Fluxos WhatsApp - Reliance CRM

## Objetivo

A area de Fluxos WhatsApp permite criar automacoes controladas de atendimento com gatilhos de resposta, sem disparo em massa agressivo.

## Onde usar

- Menu lateral: `Fluxos de WhatsApp`
- Rota: `/whatsapp-fluxos`
- Dentro de `WhatsApp API` existem as guias: `Conexao`, `Templates`, `Fluxos`, `Historico`.
- Na tela do cliente (`/atendimento`) existe a secao **Fluxo WhatsApp** para iniciar/parar fluxo.

## Como criar um fluxo

1. Acesse `WhatsApp API > Fluxos`.
2. Clique em `Novo fluxo`.
3. Configure:
   - Nome e descricao
   - Template inicial (opcional)
   - Mensagem inicial (opcional)
   - Mensagem fallback (nao entendida)
   - Limite de respostas nao entendidas para escalar ao humano
4. Em **Respostas esperadas**, adicione:
   - Gatilhos por palavras-chave
   - Resposta automatica
   - Acao (`none`, `interest`, `opt_out`, `human`)
   - Status de cliente para aplicar (ex: `em_atendimento`, `sem_interesse`)
   - Flags `Humano assumir` e `Parar fluxo`
5. Salve o fluxo.

## Fluxo padrao criado automaticamente

Nome: `Primeiro contato consignado`

Inclui 3 blocos:
- Interesse: `pode mandar`, `sim`, `quero`, `manda`, `pode`, `tenho interesse`
- Recusa/opt-out: `nao tenho interesse`, `nao quero`, `parar`, `remover`, `bloquear`, `nao me chama`, `agora nao`
- Humano: `atendente`, `humano`, `falar com alguem`, `me liga`, `ligacao`, `quero falar`

## Como iniciar fluxo no cliente

Na tela de atendimento do cliente:

1. Selecione o fluxo na secao **Fluxo WhatsApp**.
2. Clique em `Iniciar fluxo`.
3. O CRM envia a mensagem inicial e cria uma execucao ativa.

Para parar:

1. Clique em `Parar fluxo`.
2. O CRM encerra a execucao com status `stopped`.

## Como funciona no webhook

Quando chega mensagem recebida:

1. CRM identifica cliente pelo telefone.
2. Salva mensagem em `whatsapp_messages`.
3. Se existir fluxo ativo do cliente:
   - tenta casar gatilho da resposta.
   - envia resposta automatica da etapa.
   - aplica acao/estado no cliente.
   - grava log em `whatsapp_flow_logs`.
4. Se nao casar gatilho:
   - envia fallback de orientacao.
   - incrementa contador de nao entendidas.
   - ao atingir limite (padrao 2), encaminha para humano.
5. Se nao houver fluxo ativo:
   - aplica regra geral de interesse/opt-out ja existente.

## Opt-out e bloqueios

Antes de iniciar envio/fluxo:

- cliente sem telefone valido: bloqueado.
- cliente com status sem interesse/bloqueado/nao abordar: bloqueado.
- cliente com opt-out: bloqueado.

Ao detectar opt-out por gatilho:

- `whatsapp_opt_out = 1`
- `whatsapp_blocked = 1`
- `whatsapp_allowed = 0`
- status do atendimento atualizado para `sem_interesse`

## Historico e auditoria

As execucoes e logs ficam em:

- `whatsapp_flow_executions`
- `whatsapp_flow_logs`
- `whatsapp_messages`

Tudo fica registrado com data/hora e acao aplicada.

## Endpoints de fluxos

- `GET /api/whatsapp/flows`
- `POST /api/whatsapp/flows`
- `PUT /api/whatsapp/flows/:id`
- `POST /api/whatsapp/flows/start`
- `POST /api/whatsapp/flows/stop`
- `GET /api/whatsapp/flows/executions`
- `GET /api/whatsapp/flows/logs`
