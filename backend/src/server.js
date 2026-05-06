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
  listPhoneLookupLogs,
  listPhoneLookupJobs,
  processPhoneLookupJob,
  queuePhoneLookupForClient,
  queuePhoneLookupForMarginClients,
  runPhoneLookupWorker,
  savePhonesToClient,
  searchPhones,
} from './services/phone_lookup/phoneLookupService.js';

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
    app: process.env.APP_NAME || 'Relianse CRM',
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
app.use('/api/users', roleMiddleware(['gerencial']));
app.use('/api/bases', roleMiddleware(['gerencial']));
app.use('/api/upload', roleMiddleware(['gerencial']));
app.use('/api/settings', roleMiddleware(['gerencial']));
app.use('/api/reports', roleMiddleware(['gerencial']));
app.use('/api/ribeirao', roleMiddleware(['gerencial']));
app.use('/api/phone-lookup', roleMiddleware(['gerencial']));

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

app.get('/api/clients/export', requirePrivilegedRole, (req, res) => {
  const data = listClients({ ...(req.query || {}), include_archived: req.query?.include_archived || '1' });
  const rows = (data.clients || []).map((client) => {
    const phones = client.phones || [];
    const primary = phones.find((phone) => phone.is_primary) || phones[0] || null;
    return {
      CPF: client.cpf || '',
      Nome: client.name || '',
      Telefone: client.phone || '',
      telefone_principal: primary?.normalized_phone || primary?.phone_number || client.phone || '',
      telefones_encontrados: phones.map((phone) => phone.normalized_phone || phone.phone_number).filter(Boolean).join('; '),
      origem_telefone: primary?.source || '',
      qualidade_telefone: primary?.quality || '',
      data_busca_telefone: primary?.searched_at_formatted || primary?.searched_at || '',
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

app.post('/api/clients/:id/whatsapp-open', (req, res) => {
  const id = Number(req.params.id);
  const userId = getAuthenticatedUserId(req);
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

app.post('/api/phone-lookup/search', async (req, res) => {
  try {
    const result = await searchPhones({
      cpf: req.body?.cpf,
      name: req.body?.name,
      clientId: req.body?.client_id || req.body?.clientId || null,
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
    userId,
  });
  if (result.error) {
    return res.status(result.status || 400).json({ message: result.error });
  }
  return res.json(result);
});

app.get('/api/phone-lookup/history', (req, res) => {
  return res.json({ rows: listPhoneLookupLogs(req.query || {}) });
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

app.post('/api/ribeirao/session/start', requirePrivilegedRole, async (req, res) => {
  const userId = getAuthenticatedUserId(req);
  const login = String(req.body.login || req.body.username || '').trim();
  const password = String(req.body.password || '').trim();
  const role = getRequestRole(req);

  try {
    resetRibeiraoSessionCache();
    const session = await startRibeiraoSession({
      userId,
      login,
      password,
      timeoutSeconds: Number(req.body.timeout_seconds || req.body.timeoutSeconds || 900),
      slowMo: Number(req.body.slow_mo || req.body.slowMo || 0),
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

app.post('/api/ribeirao/query', requirePrivilegedRole, async (req, res) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const sessionId = Number(req.body.session_id || req.body.sessionId || 0);
    const cpf = String(req.body.cpf || '').trim();
    const login = String(req.body.login || req.body.username || '').trim();
    const password = String(req.body.password || '').trim();
    const clientId = req.body.client_id || req.body.clientId ? Number(req.body.client_id || req.body.clientId) : null;
    const baseId = req.body.base_id || req.body.baseId ? Number(req.body.base_id || req.body.baseId) : null;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        code: 'NO_ACTIVE_SESSION',
        message: 'Nenhuma sessão ativa com o portal da Prefeitura. Inicie a sessão antes de consultar.',
      });
    }
    if (!cpf) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_CPF',
        message: 'Informe um CPF válido.',
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
    const sessionId = Number(req.body.session_id || req.body.sessionId || 0);
    const login = String(req.body.login || req.body.username || '').trim();
    const password = String(req.body.password || '').trim();
    const sourceType = String(req.body.source_type || req.body.sourceType || 'upload').trim().toLowerCase();
    const sourceFileName = String(req.body.source_file_name || req.body.sourceFileName || '').trim();
    const baseIdRaw = req.body.base_id ?? req.body.baseId ?? null;
    const baseId = baseIdRaw === null || baseIdRaw === undefined || baseIdRaw === '' ? null : baseIdRaw;
    const delaySecondsMin = Number(req.body.delay_seconds_min || req.body.delaySecondsMin || 3);
    const delaySecondsMax = Number(req.body.delay_seconds_max || req.body.delaySecondsMax || 8);

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        code: 'NO_ACTIVE_SESSION',
        message: 'Nenhuma sessão ativa com o portal da Prefeitura. Inicie a sessão antes de consultar em lote.',
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

    let cpfs = parseBatchCpfs(req.body);
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
      login,
      password,
      sourceType,
      sourceFileName,
      cpfs: normalizedCpfs,
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
  const batch = resumeRibeiraoBatch(Number(req.params.id));
  if (!batch) {
    return res.status(404).json({ message: 'Lote nao encontrado.' });
  }
  return res.json({ batch });
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
});
