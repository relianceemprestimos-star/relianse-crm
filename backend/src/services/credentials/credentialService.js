import crypto from 'node:crypto';

import {
  getAverbadorCredentialById,
  getAverbadorCredentialByPortalId,
  insertCredentialConnectionLog,
  listAverbadorCredentials,
  listCredentialConnectionLogs,
  updateAverbadorCredentialById,
  upsertAverbadorCredential,
  upsertAverbadorSession,
} from '../../db.js';
import { getPortalConfig, normalizePortalId, PORTAL_CONFIGS } from './portalConfigs.js';

const STATUS_LABELS = {
  sessao_ativa: 'Sessão ativa',
  sessao_expirada: 'Sessão expirada',
  nao_conectado: 'Não conectado',
  login_assistido_necessario: 'Login assistido necessário',
  erro_conexao: 'Erro de conexão',
};

function nowIso() {
  return new Date().toISOString();
}

function addHoursIso(hours) {
  const date = new Date();
  date.setUTCHours(date.getUTCHours() + Number(hours || 0));
  return date.toISOString();
}

function encryptionKey() {
  const seed = String(process.env.CREDENTIALS_ENCRYPTION_KEY || process.env.JWT_SECRET || 'reliancecrm-local-credential-key');
  return crypto.createHash('sha256').update(seed).digest();
}

function encryptSecret(value = '') {
  const text = String(value || '');
  if (!text) {
    return '';
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptSecret(value = '') {
  const raw = String(value || '');
  if (!raw) {
    return '';
  }
  const [version, ivRaw, tagRaw, encryptedRaw] = raw.split(':');
  if (version !== 'v1' || !ivRaw || !tagRaw || !encryptedRaw) {
    return '';
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64')), decipher.final()]).toString('utf8');
}

function safeUrlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function sanitizeCredential(row) {
  if (!row) {
    return null;
  }
  const config = getPortalConfig(row.portal_id);
  const status = String(row.session_status || 'nao_conectado');
  return {
    id: Number(row.id),
    portal_id: row.portal_id,
    portal_name: row.portal_name || config?.name || '',
    portal_url: row.portal_url || config?.url || '',
    portal_host: safeUrlHost(row.portal_url || config?.url || ''),
    login: row.login || '',
    has_password: Boolean(row.encrypted_password),
    requires_captcha: Boolean(row.requires_captcha ?? config?.requiresCaptcha),
    requires_assisted_login: Boolean(row.requires_assisted_login ?? config?.requiresAssistedLogin),
    session_status: status,
    session_status_label: STATUS_LABELS[status] || status,
    last_access_at: row.last_access_at || null,
    session_expires_at: row.session_expires_at || null,
    last_test_at: row.last_test_at || null,
    last_error: row.last_error || '',
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
  };
}

function mergeConfigCredential(config, row = null) {
  return sanitizeCredential({
    id: row?.id || 0,
    portal_id: config.id,
    portal_name: row?.portal_name || config.name,
    portal_url: row?.portal_url || config.url,
    login: row?.login || '',
    encrypted_password: row?.encrypted_password || '',
    requires_captcha: row?.requires_captcha ?? config.requiresCaptcha,
    requires_assisted_login: row?.requires_assisted_login ?? config.requiresAssistedLogin,
    session_status: row?.session_status || (config.requiresAssistedLogin ? 'login_assistido_necessario' : 'nao_conectado'),
    last_access_at: row?.last_access_at || null,
    session_expires_at: row?.session_expires_at || null,
    last_test_at: row?.last_test_at || null,
    last_error: row?.last_error || '',
    created_at: row?.created_at || '',
    updated_at: row?.updated_at || '',
  });
}

export function getCredentialPortals() {
  return PORTAL_CONFIGS;
}

export function listCredentials() {
  const rows = listAverbadorCredentials();
  return PORTAL_CONFIGS.map((config) => mergeConfigCredential(config, rows.find((row) => row.portal_id === config.id)));
}

export function getCredentialByPortal(portalId) {
  const normalized = normalizePortalId(portalId);
  const config = getPortalConfig(normalized);
  if (!config) {
    return null;
  }
  return mergeConfigCredential(config, getAverbadorCredentialByPortalId(normalized));
}

export function getCredentialSecretByPortal(portalId) {
  const normalized = normalizePortalId(portalId);
  const row = getAverbadorCredentialByPortalId(normalized);
  if (!row) {
    return null;
  }
  return {
    ...sanitizeCredential(row),
    password: decryptSecret(row.encrypted_password || ''),
  };
}

export function saveCredential(payload = {}, userId = null) {
  const portalId = normalizePortalId(payload.portal_id || payload.portalId);
  const config = getPortalConfig(portalId);
  if (!config) {
    const error = new Error('Portal de credencial não reconhecido.');
    error.code = 'PORTAL_NOT_FOUND';
    throw error;
  }
  const current = getAverbadorCredentialByPortalId(portalId);
  const shouldEncryptPassword = payload.password !== undefined && String(payload.password || '') !== '';
  const encryptedPassword = shouldEncryptPassword ? encryptSecret(payload.password) : current?.encrypted_password || '';
  const credential = upsertAverbadorCredential({
    portal_id: portalId,
    portal_name: config.name,
    portal_url: payload.portal_url || payload.portalUrl || config.url,
    login: payload.login || '',
    encrypted_password: encryptedPassword,
    requires_captcha: config.requiresCaptcha,
    requires_assisted_login: config.requiresAssistedLogin,
    session_status: current?.session_status || (config.requiresAssistedLogin ? 'login_assistido_necessario' : 'nao_conectado'),
    last_access_at: current?.last_access_at || null,
    session_expires_at: current?.session_expires_at || null,
    last_test_at: current?.last_test_at || null,
    last_error: '',
    created_by: current?.created_by || userId,
    updated_by: userId,
  });
  insertCredentialConnectionLog({
    credential_id: credential.id,
    portal_id: portalId,
    action: current ? 'update' : 'create',
    status: 'success',
    message: 'Credencial salva com segurança.',
    created_by: userId,
  });
  return sanitizeCredential(credential);
}

export function updateCredential(id, payload = {}, userId = null) {
  const current = getAverbadorCredentialById(id);
  if (!current) {
    return null;
  }
  return saveCredential({ ...payload, portal_id: current.portal_id }, userId);
}

async function checkPortalReachable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    let response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    if (response.status === 405 || response.status === 403) {
      response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    }
    return {
      ok: response.ok || response.status < 500,
      status: response.status,
      url: response.url || url,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function testCredential(id, userId = null) {
  const current = getAverbadorCredentialById(id);
  if (!current) {
    const error = new Error('Credencial não encontrada.');
    error.code = 'CREDENTIAL_NOT_FOUND';
    throw error;
  }
  const config = getPortalConfig(current.portal_id);
  const portalUrl = current.portal_url || config?.url || '';
  const hasCredential = Boolean(current.login && current.encrypted_password);
  if (!hasCredential) {
    const next = updateAverbadorCredentialById(id, {
      session_status: 'nao_conectado',
      last_test_at: nowIso(),
      last_error: 'Informe login e senha antes de testar.',
      updated_by: userId,
    });
    insertCredentialConnectionLog({
      credential_id: id,
      portal_id: current.portal_id,
      action: 'test',
      status: 'failed',
      message: 'Credencial incompleta.',
      error_message: 'Login ou senha ausente.',
      created_by: userId,
    });
    return sanitizeCredential(next);
  }

  try {
    const result = await checkPortalReachable(portalUrl);
    if (!result.ok) {
      throw new Error(`Portal respondeu status ${result.status}.`);
    }
    const status = config?.requiresAssistedLogin ? 'login_assistido_necessario' : 'sessao_ativa';
    const next = updateAverbadorCredentialById(id, {
      session_status: status,
      last_access_at: status === 'sessao_ativa' ? nowIso() : current.last_access_at,
      session_expires_at: status === 'sessao_ativa' ? addHoursIso(8) : current.session_expires_at,
      last_test_at: nowIso(),
      last_error: '',
      updated_by: userId,
    });
    upsertAverbadorSession({
      credential_id: id,
      portal_id: current.portal_id,
      status,
      last_login_at: status === 'sessao_ativa' ? nowIso() : null,
      expires_at: status === 'sessao_ativa' ? addHoursIso(8) : null,
      requires_manual_action: config?.requiresAssistedLogin,
    });
    insertCredentialConnectionLog({
      credential_id: id,
      portal_id: current.portal_id,
      action: 'test',
      status: 'success',
      message: config?.requiresAssistedLogin
        ? 'Portal acessível. Login assistido necessário por CAPTCHA.'
        : `Portal acessível. HTTP ${result.status}.`,
      created_by: userId,
    });
    return sanitizeCredential(next);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro de conexão.';
    const next = updateAverbadorCredentialById(id, {
      session_status: 'erro_conexao',
      last_test_at: nowIso(),
      last_error: message,
      updated_by: userId,
    });
    insertCredentialConnectionLog({
      credential_id: id,
      portal_id: current.portal_id,
      action: 'test',
      status: 'failed',
      message: 'Falha ao testar conexão.',
      error_message: message,
      created_by: userId,
    });
    return sanitizeCredential(next);
  }
}

export function startAssistedLogin(id, userId = null) {
  const current = getAverbadorCredentialById(id);
  if (!current) {
    const error = new Error('Credencial não encontrada.');
    error.code = 'CREDENTIAL_NOT_FOUND';
    throw error;
  }
  const config = getPortalConfig(current.portal_id);
  const next = updateAverbadorCredentialById(id, {
    session_status: config?.requiresAssistedLogin ? 'login_assistido_necessario' : 'nao_conectado',
    last_error: '',
    updated_by: userId,
  });
  upsertAverbadorSession({
    credential_id: id,
    portal_id: current.portal_id,
    status: next.session_status,
    requires_manual_action: true,
  });
  insertCredentialConnectionLog({
    credential_id: id,
    portal_id: current.portal_id,
    action: 'assisted_login_start',
    status: 'pending',
    message: 'Login assistido iniciado. O usuário deve concluir o CAPTCHA/login no portal.',
    created_by: userId,
  });
  return {
    credential: sanitizeCredential(next),
    portal_url: current.portal_url || config?.url || '',
    message: 'Abra o portal, conclua o login autorizado e confirme a sessão ativa no CRM.',
  };
}

export function confirmAssistedLogin(id, userId = null) {
  const current = getAverbadorCredentialById(id);
  if (!current) {
    const error = new Error('Credencial não encontrada.');
    error.code = 'CREDENTIAL_NOT_FOUND';
    throw error;
  }
  const lastAccessAt = nowIso();
  const expiresAt = addHoursIso(8);
  const next = updateAverbadorCredentialById(id, {
    session_status: 'sessao_ativa',
    last_access_at: lastAccessAt,
    session_expires_at: expiresAt,
    last_error: '',
    updated_by: userId,
  });
  upsertAverbadorSession({
    credential_id: id,
    portal_id: current.portal_id,
    status: 'sessao_ativa',
    last_login_at: lastAccessAt,
    expires_at: expiresAt,
    requires_manual_action: false,
  });
  insertCredentialConnectionLog({
    credential_id: id,
    portal_id: current.portal_id,
    action: 'assisted_login_confirm',
    status: 'success',
    message: 'Sessão assistida confirmada no CRM.',
    created_by: userId,
  });
  return sanitizeCredential(next);
}

export function getCredentialLogs(params = {}) {
  return listCredentialConnectionLogs(params);
}

export function getCredentialGate(portalId) {
  const normalized = normalizePortalId(portalId);
  const config = getPortalConfig(normalized);
  if (!config) {
    return {
      allowed: false,
      code: 'PORTAL_NOT_FOUND',
      message: 'Fonte de consulta não reconhecida.',
    };
  }
  const current = getAverbadorCredentialByPortalId(normalized);
  if (!current || !current.login || !current.encrypted_password) {
    return {
      allowed: false,
      code: 'CREDENTIAL_NOT_CONFIGURED',
      message: 'Credencial não configurada. Acesse a aba Credenciais para conectar este portal.',
      credential: mergeConfigCredential(config, current),
    };
  }
  if (current.session_status === 'sessao_expirada') {
    return {
      allowed: false,
      code: 'CREDENTIAL_SESSION_EXPIRED',
      message: 'Sessão expirada. Reconecte ou execute login assistido na aba Credenciais.',
      credential: sanitizeCredential(current),
    };
  }
  if (config.requiresAssistedLogin && current.session_status !== 'sessao_ativa') {
    return {
      allowed: false,
      code: 'ASSISTED_LOGIN_REQUIRED',
      message: 'Este portal exige login assistido por CAPTCHA. Acesse Credenciais > Governo de SP.',
      credential: sanitizeCredential(current),
    };
  }
  return {
    allowed: true,
    code: 'OK',
    message: 'Credencial disponível.',
    credential: sanitizeCredential(current),
  };
}
