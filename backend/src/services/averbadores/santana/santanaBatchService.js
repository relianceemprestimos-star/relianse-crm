import xlsx from 'xlsx';

import {
  createSantanaBatchRecord,
  getSantanaBatchById,
  listSantanaBatches,
  updateSantanaBatchRecord,
} from '../../../db.js';
import {
  authenticateSantanaApi,
  querySantanaCpfWithToken,
} from './santanaApiService.js';
import { runSantanaPortalCommand } from './santanaPortalAdapter.js';

const runningBatches = new Set();

function nowIso() {
  return new Date().toISOString();
}

async function runSantanaApiBatch({ cpfs, apiBaseUrl, login, password, onProgress = null }) {
  const authenticated = await authenticateSantanaApi({ apiBaseUrl, login, password });
  const results = [];
  for (const [index, cpf] of cpfs.entries()) {
    let result;
    try {
      result = await querySantanaCpfWithToken({
        baseUrl: authenticated.baseUrl,
        token: authenticated.token,
        cpf,
      });
    } catch (error) {
      result = {
        status: 'erro',
        cpf: String(cpf || '').replace(/\D/g, '').padStart(11, '0'),
        message: error instanceof Error ? error.message : 'Falha na API RF1.',
      };
    }
    results.push(result);
    if (typeof onProgress === 'function') {
      onProgress({ processed: index + 1, status: result.status });
    }
  }
  return { ok: true, source: 'rf1_api', results };
}

export function startSantanaBatch({ userId, portalId = 'prefeitura_santana_parnaiba', sourceFileName = '', cpfs, login, password, apiBaseUrl = '', mode = 'portal' }) {
  const batch = createSantanaBatchRecord({ userId, portalId, sourceFileName, cpfs });
  runningBatches.add(batch.id);
  updateSantanaBatchRecord(batch.id, { status: 'em_execucao', started_at: nowIso() });

  const onProgress = (event) => {
    const current = getSantanaBatchById(batch.id);
    const status = String(event.status || '');
    updateSantanaBatchRecord(batch.id, {
      processed_count: event.processed,
      success_count: current.success_count + (status === 'sucesso' ? 1 : 0),
      not_found_count: current.not_found_count + (status === 'nao_encontrado' ? 1 : 0),
      error_count: current.error_count + (status === 'erro' ? 1 : 0),
    });
  };

  const runner = mode === 'api'
    ? runSantanaApiBatch({ cpfs, apiBaseUrl, login, password, onProgress })
    : runSantanaPortalCommand(
      { action: 'batch', cpfs, login, password, delay_ms: 1200 },
      {
        timeoutMs: Math.max(900_000, Number(cpfs?.length || 0) * 8_000),
        onProgress,
      }
    );

  void runner
    .then((response) => {
      const results = response.results || [];
      updateSantanaBatchRecord(batch.id, {
        processed_count: results.length,
        success_count: results.filter((item) => item.status === 'sucesso').length,
        not_found_count: results.filter((item) => item.status === 'nao_encontrado').length,
        error_count: results.filter((item) => item.status === 'erro').length,
        status: 'concluido',
        results_json: JSON.stringify(results),
        finished_at: nowIso(),
      });
    })
    .catch((error) => {
      updateSantanaBatchRecord(batch.id, {
        status: 'erro',
        error_message: error instanceof Error ? error.message : 'Falha no lote Santana.',
        finished_at: nowIso(),
      });
    })
    .finally(() => runningBatches.delete(batch.id));
  return getSantanaBatchById(batch.id);
}

export function getSantanaBatchStatus(id) {
  return getSantanaBatchById(id);
}

export function getSantanaBatchHistory(limit = 20, portalId = '') {
  return listSantanaBatches(limit, portalId);
}

export function exportSantanaBatchXlsx(id) {
  const batch = getSantanaBatchById(id);
  if (!batch) return null;
  const rows = (batch.results || []).map((item) => ({
    CPF: item.cpf || '',
    Nome: item.nome || '',
    Matricula: item.matricula || '',
    Secretaria: item.secretaria || '',
    Vinculo: item.vinculo || '',
    Situacao: item.situacao || '',
    Data_Nascimento: item.data_nascimento || '',
    Margem_Consignado: item.margem_consignado,
    Margem_Cartao: item.margem_cartao,
    Margem_Cartao_Beneficio: item.margem_cartao_beneficio,
    Status_Consulta: item.status || '',
    Mensagem: item.message || '',
  }));
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(rows), 'Santana');
  return xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
