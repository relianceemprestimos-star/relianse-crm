import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import initSqlJs from 'sql.js';

import {
  cleanDigits,
  formatCpfDisplay,
  formatDateTime,
  formatMoney,
  matchColumn,
  normalizeConsultaStatus,
  normalizeCpfValue,
  normalizeHeaderKey,
  normalizePhoneToBrazilInternational,
  parseMoney,
  PRODUCT_DEFINITIONS,
  readSpreadsheetRows,
  stringifyRawRow,
} from './utils.js';
import { hashPassword } from './security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(BACKEND_ROOT, '..');
const DEFAULT_DB_PATH = path.join(BACKEND_ROOT, 'data', 'relianse-crm.sqlite');
const SQL_WASM_DIR = path.join(PROJECT_ROOT, 'node_modules', 'sql.js', 'dist');

const DEFAULT_SETTINGS = {
  company_name: 'Relianse CRM',
  attendant_name: 'Carlos Andrade',
  whatsapp_message:
    'Oie, {nome}, tudo bem? E a Aline. Vi aqui que apareceu uma oportunidade no seu consignado. Posso te enviar uma simulacao sem compromisso?',
  allow_column_editing: 'true',
  daily_limit: '50',
  theme: 'dark',
  expected_columns:
    'cpf, nome, margem bruta consignacao, margem liquida consignacao, margem bruta credito, margem liquida credito, margem bruta cartao, margem liquida cartao, status, mensagem',
};

const INITIAL_USER_PASSWORD = '12345';
const SAMPLE_USERS = [
  { name: 'Magali', login: 'magali@admin', role: 'gerencial' },
  { name: 'Vinicius', login: 'vinicius@admin', role: 'vendedor' },
];

const SAMPLE_BASE = {
  nome_base: 'Campanha Maio - WhatsApp',
  tipo_base: 'Outro',
  convenio: 'Base de exemplo',
  estado: 'SP',
  cidade: '',
  arquivo_original: 'clientes_exemplo.csv',
  observacao: 'Base de demonstração criada automaticamente.',
};

const SAMPLE_CLIENTS = [
  {
    name: 'Maria Aparecida da Silva',
    cpf: '12345678909',
    phone: '11987654321',
    email: 'maria.aparecida@email.com',
    consulta_status: 'com_marg',
    consulta_mensagem: 'Consulta realizada com margem positiva.',
    margins: {
      consignacao: { gross_margin: 1909.35, net_margin: -456.09 },
      credito: { gross_margin: 272.76, net_margin: -63.17 },
      cartao: { gross_margin: 818.25, net_margin: -191.55 },
    },
  },
  {
    name: 'Joao Batista de Oliveira',
    cpf: '98765432100',
    phone: '11912345678',
    email: 'joao.oliveira@email.com',
    consulta_status: 'sem_marg',
    consulta_mensagem: 'Consulta realizada, sem margem disponivel.',
    margins: {
      consignacao: { gross_margin: 0, net_margin: 0 },
      credito: { gross_margin: 0, net_margin: 0 },
      cartao: { gross_margin: 0, net_margin: 0 },
    },
  },
  {
    name: 'Ana Paula Ferreira',
    cpf: '45678912311',
    phone: '11998765432',
    email: 'ana.ferreira@email.com',
    consulta_status: 'erro',
    consulta_mensagem: 'Erro na consulta de margem.',
    margins: {
      consignacao: { gross_margin: null, net_margin: null },
      credito: { gross_margin: null, net_margin: null },
      cartao: { gross_margin: null, net_margin: null },
    },
  },
];

let rawDb;
let db;
let initPromise;
let transactionDepth = 0;

function getDatabasePath() {
  return path.resolve(process.env.SQLITE_PATH || process.env.DATABASE_PATH || DEFAULT_DB_PATH);
}

function getUploadDirectory() {
  return path.resolve(process.env.UPLOAD_DIR || path.join(BACKEND_ROOT, 'uploads'));
}

function getLogDirectory() {
  return path.resolve(process.env.LOG_DIR || path.join(BACKEND_ROOT, 'logs'));
}

function ensureRuntimeDirectories() {
  for (const folder of [path.dirname(getDatabasePath()), getUploadDirectory(), getLogDirectory()]) {
    fs.mkdirSync(folder, { recursive: true });
  }
}

function persistDb() {
  if (!rawDb) {
    return;
  }

  const dbPath = getDatabasePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, Buffer.from(rawDb.export()));
}

function queryAll(database, sql, params = []) {
  if (database && database.__isAdapter) {
    return database.prepare(sql).all(...params);
  }

  const statement = database.prepare(sql);
  if (params.length) {
    statement.bind(params);
  }

  const rows = [];
  while (statement.step()) {
    rows.push(statement.getAsObject());
  }
  statement.free();
  return rows;
}

function queryOne(database, sql, params = []) {
  if (database && database.__isAdapter) {
    return database.prepare(sql).get(...params);
  }

  return queryAll(database, sql, params)[0];
}

function execute(database, sql, params = []) {
  if (database && database.__isAdapter) {
    return database.prepare(sql).run(...params);
  }

  const statement = database.prepare(sql);
  if (params.length) {
    statement.bind(params);
  }
  statement.step();
  statement.free();
  if (transactionDepth === 0) {
    persistDb();
  }
}

function createAdapter(database) {
  return {
    __isAdapter: true,
    name: getDatabasePath(),
    pragma() {},
    exec(sql) {
      database.exec(sql);
      if (transactionDepth === 0) {
        persistDb();
      }
    },
    prepare(sql) {
      return {
        get(...params) {
          return queryOne(database, sql, params);
        },
        all(...params) {
          return queryAll(database, sql, params);
        },
        run(...params) {
          execute(database, sql, params);
          return queryOne(database, 'SELECT last_insert_rowid() AS lastInsertRowid, changes() AS changes') || {
            lastInsertRowid: 0,
            changes: 0,
          };
        },
      };
    },
    transaction(fn) {
      return (...args) => {
        transactionDepth += 1;
        database.exec('BEGIN TRANSACTION');
        try {
          const result = fn(...args);
          database.exec('COMMIT');
          persistDb();
          return result;
        } catch (error) {
          try {
            database.exec('ROLLBACK');
          } catch {
            // ignore rollback errors
          }
          throw error;
        } finally {
          transactionDepth -= 1;
        }
      };
    },
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeUserRole(role) {
  const text = String(role || '').toLowerCase();
  if (text.includes('ger')) {
    return 'gerencial';
  }
  if (text.includes('admin')) {
    return 'gerencial';
  }
  return 'vendedor';
}

function normalizeUserLogin(login, fallbackId = '') {
  const value = String(login || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9@._-]/g, '');
  if (value) {
    return value;
  }
  return fallbackId ? `user-${fallbackId}` : `user-sem-login`;
}

function emptyMarginRecord() {
  return {
    gross_margin: null,
    net_margin: null,
    source_gross_column: '',
    source_net_column: '',
  };
}

function productLabel(productType) {
  return PRODUCT_DEFINITIONS[productType]?.label || productType;
}

function marginStatus(netValue) {
  if (netValue === null || netValue === undefined || netValue === '') {
    return 'sem_dado';
  }

  const number = Number(netValue);
  if (!Number.isFinite(number)) {
    return 'sem_dado';
  }

  if (number > 0) return 'disponivel';
  if (number === 0) return 'sem_margem';
  return 'negativa';
}

function bestMarginFromMargins(margins) {
  let best = null;

  for (const margin of margins || []) {
    const numeric = margin?.net_margin ?? margin?.gross_margin;
    if (numeric === null || numeric === undefined || numeric === '') {
      continue;
    }

    const value = Number(numeric);
    if (!Number.isFinite(value)) {
      continue;
    }

    if (!best || value > best.net_margin) {
      best = {
        product_type: margin.product_type,
        net_margin: value,
      };
    }
  }

  return best || { product_type: '', net_margin: null };
}

function baseTypeLabel(type) {
  const labels = {
    'Governo Estadual': 'Governo Estadual',
    Prefeitura: 'Prefeitura',
    SPPREV: 'SPPREV',
    'Polícia Militar': 'Polícia Militar',
    Câmara: 'Câmara',
    Autarquia: 'Autarquia',
    Outro: 'Outro',
  };

  return labels[type] || type || 'Outro';
}

function normalizeBaseText(value) {
  return String(value ?? '').trim();
}

function suggestedBaseNameFromFilename(filename) {
  const clean = path.basename(filename, path.extname(filename)).replace(/[_-]+/g, ' ').trim();
  if (!clean) {
    return 'Nova base';
  }

  return clean
    .replace(/\bsp\b/gi, 'SP')
    .replace(/\bgov\b/gi, 'GOV')
    .replace(/\bpref\b/gi, 'PREF')
    .replace(/\bmaio\b/gi, 'Maio')
    .replace(/\babril\b/gi, 'Abril')
    .replace(/\bjaneiro\b/gi, 'Janeiro')
    .replace(/\bfevereiro\b/gi, 'Fevereiro')
    .replace(/\bmarco\b/gi, 'Março')
    .replace(/\babril\b/gi, 'Abril')
    .replace(/\bmaio\b/gi, 'Maio')
    .replace(/\bjunho\b/gi, 'Junho')
    .replace(/\bjulho\b/gi, 'Julho')
    .replace(/\bagosto\b/gi, 'Agosto')
    .replace(/\bsetembro\b/gi, 'Setembro')
    .replace(/\boutubro\b/gi, 'Outubro')
    .replace(/\bnovembro\b/gi, 'Novembro')
    .replace(/\bdezembro\b/gi, 'Dezembro');
}

function baseDisplayName(base) {
  return base?.nome_base || base?.name || 'Base sem nome';
}

function flattenMargins(margins) {
  const map = {
    consignacao: emptyMarginRecord(),
    credito: emptyMarginRecord(),
    cartao: emptyMarginRecord(),
    outros: emptyMarginRecord(),
  };

  for (const margin of margins || []) {
    if (map[margin.product_type]) {
      map[margin.product_type] = {
        gross_margin: margin.gross_margin ?? null,
        net_margin: margin.net_margin ?? null,
        source_gross_column: margin.source_gross_column || '',
        source_net_column: margin.source_net_column || '',
      };
    }
  }

  return map;
}

function getClientDuplicateBases(database, cpf, currentBaseId) {
  if (!cpf) {
    return [];
  }

  return queryAll(
    database,
    `
      SELECT DISTINCT
        b.id,
        b.nome_base,
        b.tipo_base,
        b.convenio,
        b.estado,
        b.cidade,
        b.arquivo_original,
        b.created_at,
        c.status_atendimento,
        c.best_product_type,
        c.best_net_margin
      FROM clients c
      LEFT JOIN bases b ON b.id = COALESCE(c.base_id, c.campaign_id)
      WHERE c.cpf = ? AND COALESCE(c.base_id, c.campaign_id) <> ?
      ORDER BY datetime(b.created_at) DESC, b.id DESC
    `,
    [cpf, currentBaseId]
  ).map((row) => ({
    id: Number(row.id),
    nome_base: row.nome_base || '',
    tipo_base: row.tipo_base || 'Outro',
    convenio: row.convenio || '',
    estado: row.estado || '',
    cidade: row.cidade || '',
    arquivo_original: row.arquivo_original || '',
    created_at: row.created_at || '',
    status_atendimento: row.status_atendimento || 'novo_na_fila',
    best_product_type: row.best_product_type || '',
    best_net_margin: row.best_net_margin === null || row.best_net_margin === undefined ? null : Number(row.best_net_margin),
  }));
}

function clientDto(database, row, margins = [], interactions = [], returns = [], deals = []) {
  if (!row) {
    return null;
  }

  const marginMap = flattenMargins(margins);
  const best = row.best_net_margin !== null && row.best_net_margin !== undefined && row.best_net_margin !== ''
    ? {
        product_type: row.best_product_type || '',
        net_margin: Number(row.best_net_margin),
      }
    : bestMarginFromMargins(margins);

  const rawData = row.raw_data_json ? safeJsonParse(row.raw_data_json, {}) : {};
  const consultaStatus = row.consulta_status || 'sem_marg';
  const baseId = row.base_id ?? row.campaign_id ?? null;
  const base = {
    id: baseId,
    nome_base: row.base_name || row.campaign_name || '',
    tipo_base: row.base_type || 'Outro',
    convenio: row.base_convenio || row.campaign_name || '',
    estado: row.base_state || '',
    cidade: row.base_city || '',
    arquivo_original: row.base_file_name || row.campaign_file_name || '',
    observacao: row.base_observation || '',
    is_active: Number(row.base_is_active ?? 1) === 1,
    archived_at: row.base_archived_at || null,
    created_at: row.base_created_at || row.created_at || '',
    updated_at: row.base_updated_at || row.updated_at || '',
  };
  const duplicateBases = getClientDuplicateBases(database, row.cpf, baseId);

  return {
    id: row.id,
    campaign_id: row.campaign_id ?? null,
    base_id: baseId,
    name: row.name || '',
    cpf: row.cpf || '',
    phone: row.phone || '',
    email: row.email || '',
    status: row.status_atendimento || row.status || 'novo_na_fila',
    status_atendimento: row.status_atendimento || row.status || 'novo_na_fila',
    consulta_status: consultaStatus,
    consulta_status_label: consultaStatusLabel(consultaStatus),
    consulta_mensagem: row.consulta_mensagem || '',
    raw_data_json: row.raw_data_json || '',
    raw_data: rawData,
    has_duplicate_in_other_base: Number(row.has_duplicate_in_other_base || 0) === 1 || duplicateBases.length > 0,
    duplicate_bases: duplicateBases,
    base,
    base_name: base.nome_base,
    base_type: base.tipo_base,
    base_convenio: base.convenio,
    base_state: base.estado,
    base_city: base.cidade,
    base_file_name: base.arquivo_original,
    base_observation: base.observacao,
    base_is_active: base.is_active,
    base_archived_at: base.archived_at,
    assigned_to: row.assigned_to ?? null,
    assigned_to_name: row.assigned_to_name || '',
    queue_position: Number(row.queue_position || 0),
    campaign_name: row.campaign_name || '',
    campaign_file_name: row.campaign_file_name || '',
    status_label: statusLabel(row.status_atendimento || row.status),
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_at_formatted: formatDateTime(row.created_at),
    updated_at_formatted: formatDateTime(row.updated_at),
    best_product_type: best.product_type || '',
    best_product_label: productLabel(best.product_type),
    best_net_margin: best.net_margin === null || best.net_margin === undefined ? null : Number(best.net_margin),
    best_net_margin_formatted: formatMoney(best.net_margin),
    margins: [
      {
        product_type: 'consignacao',
        product_label: 'Consignação',
        ...marginMap.consignacao,
      },
      {
        product_type: 'credito',
        product_label: 'Crédito',
        ...marginMap.credito,
      },
      {
        product_type: 'cartao',
        product_label: 'Cartão',
        ...marginMap.cartao,
      },
      {
        product_type: 'outros',
        product_label: 'Outros',
        ...marginMap.outros,
      },
    ],
    margins_map: marginMap,
    margem_bruta_consignacao: marginMap.consignacao.gross_margin,
    margem_liquida_consignacao: marginMap.consignacao.net_margin,
    margem_bruta_credito: marginMap.credito.gross_margin,
    margem_liquida_credito: marginMap.credito.net_margin,
    margem_bruta_cartao: marginMap.cartao.gross_margin,
    margem_liquida_cartao: marginMap.cartao.net_margin,
    consulta_status_summary: marginStatus(best.net_margin),
    interactions,
    scheduled_returns: returns,
    deals,
    current_margin: best.net_margin ?? null,
    current_margin_formatted: formatMoney(best.net_margin),
  };
}

function statusLabel(status) {
  const labels = {
    novo_na_fila: 'Novo na fila',
    em_atendimento: 'Em atendimento',
    aguardando_retorno: 'Aguardando retorno',
    finalizado: 'Finalizado',
    sem_interesse: 'Sem interesse',
    convertido: 'Convertido',
  };
  return labels[status] || status || 'Novo na fila';
}

function consultaStatusLabel(status) {
  const labels = {
    com_marg: 'Com margem',
    sem_marg: 'Sem margem',
    erro: 'Erro',
  };
  return labels[status] || status || 'Sem margem';
}

function safeJsonParse(value, fallback = {}) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function initSchema(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      login TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'vendedor',
      is_active INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      file_name TEXT NOT NULL,
      total_clients INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome_base TEXT NOT NULL,
      tipo_base TEXT NOT NULL DEFAULT 'Outro',
      convenio TEXT NOT NULL DEFAULT '',
      estado TEXT NOT NULL DEFAULT '',
      cidade TEXT NOT NULL DEFAULT '',
      arquivo_original TEXT NOT NULL DEFAULT '',
      total_clientes INTEGER NOT NULL DEFAULT 0,
      total_com_margem INTEGER NOT NULL DEFAULT 0,
      total_sem_margem INTEGER NOT NULL DEFAULT 0,
      total_erro INTEGER NOT NULL DEFAULT 0,
      observacao TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_id INTEGER,
      campaign_id INTEGER,
      name TEXT NOT NULL,
      cpf TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      status_atendimento TEXT NOT NULL DEFAULT 'novo_na_fila',
      consulta_status TEXT NOT NULL DEFAULT 'sem_marg',
      consulta_mensagem TEXT NOT NULL DEFAULT '',
      raw_data_json TEXT NOT NULL DEFAULT '{}',
      has_duplicate_in_other_base INTEGER NOT NULL DEFAULT 0,
      best_product_type TEXT NOT NULL DEFAULT '',
      best_net_margin REAL,
      current_margin REAL,
      status TEXT NOT NULL DEFAULT 'novo_na_fila',
      assigned_to INTEGER,
      queue_position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (base_id) REFERENCES bases(id) ON DELETE SET NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
      FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS client_margins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      product_type TEXT NOT NULL,
      gross_margin REAL,
      net_margin REAL,
      source_gross_column TEXT,
      source_net_column TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_client_margins_unique ON client_margins(client_id, product_type);

    CREATE TABLE IF NOT EXISTS interactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      note TEXT,
      private_note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scheduled_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      return_at TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      bank TEXT,
      amount REAL,
      installment REAL,
      term INTEGER,
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ribeirao_query_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'conectando',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ribeirao_margin_queries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER,
      user_id INTEGER NOT NULL,
      session_id INTEGER,
      client_id INTEGER,
      base_id INTEGER,
      cpf TEXT NOT NULL,
      cpf_masked TEXT NOT NULL,
      nome TEXT,
      matricula TEXT,
      orgao TEXT,
      consulta_status TEXT NOT NULL DEFAULT 'erro',
      mensagem TEXT,
      best_product_type TEXT NOT NULL DEFAULT '',
      best_net_margin REAL,
      raw_result_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES ribeirao_query_batches(id) ON DELETE SET NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES ribeirao_query_sessions(id) ON DELETE SET NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      FOREIGN KEY (base_id) REFERENCES bases(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS ribeirao_query_margins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_id INTEGER NOT NULL,
      product_type TEXT NOT NULL,
      gross_margin REAL,
      net_margin REAL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (query_id) REFERENCES ribeirao_margin_queries(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ribeirao_query_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      base_id INTEGER,
      source_type TEXT NOT NULL DEFAULT 'upload',
      source_file_name TEXT NOT NULL DEFAULT '',
      total_cpfs INTEGER NOT NULL DEFAULT 0,
      processed_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      no_margin_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      captcha_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pendente',
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (base_id) REFERENCES bases(id) ON DELETE SET NULL
    );
  `);

  ensureColumns(database, 'clients', [
    'base_id INTEGER',
    'status_atendimento TEXT NOT NULL DEFAULT \'novo_na_fila\'',
    'consulta_status TEXT NOT NULL DEFAULT \'sem_marg\'',
    'consulta_mensagem TEXT NOT NULL DEFAULT \'\'',
    'raw_data_json TEXT NOT NULL DEFAULT \'{}\'',
    'has_duplicate_in_other_base INTEGER NOT NULL DEFAULT 0',
    'best_product_type TEXT NOT NULL DEFAULT \'\'',
    'best_net_margin REAL',
    'current_margin REAL',
    'status TEXT NOT NULL DEFAULT \'novo_na_fila\'',
    'assigned_to INTEGER',
    'queue_position INTEGER NOT NULL DEFAULT 0',
    'created_at TEXT NOT NULL',
    'updated_at TEXT NOT NULL',
  ]);

  ensureColumns(database, 'users', [
    'login TEXT NOT NULL DEFAULT \'\'',
    'email TEXT NOT NULL DEFAULT \'\'',
    'password_hash TEXT NOT NULL DEFAULT \'\'',
    'role TEXT NOT NULL DEFAULT \'vendedor\'',
    'is_active INTEGER NOT NULL DEFAULT 1',
    'last_login_at TEXT',
    'updated_at TEXT NOT NULL DEFAULT \'\'',
  ]);

  ensureColumns(database, 'ribeirao_margin_queries', [
    'batch_id INTEGER',
  ]);

  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_base_cpf ON clients(base_id, cpf)');
}

function ensureColumns(database, table, columns) {
  const existingColumns = queryAll(database, `PRAGMA table_info(${table})`).map((column) => column.name);
  for (const definition of columns) {
    const columnName = definition.split(/\s+/)[0];
    if (!existingColumns.includes(columnName)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
  }
}

function hasBaseClientIndex(database) {
  return queryAll(database, "PRAGMA index_list('clients')").some((row) => row.name === 'idx_clients_base_cpf');
}

function normalizeLegacyUsers(database) {
  const legacyUsers = queryAll(
    database,
    'SELECT id, name, email, login, role, password_hash, is_active, created_at, updated_at, last_login_at FROM users ORDER BY id ASC'
  );

  for (const user of legacyUsers) {
    const hasPasswordHash = String(user.password_hash || '').trim().length > 0;
    const nextLogin = normalizeUserLogin(user.login || user.email || user.name, user.id);
    const nextRole = normalizeUserRole(user.role);
    const nextUpdatedAt = String(user.updated_at || '').trim() || String(user.created_at || '').trim() || nowIso();
    const shouldDisable = !hasPasswordHash && nextLogin !== 'magali@admin' && nextLogin !== 'vinicius@admin';

    database
      .prepare(
        `
          UPDATE users
          SET
            login = ?,
            email = COALESCE(email, login, ?),
            role = ?,
            is_active = ?,
            updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        nextLogin,
        nextLogin,
        nextRole,
        shouldDisable ? 0 : Number(user.is_active ?? 1),
        nextUpdatedAt,
        user.id
      );
  }
}

function backfillBasesFromCampaigns(database) {
  const existingBaseIds = new Set(queryAll(database, 'SELECT id FROM bases').map((row) => Number(row.id)));
  const campaigns = queryAll(database, 'SELECT * FROM campaigns ORDER BY id ASC');
  const insertBase = database.prepare(`
    INSERT INTO bases (
      id, nome_base, tipo_base, convenio, estado, cidade, arquivo_original,
      total_clientes, total_com_margem, total_sem_margem, total_erro,
      observacao, is_active, archived_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const campaign of campaigns) {
    const baseId = Number(campaign.id);
    if (existingBaseIds.has(baseId)) {
      continue;
    }

    insertBase.run(
      baseId,
      campaign.name || 'Base sem nome',
      'Outro',
      campaign.name || '',
      '',
      '',
      campaign.file_name || '',
      Number(campaign.total_clients || 0),
      0,
      0,
      0,
      '',
      1,
      null,
      campaign.created_at || nowIso(),
      campaign.created_at || nowIso()
    );
  }
}

function rebuildClientsTableForBaseSupport(database) {
  const existingColumns = queryAll(database, "PRAGMA table_info('clients')").map((column) => column.name);
  const needsBaseId = !existingColumns.includes('base_id');
  if (!needsBaseId && hasBaseClientIndex(database)) {
    return;
  }

  const hadForeignKeys = queryOne(database, 'PRAGMA foreign_keys')?.foreign_keys ?? 1;
  database.exec('PRAGMA foreign_keys = OFF');
  database.exec('ALTER TABLE clients RENAME TO clients_legacy');

  database.exec(`
    CREATE TABLE clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_id INTEGER,
      campaign_id INTEGER,
      name TEXT NOT NULL,
      cpf TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      status_atendimento TEXT NOT NULL DEFAULT 'novo_na_fila',
      consulta_status TEXT NOT NULL DEFAULT 'sem_marg',
      consulta_mensagem TEXT NOT NULL DEFAULT '',
      raw_data_json TEXT NOT NULL DEFAULT '{}',
      has_duplicate_in_other_base INTEGER NOT NULL DEFAULT 0,
      best_product_type TEXT NOT NULL DEFAULT '',
      best_net_margin REAL,
      current_margin REAL,
      status TEXT NOT NULL DEFAULT 'novo_na_fila',
      assigned_to INTEGER,
      queue_position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (base_id) REFERENCES bases(id) ON DELETE SET NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL,
      FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
    );
  `);
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_base_cpf ON clients(base_id, cpf)');

  const legacyRows = queryAll(database, 'SELECT * FROM clients_legacy ORDER BY id ASC');
  const insertClient = database.prepare(`
    INSERT INTO clients (
      id, base_id, campaign_id, name, cpf, phone, email, status_atendimento, consulta_status, consulta_mensagem,
      raw_data_json, has_duplicate_in_other_base, best_product_type, best_net_margin, current_margin, status,
      assigned_to, queue_position, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of legacyRows) {
    const baseId = row.base_id ?? row.campaign_id ?? null;
    insertClient.run(
      row.id,
      baseId,
      row.campaign_id ?? baseId,
      row.name,
      row.cpf,
      row.phone || '',
      row.email || '',
      row.status_atendimento || row.status || 'novo_na_fila',
      row.consulta_status || 'sem_marg',
      row.consulta_mensagem || '',
      row.raw_data_json || '{}',
      row.has_duplicate_in_other_base || 0,
      row.best_product_type || '',
      row.best_net_margin,
      row.current_margin,
      row.status || row.status_atendimento || 'novo_na_fila',
      row.assigned_to ?? null,
      row.queue_position || 0,
      row.created_at,
      row.updated_at
    );
  }

  database.exec('DROP TABLE clients_legacy');
  database.exec(`PRAGMA foreign_keys = ${hadForeignKeys ? 'ON' : 'OFF'}`);
}

function refreshBaseTotals(database, baseId) {
  if (!baseId) {
    return;
  }

  const totals = queryOne(
    database,
    `
      SELECT
        COUNT(*) AS total_clientes,
        SUM(CASE WHEN consulta_status = 'com_marg' THEN 1 ELSE 0 END) AS total_com_margem,
        SUM(CASE WHEN consulta_status = 'sem_marg' THEN 1 ELSE 0 END) AS total_sem_margem,
        SUM(CASE WHEN consulta_status = 'erro' THEN 1 ELSE 0 END) AS total_erro
      FROM clients
      WHERE COALESCE(base_id, campaign_id) = ?
    `,
    [baseId]
  ) || { total_clientes: 0, total_com_margem: 0, total_sem_margem: 0, total_erro: 0 };

  database
    .prepare(
      `
        UPDATE bases
        SET
          total_clientes = ?,
          total_com_margem = ?,
          total_sem_margem = ?,
          total_erro = ?,
          updated_at = ?
        WHERE id = ?
      `
    )
    .run(
      Number(totals.total_clientes || 0),
      Number(totals.total_com_margem || 0),
      Number(totals.total_sem_margem || 0),
      Number(totals.total_erro || 0),
      nowIso(),
      baseId
    );
}

function seedDefaults(database) {
  const userCount = Number((queryOne(database, 'SELECT COUNT(*) AS count FROM users') || { count: 0 }).count || 0);
  const existingLogins = new Set(queryAll(database, 'SELECT login FROM users').map((row) => String(row.login || '').toLowerCase()));
  const seedPasswordHash = hashPassword(INITIAL_USER_PASSWORD);

  if (userCount === 0) {
    const insertUser = database.prepare(
      'INSERT INTO users (name, login, email, password_hash, role, is_active, last_login_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const user of SAMPLE_USERS) {
      insertUser.run(user.name, user.login, user.login, seedPasswordHash, user.role, 1, null, nowIso(), nowIso());
    }
  } else {
    const insertUser = database.prepare(
      'INSERT INTO users (name, login, email, password_hash, role, is_active, last_login_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const user of SAMPLE_USERS) {
      if (!existingLogins.has(user.login.toLowerCase())) {
        insertUser.run(user.name, user.login, user.login, seedPasswordHash, user.role, 1, null, nowIso(), nowIso());
      }
    }
  }

  const settingsCount = Number((queryOne(database, 'SELECT COUNT(*) AS count FROM settings') || { count: 0 }).count || 0);
  if (settingsCount === 0) {
    const insertSetting = database.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      insertSetting.run(key, String(value));
    }
  }

  const clientCount = Number((queryOne(database, 'SELECT COUNT(*) AS count FROM clients') || { count: 0 }).count || 0);
  if (clientCount === 0) {
    const now = nowIso();
    database
      .prepare(`
        INSERT INTO bases (
          nome_base, tipo_base, convenio, estado, cidade, arquivo_original,
          total_clientes, total_com_margem, total_sem_margem, total_erro,
          observacao, is_active, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        SAMPLE_BASE.nome_base,
        SAMPLE_BASE.tipo_base,
        SAMPLE_BASE.convenio,
        SAMPLE_BASE.estado,
        SAMPLE_BASE.cidade,
        SAMPLE_BASE.arquivo_original,
        SAMPLE_CLIENTS.length,
        0,
        0,
        0,
        SAMPLE_BASE.observacao,
        1,
        null,
        now,
        now
      );
    const baseId = Number(queryOne(database, 'SELECT id FROM bases ORDER BY id DESC LIMIT 1').id);
    database
      .prepare('INSERT INTO campaigns (id, name, file_name, total_clients, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(baseId, SAMPLE_BASE.nome_base, SAMPLE_BASE.arquivo_original, SAMPLE_CLIENTS.length, now);
    const insertClient = database.prepare(`
      INSERT INTO clients (
        base_id, campaign_id, name, cpf, phone, email, status_atendimento, consulta_status, consulta_mensagem,
        raw_data_json, has_duplicate_in_other_base, best_product_type, best_net_margin, current_margin, status, assigned_to,
        queue_position, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMargin = database.prepare(`
      INSERT INTO client_margins (
        client_id, product_type, gross_margin, net_margin, source_gross_column, source_net_column, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    SAMPLE_CLIENTS.forEach((client, index) => {
      const rawData = {
        CPF: client.cpf,
        Nome: client.name,
        Telefone: client.phone,
        Email: client.email,
        'Margem Bruta Consignacao': client.margins.consignacao.gross_margin,
        'Margem Liquida Consignacao': client.margins.consignacao.net_margin,
        'Margem Bruta Credito': client.margins.credito.gross_margin,
        'Margem Liquida Credito': client.margins.credito.net_margin,
        'Margem Bruta Cartao': client.margins.cartao.gross_margin,
        'Margem Liquida Cartao': client.margins.cartao.net_margin,
        Status: client.consulta_status,
        Mensagem: client.consulta_mensagem,
      };
      const best = bestMarginFromMargins([
        { product_type: 'consignacao', ...client.margins.consignacao },
        { product_type: 'credito', ...client.margins.credito },
        { product_type: 'cartao', ...client.margins.cartao },
      ]);
      const currentMargin = best.net_margin === null || best.net_margin === undefined ? 0 : best.net_margin;

      insertClient.run(
        baseId,
        baseId,
        client.name,
        client.cpf,
        normalizePhoneToBrazilInternational(client.phone),
        client.email,
        'novo_na_fila',
        client.consulta_status,
        client.consulta_mensagem,
        JSON.stringify(rawData),
        0,
        best.product_type,
        best.net_margin,
        currentMargin,
        'novo_na_fila',
        null,
        index + 1,
        nowIso(),
        nowIso()
      );

      const clientId = Number(queryOne(database, 'SELECT id FROM clients WHERE base_id = ? AND cpf = ?', [baseId, client.cpf]).id);
      for (const [productType, margin] of Object.entries(client.margins)) {
        insertMargin.run(
          clientId,
          productType,
          margin.gross_margin,
          margin.net_margin,
          `Margem Bruta ${productLabel(productType)}`,
          `Margem Liquida ${productLabel(productType)}`,
          nowIso(),
          nowIso()
        );
      }
    });

    refreshBaseTotals(database, baseId);
  }

  migrateLegacyRows(database);
}

function migrateLegacyRows(database) {
  const clients = queryAll(database, 'SELECT * FROM clients');
  const hasMargins = new Map(
    queryAll(database, 'SELECT client_id, COUNT(*) AS count FROM client_margins GROUP BY client_id').map((row) => [
      row.client_id,
      Number(row.count || 0),
    ])
  );

  const insertMargin = database.prepare(`
    INSERT INTO client_margins (
      client_id, product_type, gross_margin, net_margin, source_gross_column, source_net_column, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id, product_type) DO UPDATE SET
      gross_margin = excluded.gross_margin,
      net_margin = excluded.net_margin,
      source_gross_column = excluded.source_gross_column,
      source_net_column = excluded.source_net_column,
      updated_at = excluded.updated_at
  `);

  const updateClient = database.prepare(`
    UPDATE clients
    SET
      status_atendimento = ?,
      consulta_status = ?,
      consulta_mensagem = ?,
      raw_data_json = ?,
      best_product_type = ?,
      best_net_margin = ?,
      current_margin = ?,
      status = ?,
      updated_at = ?
    WHERE id = ?
  `);

  for (const client of clients) {
    const statusAtendimento = client.status_atendimento || client.status || 'novo_na_fila';
    const consultaStatus = client.consulta_status || normalizeConsultaStatus(client.status, 'sem_marg') || 'sem_marg';
    const consultaMensagem = client.consulta_mensagem || '';
    const rawData = client.raw_data_json && client.raw_data_json !== '{}' ? client.raw_data_json : stringifyRawRow({
      CPF: client.cpf,
      Nome: client.name,
      Telefone: client.phone,
      Email: client.email,
    });

    let bestProductType = client.best_product_type || '';
    let bestNetMargin = client.best_net_margin ?? client.current_margin ?? null;
    const currentMargin = bestNetMargin === null || bestNetMargin === undefined ? 0 : bestNetMargin;

    if (!bestProductType && bestNetMargin !== null && bestNetMargin !== undefined) {
      bestProductType = 'outros';
    }

    if (!hasMargins.get(client.id) && bestNetMargin !== null && bestNetMargin !== undefined) {
      insertMargin.run(
        client.id,
        bestProductType || 'outros',
        bestNetMargin,
        bestNetMargin,
        'current_margin',
        'current_margin',
        nowIso(),
        nowIso()
      );
    }

    updateClient.run(
      statusAtendimento,
      consultaStatus,
      consultaMensagem,
      rawData,
      bestProductType,
      bestNetMargin,
      currentMargin,
      statusAtendimento,
      nowIso(),
      client.id
    );
  }

  const baseIds = Array.from(new Set(clients.map((client) => Number(client.base_id || client.campaign_id || 0)).filter(Boolean)));
  for (const baseId of baseIds) {
    refreshBaseTotals(database, baseId);
  }
}

export async function initDb() {
  if (db) {
    return db;
  }

  if (!initPromise) {
    initPromise = (async () => {
      const sqlJs = await initSqlJs({
        locateFile: (file) => pathToFileURL(path.join(SQL_WASM_DIR, file)).href,
      });

      ensureRuntimeDirectories();
      const dbPath = getDatabasePath();
      rawDb = fs.existsSync(dbPath) ? new sqlJs.Database(fs.readFileSync(dbPath)) : new sqlJs.Database();
      db = createAdapter(rawDb);

      initSchema(db);
      rebuildClientsTableForBaseSupport(db);
      backfillBasesFromCampaigns(db);
      normalizeLegacyUsers(db);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login ON users(login)');
      seedDefaults(db);
      persistDb();
      return db;
    })();
  }

  return initPromise;
}

export function getDb() {
  if (!db) {
    throw new Error('Banco de dados nao inicializado. Aguarde initDb().');
  }
  return db;
}

function getClientMargins(database, clientId) {
  return queryAll(
    database,
    `
      SELECT *
      FROM client_margins
      WHERE client_id = ?
      ORDER BY
        CASE product_type
          WHEN 'consignacao' THEN 0
          WHEN 'credito' THEN 1
          WHEN 'cartao' THEN 2
          ELSE 3
        END
    `,
    [clientId]
  ).map((row) => ({
    ...row,
    gross_margin: row.gross_margin === null || row.gross_margin === undefined ? null : Number(row.gross_margin),
    net_margin: row.net_margin === null || row.net_margin === undefined ? null : Number(row.net_margin),
    product_label: productLabel(row.product_type),
    status_label: marginStatus(row.net_margin),
    gross_margin_formatted: formatMoney(row.gross_margin),
    net_margin_formatted: formatMoney(row.net_margin),
  }));
}

function getClientBaseQuery() {
  return `
    SELECT
      c.*,
      COALESCE(b.nome_base, cam.name) AS campaign_name,
      COALESCE(b.arquivo_original, cam.file_name) AS campaign_file_name,
      b.id AS base_join_id,
      b.nome_base AS base_name,
      b.tipo_base AS base_type,
      b.convenio AS base_convenio,
      b.estado AS base_state,
      b.cidade AS base_city,
      b.arquivo_original AS base_file_name,
      b.observacao AS base_observation,
      b.is_active AS base_is_active,
      b.archived_at AS base_archived_at,
      b.created_at AS base_created_at,
      b.updated_at AS base_updated_at,
      u.name AS assigned_to_name,
      (
        SELECT i.created_at
        FROM interactions i
        WHERE i.client_id = c.id
        ORDER BY datetime(i.created_at) DESC, i.id DESC
        LIMIT 1
      ) AS last_interaction_at,
      (
        SELECT i.type
        FROM interactions i
        WHERE i.client_id = c.id
        ORDER BY datetime(i.created_at) DESC, i.id DESC
        LIMIT 1
      ) AS last_interaction_type,
      (
        SELECT i.note
        FROM interactions i
        WHERE i.client_id = c.id
        ORDER BY datetime(i.created_at) DESC, i.id DESC
        LIMIT 1
      ) AS last_interaction_note,
      (
        SELECT r.return_at
        FROM scheduled_returns r
        WHERE r.client_id = c.id AND r.status = 'pending'
        ORDER BY datetime(r.return_at) ASC, r.id ASC
        LIMIT 1
      ) AS next_return_at
    FROM clients c
    LEFT JOIN bases b ON b.id = COALESCE(c.base_id, c.campaign_id)
    LEFT JOIN campaigns cam ON cam.id = c.campaign_id
    LEFT JOIN users u ON u.id = c.assigned_to
  `;
}

function parseHeaderAliases(headers, aliases) {
  return matchColumn(headers, aliases);
}

function detectMarginColumns(headers, productKey) {
  const productAliases = PRODUCT_DEFINITIONS[productKey]?.aliases || [];
  const gross = headers.find((header) => {
    const norm = normalizeHeaderKey(header);
    return (
      norm.includes('margem') &&
      productAliases.some((alias) => norm.includes(normalizeHeaderKey(alias))) &&
      (norm.includes('bruta') || norm.includes('gross')) &&
      !norm.includes('liqu')
    );
  });
  const net = headers.find((header) => {
    const norm = normalizeHeaderKey(header);
    return (
      norm.includes('margem') &&
      productAliases.some((alias) => norm.includes(normalizeHeaderKey(alias))) &&
      (norm.includes('liquida') || norm.includes('liquido') || norm.includes('liqu') || norm.includes('lqu') || norm.includes('net'))
    );
  });

  return {
    gross: gross || '',
    net: net || '',
  };
}

function extractConsultaFields(row, headers) {
  const statusColumn =
    parseHeaderAliases(headers, ['Status', 'Status da consulta', 'Status Consulta', 'Consulta Status']) || '';
  const messageColumn =
    parseHeaderAliases(headers, [
      'Mensagem',
      'Mensagem da consulta',
      'Mensagem Consulta',
      'Observacao',
      'Observação',
      'Retorno',
      'Erro',
    ]) || '';

  const statusRaw = statusColumn ? row[statusColumn] : '';
  const messageRaw = messageColumn ? row[messageColumn] : '';
  return {
    statusColumn,
    messageColumn,
    consulta_status: normalizeConsultaStatus(statusRaw, ''),
    consulta_mensagem: String(messageRaw ?? '').trim(),
  };
}

function extractMainFields(row, headers) {
  const cpfColumn =
    parseHeaderAliases(headers, ['CPF', 'cpf', 'documento', 'Documento', 'doc', 'cadastrado cpf']) || '';
  const nameColumn =
    parseHeaderAliases(headers, ['Nome', 'NOME', 'nome', 'cliente', 'Cliente', 'client', 'titular']) || '';
  const phoneColumn =
    parseHeaderAliases(headers, ['Telefone', 'TELEFONE', 'telefone', 'celular', 'whatsapp', 'phone', 'contato']) || '';
  const emailColumn =
    parseHeaderAliases(headers, ['Email', 'E-mail', 'e-mail', 'email', 'EMAIL', 'correio']) || '';

  return { cpfColumn, nameColumn, phoneColumn, emailColumn };
}

function buildRecognizedField(status, sourceColumn, alerts = []) {
  return {
    status: alerts.length ? 'alert' : status,
    source_column: sourceColumn || '',
    alerts,
  };
}

function analyzeRow(row, headers) {
  const rawData = { ...row };
  const { cpfColumn, nameColumn, phoneColumn, emailColumn } = extractMainFields(row, headers);
  const consulta = extractConsultaFields(row, headers);
  const marginColumns = {
    consignacao: detectMarginColumns(headers, 'consignacao'),
    credito: detectMarginColumns(headers, 'credito'),
    cartao: detectMarginColumns(headers, 'cartao'),
  };

  const cpfInfo = normalizeCpfValue(cpfColumn ? row[cpfColumn] : '');
  const name = String(nameColumn ? row[nameColumn] : '').trim();
  const phone = normalizePhoneToBrazilInternational(phoneColumn ? row[phoneColumn] : '');
  const email = String(emailColumn ? row[emailColumn] : '').trim();

  const margins = {};
  const marginPreview = {};
  for (const [productType, columns] of Object.entries(marginColumns)) {
    const gross = columns.gross ? parseMoney(row[columns.gross]) : null;
    const net = columns.net ? parseMoney(row[columns.net]) : null;
    margins[productType] = {
      product_type: productType,
      gross_margin: gross,
      net_margin: net,
      source_gross_column: columns.gross || '',
      source_net_column: columns.net || '',
    };
    marginPreview[`${productType}_gross`] = gross;
    marginPreview[`${productType}_net`] = net;
  }

  const fallbackMarginColumn = parseHeaderAliases(headers, ['Margem Atualizada', 'Margem', 'Valor Margem', 'current_margin']) || '';
  if (fallbackMarginColumn && !margins.consignacao.gross_margin && !margins.consignacao.net_margin) {
    const value = parseMoney(row[fallbackMarginColumn]);
    margins.outros = {
      product_type: 'outros',
      gross_margin: value,
      net_margin: value,
      source_gross_column: fallbackMarginColumn,
      source_net_column: fallbackMarginColumn,
    };
    marginPreview.outros_gross = value;
    marginPreview.outros_net = value;
  }

  const best = bestMarginFromMargins(Object.values(margins));
  const consultaStatus = consulta.consulta_status || (marginStatus(best.net_margin) === 'disponivel' ? 'com_marg' : 'sem_marg');
  const consultaMensagem = consulta.consulta_mensagem || '';
  const rowAlerts = [...cpfInfo.alerts];

  if (!name) {
    rowAlerts.push('Nome vazio');
  }

  if (!cpfInfo.isValid) {
    rowAlerts.push('CPF invalido');
  }

  if (!phone) {
    rowAlerts.push('Telefone ausente');
  }

  if (!consulta.statusColumn) {
    rowAlerts.push('Status nao encontrado');
  }

  if (!consulta.messageColumn) {
    rowAlerts.push('Mensagem nao encontrada');
  }

  const recognizedFields = {
    cpf: buildRecognizedField(cpfColumn ? 'identified' : 'not_found', cpfColumn, cpfInfo.alerts),
    name: buildRecognizedField(nameColumn ? 'identified' : 'not_found', nameColumn, name ? [] : ['Nome vazio']),
    phone: buildRecognizedField(phoneColumn ? 'identified' : 'not_found', phoneColumn, phone ? [] : ['Telefone ausente']),
    email: buildRecognizedField(emailColumn ? 'identified' : 'not_found', emailColumn, email ? [] : ['E-mail nao encontrado']),
    consignacao_gross: buildRecognizedField(marginColumns.consignacao.gross ? 'identified' : 'not_found', marginColumns.consignacao.gross),
    consignacao_net: buildRecognizedField(marginColumns.consignacao.net ? 'identified' : 'not_found', marginColumns.consignacao.net),
    credito_gross: buildRecognizedField(marginColumns.credito.gross ? 'identified' : 'not_found', marginColumns.credito.gross),
    credito_net: buildRecognizedField(marginColumns.credito.net ? 'identified' : 'not_found', marginColumns.credito.net),
    cartao_gross: buildRecognizedField(marginColumns.cartao.gross ? 'identified' : 'not_found', marginColumns.cartao.gross),
    cartao_net: buildRecognizedField(marginColumns.cartao.net ? 'identified' : 'not_found', marginColumns.cartao.net),
    status: buildRecognizedField(consulta.statusColumn ? 'identified' : 'not_found', consulta.statusColumn, consulta.statusColumn ? [] : ['Status nao encontrado']),
    message: buildRecognizedField(consulta.messageColumn ? 'identified' : 'not_found', consulta.messageColumn, consulta.messageColumn ? [] : ['Mensagem nao encontrada']),
  };

  return {
    rowNumber: 0,
    raw_data: rawData,
    raw_data_json: stringifyRawRow(rawData),
    cpf: cpfInfo.cpf,
    cpf_display: formatCpfDisplay(cpfInfo.cpf),
    name,
    phone,
    email,
    consulta_status: consultaStatus,
    consulta_status_label: consultaStatusLabel(consultaStatus),
    consulta_mensagem: consultaMensagem,
    margins,
    best_product_type: best.product_type || '',
    best_product_label: productLabel(best.product_type),
    best_net_margin: best.net_margin === null || best.net_margin === undefined ? null : Number(best.net_margin),
    best_net_margin_formatted: formatMoney(best.net_margin),
    margem_bruta_consignacao: marginPreview.consignacao_gross ?? null,
    margem_liquida_consignacao: marginPreview.consignacao_net ?? null,
    margem_bruta_credito: marginPreview.credito_gross ?? null,
    margem_liquida_credito: marginPreview.credito_net ?? null,
    margem_bruta_cartao: marginPreview.cartao_gross ?? null,
    margem_liquida_cartao: marginPreview.cartao_net ?? null,
    status_atendimento: 'novo_na_fila',
    row_alerts: rowAlerts,
    recognizedFields,
    isValid: Boolean(name && cpfInfo.cpf),
  };
}

function consultaStatusFromRow(row) {
  return row.consulta_status || 'sem_marg';
}

export function analyzeSpreadsheet(buffer, filename) {
  const rows = readSpreadsheetRows(buffer, filename);
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const mainFields = extractMainFields(rows[0] || {}, headers);
  const consulta = extractConsultaFields(rows[0] || {}, headers);
  const marginColumns = {
    consignacao: detectMarginColumns(headers, 'consignacao'),
    credito: detectMarginColumns(headers, 'credito'),
    cartao: detectMarginColumns(headers, 'cartao'),
  };

  const recognizedFields = {
    cpf: buildRecognizedField(mainFields.cpfColumn ? 'identified' : 'not_found', mainFields.cpfColumn),
    name: buildRecognizedField(mainFields.nameColumn ? 'identified' : 'not_found', mainFields.nameColumn),
    phone: buildRecognizedField(mainFields.phoneColumn ? 'identified' : 'not_found', mainFields.phoneColumn),
    email: buildRecognizedField(mainFields.emailColumn ? 'identified' : 'not_found', mainFields.emailColumn),
    consignacao_gross: buildRecognizedField(marginColumns.consignacao.gross ? 'identified' : 'not_found', marginColumns.consignacao.gross),
    consignacao_net: buildRecognizedField(marginColumns.consignacao.net ? 'identified' : 'not_found', marginColumns.consignacao.net),
    credito_gross: buildRecognizedField(marginColumns.credito.gross ? 'identified' : 'not_found', marginColumns.credito.gross),
    credito_net: buildRecognizedField(marginColumns.credito.net ? 'identified' : 'not_found', marginColumns.credito.net),
    cartao_gross: buildRecognizedField(marginColumns.cartao.gross ? 'identified' : 'not_found', marginColumns.cartao.gross),
    cartao_net: buildRecognizedField(marginColumns.cartao.net ? 'identified' : 'not_found', marginColumns.cartao.net),
    status: buildRecognizedField(consulta.statusColumn ? 'identified' : 'not_found', consulta.statusColumn),
    message: buildRecognizedField(consulta.messageColumn ? 'identified' : 'not_found', consulta.messageColumn),
  };

  const previewRows = rows.map((row, index) => {
    const analyzed = analyzeRow(row, headers);
    analyzed.rowNumber = index + 2;
    return analyzed;
  });

  const fieldAlertMap = new Map();
  for (const row of previewRows) {
    for (const [key, field] of Object.entries(row.recognizedFields)) {
      if (!fieldAlertMap.has(key)) {
        fieldAlertMap.set(key, []);
      }
      if (field.alerts.length) {
        fieldAlertMap.get(key).push(...field.alerts);
      }
    }
  }

  for (const [key, field] of Object.entries(recognizedFields)) {
    const alerts = fieldAlertMap.get(key) || [];
    if (alerts.length) {
      field.status = field.status === 'not_found' ? 'not_found' : 'alert';
      field.alerts = Array.from(new Set(alerts));
    } else {
      field.alerts = [];
    }
  }

  const summary = {
    total_rows: previewRows.length,
    valid_rows: previewRows.filter((row) => row.isValid).length,
    invalid_rows: previewRows.filter((row) => !row.isValid).length,
    warnings: previewRows.reduce((acc, row) => acc + row.row_alerts.length, 0),
    duplicates: 0,
  };

  return {
    filename,
    headers,
    recognizedFields,
    rows: previewRows,
    previewRows,
    summary,
  };
}

function upsertClientMargin(database, clientId, margin) {
  database
    .prepare(`
      INSERT INTO client_margins (
        client_id, product_type, gross_margin, net_margin, source_gross_column, source_net_column, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id, product_type) DO UPDATE SET
        gross_margin = excluded.gross_margin,
        net_margin = excluded.net_margin,
        source_gross_column = excluded.source_gross_column,
        source_net_column = excluded.source_net_column,
        updated_at = excluded.updated_at
    `)
    .run(
      clientId,
      margin.product_type,
      margin.gross_margin,
      margin.net_margin,
      margin.source_gross_column || '',
      margin.source_net_column || '',
      nowIso(),
      nowIso()
    );
}

function createBaseAndCampaign(database, baseInput, fileName, totalClients) {
  const now = nowIso();
  const baseName = normalizeBaseText(baseInput.nome_base || suggestedBaseNameFromFilename(fileName));
  const baseType = baseTypeLabel(baseInput.tipo_base || 'Outro');
  const convenio = normalizeBaseText(baseInput.convenio || baseName);
  const estado = normalizeBaseText(baseInput.estado || '');
  const cidade = normalizeBaseText(baseInput.cidade || '');
  const observation = normalizeBaseText(baseInput.observacao || '');

  database
    .prepare(`
      INSERT INTO bases (
        nome_base, tipo_base, convenio, estado, cidade, arquivo_original,
        total_clientes, total_com_margem, total_sem_margem, total_erro,
        observacao, is_active, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      baseName,
      baseType,
      convenio,
      estado,
      cidade,
      fileName,
      totalClients,
      0,
      0,
      0,
      observation,
      1,
      null,
      now,
      now
    );

  const baseId = Number(queryOne(database, 'SELECT id FROM bases ORDER BY id DESC LIMIT 1').id);
  database
    .prepare('INSERT INTO campaigns (id, name, file_name, total_clients, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(baseId, baseName, fileName, totalClients, now);

  return {
    id: baseId,
    nome_base: baseName,
    tipo_base: baseType,
    convenio,
    estado,
    cidade,
    arquivo_original: fileName,
    total_clientes: totalClients,
    total_com_margem: 0,
    total_sem_margem: 0,
    total_erro: 0,
    observacao,
    is_active: 1,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
}

function saveClientRecord(database, baseId, row, sourceFileName, queuePosition) {
  const existing = queryOne(database, 'SELECT * FROM clients WHERE base_id = ? AND cpf = ?', [baseId, row.cpf]);
  const rawDataJson = row.raw_data_json;
  const best = bestMarginFromMargins(Object.values(row.margins));
  const consultaStatus = row.consulta_status || (marginStatus(best.net_margin) === 'disponivel' ? 'com_marg' : 'sem_marg');
  const consultaMensagem = row.consulta_mensagem || '';
  const statusAtendimento = existing?.status_atendimento === 'em_atendimento' ? 'em_atendimento' : 'novo_na_fila';
  const assignedTo = existing?.status_atendimento === 'em_atendimento' ? existing.assigned_to : null;
  const now = nowIso();

  database
    .prepare(`
      INSERT INTO clients (
        base_id, campaign_id, name, cpf, phone, email, status_atendimento, consulta_status, consulta_mensagem,
        raw_data_json, has_duplicate_in_other_base, best_product_type, best_net_margin, current_margin, status, assigned_to,
        queue_position, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(base_id, cpf) DO UPDATE SET
        campaign_id = excluded.campaign_id,
        name = excluded.name,
        phone = excluded.phone,
        email = excluded.email,
        status_atendimento = excluded.status_atendimento,
        consulta_status = excluded.consulta_status,
        consulta_mensagem = excluded.consulta_mensagem,
        raw_data_json = excluded.raw_data_json,
        has_duplicate_in_other_base = excluded.has_duplicate_in_other_base,
        best_product_type = excluded.best_product_type,
        best_net_margin = excluded.best_net_margin,
        current_margin = excluded.current_margin,
        status = excluded.status,
        assigned_to = excluded.assigned_to,
        queue_position = excluded.queue_position,
        updated_at = excluded.updated_at
    `)
    .run(
      baseId,
      baseId,
      row.name,
      row.cpf,
      row.phone || '',
      row.email || '',
      statusAtendimento,
      consultaStatus,
      consultaMensagem,
      rawDataJson,
      0,
      best.product_type || '',
      best.net_margin,
      best.net_margin,
      statusAtendimento,
      assignedTo,
      queuePosition,
      existing?.created_at || now,
      now
    );

  const clientId = Number(queryOne(database, 'SELECT id FROM clients WHERE base_id = ? AND cpf = ?', [baseId, row.cpf]).id);
  database.prepare('DELETE FROM client_margins WHERE client_id = ?').run(clientId);
  for (const margin of Object.values(row.margins)) {
    if (
      margin.gross_margin === null &&
      margin.net_margin === null &&
      !margin.source_gross_column &&
      !margin.source_net_column
    ) {
      continue;
    }
    upsertClientMargin(database, clientId, margin);
  }

  const duplicateBases = queryAll(
    database,
    `
      SELECT DISTINCT COALESCE(b.id, c.campaign_id) AS base_id
      FROM clients c
      LEFT JOIN bases b ON b.id = COALESCE(c.base_id, c.campaign_id)
      WHERE c.cpf = ? AND COALESCE(c.base_id, c.campaign_id) <> ?
    `,
    [row.cpf, baseId]
  );
  const hasDuplicateInOtherBase = duplicateBases.length > 0 ? 1 : 0;
  database.prepare('UPDATE clients SET has_duplicate_in_other_base = ?, updated_at = ? WHERE id = ?').run(hasDuplicateInOtherBase, nowIso(), clientId);
  if (hasDuplicateInOtherBase) {
    database
      .prepare('UPDATE clients SET has_duplicate_in_other_base = 1, updated_at = ? WHERE cpf = ? AND COALESCE(base_id, campaign_id) <> ?')
      .run(nowIso(), row.cpf, baseId);
  }

  return { clientId, best, consultaStatus, consultaMensagem, hasDuplicateInOtherBase };
}

export function saveImportedSpreadsheet(buffer, filename, baseInput = {}) {
  const analysis = analyzeSpreadsheet(buffer, filename);
  const validRows = analysis.previewRows.filter((row) => row.isValid);
  const database = getDb();
  const nextQueuePosition =
    Number((queryOne(database, 'SELECT COALESCE(MAX(queue_position), 0) AS max_queue FROM clients') || { max_queue: 0 }).max_queue || 0) + 1;
  const baseRecord = createBaseAndCampaign(database, baseInput, filename, validRows.length);

  const tx = database.transaction((rowsToSave) => {
    let queuePosition = nextQueuePosition;
    let inserted = 0;
    let updated = 0;

    for (const row of rowsToSave) {
      const existing = queryOne(database, 'SELECT id FROM clients WHERE base_id = ? AND cpf = ?', [baseRecord.id, row.cpf]);
      saveClientRecord(database, baseRecord.id, row, filename, queuePosition++);
      if (existing) {
        updated += 1;
      } else {
        inserted += 1;
      }
    }

    return { inserted, updated };
  });

  const counts = tx(validRows);
  refreshBaseTotals(database, baseRecord.id);

  return {
    base: {
      ...baseRecord,
      total_clientes: validRows.length,
    },
    analysis,
    inserted: counts.inserted,
    updated: counts.updated,
  };
}

export function listClients(params = {}) {
  const database = getDb();
  const filters = [];
  const values = [];

  if (String(params.include_archived || '') !== '1' && params.include_archived !== true) {
    filters.push('COALESCE(b.is_active, 1) = 1');
  }

  if (params.status_atendimento) {
    filters.push('c.status_atendimento = ?');
    values.push(params.status_atendimento);
  }

  if (params.consulta_status) {
    filters.push('c.consulta_status = ?');
    values.push(params.consulta_status);
  }

  if (params.best_product_type) {
    filters.push('c.best_product_type = ?');
    values.push(params.best_product_type);
  }

  if (params.margin_state === 'positive') {
    filters.push('COALESCE(c.best_net_margin, 0) > 0');
  }

  if (params.margin_state === 'zero') {
    filters.push('COALESCE(c.best_net_margin, 0) = 0');
  }

  if (params.margin_state === 'negative') {
    filters.push('COALESCE(c.best_net_margin, 0) < 0');
  }

  if (params.margin_state === 'error') {
    filters.push("c.consulta_status = 'erro'");
  }

  if (params.campaign_id) {
    filters.push('COALESCE(c.base_id, c.campaign_id) = ?');
    values.push(Number(params.campaign_id));
  }

  if (params.base_id) {
    filters.push('COALESCE(c.base_id, c.campaign_id) = ?');
    values.push(Number(params.base_id));
  }

  if (params.base_type) {
    filters.push('b.tipo_base = ?');
    values.push(String(params.base_type));
  }

  if (params.convenio) {
    filters.push('b.convenio = ?');
    values.push(String(params.convenio));
  }

  if (params.estado) {
    filters.push('b.estado = ?');
    values.push(String(params.estado));
  }

  if (params.cidade) {
    filters.push('b.cidade = ?');
    values.push(String(params.cidade));
  }

  if (params.assigned_to) {
    filters.push('c.assigned_to = ?');
    values.push(Number(params.assigned_to));
  }

  if (params.search) {
    filters.push('(c.name LIKE ? OR c.cpf LIKE ? OR c.phone LIKE ?)');
    const search = `%${String(params.search).trim()}%`;
    values.push(search, search, search);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = queryAll(
    database,
    `
      ${getClientBaseQuery()}
      ${whereClause}
      ORDER BY
        CASE c.status_atendimento
          WHEN 'em_atendimento' THEN 0
          WHEN 'aguardando_retorno' THEN 1
          WHEN 'novo_na_fila' THEN 2
          WHEN 'convertido' THEN 3
          WHEN 'finalizado' THEN 4
          WHEN 'sem_interesse' THEN 5
          ELSE 6
        END,
        c.queue_position ASC,
        datetime(c.updated_at) DESC,
        c.id DESC
    `,
    values
  );

  const clients = rows.map((row) => {
    const margins = getClientMargins(database, row.id);
    const interactions = queryAll(
      database,
      `
        SELECT i.*, u.name AS user_name
        FROM interactions i
        LEFT JOIN users u ON u.id = i.user_id
        WHERE i.client_id = ?
        ORDER BY datetime(i.created_at) DESC, i.id DESC
      `,
      [row.id]
    );
    const returns = queryAll(
      database,
      `
        SELECT r.*, u.name AS user_name
        FROM scheduled_returns r
        LEFT JOIN users u ON u.id = r.user_id
        WHERE r.client_id = ?
        ORDER BY datetime(r.return_at) ASC, r.id ASC
      `,
      [row.id]
    );
    const deals = queryAll(
      database,
      `
        SELECT d.*, u.name AS user_name
        FROM deals d
        LEFT JOIN users u ON u.id = d.user_id
        WHERE d.client_id = ?
        ORDER BY datetime(d.created_at) DESC, d.id DESC
      `,
      [row.id]
    );

    return clientDto(database, row, margins, interactions, returns, deals);
  });

  const stats = queryOne(
    database,
    `
      SELECT
        SUM(CASE WHEN status_atendimento = 'novo_na_fila' THEN 1 ELSE 0 END) AS novo_na_fila,
        SUM(CASE WHEN status_atendimento = 'em_atendimento' THEN 1 ELSE 0 END) AS em_atendimento,
        SUM(CASE WHEN status_atendimento = 'aguardando_retorno' THEN 1 ELSE 0 END) AS aguardando_retorno,
        SUM(CASE WHEN status_atendimento = 'finalizado' THEN 1 ELSE 0 END) AS finalizado,
        SUM(CASE WHEN status_atendimento = 'sem_interesse' THEN 1 ELSE 0 END) AS sem_interesse,
        SUM(CASE WHEN status_atendimento = 'convertido' THEN 1 ELSE 0 END) AS convertido
      FROM clients c
      LEFT JOIN bases b ON b.id = COALESCE(c.base_id, c.campaign_id)
      ${whereClause}
    `,
    values
  ) || {};

  return {
    clients,
    meta: {
      stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value || 0)])),
      campaigns: getBases(),
      bases: getBases(),
      users: getUsers(),
    },
  };
}

export function getNextClient(params = {}) {
  const database = getDb();
  const filters = ["c.status_atendimento IN ('novo_na_fila', 'aguardando_retorno')"];
  const values = [];

  if (String(params.include_archived || '') !== '1' && params.include_archived !== true) {
    filters.push('COALESCE(b.is_active, 1) = 1');
  }

  if (params.base_id) {
    filters.push('COALESCE(c.base_id, c.campaign_id) = ?');
    values.push(Number(params.base_id));
  }

  if (params.base_type) {
    filters.push('b.tipo_base = ?');
    values.push(String(params.base_type));
  }

  if (params.convenio) {
    filters.push('b.convenio = ?');
    values.push(String(params.convenio));
  }

  if (params.estado) {
    filters.push('b.estado = ?');
    values.push(String(params.estado));
  }

  if (params.cidade) {
    filters.push('b.cidade = ?');
    values.push(String(params.cidade));
  }

  const row = queryOne(
    database,
    `
      ${getClientBaseQuery()}
      WHERE ${filters.join(' AND ')}
      ORDER BY
        CASE c.status_atendimento WHEN 'aguardando_retorno' THEN 0 ELSE 1 END,
        c.queue_position ASC,
        COALESCE(datetime(c.updated_at), datetime(c.created_at)) ASC,
        c.id ASC
      LIMIT 1
    `,
    values
  );

  if (!row) {
    return null;
  }

  const margins = getClientMargins(database, row.id);
  const queueTotal =
    Number(
      (queryOne(
        database,
        `
          SELECT COUNT(*) AS count
          FROM clients c
          LEFT JOIN bases b ON b.id = COALESCE(c.base_id, c.campaign_id)
          WHERE ${filters.join(' AND ')}
        `,
        values
      ) || { count: 0 }).count || 0
    );
  return {
    client: clientDto(
      database,
      row,
      margins,
      queryAll(database, 'SELECT * FROM interactions WHERE client_id = ? ORDER BY datetime(created_at) DESC, id DESC', [row.id]),
      queryAll(database, 'SELECT * FROM scheduled_returns WHERE client_id = ? ORDER BY datetime(return_at) ASC, id ASC', [row.id]),
      queryAll(database, 'SELECT * FROM deals WHERE client_id = ? ORDER BY datetime(created_at) DESC, id DESC', [row.id])
    ),
    queue_total: queueTotal,
    queue_position: Number(row.queue_position || 0),
  };
}

export function getClientById(id) {
  const database = getDb();
  const row = queryOne(
    database,
    `
      ${getClientBaseQuery()}
      WHERE c.id = ?
      LIMIT 1
    `,
    [id]
  );

  if (!row) {
    return null;
  }

  const margins = getClientMargins(database, row.id);
  const interactions = queryAll(
    database,
    `
      SELECT i.*, u.name AS user_name
      FROM interactions i
      LEFT JOIN users u ON u.id = i.user_id
      WHERE i.client_id = ?
      ORDER BY datetime(i.created_at) DESC, i.id DESC
    `,
    [id]
  );
  const returns = queryAll(
    database,
    `
      SELECT r.*, u.name AS user_name
      FROM scheduled_returns r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.client_id = ?
      ORDER BY datetime(r.return_at) ASC, r.id ASC
    `,
    [id]
  );
  const deals = queryAll(
    database,
    `
      SELECT d.*, u.name AS user_name
      FROM deals d
      LEFT JOIN users u ON u.id = d.user_id
      WHERE d.client_id = ?
      ORDER BY datetime(d.created_at) DESC, d.id DESC
    `,
    [id]
  );

  return {
    client: clientDto(database, row, margins, interactions, returns, deals),
    interactions,
    scheduled_returns: returns,
    deals,
  };
}

function insertInteraction(database, { clientId, userId, type, note = '', privateNote = '' }) {
  database
    .prepare(
      'INSERT INTO interactions (client_id, user_id, type, note, private_note, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(clientId, userId, type, note, privateNote, nowIso());
}

function updateClientStatus(database, id, statusAtendimento, assignedTo = null) {
  database
    .prepare('UPDATE clients SET status_atendimento = ?, status = ?, assigned_to = COALESCE(?, assigned_to), updated_at = ? WHERE id = ?')
    .run(statusAtendimento, statusAtendimento, assignedTo, nowIso(), id);
}

export function startAttendance(id, userId) {
  const database = getDb();
  if (!queryOne(database, 'SELECT id FROM clients WHERE id = ?', [id])) {
    return null;
  }

  updateClientStatus(database, id, 'em_atendimento', userId);
  insertInteraction(database, { clientId: id, userId, type: 'atendimento_iniciado' });
  persistDb();
  return getClientById(id);
}

export function addInteraction(id, { userId, type = 'observacao', note = '', private_note = '' }) {
  const database = getDb();
  if (!queryOne(database, 'SELECT id FROM clients WHERE id = ?', [id])) {
    return null;
  }

  insertInteraction(database, { clientId: id, userId, type, note, privateNote: private_note });
  database.prepare('UPDATE clients SET updated_at = ? WHERE id = ?').run(nowIso(), id);
  persistDb();
  return getClientById(id);
}

export function scheduleReturn(id, { userId, return_at, note = '', private_note = '' }) {
  const database = getDb();
  if (!queryOne(database, 'SELECT id FROM clients WHERE id = ?', [id])) {
    return null;
  }

  database
    .prepare(
      'INSERT INTO scheduled_returns (client_id, user_id, return_at, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(id, userId, return_at, note, 'pending', nowIso());
  updateClientStatus(database, id, 'aguardando_retorno', userId);
  insertInteraction(database, { clientId: id, userId, type: 'retorno_agendado', note, privateNote: private_note });
  persistDb();
  return getClientById(id);
}

export function finalizeClient(id, { userId, note = '', private_note = '' }) {
  const database = getDb();
  if (!queryOne(database, 'SELECT id FROM clients WHERE id = ?', [id])) {
    return null;
  }

  updateClientStatus(database, id, 'finalizado', userId);
  insertInteraction(database, { clientId: id, userId, type: 'finalizado', note, privateNote: private_note });
  persistDb();
  return getClientById(id);
}

export function markNoInterest(id, { userId, note = '', private_note = '' }) {
  const database = getDb();
  if (!queryOne(database, 'SELECT id FROM clients WHERE id = ?', [id])) {
    return null;
  }

  updateClientStatus(database, id, 'sem_interesse', userId);
  insertInteraction(database, { clientId: id, userId, type: 'sem_interesse', note, privateNote: private_note });
  persistDb();
  return getClientById(id);
}

export function convertClient(id, { userId, bank = '', amount = 0, installment = 0, term = 0, note = '', private_note = '' }) {
  const database = getDb();
  if (!queryOne(database, 'SELECT id FROM clients WHERE id = ?', [id])) {
    return null;
  }

  database
    .prepare(
      'INSERT INTO deals (client_id, user_id, bank, amount, installment, term, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, userId, bank, amount, installment, term, note, nowIso());

  updateClientStatus(database, id, 'convertido', userId);
  insertInteraction(database, { clientId: id, userId, type: 'convertido', note, privateNote: private_note });
  persistDb();
  return getClientById(id);
}

export function logWhatsappOpen(id, { userId, note = 'WhatsApp Web aberto para o cliente' }) {
  const database = getDb();
  if (!queryOne(database, 'SELECT id FROM clients WHERE id = ?', [id])) {
    return null;
  }

  insertInteraction(database, { clientId: id, userId, type: 'whatsapp_aberto', note });
  persistDb();
  return getClientById(id);
}

export function getDashboardData(params = {}) {
  const database = getDb();
  const filters = [];
  const values = [];

  if (String(params.include_archived || '') !== '1' && params.include_archived !== true) {
    filters.push('COALESCE(b.is_active, 1) = 1');
  }

  if (params.base_id) {
    filters.push('COALESCE(c.base_id, c.campaign_id) = ?');
    values.push(Number(params.base_id));
  }

  if (params.base_type) {
    filters.push('b.tipo_base = ?');
    values.push(String(params.base_type));
  }

  if (params.convenio) {
    filters.push('b.convenio = ?');
    values.push(String(params.convenio));
  }

  if (params.estado) {
    filters.push('b.estado = ?');
    values.push(String(params.estado));
  }

  if (params.cidade) {
    filters.push('b.cidade = ?');
    values.push(String(params.cidade));
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const stats = queryOne(
    database,
    `
      SELECT
        COUNT(*) AS total_clients,
        SUM(CASE WHEN status_atendimento IN ('novo_na_fila', 'aguardando_retorno') THEN 1 ELSE 0 END) AS queue_clients,
        SUM(CASE WHEN status_atendimento = 'em_atendimento' THEN 1 ELSE 0 END) AS active_clients,
        SUM(CASE WHEN status_atendimento = 'finalizado' AND date(updated_at) = date('now') THEN 1 ELSE 0 END) AS finished_today,
        SUM(CASE WHEN status_atendimento = 'aguardando_retorno' THEN 1 ELSE 0 END) AS scheduled_returns,
        SUM(CASE WHEN status_atendimento = 'convertido' THEN 1 ELSE 0 END) AS converted,
        SUM(CASE WHEN status_atendimento = 'sem_interesse' THEN 1 ELSE 0 END) AS no_interest
      FROM clients c
      LEFT JOIN bases b ON b.id = COALESCE(c.base_id, c.campaign_id)
      ${whereClause}
    `,
    values
  ) || {};

  const nextClient = getNextClient(params);
  const recentActivity = queryAll(
    database,
    `
      SELECT
        i.*,
        c.name AS client_name,
        c.cpf,
        c.phone,
        c.status_atendimento AS status,
        c.best_net_margin,
        u.name AS user_name
      FROM interactions i
      LEFT JOIN clients c ON c.id = i.client_id
      LEFT JOIN bases b ON b.id = COALESCE(c.base_id, c.campaign_id)
      LEFT JOIN users u ON u.id = i.user_id
      ${whereClause}
      ORDER BY datetime(i.created_at) DESC, i.id DESC
      LIMIT 8
    `,
    values
  );

  const productStats = queryAll(
    database,
    `
      SELECT
        cm.product_type,
        SUM(CASE WHEN COALESCE(net_margin, 0) > 0 THEN 1 ELSE 0 END) AS positive_count,
        SUM(CASE WHEN COALESCE(net_margin, 0) = 0 THEN 1 ELSE 0 END) AS zero_count,
        SUM(CASE WHEN COALESCE(net_margin, 0) < 0 THEN 1 ELSE 0 END) AS negative_count
      FROM clients c
      JOIN client_margins cm ON cm.client_id = c.id
      LEFT JOIN bases b ON b.id = COALESCE(c.base_id, c.campaign_id)
      ${whereClause}
      GROUP BY product_type
    `,
    values
  );

  return {
    stats: Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Number(value || 0)])),
    nextClient,
    recentActivity,
    productStats,
  };
}

export function getReportsData(params = {}) {
  const database = getDb();
  const filters = [];
  const values = [];

  if (String(params.include_archived || '') !== '1' && params.include_archived !== true) {
    filters.push('COALESCE(b.is_active, 1) = 1');
  }

  if (params.base_id) {
    filters.push('COALESCE(c.base_id, c.campaign_id) = ?');
    values.push(Number(params.base_id));
  }

  if (params.base_type) {
    filters.push('b.tipo_base = ?');
    values.push(String(params.base_type));
  }

  if (params.convenio) {
    filters.push('b.convenio = ?');
    values.push(String(params.convenio));
  }

  if (params.estado) {
    filters.push('b.estado = ?');
    values.push(String(params.estado));
  }

  if (params.cidade) {
    filters.push('b.cidade = ?');
    values.push(String(params.cidade));
  }

  if (params.status_atendimento) {
    filters.push('c.status_atendimento = ?');
    values.push(params.status_atendimento);
  }

  if (params.consulta_status) {
    filters.push('c.consulta_status = ?');
    values.push(params.consulta_status);
  }

  if (params.best_product_type) {
    filters.push('c.best_product_type = ?');
    values.push(params.best_product_type);
  }

  if (params.margin_state === 'positive') {
    filters.push('COALESCE(c.best_net_margin, 0) > 0');
  }
  if (params.margin_state === 'zero') {
    filters.push('COALESCE(c.best_net_margin, 0) = 0');
  }
  if (params.margin_state === 'negative') {
    filters.push('COALESCE(c.best_net_margin, 0) < 0');
  }
  if (params.margin_state === 'error') {
    filters.push("c.consulta_status = 'erro'");
  }

  if (params.campaign_id) {
    filters.push('COALESCE(c.base_id, c.campaign_id) = ?');
    values.push(Number(params.campaign_id));
  }
  if (params.user_id) {
    filters.push('c.assigned_to = ?');
    values.push(Number(params.user_id));
  }
  if (params.from) {
    filters.push('datetime(c.updated_at) >= datetime(?)');
    values.push(params.from);
  }
  if (params.to) {
    filters.push('datetime(c.updated_at) <= datetime(?)');
    values.push(params.to);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = queryAll(
    database,
    `
      SELECT
        c.id,
        c.name,
        c.cpf,
        c.phone,
        c.email,
        c.status_atendimento AS status,
        c.consulta_status,
        c.consulta_mensagem,
        c.raw_data_json,
        c.best_product_type,
        c.best_net_margin,
        c.updated_at,
        COALESCE(b.nome_base, cam.name) AS campaign_name,
        b.id AS base_id,
        b.nome_base AS base_name,
        b.tipo_base AS base_type,
        b.convenio AS base_convenio,
        b.estado AS base_state,
        b.cidade AS base_city,
        b.arquivo_original AS base_file_name,
        b.observacao AS base_observation,
        b.is_active AS base_is_active,
        b.archived_at AS base_archived_at,
        b.created_at AS base_created_at,
        b.updated_at AS base_updated_at,
        u.name AS assigned_to_name,
        (
          SELECT i.created_at
          FROM interactions i
          WHERE i.client_id = c.id
          ORDER BY datetime(i.created_at) DESC, i.id DESC
          LIMIT 1
        ) AS last_interaction_at,
        (
          SELECT i.note
          FROM interactions i
          WHERE i.client_id = c.id
          ORDER BY datetime(i.created_at) DESC, i.id DESC
          LIMIT 1
        ) AS last_note,
        (
          SELECT r.return_at
          FROM scheduled_returns r
          WHERE r.client_id = c.id AND r.status = 'pending'
          ORDER BY datetime(r.return_at) ASC, r.id ASC
          LIMIT 1
        ) AS next_return_at
      FROM clients c
      LEFT JOIN bases b ON b.id = COALESCE(c.base_id, c.campaign_id)
      LEFT JOIN campaigns cam ON cam.id = c.campaign_id
      LEFT JOIN users u ON u.id = c.assigned_to
      ${whereClause}
      ORDER BY datetime(c.updated_at) DESC, c.id DESC
      LIMIT 100
    `,
    values
  ).map((row) => {
    const margins = getClientMargins(database, row.id);
    const best = bestMarginFromMargins(margins);
    return {
      ...row,
      consulta_status_label: consultaStatusLabel(row.consulta_status),
      best_product_label: productLabel(row.best_product_type || best.product_type),
      best_net_margin_formatted: formatMoney(row.best_net_margin ?? best.net_margin),
      updated_at_formatted: formatDateTime(row.updated_at),
      last_interaction_at_formatted: formatDateTime(row.last_interaction_at),
      next_return_at_formatted: formatDateTime(row.next_return_at),
      margins,
    };
  });

  const totals = queryOne(
    database,
    `
      SELECT
        COUNT(*) AS total_clients,
        SUM(CASE WHEN c.consulta_status = 'com_marg' THEN 1 ELSE 0 END) AS with_margin,
        SUM(CASE WHEN c.consulta_status = 'sem_marg' THEN 1 ELSE 0 END) AS without_margin,
        SUM(CASE WHEN c.consulta_status = 'erro' THEN 1 ELSE 0 END) AS with_error,
        SUM(CASE WHEN c.status_atendimento = 'convertido' THEN 1 ELSE 0 END) AS converted,
        SUM(CASE WHEN c.status_atendimento = 'finalizado' THEN 1 ELSE 0 END) AS finalized
      FROM clients c
      LEFT JOIN bases b ON b.id = COALESCE(c.base_id, c.campaign_id)
      ${whereClause}
    `,
    values
  ) || {};

  const productStats = queryAll(
    database,
    `
      SELECT
        cm.product_type,
        SUM(CASE WHEN COALESCE(cm.net_margin, 0) > 0 THEN 1 ELSE 0 END) AS positive_count,
        SUM(CASE WHEN COALESCE(cm.net_margin, 0) = 0 THEN 1 ELSE 0 END) AS zero_count,
        SUM(CASE WHEN COALESCE(cm.net_margin, 0) < 0 THEN 1 ELSE 0 END) AS negative_count
      FROM clients c
      JOIN client_margins cm ON cm.client_id = c.id
      LEFT JOIN bases b ON b.id = COALESCE(c.base_id, c.campaign_id)
      ${whereClause}
      GROUP BY cm.product_type
    `,
    values
  );

  return {
    totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Number(value || 0)])),
    rows,
    productStats,
  };
}

export function getSettings() {
  const database = getDb();
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of queryAll(database, 'SELECT key, value FROM settings')) {
    settings[row.key] = row.value;
  }
  return settings;
}

export function saveSettings(partialSettings = {}) {
  const database = getDb();
  const merged = { ...getSettings(), ...partialSettings };
  const upsert = database.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );

  database.transaction((values) => {
    for (const [key, value] of Object.entries(values)) {
      upsert.run(key, String(value));
    }
  })(merged);

  persistDb();
  return getSettings();
}

export function getUsers() {
  const database = getDb();
  return queryAll(
    database,
    `
      SELECT
        id,
        name,
        login,
        email,
        role,
        is_active,
        last_login_at,
        created_at,
        updated_at
      FROM users
      ORDER BY name COLLATE NOCASE ASC, id ASC
    `
  ).map((row) => ({
    id: Number(row.id),
    name: row.name || '',
    login: row.login || row.email || '',
    email: row.email || row.login || '',
    role: normalizeUserRole(row.role),
    is_active: Number(row.is_active ?? 1) === 1,
    last_login_at: row.last_login_at || null,
    created_at: row.created_at || '',
    updated_at: row.updated_at || row.created_at || '',
  }));
}

export function getUserById(id) {
  const database = getDb();
  const row = queryOne(database, 'SELECT * FROM users WHERE id = ? LIMIT 1', [id]);
  if (!row) {
    return null;
  }
  return {
    ...row,
    role: normalizeUserRole(row.role),
    is_active: Number(row.is_active ?? 1) === 1,
  };
}

export function getUserByLogin(login) {
  const database = getDb();
  const row = queryOne(
    database,
    `
      SELECT *
      FROM users
      WHERE LOWER(login) = LOWER(?) OR LOWER(email) = LOWER(?)
      LIMIT 1
    `,
    [String(login || '').trim(), String(login || '').trim()]
  );
  if (!row) {
    return null;
  }
  return {
    ...row,
    role: normalizeUserRole(row.role),
    is_active: Number(row.is_active ?? 1) === 1,
  };
}

export function createUserRecord({ name, login, passwordHash, role, isActive = true }) {
  const database = getDb();
  const now = nowIso();
  database
    .prepare(
      `
        INSERT INTO users (name, login, email, password_hash, role, is_active, last_login_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(name, login, login, passwordHash, normalizeUserRole(role), isActive ? 1 : 0, null, now, now);
  return getUserById(lastInsertId(database));
}

export function updateUserRecord(id, { name, login, role, isActive }) {
  const database = getDb();
  const current = getUserById(id);
  if (!current) {
    return null;
  }

  const nextName = String(name ?? current.name ?? '').trim();
  const nextLogin = normalizeUserLogin(login ?? current.login ?? current.email ?? '', id);
  const nextRole = normalizeUserRole(role ?? current.role);
  const nextActive = typeof isActive === 'boolean' ? (isActive ? 1 : 0) : Number(current.is_active ?? 1);

  database
    .prepare(
      `
        UPDATE users
        SET name = ?, login = ?, email = ?, role = ?, is_active = ?, updated_at = ?
        WHERE id = ?
      `
    )
    .run(nextName, nextLogin, nextLogin, nextRole, nextActive, nowIso(), id);

  return getUserById(id);
}

export function updateUserPasswordRecord(id, passwordHash) {
  const database = getDb();
  const current = getUserById(id);
  if (!current) {
    return null;
  }

  database
    .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
    .run(passwordHash, nowIso(), id);
  return getUserById(id);
}

export function recordUserLogin(id) {
  const database = getDb();
  const current = getUserById(id);
  if (!current) {
    return null;
  }

  database
    .prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
    .run(nowIso(), nowIso(), id);
  return getUserById(id);
}

export function createRibeiraoBatchRecord({
  userId,
  baseId = null,
  sourceType = 'upload',
  sourceFileName = '',
  totalCpfs = 0,
}) {
  const database = getDb();
  const now = nowIso();
  const result = database
    .prepare(
      `
        INSERT INTO ribeirao_query_batches (
          user_id,
          base_id,
          source_type,
          source_file_name,
          total_cpfs,
          processed_count,
          success_count,
          no_margin_count,
          error_count,
          captcha_count,
          status,
          started_at,
          finished_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 'pendente', NULL, NULL, ?, ?)
      `
    )
    .run(
      Number(userId || 0),
      baseId === null || baseId === undefined || baseId === '' || String(baseId).toLowerCase() === 'all' || String(baseId).toLowerCase() === 'all_active'
        ? null
        : Number(baseId),
      String(sourceType || 'upload').toLowerCase(),
      String(sourceFileName || ''),
      Number(totalCpfs || 0),
      now,
      now
    );
  const batchId = Number(
    result?.lastInsertRowid ||
      result?.last_insert_rowid ||
      queryOne(database, 'SELECT id AS id FROM ribeirao_query_batches ORDER BY id DESC LIMIT 1')?.id ||
      0
  );
  return getRibeiraoBatchById(batchId);
}

export function getRibeiraoBatchById(id) {
  const database = getDb();
  const row = queryOne(
    database,
    `
      SELECT
        b.*,
        u.name AS user_name,
        u.login AS user_login,
        base.nome_base AS base_name,
        base.tipo_base AS base_type,
        base.convenio AS base_convenio,
        base.estado AS base_state,
        base.cidade AS base_city,
        base.arquivo_original AS base_file_name,
        base.is_active AS base_is_active,
        base.archived_at AS base_archived_at
      FROM ribeirao_query_batches b
      LEFT JOIN users u ON u.id = b.user_id
      LEFT JOIN bases base ON base.id = b.base_id
      WHERE b.id = ?
      LIMIT 1
    `,
    [id]
  );
  if (!row) {
    return null;
  }

  return {
    ...row,
    id: Number(row.id),
    user_id: Number(row.user_id),
    base_id: row.base_id === null || row.base_id === undefined ? null : Number(row.base_id),
    total_cpfs: Number(row.total_cpfs || 0),
    processed_count: Number(row.processed_count || 0),
    success_count: Number(row.success_count || 0),
    no_margin_count: Number(row.no_margin_count || 0),
    error_count: Number(row.error_count || 0),
    captcha_count: Number(row.captcha_count || 0),
    progress_percent: row.total_cpfs ? Math.round((Number(row.processed_count || 0) / Number(row.total_cpfs || 1)) * 100) : 0,
  };
}

export function updateRibeiraoBatchRecord(id, updates = {}) {
  const database = getDb();
  const allowed = {
    source_type: 'source_type',
    source_file_name: 'source_file_name',
    total_cpfs: 'total_cpfs',
    processed_count: 'processed_count',
    success_count: 'success_count',
    no_margin_count: 'no_margin_count',
    error_count: 'error_count',
    captcha_count: 'captcha_count',
    status: 'status',
    started_at: 'started_at',
    finished_at: 'finished_at',
    base_id: 'base_id',
    user_id: 'user_id',
  };

  const entries = Object.entries(updates).filter(([key]) => Object.hasOwn(allowed, key));
  if (!entries.length) {
    return getRibeiraoBatchById(id);
  }

  const sets = entries.map(([key]) => `${allowed[key]} = ?`);
  const numericKeys = new Set(['total_cpfs', 'processed_count', 'success_count', 'no_margin_count', 'error_count', 'captcha_count', 'user_id']);
  const nullableNumericKeys = new Set(['base_id']);
  const values = entries.map(([key, value]) => {
    if (value === undefined) {
      return null;
    }
    if (numericKeys.has(key)) {
      return Number(value || 0);
    }
    if (nullableNumericKeys.has(key)) {
      if (value === null || value === undefined || value === '' || String(value).toLowerCase() === 'all' || String(value).toLowerCase() === 'all_active') {
        return null;
      }
      return Number(value);
    }
    return value;
  });

  const nextUpdatedAt = nowIso();
  database
    .prepare(`UPDATE ribeirao_query_batches SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...values, nextUpdatedAt, id);
  return getRibeiraoBatchById(id);
}

export function listRibeiraoBatches(params = {}) {
  const database = getDb();
  const clauses = [];
  const values = [];

  if (params.status) {
    clauses.push('b.status = ?');
    values.push(String(params.status));
  }
  if (params.user_id) {
    clauses.push('b.user_id = ?');
    values.push(Number(params.user_id));
  }
  if (params.base_id) {
    clauses.push('b.base_id = ?');
    values.push(Number(params.base_id));
  }
  if (params.source_type) {
    clauses.push('b.source_type = ?');
    values.push(String(params.source_type));
  }
  if (params.from) {
    clauses.push('datetime(b.created_at) >= datetime(?)');
    values.push(String(params.from));
  }
  if (params.to) {
    clauses.push('datetime(b.created_at) <= datetime(?)');
    values.push(String(params.to));
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return queryAll(
    database,
    `
      SELECT
        b.*,
        u.name AS user_name,
        u.login AS user_login,
        base.nome_base AS base_name,
        base.tipo_base AS base_type,
        base.convenio AS base_convenio,
        base.estado AS base_state,
        base.cidade AS base_city,
        base.arquivo_original AS base_file_name,
        base.is_active AS base_is_active,
        base.archived_at AS base_archived_at
      FROM ribeirao_query_batches b
      LEFT JOIN users u ON u.id = b.user_id
      LEFT JOIN bases base ON base.id = b.base_id
      ${where}
      ORDER BY datetime(b.created_at) DESC, b.id DESC
      LIMIT 200
    `,
    values
  ).map((row) => ({
    ...row,
    id: Number(row.id),
    user_id: Number(row.user_id),
    base_id: row.base_id === null || row.base_id === undefined ? null : Number(row.base_id),
    total_cpfs: Number(row.total_cpfs || 0),
    processed_count: Number(row.processed_count || 0),
    success_count: Number(row.success_count || 0),
    no_margin_count: Number(row.no_margin_count || 0),
    error_count: Number(row.error_count || 0),
    captcha_count: Number(row.captcha_count || 0),
    progress_percent: row.total_cpfs ? Math.round((Number(row.processed_count || 0) / Number(row.total_cpfs || 1)) * 100) : 0,
  }));
}

export function listRibeiraoBatchResults(batchId) {
  const database = getDb();
  return queryAll(
    database,
    `
      SELECT
        q.*,
        u.name AS user_name,
        c.name AS client_name,
        c.base_id AS client_base_id,
        b.nome_base AS base_name,
        b.tipo_base AS base_type,
        b.convenio AS base_convenio,
        b.estado AS base_state,
        b.cidade AS base_city,
        b.arquivo_original AS base_file_name
      FROM ribeirao_margin_queries q
      LEFT JOIN users u ON u.id = q.user_id
      LEFT JOIN clients c ON c.id = q.client_id
      LEFT JOIN bases b ON b.id = q.base_id
      WHERE q.batch_id = ?
      ORDER BY q.id ASC
    `,
    [batchId]
  );
}

export function getBases(params = {}) {
  const database = getDb();
  return queryAll(
    database,
    `
      SELECT
        id,
        nome_base,
        tipo_base,
        convenio,
        estado,
        cidade,
        arquivo_original,
        total_clientes,
        total_com_margem,
        total_sem_margem,
        total_erro,
        observacao,
        is_active,
        archived_at,
        created_at,
        updated_at
      FROM bases
      ${String(params.include_archived || '') !== '1' && params.include_archived !== true ? 'WHERE COALESCE(is_active, 1) = 1' : ''}
      ORDER BY COALESCE(datetime(updated_at), datetime(created_at)) DESC, id DESC
    `
  );
}

export function getCampaigns(params = {}) {
  return getBases(params).map((base) => ({
    id: base.id,
    name: base.nome_base,
    file_name: base.arquivo_original,
    total_clients: base.total_clientes,
    created_at: base.created_at,
  }));
}

export function renameBase(id, name) {
  const database = getDb();
  const now = nowIso();
  const baseName = normalizeBaseText(name);
  if (!baseName) {
    return null;
  }

  const exists = queryOne(database, 'SELECT id FROM bases WHERE id = ?', [id]);
  if (!exists) {
    return null;
  }

  database
    .prepare('UPDATE bases SET nome_base = ?, updated_at = ? WHERE id = ?')
    .run(baseName, now, id);
  database
    .prepare('UPDATE campaigns SET name = ? WHERE id = ?')
    .run(baseName, id);
  persistDb();
  return queryOne(database, 'SELECT * FROM bases WHERE id = ?', [id]);
}

export function archiveBase(id, archived = true) {
  const database = getDb();
  const now = nowIso();
  const exists = queryOne(database, 'SELECT id FROM bases WHERE id = ?', [id]);
  if (!exists) {
    return null;
  }

  database
    .prepare(
      `UPDATE bases SET is_active = ?, archived_at = ?, updated_at = ? WHERE id = ?`
    )
    .run(archived ? 0 : 1, archived ? now : null, now, id);
  persistDb();
  return queryOne(database, 'SELECT * FROM bases WHERE id = ?', [id]);
}
