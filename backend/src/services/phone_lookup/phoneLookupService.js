import fs from 'node:fs';
import path from 'node:path';

import {
  createPhoneLookupJob,
  enqueuePhoneLookupForMarginClients,
  getClientById,
  getClientConsultationById,
  getPhoneLookupJobById,
  getValidClientConsultationByCpf,
  linkClientConsultationToClient,
  listClientConsultations,
  listClients,
  listPhoneLookupLogs,
  listPhoneLookupJobs,
  logPhoneLookupRecord,
  markExpiredClientConsultations,
  saveClientConsultationSnapshot,
  saveClientEnrichmentData,
  saveClientLookupPhones,
  updatePhoneLookupJob,
} from '../../db.js';
import { cleanDigits } from '../../utils.js';
import { getNovaVidaDiagnostics, lookupPhoneNovaVida, mapNovaVidaFlow, searchPhoneNovaVida } from './novaVidaProvider.js';

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
  if (status === 'requires_manual_login') return 'requires_manual_login';
  return 'failed';
}

function consultationToSearchResult(consultation, { cacheHit = false } = {}) {
  if (!consultation) return null;
  return {
    status: consultation.status,
    source: cacheHit ? 'Consulta salva' : consultation.source || 'Fonte externa',
    origin: cacheHit ? 'Consulta salva' : consultation.source || 'Fonte externa',
    cache_hit: cacheHit,
    consultation_id: consultation.id,
    client_id: consultation.client_id ?? null,
    cpf: consultation.cpf || '',
    name: consultation.nome || consultation.full_name || '',
    full_name: consultation.full_name || consultation.nome || '',
    birth_date: consultation.birth_date || '',
    age: consultation.age ?? null,
    gender: consultation.gender || '',
    mother_name: consultation.mother_name || '',
    father_name: consultation.father_name || '',
    email: consultation.emails?.[0]?.email || '',
    emails: (consultation.emails || []).map((item) => item.email).filter(Boolean),
    addresses: consultation.addresses || [],
    raw_data: consultation.raw_data || {},
    phones: (consultation.phones || []).map((phone) => ({
      number: phone.phone_number || phone.number || '',
      normalized: phone.phone_number || phone.normalized || '',
      normalized_phone: phone.phone_number || phone.normalized || '',
      type: phone.phone_type || phone.type || '',
      quality: phone.label || '',
      raw_label: phone.label || '',
      source: 'Consulta salva',
    })),
    message: consultation.error_message || '',
    code: '',
    expires_at: consultation.expires_at,
    consulted_at: consultation.consulted_at,
  };
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

export async function mapPhoneLookupProvider() {
  const result = await mapNovaVidaFlow();
  logLookup('provider_map_finished', {
    source: 'Nova Vida',
    status: result.status,
    code: result.code || '',
    stage: result.stage || '',
    loginOk: Boolean(result.loginOk),
  });
  return result;
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

export async function searchPhones({ cpf = '', name = '', phone = '', clientId = null, userId = null } = {}) {
  markExpiredClientConsultations();
  const clientDetails = clientId ? getClientById(Number(clientId)) : null;
  const client = clientDetails?.client || null;
  const searchPhone = String(phone || client?.phone || '').trim();
  const searchCpf = cleanDigits(cpf || client?.cpf || '');
  const searchName = String(name || client?.name || (!searchCpf && searchPhone ? searchPhone : '')).trim();
  if (!searchCpf && !searchName) {
    return { error: 'Informe CPF ou nome para buscar.', status: 400 };
  }

  if (searchCpf.length === 11) {
    const cached = getValidClientConsultationByCpf(searchCpf);
    if (cached) {
      logLookup('manual_search_cache_hit', {
        clientId: client?.id ?? null,
        cpf: maskCpf(searchCpf),
        consultationId: cached.id,
      });
      return consultationToSearchResult(cached, { cacheHit: true });
    }
  }

  const result = await searchPhoneNovaVida({ cpf: searchCpf, name: searchName });
  const finalStatus = statusFromProvider(result.status);
  const savedConsultation = saveClientConsultationSnapshot({
    clientId: client?.id ?? null,
    createdBy: userId,
    cpf: searchCpf,
    nome: result.full_name || result.name || searchName,
    telefonePesquisado: searchPhone,
    status: finalStatus,
    source: 'Fonte externa',
    errorMessage: finalStatus === 'success' ? '' : result.message || result.code || 'Consulta nao concluida.',
    result: { ...result, status: finalStatus },
  });

  logPhoneLookupRecord({
    clientId: client?.id ?? null,
    cpf: searchCpf,
    cpfMasked: searchCpf ? maskCpf(searchCpf) : '',
    name: result.name || searchName,
    source: 'Fonte externa',
    status: finalStatus,
    phonesFoundCount: result.phones?.length || 0,
    hasAddress: Boolean(result.addresses?.length),
    hasBirthDate: Boolean(result.birth_date),
    errorMessage: finalStatus === 'success' ? '' : result.message || result.code || '',
  });
  logLookup('manual_search_finished', {
    clientId: client?.id ?? null,
    cpf: searchCpf ? maskCpf(searchCpf) : '',
    status: finalStatus,
    phonesFound: result.phones?.length || 0,
    consultationId: savedConsultation?.id ?? null,
    reconnectAttempted: Boolean(result.reconnectAttempted),
    reconnectOk: Boolean(result.reconnectOk),
  });

  if (client?.id) {
    if (finalStatus === 'success' && result.phones?.length) {
      saveClientLookupPhones({
        clientId: client.id,
        userId,
        source: 'Nova Vida',
        phones: result.phones || [],
        searchedAt: nowIso(),
      });
    }
    saveClientEnrichmentData({
      clientId: client.id,
      userId,
      source: 'Nova Vida',
      data: { ...result, status: finalStatus },
      searchedAt: nowIso(),
    });
  }

  return {
    status: finalStatus,
    source: 'Fonte externa',
    origin: 'Fonte externa',
    cache_hit: false,
    consultation_id: savedConsultation?.id ?? null,
    client_id: client?.id ?? null,
    cpf: searchCpf,
    name: result.name || searchName,
    full_name: result.full_name || result.name || searchName,
    birth_date: result.birth_date || '',
    age: result.age ?? null,
    gender: result.gender || '',
    mother_name: result.mother_name || '',
    father_name: result.father_name || '',
    email: result.email || '',
    emails: result.emails || [],
    addresses: result.addresses || [],
    raw_data: result.raw_data || result.raw || {},
    phones: result.phones || [],
    message: result.message || '',
    code: result.code || '',
    stage: result.stage || '',
    expires_at: savedConsultation?.expires_at || '',
    consulted_at: savedConsultation?.consulted_at || '',
  };
}

export function getPhoneLookupConsultation(id) {
  const consultation = getClientConsultationById(Number(id));
  return consultation ? consultationToSearchResult(consultation, { cacheHit: true }) : null;
}

export function listPhoneLookupConsultations(params = {}) {
  return { rows: listClientConsultations(params) };
}

export function saveCurrentConsultation({ consultationId, clientId, userId }) {
  if (!consultationId) {
    return { error: 'Consulta atual nao encontrada para salvar.', status: 400 };
  }
  if (!clientId) {
    const consultation = getClientConsultationById(Number(consultationId));
    if (!consultation) return { error: 'Consulta nao encontrada.', status: 404 };
    return { consultation };
  }
  const linked = linkClientConsultationToClient({ consultationId: Number(consultationId), clientId: Number(clientId), userId });
  if (!linked) return { error: 'Nao foi possivel vincular a consulta ao cliente.', status: 404 };
  return { consultation: linked };
}

export function cleanupPhoneLookupConsultations() {
  return markExpiredClientConsultations();
}

export function savePhonesToClient({ clientId, phones = [], enrichment = null, userId }) {
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
  const enrichmentSaved = enrichment
    ? saveClientEnrichmentData({
        clientId: Number(clientId),
        userId,
        data: enrichment,
        source: 'Nova Vida',
        searchedAt: nowIso(),
      })
    : null;
  logPhoneLookupRecord({
    clientId: Number(clientId),
    cpf: saved.client?.cpf || '',
    cpfMasked: '',
    name: saved.client?.name || '',
    source: 'Nova Vida',
    status: 'saved',
    phonesFoundCount: saved.saved || 0,
  });
  return { ...saved, enrichment: enrichmentSaved };
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
      saveClientEnrichmentData({
        clientId: details.client.id,
        userId,
        source: 'Nova Vida',
        data: { ...result, status: finalStatus },
        searchedAt: nowIso(),
      });
    } else {
      saveClientEnrichmentData({
        clientId: details.client.id,
        userId,
        source: 'Nova Vida',
        data: { cpf: details.client.cpf, full_name: details.client.name, status: finalStatus, raw_data: result.raw_data || result.raw || {} },
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
