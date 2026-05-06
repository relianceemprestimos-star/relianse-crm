import fs from 'node:fs';
import path from 'node:path';

import {
  createPhoneLookupJob,
  enqueuePhoneLookupForMarginClients,
  getClientById,
  getPhoneLookupJobById,
  listClients,
  listPhoneLookupLogs,
  listPhoneLookupJobs,
  logPhoneLookupRecord,
  saveClientLookupPhones,
  updatePhoneLookupJob,
} from '../../db.js';
import { cleanDigits } from '../../utils.js';
import { getNovaVidaDiagnostics, lookupPhoneNovaVida, searchPhoneNovaVida } from './novaVidaProvider.js';

function nowIso() {
  return new Date().toISOString();
}

function maskCpf(cpf) {
  const digits = cleanDigits(cpf);
  if (digits.length !== 11) return '***';
  return `***${digits.slice(-3)}`;
}

function logLookup(message, payload = {}) {
  const logDir = path.resolve(process.env.LOG_DIR || path.join(process.cwd(), 'logs'));
  fs.mkdirSync(logDir, { recursive: true });
  const safePayload = { ...payload };
  delete safePayload.password;
  delete safePayload.senha;
  const line = JSON.stringify({ at: nowIso(), message, ...safePayload });
  fs.appendFileSync(path.join(logDir, 'phone_lookup.log'), `${line}\n`, 'utf8');
}

function canAutoLookup(client) {
  if (!client) {
    return { ok: false, reason: 'Cliente nao encontrado.' };
  }
  const status = String(client.status_atendimento || client.status || '').toLowerCase();
  if (['sem_interesse', 'bloqueado', 'nao_abordar', 'não_abordar', 'nao abordar', 'não abordar', 'finalizado_sem_interesse'].includes(status)) {
    return { ok: false, reason: 'Cliente possui status que bloqueia busca automatica.' };
  }
  if (cleanDigits(client.cpf).length !== 11) {
    return { ok: false, reason: 'Cliente sem CPF valido.' };
  }
  const margin = Number(client.best_net_margin ?? client.current_margin ?? 0);
  if (!Number.isFinite(margin) || margin <= 0) {
    return { ok: false, reason: 'Cliente sem margem disponivel.' };
  }
  const hasActivePhone = (client.phones || []).some((phone) => phone.status === 'active');
  if (hasActivePhone) {
    return { ok: false, reason: 'Cliente ja possui telefone ativo.' };
  }
  return { ok: true, reason: '' };
}

function statusFromProvider(providerStatus) {
  const status = String(providerStatus || '').toLowerCase();
  if (status === 'success') return 'success';
  if (status === 'not_found') return 'not_found';
  if (status === 'blocked') return 'blocked';
  if (status === 'requires_manual_login') return 'requires_manual_login';
  return 'failed';
}

export function getPhoneLookupDiagnostics() {
  return {
    enabled: String(process.env.PHONE_LOOKUP_ENABLED ?? 'true').toLowerCase() !== 'false',
    source: process.env.PHONE_LOOKUP_SOURCE || 'nova_vida',
    maxPerRun: Number(process.env.PHONE_LOOKUP_MAX_PER_RUN || 50),
    delaySeconds: Number(process.env.PHONE_LOOKUP_DELAY_SECONDS || 5),
    novaVida: getNovaVidaDiagnostics(),
  };
}

export function queuePhoneLookupForClient({ clientId, userId, force = false }) {
  const details = getClientById(Number(clientId));
  if (!details?.client) {
    return { error: 'Cliente nao encontrado.', status: 404 };
  }
  const eligibility = canAutoLookup(details.client);
  if (!force && !eligibility.ok) {
    return { error: eligibility.reason, status: 400 };
  }
  const job = createPhoneLookupJob({ clientId: Number(clientId), userId, source: 'Nova Vida' });
  logLookup('job_created', { clientId: Number(clientId), cpf: maskCpf(details.client.cpf), source: 'Nova Vida' });
  return { job };
}

export function queuePhoneLookupForMarginClients({ userId, filters = {}, force = false } = {}) {
  const result = enqueuePhoneLookupForMarginClients({
    ...filters,
    userId,
    source: 'Nova Vida',
    force,
    limit: Number(process.env.PHONE_LOOKUP_MAX_PER_RUN || 50),
  });
  logLookup('bulk_jobs_created', { created: result.created, source: 'Nova Vida' });
  return result;
}

export async function searchPhones({ cpf = '', name = '', clientId = null } = {}) {
  const clientDetails = clientId ? getClientById(Number(clientId)) : null;
  const client = clientDetails?.client || null;
  const searchCpf = cleanDigits(cpf || client?.cpf || '');
  const searchName = String(name || client?.name || '').trim();
  if (!searchCpf && !searchName) {
    return { error: 'Informe CPF ou nome para buscar telefone.', status: 400 };
  }

  const result = await searchPhoneNovaVida({ cpf: searchCpf, name: searchName });
  logPhoneLookupRecord({
    clientId: client?.id ?? null,
    cpfMasked: searchCpf ? maskCpf(searchCpf) : '',
    name: result.name || searchName,
    source: 'Nova Vida',
    status: result.status,
    phonesFoundCount: result.phones?.length || 0,
    errorMessage: result.status === 'success' ? '' : result.message || result.code || '',
  });
  logLookup('manual_search_finished', {
    clientId: client?.id ?? null,
    cpf: searchCpf ? maskCpf(searchCpf) : '',
    status: result.status,
    phonesFound: result.phones?.length || 0,
  });

  return {
    status: result.status,
    source: result.source || 'Nova Vida',
    client_id: client?.id ?? null,
    cpf: searchCpf,
    name: result.name || searchName,
    phones: result.phones || [],
    message: result.message || '',
    code: result.code || '',
  };
}

export function savePhonesToClient({ clientId, phones = [], userId }) {
  const saved = saveClientLookupPhones({
    clientId: Number(clientId),
    userId,
    phones,
    source: 'Nova Vida',
    searchedAt: nowIso(),
  });
  if (!saved) {
    return { error: 'Cliente nao encontrado.', status: 404 };
  }
  logPhoneLookupRecord({
    clientId: Number(clientId),
    cpfMasked: '',
    name: saved.client?.name || '',
    source: 'Nova Vida',
    status: 'saved',
    phonesFoundCount: saved.saved || 0,
  });
  return saved;
}

export async function processPhoneLookupJob(jobId, { userId } = {}) {
  const job = getPhoneLookupJobById(Number(jobId));
  if (!job) {
    return { error: 'Job nao encontrado.', status: 404 };
  }

  const details = getClientById(Number(job.client_id));
  if (!details?.client) {
    updatePhoneLookupJob(job.id, {
      status: 'failed',
      attempts: job.attempts + 1,
      error_message: 'Cliente nao encontrado.',
      finished_at: nowIso(),
    });
    return { error: 'Cliente nao encontrado.', status: 404 };
  }

  const startedAt = nowIso();
  updatePhoneLookupJob(job.id, {
    status: 'running',
    attempts: job.attempts + 1,
    started_at: job.started_at || startedAt,
    error_message: '',
  });

  const start = Date.now();
  try {
    const result = await lookupPhoneNovaVida(details.client);
    const finalStatus = statusFromProvider(result.status);
    let saved = null;
    if (finalStatus === 'success') {
      saved = saveClientLookupPhones({
        clientId: details.client.id,
        userId,
        source: 'Nova Vida',
        phones: result.phones || [],
        searchedAt: nowIso(),
      });
    }

    const updatedJob = updatePhoneLookupJob(job.id, {
      status: finalStatus,
      error_message: finalStatus === 'success' ? '' : result.message || result.code || 'Busca sem sucesso.',
      finished_at: nowIso(),
    });
    logLookup('job_finished', {
      jobId: job.id,
      clientId: details.client.id,
      cpf: maskCpf(details.client.cpf),
      status: finalStatus,
      phonesFound: result.phones?.length || 0,
      durationMs: Date.now() - start,
    });
    return { job: updatedJob, result, client: saved?.client || getClientById(details.client.id)?.client };
  } catch (error) {
    const updatedJob = updatePhoneLookupJob(job.id, {
      status: 'failed',
      error_message: error instanceof Error ? error.message : 'Erro inesperado na busca de telefone.',
      finished_at: nowIso(),
    });
    logLookup('job_failed', {
      jobId: job.id,
      clientId: details.client.id,
      cpf: maskCpf(details.client.cpf),
      error: updatedJob.error_message,
      durationMs: Date.now() - start,
    });
    return { job: updatedJob, error: updatedJob.error_message, status: 500 };
  }
}

export async function runPhoneLookupWorker({ max = Number(process.env.PHONE_LOOKUP_MAX_PER_RUN || 50), userId } = {}) {
  const pending = listPhoneLookupJobs({ status: 'pending', limit: max }).jobs;
  const delayMs = Math.max(0, Number(process.env.PHONE_LOOKUP_DELAY_SECONDS || 5)) * 1000;
  const processed = [];
  for (const job of pending) {
    processed.push(await processPhoneLookupJob(job.id, { userId }));
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return { processed: processed.length, results: processed };
}

export { listPhoneLookupJobs };
export { listPhoneLookupLogs };
