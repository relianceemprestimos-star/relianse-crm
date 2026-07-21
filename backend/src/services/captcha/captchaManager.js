import crypto from 'node:crypto';

import {
  getCaptchaEngineReport,
  getSettings,
  insertCaptchaEngineLog,
  listCaptchaEngineLogs,
  saveSettings,
} from '../../db.js';
import { getPortalConfig, PORTAL_CONFIGS, normalizePortalId } from '../credentials/portalConfigs.js';
import { solveInternalOcr } from './providers/internalOcrProvider.js';
import { getCapSolverBalance, solveWithCapSolver } from './providers/capsolverProvider.js';
import { solveManual } from './providers/manualProvider.js';

const CONFIG_SETTING_KEY = 'captcha_engine_config_json';

const ENGINE_STATUSES = {
  CAPTCHA_DETECTED: 'CAPTCHA_DETECTED',
  INTERNAL_OCR_ATTEMPTED: 'INTERNAL_OCR_ATTEMPTED',
  INTERNAL_OCR_SOLVED: 'INTERNAL_OCR_SOLVED',
  INTERNAL_OCR_LOW_CONFIDENCE: 'INTERNAL_OCR_LOW_CONFIDENCE',
  INTERNAL_OCR_FAILED: 'INTERNAL_OCR_FAILED',
  INTERNAL_OCR_NOT_APPLICABLE: 'INTERNAL_OCR_NOT_APPLICABLE',
  EXTERNAL_PROVIDER_ATTEMPTED: 'EXTERNAL_PROVIDER_ATTEMPTED',
  EXTERNAL_PROVIDER_SOLVED: 'EXTERNAL_PROVIDER_SOLVED',
  EXTERNAL_PROVIDER_FAILED: 'EXTERNAL_PROVIDER_FAILED',
  EXTERNAL_PROVIDER_TIMEOUT: 'EXTERNAL_PROVIDER_TIMEOUT',
  TOKEN_APPLIED: 'TOKEN_APPLIED',
  TOKEN_REJECTED: 'TOKEN_REJECTED',
  MANUAL_AUTH_REQUIRED: 'MANUAL_AUTH_REQUIRED',
  DAILY_LIMIT_REACHED: 'DAILY_LIMIT_REACHED',
  BATCH_LIMIT_REACHED: 'BATCH_LIMIT_REACHED',
  PORTAL_NOT_ENABLED: 'PORTAL_NOT_ENABLED',
  ENGINE_DISABLED: 'ENGINE_DISABLED',
  CONFIG_MISSING: 'CONFIG_MISSING',
  FAILED: 'FAILED',
};

const DEFAULT_PORTAL_RULES = {
  prefeitura_ribeirao_preto: {
    ocrEnabled: false,
    externalEnabled: false,
    fallbackManual: true,
    batchLimit: 20,
    dailyLimit: 100,
    pauseAfterFailures: 3,
  },
  governo_sp: {
    ocrEnabled: false,
    externalEnabled: false,
    fallbackManual: true,
    batchLimit: 20,
    dailyLimit: 100,
    pauseAfterFailures: 2,
  },
  governo_amapa: {
    ocrEnabled: false,
    externalEnabled: false,
    fallbackManual: true,
    batchLimit: 20,
    dailyLimit: 100,
    pauseAfterFailures: 3,
  },
  prefeitura_santana_parnaiba: {
    ocrEnabled: false,
    externalEnabled: true,
    fallbackManual: true,
    batchLimit: 20,
    dailyLimit: 100,
    pauseAfterFailures: 3,
  },
};

function boolFromEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(value).toLowerCase());
}

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function encryptionKey() {
  const seed = String(process.env.CAPTCHA_ENGINE_ENCRYPTION_KEY || process.env.CREDENTIALS_ENCRYPTION_KEY || process.env.JWT_SECRET || 'reliancecrm-local-captcha-key');
  return crypto.createHash('sha256').update(seed).digest();
}

function encryptSecret(value = '') {
  const text = String(value || '');
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decryptSecret(value = '') {
  const raw = String(value || '');
  if (!raw) return '';
  const [version, ivRaw, tagRaw, encryptedRaw] = raw.split(':');
  if (version !== 'v1' || !ivRaw || !tagRaw || !encryptedRaw) return '';
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function maskApiKey(apiKey = '') {
  const value = String(apiKey || '').trim();
  if (!value) return '';
  const prefix = value.startsWith('CAP-') ? 'CAP-' : value.slice(0, Math.min(4, value.length));
  const suffix = value.slice(-4);
  return `${prefix}${'*'.repeat(12)}${suffix}`;
}

function envConfig() {
  return {
    enabled: boolFromEnv('CAPTCHA_ENGINE_ENABLED', true),
    defaultMode: process.env.CAPTCHA_DEFAULT_MODE || 'hybrid',
    internalOcrEnabled: boolFromEnv('CAPTCHA_INTERNAL_OCR_ENABLED', true),
    internalOcrMinConfidence: numberFromEnv('CAPTCHA_INTERNAL_OCR_MIN_CONFIDENCE', 0.75),
    externalProvider: process.env.CAPTCHA_EXTERNAL_PROVIDER || 'capsolver',
    externalProviderEnabled: boolFromEnv('CAPTCHA_EXTERNAL_PROVIDER_ENABLED', false),
    capsolverEnabled: boolFromEnv('CAPSOLVER_ENABLED', false),
    capsolverApiKeyEncrypted: '',
    dailyLimit: numberFromEnv('CAPSOLVER_DAILY_LIMIT', 100),
    batchLimit: numberFromEnv('CAPSOLVER_BATCH_LIMIT', 20),
    timeoutMs: numberFromEnv('CAPSOLVER_TIMEOUT_MS', 120000),
    pollIntervalMs: numberFromEnv('CAPSOLVER_POLL_INTERVAL_MS', 3000),
    lastTestAt: '',
    lastError: '',
    portalRules: DEFAULT_PORTAL_RULES,
  };
}

function loadStoredConfig() {
  const settings = getSettings();
  const raw = String(settings[CONFIG_SETTING_KEY] || '');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function mergeConfig() {
  const base = envConfig();
  const stored = loadStoredConfig();
  const mergedPortalRules = { ...DEFAULT_PORTAL_RULES, ...(stored.portalRules || {}) };
  for (const portal of PORTAL_CONFIGS) {
    mergedPortalRules[portal.id] = {
      ...(DEFAULT_PORTAL_RULES[portal.id] || {
        ocrEnabled: false,
        externalEnabled: false,
        fallbackManual: true,
        batchLimit: base.batchLimit,
        dailyLimit: base.dailyLimit,
        pauseAfterFailures: 3,
      }),
      ...(stored.portalRules?.[portal.id] || {}),
    };
  }
  return {
    ...base,
    ...stored,
    enabled: stored.enabled ?? base.enabled,
    internalOcrEnabled: stored.internalOcrEnabled ?? base.internalOcrEnabled,
    externalProviderEnabled: stored.externalProviderEnabled ?? base.externalProviderEnabled,
    capsolverEnabled: stored.capsolverEnabled ?? base.capsolverEnabled,
    capsolverApiKeyEncrypted: stored.capsolverApiKeyEncrypted || base.capsolverApiKeyEncrypted,
    portalRules: mergedPortalRules,
  };
}

function getSecretConfig() {
  const config = mergeConfig();
  return {
    ...config,
    capsolverApiKey: decryptSecret(config.capsolverApiKeyEncrypted) || String(process.env.CAPSOLVER_API_KEY || ''),
  };
}

export function getCaptchaEngineConfig({ includeSecret = false } = {}) {
  const config = includeSecret ? getSecretConfig() : mergeConfig();
  const apiKey = includeSecret ? config.capsolverApiKey : decryptSecret(config.capsolverApiKeyEncrypted) || String(process.env.CAPSOLVER_API_KEY || '');
  return {
    ...config,
    capsolverApiKey: includeSecret ? apiKey : undefined,
    capsolverApiKeyEncrypted: undefined,
    capsolverApiKeyMasked: maskApiKey(apiKey),
    capsolverApiKeyConfigured: Boolean(apiKey),
    portals: PORTAL_CONFIGS.map((portal) => ({
      id: portal.id,
      label: portal.name,
      url: portal.url,
      rules: config.portalRules[portal.id] || {},
    })),
  };
}

export function saveCaptchaEngineConfig(payload = {}, userId = null) {
  const current = getSecretConfig();
  const next = {
    enabled: payload.enabled ?? current.enabled,
    defaultMode: String(payload.defaultMode || current.defaultMode || 'hybrid'),
    internalOcrEnabled: payload.internalOcrEnabled ?? current.internalOcrEnabled,
    internalOcrMinConfidence: Number(payload.internalOcrMinConfidence ?? current.internalOcrMinConfidence ?? 0.75),
    externalProvider: String(payload.externalProvider || current.externalProvider || 'capsolver'),
    externalProviderEnabled: payload.externalProviderEnabled ?? current.externalProviderEnabled,
    capsolverEnabled: payload.capsolverEnabled ?? current.capsolverEnabled,
    dailyLimit: Number(payload.dailyLimit ?? current.dailyLimit ?? 100),
    batchLimit: Number(payload.batchLimit ?? current.batchLimit ?? 20),
    timeoutMs: Number(payload.timeoutMs ?? current.timeoutMs ?? 120000),
    pollIntervalMs: Number(payload.pollIntervalMs ?? current.pollIntervalMs ?? 3000),
    lastTestAt: current.lastTestAt || '',
    lastError: current.lastError || '',
    updatedAt: nowIso(),
    updatedBy: userId,
    portalRules: {
      ...current.portalRules,
      ...(payload.portalRules || {}),
    },
  };
  if (payload.capsolverApiKey !== undefined) {
    const apiKey = String(payload.capsolverApiKey || '').trim();
    next.capsolverApiKeyEncrypted = apiKey ? encryptSecret(apiKey) : '';
  } else {
    next.capsolverApiKeyEncrypted = current.capsolverApiKeyEncrypted || '';
  }

  saveSettings({ [CONFIG_SETTING_KEY]: JSON.stringify(next) });
  registerUsageLog({
    portal: 'system',
    portalLabel: 'Motor de CAPTCHA',
    userId,
    provider: 'MANUAL',
    status: 'CONFIG_UPDATED',
    engineMode: next.defaultMode,
    errorMessage: 'Configuração do Motor de CAPTCHA alterada por usuário gerencial.',
  });
  return getCaptchaEngineConfig();
}

function maskCpf(cpf = '') {
  const digits = String(cpf || '').replace(/\D/g, '');
  if (digits.length < 3) return '***';
  return `***${digits.slice(-3)}`;
}

export function registerUsageLog(data = {}) {
  return insertCaptchaEngineLog({
    portal: data.portal || '',
    portal_label: data.portalLabel || data.portal_label || '',
    batch_id: data.batchId ?? data.batch_id ?? null,
    cpf_masked: data.cpfMasked || data.cpf_masked || maskCpf(data.cpf || ''),
    user_id: data.userId ?? data.user_id ?? null,
    captcha_type: data.captchaType || data.captcha_type || '',
    engine_mode: data.engineMode || data.engine_mode || '',
    provider: data.provider || '',
    status: data.status || '',
    confidence: data.confidence ?? null,
    task_id: data.taskId || data.task_id || '',
    error_code: data.errorCode || data.error_code || '',
    error_message: data.errorMessage || data.error_message || '',
    cost_estimated: data.costEstimated ?? data.cost_estimated ?? null,
    raw_provider_status: data.rawProviderStatus || data.raw_provider_status || '',
    started_at: data.startedAt || data.started_at || null,
    resolved_at: data.resolvedAt || data.resolved_at || null,
    duration_ms: data.durationMs ?? data.duration_ms ?? null,
  });
}

export function listCaptchaLogs(params = {}) {
  return listCaptchaEngineLogs(params);
}

export function getCaptchaReport(params = {}) {
  return getCaptchaEngineReport(params);
}

function portalRuleFor(config, portal) {
  return config.portalRules?.[portal] || {};
}

function countTodayExternalLogs(portal = '') {
  const today = new Date().toISOString().slice(0, 10);
  return listCaptchaEngineLogs({ from: today, to: today, portal, provider: 'CAPSOLVER', limit: 1000 }).filter((row) =>
    ['EXTERNAL_PROVIDER_ATTEMPTED', 'EXTERNAL_PROVIDER_SOLVED', 'EXTERNAL_PROVIDER_FAILED', 'EXTERNAL_PROVIDER_TIMEOUT'].includes(row.status)
  ).length;
}

function countBatchExternalLogs(batchId, portal = '') {
  if (!batchId) return 0;
  return listCaptchaEngineLogs({ batch_id: batchId, portal, provider: 'CAPSOLVER', limit: 1000 }).filter((row) =>
    ['EXTERNAL_PROVIDER_ATTEMPTED', 'EXTERNAL_PROVIDER_SOLVED', 'EXTERNAL_PROVIDER_FAILED', 'EXTERNAL_PROVIDER_TIMEOUT'].includes(row.status)
  ).length;
}

function alreadyAttempted(context = {}, provider = '') {
  const batchId = context.batchId || context.batch_id;
  const portal = normalizePortalId(context.portal || '');
  const cpfMasked = context.cpfMasked || maskCpf(context.cpf || '');
  if (!batchId || !portal || !cpfMasked) return false;
  return listCaptchaEngineLogs({ batch_id: batchId, portal, provider, limit: 1000 }).some((row) => row.cpf_masked === cpfMasked);
}

export function validateLimits(portal, batchId = null) {
  const config = getCaptchaEngineConfig({ includeSecret: true });
  const rule = portalRuleFor(config, portal);
  const dailyLimit = Number(rule.dailyLimit || config.dailyLimit || 100);
  const batchLimit = Number(rule.batchLimit || config.batchLimit || 20);
  if (countTodayExternalLogs(portal) >= dailyLimit) {
    return { ok: false, status: ENGINE_STATUSES.DAILY_LIMIT_REACHED, message: 'Limite diário de provider externo atingido.' };
  }
  if (batchId && countBatchExternalLogs(batchId, portal) >= batchLimit) {
    return { ok: false, status: ENGINE_STATUSES.BATCH_LIMIT_REACHED, message: 'Limite de provider externo por lote atingido.' };
  }
  return { ok: true };
}

export async function getBalance() {
  const config = getSecretConfig();
  if (!config.capsolverEnabled || !config.externalProviderEnabled) {
    return { ok: false, status: 'DISABLED', message: 'CapSolver está desativado no Motor de CAPTCHA.' };
  }
  try {
    const balance = await getCapSolverBalance(config.capsolverApiKey, Math.min(Number(config.timeoutMs || 120000), 30000));
    return { ok: true, provider: 'CAPSOLVER', balance };
  } catch (error) {
    return {
      ok: false,
      status: error?.code || 'BALANCE_UNAVAILABLE',
      message: error instanceof Error ? error.message : 'Saldo indisponível.',
    };
  }
}

export async function testExternalProvider() {
  const balance = await getBalance();
  const current = loadStoredConfig();
  saveSettings({
    [CONFIG_SETTING_KEY]: JSON.stringify({
      ...current,
      lastTestAt: nowIso(),
      lastError: balance.ok ? '' : balance.message || 'Falha ao testar provider.',
    }),
  });
  return balance;
}

export async function handleCaptcha(context = {}) {
  const portal = normalizePortalId(context.portal || '');
  const portalConfig = getPortalConfig(portal);
  const portalLabel = context.portalLabel || portalConfig?.name || portal;
  const batchId = context.batchId || context.batch_id || null;
  const userId = context.userId || context.user_id || null;
  const captchaType = context.captchaType || context.captcha_type || '';
  const config = getSecretConfig();
  const engineMode = String(config.defaultMode || 'hybrid').toLowerCase();
  const baseLog = { portal, portalLabel, batchId, userId, captchaType, cpf: context.cpf || '', engineMode };

  registerUsageLog({ ...baseLog, provider: 'MANUAL', status: ENGINE_STATUSES.CAPTCHA_DETECTED });

  if (!config.enabled || engineMode === 'manual') {
    registerUsageLog({ ...baseLog, provider: 'MANUAL', status: ENGINE_STATUSES.ENGINE_DISABLED, errorMessage: 'Motor de CAPTCHA desativado ou em modo manual.' });
    const manual = await solveManual(context, 'Motor de CAPTCHA desativado ou em modo manual.');
    registerUsageLog({ ...baseLog, provider: 'MANUAL', status: ENGINE_STATUSES.MANUAL_AUTH_REQUIRED, errorMessage: manual.message });
    return manual;
  }

  const rule = portalRuleFor(config, portal);
  if (!rule.ocrEnabled && !rule.externalEnabled) {
    registerUsageLog({ ...baseLog, provider: 'MANUAL', status: ENGINE_STATUSES.PORTAL_NOT_ENABLED, errorMessage: 'Portal sem resolução automática habilitada.' });
    const manual = await solveManual(context, 'Portal sem resolução automática habilitada.');
    registerUsageLog({ ...baseLog, provider: 'MANUAL', status: ENGINE_STATUSES.MANUAL_AUTH_REQUIRED, errorMessage: manual.message });
    return manual;
  }

  if (config.internalOcrEnabled && rule.ocrEnabled && ['hybrid', 'internal_ocr', 'ocr'].includes(engineMode) && !alreadyAttempted(context, 'INTERNAL_OCR')) {
    registerUsageLog({ ...baseLog, provider: 'INTERNAL_OCR', status: ENGINE_STATUSES.INTERNAL_OCR_ATTEMPTED });
    const ocr = await solveInternalOcr(context, { minConfidence: config.internalOcrMinConfidence });
    registerUsageLog({
      ...baseLog,
      provider: 'INTERNAL_OCR',
      status: ocr.status,
      confidence: ocr.confidence,
      errorCode: ocr.code,
      errorMessage: ocr.ok ? '' : ocr.message,
      durationMs: ocr.durationMs,
    });
    if (ocr.ok) {
      return ocr;
    }
  }

  const externalEnabled = config.externalProviderEnabled && config.externalProvider === 'capsolver' && config.capsolverEnabled && rule.externalEnabled;
  if (['hybrid', 'external', 'provider'].includes(engineMode) && externalEnabled && !alreadyAttempted(context, 'CAPSOLVER')) {
    if (!config.capsolverApiKey) {
      registerUsageLog({ ...baseLog, provider: 'CAPSOLVER', status: ENGINE_STATUSES.CONFIG_MISSING, errorMessage: 'API Key CapSolver ausente.' });
    } else {
      const limit = validateLimits(portal, batchId);
      if (!limit.ok) {
        registerUsageLog({ ...baseLog, provider: 'CAPSOLVER', status: limit.status, errorMessage: limit.message });
      } else {
        registerUsageLog({ ...baseLog, provider: 'CAPSOLVER', status: ENGINE_STATUSES.EXTERNAL_PROVIDER_ATTEMPTED });
        const solved = await solveWithCapSolver(context, {
          apiKey: config.capsolverApiKey,
          timeoutMs: config.timeoutMs,
          pollIntervalMs: config.pollIntervalMs,
        });
        registerUsageLog({
          ...baseLog,
          provider: 'CAPSOLVER',
          status: solved.status,
          taskId: solved.taskId,
          errorCode: solved.code,
          errorMessage: solved.ok ? '' : solved.message,
          costEstimated: solved.costEstimated,
          rawProviderStatus: solved.rawProviderStatus,
          durationMs: solved.durationMs,
          resolvedAt: nowIso(),
        });
        if (solved.ok) {
          return solved;
        }
      }
    }
  }

  const manual = await solveManual(context, 'Este portal exigiu CAPTCHA/autenticação manual. A consulta foi pausada para evitar bloqueio ou consumo indevido.');
  registerUsageLog({ ...baseLog, provider: 'MANUAL', status: ENGINE_STATUSES.MANUAL_AUTH_REQUIRED, errorMessage: manual.message });
  return manual;
}

export function getCaptchaRuntimeEnv(context = {}) {
  const config = getCaptchaEngineConfig({ includeSecret: false });
  const secret = getSecretConfig();
  const portal = normalizePortalId(context.portal || '');
  const rule = portalRuleFor(secret, portal);
  const canUseExternal =
    Boolean(secret.enabled) &&
    Boolean(secret.externalProviderEnabled) &&
    secret.externalProvider === 'capsolver' &&
    Boolean(secret.capsolverEnabled) &&
    Boolean(rule.externalEnabled) &&
    Boolean(secret.capsolverApiKey);
  return {
    CAPTCHA_ENGINE_ENABLED: String(Boolean(secret.enabled)),
    CAPTCHA_DEFAULT_MODE: String(secret.defaultMode || 'hybrid'),
    CAPTCHA_INTERNAL_OCR_ENABLED: String(Boolean(secret.internalOcrEnabled && rule.ocrEnabled)),
    CAPTCHA_INTERNAL_OCR_MIN_CONFIDENCE: String(secret.internalOcrMinConfidence || 0.75),
    CAPTCHA_EXTERNAL_PROVIDER: String(secret.externalProvider || 'capsolver'),
    CAPTCHA_EXTERNAL_PROVIDER_ENABLED: String(canUseExternal),
    CAPTCHA_PROVIDER_TIMEOUT_MS: String(secret.timeoutMs || 120000),
    CAPTCHA_PROVIDER_POLL_INTERVAL_MS: String(secret.pollIntervalMs || 3000),
    CAPSOLVER_ENABLED: String(canUseExternal),
    CAPSOLVER_API_KEY: canUseExternal ? secret.capsolverApiKey : '',
    CAPSOLVER_TIMEOUT_MS: String(secret.timeoutMs || 120000),
    CAPSOLVER_POLL_INTERVAL_MS: String(secret.pollIntervalMs || 3000),
    CAPTCHA_PORTAL_OCR_ENABLED: String(Boolean(rule.ocrEnabled)),
    CAPTCHA_PORTAL_EXTERNAL_ENABLED: String(Boolean(rule.externalEnabled)),
    CAPTCHA_PUBLIC_STATUS: JSON.stringify({
      enabled: config.enabled,
      mode: config.defaultMode,
      provider: canUseExternal ? 'CAPSOLVER' : 'MANUAL',
      apiKeyConfigured: config.capsolverApiKeyConfigured,
    }),
  };
}

export function markManualRequired(context = {}, reason = 'Ação manual necessária.') {
  const portal = normalizePortalId(context.portal || '');
  const portalConfig = getPortalConfig(portal);
  registerUsageLog({
    portal,
    portalLabel: context.portalLabel || portalConfig?.name || portal,
    batchId: context.batchId || context.batch_id || null,
    userId: context.userId || context.user_id || null,
    cpf: context.cpf || '',
    captchaType: context.captchaType || context.captcha_type || '',
    provider: 'MANUAL',
    status: ENGINE_STATUSES.MANUAL_AUTH_REQUIRED,
    errorMessage: reason,
  });
  return { ok: false, status: ENGINE_STATUSES.MANUAL_AUTH_REQUIRED, message: reason };
}

export { ENGINE_STATUSES };
