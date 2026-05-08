import { WhatsappProviderBase, WhatsappProviderError, normalizeWhatsappPhone, withTimeout } from './whatsapp_provider_base.js';

async function requestMeta(path, { token, method = 'GET', body } = {}) {
  const { controller, timeout } = withTimeout(15000);
  try {
    const response = await fetch(`https://graph.facebook.com/v20.0/${path.replace(/^\//, '')}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new WhatsappProviderError(data?.error?.message || `Meta retornou HTTP ${response.status}.`, 'META_WHATSAPP_HTTP_ERROR', {
        status: response.status,
      });
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new WhatsappProviderError('Timeout ao acessar Meta WhatsApp.', 'META_WHATSAPP_TIMEOUT');
    }
    if (error instanceof WhatsappProviderError) throw error;
    throw new WhatsappProviderError(error instanceof Error ? error.message : 'Falha ao acessar Meta WhatsApp.', 'META_WHATSAPP_REQUEST_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}

export class MetaWhatsappProvider extends WhatsappProviderBase {
  get token() {
    return this.config.token || process.env.META_WHATSAPP_ACCESS_TOKEN || '';
  }

  get phoneNumberId() {
    return this.config.phone_number_id || process.env.META_WHATSAPP_PHONE_NUMBER_ID || '';
  }

  get configured() {
    return Boolean(this.token && this.phoneNumberId);
  }

  async getStatus() {
    if (!this.configured) {
      return { connected: false, status: 'not_configured', message: 'Token ou Phone Number ID da Meta nao configurado.' };
    }
    const data = await requestMeta(this.phoneNumberId, { token: this.token });
    return { connected: true, status: 'connected', raw: data };
  }

  async connect() {
    return this.getStatus();
  }

  async reconnect() {
    return this.getStatus();
  }

  async getQrcode() {
    return { connected: true, status: 'not_required', qrcode: '' };
  }

  async sendMessage(phone, message) {
    if (!this.configured) {
      throw new WhatsappProviderError('Credenciais da Meta nao configuradas.', 'META_WHATSAPP_NOT_CONFIGURED');
    }
    const normalized = normalizeWhatsappPhone(phone).replace(/^\+/, '');
    if (!normalized) {
      throw new WhatsappProviderError('Telefone invalido.', 'WHATSAPP_INVALID_PHONE');
    }
    const data = await requestMeta(`${this.phoneNumberId}/messages`, {
      method: 'POST',
      token: this.token,
      body: {
        messaging_product: 'whatsapp',
        to: normalized,
        type: 'text',
        text: {
          preview_url: false,
          body: message,
        },
      },
    });
    return {
      status: 'sent',
      provider_message_id: data?.messages?.[0]?.id || '',
      raw: data,
    };
  }

  receiveWebhook(payload = {}) {
    const events = [];
    const entries = Array.isArray(payload.entry) ? payload.entry : [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        for (const message of value.messages || []) {
          events.push({
            type: 'message',
            direction: 'inbound',
            phone: message.from || '',
            body: message.text?.body || '',
            providerMessageId: message.id || '',
            status: 'received',
          });
        }
        for (const status of value.statuses || []) {
          events.push({
            type: 'status',
            providerMessageId: status.id || '',
            status: status.status || '',
            phone: status.recipient_id || '',
          });
        }
      }
    }
    return { raw: payload, events };
  }
}
