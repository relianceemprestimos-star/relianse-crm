import crypto from 'node:crypto';

import {
  addInteraction,
  countWhatsappMessagesSentToday,
  createWhatsappMessageRecord,
  createWhatsappSendJobRecord,
  findClientByPhone,
  getClientById,
  getLastWhatsappOutboundByPhone,
  getWhatsappConfigRecord,
  getWhatsappTemplateById,
  listWhatsappMessages,
  listWhatsappTemplates,
  saveWhatsappConfigRecord,
  saveWhatsappTemplateRecord,
  updateClientWhatsappState,
  updateWhatsappMessageRecord,
} from '../../db.js';
import { cleanDigits, normalizePhoneToBrazilInternational } from '../../utils.js';
import { MetaWhatsappProvider } from './meta_whatsapp_provider.js';
import { UnofficialWhatsappProvider } from './unofficial_whatsapp_provider.js';
import { WhatsappProviderError } from './whatsapp_provider_base.js';
import { canSendToClientByStatus, detectInboundIntent, maskPhone } from './whatsapp_rules_service.js';
import { writeWhatsappLog } from './whatsapp_log_service.js';

export class WhatsappServiceError extends Error {
  constructor(message, code = 'WHATSAPP_SERVICE_ERROR', status = 400) {
    super(message);
    this.name = 'WhatsappServiceError';
    this.code = code;
    this.status = status;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function encryptionKey() {
  const secret =
    process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY ||
    process.env.CREDENTIALS_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    'reliance-crm-local-whatsapp-key';
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(value) {
  const text = String(value || '');
  if (!text) return '';
  if (!text.startsWith('v1:')) return text;
  const [, ivRaw, tagRaw, encryptedRaw] = text.split(':');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function publicConfig(config) {
  if (!config) return null;
  const { encrypted_token: _encryptedToken, token: _token, ...safe } = config;
  return {
    ...safe,
    has_token: Boolean(config.has_token || config.encrypted_token || config.token),
  };
}

function envConfig() {
  return {
    provider: process.env.WHATSAPP_PROVIDER || 'unofficial',
    api_url: process.env.WHATSAPP_API_URL || '',
    token: process.env.WHATSAPP_API_TOKEN || '',
    instance_id: process.env.WHATSAPP_INSTANCE_ID || '',
    default_country_code: process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '55',
    default_number: process.env.WHATSAPP_DEFAULT_NUMBER || '',
    enabled: String(process.env.WHATSAPP_ENABLED ?? 'true').toLowerCase() !== 'false',
    send_delay_seconds: Number(process.env.WHATSAPP_SEND_DELAY_SECONDS || 120),
    daily_limit_per_number: Number(process.env.WHATSAPP_DAILY_LIMIT_PER_NUMBER || 30),
    manual_only: String(process.env.WHATSAPP_MANUAL_ONLY ?? 'true').toLowerCase() !== 'false',
    status: process.env.WHATSAPP_API_URL ? 'configured' : 'not_configured',
  };
}

function getConfigWithSecret() {
  const stored = getWhatsappConfigRecord({ includeSecret: true });
  const fallback = envConfig();
  if (!stored) {
    return {
      ...fallback,
      has_token: Boolean(fallback.token),
    };
  }
  const token = decryptSecret(stored.encrypted_token) || fallback.token || '';
  return {
    ...fallback,
    ...stored,
    api_url: stored.api_url || fallback.api_url,
    instance_id: stored.instance_id || fallback.instance_id,
    default_country_code: stored.default_country_code || fallback.default_country_code,
    default_number: stored.default_number || fallback.default_number,
    token,
    has_token: Boolean(token),
  };
}

function getProvider(config) {
  if (String(config.provider || '').toLowerCase() === 'meta') {
    return new MetaWhatsappProvider(config);
  }
  return new UnofficialWhatsappProvider(config);
}

function normalizeOutgoingPhone(phone) {
  const normalized = normalizePhoneToBrazilInternational(phone);
  return normalized ? `+${normalized}` : '';
}

function resolveClient(clientId) {
  if (!clientId) return null;
  const result = getClientById(Number(clientId));
  return result?.client || result || null;
}

function buildTemplateBody(template, variables = {}, client = null) {
  let body = String(template?.body || '');
  const replacements = {
    nome: client?.name || client?.nome || client?.full_name || variables.nome || variables.name || '',
    cpf: client?.cpf || variables.cpf || '',
    ...variables,
  };
  for (const [key, value] of Object.entries(replacements)) {
    const safeValue = String(value ?? '');
    body = body.replace(new RegExp(`\\{${key}\\}`, 'g'), safeValue);
    body = body.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), safeValue);
  }
  return body;
}

function validateClientRules(client) {
  if (!client) return;
  const status = String(client.status_atendimento || client.status || '').trim().toLowerCase();
  if (!canSendToClientByStatus(status)) {
    throw new WhatsappServiceError('Cliente bloqueado por regra de atendimento.', 'WHATSAPP_CLIENT_BLOCKED', 403);
  }
  if (Number(client.whatsapp_allowed ?? 1) !== 1) {
    throw new WhatsappServiceError('Cliente sem permissão para WhatsApp.', 'WHATSAPP_NOT_ALLOWED', 403);
  }
  if (Number(client.whatsapp_opt_out ?? 0) === 1) {
    throw new WhatsappServiceError('Cliente solicitou parar contato no WhatsApp.', 'WHATSAPP_OPTOUT', 403);
  }
  if (Number(client.whatsapp_blocked ?? 0) === 1) {
    throw new WhatsappServiceError('Cliente bloqueado para contato no WhatsApp.', 'WHATSAPP_BLOCKED', 403);
  }
}

function assertRateRules(config, targetPhone) {
  const sentToday = countWhatsappMessagesSentToday({ phone: targetPhone, provider: config.provider });
  const dailyLimit = Number(config.daily_limit_per_number || 30);
  if (sentToday >= dailyLimit) {
    throw new WhatsappServiceError('Limite diário por número atingido.', 'WHATSAPP_DAILY_LIMIT_REACHED', 429);
  }

  const delaySeconds = Math.max(0, Number(config.send_delay_seconds || 120));
  if (delaySeconds > 0) {
    const lastMessage = getLastWhatsappOutboundByPhone(targetPhone);
    if (lastMessage) {
      const sentAt = new Date(lastMessage.sent_at || lastMessage.created_at || 0).getTime();
      if (!Number.isNaN(sentAt)) {
        const elapsedSeconds = (Date.now() - sentAt) / 1000;
        if (elapsedSeconds < delaySeconds) {
          throw new WhatsappServiceError(`Aguarde ${Math.ceil(delaySeconds - elapsedSeconds)}s para novo envio nesse número.`, 'WHATSAPP_SEND_DELAY', 429);
        }
      }
    }
  }
}

function logSendAttempt({ client, phone, status, code = '', message = '' }) {
  writeWhatsappLog(status === 'failed' ? 'error' : 'info', 'send_message', {
    client_id: client?.id ?? null,
    client_name: client?.name ?? '',
    phone,
    masked_phone: maskPhone(phone),
    status,
    code,
    message,
  });
}

async function runConnectionAction(action) {
  const config = getConfigWithSecret();
  if (!config.enabled) {
    throw new WhatsappServiceError('WhatsApp API desativado.', 'WHATSAPP_DISABLED', 403);
  }
  const result = await getProvider(config)[action]();
  saveWhatsappConfigRecord({
    ...config,
    status: result.connected ? 'connected' : result.status || 'pending',
    qrcode: result.qrcode || '',
    last_error: '',
    last_test_at: nowIso(),
    connected_at: result.connected ? nowIso() : config.connected_at,
  });
  writeWhatsappLog('info', action, { status: result.status || '', connected: Boolean(result.connected) });
  return { config: getWhatsappConfig(), ...result };
}

export function getWhatsappConfig() {
  return publicConfig(getConfigWithSecret());
}

export function saveWhatsappConfig(input = {}, userId = null) {
  const current = getConfigWithSecret();
  const token = input.token || input.api_token || input.whatsapp_api_token;
  const encryptedToken = token ? encryptSecret(token) : current.encrypted_token || '';
  const config = saveWhatsappConfigRecord({
    provider: input.provider || current.provider || 'unofficial',
    api_url: input.api_url ?? current.api_url ?? '',
    encrypted_token: encryptedToken,
    default_country_code: input.default_country_code ?? current.default_country_code ?? '55',
    default_number: input.default_number ?? current.default_number ?? '',
    instance_id: input.instance_id ?? current.instance_id ?? '',
    enabled: input.enabled === undefined ? current.enabled : Boolean(input.enabled),
    send_delay_seconds: Number(input.send_delay_seconds ?? current.send_delay_seconds ?? 120),
    daily_limit_per_number: Number(input.daily_limit_per_number ?? current.daily_limit_per_number ?? 30),
    status: input.status || current.status || 'configured',
    qrcode: input.qrcode ?? current.qrcode ?? '',
    last_error: '',
    updated_by: userId,
  });
  writeWhatsappLog('info', 'save_config', { provider: config?.provider, api_url: config?.api_url, has_token: config?.has_token });
  return config;
}

export async function getWhatsappStatus() {
  const config = getConfigWithSecret();
  if (!config.enabled) {
    return { config: publicConfig(config), connected: false, status: 'disabled', message: 'WhatsApp API desativado.' };
  }
  if (!config.api_url && String(config.provider || '').toLowerCase() !== 'meta') {
    return { config: publicConfig(config), connected: false, status: 'not_configured', message: 'API URL nao configurada.' };
  }
  try {
    const status = await getProvider(config).getStatus();
    saveWhatsappConfigRecord({
      ...config,
      status: status.connected ? 'connected' : status.status || 'disconnected',
      qrcode: status.qrcode || config.qrcode || '',
      last_error: '',
      last_test_at: nowIso(),
      connected_at: status.connected ? nowIso() : config.connected_at,
    });
    return { config: getWhatsappConfig(), ...status };
  } catch (error) {
    saveWhatsappConfigRecord({
      ...config,
      status: 'error',
      last_error: error instanceof Error ? error.message : 'Erro ao consultar status.',
      last_test_at: nowIso(),
    });
    return {
      config: getWhatsappConfig(),
      connected: false,
      status: 'error',
      message: error instanceof Error ? error.message : 'Erro ao consultar status.',
      code: error?.code || 'WHATSAPP_STATUS_ERROR',
    };
  }
}

export const connectWhatsapp = () => runConnectionAction('connect');
export const reconnectWhatsapp = () => runConnectionAction('reconnect');
export const testWhatsapp = () => runConnectionAction('getStatus');

export async function getWhatsappQrCode() {
  const config = getConfigWithSecret();
  try {
    const result = await getProvider(config).getQrcode();
    saveWhatsappConfigRecord({
      ...config,
      qrcode: result.qrcode || '',
      status: result.status || config.status || 'unknown',
      last_test_at: nowIso(),
      connected_at: result.connected ? nowIso() : config.connected_at,
    });
    return { qrcode: result.qrcode || '', status: result.status || 'unknown', connected: Boolean(result.connected) };
  } catch (error) {
    if (error?.code === 'WHATSAPP_NOT_CONFIGURED') {
      return { qrcode: '', status: 'not_configured', connected: false };
    }
    throw error;
  }
}

export async function sendWhatsappMessage({ clientId, phone, message, templateId = null, userId = null } = {}) {
  const config = getConfigWithSecret();
  if (!config.enabled) {
    throw new WhatsappServiceError('WhatsApp API desativado.', 'WHATSAPP_DISABLED', 403);
  }

  const client = resolveClient(clientId);
  validateClientRules(client);

  const targetPhone = normalizeOutgoingPhone(phone || client?.phone || client?.telefone || '');
  if (!targetPhone) {
    throw new WhatsappServiceError('Telefone invalido ou ausente.', 'WHATSAPP_INVALID_PHONE', 400);
  }

  const body = String(message || '').trim();
  if (!body) {
    throw new WhatsappServiceError('Mensagem vazia.', 'WHATSAPP_EMPTY_MESSAGE', 400);
  }

  try {
    assertRateRules(config, targetPhone);
  } catch (error) {
    createWhatsappSendJobRecord({
      client_id: client?.id ?? clientId ?? null,
      phone: targetPhone,
      template_id: templateId,
      message_body: body,
      status: 'blocked_by_rule',
      error_message: error instanceof Error ? error.message : 'Bloqueado por regra.',
      created_by: userId,
    });
    logSendAttempt({ client, phone: targetPhone, status: 'blocked_by_rule', code: error?.code || 'RULE_BLOCKED', message: error instanceof Error ? error.message : '' });
    throw error;
  }

  try {
    const result = await getProvider(config).sendMessage(targetPhone, body);
    const messageRecord = createWhatsappMessageRecord({
      client_id: client?.id ?? clientId ?? null,
      phone: targetPhone,
      direction: 'outbound',
      provider: config.provider || 'unofficial',
      template_id: templateId,
      message_body: body,
      status: result.status === 'failed' ? 'failed' : 'sent',
      provider_message_id: result.provider_message_id || '',
      sent_by: userId,
      sent_at: nowIso(),
    });

    if (client?.id) {
      updateClientWhatsappState(client.id, {
        whatsapp_last_contact_at: nowIso(),
        whatsapp_status: 'sent',
      });
      addInteraction(client.id, {
        userId,
        type: 'whatsapp_api_enviado',
        note: `Mensagem enviada via WhatsApp API para ${targetPhone}.`,
      });
    }
    logSendAttempt({ client, phone: targetPhone, status: 'sent' });
    return { message: messageRecord, provider_result: result };
  } catch (error) {
    const messageRecord = createWhatsappMessageRecord({
      client_id: client?.id ?? clientId ?? null,
      phone: targetPhone,
      direction: 'outbound',
      provider: config.provider || 'unofficial',
      template_id: templateId,
      message_body: body,
      status: 'failed',
      error_message: error instanceof Error ? error.message : 'Falha ao enviar mensagem.',
      sent_by: userId,
      sent_at: nowIso(),
    });
    logSendAttempt({
      client,
      phone: targetPhone,
      status: 'failed',
      code: error?.code || 'WHATSAPP_SEND_ERROR',
      message: error instanceof Error ? error.message : '',
    });
    const serviceError = new WhatsappServiceError(
      error instanceof Error ? error.message : 'Falha ao enviar mensagem.',
      error?.code || (error instanceof WhatsappProviderError ? error.code : 'WHATSAPP_SEND_ERROR'),
      502
    );
    serviceError.messageRecord = messageRecord;
    throw serviceError;
  }
}

export async function sendWhatsappTemplate({ clientId, phone, templateId, variables = {}, userId = null } = {}) {
  const template = getWhatsappTemplateById(Number(templateId));
  if (!template || template.active === false) {
    throw new WhatsappServiceError('Template nao encontrado ou inativo.', 'WHATSAPP_TEMPLATE_NOT_FOUND', 404);
  }
  const client = resolveClient(clientId);
  const body = buildTemplateBody(template, variables, client);
  return sendWhatsappMessage({ clientId, phone, message: body, templateId: template.id, userId });
}

export function getWhatsappMessages(params = {}) {
  return listWhatsappMessages(params);
}

export function getWhatsappTemplates(params = {}) {
  return listWhatsappTemplates(params);
}

export function saveWhatsappTemplate(input = {}) {
  if (!String(input.name || '').trim()) {
    throw new WhatsappServiceError('Nome do template obrigatorio.', 'WHATSAPP_TEMPLATE_NAME_REQUIRED');
  }
  if (!String(input.body || '').trim()) {
    throw new WhatsappServiceError('Texto do template obrigatorio.', 'WHATSAPP_TEMPLATE_BODY_REQUIRED');
  }
  return saveWhatsappTemplateRecord(input);
}

export function updateWhatsappTemplate(id, input = {}) {
  return saveWhatsappTemplate({
    ...input,
    id: Number(id),
  });
}

export function queueWhatsappSend(input = {}, userId = null) {
  return createWhatsappSendJobRecord({
    client_id: input.client_id ?? null,
    phone: normalizeOutgoingPhone(input.phone || ''),
    template_id: input.template_id ?? null,
    message_body: input.message_body || '',
    status: input.status || 'pending',
    scheduled_at: input.scheduled_at ?? null,
    created_by: userId,
  });
}

async function handleInboundIntent({ client, inboundText, phone, userId = null }) {
  if (!client?.id) return null;
  const intent = detectInboundIntent(inboundText);
  if (intent === 'none') return { intent: 'none' };

  if (intent === 'interest') {
    updateClientWhatsappState(client.id, {
      whatsapp_last_response_at: nowIso(),
      whatsapp_status: 'interessado',
      status_atendimento: 'em_atendimento',
    });
    addInteraction(client.id, {
      userId,
      type: 'whatsapp_interessado',
      note: 'Cliente demonstrou interesse por WhatsApp. Humano deve assumir o atendimento.',
    });

    const template = listWhatsappTemplates({ active: true }).find((row) => String(row.category || '').toLowerCase() === 'resposta_interesse');
    if (template) {
      await sendWhatsappTemplate({ clientId: client.id, phone, templateId: template.id, variables: { nome: client.name }, userId });
    }
    return { intent: 'interest' };
  }

  if (intent === 'opt_out') {
    const template = listWhatsappTemplates({ active: true }).find((row) => String(row.category || '').toLowerCase() === 'opt_out');
    if (template) {
      try {
        await sendWhatsappTemplate({ clientId: client.id, phone, templateId: template.id, variables: { nome: client.name }, userId });
      } catch {
        // optional response, do not block opt-out update
      }
    }
    updateClientWhatsappState(client.id, {
      whatsapp_last_response_at: nowIso(),
      whatsapp_status: 'opt_out',
      whatsapp_opt_out: 1,
      whatsapp_blocked: 1,
      whatsapp_allowed: 0,
      status_atendimento: 'sem_interesse',
    });
    addInteraction(client.id, {
      userId,
      type: 'whatsapp_opt_out',
      note: 'Cliente pediu para nao receber mais contato por WhatsApp.',
    });
    return { intent: 'opt_out' };
  }

  return { intent: 'none' };
}

export async function receiveWhatsappWebhook(payload = {}) {
  const config = getConfigWithSecret();
  const provider = getProvider(config);
  const parsed = provider.receiveWebhook(payload);
  const saved = [];
  for (const event of parsed.events || []) {
    if (event.type === 'message') {
      const phone = normalizeOutgoingPhone(event.phone || '');
      const client = findClientByPhone(phone);
      const row = createWhatsappMessageRecord({
        client_id: client?.id ?? null,
        phone,
        direction: event.direction || 'inbound',
        provider: config.provider || 'unofficial',
        message_body: event.body || '',
        status: event.status || 'received',
        provider_message_id: event.providerMessageId || '',
        received_at: nowIso(),
      });
      saved.push(row);
      writeWhatsappLog('info', 'webhook_message', {
        client_id: client?.id ?? null,
        phone,
        status: row.status,
      });
      if (client?.id) {
        updateClientWhatsappState(client.id, {
          whatsapp_last_response_at: nowIso(),
          whatsapp_status: 'received',
        });
        addInteraction(client.id, {
          userId: null,
          type: 'whatsapp_api_recebido',
          note: 'Mensagem recebida via WhatsApp API.',
        });
        await handleInboundIntent({
          client,
          inboundText: event.body || '',
          phone,
          userId: null,
        });
      }
    } else if (event.type === 'status' && event.providerMessageId) {
      const current = listWhatsappMessages({ search: event.providerMessageId, limit: 1 })[0];
      if (current) {
        saved.push(
          updateWhatsappMessageRecord(current.id, {
            status: event.status || current.status,
            delivered_at: event.status === 'delivered' ? nowIso() : current.delivered_at,
            read_at: event.status === 'read' ? nowIso() : current.read_at,
          })
        );
      }
    }
  }
  return { saved, events: parsed.events || [] };
}

export function verifyMetaWebhook(query = {}) {
  const verifyToken = process.env.META_WHATSAPP_VERIFY_TOKEN || '';
  if (!verifyToken) return null;
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  return mode === 'subscribe' && token === verifyToken ? String(challenge || '') : null;
}

export function canSendWhatsappToClient(clientId) {
  const client = resolveClient(clientId);
  if (!client) {
    return { allowed: false, reason: 'Cliente nao encontrado.' };
  }
  try {
    validateClientRules(client);
    const phone = normalizeOutgoingPhone(client.phone || '');
    if (!phone) return { allowed: false, reason: 'Cliente sem telefone valido.' };
    return { allowed: true, phone };
  } catch (error) {
    return { allowed: false, reason: error.message };
  }
}

export function cleanWhatsappPhone(phone) {
  return normalizeOutgoingPhone(cleanDigits(phone));
}
