import { normalizePhoneToBrazilInternational } from '../../utils.js';

export class WhatsappProviderError extends Error {
  constructor(message, code = 'WHATSAPP_PROVIDER_ERROR', details = {}) {
    super(message);
    this.name = 'WhatsappProviderError';
    this.code = code;
    this.details = details;
  }
}

export function normalizeWhatsappPhone(phone) {
  const normalized = normalizePhoneToBrazilInternational(phone);
  return normalized ? `+${normalized}` : '';
}

export function withTimeout(ms = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { controller, timeout };
}

export function safeJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class WhatsappProviderBase {
  constructor(config = {}) {
    this.config = config;
  }

  getStatus() {
    throw new WhatsappProviderError('Provider nao implementou getStatus.', 'PROVIDER_METHOD_NOT_IMPLEMENTED');
  }

  connect() {
    throw new WhatsappProviderError('Provider nao implementou connect.', 'PROVIDER_METHOD_NOT_IMPLEMENTED');
  }

  reconnect() {
    throw new WhatsappProviderError('Provider nao implementou reconnect.', 'PROVIDER_METHOD_NOT_IMPLEMENTED');
  }

  getQrcode() {
    throw new WhatsappProviderError('Provider nao implementou getQrcode.', 'PROVIDER_METHOD_NOT_IMPLEMENTED');
  }

  sendMessage() {
    throw new WhatsappProviderError('Provider nao implementou sendMessage.', 'PROVIDER_METHOD_NOT_IMPLEMENTED');
  }

  receiveWebhook(payload) {
    return { raw: payload, events: [] };
  }
}
