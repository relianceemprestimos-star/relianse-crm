import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { fileURLToPath } from 'node:url';
import xlsx from 'xlsx';

import { BUILD_VERSION } from './build.js';
import {
  archiveBase,
  analyzeSpreadsheet,
  createUserRecord,
  convertClient,
  finalizeClient,
  getBases,
  getClientById,
  getDashboardData,
  getDb,
  getNextClient,
  getUserById,
  getUserByLogin,
  getReportsData,
  getSettings,
  getUsers,
  initDb,
  listClients,
  logWhatsappOpen,
  markNoInterest,
  saveImportedSpreadsheet,
  saveSettings,
  scheduleReturn,
  startAttendance,
  renameBase,
  addInteraction,
  archiveCampaignRecord,
  updateUserPasswordRecord,
  createCampaignRecordPublic as createCampaignRecord,
  getCampaignById,
  getCampaigns,
  updateUserRecord,
  setCampaignUsers,
  updateCampaignRecord,
  getTodayBankCoefficients,
  listClientPhones,
  setPrimaryClientPhone,
  updateClientPhoneStatus,
  getActiveConsent,
  grantCustomerConsent,
  revokeCustomerConsent,
  writeAuditLog,
  completeDispatchCampaign,
  createDispatchCampaign,
  getDispatchCampaignById,
  getTodayCampaignCoefficient,
  listCampaignOpportunities,
  listDispatchCampaigns,
  listPendingDispatchClients,
  markCampaignClientFailed,
  markCampaignClientSent,
  saveBankCoefficient,
  saveCampaignCoefficient,
  startDispatchCampaign,
  listCampaignDryRuns,
  runCampaignDryRun,
  updateCampaignPreDispatchStatus,
  updateCampaignClientStatusFromWebhook,
  getDocumentChecklist,
  getClientDocumentById,
  listCampaignDocumentChecklists,
  markDigitalAccountForDocuments,
  registerReceivedDocument,
  saveDocumentAiResult,
  validateClientDocument,
} from './db.js';
import { authMiddleware, loginWithCredentials, roleMiddleware } from './auth.js';
import { hashPassword, verifyPassword } from './security.js';
import {
  applyRibeiraoResultToClient,
  getRibeiraoDiagnostics,
  getRibeiraoHistoryById,
  getRibeiraoConfigStatus,
  getRibeiraoSessionGate,
  getRibeiraoSessionStatus,
  listRibeiraoHistory,
  resetRibeiraoSessionCache,
  queryRibeiraoCpf,
  startRibeiraoSession,
} from './services/averbadores/ribeirao/ribeiraoService.js';
import {
  cancelRibeiraoBatch,
  exportRibeiraoBatchResultsXlsx,
  getRibeiraoBatchHistory,
  getRibeiraoBatchResults,
  getRibeiraoBatchStatus,
  loadRibeiraoBatchCpfsFromBase,
  pauseRibeiraoBatch,
  previewRibeiraoBatchSpreadsheet,
  resumeRibeiraoBatch,
  startRibeiraoBatch,
} from './services/averbadores/ribeirao/ribeiraoBatchService.js';
import { normalizePhoneToBrazilInternational } from './utils.js';
import {
  getPhoneLookupDiagnostics,
  cleanupPhoneLookupConsultations,
  getPhoneLookupConsultation,
  listPhoneLookupConsultations,
  listPhoneLookupLogs,
  listPhoneLookupJobs,
  mapPhoneLookupProvider,
  processPhoneLookupJob,
  queuePhoneLookupForClient,
  queuePhoneLookupForMarginClients,
  runPhoneLookupWorker,
  saveCurrentConsultation,
  savePhonesToClient,
  searchCpfCandidatesByName,
  searchPhones,
} from './services/phone_lookup/phoneLookupService.js';
import { globalRateLimit, loginRateLimit, communicationRateLimit, sensitiveLookupRateLimit } from './rateLimits.js';
import { getDocumentAiStatus, processDocumentWithGoogleAi } from './services/documentAiService.js';
import {
  confirmAssistedLogin,
  getCredentialPortals,
  getCredentialSecretByPortal,
  getCredentialLogs,
  listCredentials,
  saveCredential,
  startAssistedLogin,
  testCredential,
  updateCredential,
} from './services/credentials/credentialService.js';
import { getMarginPortalConfigs, getPortalConfig, isRf1ApiPortal, normalizePortalId } from './services/credentials/portalConfigs.js';
import { runSantanaPortalCommand } from './services/averbadores/santana/santanaPortalAdapter.js';
import { inferSantanaApiBaseUrl, querySantanaCpf } from './services/averbadores/santana/santanaApiService.js';
import {
  exportSantanaBatchXlsx,
  getSantanaBatchHistory,
  getSantanaBatchStatus,
  startSantanaBatch,
} from './services/averbadores/santana/santanaBatchService.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), override: true });
await initDb();

const app = express();
app.set('trust proxy', 1);

function parseCorsOrigins() {
  const candidates = [
    process.env.CORS_ORIGIN,
    process.env.FRONTEND_URL,
    process.env.APP_URL,
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3000',
  ];

  return Array.from(
    new Set(
      candidates
        .flatMap((entry) => String(entry || '').split(','))
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
}

const allowedCorsOrigins = parseCorsOrigins();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_SIZE_MB || 25) * 1024 * 1024,
  },
  fileFilter: (_req, file, callback) => {
    const name = String(file.originalname || '').toLowerCase();
    const mime = String(file.mimetype || '').toLowerCase();
    const allowed =
      name.endsWith('.csv') ||
      name.endsWith('.xls') ||
      name.endsWith('.xlsx') ||
      mime.includes('csv') ||
      mime.includes('excel') ||
      mime.includes('spreadsheetml');

    if (!allowed) {
      callback(new Error('Tipo de arquivo nao suportado. Envie .xlsx, .xls ou .csv.'));
      return;
    }

    callback(null, true);
  },
});
const port = Number(process.env.PORT || 3001);
const defaultUserId = 1;
const privilegedRoles = new Set(['admin', 'gerencial']);

function requestIp(req) {
  return String(req.ip || req.get('x-forwarded-for') || '').split(',')[0].trim();
}

function getRequestRole(req) {
  return String(req.user?.role || req.get('x-crm-role') || req.get('x-user-role') || req.body?.role || req.query?.role || 'vendedor').toLowerCase();
}

function getAuthenticatedUserId(req) {
  return Number(req.user?.id || req.body?.user_id || req.body?.userId || defaultUserId);
}

function requirePrivilegedRole(req, res, next) {
  const role = getRequestRole(req);
  if (!privilegedRoles.has(role)) {
    return res.status(403).json({ message: 'Acesso restrito ao perfil gerencial.' });
  }
  return next();
}

function normalizeAutomationText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function firstEnvValue(keys) {
  for (const key of keys) {
    const value = String(process.env[key] || '').trim();
    if (value) {
      return value;
    }
  }
  return '';
}

function isTruthyFlag(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'sim', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function isEsteiraImport(baseInput) {
  const text = normalizeAutomationText([
    baseInput?.notes,
    baseInput?.tipo_base,
    baseInput?.campaign_name,
  ].filter(Boolean).join(' '));
  return text.includes('[finalidade:esteira]') || text.includes('esteira') || text.includes('campanha');
}

function resolveMarginPortalId(baseInput, base = {}) {
  const text = normalizeAutomationText([
    baseInput?.convenio,
    baseInput?.cidade,
    baseInput?.estado,
    baseInput?.tipo_base,
    baseInput?.nome_base,
    baseInput?.notes,
    base?.convenio,
    base?.cidade,
    base?.estado,
    base?.tipo_base,
    base?.nome_base,
    base?.observacao,
  ].filter(Boolean).join(' '));

  if (text.includes('governo') || text.includes('gov sp') || text.includes('sao paulo')) {
    return 'governo_sp';
  }
  if (text.includes('ribeirao')) {
    return 'prefeitura_ribeirao_preto';
  }
  return '';
}

function getMarginPortalCredentials(portalId) {
  const stored = getCredentialSecretByPortal(portalId);
  if (stored?.login && stored?.password) {
    return {
      credential_id: Number(stored.id || 0) || null,
      login: stored.login,
      password: stored.password,
    };
  }

  if (portalId === 'governo_sp' || portalId === 'tjsp' || portalId === 'portal_consignado') {
    return {
      credential_id: null,
      login: firstEnvValue(['GOV_SP_AVERBADOR_LOGIN', 'GOVSP_AVERBADOR_LOGIN', 'GOV_SP_LOGIN', 'GOVSP_LOGIN']),
      password: firstEnvValue(['GOV_SP_AVERBADOR_PASSWORD', 'GOVSP_AVERBADOR_PASSWORD', 'GOV_SP_PASSWORD', 'GOVSP_PASSWORD']),
    };
  }

  if (portalId === 'governo_amapa') {
    return {
      credential_id: null,
      login: firstEnvValue(['AMAPA_AVERBADOR_LOGIN', 'GOVERNO_AMAPA_LOGIN', 'AMAPA_LOGIN']),
      password: firstEnvValue(['AMAPA_AVERBADOR_PASSWORD', 'GOVERNO_AMAPA_PASSWORD', 'AMAPA_PASSWORD']),
    };
  }

  return {
    credential_id: null,
    login: firstEnvValue(['RIBEIRAO_AVERBADOR_LOGIN', 'RIBEIRAO_LOGIN']),
    password: firstEnvValue(['RIBEIRAO_AVERBADOR_PASSWORD', 'RIBEIRAO_PASSWORD']),
  };
}

function buildUploadAutomationPlan({ baseInput, importResult }) {
  const base = importResult?.base || {};
  const baseId = Number(base.id || 0);
  const autoMarginRequested = isTruthyFlag(baseInput?.auto_margin, isEsteiraImport(baseInput));
  if (!autoMarginRequested) {
    return { status: 'not_requested', step: 'upload' };
  }
  if (!isEsteiraImport(baseInput)) {
    return { status: 'skipped', reason: 'base_not_pipeline', step: 'upload' };
  }
  if (!baseId) {
    return { status: 'skipped', reason: 'base_not_saved', step: 'upload' };
  }

  const portalId = resolveMarginPortalId(baseInput, base);
  if (!portalId) {
    return { status: 'pending_configuration', reason: 'portal_not_mapped', step: 'margin', base_id: baseId };
  }

  const cpfs = loadRibeiraoBatchCpfsFromBase(baseId);
  if (!cpfs.length) {
    return { status: 'pending_data', reason: 'no_valid_cpfs', step: 'margin', portal_id: portalId, base_id: baseId, total_cpfs: 0 };
  }

  const credentials = getMarginPortalCredentials(portalId);
  if (!credentials.login || !credentials.password) {
    return {
      status: 'pending_credentials',
      reason: 'missing_portal_credentials',
      step: 'margin',
      portal_id: portalId,
      base_id: baseId,
      total_cpfs: cpfs.length,
    };
  }

  return {
    status: 'queued',
    step: 'margin',
    portal_id: portalId,
    base_id: baseId,
    total_cpfs: cpfs.length,
    source_file_name: base.arquivo_original || base.nome_base || '',
    credentials,
  };
}

function latestPipelineBasesWaitingMargin(limit = 5) {
  const database = getDb();
  return database
    .prepare(
      `
        SELECT
          b.id,
          b.nome_base,
          b.tipo_base,
          b.convenio,
          b.estado,
          b.cidade,
          b.observacao,
          b.arquivo_original,
          b.total_clientes,
          b.created_at,
          (
            SELECT COUNT(*)
            FROM ribeirao_query_batches rb
            WHERE rb.base_id = b.id
          ) AS batch_count
        FROM bases b
        WHERE COALESCE(b.is_active, 1) = 1
          AND COALESCE(b.total_clientes, 0) > 0
          AND datetime(b.created_at) >= datetime('now', '-24 hours')
        ORDER BY datetime(b.created_at) DESC, b.id DESC
        LIMIT ?
      `
    )
    .all(Number(limit || 5))
    .filter((base) => Number(base.batch_count || 0) === 0)
    .filter((base) =>
      isEsteiraImport({
        notes: base.observacao,
        tipo_base: base.tipo_base,
        campaign_name: base.nome_base,
      })
    );
}

async function resumeRecentPipelineMarginBatches() {
  if (isTruthyFlag(process.env.AUTO_PIPELINE_RECOVERY_DISABLED, false)) {
    return;
  }

  const pendingBases = latestPipelineBasesWaitingMargin(Number(process.env.AUTO_PIPELINE_RECOVERY_LIMIT || 5));
  for (const base of pendingBases) {
    const importResult = { base };
    const plan = buildUploadAutomationPlan({
      baseInput: {
        nome_base: base.nome_base,
        tipo_base: base.tipo_base,
        convenio: base.convenio,
        estado: base.estado,
        cidade: base.cidade,
        notes: base.observacao,
        auto_margin: true,
      },
      importResult,
    });

    if (plan.status !== 'queued') {
      console.warn('[PIPELINE] retomada automatica nao iniciou lote', {
        base_id: base.id,
        status: plan.status,
        reason: plan.reason || '',
        portal_id: plan.portal_id || '',
      });
      continue;
    }

    console.log('[PIPELINE] retomando margem automatica para base da Esteira', {
      base_id: base.id,
      portal_id: plan.portal_id,
      total_cpfs: plan.total_cpfs,
    });
    await runUploadAutomation({ plan, userId: defaultUserId });
  }
}

function publicAutomationPlan(plan) {
  const { credentials: _credentials, ...safePlan } = plan || {};
  return safePlan;
}

async function startMarginBatchFromPlan({ plan, userId }) {
  resetRibeiraoSessionCache();
  const session = await startRibeiraoSession({
    userId,
    credentialId: plan.credentials.credential_id || null,
    login: plan.credentials.login,
    password: plan.credentials.password,
    portalId: plan.portal_id,
    timeoutSeconds: Number(process.env.AUTO_PIPELINE_SESSION_TIMEOUT_SECONDS || 900),
    role: 'gerencial',
  });

  const sessionStatus = String(session?.status || '').toLowerCase();
  let sessionId = Number(session?.id || 0);
  if (sessionStatus !== 'conectado') {
    const reusableSession = getReusableRibeiraoSession();
    if (!reusableSession) {
      return {
        status: 'pending_session',
        reason: 'portal_session_not_connected',
        session_status: sessionStatus || 'desconhecido',
        error_code: session?.error_code || '',
      };
    }
    sessionId = Number(reusableSession.id);
  }

  const cpfs = loadRibeiraoBatchCpfsFromBase(plan.base_id).map((row) => row.cpf).filter(Boolean);
  if (!cpfs.length) {
    return { status: 'pending_data', reason: 'no_valid_cpfs' };
  }

  const batch = await startRibeiraoBatch({
    userId,
    sessionId,
    credentialId: plan.credentials.credential_id || null,
    login: plan.credentials.login,
    password: plan.credentials.password,
    portalId: plan.portal_id,
    sourceType: 'base',
    sourceFileName: plan.source_file_name || '',
    cpfs,
    baseId: plan.base_id,
    delaySecondsMin: Number(process.env.AUTO_PIPELINE_MARGIN_DELAY_SECONDS_MIN || process.env.AUTO_MARGIN_DELAY_SECONDS_MIN || 3),
    delaySecondsMax: Number(process.env.AUTO_PIPELINE_MARGIN_DELAY_SECONDS_MAX || process.env.AUTO_MARGIN_DELAY_SECONDS_MAX || 8),
  });

  return {
    status: 'batch_started',
    reason: '',
    batch_id: Number(batch.id),
    batch,
  };
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseBatchClients(payload, cpfs = []) {
  const source = Array.isArray(payload.clients) ? payload.clients : [];
  if (source.length) {
    return source
      .map((item) => ({
        cpf: String(item?.cpf || item?.cpf_display || '').replace(/\D/g, ''),
        nome: String(item?.name || item?.nome || '').trim(),
      }))
      .filter((item) => item.cpf.length === 11);
  }

  return (cpfs || [])
    .map((item) => {
      if (typeof item === 'string') {
        const cpf = item.replace(/\D/g, '');
        return { cpf, nome: '' };
      }
      const cpf = String(item?.cpf || item?.cpf_display || '').replace(/\D/g, '');
      return { cpf, nome: String(item?.name || item?.nome || '').trim() };
    })
    .filter((item) => item.cpf.length === 11);
}

function baseInputForMarginPortal(portalId, sourceFileName = '') {
  if (portalId === 'governo_sp') {
    return {
      nome_base: sourceFileName ? `${sourceFileName} - Esteira` : 'Governo de SP - Esteira',
      tipo_base: 'Esteira de Campanha',
      convenio: 'Governo de SP',
      estado: 'SP',
      cidade: '',
      notes: '[FINALIDADE:ESTEIRA]\n[ORIGEM:CONSULTA_MARGEM_LOTE]',
    };
  }

  return {
    nome_base: sourceFileName ? `${sourceFileName} - Esteira` : 'Prefeitura de Ribeirão - Esteira',
    tipo_base: 'Esteira de Campanha',
    convenio: 'Prefeitura de Ribeirão Preto',
    estado: 'SP',
    cidade: 'Ribeirão Preto',
    notes: '[FINALIDADE:ESTEIRA]\n[ORIGEM:CONSULTA_MARGEM_LOTE]',
  };
}

function saveBatchUploadAsPipelineBase({ payload, cpfs, portalId, sourceFileName }) {
  const clients = parseBatchClients(payload, cpfs);
  if (!clients.length) {
    return null;
  }

  const rows = ['cpf,nome', ...clients.map((client) => `${csvEscape(client.cpf)},${csvEscape(client.nome || `Cliente ${client.cpf.slice(-4)}`)}`)];
  const buffer = Buffer.from(rows.join('\n'), 'utf8');
  return saveImportedSpreadsheet(buffer, sourceFileName || 'base-esteira.csv', baseInputForMarginPortal(portalId, sourceFileName));
}

async function waitForMarginBatch(batchId) {
  const timeoutSeconds = Math.max(60, Number(process.env.AUTO_PIPELINE_MARGIN_WAIT_SECONDS || 21600));
  const intervalMs = Math.max(3000, Number(process.env.AUTO_PIPELINE_POLL_SECONDS || 10) * 1000);
  const startedAt = Date.now();
  const terminalStatuses = new Set(['concluido', 'erro', 'cancelado', 'pausado_sessao_expirada', 'aguardando_captcha']);

  while (Date.now() - startedAt < timeoutSeconds * 1000) {
    const batch = getRibeiraoBatchStatus(batchId);
    const status = String(batch?.status || '').toLowerCase();
    if (!batch || terminalStatuses.has(status)) {
      return batch;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return getRibeiraoBatchStatus(batchId);
}

async function continuePipelineAfterMarginBatch({ batchId, baseId, userId }) {
  if (!batchId || !baseId) {
    return;
  }

  const finishedBatch = await waitForMarginBatch(Number(batchId));
  if (String(finishedBatch?.status || '').toLowerCase() !== 'concluido') {
    console.warn('[PIPELINE] Nova Vida aguardando conclusao da margem', {
      base_id: baseId,
      batch_id: batchId,
      status: finishedBatch?.status || 'desconhecido',
    });
    return;
  }

  const queued = queuePhoneLookupForMarginClients({
    userId,
    filters: { base_id: baseId },
    limit: Math.max(
      Number(finishedBatch?.success_count || 0),
      Number(process.env.AUTO_PIPELINE_NOVA_VIDA_MAX || 5000)
    ),
    force: false,
  });
  const created = Number(queued?.created || 0);
  console.log('[PIPELINE] margem concluida; Nova Vida enfileirado', {
    base_id: baseId,
    batch_id: batchId,
    created,
  });

  if (created && !isTruthyFlag(process.env.AUTO_PIPELINE_DISABLE_NOVA_VIDA_RUN, false)) {
    await runPhoneLookupWorker({
      userId,
      max: Math.min(created, Number(process.env.AUTO_PIPELINE_NOVA_VIDA_MAX || process.env.PHONE_LOOKUP_MAX_PER_RUN || 50)),
    });
  }
}

async function runUploadAutomation({ plan, userId }) {
  try {
    console.log('[PIPELINE] upload importado; iniciando consulta de margem automatica', {
      base_id: plan.base_id,
      portal_id: plan.portal_id,
      total_cpfs: plan.total_cpfs,
    });

    const started = await startMarginBatchFromPlan({ plan, userId });
    if (started.status !== 'batch_started') {
      console.warn('[PIPELINE] consulta de margem nao iniciou: sessao do portal nao conectou', {
        base_id: plan.base_id,
        portal_id: plan.portal_id,
        status: started.status,
        reason: started.reason || '',
        code: started.error_code || '',
      });
      return;
    }

    await continuePipelineAfterMarginBatch({ batchId: Number(started.batch_id), baseId: plan.base_id, userId });
  } catch (error) {
    console.error('[PIPELINE] erro na automacao da esteira:', error instanceof Error ? error.message : error);
  }
}

function getReusableRibeiraoSession() {
  try {
    return (
      getDb()
        .prepare(
          `
            SELECT id, status, updated_at
            FROM ribeirao_query_sessions
            WHERE status = 'conectado'
              AND datetime(updated_at) >= datetime('now', '-7 days')
            ORDER BY datetime(updated_at) DESC, id DESC
            LIMIT 1
          `
        )
        .get() || null
    );
  } catch {
    return null;
  }
}

function resolveRibeiraoSessionGate(requestedSessionId) {
  const initialSessionId = Number(requestedSessionId || 0);
  if (initialSessionId) {
    const gate = getRibeiraoSessionGate(initialSessionId);
    if (gate.success) {
      return { sessionId: initialSessionId, gate, usedReusableSession: false };
    }
  }

  const reusableSession = getReusableRibeiraoSession();
  const reusableSessionId = Number(reusableSession?.id || 0);
  if (reusableSessionId && reusableSessionId !== initialSessionId) {
    const gate = getRibeiraoSessionGate(reusableSessionId);
    if (gate.success) {
      return { sessionId: reusableSessionId, gate, usedReusableSession: true };
    }
  }

  if (initialSessionId) {
    return {
      sessionId: initialSessionId,
      gate: getRibeiraoSessionGate(initialSessionId),
      usedReusableSession: false,
    };
  }

  return {
    sessionId: 0,
    gate: {
      success: false,
      code: 'NO_ACTIVE_SESSION',
      message: 'Nenhuma sessão ativa com o portal da Prefeitura. Inicie a sessão antes de consultar.',
    },
    usedReusableSession: false,
  };
}

function campaignWebhookAuthorized(req) {
  const header = String(req.get('authorization') || '');
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : header.trim();
  return Boolean(process.env.CRM_WEBHOOK_SECRET && token && token === process.env.CRM_WEBHOOK_SECRET);
}

function getReWhatsConfig() {
  return {
    url: String(process.env.REWHATS_URL || '').replace(/\/$/, ''),
    apiKey: String(process.env.REWHATS_API_KEY || ''),
    intervalMs: Number(process.env.DISPARO_INTERVALO_MS || 8000),
  };
}

async function fetchReWhatsSessions() {
  const config = getReWhatsConfig();
  if (!config.url || !config.apiKey) {
    return { sessoes: [], configured: false };
  }

  const response = await fetch(`${config.url}/api/sessoes`, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(`ReWhats retornou HTTP ${response.status} ao listar sessoes.`);
  }
  const data = await response.json();
  return { sessoes: Array.isArray(data?.sessoes) ? data.sessoes : [], configured: true };
}

async function dispatchCampaignInBackground(campaignId) {
  const config = getReWhatsConfig();
  const campaignData = getDispatchCampaignById(campaignId);
  const campaign = campaignData?.campanha;
  if (!campaign || !config.url || !config.apiKey) {
    return;
  }

  const pendingClients = listPendingDispatchClients(campaignId);
  for (const client of pendingClients) {
    try {
      const response = await fetch(`${config.url}/api/campanha/disparar`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          telefone: client.telefone,
          sessao: campaign.sessao_rewhats || '',
          contexto: {
            campanha_id: campaign.id,
            nome: client.nome || '',
            convenio: campaign.convenio,
            produto: client.produto,
            margem_disponivel: client.margem_disponivel,
            valor_liberado: client.valor_liberado,
            prazo: campaign.prazo,
            coeficiente: campaign.coeficiente,
            oferta_complementar: Number(client.oferta_complementar || 0) === 1,
            produto_complementar: client.produto_complementar || null,
            valor_complementar: client.valor_complementar ?? null,
          },
        }),
      });

      if (response.ok) {
        markCampaignClientSent(client.id);
      } else {
        markCampaignClientFailed(client.id, `ReWhats retornou HTTP ${response.status}`);
      }
    } catch (error) {
      markCampaignClientFailed(client.id, error instanceof Error ? error.message : 'Falha ao chamar ReWhats');
    }

    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(config.intervalMs) ? config.intervalMs : 8000));
  }

  completeDispatchCampaign(campaignId);
}

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", 'data:', 'blob:'],
        "connect-src": ["'self'"],
        "frame-ancestors": ["'none'"],
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);
app.use(globalRateLimit);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedCorsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
    credentials: false,
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    app: process.env.APP_NAME || 'Relianse CRM',
    service: 'relianse-crm-backend',
    build: BUILD_VERSION,
    db: getDb().name,
  });
});

app.post('/api/auth/login', loginRateLimit, (req, res) => {
  const login = String(req.body.login || req.body.username || '').trim();
  try {
    const password = String(req.body.password || '').trim();
    if (!login || !password) {
      return res.status(400).json({ message: 'Informe login e senha.' });
    }

    const result = loginWithCredentials({ login, password });
    try {
      writeAuditLog({
        actorUserId: result.user?.id,
        action: 'auth.login_success',
        entityType: 'user',
        entityId: String(result.user?.id || ''),
        metadata: { login },
        ipAddress: requestIp(req),
      });
    } catch (auditError) {
      console.warn('[AUDIT] auth.login_success failed:', auditError instanceof Error ? auditError.message : auditError);
    }
    return res.json(result);
  } catch (error) {
    try {
      writeAuditLog({
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: '',
        metadata: { login },
        ipAddress: requestIp(req),
      });
    } catch (auditError) {
      console.warn('[AUDIT] auth.login_failed failed:', auditError instanceof Error ? auditError.message : auditError);
    }
    return res.status(401).json({
      message: error instanceof Error ? error.message : 'Login ou senha invalidos.',
    });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  return res.json({ user: req.user });
});

app.post('/api/auth/logout', (_req, res) => {
  return res.json({ message: 'Logout realizado com sucesso.' });
});

app.post('/api/campanhas/status', (req, res) => {
  if (!campaignWebhookAuthorized(req)) {
    return res.status(401).json({ message: 'Webhook de campanha nao autorizado.' });
  }

  try {
    const campanhaId = String(req.body.campanha_id || req.body.campanhaId || '').trim();
    const telefone = String(req.body.telefone || req.body.phone || '').trim();
    const status = String(req.body.status || '').trim();
    if (!campanhaId || !telefone || !status) {
      return res.status(400).json({ message: 'campanha_id, telefone e status sao obrigatorios.' });
    }

    const campaign = updateCampaignClientStatusFromWebhook({ campanhaId, telefone, status });
    return res.json({ ok: true, campanha: campaign?.campanha || null });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao atualizar status da campanha.' });
  }
});

app.post('/api/documentos/recebido', (req, res) => {
  if (!campaignWebhookAuthorized(req)) {
    return res.status(401).json({ message: 'Webhook de documentos nao autorizado.' });
  }

  try {
    const campanhaId = String(req.body.campanha_id || req.body.campanhaId || '').trim();
    const telefone = String(req.body.telefone || req.body.phone || '').trim();
    const tipoDocumento = String(req.body.tipo_documento || req.body.tipoDocumento || 'outro').trim();
    const nomeArquivo = String(req.body.nome_arquivo || req.body.nomeArquivo || '').trim();
    if (!campanhaId || !telefone || !nomeArquivo) {
      return res.status(400).json({ message: 'campanha_id, telefone e nome_arquivo sao obrigatorios.' });
    }

    const result = registerReceivedDocument({
      campanhaId,
      telefone,
      tipoDocumento,
      nomeArquivo,
      caminho: String(req.body.caminho || ''),
      mimetype: String(req.body.mimetype || ''),
      recebidoEm: String(req.body.recebido_em || new Date().toISOString()),
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao registrar documento.' });
  }
});

app.use('/api', authMiddleware);
app.post('/api/auth/change-password', (req, res) => {
  try {
    const currentUser = req.user;
    if (!currentUser) {
      return res.status(401).json({ message: 'Faça login para continuar.' });
    }

    const currentPassword = String(req.body.currentPassword || '').trim();
    const newPassword = String(req.body.newPassword || '').trim();
    const confirmPassword = String(req.body.confirmPassword || '').trim();

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: 'Preencha todos os campos da senha.' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: 'As senhas não conferem.' });
    }

    const user = getUserById(Number(currentUser.id));
    if (!user) {
      return res.status(404).json({ message: 'Usuário não encontrado.' });
    }
    if (!verifyPassword(currentPassword, user.password_hash)) {
      return res.status(400).json({ message: 'Senha atual incorreta.' });
    }

    updateUserPasswordRecord(user.id, hashPassword(newPassword));
    return res.json({ message: 'Senha alterada com sucesso.' });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao alterar a senha.' });
  }
});
app.get('/api/clients/:id/consent/:channel', (req, res) => {
  const channel = String(req.params.channel || 'whatsapp').trim().toLowerCase();
  const consent = getActiveConsent(Number(req.params.id), channel);
  return res.json({ allowed: Boolean(consent), consent: consent || null });
});

app.post('/api/clients/:id/consent/:channel', requirePrivilegedRole, (req, res) => {
  const channel = String(req.params.channel || 'whatsapp').trim().toLowerCase();
  const consent = grantCustomerConsent({
    customerId: Number(req.params.id),
    channel,
    source: String(req.body.source || 'internal_manual'),
    ipAddress: requestIp(req),
    userAgent: String(req.get('user-agent') || ''),
    consentTextVersion: String(req.body.consent_text_version || req.body.consentTextVersion || 'internal-v1'),
    actorUserId: getAuthenticatedUserId(req),
  });
  return res.json({ consent });
});

app.post('/api/clients/:id/consent/:channel/revoke', requirePrivilegedRole, (req, res) => {
  const channel = String(req.params.channel || 'whatsapp').trim().toLowerCase();
  const consent = revokeCustomerConsent({
    customerId: Number(req.params.id),
    channel,
    actorUserId: getAuthenticatedUserId(req),
    ipAddress: requestIp(req),
    source: String(req.body.source || 'internal_opt_out'),
  });
  return res.json({ consent });
});
app.use('/api/users', roleMiddleware(['gerencial']));
app.use('/api/bases', roleMiddleware(['gerencial']));
app.use('/api/upload', roleMiddleware(['gerencial']));
app.use('/api/settings', roleMiddleware(['gerencial']));
app.use('/api/reports', roleMiddleware(['gerencial']));
app.use('/api/ribeirao', roleMiddleware(['gerencial']));
app.use('/api/phone-lookup', roleMiddleware(['gerencial']));
app.use('/api/documentos', roleMiddleware(['gerencial']));
app.use('/api/rewhats', roleMiddleware(['gerencial']));
app.use('/api/credentials', roleMiddleware(['gerencial']));

app.get('/api/credentials/portals', requirePrivilegedRole, (_req, res) => {
  return res.json({ portals: getCredentialPortals() });
});

app.get('/api/margin-portals', requirePrivilegedRole, (_req, res) => {
  return res.json({ portals: getMarginPortalConfigs() });
});

app.get('/api/credentials', requirePrivilegedRole, (_req, res) => {
  return res.json({ credentials: listCredentials() });
});

app.get('/api/credentials/logs', requirePrivilegedRole, (req, res) => {
  return res.json({ rows: getCredentialLogs(req.query || {}) });
});

app.post('/api/credentials', requirePrivilegedRole, (req, res) => {
  try {
    const credential = saveCredential(req.body || {}, getAuthenticatedUserId(req));
    return res.json({ credential });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao salvar credencial.' });
  }
});

app.put('/api/credentials/:id', requirePrivilegedRole, (req, res) => {
  try {
    const credential = updateCredential(Number(req.params.id), req.body || {}, getAuthenticatedUserId(req));
    if (!credential) {
      return res.status(404).json({ message: 'Credencial não encontrada.' });
    }
    return res.json({ credential });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao atualizar credencial.' });
  }
});

app.post('/api/credentials/:id/test', requirePrivilegedRole, async (req, res) => {
  try {
    const credential = await testCredential(Number(req.params.id), getAuthenticatedUserId(req));
    return res.json({ credential });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao testar credencial.' });
  }
});

app.post('/api/credentials/:id/assisted-login', requirePrivilegedRole, (req, res) => {
  try {
    const result = startAssistedLogin(Number(req.params.id), getAuthenticatedUserId(req));
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao iniciar login assistido.' });
  }
});

app.post('/api/credentials/:id/confirm-assisted-login', requirePrivilegedRole, (req, res) => {
  try {
    const credential = confirmAssistedLogin(Number(req.params.id), getAuthenticatedUserId(req));
    return res.json({ credential });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao confirmar sessão assistida.' });
  }
});

app.post('/api/santana/query', requirePrivilegedRole, sensitiveLookupRateLimit, async (req, res) => {
  try {
    const portalId = normalizePortalId(req.body.portal_id || req.body.portalId || 'prefeitura_santana_parnaiba');
    const portalConfig = getPortalConfig(portalId);
    if (!isRf1ApiPortal(portalId)) {
      return res.status(400).json({
        success: false,
        code: 'PORTAL_NOT_RF1',
        message: 'Este endpoint atende apenas portais RF1.',
      });
    }
    const credential = getCredentialSecretByPortal(portalId);
    if (!credential?.login || !credential?.password) {
      return res.status(409).json({
        success: false,
        code: 'CREDENTIAL_NOT_CONFIGURED',
        message: `Cadastre a credencial de ${portalConfig?.name || 'este portal'} na Central de Credenciais.`,
      });
    }
    const apiBaseUrl = inferSantanaApiBaseUrl({
      apiBaseUrl: credential.api_url || portalConfig?.apiBaseUrl,
      portalUrl: credential.portal_url,
    });
    const response = apiBaseUrl
      ? { result: await querySantanaCpf({
        apiBaseUrl,
        login: credential.login,
        password: credential.password,
        cpf: req.body.cpf,
      }) }
      : await runSantanaPortalCommand({
        action: 'query',
      login: credential.login,
      password: credential.password,
      cpf: req.body.cpf,
    });
    return res.json({ success: true, result: response.result });
  } catch (error) {
    const status = Number(error?.status || 400);
    return res.status(status).json({
      success: false,
      code: String(error?.code || 'SANTANA_API_ERROR'),
      message: error instanceof Error ? error.message : 'Falha ao consultar a API RF1.',
    });
  }
});

app.post('/api/santana/batch', requirePrivilegedRole, sensitiveLookupRateLimit, (req, res) => {
  try {
    const portalId = normalizePortalId(req.body.portal_id || req.body.portalId || 'prefeitura_santana_parnaiba');
    const portalConfig = getPortalConfig(portalId);
    if (!isRf1ApiPortal(portalId)) {
      return res.status(400).json({ message: 'Este endpoint atende apenas portais RF1.' });
    }
    const credential = getCredentialSecretByPortal(portalId);
    if (!credential?.login || !credential?.password) {
      return res.status(409).json({ message: `Cadastre a credencial de ${portalConfig?.name || 'este portal'} na Central de Credenciais.` });
    }
    const cpfs = Array.isArray(req.body.cpfs) ? req.body.cpfs : [];
    if (!cpfs.length) {
      return res.status(400).json({ message: 'Informe ao menos um CPF para o lote RF1.' });
    }
    const apiBaseUrl = inferSantanaApiBaseUrl({
      apiBaseUrl: credential.api_url || portalConfig?.apiBaseUrl,
      portalUrl: credential.portal_url,
    });
    const batch = startSantanaBatch({
      userId: getAuthenticatedUserId(req),
      portalId,
      sourceFileName: String(req.body.source_file_name || ''),
      cpfs,
      login: credential.login,
      password: credential.password,
      apiBaseUrl,
      mode: apiBaseUrl ? 'api' : 'portal',
    });
    return res.json({ message: `Lote ${portalConfig?.name || 'RF1'} iniciado.`, batch });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao iniciar lote RF1.' });
  }
});

app.get('/api/santana/batch/history', requirePrivilegedRole, (req, res) => {
  return res.json({ batches: getSantanaBatchHistory(Number(req.query.limit || 20), normalizePortalId(req.query.portal_id || req.query.portalId || '')) });
});

app.get('/api/santana/batch/:id/status', requirePrivilegedRole, (req, res) => {
  const batch = getSantanaBatchStatus(Number(req.params.id));
  if (!batch) return res.status(404).json({ message: 'Lote RF1 não encontrado.' });
  return res.json({ batch });
});

app.get('/api/santana/batch/:id/export', requirePrivilegedRole, (req, res) => {
  const buffer = exportSantanaBatchXlsx(Number(req.params.id));
  if (!buffer) return res.status(404).json({ message: 'Lote RF1 não encontrado.' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="lote-rf1-${req.params.id}.xlsx"`);
  return res.send(buffer);
});

app.get('/api/coeficiente/hoje', (_req, res) => {
  return res.json(getTodayCampaignCoefficient());
});

app.get('/api/coeficiente/bancos/hoje', requirePrivilegedRole, (_req, res) => {
  return res.json(getTodayBankCoefficients());
});

app.post('/api/coeficiente/bancos', requirePrivilegedRole, (req, res) => {
  try {
    const saved = saveBankCoefficient({
      convenio: String(req.body.convenio || ''),
      banco: String(req.body.banco || ''),
      bancoLabel: String(req.body.banco_label || req.body.bancoLabel || req.body.banco || ''),
      produto: String(req.body.produto || 'consignado'),
      coeficiente: req.body.coeficiente,
      taxa: req.body.taxa ?? null,
      prazo: req.body.prazo,
      primeiroVencimentoDias: req.body.primeiro_vencimento_dias ?? req.body.primeiroVencimentoDias ?? null,
      status: String(req.body.status || 'ativo'),
      cadastradoPor: String(req.user?.name || req.get('x-crm-user-name') || 'sistema'),
    });
    writeAuditLog({
      actorUserId: getAuthenticatedUserId(req),
      action: 'campaign.bank_coefficient_saved',
      entityType: 'coeficientes_banco_dia',
      entityId: `${req.body.convenio || ''}:${req.body.banco || ''}`,
      metadata: {
        convenio: String(req.body.convenio || ''),
        banco: String(req.body.banco || ''),
        produto: String(req.body.produto || 'consignado'),
        prazo: req.body.prazo,
      },
      ipAddress: requestIp(req),
    });
    return res.json(saved);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao salvar coeficiente do banco.' });
  }
});

app.post('/api/coeficiente', requirePrivilegedRole, (req, res) => {
  try {
    const coeficiente = Number(req.body.coeficiente);
    const prazo = Number(req.body.prazo);
    if (!Number.isFinite(coeficiente) || coeficiente <= 0 || !Number.isFinite(prazo) || prazo <= 0) {
      return res.status(400).json({ message: 'Informe coeficiente e prazo validos.' });
    }

    const saved = saveCampaignCoefficient({
      coeficiente,
      prazo,
      cadastradoPor: String(req.user?.name || req.get('x-crm-user-name') || 'sistema'),
    });
    writeAuditLog({
      actorUserId: getAuthenticatedUserId(req),
      action: 'campaign.coefficient_saved',
      entityType: 'coeficientes_dia',
      entityId: String(saved.id || saved.data || ''),
      metadata: { data: saved.data, prazo: saved.prazo },
      ipAddress: requestIp(req),
    });
    return res.json(saved);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao salvar coeficiente.' });
  }
});

app.get('/api/campanhas/oportunidades', requirePrivilegedRole, (req, res) => {
  try {
    return res.json(listCampaignOpportunities(req.query || {}));
  } catch (error) {
    const status = error?.code === 'COEFFICIENT_REQUIRED' ? 400 : 500;
    return res.status(status).json({ message: error instanceof Error ? error.message : 'Falha ao listar oportunidades.' });
  }
});

app.get('/api/rewhats/sessoes', requirePrivilegedRole, async (_req, res) => {
  try {
    return res.json(await fetchReWhatsSessions());
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao listar sessoes do ReWhats.' });
  }
});

app.get('/api/campanhas', requirePrivilegedRole, (_req, res) => {
  return res.json({ campanhas: listDispatchCampaigns() });
});

app.post('/api/campanhas', requirePrivilegedRole, (req, res) => {
  try {
    const nome = String(req.body.nome || req.body.name || '').trim();
    const clientes = Array.isArray(req.body.clientes) ? req.body.clientes : [];
    if (!nome || clientes.length === 0) {
      return res.status(400).json({ message: 'Informe nome e ao menos um cliente para criar a campanha.' });
    }

    const campaign = createDispatchCampaign({
      nome,
      convenio: String(req.body.convenio || 'todos'),
      sessao_rewhats: String(req.body.sessao_rewhats || req.body.session || ''),
      banco: String(req.body.banco || 'banco_futuro'),
      produto: String(req.body.produto || ''),
      faixa_valor: String(req.body.faixa_valor || ''),
      mensagem_inicial: String(req.body.mensagem_inicial || 'Oie, {nome} 👋 é a Aline, tudo bem?'),
      followup_mensagem: String(req.body.followup_mensagem || ''),
      followup_intervalo_horas: Number(req.body.followup_intervalo_horas || 0),
      janela_inicio: String(req.body.janela_inicio || '08:00'),
      janela_fim: String(req.body.janela_fim || '20:00'),
      intervalo_envios_segundos: Number(req.body.intervalo_envios_segundos || 8),
      incluir_idade_nao_encontrada: Boolean(req.body.incluir_idade_nao_encontrada),
      apenas_com_telefone: req.body.apenas_com_telefone !== false,
      excluir_opt_out: req.body.excluir_opt_out !== false,
      correntista_santander: Boolean(req.body.correntista_santander),
      conta_diferente_holerite: Boolean(req.body.conta_diferente_holerite),
      clientes,
    });
    writeAuditLog({
      actorUserId: getAuthenticatedUserId(req),
      action: 'campaign.dispatch_created',
      entityType: 'campanhas_crm',
      entityId: String(campaign?.campanha?.id || ''),
      metadata: { total: clientes.length },
      ipAddress: requestIp(req),
    });
    return res.json({ sucesso: true, campanha_id: campaign?.campanha?.id, ...campaign });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao criar campanha.' });
  }
});

app.get('/api/campanhas/:id', requirePrivilegedRole, (req, res) => {
  const campaign = getDispatchCampaignById(req.params.id);
  if (!campaign) {
    return res.status(404).json({ message: 'Campanha nao encontrada.' });
  }
  return res.json(campaign);
});

app.post('/api/campanhas/:id/disparar', requirePrivilegedRole, (req, res) => {
  try {
    const config = getReWhatsConfig();
    if (!config.url || !config.apiKey) {
      return res.status(400).json({ message: 'Configure REWHATS_URL e REWHATS_API_KEY antes de disparar.' });
    }

    const campaign = startDispatchCampaign(req.params.id);
    if (!campaign) {
      return res.status(404).json({ message: 'Campanha nao encontrada.' });
    }
    const pending = listPendingDispatchClients(req.params.id);
    void dispatchCampaignInBackground(req.params.id);
    return res.json({ sucesso: true, total_pendentes: pending.length, campanha: campaign.campanha });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao iniciar disparos.' });
  }
});

app.post('/api/campanhas/:id/dry-run', requirePrivilegedRole, (req, res) => {
  const result = runCampaignDryRun(req.params.id);
  if (!result) {
    return res.status(404).json({ message: 'Campanha nao encontrada.' });
  }
  return res.json(result);
});

app.get('/api/campanhas/:id/dry-runs', requirePrivilegedRole, (req, res) => {
  return res.json({ dry_runs: listCampaignDryRuns(req.params.id) });
});

app.put('/api/campanhas/:id/status', requirePrivilegedRole, (req, res) => {
  try {
    const result = updateCampaignPreDispatchStatus(req.params.id, req.body.status);
    if (!result) {
      return res.status(404).json({ message: 'Campanha nao encontrada.' });
    }
    return res.json(result);
  } catch (error) {
    const status = error?.code === 'STATUS_BLOCKED' ? 403 : 400;
    return res.status(status).json({
      message: error instanceof Error ? error.message : 'Falha ao atualizar status.',
      status_recebido: req.body.status,
    });
  }
});

app.post('/api/documentos/conta-digital', requirePrivilegedRole, (req, res) => {
  try {
    const campanhaId = String(req.body.campanha_id || req.body.campanhaId || '').trim();
    const telefone = String(req.body.telefone || '').trim();
    if (!campanhaId || !telefone) {
      return res.status(400).json({ message: 'campanha_id e telefone sao obrigatorios.' });
    }
    const result = markDigitalAccountForDocuments({ campanhaId, telefone });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao marcar conta digital.' });
  }
});

app.get('/api/documentos/checklist/:campanhaId/:telefone', requirePrivilegedRole, (req, res) => {
  const result = getDocumentChecklist(req.params.campanhaId, req.params.telefone);
  if (!result) {
    return res.status(404).json({ message: 'Checklist nao encontrado.' });
  }
  return res.json(result);
});

app.put('/api/documentos/:id/validar', requirePrivilegedRole, (req, res) => {
  try {
    const document = validateClientDocument(req.params.id, String(req.body.status || 'recebido'), String(req.body.observacao || ''));
    if (!document) {
      return res.status(404).json({ message: 'Documento nao encontrado.' });
    }
    return res.json({ ok: true, document });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao validar documento.' });
  }
});

app.get('/api/documentos/campanha/:campanhaId', requirePrivilegedRole, (req, res) => {
  return res.json(listCampaignDocumentChecklists(req.params.campanhaId));
});

app.get('/api/documentos/document-ai/status', requirePrivilegedRole, (_req, res) => {
  return res.json(getDocumentAiStatus());
});

app.get('/api/documentos/arquivo/:id', requirePrivilegedRole, async (req, res) => {
  try {
    const document = getDb().prepare('SELECT * FROM documentos_clientes WHERE id = ?').get(Number(req.params.id));
    if (!document?.url_arquivo) {
      return res.status(404).json({ message: 'Arquivo nao encontrado.' });
    }
    const response = await fetch(document.url_arquivo, {
      headers: {
        Authorization: `Bearer ${process.env.REWHATS_API_KEY || ''}`,
      },
    });
    if (!response.ok) {
      return res.status(response.status).json({ message: 'Falha ao buscar arquivo no ReWhats.' });
    }
    const contentType = response.headers.get('content-type') || document.mimetype || 'application/octet-stream';
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${String(document.nome_arquivo || 'documento').replace(/"/g, '')}"`);
    return res.send(buffer);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao abrir arquivo.' });
  }
});

app.post('/api/documentos/:id/processar-ai', requirePrivilegedRole, async (req, res) => {
  const document = getClientDocumentById(req.params.id);
  if (!document?.url_arquivo) {
    return res.status(404).json({ message: 'Documento nao encontrado ou sem arquivo vinculado.' });
  }

  try {
    const response = await fetch(document.url_arquivo, {
      headers: {
        Authorization: `Bearer ${process.env.REWHATS_API_KEY || ''}`,
      },
    });
    if (!response.ok) {
      throw new Error(`ReWhats retornou HTTP ${response.status} ao buscar arquivo.`);
    }
    const mimeType = response.headers.get('content-type') || document.mimetype || 'application/pdf';
    const buffer = Buffer.from(await response.arrayBuffer());
    const aiResult = await processDocumentWithGoogleAi({ buffer, mimeType });
    const saved = saveDocumentAiResult(document.id, {
      status: 'processado',
      text: aiResult.text,
      data: aiResult,
    });
    return res.json({ ok: true, document: saved, result: aiResult });
  } catch (error) {
    const saved = saveDocumentAiResult(document.id, {
      status: 'erro',
      error: error instanceof Error ? error.message : 'Falha ao processar Document AI.',
    });
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao processar Document AI.', document: saved });
  }
});

app.get('/api/users', (_req, res) => {
  res.json({ users: getUsers() });
});

app.post('/api/users', (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const login = String(req.body.login || '').trim().toLowerCase();
    const password = String(req.body.password || '').trim();
    const role = String(req.body.role || 'vendedor').trim().toLowerCase();
    const isActive = req.body.is_active !== false && req.body.isActive !== false;

    if (!name) {
      return res.status(400).json({ message: 'Informe o nome do usuario.' });
    }
    if (!login) {
      return res.status(400).json({ message: 'Informe o login do usuario.' });
    }
    if (!password) {
      return res.status(400).json({ message: 'Informe a senha do usuario.' });
    }
    if (getUserByLogin(login)) {
      return res.status(400).json({ message: 'Login já cadastrado.' });
    }

    const user = createUserRecord({
      name,
      login,
      passwordHash: hashPassword(password),
      role,
      isActive,
    });

    return res.json({ user });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao cadastrar usuário.' });
  }
});

app.put('/api/users/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body.name || '').trim();
    const login = String(req.body.login || '').trim().toLowerCase();
    const role = String(req.body.role || '').trim().toLowerCase();
    const isActive = req.body.is_active !== undefined ? Boolean(req.body.is_active) : req.body.isActive !== undefined ? Boolean(req.body.isActive) : undefined;

    const current = getUserById(id);
    if (!current) {
      return res.status(404).json({ message: 'Usuario nao encontrado.' });
    }

    const duplicate = login && getUserByLogin(login);
    if (duplicate && Number(duplicate.id) !== id) {
      return res.status(400).json({ message: 'Login já cadastrado.' });
    }

    const user = updateUserRecord(id, {
      name: name || current.name,
      login: login || current.login,
      role: role || current.role,
      isActive,
    });

    return res.json({ user });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao atualizar usuário.' });
  }
});

app.post('/api/users/:id/password', (req, res) => {
  try {
    const id = Number(req.params.id);
    const password = String(req.body.password || '').trim();
    const confirmPassword = String(req.body.confirm_password || req.body.confirmPassword || '').trim();

    if (!password) {
      return res.status(400).json({ message: 'Informe a nova senha.' });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ message: 'As senhas precisam ser iguais.' });
    }

    const user = updateUserPasswordRecord(id, hashPassword(password));
    if (!user) {
      return res.status(404).json({ message: 'Usuario nao encontrado.' });
    }

    return res.json({ user });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao atualizar senha.' });
  }
});

app.post('/api/users/:id/toggle-active', (req, res) => {
  try {
    const id = Number(req.params.id);
    const current = getUserById(id);
    if (!current) {
      return res.status(404).json({ message: 'Usuario nao encontrado.' });
    }

    const user = updateUserRecord(id, {
      name: current.name,
      login: current.login,
      role: current.role,
      isActive: !current.is_active,
    });

    return res.json({ user });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao atualizar usuário.' });
  }
});

app.get('/api/campaigns', (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const role = getRequestRole(req);
  const includeArchived = req.query.include_archived;
  const campaigns = getCampaigns({
    user_id: userId,
    role,
    include_archived: includeArchived,
  });
  return res.json({ campaigns });
});

app.get('/api/campaigns/:id', (req, res) => {
  const id = Number(req.params.id);
  const campaign = getCampaignById(id, {
    user_id: getAuthenticatedUserId(req),
    role: getRequestRole(req),
    include_archived: req.query.include_archived,
  });
  if (!campaign) {
    return res.status(404).json({ message: 'Campanha nao encontrada.' });
  }
  return res.json({ campaign });
});

app.post('/api/campaigns', requirePrivilegedRole, (req, res) => {
  try {
    const campaign = createCampaignRecord({
      name: String(req.body.name || req.body.nome || '').trim(),
      convenio: String(req.body.convenio || req.body.orgao || '').trim(),
      description: String(req.body.description || req.body.descricao || '').trim(),
      product_focus: String(req.body.product_focus || req.body.productFocus || 'outros').trim(),
      status: String(req.body.status || 'active').trim(),
      internal_notes: String(req.body.internal_notes || req.body.internalNotes || '').trim(),
      file_name: String(req.body.file_name || req.body.fileName || '').trim(),
      user_ids: Array.isArray(req.body.user_ids) ? req.body.user_ids : [],
      role: String(req.body.role || 'vendedor').trim(),
    }, getAuthenticatedUserId(req));
    if (!campaign) {
      return res.status(400).json({ message: 'Informe o nome da campanha.' });
    }
    return res.json({ campaign });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao cadastrar campanha.' });
  }
});

app.put('/api/campaigns/:id', requirePrivilegedRole, (req, res) => {
  try {
    const id = Number(req.params.id);
    const campaign = updateCampaignRecord(id, {
      name: String(req.body.name || req.body.nome || '').trim(),
      convenio: String(req.body.convenio || req.body.orgao || '').trim(),
      description: String(req.body.description || req.body.descricao || '').trim(),
      product_focus: String(req.body.product_focus || req.body.productFocus || 'outros').trim(),
      status: String(req.body.status || 'active').trim(),
      internal_notes: String(req.body.internal_notes || req.body.internalNotes || '').trim(),
      file_name: String(req.body.file_name || req.body.fileName || '').trim(),
      user_ids: Array.isArray(req.body.user_ids) ? req.body.user_ids : undefined,
      role: String(req.body.role || 'vendedor').trim(),
    });
    if (!campaign) {
      return res.status(404).json({ message: 'Campanha nao encontrada.' });
    }
    return res.json({ campaign });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao atualizar campanha.' });
  }
});

app.post('/api/campaigns/:id/archive', requirePrivilegedRole, (req, res) => {
  try {
    const id = Number(req.params.id);
    const archived = req.body.archived !== false;
    const campaign = archiveCampaignRecord(id, archived);
    if (!campaign) {
      return res.status(404).json({ message: 'Campanha nao encontrada.' });
    }
    return res.json({ campaign });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao arquivar campanha.' });
  }
});

app.post('/api/campaigns/:id/users', requirePrivilegedRole, (req, res) => {
  try {
    const id = Number(req.params.id);
    const userIds = Array.isArray(req.body.user_ids) ? req.body.user_ids : [];
    const role = String(req.body.role || 'vendedor').trim();
    const campaignUsers = setCampaignUsers(id, userIds, role);
    return res.json({ campaignUsers });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao atualizar vendedores da campanha.' });
  }
});

app.get('/api/bases', (req, res) => {
  res.json({ bases: getBases(req.query || {}) });
});

app.post('/api/bases/:id/rename', (req, res) => {
  const id = Number(req.params.id);
  const base = renameBase(id, String(req.body.nome_base || req.body.name || ''));
  if (!base) {
    return res.status(404).json({ message: 'Base não encontrada.' });
  }
  return res.json({ base });
});

app.post('/api/bases/:id/archive', (req, res) => {
  const id = Number(req.params.id);
  const archived = req.body.archived !== false;
  const base = archiveBase(id, archived);
  if (!base) {
    return res.status(404).json({ message: 'Base não encontrada.' });
  }
  return res.json({ base });
});

app.get('/api/settings', (_req, res) => {
  res.json({ settings: getSettings() });
});

app.post('/api/settings', (req, res) => {
  const settings = saveSettings(req.body || {});
  res.json({ settings });
});

app.get('/api/ribeirao/config', requirePrivilegedRole, (_req, res) => {
  return res.json({ config: getRibeiraoConfigStatus() });
});

app.get('/api/ribeirao/diagnostics', requirePrivilegedRole, (_req, res) => {
  return res.json({ diagnostics: getRibeiraoDiagnostics() });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Envie um arquivo válido.' });
    }

    const mode = String(req.body.mode || 'import').toLowerCase();
    const baseInput = {
      nome_base: String(req.body.nome_base || req.body.baseName || req.body.campaignName || '').trim(),
      tipo_base: String(req.body.tipo_base || req.body.baseType || '').trim(),
      convenio: String(req.body.convenio || req.body.orgao || req.body.convenio_orgao || '').trim(),
      estado: String(req.body.estado || req.body.state || '').trim(),
      cidade: String(req.body.cidade || req.body.city || '').trim(),
      notes: String(req.body.notes || req.body.observacao || req.body.observation || req.body.internal_notes || '').trim(),
      campaign_id: req.body.campaign_id || req.body.campaignId || null,
      campaign_name: String(req.body.campaign_name || '').trim(),
      auto_margin: req.body.auto_margin ?? req.body.autoMargin ?? '',
    };

    if (mode === 'preview' || mode === 'validate') {
      const analysis = analyzeSpreadsheet(req.file.buffer, req.file.originalname);
      return res.json({
        mode: 'preview',
        file: {
          name: req.file.originalname,
          size: req.file.size,
          mime: req.file.mimetype,
        },
        analysis,
      });
    }

    const importResult = saveImportedSpreadsheet(req.file.buffer, req.file.originalname, baseInput);
    const automationPlan = buildUploadAutomationPlan({ baseInput, importResult });
    if (automationPlan.status === 'queued') {
      void runUploadAutomation({
        plan: automationPlan,
        userId: getAuthenticatedUserId(req),
      });
    }

    return res.json({
      mode: 'import',
      message:
        automationPlan.status === 'queued'
          ? 'Lista importada com sucesso. Consulta de margem iniciada automaticamente.'
          : 'Lista importada com sucesso.',
      redirectTo: isEsteiraImport(baseInput) ? '/esteira-inteligente' : '/fila',
      result: importResult,
      automation: publicAutomationPlan(automationPlan),
    });
  } catch (error) {
    return res.status(400).json({
      message: error instanceof Error ? error.message : 'Falha ao processar a planilha.',
    });
  }
});

app.get('/api/clients', (req, res) => {
  const data = listClients(req.query || {});
  res.json(data);
});

app.get('/api/clients/export', requirePrivilegedRole, (req, res) => {
  const data = listClients({ ...(req.query || {}), include_archived: req.query?.include_archived || '1' });
  const rows = (data.clients || []).map((client) => {
    const phones = client.phones || [];
    const primary = phones.find((phone) => phone.is_primary) || phones[0] || null;
    const enrichment = client.nova_vida_data || {};
    const address = enrichment.addresses?.[0] || {};
    return {
      CPF: client.cpf || '',
      Nome: client.name || '',
      data_nascimento: enrichment.birth_date || '',
      idade: enrichment.age ?? '',
      sexo: enrichment.gender || '',
      nome_mae: enrichment.mother_name || '',
      nome_pai: enrichment.father_name || '',
      email_nova_vida: enrichment.email || enrichment.emails?.[0] || '',
      endereco_completo: address.address_full || enrichment.address_full || '',
      rua: address.street || enrichment.street || '',
      numero: address.number || enrichment.number || '',
      complemento: address.complement || enrichment.complement || '',
      bairro: address.district || enrichment.district || '',
      cidade: address.city || enrichment.city || '',
      uf: address.state || enrichment.state || '',
      cep: address.zipcode || enrichment.zipcode || '',
      Telefone: client.phone || '',
      telefone_principal: primary?.normalized_phone || primary?.phone_number || client.phone || '',
      telefones_encontrados: phones.map((phone) => phone.normalized_phone || phone.phone_number).filter(Boolean).join('; '),
      origem_telefone: primary?.source || '',
      origem_dados: enrichment.source || primary?.source || '',
      qualidade_telefone: primary?.quality || '',
      data_busca_telefone: primary?.searched_at_formatted || primary?.searched_at || '',
      data_consulta_nova_vida: enrichment.searched_at_formatted || enrichment.searched_at || client.nova_vida_last_lookup_at || '',
      Status: client.status_label || client.status_atendimento || client.status || '',
      Consulta: client.consulta_status_label || client.consulta_status || '',
      Campanha: client.campaign_name || '',
      Base: client.base_name || '',
      Melhor_produto: client.best_product_label || '',
      Melhor_margem: client.best_net_margin_formatted || '',
    };
  });
  const workbook = xlsx.utils.book_new();
  const sheet = xlsx.utils.json_to_sheet(rows);
  xlsx.utils.book_append_sheet(workbook, sheet, 'Clientes');
  const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="clientes-com-telefones.xlsx"');
  return res.send(buffer);
});

app.get('/api/clients/next', (req, res) => {
  const next = getNextClient(req.query || {});
  res.json({ next });
});

app.get('/api/clients/:id', (req, res) => {
  const id = Number(req.params.id);
  const client = getClientById(id);
  if (!client) {
    return res.status(404).json({ message: 'Cliente não encontrado.' });
  }
  res.json(client);
});

app.post('/api/clients/:id/start', (req, res) => {
  const id = Number(req.params.id);
  const userId = getAuthenticatedUserId(req);
  const currentClient = getClientById(id);
  if (!currentClient) {
    return res.status(404).json({ message: 'Cliente não encontrado.' });
  }
  const requesterRole = getRequestRole(req);
  if (
    currentClient.client?.assigned_to &&
    Number(currentClient.client.assigned_to) !== userId &&
    requesterRole !== 'gerencial'
  ) {
    return res.status(403).json({ message: 'Este atendimento já está com outro vendedor.' });
  }
  const result = startAttendance(id, userId);
  if (!result) {
    return res.status(404).json({ message: 'Cliente não encontrado.' });
  }
  return res.json(result);
});

app.post('/api/clients/:id/interactions', (req, res) => {
  const id = Number(req.params.id);
  const userId = getAuthenticatedUserId(req);
  const result = addInteraction(id, {
    userId,
    type: String(req.body.type || 'observacao'),
    note: String(req.body.note || ''),
    private_note: String(req.body.private_note || req.body.privateNote || ''),
  });

  if (!result) {
    return res.status(404).json({ message: 'Cliente não encontrado.' });
  }

  return res.json(result);
});

app.post('/api/clients/:id/schedule-return', (req, res) => {
  const id = Number(req.params.id);
  const userId = getAuthenticatedUserId(req);
  const returnAt = String(req.body.return_at || req.body.returnAt || '');
  if (!returnAt) {
    return res.status(400).json({ message: 'Informe a data e hora do retorno.' });
  }

  const result = scheduleReturn(id, {
    userId,
    return_at: returnAt,
    note: String(req.body.note || ''),
    private_note: String(req.body.private_note || req.body.privateNote || ''),
  });

  if (!result) {
    return res.status(404).json({ message: 'Cliente não encontrado.' });
  }

  return res.json(result);
});

app.post('/api/clients/:id/finalize', (req, res) => {
  const id = Number(req.params.id);
  const userId = getAuthenticatedUserId(req);
  const result = finalizeClient(id, {
    userId,
    note: String(req.body.note || ''),
    private_note: String(req.body.private_note || req.body.privateNote || ''),
  });

  if (!result) {
    return res.status(404).json({ message: 'Cliente não encontrado.' });
  }

  return res.json(result);
});

app.post('/api/clients/:id/no-interest', (req, res) => {
  const id = Number(req.params.id);
  const userId = getAuthenticatedUserId(req);
  const result = markNoInterest(id, {
    userId,
    note: String(req.body.note || ''),
    private_note: String(req.body.private_note || req.body.privateNote || ''),
  });

  if (!result) {
    return res.status(404).json({ message: 'Cliente não encontrado.' });
  }

  return res.json(result);
});

app.post('/api/clients/:id/converted', (req, res) => {
  const id = Number(req.params.id);
  const userId = getAuthenticatedUserId(req);
  const result = convertClient(id, {
    userId,
    bank: String(req.body.bank || ''),
    amount: Number(req.body.amount || 0),
    installment: Number(req.body.installment || 0),
    term: Number(req.body.term || 0),
    note: String(req.body.note || ''),
    private_note: String(req.body.private_note || req.body.privateNote || ''),
  });

  if (!result) {
    return res.status(404).json({ message: 'Cliente não encontrado.' });
  }

  return res.json(result);
});

app.post('/api/clients/:id/whatsapp-open', communicationRateLimit, (req, res) => {
  const id = Number(req.params.id);
  const userId = getAuthenticatedUserId(req);
  const consent = getActiveConsent(id, 'whatsapp');
  if (!consent) {
    writeAuditLog({
      actorUserId: userId,
      action: 'communication.blocked_no_consent',
      entityType: 'client',
      entityId: String(id),
      metadata: { channel: 'whatsapp' },
      ipAddress: requestIp(req),
    });
    return res.status(403).json({
      code: 'CONSENT_REQUIRED',
      message: 'Envio bloqueado: cliente sem opt-in ativo para WhatsApp.',
    });
  }
  const result = logWhatsappOpen(id, {
    userId,
    note: String(req.body.note || 'WhatsApp Web aberto para o cliente'),
  });

  if (!result) {
    return res.status(404).json({ message: 'Cliente não encontrado.' });
  }

  return res.json({ client: result });
});

app.get('/api/clients/:id/phones', (req, res) => {
  const id = Number(req.params.id);
  if (!getClientById(id)) {
    return res.status(404).json({ message: 'Cliente não encontrado.' });
  }
  return res.json({ phones: listClientPhones(id) });
});

app.post('/api/clients/:id/phones/:phoneId/primary', (req, res) => {
  const result = setPrimaryClientPhone(Number(req.params.id), Number(req.params.phoneId));
  if (!result) {
    return res.status(404).json({ message: 'Telefone não encontrado.' });
  }
  return res.json(result);
});

app.post('/api/clients/:id/phones/:phoneId/inactivate', (req, res) => {
  const result = updateClientPhoneStatus(Number(req.params.id), Number(req.params.phoneId), 'inactive');
  if (!result) {
    return res.status(404).json({ message: 'Telefone não encontrado.' });
  }
  return res.json(result);
});

app.post('/api/clients/:id/phone-lookup', sensitiveLookupRateLimit, async (req, res) => {
  try {
    const clientId = Number(req.params.id);
    if (!Number.isInteger(clientId) || clientId <= 0) {
      return res.status(400).json({ message: 'Cliente inválido para busca de telefone.' });
    }
    const userId = getAuthenticatedUserId(req);
    const force = req.body?.force === true || String(req.body?.force || '') === '1';
    const queued = queuePhoneLookupForClient({ clientId, userId, force });
    if (queued.error) {
      return res.status(queued.status || 400).json({ message: queued.error });
    }
    if (!queued.job?.id) {
      return res.status(500).json({ message: 'Busca de telefone não foi enfileirada corretamente.' });
    }

    if (req.body?.run_now !== false) {
      const processed = await processPhoneLookupJob(queued.job.id, { userId });
      if (processed.error && processed.status && processed.status >= 500) {
        return res.status(500).json({ message: processed.error, job: processed.job });
      }
      return res.json({ job: processed.job, result: processed.result, client: processed.client });
    }

    return res.json({ job: queued.job });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : '';
    const message = /Cannot read properties/i.test(rawMessage) ? 'Falha ao preparar busca de telefone para este cliente.' : rawMessage || 'Falha na busca de telefone.';
    return res.status(500).json({ message });
  }
});

app.get('/api/phone-lookup/diagnostics', (_req, res) => {
  return res.json({ diagnostics: getPhoneLookupDiagnostics() });
});

app.post('/api/phone-lookup/provider/map', async (_req, res) => {
  try {
    return res.json(await mapPhoneLookupProvider());
  } catch (error) {
    return res.status(500).json({
      status: 'failed',
      code: 'NOVA_VIDA_MAP_ERROR',
      message: error instanceof Error ? error.message : 'Erro ao mapear fluxo Nova Vida.',
    });
  }
});

app.post('/api/phone-lookup/search', sensitiveLookupRateLimit, async (req, res) => {
  try {
    const result = await searchPhones({
      cpf: req.body?.cpf,
      name: req.body?.name,
      phone: req.body?.phone || req.body?.telefone,
      clientId: req.body?.client_id || req.body?.clientId || null,
      userId: getAuthenticatedUserId(req),
    });
    if (result.error) {
      return res.status(result.status || 400).json({ message: result.error });
    }
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error instanceof Error ? error.message : 'Falha ao consultar telefones.' });
  }
});

app.post('/api/phone-lookup/name-candidates', sensitiveLookupRateLimit, async (req, res) => {
  try {
    const result = await searchCpfCandidatesByName({
      name: req.body?.name || req.body?.nome,
    });
    if (result.error) {
      return res.status(result.status || 400).json({ message: result.error });
    }
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error instanceof Error ? error.message : 'Falha ao buscar candidatos por nome.' });
  }
});

app.post('/api/phone-lookup/save-to-client', (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const result = savePhonesToClient({
    clientId: req.body?.client_id || req.body?.clientId,
    phones: Array.isArray(req.body?.phones) ? req.body.phones : [],
    enrichment: req.body?.enrichment || req.body?.data || null,
    userId,
  });
  if (result.error) {
    return res.status(result.status || 400).json({ message: result.error });
  }
  return res.json(result);
});

app.get('/api/phone-lookup/history', (req, res) => {
  return res.json(listPhoneLookupConsultations(req.query || {}));
});

app.get('/api/phone-lookup/consultations/:id', (req, res) => {
  const consultation = getPhoneLookupConsultation(req.params.id);
  if (!consultation) {
    return res.status(404).json({ message: 'Consulta nao encontrada.' });
  }
  return res.json({ consultation });
});

app.post('/api/phone-lookup/save-current', (req, res) => {
  const result = saveCurrentConsultation({
    consultationId: req.body?.consultation_id || req.body?.consultationId,
    clientId: req.body?.client_id || req.body?.clientId || null,
    userId: getAuthenticatedUserId(req),
  });
  if (result.error) {
    return res.status(result.status || 400).json({ message: result.error });
  }
  return res.json(result);
});

app.post('/api/phone-lookup/cleanup', (_req, res) => {
  return res.json(cleanupPhoneLookupConsultations());
});

app.get('/api/phone-lookup/jobs', (req, res) => {
  return res.json(listPhoneLookupJobs(req.query || {}));
});

app.post('/api/phone-lookup/bulk/margin-clients', (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const result = queuePhoneLookupForMarginClients({
    userId,
    filters: {
      campaign_id: req.body?.campaign_id || req.query?.campaign_id,
      base_id: req.body?.base_id || req.query?.base_id,
    },
    force: req.body?.force === true || String(req.body?.force || '') === '1',
  });
  return res.json(result);
});

app.post('/api/phone-lookup/worker/run', async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const max = Number(req.body?.max || process.env.PHONE_LOOKUP_MAX_PER_RUN || 50);
    const result = await runPhoneLookupWorker({ max, userId });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ message: error instanceof Error ? error.message : 'Falha ao executar fila de busca.' });
  }
});


let phoneLookupAutoWorkerRunning = false;
let phoneLookupAutoWorkerTimer = null;

function phoneLookupAutoWorkerEnabled() {
  return String(process.env.PHONE_LOOKUP_AUTO_WORKER ?? 'true').toLowerCase() !== 'false';
}

async function runPendingPhoneLookupAutoWorker(trigger = 'timer') {
  if (!phoneLookupAutoWorkerEnabled() || phoneLookupAutoWorkerRunning) {
    return;
  }

  const pending = listPhoneLookupJobs({ status: 'pending', limit: 1 }).jobs || [];
  if (!pending.length) {
    return;
  }

  phoneLookupAutoWorkerRunning = true;
  try {
    const max = Number(process.env.PHONE_LOOKUP_AUTO_WORKER_MAX || process.env.PHONE_LOOKUP_MAX_PER_RUN || 25);
    const userId = Number(process.env.PHONE_LOOKUP_AUTO_WORKER_USER_ID || 1);
    const result = await runPhoneLookupWorker({ max, userId });
    console.log('[PHONE_LOOKUP] fila automatica executada', {
      trigger,
      processed: result.processed,
      max,
    });
  } catch (error) {
    console.error('[PHONE_LOOKUP] falha na fila automatica:', error instanceof Error ? error.message : error);
  } finally {
    phoneLookupAutoWorkerRunning = false;
  }
}

function startPhoneLookupAutoWorker() {
  if (!phoneLookupAutoWorkerEnabled() || phoneLookupAutoWorkerTimer) {
    return;
  }

  const intervalSeconds = Math.max(30, Number(process.env.PHONE_LOOKUP_AUTO_WORKER_INTERVAL_SECONDS || 120));
  setTimeout(() => {
    void runPendingPhoneLookupAutoWorker('startup');
  }, 15_000);
  phoneLookupAutoWorkerTimer = setInterval(() => {
    void runPendingPhoneLookupAutoWorker('timer');
  }, intervalSeconds * 1000);
  phoneLookupAutoWorkerTimer.unref?.();
  console.log('[PHONE_LOOKUP] fila automatica ativa', { intervalSeconds });
}

app.post('/api/ribeirao/session/start', requirePrivilegedRole, sensitiveLookupRateLimit, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const portalId = String(req.body.portal_id || req.body.portalId || 'prefeitura_ribeirao_preto').trim() || 'prefeitura_ribeirao_preto';
  const storedCredentials = getMarginPortalCredentials(portalId);
  const login = String(req.body.login || req.body.username || storedCredentials.login || '').trim();
  const password = String(req.body.password || storedCredentials.password || '').trim();
  const role = getRequestRole(req);

  try {
    if (!login || !password) {
      return res.status(409).json({
        success: false,
        code: 'CREDENTIAL_NOT_CONFIGURED',
        message: 'Cadastre login e senha deste portal na Central de Credenciais.',
      });
    }
    resetRibeiraoSessionCache();
    const session = await startRibeiraoSession({
      userId,
      credentialId: storedCredentials.credential_id || null,
      login,
      password,
      timeoutSeconds: Number(req.body.timeout_seconds || req.body.timeoutSeconds || 900),
      slowMo: Number(req.body.slow_mo || req.body.slowMo || 0),
      portalId,
      role,
    });

    const sessionStatus = String(session?.status || '').toLowerCase();
    const isConnected = sessionStatus === 'conectado';
    const isPendingManual = sessionStatus === 'conectando' || sessionStatus === 'aguardando_captcha_manual';
    const isError = sessionStatus === 'erro' || sessionStatus === 'erro_login' || sessionStatus === 'sessao_expirada' || sessionStatus === 'browser_launch_error';

    if (isError) {
      return res.status(400).json({
        success: false,
        code: String(session?.error_code || sessionStatus || 'ERROR').toUpperCase(),
        message:
          session?.message ||
          session?.error_message ||
          'Erro ao iniciar navegador de consulta no servidor. Verifique configuracao do Playwright/Chromium em producao.',
        session,
      });
    }

    return res.json({
      session,
      message: isConnected
        ? 'Sessao Ribeirao conectada.'
        : isPendingManual
          ? 'Sessao Ribeirao iniciada. Aguardando autenticacao manual no navegador aberto.'
          : 'Sessao Ribeirao iniciada.',
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      code: String(error?.code || 'ERROR').toUpperCase(),
      message: error instanceof Error ? error.message : 'Falha ao iniciar sessao Ribeirao.',
    });
  }
});

app.get('/api/ribeirao/session/:id/status', requirePrivilegedRole, (req, res) => {
  const sessionId = Number(req.params.id);
  const status = getRibeiraoSessionStatus(sessionId);
  if (!status) {
    return res.status(404).json({ message: 'Sessao nao encontrada.' });
  }
  return res.json({ session: status });
});

app.post('/api/ribeirao/query', requirePrivilegedRole, sensitiveLookupRateLimit, async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const requestedSessionId = Number(req.body.session_id || req.body.sessionId || 0);
    const cpf = String(req.body.cpf || '').trim();
    const portalId = String(req.body.portal_id || req.body.portalId || 'prefeitura_ribeirao_preto').trim() || 'prefeitura_ribeirao_preto';
    const storedCredentials = getMarginPortalCredentials(portalId);
    const login = String(req.body.login || req.body.username || storedCredentials.login || '').trim();
    const password = String(req.body.password || storedCredentials.password || '').trim();
    const clientId = req.body.client_id || req.body.clientId ? Number(req.body.client_id || req.body.clientId) : null;
    const baseId = req.body.base_id || req.body.baseId ? Number(req.body.base_id || req.body.baseId) : null;

    if (!cpf) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_CPF',
        message: 'Informe um CPF válido.',
      });
    }

    const { sessionId, gate } = resolveRibeiraoSessionGate(requestedSessionId);
    if (!gate.success) {
      return res.status(400).json({
        success: false,
        code: gate.code,
        message: gate.message,
      });
    }

    const result = await queryRibeiraoCpf({
      userId,
      sessionId,
      credentialId: storedCredentials.credential_id || null,
      cpf,
      login,
      password,
      portalId,
      clientId,
      baseId,
    });

    if (result?.ok === false) {
      const errorCode = String(result?.code || result?.status || 'ERROR').toUpperCase();
      const statusMap = {
        NO_ACTIVE_SESSION: 400,
        MANUAL_AUTH_REQUIRED: 409,
        CAPTCHA_REQUIRED: 409,
        LOGIN_ERROR: 401,
        LOGIN_REJECTED: 401,
        LOGIN_FIELDS_NOT_FOUND: 400,
        LOGIN_BUTTON_NOT_FOUND: 400,
        LOGIN_TIMEOUT: 408,
        LOGIN_STILL_ON_SAME_PAGE: 400,
        PORTAL_CHANGED: 400,
        SELECTOR_ERROR: 400,
        DNS_RESOLUTION_FAILED: 503,
        CHROMIUM_DNS_FAILED: 503,
        LOGIN_OK_NAVIGATION_FAILED: 400,
        PORTAL_UNREACHABLE: 503,
        SESSION_EXPIRED: 409,
        PORTAL_UNAVAILABLE: 503,
        INVALID_CPF: 400,
        DAILY_QUERY_LIMIT_REACHED: 429,
      };
      return res.status(statusMap[errorCode] || 400).json({
        success: false,
        code: errorCode,
        message: result?.message || 'Falha ao consultar margem no Ribeirao.',
        session_id: result?.session_id || sessionId,
        cpf: result?.cpf || cpf,
      });
    }

    return res.json(result);
  } catch (error) {
    const errorCode = String(error?.code || 'ERROR').toUpperCase();
    const statusMap = {
      NO_ACTIVE_SESSION: 400,
      MANUAL_AUTH_REQUIRED: 409,
      CAPTCHA_REQUIRED: 409,
      LOGIN_ERROR: 401,
      SELECTOR_ERROR: 400,
      DNS_RESOLUTION_FAILED: 503,
      CHROMIUM_DNS_FAILED: 503,
      PORTAL_UNREACHABLE: 503,
      SESSION_EXPIRED: 409,
      PORTAL_UNAVAILABLE: 503,
      INVALID_CPF: 400,
      DAILY_QUERY_LIMIT_REACHED: 429,
    };
    return res.status(statusMap[errorCode] || 400).json({
      success: false,
      code: errorCode,
      message: error instanceof Error ? error.message : 'Falha ao consultar margem no Ribeirao.',
    });
  }
});

app.post('/api/ribeirao/batch/upload-preview', requirePrivilegedRole, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Envie uma planilha válida.' });
    }

    const preview = previewRibeiraoBatchSpreadsheet(req.file.buffer, req.file.originalname);
    return res.json({
      file: {
        name: req.file.originalname,
        size: req.file.size,
        mime: req.file.mimetype,
      },
      preview,
    });
  } catch (error) {
    return res.status(400).json({
      message: error instanceof Error ? error.message : 'Falha ao analisar a planilha do lote.',
    });
  }
});

function parseBatchCpfs(payload) {
  if (Array.isArray(payload.cpfs)) {
    return payload.cpfs;
  }
  if (typeof payload.cpfs === 'string') {
    try {
      const parsed = JSON.parse(payload.cpfs);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return payload.cpfs.split(/[\n,;]+/g);
    }
  }
  return [];
}

async function handleBatchStart(req, res) {
  try {
    const userId = getAuthenticatedUserId(req);
    const requestedSessionId = Number(req.body.session_id || req.body.sessionId || 0);
    const portalId = String(req.body.portal_id || req.body.portalId || 'prefeitura_ribeirao_preto').trim() || 'prefeitura_ribeirao_preto';
    const storedCredentials = getMarginPortalCredentials(portalId);
    const login = String(req.body.login || req.body.username || storedCredentials.login || '').trim();
    const password = String(req.body.password || storedCredentials.password || '').trim();
    let sourceType = String(req.body.source_type || req.body.sourceType || 'upload').trim().toLowerCase();
    const sourceFileName = String(req.body.source_file_name || req.body.sourceFileName || '').trim();
    const baseIdRaw = req.body.base_id ?? req.body.baseId ?? null;
    let baseId = baseIdRaw === null || baseIdRaw === undefined || baseIdRaw === '' ? null : baseIdRaw;
    const delaySecondsMin = Number(req.body.delay_seconds_min || req.body.delaySecondsMin || 3);
    const delaySecondsMax = Number(req.body.delay_seconds_max || req.body.delaySecondsMax || 8);
    const shouldCreatePipelineBase = isTruthyFlag(req.body.create_pipeline_base ?? req.body.createPipelineBase, false);
    const shouldContinuePipeline = isTruthyFlag(req.body.auto_pipeline ?? req.body.autoPipeline, shouldCreatePipelineBase);

    const { sessionId, gate } = resolveRibeiraoSessionGate(requestedSessionId);
    if (!gate.success) {
      return res.status(400).json({
        success: false,
        code: gate.code,
        message: gate.message,
      });
    }

    let cpfs = parseBatchCpfs(req.body);
    let createdPipelineBase = null;
    if (sourceType === 'upload' && shouldCreatePipelineBase) {
      createdPipelineBase = saveBatchUploadAsPipelineBase({
        payload: req.body,
        cpfs,
        portalId,
        sourceFileName,
      });
      if (createdPipelineBase?.base?.id) {
        baseId = createdPipelineBase.base.id;
        sourceType = 'base';
        cpfs = loadRibeiraoBatchCpfsFromBase(baseId);
      }
    }

    if (sourceType === 'base') {
      cpfs = loadRibeiraoBatchCpfsFromBase(baseId);
    }

    const normalizedCpfs = cpfs
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        return item?.cpf || item?.cpf_display || '';
      })
      .filter(Boolean);

    const batch = await startRibeiraoBatch({
      userId,
      sessionId,
      credentialId: storedCredentials.credential_id || null,
      login,
      password,
      portalId,
      sourceType,
      sourceFileName,
      cpfs: normalizedCpfs,
      baseId,
      delaySecondsMin,
      delaySecondsMax,
    });

    if (shouldContinuePipeline && baseId) {
      void continuePipelineAfterMarginBatch({
        batchId: Number(batch.id),
        baseId: Number(baseId),
        userId,
      }).catch((error) => {
        console.error('[PIPELINE] erro ao continuar esteira apos lote:', error instanceof Error ? error.message : error);
      });
    }

    return res.json({
      message: createdPipelineBase?.base?.id
        ? 'Lote iniciado e base da Esteira criada. Nova Vida seguirá automaticamente após a margem.'
        : 'Lote de consultas iniciado.',
      batch,
      pipeline_base: createdPipelineBase?.base || null,
    });
  } catch (error) {
    const errorCode = String(error?.code || 'ERROR').toUpperCase();
    const statusMap = {
      NO_ACTIVE_SESSION: 400,
      MANUAL_AUTH_REQUIRED: 409,
      CAPTCHA_REQUIRED: 409,
      LOGIN_ERROR: 401,
      SELECTOR_ERROR: 400,
      DNS_RESOLUTION_FAILED: 503,
      CHROMIUM_DNS_FAILED: 503,
      PORTAL_UNREACHABLE: 503,
      SESSION_EXPIRED: 409,
      PORTAL_UNAVAILABLE: 503,
      INVALID_CPF: 400,
    };
    return res.status(statusMap[errorCode] || 400).json({
      success: false,
      code: errorCode,
      message: error instanceof Error ? error.message : 'Falha ao iniciar o lote.',
    });
  }
}

app.post('/api/ribeirao/batch/start', requirePrivilegedRole, (req, res) => {
  void handleBatchStart(req, res);
});

app.post('/api/ribeirao/batch', requirePrivilegedRole, (req, res) => {
  void handleBatchStart(req, res);
});

app.get('/api/ribeirao/history', requirePrivilegedRole, (req, res) => {
  const rows = listRibeiraoHistory(req.query || {});
  return res.json({ rows });
});

app.get('/api/ribeirao/history/:id', requirePrivilegedRole, (req, res) => {
  const item = getRibeiraoHistoryById(Number(req.params.id));
  if (!item) {
    return res.status(404).json({ message: 'Consulta nao encontrada.' });
  }
  return res.json({ item });
});

app.post('/api/ribeirao/history/:id/apply', requirePrivilegedRole, (req, res) => {
  const queryId = Number(req.params.id);
  const clientId = Number(req.body.client_id || req.body.clientId || 0);
  const baseId = req.body.base_id || req.body.baseId ? Number(req.body.base_id || req.body.baseId) : null;
  const userId = getAuthenticatedUserId(req);

  if (!clientId) {
    return res.status(400).json({ message: 'Informe o cliente alvo.' });
  }

  const client = applyRibeiraoResultToClient({
    queryId,
    clientId,
    baseId,
    userId,
  });

  if (!client) {
    return res.status(404).json({ message: 'Nao foi possivel aplicar o resultado ao cliente.' });
  }

  return res.json({ client: client.client || client });
});

app.get('/api/ribeirao/batch/history', requirePrivilegedRole, (req, res) => {
  const rows = getRibeiraoBatchHistory(req.query || {});
  return res.json({ rows });
});

app.post('/api/ribeirao/batch/recover-pipeline', requirePrivilegedRole, async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const limit = Number(req.body.limit || req.query.limit || process.env.AUTO_PIPELINE_RECOVERY_LIMIT || 10);
    const pendingBases = latestPipelineBasesWaitingMargin(limit);
    const results = [];

    for (const base of pendingBases) {
      const plan = buildUploadAutomationPlan({
        baseInput: {
          nome_base: base.nome_base,
          tipo_base: base.tipo_base,
          convenio: base.convenio,
          estado: base.estado,
          cidade: base.cidade,
          notes: base.observacao,
          auto_margin: true,
        },
        importResult: { base },
      });

      if (plan.status !== 'queued') {
        results.push({
          base_id: base.id,
          base_name: base.nome_base,
          status: plan.status,
          reason: plan.reason || '',
          portal_id: plan.portal_id || '',
        });
        continue;
      }

      const started = await startMarginBatchFromPlan({ plan, userId });
      results.push({
        base_id: base.id,
        base_name: base.nome_base,
        status: started.status,
        reason: started.reason || '',
        portal_id: plan.portal_id,
        total_cpfs: plan.total_cpfs,
        batch_id: started.batch_id || null,
      });

      if (started.status === 'batch_started') {
        void continuePipelineAfterMarginBatch({
          batchId: Number(started.batch_id),
          baseId: Number(base.id),
          userId,
        }).catch((error) => {
          console.error('[PIPELINE] erro ao continuar esteira recuperada:', error instanceof Error ? error.message : error);
        });
      }
    }

    return res.json({ recovered: results });
  } catch (error) {
    return res.status(400).json({
      message: error instanceof Error ? error.message : 'Falha ao recuperar lotes da esteira.',
    });
  }
});

app.get('/api/ribeirao/batch/:id/status', requirePrivilegedRole, (req, res) => {
  const batch = getRibeiraoBatchStatus(Number(req.params.id));
  if (!batch) {
    return res.status(404).json({ message: 'Lote nao encontrado.' });
  }
  return res.json({ batch });
});

app.post('/api/ribeirao/batch/:id/pause', requirePrivilegedRole, (req, res) => {
  const batch = pauseRibeiraoBatch(Number(req.params.id));
  if (!batch) {
    return res.status(404).json({ message: 'Lote nao encontrado.' });
  }
  return res.json({ batch });
});

app.post('/api/ribeirao/batch/:id/resume', requirePrivilegedRole, (req, res) => {
  try {
    const reusableSession = getReusableRibeiraoSession();
    const batch = resumeRibeiraoBatch(Number(req.params.id), {
      userId: getAuthenticatedUserId(req),
      sessionId: reusableSession?.id || 0,
      portalId: req.body?.portal_id || req.body?.portalId || 'prefeitura_ribeirao_preto',
      delaySecondsMin: req.body?.delay_seconds_min ?? req.body?.delaySecondsMin,
      delaySecondsMax: req.body?.delay_seconds_max ?? req.body?.delaySecondsMax,
    });
    if (!batch) {
      return res.status(404).json({ message: 'Lote nao encontrado.' });
    }
    return res.json({ batch });
  } catch (error) {
    const code = String(error?.code || 'RESUME_FAILED').toUpperCase();
    const status = code === 'BATCH_CPF_LIST_NOT_FOUND' ? 409 : code === 'NO_ACTIVE_SESSION' ? 409 : 400;
    return res.status(status).json({
      success: false,
      code,
      message: error instanceof Error ? error.message : 'Falha ao retomar lote.',
    });
  }
});

app.post('/api/ribeirao/batch/:id/cancel', requirePrivilegedRole, (req, res) => {
  const batch = cancelRibeiraoBatch(Number(req.params.id));
  if (!batch) {
    return res.status(404).json({ message: 'Lote nao encontrado.' });
  }
  return res.json({ batch });
});

app.get('/api/ribeirao/batch/:id/results', requirePrivilegedRole, (req, res) => {
  const batch = getRibeiraoBatchStatus(Number(req.params.id));
  if (!batch) {
    return res.status(404).json({ message: 'Lote nao encontrado.' });
  }
  const rows = getRibeiraoBatchResults(Number(req.params.id));
  return res.json({ batch, rows });
});

app.get('/api/ribeirao/batch/:id/export', requirePrivilegedRole, (req, res) => {
  const batch = getRibeiraoBatchStatus(Number(req.params.id));
  if (!batch) {
    return res.status(404).json({ message: 'Lote nao encontrado.' });
  }
  const workbookBuffer = exportRibeiraoBatchResultsXlsx(Number(req.params.id));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="lote-ribeirao-${batch.id}.xlsx"`);
  return res.send(workbookBuffer);
});

app.get('/api/dashboard', (req, res) => {
  res.json(getDashboardData(req.query || {}));
});

app.get('/api/reports', (req, res) => {
  res.json(getReportsData(req.query || {}));
});

app.use((error, _req, res, next) => {
  if (!error) {
    return next();
  }

  const message = error instanceof Error ? error.message : 'Falha ao processar a requisicao.';
  if (/file too large|larg.*excede|tipo de arquivo nao suportado/i.test(message)) {
    return res.status(400).json({ message });
  }

  return res.status(400).json({ message });
});

app.use((_req, res) => {
  res.status(404).json({ message: 'Rota não encontrada.' });
});

app.listen(port, () => {
  const dbPath = getDb().name;
  console.log(`[BUILD] ${BUILD_VERSION}`);
  console.log(`Relianse CRM backend running on port ${port}`);
  console.log(`SQLite database: ${dbPath}`);
  setTimeout(() => {
    resumeRecentPipelineMarginBatches().catch((error) => {
      console.error('[PIPELINE] erro na retomada automatica:', error instanceof Error ? error.message : error);
    });
  }, Number(process.env.AUTO_PIPELINE_RECOVERY_DELAY_MS || 5000));
  startPhoneLookupAutoWorker();
});
