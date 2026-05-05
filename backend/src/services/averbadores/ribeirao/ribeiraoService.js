import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD_VERSION } from '../../../build.js';
import { getDb, getClientById, addInteraction } from '../../../db.js';
import { formatDateTime, formatMoney } from '../../../utils.js';
import {
  formatRibeiraoSummary,
  normalizeRibeiraoCpf,
  normalizeRibeiraoQueryResult,
  RIBEIRAO_QUERY_STATUSES,
  RIBEIRAO_SESSION_STATUSES,
} from './ribeiraoTypes.js';
import { runRibeiraoCommand, startRibeiraoSessionBackground } from './ribeiraoAdapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ribeiraoSessionCache = new Map();

function nowIso() {
  return new Date().toISOString();
}

function one(database, sql, params = []) {
  const statement = database.prepare(sql);
  if (statement && typeof statement.get === 'function') {
    return statement.get(...params);
  }
  if (params.length && typeof statement.bind === 'function') {
    statement.bind(params);
  }
  const row = statement.step() ? statement.getAsObject() : null;
  statement.free();
  return row;
}

function all(database, sql, params = []) {
  const statement = database.prepare(sql);
  if (statement && typeof statement.all === 'function') {
    return statement.all(...params);
  }
  if (params.length && typeof statement.bind === 'function') {
    statement.bind(params);
  }
  const rows = [];
  while (statement.step()) {
    rows.push(statement.getAsObject());
  }
  statement.free();
  return rows;
}

function run(database, sql, params = []) {
  const statement = database.prepare(sql);
  if (statement && typeof statement.run === 'function') {
    return statement.run(...params);
  }
  if (params.length && typeof statement.bind === 'function') {
    statement.bind(params);
  }
  statement.step();
  statement.free();
}

function lastInsertId(database) {
  return Number((one(database, 'SELECT last_insert_rowid() AS id') || {}).id || 0);
}

function normalizeSessionStatus(status) {
  const text = String(status || '').toLowerCase();
  if (text.includes('aguard')) return RIBEIRAO_SESSION_STATUSES.WAITING_CAPTCHA;
  if (text.includes('conectado')) return RIBEIRAO_SESSION_STATUSES.CONNECTED;
  if (text.includes('login')) return RIBEIRAO_SESSION_STATUSES.LOGIN_ERROR;
  if (text.includes('unreach') || text.includes('browser_launch_error') || text.includes('launch')) return RIBEIRAO_SESSION_STATUSES.ERROR;
  if (text.includes('expir')) return RIBEIRAO_SESSION_STATUSES.SESSION_EXPIRED;
  if (text.includes('erro')) return RIBEIRAO_SESSION_STATUSES.ERROR;
  return RIBEIRAO_SESSION_STATUSES.CONNECTING;
}

function serializeQueryRow(row) {
  if (!row) {
    return null;
  }

  const rawResult = row.raw_result_json ? safeParse(row.raw_result_json, {}) : {};
  const summary = formatRibeiraoSummary(normalizeRibeiraoQueryResult(rawResult, row.cpf, row.session_id, row.user_id));
  return {
    id: row.id,
    user_id: row.user_id,
    session_id: row.session_id,
    client_id: row.client_id,
    base_id: row.base_id,
    cpf: row.cpf,
    cpf_masked: row.cpf_masked,
    nome: row.nome || summary.nome || '',
    matricula: row.matricula || summary.matricula || '',
    orgao: row.orgao || summary.orgao || '',
    consulta_status: row.consulta_status || summary.consulta_status,
    consulta_status_label: row.consulta_status_label || summary.consulta_status_label,
    mensagem: row.mensagem || summary.mensagem || '',
    best_product_type: row.best_product_type || summary.best_product_type || '',
    best_net_margin: row.best_net_margin === null || row.best_net_margin === undefined ? summary.best_net_margin : Number(row.best_net_margin),
    best_net_margin_formatted: formatMoney(row.best_net_margin ?? summary.best_net_margin),
    margem_consignavel_bruta: summary.margem_consignavel_bruta ?? null,
    margem_consignavel_liquida: summary.margem_consignavel_liquida ?? null,
    margem_cartao_bruta: summary.margem_cartao_bruta ?? null,
    margem_cartao_liquida: summary.margem_cartao_liquida ?? null,
    margem_emprestimo_total: summary.margem_emprestimo_total ?? null,
    margem_emprestimo_disponivel: summary.margem_emprestimo_disponivel ?? null,
    margem_cartao_total: summary.margem_cartao_total ?? null,
    margem_cartao_disponivel: summary.margem_cartao_disponivel ?? null,
    margem_consignavel_bruta_formatted: summary.margem_consignavel_bruta_formatted,
    margem_consignavel_liquida_formatted: summary.margem_consignavel_liquida_formatted,
    margem_cartao_bruta_formatted: summary.margem_cartao_bruta_formatted,
    margem_cartao_liquida_formatted: summary.margem_cartao_liquida_formatted,
    margem_emprestimo_total_formatted: formatMoney(summary.margem_emprestimo_total),
    margem_emprestimo_disponivel_formatted: formatMoney(summary.margem_emprestimo_disponivel),
    margem_cartao_total_formatted: formatMoney(summary.margem_cartao_total),
    margem_cartao_disponivel_formatted: formatMoney(summary.margem_cartao_disponivel),
    raw_result_json: row.raw_result_json || summary.raw_result_json || '{}',
    created_at: row.created_at,
    created_at_formatted: formatDateTime(row.created_at),
    margins: all(getDb(), 'SELECT * FROM ribeirao_query_margins WHERE query_id = ? ORDER BY id ASC', [row.id]),
  };
}

function safeParse(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function createSessionGateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clearRibeiraoSessionCache(sessionId = null) {
  if (sessionId === null || sessionId === undefined || sessionId === '') {
    ribeiraoSessionCache.clear();
    return;
  }
  ribeiraoSessionCache.delete(Number(sessionId));
}

function normalizeRibeiraoSessionMessage(status, message, errorCode = null) {
  const normalizedStatus = String(status || '').toLowerCase();
  const raw = String(message || '').trim();
  const normalizedErrorCode = String(errorCode || '').toUpperCase();

  if (normalizedStatus === RIBEIRAO_SESSION_STATUSES.CONNECTED) {
    if (!raw || /browsertype\.launch|missing x server|\$display|playwright|chromium|headed browser/i.test(raw)) {
      return 'Sess?o conectada com sucesso.';
    }
    return raw;
  }
  if (normalizedStatus === RIBEIRAO_SESSION_STATUSES.WAITING_CAPTCHA || normalizedStatus === 'aguardando_validacao_manual') {
    return 'O portal solicitou valida??o manual. Resolva no navegador aberto e clique em Atualizar status.';
  }
  if (
    normalizedStatus === RIBEIRAO_SESSION_STATUSES.LOGIN_ERROR ||
    normalizedStatus === 'erro_login' ||
    ['LOGIN_REJECTED', 'LOGIN_FIELDS_NOT_FOUND', 'LOGIN_BUTTON_NOT_FOUND', 'LOGIN_TIMEOUT', 'LOGIN_STILL_ON_SAME_PAGE', 'PORTAL_CHANGED', 'UNKNOWN_LOGIN_ERROR', 'LOGIN_OK_NAVIGATION_FAILED', 'DNS_RESOLUTION_FAILED'].includes(normalizedErrorCode)
  ) {
    if (normalizedErrorCode === 'LOGIN_FIELDS_NOT_FOUND') {
      return 'O sistema n?o encontrou os campos de login do portal. O layout pode ter mudado.';
    }
    if (normalizedErrorCode === 'LOGIN_BUTTON_NOT_FOUND') {
      return 'O sistema n?o encontrou o bot?o de login do portal.';
    }
    if (normalizedErrorCode === 'LOGIN_TIMEOUT') {
      return 'O portal n?o respondeu ap?s tentar login.';
    }
    if (normalizedErrorCode === 'LOGIN_STILL_ON_SAME_PAGE') {
      return 'O portal permaneceu na tela de login sem confirmar autentica??o.';
    }
    if (normalizedErrorCode === 'PORTAL_CHANGED') {
      return 'O layout do portal mudou e o fluxo de login n?o foi reconhecido.';
    }
    if (normalizedErrorCode === 'LOGIN_OK_NAVIGATION_FAILED') {
      return 'Login aceito, mas n?o foi poss?vel abrir Consulta de Margem.';
    }
    if (normalizedErrorCode === 'DNS_RESOLUTION_FAILED') {
      return 'NÃ£o foi possÃ­vel resolver o endereÃ§o do portal no servidor. Verifique DNS da VPS/container.';
    }
    return 'O portal recusou o login/senha informados.';
  }
  if (normalizedStatus === RIBEIRAO_SESSION_STATUSES.SESSION_EXPIRED || normalizedStatus === 'expired') {
    return 'A sess?o com o portal expirou. Inicie uma nova sess?o e clique em Atualizar status.';
  }
  if (normalizedStatus === RIBEIRAO_SESSION_STATUSES.ERROR || normalizedStatus === 'browser_launch_error') {
    if (normalizedErrorCode === 'DNS_RESOLUTION_FAILED') {
      return 'Não foi possível resolver o endereço do portal no servidor. Verifique DNS da VPS/container.';
    }
    if (normalizedErrorCode === 'PORTAL_UNREACHABLE') {
      return 'Não foi possível acessar o portal da Prefeitura no momento.';
    }
    return 'Erro ao iniciar navegador de consulta no servidor. Verifique configura??o do Playwright em produ??o.';
  }
  if (!raw) {
    return 'Nenhuma sess?o ativa com o portal da Prefeitura. Inicie a sess?o antes de consultar.';
  }
  if (/browsertype\.launch|missing x server|\$display|headed browser|playwright|chromium|xvfb/i.test(raw)) {
    return 'Erro ao iniciar navegador de consulta no servidor. Verifique configura??o do Playwright em produ??o.';
  }
  return raw;
}


export function getRibeiraoSessionGate(sessionId) {
  const session = getRibeiraoSessionStatus(sessionId);
  if (!session || !session.id) {
    return {
      success: false,
      code: 'NO_ACTIVE_SESSION',
      message: 'Nenhuma sessão ativa com o portal da Prefeitura. Inicie a sessão antes de consultar.',
      session: null,
    };
  }

  const status = String(session.status || '').toLowerCase();
  if (status === RIBEIRAO_SESSION_STATUSES.CONNECTED) {
    return { success: true, code: 'OK', message: 'Sessão conectada.', session };
  }

  if (status === RIBEIRAO_SESSION_STATUSES.WAITING_CAPTCHA || status === 'aguardando_validacao_manual' || status === 'conectando') {
    return {
      success: false,
      code: 'MANUAL_AUTH_REQUIRED',
      message: 'Conclua a validação manual no navegador aberto e atualize o status da sessão.',
      session,
    };
  }

  if (status === RIBEIRAO_SESSION_STATUSES.LOGIN_ERROR || ['LOGIN_REJECTED', 'LOGIN_FIELDS_NOT_FOUND', 'LOGIN_BUTTON_NOT_FOUND', 'LOGIN_TIMEOUT', 'LOGIN_STILL_ON_SAME_PAGE', 'PORTAL_CHANGED', 'UNKNOWN_LOGIN_ERROR', 'LOGIN_OK_NAVIGATION_FAILED'].includes(String(session.error_code || '').toUpperCase())) {
    return {
      success: false,
      code: String(session.error_code || 'LOGIN_ERROR').toUpperCase(),
      message: session.message || 'Login ou senha do averbador inv?lidos.',
      session,
    };
  }

  if (status === RIBEIRAO_SESSION_STATUSES.SESSION_EXPIRED) {
    return {
      success: false,
      code: 'SESSION_EXPIRED',
      message: 'A sessão com o portal expirou. Inicie uma nova sessão e clique em Atualizar status.',
      session,
    };
  }

  if (status === RIBEIRAO_SESSION_STATUSES.ERROR) {
    return {
      success: false,
      code: 'PORTAL_UNAVAILABLE',
      message: 'Não foi possível acessar o portal da Prefeitura no momento.',
      session,
    };
  }

  return {
    success: false,
    code: 'NO_ACTIVE_SESSION',
    message: 'Nenhuma sessão ativa com o portal da Prefeitura. Inicie a sessão antes de consultar.',
    session,
  };
}

function isPlaceholderUrl(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return (
    !normalized ||
    normalized.includes('exemplo.local') ||
    normalized.includes('example.local') ||
    normalized === 'url_real_aqui' ||
    normalized.includes('coloque_a_url_real')
  );
}

function resolveRibeiraoHeadless() {
  if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production') {
    return true;
  }

  const raw = String(process.env.RIBEIRAO_HEADLESS || '').trim().toLowerCase();
  if (!raw) {
    return true;
  }
  if (['1', 'true', 'yes', 'on'].includes(raw)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(raw)) {
    return false;
  }
  return true;
}

function maskRibeiraoUrl(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  try {
    const parsed = new URL(text);
    const host = parsed.hostname;
    const maskedHost = host.length > 10 ? `${host.slice(0, 4)}...${host.slice(-6)}` : host;
    const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    return `${parsed.protocol}//${maskedHost}${pathname}`;
  } catch {
    return text.length > 16 ? `${text.slice(0, 12)}...${text.slice(-6)}` : text;
  }
}

function resolveRibeiraoUrls() {
  const loginUrl = String(process.env.RIBEIRAO_AVERBADOR_URL || '').trim();
  const consultaUrl = String(process.env.RIBEIRAO_AVERBADOR_CONSULTA_URL || '').trim() || loginUrl;
  return {
    loginUrl,
    consultaUrl,
  };
}

export function getRibeiraoDiagnostics() {
  const { loginUrl, consultaUrl } = resolveRibeiraoUrls();
  const effectiveUrl = loginUrl || consultaUrl;
  const configured = Boolean(loginUrl) && !isPlaceholderUrl(loginUrl) && loginUrl.startsWith('http');
  const fallbackConsulta = Boolean(consultaUrl) && !isPlaceholderUrl(consultaUrl) && consultaUrl.startsWith('http');
  let ribeiraoHost = '';
  try {
    if (effectiveUrl) {
      ribeiraoHost = new URL(effectiveUrl).hostname;
    }
  } catch {
    ribeiraoHost = '';
  }

  return {
    ribeiraoConfigured: configured,
    ribeiraoHost,
    hasLoginUrl: Boolean(loginUrl) && !isPlaceholderUrl(loginUrl) && loginUrl.startsWith('http'),
    hasConsultaUrl: fallbackConsulta,
    headless: resolveRibeiraoHeadless(),
    loginUrlMasked: configured ? maskRibeiraoUrl(loginUrl) : '',
    consultaUrlMasked: fallbackConsulta ? maskRibeiraoUrl(consultaUrl) : '',
    message: configured
      ? 'URL do averbador configurada no servidor.'
      : 'URL do averbador não configurada no servidor.',
    hint: configured
      ? 'A consulta Ribeirão está pronta para usar essa URL.'
      : 'Configure RIBEIRAO_AVERBADOR_URL no .env da VPS e reinicie os containers.',
  };
}

export function getRibeiraoConfigStatus() {
  const diagnostics = getRibeiraoDiagnostics();
  return {
    configured: diagnostics.ribeiraoConfigured,
    env_key: 'RIBEIRAO_AVERBADOR_URL',
    value_masked: diagnostics.loginUrlMasked || diagnostics.consultaUrlMasked || '',
    message: diagnostics.message,
    hint: diagnostics.hint,
  };
}

export function findClientsByCpf(cpf) {
  const database = getDb();
  const digits = normalizeRibeiraoCpf(cpf).cpf;
  if (!digits) {
    return [];
  }

  return all(
    database,
    `
      SELECT
        c.id,
        c.base_id,
        c.name,
        c.cpf,
        c.phone,
        c.email,
        c.status_atendimento,
        c.consulta_status,
        c.consulta_mensagem,
        c.best_product_type,
        c.best_net_margin,
        b.nome_base AS base_name,
        b.tipo_base AS base_type,
        b.convenio AS base_convenio,
        b.estado AS base_state,
        b.cidade AS base_city,
        b.arquivo_original AS base_file_name,
        b.is_active AS base_is_active,
        b.archived_at AS base_archived_at,
        b.created_at AS base_created_at,
        b.updated_at AS base_updated_at
      FROM clients c
      LEFT JOIN bases b ON b.id = COALESCE(c.base_id, c.campaign_id)
      WHERE c.cpf = ?
      ORDER BY datetime(c.updated_at) DESC, c.id DESC
    `,
    [digits]
  ).map((row) => ({
    id: Number(row.id),
    base_id: row.base_id === null || row.base_id === undefined ? null : Number(row.base_id),
    name: row.name || '',
    cpf: row.cpf || '',
    phone: row.phone || '',
    email: row.email || '',
    status_atendimento: row.status_atendimento || 'novo_na_fila',
    consulta_status: row.consulta_status || 'sem_marg',
    consulta_mensagem: row.consulta_mensagem || '',
    best_product_type: row.best_product_type || '',
    best_net_margin: row.best_net_margin === null || row.best_net_margin === undefined ? null : Number(row.best_net_margin),
    base_name: row.base_name || '',
    base_type: row.base_type || '',
    base_convenio: row.base_convenio || '',
    base_state: row.base_state || '',
    base_city: row.base_city || '',
    base_file_name: row.base_file_name || '',
    base_is_active: Number(row.base_is_active ?? 1) === 1,
    base_archived_at: row.base_archived_at || null,
    base_created_at: row.base_created_at || '',
    base_updated_at: row.base_updated_at || '',
  }));
}

function persistQueryMargins(database, queryId, margins = []) {
  run(database, 'DELETE FROM ribeirao_query_margins WHERE query_id = ?', [queryId]);
  for (const margin of margins || []) {
    run(
      database,
      `
        INSERT INTO ribeirao_query_margins (query_id, product_type, gross_margin, net_margin, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      [queryId, margin.product_type, margin.gross_margin ?? null, margin.net_margin ?? null, nowIso()]
    );
  }
}

function normalizeQueryPayload(payload, userId, sessionId, clientMatches = []) {
  return normalizeRibeiraoQueryResult(payload?.rawResult || payload, payload?.cpf || '', sessionId, userId, clientMatches);
}

function sessionStatusFile(sessionId) {
  return path.resolve(path.join(_repoRoot(), 'data', 'ribeirao_sessions', `session_${sessionId}.status.json`));
}

function _repoRoot() {
  return path.resolve(__dirname, '..', '..', '..', '..', '..');
}

export function getRibeiraoSessionStatus(sessionId) {
  const cached = ribeiraoSessionCache.get(Number(sessionId));
  if (cached) {
    return {
      ...cached,
      message: normalizeRibeiraoSessionMessage(cached.status, cached.message, cached.error_code),
      stage: cached.stage || null,
    };
  }

  const database = getDb();
  const row = one(database, 'SELECT * FROM ribeirao_query_sessions WHERE id = ?', [sessionId]);
  if (!row) {
    return null;
  }

  const file = sessionStatusFile(sessionId);
  let fileStatus = null;
  if (fs.existsSync(file)) {
    try {
      fileStatus = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      fileStatus = null;
    }
  }

  const status = normalizeSessionStatus(fileStatus?.status || row.status);
  const message = normalizeRibeiraoSessionMessage(status, fileStatus?.message || row.error_message || '', fileStatus?.error_code || row.error_code || null);

  run(
    database,
    'UPDATE ribeirao_query_sessions SET status = ?, error_message = ?, updated_at = ? WHERE id = ?',
    [status, message || null, nowIso(), sessionId]
  );

  const session = {
    id: Number(row.id),
    user_id: Number(row.user_id),
    status,
    message,
    stage: fileStatus?.stage || row.stage || null,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
    updated_at: nowIso(),
    raw: fileStatus || null,
    error_code: fileStatus?.error_code || row.error_code || null,
  };
  ribeiraoSessionCache.set(Number(sessionId), session);
  return session;
}

export async function startRibeiraoSession({ userId, login, password, timeoutSeconds = 900, slowMo = 0, userName = '', role = 'gerencial' }) {
  clearRibeiraoSessionCache();
  const database = getDb();
  const sessionAt = nowIso();
  const insertResult = run(
    database,
    `
      INSERT INTO ribeirao_query_sessions (user_id, status, started_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    [userId, RIBEIRAO_SESSION_STATUSES.CONNECTING, sessionAt, sessionAt, sessionAt]
  );
  const sessionId = Number(
    insertResult?.lastInsertRowid ||
      insertResult?.last_insert_rowid ||
      one(database, 'SELECT id AS id FROM ribeirao_query_sessions ORDER BY id DESC LIMIT 1')?.id ||
      lastInsertId(database) ||
      0
  );

  const { loginUrl, consultaUrl } = resolveRibeiraoUrls();
  const configuredUrl = loginUrl || consultaUrl || '';
  if (isPlaceholderUrl(configuredUrl) || !String(configuredUrl || '').startsWith('http')) {
    const message = 'URL do averbador de Ribeirao nao configurada. Configure RIBEIRAO_AVERBADOR_URL no .env da VPS e reinicie os containers.';
    run(
      database,
      'UPDATE ribeirao_query_sessions SET status = ?, error_message = ?, updated_at = ? WHERE id = ?',
      [RIBEIRAO_SESSION_STATUSES.LOGIN_ERROR, message, nowIso(), sessionId]
    );
    const error = new Error(message);
    error.code = 'MISSING_RIBEIRAO_URL';
    throw error;
  }

  console.log('[RIBEIRAO] NODE_ENV:', process.env.NODE_ENV || '');
  console.log('[RIBEIRAO] RIBEIRAO_HEADLESS:', process.env.RIBEIRAO_HEADLESS || '');
  console.log('[RIBEIRAO] headless efetivo:', resolveRibeiraoHeadless());
  console.log('[RIBEIRAO] BUILD:', BUILD_VERSION);

  const payload = {
    action: 'start_session',
    session_id: sessionId,
    login,
    password,
    timeout_seconds: timeoutSeconds,
    slow_mo: slowMo,
    headless: resolveRibeiraoHeadless(),
    user_id: userId,
    user_name: userName,
    role,
  };

  try {
    const result = await runRibeiraoCommand(payload, { timeoutMs: Math.max(60000, timeoutSeconds * 1000 + 30000) });
    const status = String(result?.status || '').toLowerCase();
    if (status === RIBEIRAO_SESSION_STATUSES.CONNECTED) {
      run(
        database,
        'UPDATE ribeirao_query_sessions SET status = ?, error_message = ?, updated_at = ? WHERE id = ?',
        [RIBEIRAO_SESSION_STATUSES.CONNECTED, result?.message || null, nowIso(), sessionId]
      );
    } else if (status === RIBEIRAO_SESSION_STATUSES.WAITING_CAPTCHA || status === 'aguardando_validacao_manual') {
      run(
        database,
        'UPDATE ribeirao_query_sessions SET status = ?, error_message = ?, updated_at = ? WHERE id = ?',
        [RIBEIRAO_SESSION_STATUSES.WAITING_CAPTCHA, result?.message || null, nowIso(), sessionId]
      );
    } else if (status === RIBEIRAO_SESSION_STATUSES.LOGIN_ERROR || status === 'erro_login') {
      run(
        database,
        'UPDATE ribeirao_query_sessions SET status = ?, error_message = ?, updated_at = ? WHERE id = ?',
        [RIBEIRAO_SESSION_STATUSES.LOGIN_ERROR, result?.message || null, nowIso(), sessionId]
      );
    } else if (status === 'browser_launch_error' || String(result?.code || '').toUpperCase() === 'BROWSER_LAUNCH_ERROR') {
      const message = result?.message || 'Erro ao iniciar navegador de consulta no servidor. Verifique configuracao do Playwright/Chromium em producao.';
      run(
        database,
        'UPDATE ribeirao_query_sessions SET status = ?, error_message = ?, updated_at = ? WHERE id = ?',
        [RIBEIRAO_SESSION_STATUSES.ERROR, message, nowIso(), sessionId]
      );
    } else if (status === RIBEIRAO_SESSION_STATUSES.SESSION_EXPIRED || status === 'expired') {
      run(
        database,
        'UPDATE ribeirao_query_sessions SET status = ?, error_message = ?, updated_at = ? WHERE id = ?',
        [RIBEIRAO_SESSION_STATUSES.SESSION_EXPIRED, result?.message || null, nowIso(), sessionId]
      );
    } else {
      run(
        database,
        'UPDATE ribeirao_query_sessions SET status = ?, error_message = ?, updated_at = ? WHERE id = ?',
        [RIBEIRAO_SESSION_STATUSES.ERROR, result?.message || 'Falha ao iniciar a sessao Ribeirao.', nowIso(), sessionId]
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Falha ao iniciar a sessao Ribeirao.';
    run(
      database,
      'UPDATE ribeirao_query_sessions SET status = ?, error_message = ?, updated_at = ? WHERE id = ?',
      [RIBEIRAO_SESSION_STATUSES.LOGIN_ERROR, message, nowIso(), sessionId]
    );
    return getRibeiraoSessionStatus(sessionId);
  }
  const session = getRibeiraoSessionStatus(sessionId) || {
    id: sessionId,
    user_id: userId,
    status: RIBEIRAO_SESSION_STATUSES.CONNECTED,
    message: result?.message || 'Sessao autenticada com sucesso.',
    stage: result?.stage || null,
    started_at: sessionAt,
    finished_at: null,
    created_at: sessionAt,
    updated_at: nowIso(),
    raw: result || null,
  };
  ribeiraoSessionCache.set(Number(sessionId), session);
  return session;
}

export async function queryRibeiraoCpf({ userId, sessionId, cpf, login, password, clientId = null, baseId = null }) {
  const database = getDb();
  const gate = getRibeiraoSessionGate(sessionId);
  if (!gate.success) {
    throw createSessionGateError(gate.code, gate.message);
  }

  const clientMatches = findClientsByCpf(cpf).filter(Boolean);
  console.log('[RIBEIRAO] BUILD:', BUILD_VERSION);
  console.log('[RIBEIRAO] NODE_ENV:', process.env.NODE_ENV || '');
  console.log('[RIBEIRAO] RIBEIRAO_HEADLESS:', process.env.RIBEIRAO_HEADLESS || '');
  console.log('[RIBEIRAO] headless efetivo:', resolveRibeiraoHeadless());
  const payload = await runRibeiraoCommand(
    {
      action: 'query',
      session_id: sessionId,
      login,
      password,
      cpf,
      client_id: clientId,
      base_id: baseId,
      headless: resolveRibeiraoHeadless(),
    },
    { timeoutMs: 180000 }
  );

  const normalized = normalizeQueryPayload(payload, userId, sessionId, clientMatches);
  const createdAt = nowIso();

  run(
    database,
    `
      INSERT INTO ribeirao_margin_queries (
        user_id,
        session_id,
        client_id,
        base_id,
        cpf,
        cpf_masked,
        nome,
        matricula,
        orgao,
        consulta_status,
        mensagem,
        best_product_type,
        best_net_margin,
        margem_emprestimo_total,
        margem_emprestimo_disponivel,
        margem_cartao_total,
        margem_cartao_disponivel,
        raw_result_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      userId,
      sessionId,
      clientId,
      baseId,
      normalized.cpf,
      normalized.cpf_masked,
      normalized.nome || '',
      normalized.matricula || '',
      normalized.orgao || '',
      normalized.consultaStatus,
      normalized.mensagem || '',
      normalized.best_product_type || '',
      normalized.best_net_margin,
      normalized.margem_emprestimo_total ?? null,
      normalized.margem_emprestimo_disponivel ?? null,
      normalized.margem_cartao_total ?? null,
      normalized.margem_cartao_disponivel ?? null,
      normalized.raw_result_json,
      createdAt,
    ]
  );

  const queryId = lastInsertId(database);
  persistQueryMargins(database, queryId, normalized.products);

  const record = one(database, 'SELECT * FROM ribeirao_margin_queries WHERE id = ?', [queryId]);
  const historyItem = serializeQueryRow(record);

  const nextSessionStatus =
    normalized.consultaStatus === RIBEIRAO_QUERY_STATUSES.WITH_MARGIN ||
    normalized.consultaStatus === RIBEIRAO_QUERY_STATUSES.WITHOUT_MARGIN ||
    normalized.consultaStatus === RIBEIRAO_QUERY_STATUSES.NOT_FOUND
      ? RIBEIRAO_SESSION_STATUSES.CONNECTED
      : normalized.consultaStatus === RIBEIRAO_QUERY_STATUSES.CAPTCHA_REQUIRED
        ? RIBEIRAO_SESSION_STATUSES.WAITING_CAPTCHA
        : normalized.consultaStatus === RIBEIRAO_QUERY_STATUSES.LOGIN_ERROR
          ? RIBEIRAO_SESSION_STATUSES.LOGIN_ERROR
          : normalized.consultaStatus === RIBEIRAO_QUERY_STATUSES.SESSION_EXPIRED
            ? RIBEIRAO_SESSION_STATUSES.SESSION_EXPIRED
            : RIBEIRAO_SESSION_STATUSES.ERROR;

  run(
    database,
    'UPDATE ribeirao_query_sessions SET status = ?, updated_at = ? WHERE id = ?',
    [nextSessionStatus, nowIso(), sessionId]
  );

  return {
    query: historyItem,
    client_matches: clientMatches,
    standardized: normalized,
  };
}

export function resetRibeiraoSessionCache(sessionId = null) {
  clearRibeiraoSessionCache(sessionId);
}

export function listRibeiraoHistory(filters = {}) {
  const database = getDb();
  const clauses = [];
  const values = [];

  if (filters.session_id) {
    clauses.push('q.session_id = ?');
    values.push(Number(filters.session_id));
  }
  if (filters.status) {
    clauses.push('q.consulta_status = ?');
    values.push(String(filters.status));
  }
  if (filters.cpf) {
    clauses.push('q.cpf LIKE ?');
    values.push(`%${_digits(filters.cpf)}%`);
  }
  if (filters.user_id) {
    clauses.push('q.user_id = ?');
    values.push(Number(filters.user_id));
  }
  if (filters.from) {
    clauses.push('datetime(q.created_at) >= datetime(?)');
    values.push(String(filters.from));
  }
  if (filters.to) {
    clauses.push('datetime(q.created_at) <= datetime(?)');
    values.push(String(filters.to));
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = all(
    database,
    `
      SELECT
        q.*,
        u.name AS user_name,
        s.status AS session_status,
        s.started_at AS session_started_at,
        s.finished_at AS session_finished_at
      FROM ribeirao_margin_queries q
      LEFT JOIN users u ON u.id = q.user_id
      LEFT JOIN ribeirao_query_sessions s ON s.id = q.session_id
      ${where}
      ORDER BY datetime(q.created_at) DESC, q.id DESC
      LIMIT 200
    `,
    values
  ).map((row) => serializeQueryRow(row));

  return rows;
}

function _digits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function getRibeiraoHistoryById(id) {
  const database = getDb();
  const row = one(
    database,
    `
      SELECT
        q.*,
        u.name AS user_name,
        s.status AS session_status,
        s.started_at AS session_started_at,
        s.finished_at AS session_finished_at,
        s.error_message AS session_error_message
      FROM ribeirao_margin_queries q
      LEFT JOIN users u ON u.id = q.user_id
      LEFT JOIN ribeirao_query_sessions s ON s.id = q.session_id
      WHERE q.id = ?
    `,
    [id]
  );

  if (!row) {
    return null;
  }

  const query = serializeQueryRow(row);
  return {
    ...query,
    user_name: row.user_name || '',
    session_status: row.session_status || '',
    session_started_at: row.session_started_at || '',
    session_finished_at: row.session_finished_at || '',
    session_error_message: row.session_error_message || '',
    client_matches: findClientsByCpf(row.cpf).filter(Boolean),
  };
}

export function applyRibeiraoResultToClient({ queryId, clientId, baseId, userId }) {
  const database = getDb();
  const query = getRibeiraoHistoryById(queryId);
  if (!query) {
    return null;
  }

  const client = getClientById(clientId);
  if (!client) {
    return null;
  }

  if (baseId && Number(baseId) !== Number(client.client?.base_id || client.client?.campaign_id || 0)) {
    return null;
  }

  run(database, 'DELETE FROM client_margins WHERE client_id = ?', [clientId]);
  for (const margin of query.margins || []) {
    run(
      database,
      `
        INSERT INTO client_margins (
          client_id,
          product_type,
          gross_margin,
          net_margin,
          source_gross_column,
          source_net_column,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        clientId,
        margin.product_type,
        margin.gross_margin ?? null,
        margin.net_margin ?? null,
        margin.source_gross_column || '',
        margin.source_net_column || '',
        nowIso(),
        nowIso(),
      ]
    );
  }

  run(
    database,
    `
      UPDATE clients
      SET
        consulta_status = ?,
        consulta_mensagem = ?,
        best_product_type = ?,
        best_net_margin = ?,
        raw_data_json = ?,
        updated_at = ?
      WHERE id = ?
    `,
    [
      query.consulta_status,
      `Margem atualizada via Consulta Ribeirao. ${query.mensagem || ''}`.trim(),
      query.best_product_type || '',
      query.best_net_margin === null || query.best_net_margin === undefined ? null : Number(query.best_net_margin),
      query.raw_result_json || '{}',
      nowIso(),
      clientId,
    ]
  );

  if (userId) {
    addInteraction(clientId, {
      userId,
      type: 'observacao',
      note: 'Margem atualizada via Consulta Ribeirao',
      private_note: '',
    });
  }

  return getClientById(clientId);
}

export function getRibeiraoDashboardSummary(filters = {}) {
  const history = listRibeiraoHistory(filters);
  const total = history.length;
  const withMargin = history.filter((item) => item.consulta_status === RIBEIRAO_QUERY_STATUSES.WITH_MARGIN).length;
  const withoutMargin = history.filter((item) => item.consulta_status === RIBEIRAO_QUERY_STATUSES.WITHOUT_MARGIN).length;
  const notFound = history.filter((item) => item.consulta_status === RIBEIRAO_QUERY_STATUSES.NOT_FOUND).length;
  const errors = history.filter((item) => item.consulta_status === RIBEIRAO_QUERY_STATUSES.ERROR).length;
  const captcha = history.filter((item) => item.consulta_status === RIBEIRAO_QUERY_STATUSES.CAPTCHA_REQUIRED).length;

  return {
    total,
    with_margin: withMargin,
    without_margin: withoutMargin,
    not_found: notFound,
    errors,
    captcha,
    history,
  };
}
