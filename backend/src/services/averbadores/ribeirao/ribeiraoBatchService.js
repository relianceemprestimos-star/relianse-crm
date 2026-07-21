import {
  createRibeiraoBatchRecord,
  getDb,
  getRibeiraoBatchById,
  listRibeiraoBatchResults,
  listRibeiraoBatches,
  updateRibeiraoBatchRecord,
} from '../../../db.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanDigits,
  formatCpfDisplay,
  formatMoney,
  getWorksheetHeaders,
  matchColumn,
  normalizeCpfValue,
  normalizeHeaderKey,
  parseMoney,
  readSpreadsheetRows,
} from '../../../utils.js';
import * as XLSX from 'xlsx';
import { getCredentialSecretByPortal } from '../../credentials/credentialService.js';
import { getPortalConfig } from '../../credentials/portalConfigs.js';
import {
  getCaptchaRuntimeEnv,
  markManualRequired,
  registerUsageLog,
} from '../../captcha/captchaManager.js';
import {
  applyRibeiraoResultToClient,
  findClientsByCpf,
  getRibeiraoHistoryById,
  getRibeiraoSessionGate,
  queryRibeiraoCpf,
} from './ribeiraoService.js';
import { runAmapaCommand, runSantanaCommand, runSantanaWebCommand } from './ribeiraoAdapter.js';
import { RIBEIRAO_QUERY_STATUSES, normalizeRibeiraoQueryResult } from './ribeiraoTypes.js';

const activeBatchJobs = new Map();
const BATCH_RESULT_SUBDIR = path.join('consultas-margem', 'resultados');

function nowIso() {
  return new Date().toISOString();
}

function getBatchResultBaseDir() {
  const dbPathCandidate = String(process.env.SQLITE_PATH || process.env.DATABASE_PATH || '').trim();
  if (dbPathCandidate) {
    return path.resolve(path.dirname(dbPathCandidate));
  }
  return path.resolve(process.cwd(), 'data');
}

function getBatchResultDir() {
  return path.join(getBatchResultBaseDir(), BATCH_RESULT_SUBDIR);
}

function ensureBatchResultDir() {
  const targetDir = getBatchResultDir();
  fs.mkdirSync(targetDir, { recursive: true });
  return targetDir;
}

function normalizeExportSlug(value) {
  const slug = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'consulta-margem';
}

function getBatchPortalLabel(batch) {
  const portalId = String(batch?.portal_id || 'prefeitura_ribeirao_preto');
  return getPortalConfig(portalId)?.name || batch?.base_convenio || 'Consulta de Margem';
}

function sanitizeWorksheetName(value) {
  const name = String(value || 'Resultados')
    .replace(/[:\/?*[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (name || 'Resultados').slice(0, 31);
}

function buildBatchDownloadFileName(batchOrId, ext = 'xlsx') {
  const batch = typeof batchOrId === 'object' && batchOrId !== null
    ? batchOrId
    : getRibeiraoBatchById(batchOrId);
  const batchId = Number(batch?.id || batchOrId || 0);
  const stamp = new Date().toISOString().slice(0, 10);
  const portalSlug = normalizeExportSlug(getBatchPortalLabel(batch));
  const safeExt = String(ext || 'xlsx').replace(/^\./, '').replace(/[^a-z0-9]/gi, '') || 'xlsx';
  const partialSuffix = batch?.status === 'em_andamento' ? '-parcial' : '';
  return `resultado-${portalSlug}-${stamp}-lote-${batchId}${partialSuffix}.${safeExt}`;
}

function buildBatchResultFileName(batchId, ext = 'xlsx') {
  return buildBatchDownloadFileName(batchId, ext);
}

function saveBatchResultFile(batchId) {
  const targetDir = ensureBatchResultDir();
  const filename = buildBatchResultFileName(batchId, 'xlsx');
  const absolutePath = path.join(targetDir, filename);
  const workbookBuffer = exportRibeiraoBatchResultsXlsx(batchId);
  fs.writeFileSync(absolutePath, workbookBuffer);
  return path.join(BATCH_RESULT_SUBDIR, filename).replace(/\\/g, '/');
}

function resolveBatchResultFile(resultFilePath) {
  const relative = String(resultFilePath || '').trim().replace(/\\/g, '/');
  if (!relative) {
    return null;
  }
  const baseDir = getBatchResultBaseDir();
  const resolved = path.resolve(baseDir, relative);
  if (!resolved.startsWith(baseDir)) {
    return null;
  }
  return resolved;
}

function finalizeBatch(batchId, status, options = {}) {
  const {
    errorMessage = '',
    forceResultFile = false,
    processedCount,
  } = options;

  const current = getRibeiraoBatchById(batchId);
  if (!current) {
    return null;
  }

  let resultFilePath = current.result_file_path || '';
  const shouldGenerateFile = forceResultFile || Number(current.processed_count || 0) > 0 || status === 'concluido';
  if (shouldGenerateFile) {
    try {
      resultFilePath = saveBatchResultFile(batchId);
    } catch (error) {
      const suffix = error instanceof Error ? error.message : String(error || 'erro ao salvar resultado');
      const mergedMessage = errorMessage
        ? `${errorMessage} | RESULT_FILE_ERROR: ${suffix}`
        : `RESULT_FILE_ERROR: ${suffix}`;
      updateRibeiraoBatchRecord(batchId, {
        status,
        finished_at: nowIso(),
        processed_count: Number.isFinite(Number(processedCount)) ? Number(processedCount) : Number(current.processed_count || 0),
        result_file_path: '',
        result_file_format: '',
        error_message: mergedMessage,
      });
      return getRibeiraoBatchById(batchId);
    }
  }

  updateRibeiraoBatchRecord(batchId, {
    status,
    finished_at: nowIso(),
    processed_count: Number.isFinite(Number(processedCount)) ? Number(processedCount) : Number(current.processed_count || 0),
    result_file_path: resultFilePath || '',
    result_file_format: resultFilePath ? 'xlsx' : '',
    error_message: String(errorMessage || ''),
  });

  return getRibeiraoBatchById(batchId);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function ensureBatchEntriesTable(database = getDb()) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS ribeirao_batch_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      cpf TEXT NOT NULL,
      nome TEXT DEFAULT '',
      matricula TEXT DEFAULT '',
      orgao TEXT DEFAULT '',
      cargo TEXT DEFAULT '',
      vinculo TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(batch_id, cpf)
    )
  `);
}

function persistBatchEntries(batchId, entries = []) {
  const database = getDb();
  ensureBatchEntriesTable(database);
  const now = nowIso();
  const statement = database.prepare(`
    INSERT OR IGNORE INTO ribeirao_batch_entries (
      batch_id,
      position,
      cpf,
      nome,
      matricula,
      orgao,
      cargo,
      vinculo,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  entries.forEach((entry, index) => {
    const source = normalizeBatchSourceRecord(entry.source || entry);
    const cpf = cleanDigits(String(entry.cpf || source.cpf || ''));
    if (cpf.length !== 11) return;
    statement.run(
      batchId,
      index + 1,
      cpf,
      source.nome,
      source.matricula,
      source.orgao,
      source.cargo,
      source.vinculo,
      now,
      now
    );
  });
}

function listPersistedBatchEntries(batchId) {
  const database = getDb();
  ensureBatchEntriesTable(database);
  return database
    .prepare(
      `
        SELECT cpf, nome, matricula, orgao, cargo, vinculo
        FROM ribeirao_batch_entries
        WHERE batch_id = ?
        ORDER BY position ASC, id ASC
      `
    )
    .all(batchId)
    .map((row) => ({
      cpf: cleanDigits(String(row.cpf || '')),
      source: normalizeBatchSourceRecord(row),
    }))
    .filter((entry) => entry.cpf.length === 11);
}

function listPendingBatchEntries(batchId) {
  const database = getDb();
  ensureBatchEntriesTable(database);
  return database
    .prepare(
      `
        SELECT e.cpf, e.nome, e.matricula, e.orgao, e.cargo, e.vinculo
        FROM ribeirao_batch_entries e
        LEFT JOIN ribeirao_margin_queries q
          ON q.batch_id = e.batch_id
         AND q.cpf = e.cpf
         AND q.consulta_status <> 'captcha_required'
        WHERE e.batch_id = ?
          AND q.id IS NULL
        ORDER BY e.position ASC, e.id ASC
      `
    )
    .all(batchId)
    .map((row) => ({
      cpf: cleanDigits(String(row.cpf || '')),
      source: normalizeBatchSourceRecord(row),
    }))
    .filter((entry) => entry.cpf.length === 11);
}

function getLatestConnectedSessionId(userId) {
  const database = getDb();
  const row = one(
    database,
    `
      SELECT id
      FROM ribeirao_query_sessions
      WHERE user_id = ?
        AND status LIKE '%conect%'
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `,
    [userId]
  );
  return Number(row?.id || 0);
}

function randomDelay(minSeconds = 3, maxSeconds = 8) {
  const min = Math.max(0, Number(minSeconds || 0));
  const max = Math.max(min, Number(maxSeconds || min));
  const seconds = min === max ? min : min + Math.random() * (max - min);
  return Math.max(0, Math.round(seconds * 1000));
}

function maskBatchCpfLog(cpf) {
  const digits = cleanDigits(String(cpf || ''));
  if (digits.length >= 3) {
    return `***${digits.slice(-3)}`;
  }
  return '***';
}

function getBatchControl(batchId) {
  if (!activeBatchJobs.has(batchId)) {
    activeBatchJobs.set(batchId, { paused: false, cancelled: false, running: false, waitingCaptcha: false });
  }
  return activeBatchJobs.get(batchId);
}

function normalizeBatchBaseId(baseId) {
  if (baseId === null || baseId === undefined || baseId === '') {
    return null;
  }

  const text = String(baseId).trim().toLowerCase();
  if (text === 'all' || text === 'all_active') {
    return null;
  }

  const numeric = Number(baseId);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeCpfSource(value) {
  const normalized = normalizeCpfValue(value);
  return {
    raw: value ?? '',
    cpf: normalized.cpf,
    cpf_display: normalized.displayCpf || formatCpfDisplay(normalized.cpf),
    alerts: normalized.alerts,
    isValid: normalized.isValid,
  };
}

function extractCpfColumn(headers) {
  const column = matchColumn(headers, ['cpf', 'documento']);
  if (column) {
    return column;
  }

  return headers.find((header) => {
    const norm = normalizeHeaderKey(header);
    return norm.includes('cpf') || norm.includes('documento');
  }) || '';
}

function extractIdentityColumns(headers) {
  return {
    nome: matchColumn(headers, ['nome', 'cliente', 'servidor']) || '',
    matricula: matchColumn(headers, ['matricula', 'matrícula', 'registro']) || '',
    orgao: matchColumn(headers, ['orgao', 'órgão', 'entidade', 'convenio', 'convênio']) || '',
    cargo: matchColumn(headers, ['cargo', 'funcao', 'função']) || '',
    vinculo: matchColumn(headers, ['vinculo', 'vínculo', 'tipo servidor', 'tipo do servidor', 'regime']) || '',
  };
}

function readRowValue(row, column) {
  if (!column) return '';
  const value = row?.[column];
  return value === null || value === undefined ? '' : String(value).trim();
}

function normalizeBatchSourceRecord(record = {}) {
  return {
    cpf: cleanDigits(String(record.cpf || record.cpf_display || '')),
    nome: String(record.nome || '').trim(),
    matricula: String(record.matricula || '').trim(),
    orgao: String(record.orgao || '').trim(),
    cargo: String(record.cargo || '').trim(),
    vinculo: String(record.vinculo || '').trim(),
  };
}

function normalizeLooseText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9: ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function isGarbagePortalField(value = '') {
  const text = String(value || '').trim();
  if (!text) return false;
  const upper = normalizeLooseText(text);
  if (text.length > 140) return true;
  const garbageTokens = [
    'DETALHES DA MARGEM',
    'MARGEM TOTAL',
    'MARGEM DISPON',
    'TIPO ACESSO',
    'CONSULTA DE MARGEM',
    'INÍCIO PÁGINA',
    'CHAT ONLINE',
    'SERVIÇO',
    'DATA DE ADMISS',
    'ÓRGÃO/ENTIDADE',
    'ORGÃO/ENTIDADE',
    'ACESSO:',
  ];
  if (upper.startsWith('DATA INCLUSAO')) return true;
  if (upper.startsWith('CPF TIPO')) return true;
  if (upper.startsWith('ACESSO:')) return true;
  if (upper.includes('ORGAO ENTIDADE')) return true;
  return garbageTokens.some((token) => upper.includes(normalizeLooseText(token)));
}

function cleanIdentityField(value = '', { allowColon = false } = {}) {
  const text = String(value || '').trim();
  if (!text) return '';
  const upper = normalizeLooseText(text);
  if (upper === 'DATA INCLUSÃO' || upper === 'DATA INCLUSAO') return '';
  if (upper.startsWith('DATA INCLUSAO')) return '';
  if (upper.startsWith('CPF TIPO')) return '';
  if (upper.startsWith('ACESSO:')) return '';
  if (!allowColon && text.includes(':')) return '';
  if (isGarbagePortalField(text)) return '';
  return text;
}

function sanitizeAndMergeIdentity(queryRow = {}, sourceRecord = {}) {
  const next = {
    nome: cleanIdentityField(queryRow.nome),
    matricula: cleanIdentityField(queryRow.matricula),
    orgao: cleanIdentityField(queryRow.orgao, { allowColon: false }),
    cargo: cleanIdentityField(queryRow.cargo),
    vinculo: cleanIdentityField(queryRow.vinculo),
  };

  const source = normalizeBatchSourceRecord(sourceRecord);
  if (!next.nome && source.nome) next.nome = source.nome;
  if (!next.matricula && source.matricula) next.matricula = source.matricula;
  if (!next.orgao && source.orgao) next.orgao = source.orgao;
  if (!next.cargo && source.cargo) next.cargo = source.cargo;
  if (!next.vinculo && source.vinculo) next.vinculo = source.vinculo;
  return next;
}

export function previewRibeiraoBatchSpreadsheet(buffer, filename) {
  const rows = readSpreadsheetRows(buffer, filename);
  const headers = getWorksheetHeaders(rows);
  const cpfColumn = extractCpfColumn(headers);
  const identityColumns = extractIdentityColumns(headers);

  const previewRows = rows.map((row, index) => {
    const source = normalizeCpfSource(cpfColumn ? row[cpfColumn] : Object.values(row || {})[0]);
    return {
      rowNumber: index + 2,
      cpf: source.cpf,
      cpf_display: source.cpf_display,
      raw_value: String(source.raw ?? ''),
      isValid: source.isValid,
      alerts: source.alerts,
      nome: readRowValue(row, identityColumns.nome),
      matricula: readRowValue(row, identityColumns.matricula),
      orgao: readRowValue(row, identityColumns.orgao),
      cargo: readRowValue(row, identityColumns.cargo),
      vinculo: readRowValue(row, identityColumns.vinculo),
    };
  });

  return {
    headers,
    cpf_column: cpfColumn,
    total_rows: previewRows.length,
    valid_rows: previewRows.filter((row) => row.isValid).length,
    invalid_rows: previewRows.filter((row) => !row.isValid).length,
    preview_rows: previewRows.slice(0, 100),
    cpfs: previewRows.filter((row) => row.isValid).map((row) => row.cpf),
    source_rows: previewRows
      .filter((row) => row.isValid)
      .map((row) => normalizeBatchSourceRecord(row)),
  };
}

export function loadRibeiraoBatchCpfsFromBase(baseId) {
  const database = getDb();
  const isAll = String(baseId || '').toLowerCase() === 'all' || String(baseId || '') === 'all_active';
  const sql = isAll
    ? `
      SELECT DISTINCT c.id AS client_id, COALESCE(c.base_id, c.campaign_id) AS base_id, c.cpf, c.name
      FROM clients c
      LEFT JOIN bases b ON b.id = COALESCE(c.base_id, c.campaign_id)
      WHERE c.cpf IS NOT NULL
        AND TRIM(c.cpf) <> ''
        AND COALESCE(b.is_active, 1) = 1
      ORDER BY datetime(c.created_at) ASC, c.id ASC
    `
    : `
      SELECT DISTINCT c.id AS client_id, COALESCE(c.base_id, c.campaign_id) AS base_id, c.cpf, c.name
      FROM clients c
      WHERE COALESCE(c.base_id, c.campaign_id) = ?
        AND c.cpf IS NOT NULL
        AND TRIM(c.cpf) <> ''
      ORDER BY datetime(c.created_at) ASC, c.id ASC
    `;

  const params = isAll ? [] : [Number(baseId)];
  const statement = database.prepare(sql);
  if (typeof statement.all === 'function') {
    const rows = params.length ? statement.all(...params) : statement.all();
    return rows
      .map((row) => {
        const normalized = normalizeCpfSource(row.cpf);
        return {
          client_id: row.client_id === null || row.client_id === undefined ? null : Number(row.client_id),
          base_id: row.base_id === null || row.base_id === undefined ? null : Number(row.base_id),
          name: row.name || '',
          cpf: normalized.cpf,
          cpf_display: normalized.cpf_display,
          isValid: normalized.isValid,
          alerts: normalized.alerts,
        };
      })
      .filter((row) => row.isValid);
  }

  const rows = [];
  if (params.length && typeof statement.bind === 'function') {
    statement.bind(params);
  }
  while (statement.step()) {
    rows.push(statement.getAsObject());
  }
  statement.free();

  return rows
    .map((row) => {
      const normalized = normalizeCpfSource(row.cpf);
      return {
        client_id: row.client_id === null || row.client_id === undefined ? null : Number(row.client_id),
        base_id: row.base_id === null || row.base_id === undefined ? null : Number(row.base_id),
        name: row.name || '',
        cpf: normalized.cpf,
        cpf_display: normalized.cpf_display,
        isValid: normalized.isValid,
        alerts: normalized.alerts,
      };
    })
    .filter((row) => row.isValid);
}

function mapBatchRow(row) {
  if (!row) {
    return null;
  }

  const history = getRibeiraoHistoryById(row.id) || {};
  const sanitizeIdentity = (value) => cleanIdentityField(value, { allowColon: false });
  return {
    ...history,
    nome: sanitizeIdentity(history.nome),
    matricula: sanitizeIdentity(history.matricula),
    orgao: sanitizeIdentity(history.orgao),
    cargo: sanitizeIdentity(history.cargo),
    vinculo: sanitizeIdentity(history.vinculo),
    batch_id: row.batch_id === null || row.batch_id === undefined ? null : Number(row.batch_id),
    user_name: row.user_name || history.user_name || '',
    client_name: row.client_name || '',
    base_name: row.base_name || history.base_name || '',
    base_type: row.base_type || history.base_type || '',
    base_convenio: row.base_convenio || history.base_convenio || '',
    base_state: row.base_state || history.base_state || '',
    base_city: row.base_city || history.base_city || '',
    base_file_name: row.base_file_name || history.base_file_name || '',
  };
}

async function waitUntilResumed(batchId) {
  while (true) {
    const control = getBatchControl(batchId);
    const batch = getRibeiraoBatchById(batchId);
    if (!batch) {
      return false;
    }

    if (control.cancelled || batch.status === 'cancelado') {
      return false;
    }

    if (!control.paused && batch.status !== 'pausado' && batch.status !== 'aguardando_captcha') {
      return true;
    }

    await sleep(1000);
  }
}

function clearBatchCaptchaPlaceholders(batchId) {
  const database = getDb();
  const deleted = database
    .prepare('DELETE FROM ribeirao_margin_queries WHERE batch_id = ? AND consulta_status = ?')
    .run(batchId, RIBEIRAO_QUERY_STATUSES.CAPTCHA_REQUIRED).changes || 0;

  const rows = database
    .prepare(
      `
        SELECT consulta_status, COUNT(*) AS qty
        FROM ribeirao_margin_queries
        WHERE batch_id = ?
        GROUP BY consulta_status
      `
    )
    .all(batchId);
  const count = (status) => Number(rows.find((row) => row.consulta_status === status)?.qty || 0);
  const successCount = count(RIBEIRAO_QUERY_STATUSES.WITH_MARGIN);
  const noMarginCount = count(RIBEIRAO_QUERY_STATUSES.WITHOUT_MARGIN);
  const notFoundCount = count(RIBEIRAO_QUERY_STATUSES.NOT_FOUND);
  const errorCount = count(RIBEIRAO_QUERY_STATUSES.ERROR) + count(RIBEIRAO_QUERY_STATUSES.LOGIN_ERROR) + count(RIBEIRAO_QUERY_STATUSES.SESSION_EXPIRED);
  const captchaCount = count(RIBEIRAO_QUERY_STATUSES.CAPTCHA_REQUIRED);

  updateRibeiraoBatchRecord(batchId, {
    processed_count: successCount + noMarginCount + notFoundCount + errorCount + captchaCount,
    success_count: successCount,
    no_margin_count: noMarginCount,
    not_found_count: notFoundCount,
    error_count: errorCount,
    captcha_count: captchaCount,
  });

  return deleted;
}

function updateBatchCounts(batchId, delta = {}, status) {
  const batch = getRibeiraoBatchById(batchId);
  if (!batch) {
    return null;
  }

  const next = {
    processed_count: batch.processed_count + Number(delta.processed_count || 0),
    success_count: batch.success_count + Number(delta.success_count || 0),
    no_margin_count: batch.no_margin_count + Number(delta.no_margin_count || 0),
    not_found_count: batch.not_found_count + Number(delta.not_found_count || 0),
    error_count: batch.error_count + Number(delta.error_count || 0),
    captcha_count: batch.captcha_count + Number(delta.captcha_count || 0),
    status: status || batch.status,
    started_at: batch.started_at || nowIso(),
    finished_at: delta.finished_at !== undefined ? delta.finished_at : batch.finished_at,
  };

  return updateRibeiraoBatchRecord(batchId, next);
}

function saveBatchCpfTechnicalError(batchId, {
  userId,
  sessionId,
  cpf,
  sourceRecord = {},
  baseId = null,
  message = 'Erro tecnico na consulta.',
  code = 'TECHNICAL_ERROR',
}) {
  const database = getDb();
  const identity = sanitizeAndMergeIdentity({}, sourceRecord || {});
  const createdAt = nowIso();
  const raw = JSON.stringify({
    status: 'erro',
    code,
    message,
    source: 'batch_error',
  });
  const result = database
    .prepare(
      `
        INSERT INTO ribeirao_margin_queries (
          batch_id,
          user_id,
          session_id,
          client_id,
          base_id,
          cpf,
          cpf_masked,
          nome,
          matricula,
          orgao,
          cargo,
          vinculo,
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
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, NULL, NULL, NULL, NULL, ?, ?)
      `
    )
    .run(
      batchId,
      userId,
      sessionId || null,
      baseId,
      cpf,
      formatCpfDisplay(cpf),
      identity.nome || '',
      identity.matricula || '',
      identity.orgao || '',
      identity.cargo || '',
      identity.vinculo || '',
      RIBEIRAO_QUERY_STATUSES.ERROR || 'erro',
      message,
      raw,
      createdAt
    );
  return Number(result?.lastInsertRowid || 0);
}

function normalizeAmapaBestProduct(payload = {}) {
  const candidates = [
    { product: 'credito', value: parseMoney(payload.facultativa_disponivel) },
    { product: 'cartao', value: parseMoney(payload.cartao_disponivel) },
    { product: 'cartao_beneficio', value: parseMoney(payload.cartao_beneficio_disponivel) },
  ].filter((item) => item.value !== null && item.value !== undefined);

  if (!candidates.length) {
    return { product: '', value: null };
  }
  return candidates.reduce((best, item) => (Number(item.value) > Number(best.value) ? item : best), candidates[0]);
}

async function queryAmapaCpfForBatch({
  batchId,
  userId,
  cpf,
  login,
  password,
  sourceRecord = {},
  baseId = null,
}) {
  const database = getDb();
  const clientMatches = findClientsByCpf(cpf).filter(Boolean);
  const rawResult = await runAmapaCommand(
    {
      action: 'query',
      batch_id: batchId,
      cpf,
      login,
      password,
      headless: true,
      timeout_ms: Number(process.env.AMAPA_QUERY_TIMEOUT_MS || 30000),
    },
    { timeoutMs: Number(process.env.AMAPA_QUERY_TIMEOUT_TOTAL_MS || 180000) }
  );

  const payload = rawResult?.payload_extra || {};
  const detailText = String(rawResult?.detalhe_erro || rawResult?.message || '').toLowerCase();
  const normalizedStatus = /cpf.*(nao|não).*localizado|nenhum registro|sem resultado/.test(detailText)
    ? 'not_found'
    : rawResult?.status;
  const bestAmapa = normalizeAmapaBestProduct(payload);
  const enrichedRaw = {
    ...(rawResult || {}),
    status: normalizedStatus,
    payload_extra: {
      ...payload,
      margem_emprestimo_total: payload.facultativa_margem_consignavel || payload.margem_emprestimo_total || '',
      margem_emprestimo_disponivel: payload.facultativa_disponivel || payload.margem_emprestimo_disponivel || '',
      margem_cartao_total: payload.cartao_margem_consignavel || payload.margem_cartao_total || '',
      margem_cartao_disponivel: payload.cartao_disponivel || payload.margem_cartao_disponivel || '',
      cartao_beneficio_total: payload.cartao_beneficio_margem_consignavel || '',
      cartao_beneficio_disponivel: payload.cartao_beneficio_disponivel || '',
    },
  };
  const normalized = normalizeRibeiraoQueryResult(enrichedRaw, cpf, null, userId, clientMatches);
  const identity = sanitizeAndMergeIdentity(
    {
      nome: normalized.nome || payload.nome_portal || '',
      matricula: normalized.matricula || payload.matricula || '',
      orgao: normalized.orgao || payload.orgao || payload.entidade || '',
      cargo: normalized.cargo || payload.cargo || '',
      vinculo: normalized.vinculo || payload.vinculo || '',
    },
    sourceRecord || {}
  );
  const createdAt = nowIso();
  const result = database
    .prepare(
      `
        INSERT INTO ribeirao_margin_queries (
          batch_id,
          user_id,
          session_id,
          client_id,
          base_id,
          cpf,
          cpf_masked,
          nome,
          matricula,
          orgao,
          cargo,
          vinculo,
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
        ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      batchId,
      userId,
      baseId,
      normalized.cpf,
      formatCpfDisplay(normalized.cpf),
      identity.nome || '',
      identity.matricula || '',
      identity.orgao || '',
      identity.cargo || '',
      identity.vinculo || '',
      normalized.consultaStatus,
      normalized.mensagem || '',
      bestAmapa.product || normalized.best_product_type || '',
      bestAmapa.value ?? normalized.best_net_margin,
      normalized.margem_emprestimo_total ?? null,
      normalized.margem_emprestimo_disponivel ?? null,
      normalized.margem_cartao_total ?? null,
      normalized.margem_cartao_disponivel ?? null,
      normalized.raw_result_json,
      createdAt
    );

  const queryId = Number(result?.lastInsertRowid || 0);
  const query = queryId ? getRibeiraoHistoryById(queryId) : null;
  return {
    query,
    client_matches: clientMatches,
    standardized: normalized,
  };
}

async function querySantanaCpfForBatch({
  batchId,
  userId,
  cpf,
  login,
  password,
  sourceRecord = {},
  baseId = null,
  portalId = 'prefeitura_santana_parnaiba',
}) {
  const database = getDb();
  const clientMatches = findClientsByCpf(cpf).filter(Boolean);
  const hasApiEndpoint = Boolean(String(process.env.SANTANA_RF1_API_URL || '').trim());
  const portalLabel = portalId === 'prefeitura_ananindeua' ? 'Prefeitura de Ananindeua' : 'Prefeitura de Santana de Parnaíba';
  const captchaContext = {
    portal: portalId,
    portalLabel,
    batchId,
    cpf,
    userId,
    captchaType: 'recaptcha_v2',
  };
  const rawResult = hasApiEndpoint
    ? await runSantanaCommand(
        {
          action: 'query',
          batch_id: batchId,
          cpf,
          login,
          password,
          timeout_ms: Number(process.env.SANTANA_RF1_QUERY_TIMEOUT_MS || 30000),
        },
        { timeoutMs: Number(process.env.SANTANA_RF1_QUERY_TIMEOUT_TOTAL_MS || 180000) }
      )
    : await runSantanaWebCommand(
        {
          action: 'query',
          batch_id: batchId,
          cpf,
          login,
          password,
          headless: true,
          timeout_ms: Number(process.env.SANTANA_WEB_QUERY_TIMEOUT_MS || 45000),
          captcha_context: captchaContext,
        },
        {
          timeoutMs: Number(process.env.SANTANA_WEB_QUERY_TIMEOUT_TOTAL_MS || 300000),
          env: getCaptchaRuntimeEnv(captchaContext),
        }
      );

  const captchaMeta = rawResult?.payload_extra?.captcha_engine || null;
  if (captchaMeta?.status) {
    registerUsageLog({
      ...captchaContext,
      provider: captchaMeta.provider || 'CAPSOLVER',
      status: captchaMeta.status,
      taskId: captchaMeta.task_id || captchaMeta.taskId || '',
      errorCode: captchaMeta.code || '',
      errorMessage: captchaMeta.message || '',
      durationMs: captchaMeta.duration_ms || captchaMeta.durationMs || null,
    });
  }

  if (String(rawResult?.status || '').toLowerCase().includes('captcha')) {
    markManualRequired(captchaContext, rawResult?.detalhe_erro || rawResult?.message || `${portalLabel} aguardando validação manual de CAPTCHA.`);
    const error = new Error(rawResult?.detalhe_erro || rawResult?.message || 'Portal Santana aguardando reCAPTCHA.');
    error.code = 'CAPTCHA_REQUIRED';
    throw error;
  }

  const payload = rawResult?.payload_extra || {};
  const detailText = String(rawResult?.detalhe_erro || rawResult?.message || '').toLowerCase();
  const normalizedStatus = /cpf.*(nao|não).*encontrado|nao encontrado|não encontrado|sem uuid|sem resultado/.test(detailText)
    ? 'not_found'
    : rawResult?.status;
  const enrichedRaw = {
    ...(rawResult || {}),
    status: normalizedStatus,
    payload_extra: {
      ...payload,
      margem_emprestimo_total: payload.margem_emprestimo_total || '',
      margem_emprestimo_disponivel: payload.margem_emprestimo_disponivel || payload.margem_desconto_consignado || '',
      margem_cartao_total: payload.margem_cartao_total || '',
      margem_cartao_disponivel: payload.margem_cartao_disponivel || payload.margem_cartao_credito || '',
      cartao_beneficio_disponivel: payload.cartao_beneficio_disponivel || payload.margem_cartao_beneficio || '',
    },
  };
  const normalized = normalizeRibeiraoQueryResult(enrichedRaw, cpf, null, userId, clientMatches);
  const cartaoBeneficio = parseMoney(enrichedRaw.payload_extra.cartao_beneficio_disponivel);
  const bestSantana = [
    { product: normalized.best_product_type || '', value: normalized.best_net_margin },
    { product: 'cartao_beneficio', value: cartaoBeneficio },
  ]
    .filter((item) => item.value !== null && item.value !== undefined && !Number.isNaN(Number(item.value)))
    .reduce(
      (best, item) => (best.value === null || Number(item.value) > Number(best.value) ? item : best),
      { product: '', value: null }
    );
  const identity = sanitizeAndMergeIdentity(
    {
      nome: normalized.nome || payload.nome_portal || '',
      matricula: normalized.matricula || payload.matricula || '',
      orgao: normalized.orgao || payload.orgao || payload.secretaria || '',
      cargo: normalized.cargo || payload.cargo || '',
      vinculo: normalized.vinculo || payload.vinculo || '',
    },
    sourceRecord || {}
  );
  const createdAt = nowIso();
  const result = database
    .prepare(
      `
        INSERT INTO ribeirao_margin_queries (
          batch_id,
          user_id,
          session_id,
          client_id,
          base_id,
          cpf,
          cpf_masked,
          nome,
          matricula,
          orgao,
          cargo,
          vinculo,
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
        ) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      batchId,
      userId,
      baseId,
      normalized.cpf,
      formatCpfDisplay(normalized.cpf),
      identity.nome || '',
      identity.matricula || '',
      identity.orgao || '',
      identity.cargo || '',
      identity.vinculo || '',
      normalized.consultaStatus,
      normalized.mensagem || '',
      bestSantana.product || normalized.best_product_type || '',
      bestSantana.value ?? normalized.best_net_margin,
      normalized.margem_emprestimo_total ?? null,
      normalized.margem_emprestimo_disponivel ?? null,
      normalized.margem_cartao_total ?? null,
      normalized.margem_cartao_disponivel ?? null,
      normalized.raw_result_json,
      createdAt
    );

  const queryId = Number(result?.lastInsertRowid || 0);
  const query = queryId ? getRibeiraoHistoryById(queryId) : null;
  return {
    query,
    client_matches: clientMatches,
    standardized: normalized,
  };
}

async function processBatch(batchId, {
  userId,
  sessionId,
  credentialId,
  login,
  password,
  credentialProfile,
  cpfEntries,
  sourceType,
  baseId,
  sourceFileName,
  delaySecondsMin,
  delaySecondsMax,
  portalId = 'prefeitura_ribeirao_preto',
}) {
  const control = getBatchControl(batchId);
  const normalizedBaseId = normalizeBatchBaseId(baseId);
  if (control.running) {
    return getRibeiraoBatchById(batchId);
  }

  control.running = true;
  control.paused = false;
  control.cancelled = false;
  control.waitingCaptcha = false;

  try {
    updateRibeiraoBatchRecord(batchId, {
      status: 'em_andamento',
      started_at: nowIso(),
      finished_at: null,
      result_file_path: '',
      result_file_format: '',
      error_message: '',
      source_type: sourceType,
      source_file_name: sourceFileName || '',
      portal_id: portalId,
      base_id: normalizedBaseId,
      user_id: userId,
    });

    for (let index = 0; index < cpfEntries.length; index += 1) {
      const entry = cpfEntries[index] || {};
      const cpf = cleanDigits(String(entry.cpf || ''));
      const sourceRecord = normalizeBatchSourceRecord(entry.source || entry);
      if (!cpf) {
        continue;
      }
      console.log(`[RIBEIRAO_BATCH] iniciando CPF mascarado: ${maskBatchCpfLog(cpf)}`);

      const sessionGate = portalId === 'prefeitura_ribeirao_preto'
        ? getRibeiraoSessionGate(sessionId)
        : { success: true };
      if (!sessionGate.success) {
        const gateCode = String(sessionGate.code || 'NO_ACTIVE_SESSION');
        if (gateCode === 'MANUAL_AUTH_REQUIRED' || gateCode === 'CAPTCHA_REQUIRED') {
          updateBatchCounts(batchId, { processed_count: 0 }, 'aguardando_captcha');
          control.paused = true;
          control.waitingCaptcha = true;
          updateRibeiraoBatchRecord(batchId, {
            status: 'aguardando_captcha',
          });
          const canContinueAfterCaptcha = await waitUntilResumed(batchId);
          control.waitingCaptcha = false;
          if (!canContinueAfterCaptcha) {
            if (control.cancelled) {
              return finalizeBatch(batchId, 'cancelado');
            }
            return getRibeiraoBatchById(batchId);
          }
          continue;
        }

        if (gateCode === 'SESSION_EXPIRED' || gateCode === 'NO_ACTIVE_SESSION') {
          updateRibeiraoBatchRecord(batchId, {
            status: 'pausado_sessao_expirada',
            finished_at: null,
          });
          control.paused = true;
          return getRibeiraoBatchById(batchId);
        }

        updateBatchCounts(batchId, { processed_count: 0, error_count: 1 }, 'erro');
        return finalizeBatch(batchId, 'erro', { errorMessage: sessionGate.message || 'Falha ao validar sessão ativa.' });
      }

      const latestBatch = getRibeiraoBatchById(batchId);
      if (!latestBatch) {
        return null;
      }

      if (control.cancelled || latestBatch.status === 'cancelado') {
        return finalizeBatch(batchId, 'cancelado');
      }

      const canProceed = await waitUntilResumed(batchId);
      if (!canProceed) {
        if (control.cancelled) {
          return finalizeBatch(batchId, 'cancelado');
        }
        return getRibeiraoBatchById(batchId);
      }

      let queryResult;
      try {
        queryResult = portalId === 'governo_amapa'
          ? await queryAmapaCpfForBatch({
              batchId,
              userId,
              cpf,
              login,
              password,
              sourceRecord,
              baseId: normalizedBaseId,
            })
          : ['prefeitura_santana_parnaiba', 'prefeitura_ananindeua'].includes(portalId)
            ? await querySantanaCpfForBatch({
                batchId,
                userId,
                cpf,
                login,
                password,
                sourceRecord,
                baseId: normalizedBaseId,
                portalId,
              })
          : await queryRibeiraoCpf({
              userId,
              sessionId,
              cpf,
              login,
              password,
              credentialProfile,
              clientId: null,
              baseId: normalizedBaseId,
            });
      } catch (error) {
        const errorCode = String(error?.code || '').toUpperCase();
        const errorMessage = error instanceof Error ? error.message : String(error || 'Erro tecnico na consulta.');
        const isTimeout =
          errorCode === 'RIBEIRAO_QUERY_TIMEOUT' ||
          /tempo limite excedido|timeout/i.test(errorMessage);
        if (isTimeout) {
          saveBatchCpfTechnicalError(batchId, {
            userId,
            sessionId,
            cpf,
            sourceRecord,
            baseId: normalizedBaseId,
            message: 'Tempo limite excedido na consulta deste CPF. O lote continuou para o proximo CPF.',
            code: 'RIBEIRAO_QUERY_TIMEOUT',
          });
          updateBatchCounts(batchId, { processed_count: 1, error_count: 1 }, 'em_andamento');
          console.log(`[RIBEIRAO_BATCH] status final do CPF: timeout`);
          if (index < cpfEntries.length - 1) {
            await sleep(randomDelay(delaySecondsMin, delaySecondsMax));
          }
          continue;
        }
        if (errorCode === 'MANUAL_AUTH_REQUIRED' || errorCode === 'CAPTCHA_REQUIRED') {
          updateBatchCounts(batchId, { processed_count: 0, captcha_count: 1 }, 'aguardando_captcha');
          control.paused = true;
          control.waitingCaptcha = true;
          updateRibeiraoBatchRecord(batchId, { status: 'aguardando_captcha' });
          const canContinueAfterCaptcha = await waitUntilResumed(batchId);
          control.waitingCaptcha = false;
          if (!canContinueAfterCaptcha) {
            if (control.cancelled) {
              return finalizeBatch(batchId, 'cancelado');
            }
            return getRibeiraoBatchById(batchId);
          }
          continue;
        }

        if (errorCode === 'SESSION_EXPIRED' || errorCode === 'NO_ACTIVE_SESSION') {
          updateRibeiraoBatchRecord(batchId, {
            status: 'pausado_sessao_expirada',
            finished_at: null,
          });
          control.paused = true;
          return getRibeiraoBatchById(batchId);
        }

        if (errorCode === 'LOGIN_ERROR' || errorCode === 'PORTAL_UNAVAILABLE') {
          updateBatchCounts(batchId, { processed_count: 1, error_count: 1 }, 'erro');
          return finalizeBatch(batchId, 'erro', { errorMessage: error?.message || String(errorCode || 'Falha na autenticação do portal.') });
        }

        throw error;
      }

      const standardized = queryResult.standardized;
      let query = queryResult.query;
      let queryId = Number(query?.id || 0);
      if (!queryId) {
        const database = getDb();
        const recoveredQuery = one(
          database,
          `
            SELECT *
            FROM ribeirao_margin_queries
            WHERE user_id = ?
              AND session_id = ?
              AND cpf = ?
            ORDER BY id DESC
            LIMIT 1
          `,
          [userId, sessionId, cpf]
        );
        if (recoveredQuery?.id) {
          query = recoveredQuery;
          queryId = Number(recoveredQuery.id);
        }
      }
      console.log(
        `[RIBEIRAO_BATCH] resultado parseado: ${JSON.stringify({
          cpf: query?.cpf_masked || maskBatchCpfLog(cpf),
          status: standardized.consultaStatus,
          margem_emprestimo_total: standardized.margem_emprestimo_total ?? null,
          margem_emprestimo_disponivel: standardized.margem_emprestimo_disponivel ?? null,
          margem_cartao_total: standardized.margem_cartao_total ?? null,
          margem_cartao_disponivel: standardized.margem_cartao_disponivel ?? null,
        })}`
      );
      if (queryId) {
        const database = getDb();
        database
          .prepare('UPDATE ribeirao_margin_queries SET batch_id = ? WHERE id = ?')
          .run(batchId, queryId);

        const rowAfterQuery = one(
          database,
          `
            SELECT id, nome, matricula, orgao, cargo, vinculo
            FROM ribeirao_margin_queries
            WHERE id = ?
            LIMIT 1
          `,
          [queryId]
        );

        const mergedIdentity = sanitizeAndMergeIdentity(rowAfterQuery || {}, sourceRecord);
        const changed =
          String(rowAfterQuery?.nome || '') !== mergedIdentity.nome ||
          String(rowAfterQuery?.matricula || '') !== mergedIdentity.matricula ||
          String(rowAfterQuery?.orgao || '') !== mergedIdentity.orgao ||
          String(rowAfterQuery?.cargo || '') !== mergedIdentity.cargo ||
          String(rowAfterQuery?.vinculo || '') !== mergedIdentity.vinculo;

        if (changed) {
          database
            .prepare(
              `
                UPDATE ribeirao_margin_queries
                SET nome = ?, matricula = ?, orgao = ?, cargo = ?, vinculo = ?
                WHERE id = ?
              `
            )
            .run(
              mergedIdentity.nome,
              mergedIdentity.matricula,
              mergedIdentity.orgao,
              mergedIdentity.cargo,
              mergedIdentity.vinculo,
              queryId
            );
        }
      }

      const matchedClient = Array.isArray(queryResult.client_matches)
        ? queryResult.client_matches.find((match) => {
            const candidateBaseId = match.base_id === null || match.base_id === undefined ? null : Number(match.base_id);
            return normalizedBaseId !== null ? candidateBaseId === normalizedBaseId : true;
          })
        : null;

      if (matchedClient && queryId) {
        applyRibeiraoResultToClient({
          queryId,
          clientId: matchedClient.id,
          baseId: matchedClient.base_id || normalizedBaseId || null,
          userId,
        });
      }

      const status = standardized.consultaStatus;
      if (status === RIBEIRAO_QUERY_STATUSES.CAPTCHA_REQUIRED) {
        updateBatchCounts(batchId, { processed_count: 1, captcha_count: 1 }, 'aguardando_captcha');
        control.paused = true;
        control.waitingCaptcha = true;
        updateRibeiraoBatchRecord(batchId, { status: 'aguardando_captcha' });
        console.log(`[RIBEIRAO_BATCH] status final do CPF: ${status}`);
        const canContinueAfterCaptcha = await waitUntilResumed(batchId);
        control.waitingCaptcha = false;
        if (!canContinueAfterCaptcha) {
          if (control.cancelled) {
            return finalizeBatch(batchId, 'cancelado');
          }
          return getRibeiraoBatchById(batchId);
        }
        continue;
      }

      if (status === RIBEIRAO_QUERY_STATUSES.LOGIN_ERROR || status === RIBEIRAO_QUERY_STATUSES.SESSION_EXPIRED) {
        updateBatchCounts(batchId, { processed_count: 1, error_count: 1 }, 'erro');
        console.log(`[RIBEIRAO_BATCH] status final do CPF: ${status}`);
        return finalizeBatch(batchId, 'erro', {
          errorMessage: standardized.mensagem || 'Falha de sessão/autenticação no portal durante o lote.',
        });
      }

      if (status === RIBEIRAO_QUERY_STATUSES.NOT_FOUND) {
        updateBatchCounts(batchId, { processed_count: 1, not_found_count: 1 }, 'em_andamento');
      } else if (status === RIBEIRAO_QUERY_STATUSES.WITH_MARGIN) {
        updateBatchCounts(batchId, { processed_count: 1, success_count: 1 }, 'em_andamento');
      } else if (status === RIBEIRAO_QUERY_STATUSES.WITHOUT_MARGIN) {
        updateBatchCounts(batchId, { processed_count: 1, no_margin_count: 1 }, 'em_andamento');
      } else {
        updateBatchCounts(batchId, { processed_count: 1, error_count: 1 }, 'em_andamento');
      }
      console.log(`[RIBEIRAO_BATCH] status final do CPF: ${status}`);

      if (index < cpfEntries.length - 1) {
        await sleep(randomDelay(delaySecondsMin, delaySecondsMax));
      }
    }

    return finalizeBatch(batchId, control.cancelled ? 'cancelado' : 'concluido', {
      forceResultFile: true,
      processedCount: getRibeiraoBatchById(batchId)?.total_cpfs || cpfEntries.length,
    });
  } catch (error) {
    finalizeBatch(batchId, 'erro', {
      errorMessage: error instanceof Error ? error.message : String(error || 'Erro inesperado no processamento do lote.'),
    });
    throw error;
  } finally {
    control.running = false;
  }
}

export async function startRibeiraoBatch({
  userId,
  sessionId,
  login,
  password,
  portalId = 'prefeitura_ribeirao_preto',
  sourceType = 'upload',
  sourceFileName = '',
  cpfs = [],
  cpfEntries = [],
  baseId = null,
  delaySecondsMin = 3,
  delaySecondsMax = 8,
}) {
  const normalizedPortalId = String(portalId || 'prefeitura_ribeirao_preto');
  if (!['prefeitura_ribeirao_preto', 'governo_amapa', 'prefeitura_santana_parnaiba', 'prefeitura_ananindeua'].includes(normalizedPortalId)) {
    const error = new Error('Fonte ainda não implementada para consulta em lote.');
    error.code = 'SOURCE_NOT_IMPLEMENTED';
    throw error;
  }
  const sessionGate = normalizedPortalId === 'prefeitura_ribeirao_preto'
    ? getRibeiraoSessionGate(sessionId)
    : { success: true };
  if (!sessionGate.success) {
    const error = new Error(sessionGate.message);
    error.code = sessionGate.code;
    throw error;
  }

  const sourceEntriesRaw = Array.isArray(cpfEntries) && cpfEntries.length
    ? cpfEntries
    : (cpfs || []).map((value) => ({ cpf: value }));

  const seen = new Set();
  const normalizedEntries = sourceEntriesRaw
    .map((item) => {
      const normalized = normalizeBatchSourceRecord(item);
      return {
        cpf: normalized.cpf,
        source: normalized,
      };
    })
    .filter((item) => item.cpf.length === 11)
    .filter((item) => {
      if (seen.has(item.cpf)) return false;
      seen.add(item.cpf);
      return true;
    });

  const totalCpfs = normalizedEntries.length;
  const normalizedBaseId = normalizeBatchBaseId(baseId);
  const batch = createRibeiraoBatchRecord({
    userId,
    baseId: normalizedBaseId,
    portalId: normalizedPortalId,
    sourceType,
    sourceFileName,
    totalCpfs,
  });

  if (!batch) {
    throw new Error('Nao foi possivel criar o lote.');
  }

  const batchId = batch.id;
  persistBatchEntries(batchId, normalizedEntries);
  activeBatchJobs.set(batchId, { paused: false, cancelled: false, running: false, waitingCaptcha: false });

  void processBatch(batchId, {
    userId,
    sessionId,
    login,
    password,
    cpfEntries: normalizedEntries,
    sourceType,
    baseId: normalizedBaseId,
    sourceFileName,
    delaySecondsMin,
    delaySecondsMax,
    portalId: normalizedPortalId,
  }).catch((error) => {
    console.error('[RIBEIRAO_BATCH] erro no processamento em segundo plano:', error);
  });
  return getRibeiraoBatchById(batchId);
}

export function getRibeiraoBatchStatus(batchId) {
  return getRibeiraoBatchById(batchId);
}

export function pauseRibeiraoBatch(batchId) {
  const control = getBatchControl(batchId);
  control.paused = true;
  updateRibeiraoBatchRecord(batchId, { status: 'pausado' });
  return getRibeiraoBatchById(batchId);
}

export function resumeRibeiraoBatch(batchId) {
  const control = getBatchControl(batchId);
  const batch = getRibeiraoBatchById(batchId);
  if (!batch) {
    return null;
  }

  control.paused = false;
  control.waitingCaptcha = false;

  if (control.running) {
    updateRibeiraoBatchRecord(batchId, { status: 'em_andamento' });
    return getRibeiraoBatchById(batchId);
  }

  clearBatchCaptchaPlaceholders(batchId);
  const pendingEntries = listPendingBatchEntries(batchId);
  if (!pendingEntries.length) {
    return finalizeBatch(batchId, 'concluido', {
      forceResultFile: true,
      processedCount: batch.total_cpfs,
    });
  }

  const userId = Number(batch.user_id || 1);
  const portalId = String(batch.portal_id || 'prefeitura_ribeirao_preto');
  const sessionId = portalId === 'prefeitura_ribeirao_preto' ? getLatestConnectedSessionId(userId) : null;
  const gate = portalId === 'prefeitura_ribeirao_preto'
    ? (sessionId ? getRibeiraoSessionGate(sessionId) : { success: false, message: 'Sessao nao conectada.' })
    : { success: true };
  if (!gate.success) {
    updateRibeiraoBatchRecord(batchId, {
      status: 'pausado_sessao_expirada',
      error_message: gate.message || 'Sessão expirada. Reconecte a credencial antes de continuar.',
    });
    return getRibeiraoBatchById(batchId);
  }

  const credentialSecret = getCredentialSecretByPortal(portalId);
  const login = String(credentialSecret?.login || '').trim();
  const password = String(credentialSecret?.password || '').trim();
  const credentialProfile = credentialSecret?.credential_profile || null;
  if (!login || !password) {
    updateRibeiraoBatchRecord(batchId, {
      status: 'pausado_sessao_expirada',
      error_message: 'Credencial de Ribeirão não configurada. Configure a credencial antes de continuar.',
    });
    return getRibeiraoBatchById(batchId);
  }

  updateRibeiraoBatchRecord(batchId, {
    status: 'em_andamento',
    finished_at: null,
    error_message: '',
  });

  void processBatch(batchId, {
    userId,
    sessionId,
    login,
    password,
    credentialProfile,
    cpfEntries: pendingEntries,
    sourceType: batch.source_type || 'upload',
    baseId: batch.base_id || null,
    sourceFileName: batch.source_file_name || '',
    delaySecondsMin: 3,
    delaySecondsMax: 8,
    portalId,
  }).catch((error) => {
    console.error('[RIBEIRAO_BATCH] erro ao continuar lote em segundo plano:', error);
  });

  return getRibeiraoBatchById(batchId);
}

export function resumeRibeiraoBatchWithEntries(batchId, options = {}) {
  const {
    userId = 1,
    sessionId,
    login = '',
    password = '',
    credentialProfile = null,
    cpfEntries = [],
    sourceType = 'upload',
    sourceFileName = '',
    baseId = null,
    delaySecondsMin = 3,
    delaySecondsMax = 8,
    portalId = 'prefeitura_ribeirao_preto',
  } = options;

  const control = getBatchControl(batchId);
  if (control.running) {
    return getRibeiraoBatchById(batchId);
  }

  control.paused = false;
  control.cancelled = false;
  control.waitingCaptcha = false;

  void processBatch(batchId, {
    userId,
    sessionId,
    login,
    password,
    credentialProfile,
    cpfEntries,
    sourceType,
    baseId,
    sourceFileName,
    delaySecondsMin,
    delaySecondsMax,
    portalId,
  }).catch((error) => {
    console.error('[RIBEIRAO_BATCH] erro ao retomar lote em segundo plano:', error);
  });

  return getRibeiraoBatchById(batchId);
}

export function cancelRibeiraoBatch(batchId) {
  const control = getBatchControl(batchId);
  control.paused = false;
  control.cancelled = true;
  control.waitingCaptcha = false;
  return finalizeBatch(batchId, 'cancelado');
}

export function getRibeiraoBatchHistory(filters = {}) {
  return listRibeiraoBatches(filters);
}

export function getRibeiraoBatchResults(batchId) {
  return listRibeiraoBatchResults(batchId).map((row) => mapBatchRow(row));
}

function buildRibeiraoBatchExportRows(batchId) {
  const batch = getRibeiraoBatchById(batchId);
  const portalLabel = getBatchPortalLabel(batch);
  const rows = getRibeiraoBatchResults(batchId);
  const marginByProduct = (row, productType) => row.margins?.find((margin) => margin.product_type === productType) || null;
  const cleanForExport = (value) => cleanIdentityField(value, { allowColon: false });
  return rows.map((row) => ({
    portal: portalLabel,
    lote: batch?.id || Number(batchId),
    cpf: row.cpf || '',
    nome: cleanForExport(row.nome),
    matricula: cleanForExport(row.matricula),
    orgao: cleanForExport(row.orgao),
    cargo: cleanForExport(row.cargo),
    vinculo: cleanForExport(row.vinculo),
    base: row.base_name || '',
    client_id: row.client_id || '',
    status: row.consulta_status_label || row.consulta_status || '',
    mensagem: row.mensagem || '',
    margem_emprestimo_total: formatMoney(row.margem_emprestimo_total ?? marginByProduct(row, 'credito')?.gross_margin ?? row.margem_consignavel_bruta),
    margem_emprestimo_disponivel: formatMoney(row.margem_emprestimo_disponivel ?? marginByProduct(row, 'credito')?.net_margin ?? row.margem_consignavel_liquida),
    margem_cartao_total: formatMoney(row.margem_cartao_total ?? marginByProduct(row, 'cartao')?.gross_margin ?? row.margem_cartao_bruta),
    margem_cartao_disponivel: formatMoney(row.margem_cartao_disponivel ?? marginByProduct(row, 'cartao')?.net_margin ?? row.margem_cartao_liquida),
    melhor_produto: row.best_product_type || '',
    melhor_margem_liquida: formatMoney(row.best_net_margin),
    data_hora: row.created_at_formatted || row.created_at || '',
  }));
}

export function exportRibeiraoBatchResultsCsv(batchId) {
  const rows = buildRibeiraoBatchExportRows(batchId);
  const header = [
    'Portal',
    'Lote',
    'CPF',
    'Nome',
    'Matricula',
    'Orgao',
    'Cargo',
    'Vinculo',
    'Base',
    'Cliente ID',
    'Status',
    'Mensagem',
    'Margem Emprestimo Total',
    'Margem Emprestimo Disponivel',
    'Margem Cartao Total',
    'Margem Cartao Disponivel',
    'Melhor produto',
    'Melhor margem liquida',
    'Data/hora',
  ];

  const escapeCsv = (value) => {
    const text = String(value ?? '');
    if (/[;\n"]/g.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const lines = [
    '\ufeff' + header.map(escapeCsv).join(';'),
    ...rows.map((row) =>
      [
        row.portal,
        row.lote,
        row.cpf,
        row.nome,
        row.matricula,
        row.orgao,
        row.cargo,
        row.vinculo,
        row.base,
        row.client_id,
        row.status,
        row.mensagem,
        row.margem_emprestimo_total,
        row.margem_emprestimo_disponivel,
        row.margem_cartao_total,
        row.margem_cartao_disponivel,
        row.melhor_produto,
        row.melhor_margem_liquida,
        row.data_hora,
      ]
        .map(escapeCsv)
        .join(';')
    ),
  ];

  return lines.join('\n');
}

export function exportRibeiraoBatchResultsXlsx(batchId) {
  const batch = getRibeiraoBatchById(batchId);
  const rows = buildRibeiraoBatchExportRows(batchId);
  const header = [
    'Portal',
    'Lote',
    'CPF',
    'Nome',
    'Matricula',
    'Orgao',
    'Cargo',
    'Vinculo',
    'Base',
    'Cliente ID',
    'Status',
    'Mensagem',
    'Margem Emprestimo Total',
    'Margem Emprestimo Disponivel',
    'Margem Cartao Total',
    'Margem Cartao Disponivel',
    'Melhor produto',
    'Melhor margem liquida',
    'Data/hora',
  ];
  const worksheet = XLSX.utils.aoa_to_sheet([header, ...rows.map((row) => [
    row.portal,
    row.lote,
    row.cpf,
    row.nome,
    row.matricula,
    row.orgao,
    row.cargo,
    row.vinculo,
    row.base,
    row.client_id,
    row.status,
    row.mensagem,
    row.margem_emprestimo_total,
    row.margem_emprestimo_disponivel,
    row.margem_cartao_total,
    row.margem_cartao_disponivel,
    row.melhor_produto,
    row.melhor_margem_liquida,
    row.data_hora,
  ])]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeWorksheetName(getBatchPortalLabel(batch)));
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
}

export function getRibeiraoBatchResultDownloadInfo(batchId) {
  const batch = getRibeiraoBatchById(batchId);
  if (!batch) {
    return { batch: null, reason: 'BATCH_NOT_FOUND' };
  }

  const processedCount = Number(batch.processed_count || 0);
  if (processedCount <= 0) {
    return { batch, reason: 'BATCH_WITHOUT_RESULTS' };
  }

  return {
    batch,
    reason: null,
    buffer: exportRibeiraoBatchResultsXlsx(batchId),
    filename: buildBatchDownloadFileName(batch, 'xlsx'),
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}
