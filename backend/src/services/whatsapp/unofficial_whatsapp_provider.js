import { WhatsappProviderBase, WhatsappProviderError, normalizeWhatsappPhone, withTimeout } from './whatsapp_provider_base.js';

function joinUrl(baseUrl, path) {
  return `${String(baseUrl || '').replace(/\/$/, '')}/${String(path || '').replace(/^\//, '')}`;
}

async function requestJson(url, { token, method = 'GET', body, timeoutMs = 15000 } = {}) {
  const { controller, timeout } = withTimeout(timeoutMs);
  try {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { text };
    }
    if (!response.ok) {
      throw new WhatsappProviderError(data?.message || `API retornou HTTP ${response.status}.`, 'WHATSAPP_API_HTTP_ERROR', {
        status: response.status,
      });
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new WhatsappProviderError('Timeout ao acessar API de WhatsApp.', 'WHATSAPP_API_TIMEOUT');
    }
    if (error instanceof WhatsappProviderError) throw error;
    throw new WhatsappProviderError(error instanceof Error ? error.message : 'Falha ao acessar API de WhatsApp.', 'WHATSAPP_API_REQUEST_ERROR');
  } finally {
    clearTimeout(timeout);
  }
}

export class UnofficialWhatsappProvider extends WhatsappProviderBase {
  get configured() {
    return Boolean(this.config.api_url);
  }

  async getStatus() {
    if (!this.configured) {
      return { connected: false, status: 'not_configured', message: 'API URL nao configurada.' };
    }
    const data = await requestJson(joinUrl(this.config.api_url, 'status'), { token: this.config.token });
    return {
      connected: Boolean(data.connected ?? data.isConnected ?? data.status === 'connected' ?? data.status === 'open'),
      status: data.status || (data.connected ? 'connected' : 'unknown'),
      qrcode: data.qrcode || data.qr || data.qrCode || '',
      raw: data,
    };
  }

  async connect() {
    if (!this.configured) {
      throw new WhatsappProviderError('API URL nao configurada.', 'WHATSAPP_NOT_CONFIGURED');
    }
    const data = await requestJson(joinUrl(this.config.api_url, 'connect'), {
      method: 'POST',
      token: this.config.token,
      body: {
        instance_id: this.config.instance_id || undefined,
        phone_number: this.config.default_number || undefined,
      },
    });
    return {
      connected: Boolean(data.connected ?? data.status === 'connected' ?? data.status === 'open'),
      status: data.status || 'connect_requested',
      qrcode: data.qrcode || data.qr || data.qrCode || '',
      raw: data,
    };
  }

  async reconnect() {
    if (!this.configured) {
      throw new WhatsappProviderError('API URL nao configurada.', 'WHATSAPP_NOT_CONFIGURED');
    }
    const data = await requestJson(joinUrl(this.config.api_url, 'reconnect'), {
      method: 'POST',
      token: this.config.token,
      body: {
        instance_id: this.config.instance_id || undefined,
      },
    });
    return {
      connected: Boolean(data.connected ?? data.status === 'connected' ?? data.status === 'open'),
      status: data.status || 'reconnect_requested',
      qrcode: data.qrcode || data.qr || data.qrCode || '',
      raw: data,
    };
  }

  async sendMessage(phone, message) {
    if (!this.configured) {
      throw new WhatsappProviderError('API URL nao configurada.', 'WHATSAPP_NOT_CONFIGURED');
    }
    const normalized = normalizeWhatsappPhone(phone);
    if (!normalized) {
      throw new WhatsappProviderError('Telefone invalido.', 'WHATSAPP_INVALID_PHONE');
    }
    const data = await requestJson(joinUrl(this.config.api_url, 'send-message'), {
      method: 'POST',
      token: this.config.token,
      body: {
        phone: normalized,
        number: normalized,
        to: normalized,
        message,
        text: message,
        instance_id: this.config.instance_id || undefined,
      },
    });
    return {
      status: data.status || 'sent',
      provider_message_id: data.id || data.message_id || data.messageId || '',
      raw: data,
    };
  }

  async sendMedia(phone, fileUrl, caption = '') {
    if (!this.configured) {
      throw new WhatsappProviderError('API URL nao configurada.', 'WHATSAPP_NOT_CONFIGURED');
    }
    const normalized = normalizeWhatsappPhone(phone);
    const data = await requestJson(joinUrl(this.config.api_url, 'send-media'), {
      method: 'POST',
      token: this.config.token,
      body: {
        phone: normalized,
        number: normalized,
        to: normalized,
        file_url: fileUrl,
        media: fileUrl,
        caption,
        instance_id: this.config.instance_id || undefined,
      },
    });
    return {
      status: data.status || 'sent',
      provider_message_id: data.id || data.message_id || data.messageId || '',
      raw: data,
    };
  }

  receiveWebhook(payload = {}) {
    const body = payload.message || payload.body || payload.text || payload.content || '';
    const phone = payload.phone || payload.from || payload.remoteJid || payload.number || '';
    const status = payload.status || payload.event || '';
    const providerMessageId = payload.id || payload.message_id || payload.messageId || '';
    const events = [];
    if (body || phone) {
      events.push({ type: 'message', direction: 'inbound', phone, body, providerMessageId, status: status || 'received' });
    } else if (status || providerMessageId) {
      events.push({ type: 'status', providerMessageId, status });
    }
    return { raw: payload, events };
  }
}
