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

function randomDelay(minSeconds = 3, maxSeconds = 8) {
  const min = Math.max(0, Number(minSeconds || 0));
  const max = Math.max(min, Number(maxSeconds || min));
  const seconds = min === max ? min : min + Math.random() * (max - min);
  return Math.max(0, Math.round(seconds * 1000));
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

export function previewRibeiraoBatchSpreadsheet(buffer, filename) {
  const rows = readSpreadsheetRows(buffer, filename);
  const headers = getWorksheetHeaders(rows);
  const cpfColumn = extractCpfColumn(headers);

  const previewRows = rows.map((row, index) => {
    const source = normalizeCpfSource(cpfColumn ? row[cpfColumn] : Object.values(row || {})[0]);
    return {
      rowNumber: index + 2,
      cpf: source.cpf,
      cpf_display: source.cpf_display,
      raw_value: String(source.raw ?? ''),
      isValid: source.isValid,
      alerts: source.alerts,
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
  login,
  password,
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
          cpf,
          login,
          password,
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

        throw error;
      }

      const standardized = queryResult.standardized;
      const query = queryResult.query;
      if (query?.id) {
        const database = getDb();
        database
          .prepare('UPDATE ribeirao_margin_queries SET batch_id = ? WHERE id = ?')
          .run(batchId, query.id);
      }

      const matchedClient = Array.isArray(queryResult.client_matches)
        ? queryResult.client_matches.find((match) => {
            const candidateBaseId = match.base_id === null || match.base_id === undefined ? null : Number(match.base_id);
            return normalizedBaseId !== null ? candidateBaseId === normalizedBaseId : true;
          })
        : null;

      if (matchedClient && query?.id) {
        applyRibeiraoResultToClient({
          queryId: query.id,
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
        return getRibeiraoBatchById(batchId);
      }

      if (status === RIBEIRAO_QUERY_STATUSES.WITH_MARGIN) {
        updateBatchCounts(batchId, { processed_count: 1, success_count: 1 }, 'em_andamento');
      } else if (status === RIBEIRAO_QUERY_STATUSES.WITHOUT_MARGIN) {
        updateBatchCounts(batchId, { processed_count: 1, no_margin_count: 1 }, 'em_andamento');
      } else {
        updateBatchCounts(batchId, { processed_count: 1, error_count: 1 }, 'em_andamento');
      }

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
  login,
  password,
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

  const cleanCpfs = Array.from(new Set((cpfs || []).map((value) => cleanDigits(String(value || ''))).filter((value) => value.length === 11)));
  const totalCpfs = cleanCpfs.length;
  const normalizedBaseId = normalizeBatchBaseId(baseId);
  const batch = createRibeiraoBatchRecord({
    userId,
    baseId: normalizedBaseId,
    sourceType,
    sourceFileName,
    totalCpfs,
  });

  if (!batch) {
    throw new Error('Nao foi possivel criar o lote.');
  }

  const batchId = batch.id;
  activeBatchJobs.set(batchId, { paused: false, cancelled: false, running: false, waitingCaptcha: false });

  return await processBatch(batchId, {
    userId,
    sessionId,
    login,
    password,
    cpfs: cleanCpfs,
    sourceType,
    baseId: normalizedBaseId,
    sourceFileName,
    delaySecondsMin,
    delaySecondsMax,
  });
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
  control.paused = false;
  control.waitingCaptcha = false;
  updateRibeiraoBatchRecord(batchId, { status: 'em_andamento' });
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

export function exportRibeiraoBatchResultsCsv(batchId) {
  const rows = getRibeiraoBatchResults(batchId);
  const marginByProduct = (row, productType) => row.margins?.find((margin) => margin.product_type === productType) || null;
  const header = [
    'CPF',
    'Nome',
    'Matricula',
    'Orgao',
    'Base',
    'Cliente ID',
    'Margem Bruta Consignacao',
    'Margem Liquida Consignacao',
    'Margem Bruta Credito',
    'Margem Liquida Credito',
    'Margem Bruta Cartao',
    'Margem Liquida Cartao',
    'Melhor produto',
    'Melhor margem liquida',
    'Status consulta',
    'Mensagem',
    'Data/hora',
  ];

  const escapeCsv = (value) => {
    const text = String(value ?? '');
    if (/[",\n;]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const lines = [
    header.map(escapeCsv).join(','),
    ...rows.map((row) =>
      [
        row.cpf_masked || row.cpf || '',
        row.nome || '',
        row.matricula || '',
        row.orgao || '',
        row.base_name || '',
        row.client_id || '',
        formatMoney(marginByProduct(row, 'consignacao')?.gross_margin ?? row.margem_consignavel_bruta),
        formatMoney(marginByProduct(row, 'consignacao')?.net_margin ?? row.margem_consignavel_liquida),
        formatMoney(marginByProduct(row, 'credito')?.gross_margin ?? null),
        formatMoney(marginByProduct(row, 'credito')?.net_margin ?? null),
        formatMoney(marginByProduct(row, 'cartao')?.gross_margin ?? row.margem_cartao_bruta),
        formatMoney(marginByProduct(row, 'cartao')?.net_margin ?? row.margem_cartao_liquida),
        row.best_product_type || '',
        formatMoney(row.best_net_margin),
        row.consulta_status_label || row.consulta_status || '',
        row.mensagem || '',
        row.created_at_formatted || row.created_at || '',
      ]
        .map(escapeCsv)
        .join(',')
    ),
  ];

  return lines.join('\n');
}
