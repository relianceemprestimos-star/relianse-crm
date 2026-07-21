import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
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
  listClientPhones,
  setPrimaryClientPhone,
  updateClientPhoneStatus,
} from './db.js';
import { authMiddleware, loginWithCredentials, roleMiddleware } from './auth.js';
import { hashPassword, verifyPassword } from './security.js';
import {
  applyRibeiraoResultToClient,
  getRibeiraoDiagnostics,
  getRibeiraoHistoryById,
  getLatestConnectedRibeiraoSession,
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
  getRibeiraoBatchHistory,
  getRibeiraoBatchResultDownloadInfo,
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
  searchPhones,
} from './services/phone_lookup/phoneLookupService.js';
import {
  confirmAssistedLogin,
  getCredentialByPortal,
  getCredentialGate,
  getCredentialLogs,
  getCredentialPortals,
  getCredentialSecretByPortal,
  listCredentials,
  saveCredential,
  startAssistedLogin,
  testCredential,
  updateCredential,
} from './services/credentials/credentialService.js';
import { normalizePortalId } from './services/credentials/portalConfigs.js';
import {
  getBalance as getCaptchaBalance,
  getCaptchaEngineConfig,
  getCaptchaReport,
  listCaptchaLogs,
  saveCaptchaEngineConfig,
  testExternalProvider,
} from './services/captcha/captchaManager.js';
import {
  connectWhatsapp,
  getWhatsappConfig,
  getWhatsappMessages,
  getWhatsappFlowExecutions,
  getWhatsappFlowLogs,
  getWhatsappFlows,
  getWhatsappQrCode,
  getWhatsappStatus,
  getWhatsappTemplates,
  reconnectWhatsapp,
  receiveWhatsappWebhook,
  saveWhatsappFlow,
  saveWhatsappConfig,
  saveWhatsappTemplate,
  sendWhatsappMessage,
  sendWhatsappTemplate,
  startWhatsappFlow,
  stopWhatsappFlow,
  testWhatsapp,
  updateWhatsappTemplate,
  verifyMetaWebhook,
  WhatsappServiceError,
} from './services/whatsapp/whatsapp_service.js';

dotenv.config();
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
const operationalRoles = ['gerencial', 'vendedor'];

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
    app: process.env.APP_NAME || 'Reliance CRM',
    service: 'relianse-crm-backend',
    build: BUILD_VERSION,
    db: getDb().name,
  });
});

app.post('/api/auth/login', (req, res) => {
  try {
    const login = String(req.body.login || req.body.username || '').trim();
    const password = String(req.body.password || '').trim();
    if (!login || !password) {
      return res.status(400).json({ message: 'Informe login e senha.' });
    }

    const result = loginWithCredentials({ login, password });
    return res.json(result);
  } catch (error) {
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

app.get('/api/whatsapp/webhook', (req, res) => {
  const challenge = verifyMetaWebhook(req.query || {});
  if (challenge !== null) {
    return res.status(200).send(challenge);
  }
  return res.status(403).json({ message: 'Webhook nao verificado.' });
});

app.post('/api/whatsapp/webhook', async (req, res) => {
  try {
    const result = await receiveWhatsappWebhook(req.body || {});
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Erro ao processar webhook.',
      code: error?.code || 'WHATSAPP_WEBHOOK_ERROR',
    });
  }
});

app.use('/api', authMiddleware);
app.post('/api/auth/change-password', (req, res) => {
  try {
    const currentUser = req.user;
    if (!currentUser) {
      return res.status(401).json({ message: 'FaÃ§a login para continuar.' });
    }

    const currentPassword = String(req.body.currentPassword || '').trim();
    const newPassword = String(req.body.newPassword || '').trim();
    const confirmPassword = String(req.body.confirmPassword || '').trim();

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: 'Preencha todos os campos da senha.' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: 'As senhas nÃ£o conferem.' });
    }

    const user = getUserById(Number(currentUser.id));
    if (!user) {
      return res.status(404).json({ message: 'UsuÃ¡rio nÃ£o encontrado.' });
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
app.use('/api/users', roleMiddleware(['gerencial']));
app.use('/api/bases', roleMiddleware(operationalRoles));
app.use('/api/upload', roleMiddleware(operationalRoles));
app.use('/api/settings', roleMiddleware(operationalRoles));
app.use('/api/reports', roleMiddleware(operationalRoles));
app.use('/api/ribeirao', roleMiddleware(operationalRoles));
app.use('/api/phone-lookup', roleMiddleware(operationalRoles));
app.use('/api/whatsapp', roleMiddleware(operationalRoles));
app.use('/api/captcha-engine', roleMiddleware(['gerencial']));

function handleWhatsappError(res, error) {
  const status = error instanceof WhatsappServiceError ? error.status : 500;
  return res.status(status || 500).json({
    message: error instanceof Error ? error.message : 'Erro no modulo WhatsApp.',
    code: error?.code || 'WHATSAPP_ERROR',
    message_record: error?.messageRecord || undefined,
  });
}

app.get('/api/credentials/portals', (_req, res) => {
  return res.json({ portals: getCredentialPortals() });
});

app.get('/api/credentials/logs', roleMiddleware(['gerencial']), (req, res) => {
  return res.json({ rows: getCredentialLogs(req.query || {}) });
});

app.get('/api/credentials', roleMiddleware(['gerencial']), (_req, res) => {
  return res.json({ credentials: listCredentials() });
});

app.get('/api/credentials/:portalId', (req, res) => {
  const credential = getCredentialByPortal(req.params.portalId);
  if (!credential) {
    return res.status(404).json({ message: 'Portal de credencial não encontrado.' });
  }
  if (!privilegedRoles.has(getRequestRole(req))) {
    return res.json({ credential: { ...credential, login: '' } });
  }
  return res.json({ credential });
});

app.post('/api/credentials', roleMiddleware(['gerencial']), (req, res) => {
  try {
    const credential = saveCredential(req.body || {}, getAuthenticatedUserId(req));
    return res.json({ credential });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao salvar credencial.' });
  }
});

app.put('/api/credentials/:id', roleMiddleware(['gerencial']), (req, res) => {
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

app.post('/api/credentials/:id/test', roleMiddleware(['gerencial']), async (req, res) => {
  try {
    const credential = await testCredential(Number(req.params.id), getAuthenticatedUserId(req));
    return res.json({ credential });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao testar conexão.' });
  }
});

app.post('/api/credentials/:id/assisted-login/start', roleMiddleware(['gerencial']), (req, res) => {
  try {
    const result = startAssistedLogin(Number(req.params.id), getAuthenticatedUserId(req));
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao iniciar login assistido.' });
  }
});

app.post('/api/credentials/:id/assisted-login/confirm', roleMiddleware(['gerencial']), (req, res) => {
  try {
    const credential = confirmAssistedLogin(Number(req.params.id), getAuthenticatedUserId(req));
    return res.json({ credential });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao confirmar sessão assistida.' });
  }
});

app.get('/api/whatsapp/status', async (_req, res) => {
  try {
    return res.json(await getWhatsappStatus());
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.get('/api/captcha-engine/config', roleMiddleware(['gerencial']), (_req, res) => {
  return res.json({ config: getCaptchaEngineConfig() });
});

app.post('/api/captcha-engine/config', roleMiddleware(['gerencial']), (req, res) => {
  try {
    const config = saveCaptchaEngineConfig(req.body || {}, getAuthenticatedUserId(req));
    return res.json({ config });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao salvar Motor de CAPTCHA.' });
  }
});

app.post('/api/captcha-engine/test-provider', roleMiddleware(['gerencial']), async (_req, res) => {
  try {
    const result = await testExternalProvider();
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ ok: false, message: error instanceof Error ? error.message : 'Falha ao testar provider externo.' });
  }
});

app.get('/api/captcha-engine/balance', roleMiddleware(['gerencial']), async (_req, res) => {
  try {
    const result = await getCaptchaBalance();
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ ok: false, message: error instanceof Error ? error.message : 'Saldo indisponível.' });
  }
});

app.get('/api/captcha-engine/logs', roleMiddleware(['gerencial']), (req, res) => {
  return res.json({ rows: listCaptchaLogs(req.query || {}) });
});

app.get('/api/captcha-engine/report', roleMiddleware(['gerencial']), (req, res) => {
  return res.json(getCaptchaReport(req.query || {}));
});

app.get('/api/captcha-engine/logs/export', roleMiddleware(['gerencial']), (req, res) => {
  const rows = listCaptchaLogs({ ...(req.query || {}), limit: 1000 });
  const headers = [
    'id',
    'portal',
    'portal_label',
    'batch_id',
    'cpf_masked',
    'provider',
    'status',
    'confidence',
    'error_code',
    'error_message',
    'cost_estimated',
    'duration_ms',
    'created_at',
  ];
  const csv = [
    headers.join(';'),
    ...rows.map((row) =>
      headers
        .map((header) => `"${String(row[header] ?? '').replace(/"/g, '""')}"`)
        .join(';')
    ),
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="motor-captcha-logs.csv"');
  return res.send(`\ufeff${csv}`);
});

app.get('/api/whatsapp/config', (_req, res) => {
  return res.json({ config: getWhatsappConfig() });
});

app.post('/api/whatsapp/config', roleMiddleware(['gerencial']), (req, res) => {
  try {
    return res.json({ config: saveWhatsappConfig(req.body || {}, getAuthenticatedUserId(req)) });
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.post('/api/whatsapp/connect', roleMiddleware(['gerencial']), async (_req, res) => {
  try {
    return res.json(await connectWhatsapp());
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.post('/api/whatsapp/reconnect', roleMiddleware(['gerencial']), async (_req, res) => {
  try {
    return res.json(await reconnectWhatsapp());
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.get('/api/whatsapp/qrcode', roleMiddleware(['gerencial']), async (_req, res) => {
  try {
    return res.json(await getWhatsappQrCode());
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.post('/api/whatsapp/test', roleMiddleware(['gerencial']), async (req, res) => {
  try {
    if (String(req.body?.phone || '').trim() && String(req.body?.message || '').trim()) {
      const testResult = await sendWhatsappMessage({
        phone: req.body.phone,
        message: req.body.message,
        userId: getAuthenticatedUserId(req),
      });
      return res.json({ test_send: true, ...testResult });
    }
    return res.json(await testWhatsapp());
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const result = await sendWhatsappMessage({
      clientId: req.body?.client_id || req.body?.clientId,
      phone: req.body?.phone,
      message: req.body?.message || req.body?.message_body,
      templateId: req.body?.template_id || req.body?.templateId || null,
      userId: getAuthenticatedUserId(req),
    });
    return res.json(result);
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.post('/api/whatsapp/send-template', async (req, res) => {
  try {
    const result = await sendWhatsappTemplate({
      clientId: req.body?.client_id || req.body?.clientId,
      phone: req.body?.phone,
      templateId: req.body?.template_id || req.body?.templateId,
      variables: req.body?.variables || {},
      userId: getAuthenticatedUserId(req),
    });
    return res.json(result);
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.get('/api/whatsapp/messages', (req, res) => {
  return res.json({ rows: getWhatsappMessages(req.query || {}) });
});

app.get('/api/whatsapp/templates', (req, res) => {
  return res.json({ rows: getWhatsappTemplates(req.query || {}) });
});

app.post('/api/whatsapp/templates', roleMiddleware(['gerencial']), (req, res) => {
  try {
    return res.json({ template: saveWhatsappTemplate(req.body || {}) });
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.put('/api/whatsapp/templates/:id', roleMiddleware(['gerencial']), (req, res) => {
  try {
    return res.json({ template: updateWhatsappTemplate(Number(req.params.id), req.body || {}) });
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.get('/api/whatsapp/flows', (req, res) => {
  try {
    return res.json({ rows: getWhatsappFlows(req.query || {}) });
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.post('/api/whatsapp/flows', roleMiddleware(['gerencial']), (req, res) => {
  try {
    return res.json({ flow: saveWhatsappFlow(req.body || {}) });
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.put('/api/whatsapp/flows/:id', roleMiddleware(['gerencial']), (req, res) => {
  try {
    return res.json({ flow: saveWhatsappFlow({ ...(req.body || {}), id: Number(req.params.id) }) });
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.post('/api/whatsapp/flows/start', async (req, res) => {
  try {
    const result = await startWhatsappFlow({
      flowId: req.body?.flow_id ?? req.body?.flowId,
      clientId: req.body?.client_id ?? req.body?.clientId,
      phone: req.body?.phone || '',
      userId: getAuthenticatedUserId(req),
    });
    return res.json(result);
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.post('/api/whatsapp/flows/stop', (req, res) => {
  try {
    const execution = stopWhatsappFlow({
      executionId: req.body?.execution_id ?? req.body?.executionId ?? null,
      clientId: req.body?.client_id ?? req.body?.clientId ?? null,
      reason: req.body?.reason || 'stopped',
      userId: getAuthenticatedUserId(req),
    });
    return res.json({ execution });
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.get('/api/whatsapp/flows/executions', (req, res) => {
  try {
    return res.json({ rows: getWhatsappFlowExecutions(req.query || {}) });
  } catch (error) {
    return handleWhatsappError(res, error);
  }
});

app.get('/api/whatsapp/flows/logs', (req, res) => {
  try {
    return res.json({ rows: getWhatsappFlowLogs(req.query || {}) });
  } catch (error) {
    return handleWhatsappError(res, error);
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
      return res.status(400).json({ message: 'Login jÃ¡ cadastrado.' });
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
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao cadastrar usuÃ¡rio.' });
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
      return res.status(400).json({ message: 'Login jÃ¡ cadastrado.' });
    }

    const user = updateUserRecord(id, {
      name: name || current.name,
      login: login || current.login,
      role: role || current.role,
      isActive,
    });

    return res.json({ user });
  } catch (error) {
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao atualizar usuÃ¡rio.' });
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
    return res.status(400).json({ message: error instanceof Error ? error.message : 'Falha ao atualizar usuÃ¡rio.' });
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

app.post('/api/campaigns', roleMiddleware(operationalRoles), (req, res) => {
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

app.put('/api/campaigns/:id', roleMiddleware(operationalRoles), (req, res) => {
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

app.post('/api/campaigns/:id/archive', roleMiddleware(operationalRoles), (req, res) => {
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
    return res.status(404).json({ message: 'Base nÃ£o encontrada.' });
  }
  return res.json({ base });
});

app.post('/api/bases/:id/archive', (req, res) => {
  const id = Number(req.params.id);
  const archived = req.body.archived !== false;
  const base = archiveBase(id, archived);
  if (!base) {
    return res.status(404).json({ message: 'Base nÃ£o encontrada.' });
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

app.get('/api/ribeirao/config', roleMiddleware(operationalRoles), (_req, res) => {
  return res.json({ config: getRibeiraoConfigStatus() });
});

app.get('/api/ribeirao/diagnostics', roleMiddleware(operationalRoles), (_req, res) => {
  return res.json({ diagnostics: getRibeiraoDiagnostics() });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Envie um arquivo vÃ¡lido.' });
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

    return res.json({
      mode: 'import',
      message: 'Lista importada com sucesso.',
      redirectTo: '/fila',
      result: importResult,
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

app.get('/api/clients/export', roleMiddleware(operationalRoles), (req, res) => {
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
    return res.status(404).json({ message: 'Cliente nÃ£o encontrado.' });
  }
  res.json(client);
});

app.post('/api/clients/:id/start', (req, res) => {
  const id = Number(req.params.id);
  const userId = getAuthenticatedUserId(req);
  const currentClient = getClientById(id);
  if (!currentClient) {
    return res.status(404).json({ message: 'Cliente nÃ£o encontrado.' });
  }
  const requesterRole = getRequestRole(req);
  if (
    currentClient.client?.assigned_to &&
    Number(currentClient.client.assigned_to) !== userId &&
    requesterRole !== 'gerencial'
  ) {
    return res.status(403).json({ message: 'Este atendimento jÃ¡ estÃ¡ com outro vendedor.' });
  }
  const result = startAttendance(id, userId);
  if (!result) {
    return res.status(404).json({ message: 'Cliente nÃ£o encontrado.' });
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
    return res.status(404).json({ message: 'Cliente nÃ£o encontrado.' });
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
    return res.status(404).json({ message: 'Cliente nÃ£o encontrado.' });
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
    return res.status(404).json({ message: 'Cliente nÃ£o encontrado.' });
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
    return res.status(404).json({ message: 'Cliente nÃ£o encontrado.' });
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
    return res.status(404).json({ message: 'Cliente nÃ£o encontrado.' });
  }

  return res.json(result);
});

app.post('/api/clients/:id/whatsapp-open', (req, res) => {
  const id = Number(req.params.id);
  const userId = getAuthenticatedUserId(req);
  const result = logWhatsappOpen(id, {
    userId,
    note: String(req.body.note || 'WhatsApp Web aberto para o cliente'),
  });

  if (!result) {
    return res.status(404).json({ message: 'Cliente nÃ£o encontrado.' });
  }

  return res.json({ client: result });
});

app.get('/api/clients/:id/phones', (req, res) => {
  const id = Number(req.params.id);
  if (!getClientById(id)) {
    return res.status(404).json({ message: 'Cliente nÃ£o encontrado.' });
  }
  return res.json({ phones: listClientPhones(id) });
});

app.post('/api/clients/:id/phones/:phoneId/primary', (req, res) => {
  const result = setPrimaryClientPhone(Number(req.params.id), Number(req.params.phoneId));
  if (!result) {
    return res.status(404).json({ message: 'Telefone nÃ£o encontrado.' });
  }
  return res.json(result);
});

app.post('/api/clients/:id/phones/:phoneId/inactivate', (req, res) => {
  const result = updateClientPhoneStatus(Number(req.params.id), Number(req.params.phoneId), 'inactive');
  if (!result) {
    return res.status(404).json({ message: 'Telefone nÃ£o encontrado.' });
  }
  return res.json(result);
});

app.post('/api/clients/:id/phone-lookup', async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const force = req.body?.force === true || String(req.body?.force || '') === '1';
    const queued = queuePhoneLookupForClient({ clientId: Number(req.params.id), userId, force });
    if (queued.error) {
      return res.status(queued.status || 400).json({ message: queued.error });
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
    return res.status(500).json({ message: error instanceof Error ? error.message : 'Falha na busca de telefone.' });
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

app.post('/api/phone-lookup/search', async (req, res) => {
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

app.post('/api/ribeirao/session/start', roleMiddleware(operationalRoles), async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const portalId = normalizePortalId(req.body.portal_id || req.body.portalId || 'prefeitura_ribeirao_preto');
  const credentialGate = getCredentialGate(portalId);
  const credentialSecret = getCredentialSecretByPortal(portalId);
  const credentialId = Number(credentialSecret?.id || 0) || null;
  const login = String(req.body.login || req.body.username || credentialSecret?.login || '').trim();
  const password = String(req.body.password || credentialSecret?.password || '').trim();
  const credentialProfile = req.body.credential_profile || req.body.credentialProfile || credentialSecret?.credential_profile || null;
  const role = getRequestRole(req);

  try {
    if (portalId !== 'prefeitura_ribeirao_preto') {
      return res.status(501).json({
        success: false,
        code: 'SOURCE_NOT_IMPLEMENTED',
        message: 'Fonte ainda não implementada para sessão automatizada.',
      });
    }

    if (!credentialGate.allowed && (!login || !password)) {
      return res.status(409).json({
        success: false,
        code: credentialGate.code,
        message: credentialGate.message,
        credential: credentialGate.credential,
      });
    }

    if (!login || !password) {
      return res.status(400).json({
        success: false,
        code: 'CREDENTIAL_REQUIRED',
        message: 'Informe login e senha ou cadastre a credencial do portal.',
      });
    }

    const reusableSession = getLatestConnectedRibeiraoSession(userId);
    if (reusableSession?.id && String(reusableSession.status || '').toLowerCase() === 'conectado') {
      return res.json({
        session: reusableSession,
        message: 'Sessao Ribeirao conectada.',
        reused: true,
      });
    }

    resetRibeiraoSessionCache();
    const session = await startRibeiraoSession({
      userId,
      login,
      password,
      credentialProfile,
      timeoutSeconds: Number(req.body.timeout_seconds || req.body.timeoutSeconds || 900),
      slowMo: Number(req.body.slow_mo || req.body.slowMo || 0),
      role,
      credentialId,
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

app.get('/api/ribeirao/session/:id/status', roleMiddleware(operationalRoles), (req, res) => {
  const sessionId = Number(req.params.id);
  const status = getRibeiraoSessionStatus(sessionId);
  if (!status) {
    return res.status(404).json({ message: 'Sessao nao encontrada.' });
  }
  return res.json({ session: status });
});

app.post('/api/ribeirao/query', roleMiddleware(operationalRoles), async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const sessionId = Number(req.body.session_id || req.body.sessionId || 0);
    const cpf = String(req.body.cpf || '').trim();
    const portalId = normalizePortalId(req.body.portal_id || req.body.portalId || 'prefeitura_ribeirao_preto');
    const credentialSecret = getCredentialSecretByPortal(portalId);
    const credentialId = Number(credentialSecret?.id || 0) || null;
    const login = String(req.body.login || req.body.username || credentialSecret?.login || '').trim();
    const password = String(req.body.password || credentialSecret?.password || '').trim();
    const credentialProfile = req.body.credential_profile || req.body.credentialProfile || credentialSecret?.credential_profile || null;
    const clientId = req.body.client_id || req.body.clientId ? Number(req.body.client_id || req.body.clientId) : null;
    const baseId = req.body.base_id || req.body.baseId ? Number(req.body.base_id || req.body.baseId) : null;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        code: 'NO_ACTIVE_SESSION',
        message: 'Nenhuma sessÃ£o ativa com o portal da Prefeitura. Inicie a sessÃ£o antes de consultar.',
      });
    }
    if (!cpf) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_CPF',
        message: 'Informe um CPF vÃ¡lido.',
      });
    }

    const gate = getRibeiraoSessionGate(sessionId);
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
      cpf,
      login,
      password,
      credentialProfile,
      clientId,
      baseId,
      credentialId,
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
        PROFILE_COMPLETION_REQUIRED: 409,
        PORTAL_CHANGED: 400,
        SELECTOR_ERROR: 400,
        DNS_RESOLUTION_FAILED: 503,
        CHROMIUM_DNS_FAILED: 503,
        LOGIN_OK_NAVIGATION_FAILED: 400,
        PORTAL_UNREACHABLE: 503,
        SESSION_EXPIRED: 409,
        PORTAL_UNAVAILABLE: 503,
        INVALID_CPF: 400,
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
      PROFILE_COMPLETION_REQUIRED: 409,
      DNS_RESOLUTION_FAILED: 503,
      CHROMIUM_DNS_FAILED: 503,
      PORTAL_UNREACHABLE: 503,
      SESSION_EXPIRED: 409,
      PORTAL_UNAVAILABLE: 503,
      INVALID_CPF: 400,
      CREDENTIAL_NOT_CONFIGURED: 409,
      CREDENTIAL_SESSION_EXPIRED: 409,
      ASSISTED_LOGIN_REQUIRED: 409,
      SOURCE_NOT_IMPLEMENTED: 501,
    };
    return res.status(statusMap[errorCode] || 400).json({
      success: false,
      code: errorCode,
      message: error instanceof Error ? error.message : 'Falha ao consultar margem no Ribeirao.',
    });
  }
});

app.post('/api/ribeirao/batch/upload-preview', roleMiddleware(operationalRoles), upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Envie uma planilha vÃ¡lida.' });
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

function parseBatchSourceRecords(payload) {
  if (Array.isArray(payload.source_records)) {
    return payload.source_records;
  }
  if (Array.isArray(payload.sourceRecords)) {
    return payload.sourceRecords;
  }
  const raw = payload.source_records ?? payload.sourceRecords;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return [];
    }
  }
  return [];
}

async function handleBatchStart(req, res) {
  try {
    const userId = getAuthenticatedUserId(req);
    let sessionId = Number(req.body.session_id || req.body.sessionId || 0);
    const portalId = normalizePortalId(req.body.portal_id || req.body.portalId || 'prefeitura_ribeirao_preto');
    const credentialGate = getCredentialGate(portalId);
    const credentialSecret = getCredentialSecretByPortal(portalId);
    const credentialId = Number(credentialSecret?.id || 0) || null;
    const login = String(req.body.login || req.body.username || credentialSecret?.login || '').trim();
    const password = String(req.body.password || credentialSecret?.password || '').trim();
    const credentialProfile = req.body.credential_profile || req.body.credentialProfile || credentialSecret?.credential_profile || null;
    const sourceType = String(req.body.source_type || req.body.sourceType || 'upload').trim().toLowerCase();
    const sourceFileName = String(req.body.source_file_name || req.body.sourceFileName || '').trim();
    const baseIdRaw = req.body.base_id ?? req.body.baseId ?? null;
    const baseId = baseIdRaw === null || baseIdRaw === undefined || baseIdRaw === '' ? null : baseIdRaw;
    const delaySecondsMin = Number(req.body.delay_seconds_min || req.body.delaySecondsMin || 3);
    const delaySecondsMax = Number(req.body.delay_seconds_max || req.body.delaySecondsMax || 8);

    if (portalId === 'governo_sp') {
      return res.status(501).json({
        success: false,
        code: 'SOURCE_NOT_IMPLEMENTED',
        message: 'Fonte ainda não implementada para consulta em lote. O portal de SP exige login assistido por CAPTCHA.',
      });
    }

    if (!credentialGate.allowed) {
      return res.status(409).json({
        success: false,
        code: credentialGate.code,
        message: credentialGate.message,
        credential: credentialGate.credential,
      });
    }

    if (sessionId && portalId === 'prefeitura_ribeirao_preto') {
      const existingGate = getRibeiraoSessionGate(sessionId);
      if (!existingGate.success) {
        sessionId = 0;
      }
    }

    if (!sessionId && portalId === 'prefeitura_ribeirao_preto') {
      const reusableSession = getLatestConnectedRibeiraoSession(userId);
      if (reusableSession?.id && String(reusableSession.status || '').toLowerCase() === 'conectado') {
        sessionId = Number(reusableSession.id);
      }
    }

    if (!sessionId && portalId === 'prefeitura_ribeirao_preto') {
      const startedSession = await startRibeiraoSession({
        userId,
        login,
        password,
        credentialProfile,
        timeoutSeconds: Number(req.body.timeout_seconds || req.body.timeoutSeconds || 900),
        slowMo: Number(req.body.slow_mo || req.body.slowMo || 0),
        userName: req.user?.name || '',
        role: req.user?.role || 'gerencial',
        credentialId,
      });
      if (!startedSession?.id || !String(startedSession.status || '').includes('conect')) {
        return res.status(409).json({
          success: false,
          code: startedSession?.error_code || 'NO_ACTIVE_SESSION',
          message: startedSession?.error_message || startedSession?.message || 'Não foi possível conectar ao portal com a credencial salva.',
          session: startedSession,
        });
      }
      sessionId = Number(startedSession.id);
    }

    const gate = portalId === 'prefeitura_ribeirao_preto' ? getRibeiraoSessionGate(sessionId) : { success: true };
    if (!gate.success) {
      return res.status(400).json({
        success: false,
        code: gate.code,
        message: gate.message,
      });
    }

    let cpfs = parseBatchCpfs(req.body);
    let sourceRecords = parseBatchSourceRecords(req.body);
    if (sourceType === 'base') {
      cpfs = loadRibeiraoBatchCpfsFromBase(baseId);
      sourceRecords = [];
    }

    const normalizedCpfs = cpfs
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        return item?.cpf || item?.cpf_display || '';
      })
      .filter(Boolean);

    const cpfEntries =
      sourceType === 'upload' && Array.isArray(sourceRecords) && sourceRecords.length
        ? sourceRecords
        : normalizedCpfs.map((cpf) => ({ cpf }));

    const batch = await startRibeiraoBatch({
      userId,
      sessionId,
      login,
      password,
      credentialId,
      portalId,
      sourceType,
      sourceFileName,
      cpfs: normalizedCpfs,
      cpfEntries,
      baseId,
      delaySecondsMin,
      delaySecondsMax,
    });

    return res.json({
      message: 'Lote de consultas iniciado.',
      batch,
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
      CREDENTIAL_NOT_CONFIGURED: 409,
      CREDENTIAL_SESSION_EXPIRED: 409,
      ASSISTED_LOGIN_REQUIRED: 409,
      SOURCE_NOT_IMPLEMENTED: 501,
    };
    return res.status(statusMap[errorCode] || 400).json({
      success: false,
      code: errorCode,
      message: error instanceof Error ? error.message : 'Falha ao iniciar o lote.',
    });
  }
}

app.post('/api/ribeirao/batch/start', roleMiddleware(operationalRoles), (req, res) => {
  void handleBatchStart(req, res);
});

app.post('/api/ribeirao/batch', roleMiddleware(operationalRoles), (req, res) => {
  void handleBatchStart(req, res);
});

app.get('/api/ribeirao/history', roleMiddleware(operationalRoles), (req, res) => {
  const rows = listRibeiraoHistory(req.query || {});
  return res.json({ rows });
});

app.get('/api/ribeirao/history/:id', roleMiddleware(operationalRoles), (req, res) => {
  const item = getRibeiraoHistoryById(Number(req.params.id));
  if (!item) {
    return res.status(404).json({ message: 'Consulta nao encontrada.' });
  }
  return res.json({ item });
});

app.post('/api/ribeirao/history/:id/apply', roleMiddleware(operationalRoles), (req, res) => {
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

app.get('/api/ribeirao/batch/history', roleMiddleware(operationalRoles), (req, res) => {
  const rows = getRibeiraoBatchHistory(req.query || {});
  return res.json({ rows });
});

app.get('/api/ribeirao/batch/:id/status', roleMiddleware(operationalRoles), (req, res) => {
  const batch = getRibeiraoBatchStatus(Number(req.params.id));
  if (!batch) {
    return res.status(404).json({ message: 'Lote nao encontrado.' });
  }
  return res.json({ batch });
});

app.post('/api/ribeirao/batch/:id/pause', roleMiddleware(operationalRoles), (req, res) => {
  const batch = pauseRibeiraoBatch(Number(req.params.id));
  if (!batch) {
    return res.status(404).json({ message: 'Lote nao encontrado.' });
  }
  return res.json({ batch });
});

app.post('/api/ribeirao/batch/:id/resume', roleMiddleware(operationalRoles), (req, res) => {
  const batch = resumeRibeiraoBatch(Number(req.params.id));
  if (!batch) {
    return res.status(404).json({ message: 'Lote nao encontrado.' });
  }
  return res.json({ batch });
});

app.post('/api/ribeirao/batch/:id/cancel', roleMiddleware(operationalRoles), (req, res) => {
  const batch = cancelRibeiraoBatch(Number(req.params.id));
  if (!batch) {
    return res.status(404).json({ message: 'Lote nao encontrado.' });
  }
  return res.json({ batch });
});

app.get('/api/ribeirao/batch/:id/results', roleMiddleware(operationalRoles), (req, res) => {
  const batch = getRibeiraoBatchStatus(Number(req.params.id));
  if (!batch) {
    return res.status(404).json({ message: 'Lote nao encontrado.' });
  }
  const rows = getRibeiraoBatchResults(Number(req.params.id));
  return res.json({ batch, rows });
});

function sendRibeiraoBatchDownload(req, res) {
  const batchId = Number(req.params.id);
  const download = getRibeiraoBatchResultDownloadInfo(batchId);

  if (!download?.batch) {
    return res.status(404).json({ message: 'Lote nao encontrado.' });
  }

  if (download.reason === 'BATCH_WITHOUT_RESULTS') {
    return res.status(409).json({ message: 'Lote ainda sem resultados processados.' });
  }

  if (download.reason === 'BATCH_NOT_COMPLETED') {
    return res.status(409).json({ message: 'Consulta ainda em processamento.' });
  }

  if (download.reason === 'RESULT_FILE_NOT_REGISTERED' || download.reason === 'RESULT_FILE_NOT_FOUND') {
    return res.status(404).json({ message: 'Arquivo de resultado nao encontrado.' });
  }

  const filename = download.filename || `resultado-consulta-margem-lote-${download.batch.id}.xlsx`;
  res.setHeader('Content-Type', download.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  if (download.buffer) {
    return res.send(download.buffer);
  }

  if (!download.absolutePath) {
    return res.status(500).json({ message: 'Erro interno ao preparar download do resultado.' });
  }

  return res.download(download.absolutePath, filename);
}

app.get('/api/ribeirao/batch/:id/export', roleMiddleware(operationalRoles), sendRibeiraoBatchDownload);
app.get('/api/ribeirao/batch/:id/download', roleMiddleware(operationalRoles), sendRibeiraoBatchDownload);
app.get('/api/consulta-margem/lotes/:id/download', roleMiddleware(operationalRoles), sendRibeiraoBatchDownload);

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
  res.status(404).json({ message: 'Rota nÃ£o encontrada.' });
});

app.listen(port, () => {
  const dbPath = getDb().name;
  console.log(`[BUILD] ${BUILD_VERSION}`);
  console.log(`Reliance CRM backend running on port ${port}`);
  console.log(`SQLite database: ${dbPath}`);
});
