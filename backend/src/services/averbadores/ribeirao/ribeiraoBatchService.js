import {
  createRibeiraoBatchRecord,
  getDb,
  getRibeiraoBatchById,
  listRibeiraoBatchResults,
  listRibeiraoBatches,
  updateRibeiraoBatchRecord,
} from '../../../db.js';
import {
  cleanDigits,
  formatCpfDisplay,
  formatMoney,
  getWorksheetHeaders,
  matchColumn,
  normalizeCpfValue,
  normalizeHeaderKey,
  readSpreadsheetRows,
} from '../../../utils.js';
import * as XLSX from 'xlsx';
import {
  applyRibeiraoResultToClient,
  findClientsByCpf,
  getRibeiraoHistoryById,
  getRibeiraoSessionGate,
  queryRibeiraoCpf,
} from './ribeiraoService.js';
import { RIBEIRAO_QUERY_STATUSES } from './ribeiraoTypes.js';

const activeBatchJobs = new Map();

function nowIso() {
  return new Date().toISOString();
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

function normalizeBatchCpf(value) {
  const digits = cleanDigits(String(value || ''));
  if (!digits) {
    return '';
  }
  if (digits.length < 11) {
    return digits.padStart(11, '0');
  }
  return digits;
}

function parseStoredBatchCpfs(batch) {
  try {
    const items = JSON.parse(String(batch?.cpf_list_json || '[]'));
    if (!Array.isArray(items)) {
      return [];
    }
    return Array.from(new Set(items.map((value) => normalizeBatchCpf(value)).filter((value) => value.length === 11)));
  } catch {
    return [];
  }
}

function getProcessedBatchCpfs(batchId) {
  return new Set(
    listRibeiraoBatchResults(batchId)
      .map((row) => normalizeBatchCpf(row.cpf))
      .filter((value) => value.length === 11)
  );
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

function extractNameColumn(headers) {
  const column = matchColumn(headers, ['nome', 'name', 'cliente', 'servidor', 'beneficiario']);
  if (column) {
    return column;
  }

  return headers.find((header) => {
    const norm = normalizeHeaderKey(header);
    return norm.includes('nome') || norm.includes('cliente') || norm.includes('servidor') || norm.includes('beneficiario');
  }) || '';
}

export function previewRibeiraoBatchSpreadsheet(buffer, filename) {
  const rows = readSpreadsheetRows(buffer, filename);
  const headers = getWorksheetHeaders(rows);
  const cpfColumn = extractCpfColumn(headers);
  const nameColumn = extractNameColumn(headers);

  const previewRows = rows.map((row, index) => {
    const source = normalizeCpfSource(cpfColumn ? row[cpfColumn] : Object.values(row || {})[0]);
    const name = String(nameColumn ? row[nameColumn] || '' : row.nome || row.Nome || '').trim();
    return {
      rowNumber: index + 2,
      cpf: source.cpf,
      cpf_display: source.cpf_display,
      name,
      raw_value: String(source.raw ?? ''),
      isValid: source.isValid,
      alerts: source.alerts,
    };
  });

  return {
    headers,
    cpf_column: cpfColumn,
    name_column: nameColumn,
    total_rows: previewRows.length,
    valid_rows: previewRows.filter((row) => row.isValid).length,
    invalid_rows: previewRows.filter((row) => !row.isValid).length,
    preview_rows: previewRows.slice(0, 100),
    cpfs: previewRows.filter((row) => row.isValid).map((row) => row.cpf),
    clients: previewRows
      .filter((row) => row.isValid)
      .map((row) => ({
        cpf: row.cpf,
        cpf_display: row.cpf_display,
        name: row.name || `Cliente ${row.cpf_display}`,
      })),
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
  return {
    ...history,
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

async function processBatch(batchId, {
  userId,
  sessionId,
  credentialId,
  login,
  password,
  portalId,
  cpfs,
  sourceType,
  baseId,
  sourceFileName,
  delaySecondsMin,
  delaySecondsMax,
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
      source_type: sourceType,
      source_file_name: sourceFileName || '',
      base_id: normalizedBaseId,
      user_id: userId,
    });

    for (let index = 0; index < cpfs.length; index += 1) {
      const cpf = cpfs[index];
      if (!cpf) {
        continue;
      }
      console.log(`[RIBEIRAO_BATCH] iniciando CPF mascarado: ${maskBatchCpfLog(cpf)}`);

      const sessionGate = getRibeiraoSessionGate(sessionId);
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
              updateRibeiraoBatchRecord(batchId, { status: 'cancelado', finished_at: nowIso() });
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
        updateRibeiraoBatchRecord(batchId, {
          status: 'erro',
          finished_at: nowIso(),
        });
        return getRibeiraoBatchById(batchId);
      }

      const latestBatch = getRibeiraoBatchById(batchId);
      if (!latestBatch) {
        return null;
      }

      if (control.cancelled || latestBatch.status === 'cancelado') {
        updateRibeiraoBatchRecord(batchId, {
          status: 'cancelado',
          finished_at: nowIso(),
        });
        return getRibeiraoBatchById(batchId);
      }

      const canProceed = await waitUntilResumed(batchId);
      if (!canProceed) {
        if (control.cancelled) {
          updateRibeiraoBatchRecord(batchId, { status: 'cancelado', finished_at: nowIso() });
        }
        return getRibeiraoBatchById(batchId);
      }

      let queryResult;
      try {
        queryResult = await queryRibeiraoCpf({
          userId,
          sessionId,
          credentialId,
          cpf,
          login,
          password,
          portalId,
          clientId: null,
          baseId: normalizedBaseId,
        });
      } catch (error) {
        const errorCode = String(error?.code || '').toUpperCase();
        if (errorCode === 'MANUAL_AUTH_REQUIRED' || errorCode === 'CAPTCHA_REQUIRED') {
          updateBatchCounts(batchId, { processed_count: 0, captcha_count: 1 }, 'aguardando_captcha');
          control.paused = true;
          control.waitingCaptcha = true;
          updateRibeiraoBatchRecord(batchId, { status: 'aguardando_captcha' });
          const canContinueAfterCaptcha = await waitUntilResumed(batchId);
          control.waitingCaptcha = false;
          if (!canContinueAfterCaptcha) {
            if (control.cancelled) {
              updateRibeiraoBatchRecord(batchId, { status: 'cancelado', finished_at: nowIso() });
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
          updateRibeiraoBatchRecord(batchId, {
            status: 'erro',
            finished_at: nowIso(),
          });
          return getRibeiraoBatchById(batchId);
        }

        if (errorCode === 'DAILY_QUERY_LIMIT_REACHED') {
          updateRibeiraoBatchRecord(batchId, {
            status: 'pausado_limite_diario',
            finished_at: null,
          });
          control.paused = true;
          return getRibeiraoBatchById(batchId);
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
            updateRibeiraoBatchRecord(batchId, { status: 'cancelado', finished_at: nowIso() });
          }
          return getRibeiraoBatchById(batchId);
        }
        continue;
      }

      if (status === RIBEIRAO_QUERY_STATUSES.LOGIN_ERROR || status === RIBEIRAO_QUERY_STATUSES.SESSION_EXPIRED) {
        updateBatchCounts(batchId, { processed_count: 1, error_count: 1 }, 'erro');
        updateRibeiraoBatchRecord(batchId, {
          status: 'erro',
          finished_at: nowIso(),
        });
        console.log(`[RIBEIRAO_BATCH] status final do CPF: ${status}`);
        return getRibeiraoBatchById(batchId);
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

      if (index < cpfs.length - 1) {
        await sleep(randomDelay(delaySecondsMin, delaySecondsMax));
      }
    }

    updateRibeiraoBatchRecord(batchId, {
      status: control.cancelled ? 'cancelado' : 'concluido',
      finished_at: nowIso(),
      processed_count: getRibeiraoBatchById(batchId)?.total_cpfs || cpfs.length,
    });
    return getRibeiraoBatchById(batchId);
  } catch (error) {
    updateRibeiraoBatchRecord(batchId, {
      status: 'erro',
      finished_at: nowIso(),
    });
    throw error;
  } finally {
    control.running = false;
  }
}

export async function startRibeiraoBatch({
  userId,
  sessionId,
  credentialId = null,
  login,
  password,
  portalId = 'prefeitura_ribeirao_preto',
  sourceType = 'upload',
  sourceFileName = '',
  cpfs = [],
  baseId = null,
  delaySecondsMin = 3,
  delaySecondsMax = 8,
}) {
  const sessionGate = getRibeiraoSessionGate(sessionId);
  if (!sessionGate.success) {
    const error = new Error(sessionGate.message);
    error.code = sessionGate.code;
    throw error;
  }

  const cleanCpfs = Array.from(new Set((cpfs || []).map((value) => normalizeBatchCpf(value)).filter((value) => value.length === 11)));
  const totalCpfs = cleanCpfs.length;
  const normalizedBaseId = normalizeBatchBaseId(baseId);
  const batch = createRibeiraoBatchRecord({
    userId,
    baseId: normalizedBaseId,
    sourceType,
    sourceFileName,
    totalCpfs,
    cpfListJson: JSON.stringify(cleanCpfs),
  });

  if (!batch) {
    throw new Error('Nao foi possivel criar o lote.');
  }

  const batchId = batch.id;
  activeBatchJobs.set(batchId, { paused: false, cancelled: false, running: false, waitingCaptcha: false });

  void processBatch(batchId, {
    userId,
    sessionId,
    credentialId,
    login,
    password,
    portalId,
    cpfs: cleanCpfs,
    sourceType,
    baseId: normalizedBaseId,
    sourceFileName,
    delaySecondsMin,
    delaySecondsMax,
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

export function resumeRibeiraoBatch(batchId, options = {}) {
  const control = getBatchControl(batchId);
  control.paused = false;
  control.waitingCaptcha = false;
  updateRibeiraoBatchRecord(batchId, { status: 'em_andamento' });
  const batch = getRibeiraoBatchById(batchId);
  if (!batch || control.running) {
    return batch;
  }

  const storedCpfs = parseStoredBatchCpfs(batch);
  if (!storedCpfs.length) {
    updateRibeiraoBatchRecord(batchId, { status: 'erro', finished_at: nowIso() });
    const error = new Error('Este lote antigo nao tem a lista original de CPFs salva. Envie a base novamente para retomar com seguranca.');
    error.code = 'BATCH_CPF_LIST_NOT_FOUND';
    throw error;
  }

  const processedCpfs = getProcessedBatchCpfs(batchId);
  const remainingCpfs = storedCpfs.filter((cpf) => !processedCpfs.has(cpf));
  if (!remainingCpfs.length) {
    updateRibeiraoBatchRecord(batchId, {
      status: 'concluido',
      processed_count: batch.total_cpfs,
      finished_at: nowIso(),
    });
    return getRibeiraoBatchById(batchId);
  }

  if (!options.sessionId) {
    updateRibeiraoBatchRecord(batchId, { status: 'pausado_sessao_expirada', finished_at: null });
    const error = new Error('Conecte a credencial do portal antes de retomar o lote.');
    error.code = 'NO_ACTIVE_SESSION';
    throw error;
  }

  void processBatch(batchId, {
    userId: Number(options.userId || batch.user_id || 0),
    sessionId: Number(options.sessionId),
    credentialId: options.credentialId ? Number(options.credentialId) : null,
    login: options.login || '',
    password: options.password || '',
    portalId: options.portalId || 'prefeitura_ribeirao_preto',
    cpfs: remainingCpfs,
    sourceType: batch.source_type || 'upload',
    baseId: batch.base_id,
    sourceFileName: batch.source_file_name || '',
    delaySecondsMin: options.delaySecondsMin ?? 3,
    delaySecondsMax: options.delaySecondsMax ?? 8,
  }).catch((error) => {
    console.error('[RIBEIRAO_BATCH] erro ao retomar processamento:', error);
  });

  return getRibeiraoBatchById(batchId);
}

export function cancelRibeiraoBatch(batchId) {
  const control = getBatchControl(batchId);
  control.paused = false;
  control.cancelled = true;
  control.waitingCaptcha = false;
  updateRibeiraoBatchRecord(batchId, { status: 'cancelado', finished_at: nowIso() });
  return getRibeiraoBatchById(batchId);
}

export function getRibeiraoBatchHistory(filters = {}) {
  return listRibeiraoBatches(filters);
}

export function getRibeiraoBatchResults(batchId) {
  return listRibeiraoBatchResults(batchId).map((row) => mapBatchRow(row));
}

function buildRibeiraoBatchExportRows(batchId) {
  const rows = getRibeiraoBatchResults(batchId);
  const marginByProduct = (row, productType) => row.margins?.find((margin) => margin.product_type === productType) || null;
  return rows.map((row) => ({
    cpf: row.cpf || '',
    nome: row.nome || '',
    matricula: row.matricula || '',
    orgao: row.orgao || '',
    cargo: row.cargo || '',
    vinculo: row.vinculo || '',
    base: row.base_name || '',
    client_id: row.client_id || '',
    status: row.consulta_status_label || row.consulta_status || '',
    mensagem: row.mensagem || '',
    margem_emprestimo_total: formatMoney(row.margem_emprestimo_total ?? marginByProduct(row, 'credito')?.gross_margin ?? row.margem_consignavel_bruta),
    margem_emprestimo_disponivel: formatMoney(row.margem_emprestimo_disponivel ?? marginByProduct(row, 'credito')?.net_margin ?? row.margem_consignavel_liquida),
    margem_cartao_total: formatMoney(row.margem_cartao_total ?? marginByProduct(row, 'cartao')?.gross_margin ?? row.margem_cartao_bruta),
    margem_cartao_disponivel: formatMoney(row.margem_cartao_disponivel ?? marginByProduct(row, 'cartao')?.net_margin ?? row.margem_cartao_liquida),
    margem_cartao_beneficio_total: formatMoney(marginByProduct(row, 'cartao_beneficio')?.gross_margin),
    margem_cartao_beneficio_disponivel: formatMoney(marginByProduct(row, 'cartao_beneficio')?.net_margin),
    consignacoes_facultativas_bruta: formatMoney(
      row.margem_consignavel_bruta ?? row.margem_emprestimo_total ?? marginByProduct(row, 'consignacao')?.gross_margin ?? marginByProduct(row, 'credito')?.gross_margin
    ),
    consignacoes_facultativas_liquida: formatMoney(
      row.margem_consignavel_liquida ?? row.margem_emprestimo_disponivel ?? marginByProduct(row, 'consignacao')?.net_margin ?? marginByProduct(row, 'credito')?.net_margin
    ),
    cartao_beneficio_bruta: formatMoney(
      marginByProduct(row, 'cartao_beneficio')?.gross_margin
    ),
    cartao_beneficio_liquida: formatMoney(
      marginByProduct(row, 'cartao_beneficio')?.net_margin
    ),
    melhor_produto: row.best_product_type || '',
    melhor_margem_liquida: formatMoney(row.best_net_margin),
    data_hora: row.created_at_formatted || row.created_at || '',
  }));
}

export function exportRibeiraoBatchResultsCsv(batchId) {
  const rows = buildRibeiraoBatchExportRows(batchId);
  const header = [
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
    'Margem Cartao Beneficio Total',
    'Margem Cartao Beneficio Disponivel',
    'Consignacoes Facultativas - Margem Bruta',
    'Consignacoes Facultativas - Margem Liquida',
    'Cartao Beneficio - Margem Bruta',
    'Cartao Beneficio - Margem Liquida',
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
        row.margem_cartao_beneficio_total,
        row.margem_cartao_beneficio_disponivel,
        row.consignacoes_facultativas_bruta,
        row.consignacoes_facultativas_liquida,
        row.cartao_beneficio_bruta,
        row.cartao_beneficio_liquida,
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
  const rows = buildRibeiraoBatchExportRows(batchId);
  const header = [
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
    'Margem Cartao Beneficio Total',
    'Margem Cartao Beneficio Disponivel',
    'Consignacoes Facultativas - Margem Bruta',
    'Consignacoes Facultativas - Margem Liquida',
    'Cartao Beneficio - Margem Bruta',
    'Cartao Beneficio - Margem Liquida',
    'Melhor produto',
    'Melhor margem liquida',
    'Data/hora',
  ];
  const worksheet = XLSX.utils.aoa_to_sheet([header, ...rows.map((row) => [
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
    row.margem_cartao_beneficio_total,
    row.margem_cartao_beneficio_disponivel,
    row.consignacoes_facultativas_bruta,
    row.consignacoes_facultativas_liquida,
    row.cartao_beneficio_bruta,
    row.cartao_beneficio_liquida,
    row.melhor_produto,
    row.melhor_margem_liquida,
    row.data_hora,
  ])]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Resultados');
  return XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
}
