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
  company_name: 'Reliance CRM',
  attendant_name: 'Carlos Andrade',
  whatsapp_message:
    'Oie, {nome}, tudo bem? E a Aline. Vi aqui que apareceu uma oportunidade no seu consignado. Posso te enviar uma simulacao sem compromisso?',
  allow_column_editing: 'true',
  daily_limit: '50',
  theme: 'dark',
  expected_columns:
    'cpf, nome, margem bruta consignacao, margem liquida consignacao, margem bruta credito, margem liquida credito, margem bruta cartao, margem liquida cartao, status, mensagem',
  ribeirao_consignado_coefficient: '',
  ribeirao_consignado_rate: '',
  ribeirao_cartao_coefficient: '',
  ribeirao_cartao_rate: '',
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
  observacao: 'Base de demonstraÃ§Ã£o criada automaticamente.',
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

const DEFAULT_CAMPAIGN_NAME = 'Campanha Geral';

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

function lastInsertId(database) {
  const row = queryOne(database, 'SELECT last_insert_rowid() AS id');
  return Number(row?.id || row?.lastInsertRowid || row?.lastInsertRowID || row?.lastInsertId || 0);
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

function addDaysIso(dateIso, days) {
  const date = dateIso ? new Date(dateIso) : new Date();
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString();
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
    'Policia Militar': 'Policia Militar',
    Camara: 'Camara',
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
    .replace(/\bmarco\b/gi, 'MarÃ§o')
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
  const baseId = row.base_id ?? null;
  const campaignId = row.campaign_id ?? null;
  const base = {
    id: baseId,
    nome_base: row.base_name || row.campaign_name || '',
    tipo_base: row.base_type || 'Outro',
    convenio: row.base_convenio || row.campaign_convenio || row.campaign_name || '',
    estado: row.base_state || '',
    cidade: row.base_city || '',
    arquivo_original: row.base_file_name || row.campaign_file_name || '',
    observacao: row.base_observation || '',
    is_active: Number(row.base_is_active ?? 1) === 1,
    archived_at: row.base_archived_at || null,
    created_at: row.base_created_at || row.created_at || '',
    updated_at: row.base_updated_at || row.updated_at || '',
    campaign_id: campaignId,
    campaign_name: row.campaign_name || '',
  };
  const duplicateBases = getClientDuplicateBases(database, row.cpf, baseId);

  return {
    id: row.id,
    campaign_id: campaignId,
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
    nova_vida_last_lookup_at: row.nova_vida_last_lookup_at || '',
    nova_vida_last_lookup_at_formatted: formatDateTime(row.nova_vida_last_lookup_at),
    nova_vida_lookup_status: row.nova_vida_lookup_status || 'never_searched',
    created_at_formatted: formatDateTime(row.created_at),
    updated_at_formatted: formatDateTime(row.updated_at),
    best_product_type: best.product_type || '',
    best_product_label: productLabel(best.product_type),
    best_net_margin: best.net_margin === null || best.net_margin === undefined ? null : Number(best.net_margin),
    best_net_margin_formatted: formatMoney(best.net_margin),
    margins: [
      {
        product_type: 'consignacao',
        product_label: 'ConsignaÃ§Ã£o',
        ...marginMap.consignacao,
      },
      {
        product_type: 'credito',
        product_label: 'CrÃ©dito',
        ...marginMap.credito,
      },
      {
        product_type: 'cartao',
        product_label: 'CartÃ£o',
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
    phones: getClientPhonesInternal(database, row.id),
    nova_vida_data: getClientLatestEnrichmentInternal(database, row.id),
    phone_lookup_job: getLatestPhoneLookupJobInternal(database, row.id),
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

function phoneDto(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    client_id: Number(row.client_id),
    phone_number: row.phone_number || '',
    normalized_phone: row.normalized_phone || '',
    type: row.type || '',
    source: row.source || 'Nova Vida',
    quality: row.quality || '',
    is_whatsapp: row.is_whatsapp === null || row.is_whatsapp === undefined ? null : Number(row.is_whatsapp) === 1,
    is_primary: Number(row.is_primary || 0) === 1,
    status: row.status || 'active',
    raw_label: row.raw_label || '',
    raw_data: row.raw_data ? safeJsonParse(row.raw_data, {}) : {},
    searched_at: row.searched_at || '',
    searched_at_formatted: formatDateTime(row.searched_at),
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
  };
}

function enrichmentDto(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    client_id: row.client_id === null || row.client_id === undefined ? null : Number(row.client_id),
    source: row.source || 'Nova Vida',
    cpf: row.cpf || '',
    full_name: row.full_name || '',
    birth_date: row.birth_date || '',
    age: row.age === null || row.age === undefined || row.age === '' ? null : Number(row.age),
    gender: row.gender || '',
    mother_name: row.mother_name || '',
    father_name: row.father_name || '',
    email: row.email || '',
    emails: safeJsonParse(row.emails_json, []),
    address_full: row.address_full || '',
    street: row.street || '',
    number: row.number || '',
    complement: row.complement || '',
    district: row.district || '',
    city: row.city || '',
    state: row.state || '',
    zipcode: row.zipcode || '',
    addresses: safeJsonParse(row.addresses_json, []),
    raw_data: safeJsonParse(row.raw_data, {}),
    searched_at: row.searched_at || '',
    searched_at_formatted: formatDateTime(row.searched_at),
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
  };
}

function phoneLookupJobDto(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    client_id: Number(row.client_id),
    cpf: row.cpf || '',
    name: row.name || '',
    status: row.status || 'pending',
    source: row.source || 'Nova Vida',
    attempts: Number(row.attempts || 0),
    error_message: row.error_message || '',
    started_at: row.started_at || '',
    finished_at: row.finished_at || '',
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
    client_name: row.client_name || row.name || '',
    client_phone: row.client_phone || '',
  };
}

function phoneLookupLogDto(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    client_id: row.client_id === null || row.client_id === undefined ? null : Number(row.client_id),
    cpf: row.cpf || row.client_cpf || '',
    cpf_masked: row.cpf_masked || '',
    name: row.name || '',
    source: row.source || 'Nova Vida',
    status: row.status || '',
    phones_found_count: Number(row.phones_found_count || 0),
    has_address: Number(row.has_address || 0) === 1,
    has_birth_date: Number(row.has_birth_date || 0) === 1,
    error_message: row.error_message || '',
    created_at: row.created_at || '',
    created_at_formatted: formatDateTime(row.created_at),
    client_name: row.client_name || '',
  };
}

function consultationDto(row, phones = [], addresses = [], emails = []) {
  if (!row) return null;
  return {
    id: Number(row.id),
    client_id: row.client_id === null || row.client_id === undefined ? null : Number(row.client_id),
    cpf: row.cpf || '',
    nome: row.nome || '',
    name: row.nome || '',
    telefone_pesquisado: row.telefone_pesquisado || '',
    status: row.status || '',
    source: row.source || '',
    origin: row.source || '',
    error_message: row.error_message || '',
    message: row.error_message || '',
    consulted_at: row.consulted_at || '',
    consulted_at_formatted: formatDateTime(row.consulted_at),
    expires_at: row.expires_at || '',
    expires_at_formatted: formatDateTime(row.expires_at),
    created_by: row.created_by === null || row.created_by === undefined ? null : Number(row.created_by),
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
    client_name: row.client_name || '',
    client_cpf: row.client_cpf || '',
    full_name: row.full_name || row.nome || '',
    birth_date: row.birth_date || '',
    age: row.age === null || row.age === undefined || row.age === '' ? null : Number(row.age),
    gender: row.gender || '',
    mother_name: row.mother_name || '',
    father_name: row.father_name || '',
    raw_data: safeJsonParse(row.raw_data, {}),
    phones_count: Number(row.phones_count || phones.length || 0),
    addresses_count: Number(row.addresses_count || addresses.length || 0),
    emails_count: Number(row.emails_count || emails.length || 0),
    phones,
    addresses,
    emails,
  };
}

function getClientPhonesInternal(database, clientId) {
  return queryAll(
    database,
    `
      SELECT *
      FROM client_phones
      WHERE client_id = ?
      ORDER BY is_primary DESC, datetime(COALESCE(searched_at, created_at)) DESC, id DESC
    `,
    [clientId]
  ).map(phoneDto);
}

function getClientLatestEnrichmentInternal(database, clientId) {
  return enrichmentDto(
    queryOne(
      database,
      `
        SELECT *
        FROM client_enrichment_data
        WHERE client_id = ?
        ORDER BY datetime(searched_at) DESC, id DESC
        LIMIT 1
      `,
      [clientId]
    )
  );
}

function getLatestPhoneLookupJobInternal(database, clientId) {
  return phoneLookupJobDto(
    queryOne(
      database,
      `
        SELECT *
        FROM phone_lookup_jobs
        WHERE client_id = ?
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT 1
      `,
      [clientId]
    )
  );
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
      convenio TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      product_focus TEXT NOT NULL DEFAULT 'outros',
      status TEXT NOT NULL DEFAULT 'active',
      internal_notes TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      file_name TEXT NOT NULL DEFAULT '',
      total_clients INTEGER NOT NULL DEFAULT 0,
      total_bases INTEGER NOT NULL DEFAULT 0,
      total_pendente INTEGER NOT NULL DEFAULT 0,
      total_em_atendimento INTEGER NOT NULL DEFAULT 0,
      total_agendados INTEGER NOT NULL DEFAULT 0,
      total_finalizados INTEGER NOT NULL DEFAULT 0,
      total_convertidos INTEGER NOT NULL DEFAULT 0,
      total_sem_interesse INTEGER NOT NULL DEFAULT 0,
      last_base_imported_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS campaign_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'vendedor',
      created_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome_base TEXT NOT NULL,
      tipo_base TEXT NOT NULL DEFAULT 'Outro',
      campaign_id INTEGER,
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
      updated_at TEXT NOT NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
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
      campaign_id INTEGER,
      type TEXT NOT NULL,
      note TEXT,
      private_note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS scheduled_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      campaign_id INTEGER,
      return_at TEXT NOT NULL,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      campaign_id INTEGER,
      bank TEXT,
      amount REAL,
      installment REAL,
      term INTEGER,
      note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS client_phones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      phone_number TEXT NOT NULL DEFAULT '',
      normalized_phone TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'Nova Vida',
      quality TEXT NOT NULL DEFAULT '',
      is_whatsapp INTEGER,
      is_primary INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      raw_label TEXT NOT NULL DEFAULT '',
      raw_data TEXT NOT NULL DEFAULT '{}',
      searched_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS phone_lookup_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      cpf TEXT NOT NULL DEFAULT '',
      cpf_masked TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'Nova Vida',
      status TEXT NOT NULL DEFAULT '',
      phones_found_count INTEGER NOT NULL DEFAULT 0,
      has_address INTEGER NOT NULL DEFAULT 0,
      has_birth_date INTEGER NOT NULL DEFAULT 0,
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS client_enrichment_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      source TEXT NOT NULL DEFAULT 'Nova Vida',
      cpf TEXT NOT NULL DEFAULT '',
      full_name TEXT NOT NULL DEFAULT '',
      birth_date TEXT,
      age INTEGER,
      gender TEXT NOT NULL DEFAULT '',
      mother_name TEXT NOT NULL DEFAULT '',
      father_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      address_full TEXT NOT NULL DEFAULT '',
      street TEXT NOT NULL DEFAULT '',
      number TEXT NOT NULL DEFAULT '',
      complement TEXT NOT NULL DEFAULT '',
      district TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      zipcode TEXT NOT NULL DEFAULT '',
      emails_json TEXT NOT NULL DEFAULT '[]',
      addresses_json TEXT NOT NULL DEFAULT '[]',
      raw_data TEXT NOT NULL DEFAULT '{}',
      searched_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS client_consultations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      cpf TEXT NOT NULL DEFAULT '',
      nome TEXT NOT NULL DEFAULT '',
      telefone_pesquisado TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'failed',
      source TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      full_name TEXT NOT NULL DEFAULT '',
      birth_date TEXT,
      age INTEGER,
      gender TEXT NOT NULL DEFAULT '',
      mother_name TEXT NOT NULL DEFAULT '',
      father_name TEXT NOT NULL DEFAULT '',
      raw_data TEXT NOT NULL DEFAULT '{}',
      consulted_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS client_consultation_phones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consultation_id INTEGER NOT NULL,
      phone_number TEXT NOT NULL DEFAULT '',
      phone_type TEXT NOT NULL DEFAULT '',
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (consultation_id) REFERENCES client_consultations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS client_consultation_addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consultation_id INTEGER NOT NULL,
      full_address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      zip_code TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (consultation_id) REFERENCES client_consultations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS client_consultation_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      consultation_id INTEGER NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (consultation_id) REFERENCES client_consultations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS phone_lookup_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      cpf TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      source TEXT NOT NULL DEFAULT 'Nova Vida',
      attempts INTEGER NOT NULL DEFAULT 0,
      error_message TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
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
      cargo TEXT,
      vinculo TEXT,
      consulta_status TEXT NOT NULL DEFAULT 'erro',
      mensagem TEXT,
      best_product_type TEXT NOT NULL DEFAULT '',
      best_net_margin REAL,
      margem_emprestimo_total REAL,
      margem_emprestimo_disponivel REAL,
      margem_cartao_total REAL,
      margem_cartao_disponivel REAL,
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
      not_found_count INTEGER NOT NULL DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS averbador_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portal_id TEXT NOT NULL,
      portal_name TEXT NOT NULL DEFAULT '',
      portal_url TEXT NOT NULL DEFAULT '',
      login TEXT NOT NULL DEFAULT '',
      encrypted_password TEXT NOT NULL DEFAULT '',
      requires_captcha INTEGER NOT NULL DEFAULT 0,
      requires_assisted_login INTEGER NOT NULL DEFAULT 0,
      session_status TEXT NOT NULL DEFAULT 'nao_conectado',
      last_access_at TEXT,
      session_expires_at TEXT,
      last_test_at TEXT,
      last_error TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      updated_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_averbador_credentials_portal_id ON averbador_credentials(portal_id);

    CREATE TABLE IF NOT EXISTS averbador_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_id INTEGER NOT NULL,
      portal_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'nao_conectado',
      storage_state_path TEXT NOT NULL DEFAULT '',
      cookies_path TEXT NOT NULL DEFAULT '',
      last_login_at TEXT,
      expires_at TEXT,
      requires_manual_action INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (credential_id) REFERENCES averbador_credentials(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS credential_connection_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credential_id INTEGER,
      portal_id TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by INTEGER,
      FOREIGN KEY (credential_id) REFERENCES averbador_credentials(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT 'unofficial',
      api_url TEXT NOT NULL DEFAULT '',
      encrypted_token TEXT NOT NULL DEFAULT '',
      default_country_code TEXT NOT NULL DEFAULT '55',
      default_number TEXT NOT NULL DEFAULT '',
      instance_id TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      send_delay_seconds INTEGER NOT NULL DEFAULT 5,
      daily_limit_per_number INTEGER NOT NULL DEFAULT 30,
      status TEXT NOT NULL DEFAULT 'not_configured',
      qrcode TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      last_test_at TEXT,
      connected_at TEXT,
      updated_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'abordagem',
      body TEXT NOT NULL DEFAULT '',
      variables TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      phone TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL DEFAULT 'outbound',
      provider TEXT NOT NULL DEFAULT '',
      template_id INTEGER,
      message_body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      provider_message_id TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      sent_by INTEGER,
      sent_at TEXT,
      delivered_at TEXT,
      read_at TEXT,
      received_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      FOREIGN KEY (template_id) REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
      FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_send_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      phone TEXT NOT NULL DEFAULT '',
      template_id INTEGER,
      message_body TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      scheduled_at TEXT,
      sent_at TEXT,
      error_message TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
      FOREIGN KEY (template_id) REFERENCES whatsapp_templates(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      initial_template_id INTEGER,
      initial_message TEXT NOT NULL DEFAULT '',
      fallback_message TEXT NOT NULL DEFAULT '',
      fallback_human_after INTEGER NOT NULL DEFAULT 2,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (initial_template_id) REFERENCES whatsapp_templates(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_flow_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id INTEGER NOT NULL,
      step_order INTEGER NOT NULL DEFAULT 1,
      trigger_keywords TEXT NOT NULL DEFAULT '[]',
      response_message TEXT NOT NULL DEFAULT '',
      action_type TEXT NOT NULL DEFAULT 'none',
      client_status_to_apply TEXT NOT NULL DEFAULT '',
      should_assign_human INTEGER NOT NULL DEFAULT 0,
      should_stop_flow INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (flow_id) REFERENCES whatsapp_flows(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS whatsapp_flow_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      current_step_id INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      unmatched_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      last_message_at TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (flow_id) REFERENCES whatsapp_flows(id) ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
      FOREIGN KEY (current_step_id) REFERENCES whatsapp_flow_steps(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS whatsapp_flow_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_execution_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      inbound_message TEXT NOT NULL DEFAULT '',
      matched_trigger TEXT NOT NULL DEFAULT '',
      outbound_message TEXT NOT NULL DEFAULT '',
      action_taken TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (flow_execution_id) REFERENCES whatsapp_flow_executions(id) ON DELETE CASCADE,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    );
  `);

  ensureColumns(database, 'clients', [
    'base_id INTEGER',
    'campaign_id INTEGER',
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
    'whatsapp_allowed INTEGER NOT NULL DEFAULT 1',
    'whatsapp_opt_out INTEGER NOT NULL DEFAULT 0',
    'whatsapp_blocked INTEGER NOT NULL DEFAULT 0',
    'whatsapp_last_contact_at TEXT',
    'whatsapp_last_response_at TEXT',
    'whatsapp_status TEXT NOT NULL DEFAULT \'ready\'',
  ]);

  ensureColumns(database, 'campaigns', [
    'convenio TEXT NOT NULL DEFAULT \'\'',
    'description TEXT NOT NULL DEFAULT \'\'',
    'product_focus TEXT NOT NULL DEFAULT \'outros\'',
    'status TEXT NOT NULL DEFAULT \'active\'',
    'internal_notes TEXT NOT NULL DEFAULT \'\'',
    'created_by INTEGER',
    'file_name TEXT NOT NULL DEFAULT \'\'',
    'total_bases INTEGER NOT NULL DEFAULT 0',
    'total_pendente INTEGER NOT NULL DEFAULT 0',
    'total_em_atendimento INTEGER NOT NULL DEFAULT 0',
    'total_agendados INTEGER NOT NULL DEFAULT 0',
    'total_finalizados INTEGER NOT NULL DEFAULT 0',
    'total_convertidos INTEGER NOT NULL DEFAULT 0',
    'total_sem_interesse INTEGER NOT NULL DEFAULT 0',
    'last_base_imported_at TEXT',
    'updated_at TEXT NOT NULL DEFAULT \'\'',
  ]);

  ensureColumns(database, 'bases', [
    'campaign_id INTEGER',
  ]);

  ensureColumns(database, 'interactions', [
    'campaign_id INTEGER',
  ]);

  ensureColumns(database, 'scheduled_returns', [
    'campaign_id INTEGER',
  ]);

  ensureColumns(database, 'deals', [
    'campaign_id INTEGER',
  ]);

  ensureColumns(database, 'client_phones', [
    'phone_number TEXT NOT NULL DEFAULT \'\'',
    'normalized_phone TEXT NOT NULL DEFAULT \'\'',
    'type TEXT NOT NULL DEFAULT \'\'',
    'source TEXT NOT NULL DEFAULT \'Nova Vida\'',
    'quality TEXT NOT NULL DEFAULT \'\'',
    'is_whatsapp INTEGER',
    'is_primary INTEGER NOT NULL DEFAULT 0',
    'status TEXT NOT NULL DEFAULT \'active\'',
    'raw_label TEXT NOT NULL DEFAULT \'\'',
    'raw_data TEXT NOT NULL DEFAULT \'{}\'',
    'searched_at TEXT',
    'created_at TEXT NOT NULL',
    'updated_at TEXT NOT NULL',
  ]);

  ensureColumns(database, 'phone_lookup_jobs', [
    'cpf TEXT NOT NULL DEFAULT \'\'',
    'name TEXT NOT NULL DEFAULT \'\'',
    'status TEXT NOT NULL DEFAULT \'pending\'',
    'source TEXT NOT NULL DEFAULT \'Nova Vida\'',
    'attempts INTEGER NOT NULL DEFAULT 0',
    'error_message TEXT NOT NULL DEFAULT \'\'',
    'started_at TEXT',
    'finished_at TEXT',
    'created_at TEXT NOT NULL',
    'updated_at TEXT NOT NULL',
  ]);

  ensureColumns(database, 'phone_lookup_logs', [
    'client_id INTEGER',
    'cpf TEXT NOT NULL DEFAULT \'\'',
    'cpf_masked TEXT NOT NULL DEFAULT \'\'',
    'name TEXT NOT NULL DEFAULT \'\'',
    'source TEXT NOT NULL DEFAULT \'Nova Vida\'',
    'status TEXT NOT NULL DEFAULT \'\'',
    'phones_found_count INTEGER NOT NULL DEFAULT 0',
    'has_address INTEGER NOT NULL DEFAULT 0',
    'has_birth_date INTEGER NOT NULL DEFAULT 0',
    'error_message TEXT NOT NULL DEFAULT \'\'',
    'created_at TEXT NOT NULL',
  ]);

  ensureColumns(database, 'client_enrichment_data', [
    'client_id INTEGER',
    'source TEXT NOT NULL DEFAULT \'Nova Vida\'',
    'cpf TEXT NOT NULL DEFAULT \'\'',
    'full_name TEXT NOT NULL DEFAULT \'\'',
    'birth_date TEXT',
    'age INTEGER',
    'gender TEXT NOT NULL DEFAULT \'\'',
    'mother_name TEXT NOT NULL DEFAULT \'\'',
    'father_name TEXT NOT NULL DEFAULT \'\'',
    'email TEXT NOT NULL DEFAULT \'\'',
    'address_full TEXT NOT NULL DEFAULT \'\'',
    'street TEXT NOT NULL DEFAULT \'\'',
    'number TEXT NOT NULL DEFAULT \'\'',
    'complement TEXT NOT NULL DEFAULT \'\'',
    'district TEXT NOT NULL DEFAULT \'\'',
    'city TEXT NOT NULL DEFAULT \'\'',
    'state TEXT NOT NULL DEFAULT \'\'',
    'zipcode TEXT NOT NULL DEFAULT \'\'',
    'emails_json TEXT NOT NULL DEFAULT \'[]\'',
    'addresses_json TEXT NOT NULL DEFAULT \'[]\'',
    'raw_data TEXT NOT NULL DEFAULT \'{}\'',
    'searched_at TEXT NOT NULL',
    'created_at TEXT NOT NULL',
    'updated_at TEXT NOT NULL',
  ]);

  ensureColumns(database, 'client_consultations', [
    'client_id INTEGER',
    'cpf TEXT NOT NULL DEFAULT \'\'',
    'nome TEXT NOT NULL DEFAULT \'\'',
    'telefone_pesquisado TEXT NOT NULL DEFAULT \'\'',
    'status TEXT NOT NULL DEFAULT \'failed\'',
    'source TEXT NOT NULL DEFAULT \'\'',
    'error_message TEXT NOT NULL DEFAULT \'\'',
    'full_name TEXT NOT NULL DEFAULT \'\'',
    'birth_date TEXT',
    'age INTEGER',
    'gender TEXT NOT NULL DEFAULT \'\'',
    'mother_name TEXT NOT NULL DEFAULT \'\'',
    'father_name TEXT NOT NULL DEFAULT \'\'',
    'raw_data TEXT NOT NULL DEFAULT \'{}\'',
    'consulted_at TEXT NOT NULL',
    'expires_at TEXT NOT NULL',
    'created_by INTEGER',
    'created_at TEXT NOT NULL',
    'updated_at TEXT NOT NULL',
  ]);

  ensureColumns(database, 'client_consultation_phones', [
    'consultation_id INTEGER NOT NULL',
    'phone_number TEXT NOT NULL DEFAULT \'\'',
    'phone_type TEXT NOT NULL DEFAULT \'\'',
    'label TEXT NOT NULL DEFAULT \'\'',
    'created_at TEXT NOT NULL',
  ]);

  ensureColumns(database, 'client_consultation_addresses', [
    'consultation_id INTEGER NOT NULL',
    'full_address TEXT NOT NULL DEFAULT \'\'',
    'city TEXT NOT NULL DEFAULT \'\'',
    'state TEXT NOT NULL DEFAULT \'\'',
    'zip_code TEXT NOT NULL DEFAULT \'\'',
    'created_at TEXT NOT NULL',
  ]);

  ensureColumns(database, 'client_consultation_emails', [
    'consultation_id INTEGER NOT NULL',
    'email TEXT NOT NULL DEFAULT \'\'',
    'is_primary INTEGER NOT NULL DEFAULT 0',
    'created_at TEXT NOT NULL',
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

  ensureColumns(database, 'clients', [
    'nova_vida_last_lookup_at TEXT',
    'nova_vida_lookup_status TEXT NOT NULL DEFAULT \'never_searched\'',
    'whatsapp_allowed INTEGER NOT NULL DEFAULT 1',
    'whatsapp_opt_out INTEGER NOT NULL DEFAULT 0',
    'whatsapp_blocked INTEGER NOT NULL DEFAULT 0',
    'whatsapp_last_contact_at TEXT',
    'whatsapp_last_response_at TEXT',
    'whatsapp_status TEXT NOT NULL DEFAULT \'ready\'',
  ]);

  ensureColumns(database, 'ribeirao_margin_queries', [
    'batch_id INTEGER',
    'margem_emprestimo_total REAL',
    'margem_emprestimo_disponivel REAL',
    'margem_cartao_total REAL',
    'margem_cartao_disponivel REAL',
    'cargo TEXT',
    'vinculo TEXT',
  ]);

  ensureColumns(database, 'ribeirao_query_batches', [
    'not_found_count INTEGER NOT NULL DEFAULT 0',
  ]);

  ensureColumns(database, 'averbador_credentials', [
    'portal_id TEXT NOT NULL DEFAULT \'\'',
    'portal_name TEXT NOT NULL DEFAULT \'\'',
    'portal_url TEXT NOT NULL DEFAULT \'\'',
    'login TEXT NOT NULL DEFAULT \'\'',
    'encrypted_password TEXT NOT NULL DEFAULT \'\'',
    'requires_captcha INTEGER NOT NULL DEFAULT 0',
    'requires_assisted_login INTEGER NOT NULL DEFAULT 0',
    'session_status TEXT NOT NULL DEFAULT \'nao_conectado\'',
    'last_access_at TEXT',
    'session_expires_at TEXT',
    'last_test_at TEXT',
    'last_error TEXT NOT NULL DEFAULT \'\'',
    'created_by INTEGER',
    'updated_by INTEGER',
    'created_at TEXT NOT NULL DEFAULT \'\'',
    'updated_at TEXT NOT NULL DEFAULT \'\'',
  ]);

  ensureColumns(database, 'averbador_sessions', [
    'credential_id INTEGER NOT NULL DEFAULT 0',
    'portal_id TEXT NOT NULL DEFAULT \'\'',
    'status TEXT NOT NULL DEFAULT \'nao_conectado\'',
    'storage_state_path TEXT NOT NULL DEFAULT \'\'',
    'cookies_path TEXT NOT NULL DEFAULT \'\'',
    'last_login_at TEXT',
    'expires_at TEXT',
    'requires_manual_action INTEGER NOT NULL DEFAULT 0',
    'last_error TEXT NOT NULL DEFAULT \'\'',
    'created_at TEXT NOT NULL DEFAULT \'\'',
    'updated_at TEXT NOT NULL DEFAULT \'\'',
  ]);

  ensureColumns(database, 'credential_connection_logs', [
    'credential_id INTEGER',
    'portal_id TEXT NOT NULL DEFAULT \'\'',
    'action TEXT NOT NULL DEFAULT \'\'',
    'status TEXT NOT NULL DEFAULT \'\'',
    'message TEXT NOT NULL DEFAULT \'\'',
    'error_message TEXT NOT NULL DEFAULT \'\'',
    'created_at TEXT NOT NULL DEFAULT \'\'',
    'created_by INTEGER',
  ]);

  ensureColumns(database, 'whatsapp_configs', [
    'provider TEXT NOT NULL DEFAULT \'unofficial\'',
    'api_url TEXT NOT NULL DEFAULT \'\'',
    'encrypted_token TEXT NOT NULL DEFAULT \'\'',
    'default_country_code TEXT NOT NULL DEFAULT \'55\'',
    'default_number TEXT NOT NULL DEFAULT \'\'',
    'instance_id TEXT NOT NULL DEFAULT \'\'',
    'enabled INTEGER NOT NULL DEFAULT 1',
    'send_delay_seconds INTEGER NOT NULL DEFAULT 5',
    'daily_limit_per_number INTEGER NOT NULL DEFAULT 30',
    'status TEXT NOT NULL DEFAULT \'not_configured\'',
    'qrcode TEXT NOT NULL DEFAULT \'\'',
    'last_error TEXT NOT NULL DEFAULT \'\'',
    'last_test_at TEXT',
    'connected_at TEXT',
    'updated_by INTEGER',
    'created_at TEXT NOT NULL DEFAULT \'\'',
    'updated_at TEXT NOT NULL DEFAULT \'\'',
  ]);

  ensureColumns(database, 'whatsapp_templates', [
    'name TEXT NOT NULL DEFAULT \'\'',
    'category TEXT NOT NULL DEFAULT \'abordagem\'',
    'body TEXT NOT NULL DEFAULT \'\'',
    'variables TEXT NOT NULL DEFAULT \'[]\'',
    'active INTEGER NOT NULL DEFAULT 1',
    'created_at TEXT NOT NULL DEFAULT \'\'',
    'updated_at TEXT NOT NULL DEFAULT \'\'',
  ]);

  ensureColumns(database, 'whatsapp_messages', [
    'client_id INTEGER',
    'phone TEXT NOT NULL DEFAULT \'\'',
    'direction TEXT NOT NULL DEFAULT \'outbound\'',
    'provider TEXT NOT NULL DEFAULT \'\'',
    'template_id INTEGER',
    'message_body TEXT NOT NULL DEFAULT \'\'',
    'status TEXT NOT NULL DEFAULT \'pending\'',
    'provider_message_id TEXT NOT NULL DEFAULT \'\'',
    'error_message TEXT NOT NULL DEFAULT \'\'',
    'sent_by INTEGER',
    'sent_at TEXT',
    'delivered_at TEXT',
    'read_at TEXT',
    'received_at TEXT',
    'created_at TEXT NOT NULL DEFAULT \'\'',
  ]);

  ensureColumns(database, 'whatsapp_send_jobs', [
    'client_id INTEGER',
    'phone TEXT NOT NULL DEFAULT \'\'',
    'template_id INTEGER',
    'message_body TEXT NOT NULL DEFAULT \'\'',
    'status TEXT NOT NULL DEFAULT \'pending\'',
    'scheduled_at TEXT',
    'sent_at TEXT',
    'error_message TEXT NOT NULL DEFAULT \'\'',
    'created_by INTEGER',
    'created_at TEXT NOT NULL DEFAULT \'\'',
  ]);

  ensureColumns(database, 'whatsapp_flows', [
    'name TEXT NOT NULL DEFAULT \'\'',
    'description TEXT NOT NULL DEFAULT \'\'',
    'initial_template_id INTEGER',
    'initial_message TEXT NOT NULL DEFAULT \'\'',
    'fallback_message TEXT NOT NULL DEFAULT \'\'',
    'fallback_human_after INTEGER NOT NULL DEFAULT 2',
    'active INTEGER NOT NULL DEFAULT 1',
    'created_at TEXT NOT NULL DEFAULT \'\'',
    'updated_at TEXT NOT NULL DEFAULT \'\'',
  ]);

  ensureColumns(database, 'whatsapp_flow_steps', [
    'flow_id INTEGER NOT NULL DEFAULT 0',
    'step_order INTEGER NOT NULL DEFAULT 1',
    'trigger_keywords TEXT NOT NULL DEFAULT \'[]\'',
    'response_message TEXT NOT NULL DEFAULT \'\'',
    'action_type TEXT NOT NULL DEFAULT \'none\'',
    'client_status_to_apply TEXT NOT NULL DEFAULT \'\'',
    'should_assign_human INTEGER NOT NULL DEFAULT 0',
    'should_stop_flow INTEGER NOT NULL DEFAULT 0',
    'created_at TEXT NOT NULL DEFAULT \'\'',
    'updated_at TEXT NOT NULL DEFAULT \'\'',
  ]);

  ensureColumns(database, 'whatsapp_flow_executions', [
    'flow_id INTEGER NOT NULL DEFAULT 0',
    'client_id INTEGER NOT NULL DEFAULT 0',
    'phone TEXT NOT NULL DEFAULT \'\'',
    'current_step_id INTEGER',
    'status TEXT NOT NULL DEFAULT \'active\'',
    'unmatched_count INTEGER NOT NULL DEFAULT 0',
    'started_at TEXT NOT NULL DEFAULT \'\'',
    'finished_at TEXT',
    'last_message_at TEXT',
    'created_by INTEGER',
    'created_at TEXT NOT NULL DEFAULT \'\'',
    'updated_at TEXT NOT NULL DEFAULT \'\'',
  ]);

  ensureColumns(database, 'whatsapp_flow_logs', [
    'flow_execution_id INTEGER NOT NULL DEFAULT 0',
    'client_id INTEGER NOT NULL DEFAULT 0',
    'phone TEXT NOT NULL DEFAULT \'\'',
    'inbound_message TEXT NOT NULL DEFAULT \'\'',
    'matched_trigger TEXT NOT NULL DEFAULT \'\'',
    'outbound_message TEXT NOT NULL DEFAULT \'\'',
    'action_taken TEXT NOT NULL DEFAULT \'\'',
    'created_at TEXT NOT NULL DEFAULT \'\'',
  ]);

  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_base_cpf ON clients(base_id, cpf)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_client_phones_client ON client_phones(client_id)');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_client_phones_unique ON client_phones(client_id, normalized_phone, source)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_phone_lookup_jobs_status ON phone_lookup_jobs(status, created_at)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_phone_lookup_logs_created ON phone_lookup_logs(created_at)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_client_enrichment_client ON client_enrichment_data(client_id, searched_at)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_client_consultations_cpf_expires ON client_consultations(cpf, expires_at, status)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_client_consultations_consulted ON client_consultations(consulted_at)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_client_consultation_phones_consultation ON client_consultation_phones(consultation_id)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_client_consultation_addresses_consultation ON client_consultation_addresses(consultation_id)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_client_consultation_emails_consultation ON client_consultation_emails(consultation_id)');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_averbador_credentials_portal_id ON averbador_credentials(portal_id)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_averbador_sessions_credential ON averbador_sessions(credential_id, updated_at)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_credential_connection_logs_created ON credential_connection_logs(created_at)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_client ON whatsapp_messages(client_id, created_at)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone ON whatsapp_messages(phone, created_at)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_whatsapp_send_jobs_status ON whatsapp_send_jobs(status, scheduled_at)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_whatsapp_flows_active ON whatsapp_flows(active, updated_at)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_whatsapp_flow_steps_flow ON whatsapp_flow_steps(flow_id, step_order)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_whatsapp_flow_exec_client ON whatsapp_flow_executions(client_id, status, updated_at)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_whatsapp_flow_exec_status ON whatsapp_flow_executions(status, started_at)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_whatsapp_flow_logs_exec ON whatsapp_flow_logs(flow_execution_id, created_at)');
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

function normalizeCampaignStatus(status) {
  const text = String(status || '').trim().toLowerCase();
  if (text === 'inactive' || text === 'inativo') {
    return 'inactive';
  }
  if (text === 'archived' || text === 'arquivado') {
    return 'archived';
  }
  return 'active';
}

function normalizeCampaignProductFocus(value) {
  const text = String(value || '').trim();
  if (!text) {
    return 'outros';
  }
  return text;
}

function getCampaignByName(database, name) {
  const campaignName = normalizeBaseText(name);
  if (!campaignName) {
    return null;
  }

  return queryOne(database, 'SELECT * FROM campaigns WHERE lower(name) = lower(?) LIMIT 1', [campaignName]);
}

function createCampaignRecord(database, campaignInput = {}, createdBy = null) {
  const now = nowIso();
  const name = normalizeBaseText(campaignInput.name || campaignInput.nome || DEFAULT_CAMPAIGN_NAME) || DEFAULT_CAMPAIGN_NAME;
  const convenio = normalizeBaseText(campaignInput.convenio || campaignInput.orgao || 'NÃ£o definido');
  const description = normalizeBaseText(campaignInput.description || campaignInput.descricao || '');
  const productFocus = normalizeCampaignProductFocus(campaignInput.product_focus || campaignInput.productFocus || 'outros');
  const status = normalizeCampaignStatus(campaignInput.status || 'active');
  const internalNotes = normalizeBaseText(campaignInput.internal_notes || campaignInput.observacao || '');
  const fileName = normalizeBaseText(campaignInput.file_name || campaignInput.arquivo_original || '');

  const existing = getCampaignByName(database, name);
  if (existing) {
    database
      .prepare(
        `
          UPDATE campaigns
          SET
            convenio = COALESCE(NULLIF(?, ''), convenio),
            description = COALESCE(NULLIF(?, ''), description),
            product_focus = COALESCE(NULLIF(?, ''), product_focus),
            status = COALESCE(NULLIF(?, ''), status),
            internal_notes = COALESCE(NULLIF(?, ''), internal_notes),
            created_by = COALESCE(?, created_by),
            file_name = COALESCE(NULLIF(?, ''), file_name),
            updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        convenio,
        description,
        productFocus,
        status,
        internalNotes,
        createdBy,
        fileName,
        now,
        existing.id
      );
    const campaign = queryOne(database, 'SELECT * FROM campaigns WHERE id = ?', [existing.id]);
    refreshCampaignTotals(database, existing.id);
    return campaign;
  }

  database
    .prepare(
      `
        INSERT INTO campaigns (
          name, convenio, description, product_focus, status, internal_notes, created_by,
          file_name, total_clients, total_bases, total_pendente, total_em_atendimento, total_agendados,
          total_finalizados, total_convertidos, total_sem_interesse, last_base_imported_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      name,
      convenio,
      description,
      productFocus,
      status,
      internalNotes,
      createdBy,
      fileName,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      null,
      now,
      now
    );

  const campaign = queryOne(database, 'SELECT * FROM campaigns ORDER BY id DESC LIMIT 1');
  return campaign;
}

function ensureDefaultCampaign(database) {
  const existing = getCampaignByName(database, DEFAULT_CAMPAIGN_NAME);
  const campaign =
    existing ||
    createCampaignRecord(
      database,
      {
        name: DEFAULT_CAMPAIGN_NAME,
        convenio: 'NÃ£o definido',
        description: 'Campanha criada automaticamente para dados legados.',
        product_focus: 'outros',
        status: 'active',
        internal_notes: '',
      },
      null
    );

  if (campaign && String(campaign.status || '').toLowerCase() !== 'active') {
    database.prepare('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?').run('active', nowIso(), campaign.id);
  }

  return Number(campaign?.id || existing?.id || 0);
}

function resolveCampaignIdForInput(database, campaignInput = {}) {
  const campaignIdRaw = campaignInput.campaign_id ?? campaignInput.campaignId ?? campaignInput.campaign ?? null;
  const numericCampaignId = campaignIdRaw === null || campaignIdRaw === undefined || campaignIdRaw === ''
    ? null
    : Number(campaignIdRaw);

  if (numericCampaignId) {
    const existing = queryOne(database, 'SELECT id FROM campaigns WHERE id = ?', [numericCampaignId]);
    if (existing) {
      return numericCampaignId;
    }
  }

  const campaignName = normalizeBaseText(
    campaignInput.campaign_name || campaignInput.campaignName || campaignInput.nome_campanha || campaignInput.nomeCampanha || ''
  );
  if (campaignName) {
    const campaign = createCampaignRecord(
      database,
      {
        name: campaignName,
        convenio: campaignInput.convenio || campaignInput.orgao || campaignInput.convenio_orgao || 'NÃ£o definido',
        description: campaignInput.description || campaignInput.descricao || '',
        product_focus: campaignInput.product_focus || campaignInput.productFocus || 'outros',
        status: campaignInput.status || 'active',
        internal_notes: campaignInput.internal_notes || campaignInput.observacao || '',
        file_name: campaignInput.file_name || campaignInput.arquivo_original || '',
      },
      campaignInput.created_by ?? campaignInput.createdBy ?? null
    );
    return Number(campaign?.id || 0);
  }

  return ensureDefaultCampaign(database);
}

function refreshCampaignTotals(database, campaignId) {
  const resolvedId = Number(campaignId || 0);
  if (!resolvedId) {
    return;
  }

  const totals = queryOne(
    database,
    `
      SELECT
        COUNT(*) AS total_clients,
        SUM(CASE WHEN c.status_atendimento = 'novo_na_fila' THEN 1 ELSE 0 END) AS total_pendente,
        SUM(CASE WHEN c.status_atendimento = 'em_atendimento' THEN 1 ELSE 0 END) AS total_em_atendimento,
        SUM(CASE WHEN c.status_atendimento = 'aguardando_retorno' THEN 1 ELSE 0 END) AS total_agendados,
        SUM(CASE WHEN c.status_atendimento = 'finalizado' THEN 1 ELSE 0 END) AS total_finalizados,
        SUM(CASE WHEN c.status_atendimento = 'convertido' THEN 1 ELSE 0 END) AS total_convertidos,
        SUM(CASE WHEN c.status_atendimento = 'sem_interesse' THEN 1 ELSE 0 END) AS total_sem_interesse,
        COUNT(DISTINCT b.id) AS total_bases,
        MAX(COALESCE(b.updated_at, b.created_at)) AS last_base_imported_at
      FROM clients c
      LEFT JOIN bases b ON b.id = c.base_id
      WHERE COALESCE(c.campaign_id, b.campaign_id) = ?
    `,
    [resolvedId]
  ) || {
    total_clients: 0,
    total_pendente: 0,
    total_em_atendimento: 0,
    total_agendados: 0,
    total_finalizados: 0,
    total_convertidos: 0,
    total_sem_interesse: 0,
    total_bases: 0,
    last_base_imported_at: null,
  };

  database
    .prepare(
      `
        UPDATE campaigns
        SET
          total_clients = ?,
          total_bases = ?,
          total_pendente = ?,
          total_em_atendimento = ?,
          total_agendados = ?,
          total_finalizados = ?,
          total_convertidos = ?,
          total_sem_interesse = ?,
          last_base_imported_at = ?,
          updated_at = ?
        WHERE id = ?
      `
    )
    .run(
      Number(totals.total_clients || 0),
      Number(totals.total_bases || 0),
      Number(totals.total_pendente || 0),
      Number(totals.total_em_atendimento || 0),
      Number(totals.total_agendados || 0),
      Number(totals.total_finalizados || 0),
      Number(totals.total_convertidos || 0),
      Number(totals.total_sem_interesse || 0),
      totals.last_base_imported_at || null,
      nowIso(),
      resolvedId
    );
}

function getCampaignUsers(database, campaignId) {
  return queryAll(
    database,
    `
      SELECT cu.*, u.name AS user_name, u.login AS user_login, u.role AS user_role
      FROM campaign_users cu
      LEFT JOIN users u ON u.id = cu.user_id
      WHERE cu.campaign_id = ?
      ORDER BY datetime(cu.created_at) DESC, cu.id DESC
    `,
    [campaignId]
  );
}

function isCampaignVisibleToUser(database, campaignRow, userId, role) {
  const normalizedRole = String(role || 'vendedor').toLowerCase();
  if (normalizedRole === 'gerencial' || normalizedRole === 'admin' || normalizedRole === 'vendedor') {
    return true;
  }

  if (!campaignRow || normalizeCampaignStatus(campaignRow.status) !== 'active') {
    return false;
  }

  const assignments = getCampaignUsers(database, campaignRow.id);
  if (!assignments.length) {
    return true;
  }

  return assignments.some((assignment) => Number(assignment.user_id) === Number(userId));
}

function campaignDto(database, row) {
  const baseCounts = queryOne(
    database,
    'SELECT COUNT(*) AS count, MAX(updated_at) AS last_updated FROM bases WHERE campaign_id = ?',
    [row.id]
  ) || { count: 0, last_updated: null };
  const totals = queryOne(
    database,
    `
      SELECT
        COUNT(*) AS total_clients,
        SUM(CASE WHEN c.status_atendimento = 'novo_na_fila' THEN 1 ELSE 0 END) AS total_pendente,
        SUM(CASE WHEN c.status_atendimento = 'em_atendimento' THEN 1 ELSE 0 END) AS total_em_atendimento,
        SUM(CASE WHEN c.status_atendimento = 'aguardando_retorno' THEN 1 ELSE 0 END) AS total_agendados,
        SUM(CASE WHEN c.status_atendimento = 'finalizado' THEN 1 ELSE 0 END) AS total_finalizados,
        SUM(CASE WHEN c.status_atendimento = 'convertido' THEN 1 ELSE 0 END) AS total_convertidos,
        SUM(CASE WHEN c.status_atendimento = 'sem_interesse' THEN 1 ELSE 0 END) AS total_sem_interesse
      FROM clients c
      LEFT JOIN bases b ON b.id = c.base_id
      WHERE COALESCE(c.campaign_id, b.campaign_id) = ?
    `,
    [row.id]
  ) || {
    total_clients: 0,
    total_pendente: 0,
    total_em_atendimento: 0,
    total_agendados: 0,
    total_finalizados: 0,
    total_convertidos: 0,
    total_sem_interesse: 0,
  };
  const users = getCampaignUsers(database, row.id);

  return {
    id: Number(row.id),
    name: row.name || DEFAULT_CAMPAIGN_NAME,
    convenio: row.convenio || '',
    description: row.description || '',
    product_focus: row.product_focus || 'outros',
    status: normalizeCampaignStatus(row.status),
    internal_notes: row.internal_notes || '',
    created_by: row.created_by ?? null,
    created_by_name: row.created_by_name || '',
    file_name: row.file_name || '',
    total_clients: Number(totals.total_clients || row.total_clients || 0),
    total_bases: Number(baseCounts.count || row.total_bases || 0),
    total_pendente: Number(totals.total_pendente || row.total_pendente || 0),
    total_em_atendimento: Number(totals.total_em_atendimento || row.total_em_atendimento || 0),
    total_agendados: Number(totals.total_agendados || row.total_agendados || 0),
    total_finalizados: Number(totals.total_finalizados || row.total_finalizados || 0),
    total_convertidos: Number(totals.total_convertidos || row.total_convertidos || 0),
    total_sem_interesse: Number(totals.total_sem_interesse || row.total_sem_interesse || 0),
    last_base_imported_at: row.last_base_imported_at || baseCounts.last_updated || null,
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
    total_users: users.length,
    users: users.map((user) => ({
      id: Number(user.user_id),
      name: user.user_name || '',
      login: user.user_login || '',
      role: user.user_role || 'vendedor',
    })),
  };
}

function backfillCampaignAssignments(database) {
  const defaultCampaignId = ensureDefaultCampaign(database);
  if (!defaultCampaignId) {
    return;
  }

  database
    .prepare(
      `
        UPDATE bases
        SET campaign_id = COALESCE(campaign_id, ?)
        WHERE campaign_id IS NULL
      `
    )
    .run(defaultCampaignId);

  database
    .prepare(
      `
        UPDATE clients
        SET campaign_id = COALESCE(campaign_id, (
          SELECT b.campaign_id
          FROM bases b
          WHERE b.id = clients.base_id
          LIMIT 1
        ), ?)
        WHERE campaign_id IS NULL
      `
    )
    .run(defaultCampaignId);

  database
    .prepare(
      `
        UPDATE interactions
        SET campaign_id = COALESCE(campaign_id, (
          SELECT COALESCE(c.campaign_id, b.campaign_id, ?)
          FROM clients c
          LEFT JOIN bases b ON b.id = c.base_id
          WHERE c.id = interactions.client_id
          LIMIT 1
        ))
        WHERE campaign_id IS NULL
      `
    )
    .run(defaultCampaignId);

  database
    .prepare(
      `
        UPDATE scheduled_returns
        SET campaign_id = COALESCE(campaign_id, (
          SELECT COALESCE(c.campaign_id, b.campaign_id, ?)
          FROM clients c
          LEFT JOIN bases b ON b.id = c.base_id
          WHERE c.id = scheduled_returns.client_id
          LIMIT 1
        ))
        WHERE campaign_id IS NULL
      `
    )
    .run(defaultCampaignId);

  database
    .prepare(
      `
        UPDATE deals
        SET campaign_id = COALESCE(campaign_id, (
          SELECT COALESCE(c.campaign_id, b.campaign_id, ?)
          FROM clients c
          LEFT JOIN bases b ON b.id = c.base_id
          WHERE c.id = deals.client_id
          LIMIT 1
        ))
        WHERE campaign_id IS NULL
      `
    )
    .run(defaultCampaignId);

  const legacyCampaigns = queryAll(
    database,
    `
      SELECT id
      FROM campaigns
      WHERE id <> ?
        AND COALESCE(convenio, '') = ''
        AND COALESCE(description, '') = ''
        AND COALESCE(internal_notes, '') = ''
        AND COALESCE(created_by, 0) = 0
        AND COALESCE(file_name, '') <> ''
    `,
    [defaultCampaignId]
  );

  for (const row of legacyCampaigns) {
    database.prepare('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?').run('archived', nowIso(), row.id);
  }

  refreshCampaignTotals(database, defaultCampaignId);
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
  const baseCount = Number((queryOne(database, 'SELECT COUNT(*) AS count FROM bases') || { count: 0 }).count || 0);
  if (baseCount > 0) {
    return;
  }

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

  const now = nowIso();
  const insertTemplate = database.prepare(
    'INSERT INTO whatsapp_templates (name, category, body, variables, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const requiredTemplates = [
    [
      'Primeiro contato consignado',
      'abordagem',
      'Oie, {{nome}}, tudo bem?\nE a Aline, correspondente bancaria.\n\nEstou entrando em contato porque apareceu uma possibilidade de consulta/simulacao de credito consignado para o seu perfil.\n\nPosso te enviar uma simulacao sem compromisso?',
      '["nome"]',
    ],
    [
      'Cliente interessado',
      'resposta_interesse',
      'Perfeito, {{nome}}. Vou verificar as melhores condicoes disponiveis hoje e ja te envio uma simulacao sem compromisso.',
      '["nome"]',
    ],
    [
      'Sem interesse',
      'opt_out',
      'Tudo bem, {{nome}}. Obrigada pelo retorno. Vou deixar registrado aqui para nao te incomodar novamente.',
      '["nome"]',
    ],
  ];
  for (const [name, category, body, variables] of requiredTemplates) {
    const existing = queryOne(database, 'SELECT id FROM whatsapp_templates WHERE LOWER(name) = LOWER(?) LIMIT 1', [name]);
    if (!existing) {
      insertTemplate.run(name, category, body, variables, 1, now, now);
    }
  }

  const defaultFlowName = 'Primeiro contato consignado';
  const defaultFlow = queryOne(database, 'SELECT id FROM whatsapp_flows WHERE LOWER(name) = LOWER(?) LIMIT 1', [defaultFlowName]);
  if (!defaultFlow) {
    const initialTemplate = queryOne(database, 'SELECT id FROM whatsapp_templates WHERE LOWER(name) = LOWER(?) LIMIT 1', [defaultFlowName]);
    database
      .prepare(
        `
          INSERT INTO whatsapp_flows (
            name, description, initial_template_id, initial_message, fallback_message, fallback_human_after, active, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        defaultFlowName,
        'Fluxo base para primeiro contato de consignado.',
        initialTemplate?.id ?? null,
        '',
        'Desculpa, {{nome}}, nao consegui entender. Voce pode responder com: 1 - Pode mandar, 2 - Nao tenho interesse, 3 - Falar com atendente.',
        2,
        1,
        now,
        now
      );
    const createdFlow = queryOne(database, 'SELECT id FROM whatsapp_flows WHERE LOWER(name) = LOWER(?) LIMIT 1', [defaultFlowName]);
    if (createdFlow?.id) {
      const insertFlowStep = database.prepare(
        `
          INSERT INTO whatsapp_flow_steps (
            flow_id, step_order, trigger_keywords, response_message, action_type, client_status_to_apply, should_assign_human, should_stop_flow, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      );
      insertFlowStep.run(
        createdFlow.id,
        1,
        JSON.stringify(['pode mandar', 'sim', 'quero', 'manda', 'pode', 'tenho interesse']),
        'Perfeito, {{nome}}. Vou verificar as melhores condicoes disponiveis hoje e ja te envio uma simulacao sem compromisso.',
        'interest',
        'em_atendimento',
        1,
        1,
        now,
        now
      );
      insertFlowStep.run(
        createdFlow.id,
        2,
        JSON.stringify(['nao tenho interesse', 'nao quero', 'parar', 'remover', 'bloquear', 'nao me chama', 'agora nao']),
        'Tudo bem, {{nome}}. Obrigada pelo retorno. Vou deixar registrado aqui para nao te incomodar novamente.',
        'opt_out',
        'sem_interesse',
        0,
        1,
        now,
        now
      );
      insertFlowStep.run(
        createdFlow.id,
        3,
        JSON.stringify(['atendente', 'humano', 'falar com alguem', 'me liga', 'ligacao', 'quero falar']),
        'Claro, {{nome}}. Vou chamar uma pessoa da equipe para te atender agora.',
        'human',
        'em_atendimento',
        1,
        1,
        now,
        now
      );
    }
  }

  const clientCount = Number((queryOne(database, 'SELECT COUNT(*) AS count FROM clients') || { count: 0 }).count || 0);
  if (clientCount === 0) {
    const now = nowIso();
    const defaultCampaignId = ensureDefaultCampaign(database);
    database
      .prepare(`
        INSERT INTO bases (
          nome_base, tipo_base, campaign_id, convenio, estado, cidade, arquivo_original,
          total_clientes, total_com_margem, total_sem_margem, total_erro,
          observacao, is_active, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        SAMPLE_BASE.nome_base,
        SAMPLE_BASE.tipo_base,
        defaultCampaignId,
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
    database.prepare('UPDATE bases SET campaign_id = ? WHERE id = ?').run(defaultCampaignId, baseId);
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
        defaultCampaignId,
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
    refreshCampaignTotals(database, defaultCampaignId);
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
      backfillCampaignAssignments(db);
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
      COALESCE(cam.name, b.nome_base) AS campaign_name,
      cam.convenio AS campaign_convenio,
      cam.description AS campaign_description,
      cam.product_focus AS campaign_product_focus,
      cam.status AS campaign_status,
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
    LEFT JOIN campaigns cam ON cam.id = COALESCE(c.campaign_id, b.campaign_id)
    LEFT JOIN users u ON u.id = c.assigned_to
  `;
}

function latestClientAgeExpression() {
  return `CAST(COALESCE(
    (
      SELECT ed.age
      FROM client_enrichment_data ed
      WHERE ed.client_id = c.id
        AND ed.age IS NOT NULL
      ORDER BY datetime(COALESCE(ed.searched_at, ed.created_at)) DESC, ed.id DESC
      LIMIT 1
    ),
    (
      SELECT cc.age
      FROM client_consultations cc
      WHERE cc.client_id = c.id
        AND cc.age IS NOT NULL
      ORDER BY datetime(COALESCE(cc.consulted_at, cc.created_at)) DESC, cc.id DESC
      LIMIT 1
    )
  ) AS INTEGER)`;
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
      'ObservaÃ§Ã£o',
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
  const observation = normalizeBaseText(baseInput.notes || baseInput.observacao || baseInput.observation || baseInput.internal_notes || '');
  const campaignId = resolveCampaignIdForInput(database, baseInput);

  database
    .prepare(`
      INSERT INTO bases (
        nome_base, tipo_base, campaign_id, convenio, estado, cidade, arquivo_original,
        total_clientes, total_com_margem, total_sem_margem, total_erro,
        observacao, is_active, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      baseName,
      baseType,
      campaignId,
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
  database.prepare('UPDATE bases SET campaign_id = COALESCE(campaign_id, ?) WHERE id = ?').run(campaignId, baseId);
  refreshCampaignTotals(database, campaignId);

  return {
    id: baseId,
    campaign_id: campaignId,
    nome_base: baseName,
    tipo_base: baseType,
    convenio,
    estado,
    cidade,
    arquivo_original: fileName,
    total_clients: totalClients,
    total_com_margem: 0,
    total_sem_margem: 0,
    total_erro: 0,
    observacao: observation,
    is_active: 1,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
}

function saveClientRecord(database, baseId, campaignId, row, sourceFileName, queuePosition) {
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
      campaignId,
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
      saveClientRecord(database, baseRecord.id, baseRecord.campaign_id, row, filename, queuePosition++);
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
  refreshCampaignTotals(database, baseRecord.campaign_id);

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

  const ageMin = Number(params.age_min);
  if (Number.isFinite(ageMin) && String(params.age_min).trim() !== '') {
    filters.push(`${latestClientAgeExpression()} >= ?`);
    values.push(ageMin);
  }

  const ageMax = Number(params.age_max);
  if (Number.isFinite(ageMax) && String(params.age_max).trim() !== '') {
    filters.push(`${latestClientAgeExpression()} <= ?`);
    values.push(ageMax);
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
    filters.push('(c.campaign_id = ? OR b.campaign_id = ?)');
    values.push(Number(params.campaign_id), Number(params.campaign_id));
  }

  if (params.base_id) {
    filters.push('c.base_id = ?');
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
    const rawSearch = String(params.search).trim();
    const search = `%${rawSearch}%`;
    const digitSearch = cleanDigits(rawSearch);
    const normalizedPhoneSearch = digitSearch ? `%${digitSearch}%` : search;
    filters.push(`(
      c.name LIKE ?
      OR c.cpf LIKE ?
      OR c.phone LIKE ?
      OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(c.cpf, ''), '.', ''), '-', ''), ' ', ''), '/', ''), '+', '') LIKE ?
      OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(c.phone, ''), '(', ''), ')', ''), '-', ''), ' ', ''), '+', '') LIKE ?
      OR EXISTS (
        SELECT 1
        FROM client_phones cp
        WHERE cp.client_id = c.id
          AND (
            cp.phone_number LIKE ?
            OR cp.normalized_phone LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(cp.phone_number, ''), '(', ''), ')', ''), '-', ''), ' ', ''), '+', '') LIKE ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(cp.normalized_phone, ''), '(', ''), ')', ''), '-', ''), ' ', ''), '+', '') LIKE ?
          )
      )
    )`);
    values.push(search, search, search, normalizedPhoneSearch, normalizedPhoneSearch, search, search, normalizedPhoneSearch, normalizedPhoneSearch);
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
    filters.push('c.base_id = ?');
    values.push(Number(params.base_id));
  }

  if (params.campaign_id) {
    filters.push('(c.campaign_id = ? OR b.campaign_id = ?)');
    values.push(Number(params.campaign_id), Number(params.campaign_id));
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

  const ageMin = Number(params.age_min);
  if (Number.isFinite(ageMin) && String(params.age_min).trim() !== '') {
    filters.push(`${latestClientAgeExpression()} >= ?`);
    values.push(ageMin);
  }

  const ageMax = Number(params.age_max);
  if (Number.isFinite(ageMax) && String(params.age_max).trim() !== '') {
    filters.push(`${latestClientAgeExpression()} <= ?`);
    values.push(ageMax);
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

export function listClientPhones(clientId) {
  return getClientPhonesInternal(getDb(), Number(clientId));
}

export function setPrimaryClientPhone(clientId, phoneId) {
  const database = getDb();
  const phone = queryOne(database, 'SELECT * FROM client_phones WHERE id = ? AND client_id = ?', [Number(phoneId), Number(clientId)]);
  if (!phone) {
    return null;
  }

  database.prepare('UPDATE client_phones SET is_primary = 0, updated_at = ? WHERE client_id = ?').run(nowIso(), Number(clientId));
  database.prepare('UPDATE client_phones SET is_primary = 1, status = ?, updated_at = ? WHERE id = ?').run('active', nowIso(), Number(phoneId));
  database.prepare('UPDATE clients SET phone = ?, updated_at = ? WHERE id = ?').run(phone.normalized_phone || phone.phone_number || '', nowIso(), Number(clientId));
  persistDb();
  return getClientById(Number(clientId));
}

export function updateClientPhoneStatus(clientId, phoneId, status = 'inactive') {
  const database = getDb();
  const phone = queryOne(database, 'SELECT * FROM client_phones WHERE id = ? AND client_id = ?', [Number(phoneId), Number(clientId)]);
  if (!phone) {
    return null;
  }

  database.prepare('UPDATE client_phones SET status = ?, is_primary = CASE WHEN ? <> ? THEN is_primary ELSE 0 END, updated_at = ? WHERE id = ?').run(
    status,
    status,
    'inactive',
    nowIso(),
    Number(phoneId)
  );
  persistDb();
  return getClientById(Number(clientId));
}

export function saveClientLookupPhones({ clientId, userId, phones = [], source = 'Nova Vida', searchedAt = nowIso() }) {
  const database = getDb();
  const client = queryOne(database, 'SELECT id, phone FROM clients WHERE id = ?', [Number(clientId)]);
  if (!client) {
    return null;
  }

  const insertPhone = database.prepare(`
    INSERT INTO client_phones (
      client_id, phone_number, normalized_phone, type, source, quality, is_whatsapp, is_primary, status, raw_label, raw_data, searched_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(client_id, normalized_phone, source) DO UPDATE SET
      phone_number = excluded.phone_number,
      type = excluded.type,
      quality = excluded.quality,
      is_whatsapp = excluded.is_whatsapp,
      status = excluded.status,
      raw_label = excluded.raw_label,
      raw_data = excluded.raw_data,
      searched_at = excluded.searched_at,
      updated_at = excluded.updated_at
  `);

  const existingPrimary = queryOne(database, 'SELECT id FROM client_phones WHERE client_id = ? AND is_primary = 1 AND status = ?', [Number(clientId), 'active']);
  let primaryCandidate = null;
  let saved = 0;
  for (const phone of phones) {
    const normalized = String(phone.normalized || phone.normalized_phone || '').trim();
    if (!normalized) {
      continue;
    }
    if (!primaryCandidate) {
      primaryCandidate = normalized;
    }
    insertPhone.run(
      Number(clientId),
      String(phone.number || phone.phone_number || normalized),
      normalized,
      String(phone.type || ''),
      String(phone.source || source || 'Nova Vida'),
      String(phone.quality || ''),
      phone.is_whatsapp === null || phone.is_whatsapp === undefined ? null : phone.is_whatsapp ? 1 : 0,
      0,
      String(phone.status || 'active'),
      String(phone.raw_label || ''),
      JSON.stringify(phone.raw_data || phone.raw || {}),
      searchedAt,
      nowIso(),
      nowIso()
    );
    saved += 1;
  }

  if (!existingPrimary && primaryCandidate) {
    database.prepare('UPDATE client_phones SET is_primary = 1, updated_at = ? WHERE client_id = ? AND normalized_phone = ?').run(nowIso(), Number(clientId), primaryCandidate);
    database.prepare('UPDATE clients SET phone = ?, updated_at = ? WHERE id = ?').run(primaryCandidate, nowIso(), Number(clientId));
  } else if (!client.phone && primaryCandidate) {
    database.prepare('UPDATE clients SET phone = ?, updated_at = ? WHERE id = ?').run(primaryCandidate, nowIso(), Number(clientId));
  }

  if (saved > 0 && userId) {
    insertInteraction(database, {
      clientId: Number(clientId),
      userId: Number(userId),
      type: 'phone_lookup_success',
      note: `${saved} telefone(s) encontrado(s) na fonte ${source}.`,
    });
  }

  persistDb();
  return { client: getClientById(Number(clientId))?.client || null, phones: listClientPhones(Number(clientId)), saved };
}

export function saveClientEnrichmentData({ clientId = null, userId = null, data = {}, source = 'Nova Vida', searchedAt = nowIso() }) {
  const database = getDb();
  const normalizedClientId = clientId === null || clientId === undefined || clientId === '' ? null : Number(clientId);
  const client = normalizedClientId ? queryOne(database, 'SELECT id, name, cpf, email FROM clients WHERE id = ?', [normalizedClientId]) : null;
  const addresses = Array.isArray(data.addresses) ? data.addresses : [];
  const firstAddress = addresses[0] || {};
  const emails = Array.isArray(data.emails) ? data.emails : data.email ? [data.email] : [];
  const now = nowIso();
  const result = database
    .prepare(
      `
        INSERT INTO client_enrichment_data (
          client_id, source, cpf, full_name, birth_date, age, gender, mother_name, father_name, email,
          address_full, street, number, complement, district, city, state, zipcode,
          emails_json, addresses_json, raw_data, searched_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      normalizedClientId,
      String(source || 'Nova Vida'),
      String(data.cpf || client?.cpf || ''),
      String(data.full_name || data.name || client?.name || ''),
      data.birth_date || null,
      data.age === null || data.age === undefined || data.age === '' ? null : Number(data.age),
      String(data.gender || ''),
      String(data.mother_name || ''),
      String(data.father_name || ''),
      String(data.email || emails[0] || ''),
      String(firstAddress.address_full || ''),
      String(firstAddress.street || ''),
      String(firstAddress.number || ''),
      String(firstAddress.complement || ''),
      String(firstAddress.district || ''),
      String(firstAddress.city || ''),
      String(firstAddress.state || ''),
      String(firstAddress.zipcode || ''),
      JSON.stringify(emails),
      JSON.stringify(addresses),
      JSON.stringify(data.raw_data || data.raw || {}),
      searchedAt,
      now,
      now
    );

  if (client) {
    const updates = ['nova_vida_last_lookup_at = ?', 'nova_vida_lookup_status = ?', 'updated_at = ?'];
    const values = [searchedAt, data.status || 'success', now];
    if (!client.name && (data.full_name || data.name)) {
      updates.push('name = ?');
      values.push(String(data.full_name || data.name));
    }
    if (!client.email && (data.email || emails[0])) {
      updates.push('email = ?');
      values.push(String(data.email || emails[0]));
    }
    values.push(normalizedClientId);
    database.prepare(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`).run(...values);

    if (userId) {
      insertInteraction(database, {
        clientId: normalizedClientId,
        userId: Number(userId),
        type: 'nova_vida_enrichment',
        note: `Dados cadastrais consultados na fonte ${source}.`,
      });
    }
  }

  persistDb();
  return enrichmentDto(queryOne(database, 'SELECT * FROM client_enrichment_data WHERE id = ?', [Number(result.lastInsertRowid || 0)]));
}

function consultationChildren(database, consultationId) {
  const phones = queryAll(
    database,
    'SELECT * FROM client_consultation_phones WHERE consultation_id = ? ORDER BY id ASC',
    [Number(consultationId)]
  ).map((row) => ({
    id: Number(row.id),
    consultation_id: Number(row.consultation_id),
    phone_number: row.phone_number || '',
    number: row.phone_number || '',
    normalized: row.phone_number || '',
    phone_type: row.phone_type || '',
    type: row.phone_type || '',
    label: row.label || '',
    source: 'Consulta salva',
    created_at: row.created_at || '',
  }));
  const addresses = queryAll(
    database,
    'SELECT * FROM client_consultation_addresses WHERE consultation_id = ? ORDER BY id ASC',
    [Number(consultationId)]
  ).map((row) => ({
    id: Number(row.id),
    consultation_id: Number(row.consultation_id),
    full_address: row.full_address || '',
    address_full: row.full_address || '',
    city: row.city || '',
    state: row.state || '',
    zip_code: row.zip_code || '',
    zipcode: row.zip_code || '',
    created_at: row.created_at || '',
  }));
  const emails = queryAll(
    database,
    'SELECT * FROM client_consultation_emails WHERE consultation_id = ? ORDER BY is_primary DESC, id ASC',
    [Number(consultationId)]
  ).map((row) => ({
    id: Number(row.id),
    consultation_id: Number(row.consultation_id),
    email: row.email || '',
    is_primary: Number(row.is_primary || 0) === 1,
    created_at: row.created_at || '',
  }));
  return { phones, addresses, emails };
}

export function getClientConsultationById(id) {
  const database = getDb();
  const row = queryOne(
    database,
    `
      SELECT cc.*, c.name AS client_name, c.cpf AS client_cpf,
        (SELECT COUNT(*) FROM client_consultation_phones p WHERE p.consultation_id = cc.id) AS phones_count,
        (SELECT COUNT(*) FROM client_consultation_addresses a WHERE a.consultation_id = cc.id) AS addresses_count,
        (SELECT COUNT(*) FROM client_consultation_emails e WHERE e.consultation_id = cc.id) AS emails_count
      FROM client_consultations cc
      LEFT JOIN clients c ON c.id = cc.client_id
      WHERE cc.id = ?
      LIMIT 1
    `,
    [Number(id)]
  );
  if (!row) return null;
  const children = consultationChildren(database, row.id);
  return consultationDto(row, children.phones, children.addresses, children.emails);
}

export function getValidClientConsultationByCpf(cpf, { now = nowIso() } = {}) {
  const digits = cleanDigits(cpf);
  if (digits.length !== 11) return null;
  const row = queryOne(
    getDb(),
    `
      SELECT id
      FROM client_consultations
      WHERE cpf = ?
        AND status = 'success'
        AND datetime(expires_at) > datetime(?)
      ORDER BY datetime(consulted_at) DESC, id DESC
      LIMIT 1
    `,
    [digits, now]
  );
  return row ? getClientConsultationById(Number(row.id)) : null;
}

function statusToConsultationStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'success' || normalized === 'saved') return 'success';
  if (normalized === 'requires_manual_login') return 'requires_manual_login';
  if (normalized === 'expired') return 'expired';
  return 'failed';
}

export function saveClientConsultationSnapshot({
  clientId = null,
  createdBy = null,
  cpf = '',
  nome = '',
  telefonePesquisado = '',
  status = 'failed',
  source = 'Fonte externa',
  errorMessage = '',
  result = {},
  consultedAt = nowIso(),
  ttlDays = 60,
} = {}) {
  const database = getDb();
  const normalizedCpf = cleanDigits(cpf || result.cpf || '');
  const normalizedClientId = clientId === null || clientId === undefined || clientId === '' ? null : Number(clientId);
  const client = normalizedClientId ? queryOne(database, 'SELECT id, name, cpf FROM clients WHERE id = ?', [normalizedClientId]) : null;
  const phones = Array.isArray(result.phones) ? result.phones : [];
  const addresses = Array.isArray(result.addresses) ? result.addresses : [];
  const emails = Array.isArray(result.emails) ? result.emails : result.email ? [result.email] : [];
  const now = nowIso();
  const finalStatus = statusToConsultationStatus(status || result.status);
  const expiresAt = addDaysIso(consultedAt, ttlDays);
  const insert = database
    .prepare(
      `
        INSERT INTO client_consultations (
          client_id, cpf, nome, telefone_pesquisado, status, source, error_message,
          full_name, birth_date, age, gender, mother_name, father_name, raw_data,
          consulted_at, expires_at, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      normalizedClientId,
      normalizedCpf,
      String(nome || result.full_name || result.name || client?.name || ''),
      String(telefonePesquisado || ''),
      finalStatus,
      String(source || 'Fonte externa'),
      String(errorMessage || result.message || result.code || ''),
      String(result.full_name || result.name || nome || client?.name || ''),
      result.birth_date || null,
      result.age === null || result.age === undefined || result.age === '' ? null : Number(result.age),
      String(result.gender || ''),
      String(result.mother_name || ''),
      String(result.father_name || ''),
      JSON.stringify(result.raw_data || result.raw || result || {}),
      consultedAt,
      expiresAt,
      createdBy === null || createdBy === undefined ? null : Number(createdBy),
      now,
      now
    );
  const fallbackId = queryOne(database, 'SELECT MAX(id) AS id FROM client_consultations')?.id;
  const consultationId = Number(insert.lastInsertRowid || insert.lastInsertRowID || insert.lastInsertId || fallbackId || 0);
  const phoneInsert = database.prepare(
    'INSERT INTO client_consultation_phones (consultation_id, phone_number, phone_type, label, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  for (const phone of phones) {
    const phoneNumber = String(phone.normalized || phone.normalized_phone || phone.number || phone.phone_number || '').trim();
    if (!phoneNumber) continue;
    phoneInsert.run(
      consultationId,
      phoneNumber,
      String(phone.type || phone.phone_type || ''),
      String(phone.label || phone.quality || phone.raw_label || phone.source || ''),
      now
    );
  }
  const addressInsert = database.prepare(
    'INSERT INTO client_consultation_addresses (consultation_id, full_address, city, state, zip_code, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const address of addresses) {
    const fullAddress = String(address.address_full || address.full_address || '').trim();
    if (!fullAddress) continue;
    addressInsert.run(
      consultationId,
      fullAddress,
      String(address.city || ''),
      String(address.state || ''),
      String(address.zipcode || address.zip_code || ''),
      now
    );
  }
  const emailInsert = database.prepare(
    'INSERT INTO client_consultation_emails (consultation_id, email, is_primary, created_at) VALUES (?, ?, ?, ?)'
  );
  emails.forEach((email, index) => {
    const value = typeof email === 'string' ? email : email?.email;
    if (!value) return;
    emailInsert.run(consultationId, String(value), index === 0 || email?.is_primary ? 1 : 0, now);
  });
  persistDb();
  return getClientConsultationById(consultationId);
}

export function listClientConsultations(params = {}) {
  const database = getDb();
  markExpiredClientConsultations();
  const limit = Math.min(Math.max(Number(params.limit || 50), 1), 300);
  const filters = [];
  const values = [];
  if (params.status) {
    filters.push('cc.status = ?');
    values.push(String(params.status));
  }
  if (params.search) {
    const search = `%${String(params.search).trim()}%`;
    filters.push('(cc.cpf LIKE ? OR cc.nome LIKE ? OR cc.telefone_pesquisado LIKE ? OR c.name LIKE ?)');
    values.push(search, search, search, search);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return queryAll(
    database,
    `
      SELECT cc.*, c.name AS client_name, c.cpf AS client_cpf,
        (SELECT COUNT(*) FROM client_consultation_phones p WHERE p.consultation_id = cc.id) AS phones_count,
        (SELECT COUNT(*) FROM client_consultation_addresses a WHERE a.consultation_id = cc.id) AS addresses_count,
        (SELECT COUNT(*) FROM client_consultation_emails e WHERE e.consultation_id = cc.id) AS emails_count
      FROM client_consultations cc
      LEFT JOIN clients c ON c.id = cc.client_id
      ${where}
      ORDER BY datetime(cc.consulted_at) DESC, cc.id DESC
      LIMIT ${limit}
    `,
    values
  ).map((row) => consultationDto(row));
}

export function linkClientConsultationToClient({ consultationId, clientId, userId = null }) {
  const database = getDb();
  const consultation = getClientConsultationById(Number(consultationId));
  const client = queryOne(database, 'SELECT id, name FROM clients WHERE id = ?', [Number(clientId)]);
  if (!consultation || !client) return null;
  const now = nowIso();
  database.prepare('UPDATE client_consultations SET client_id = ?, updated_at = ? WHERE id = ?').run(Number(clientId), now, Number(consultationId));
  if (userId) {
    insertInteraction(database, {
      clientId: Number(clientId),
      userId: Number(userId),
      type: 'consulta_cadastral_vinculada',
      note: `Consulta salva vinculada ao cliente. CPF consultado: ${consultation.cpf || '-'}.`,
    });
  }
  persistDb();
  return getClientConsultationById(Number(consultationId));
}

export function markExpiredClientConsultations({ now = nowIso() } = {}) {
  const database = getDb();
  const before = queryOne(
    database,
    "SELECT COUNT(*) AS total FROM client_consultations WHERE status != 'expired' AND datetime(expires_at) <= datetime(?)",
    [now]
  );
  const total = Number(before?.total || 0);
  database
    .prepare("UPDATE client_consultations SET status = 'expired', updated_at = ? WHERE status != 'expired' AND datetime(expires_at) <= datetime(?)")
    .run(now, now);
  if (total > 0) {
    persistDb();
  }
  return { expired: total };
}

export function logPhoneLookupRecord({ clientId = null, cpf = '', cpfMasked = '', name = '', source = 'Nova Vida', status = '', phonesFoundCount = 0, hasAddress = false, hasBirthDate = false, errorMessage = '' }) {
  const database = getDb();
  const result = database
    .prepare(
      'INSERT INTO phone_lookup_logs (client_id, cpf, cpf_masked, name, source, status, phones_found_count, has_address, has_birth_date, error_message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      clientId === null || clientId === undefined ? null : Number(clientId),
      String(cpf || ''),
      String(cpfMasked || ''),
      String(name || ''),
      String(source || 'Nova Vida'),
      String(status || ''),
      Number(phonesFoundCount || 0),
      hasAddress ? 1 : 0,
      hasBirthDate ? 1 : 0,
      String(errorMessage || ''),
      nowIso()
    );
  persistDb();
  return phoneLookupLogDto(queryOne(database, 'SELECT * FROM phone_lookup_logs WHERE id = ?', [Number(result.lastInsertRowid || 0)]));
}

export function listPhoneLookupLogs(params = {}) {
  const database = getDb();
  const limit = Math.min(Math.max(Number(params.limit || 50), 1), 300);
  return queryAll(
    database,
    `
      SELECT l.*, c.name AS client_name, c.cpf AS client_cpf
      FROM phone_lookup_logs l
      LEFT JOIN clients c ON c.id = l.client_id
      ORDER BY datetime(l.created_at) DESC, l.id DESC
      LIMIT ${limit}
    `
  ).map(phoneLookupLogDto);
}

export function createPhoneLookupJob({ clientId, userId, source = 'Nova Vida' }) {
  const database = getDb();
  const client = queryOne(database, 'SELECT id, name, cpf FROM clients WHERE id = ?', [Number(clientId)]);
  if (!client) {
    return null;
  }

  const now = nowIso();
  const result = database
    .prepare(
      'INSERT INTO phone_lookup_jobs (client_id, cpf, name, status, source, attempts, error_message, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(Number(clientId), client.cpf || '', client.name || '', 'pending', source, 0, '', now, now);

  if (userId) {
    insertInteraction(database, {
      clientId: Number(clientId),
      userId: Number(userId),
      type: 'phone_lookup_queued',
      note: `Busca de telefone criada na fonte ${source}.`,
    });
  }
  persistDb();
  return getPhoneLookupJobById(Number(result.lastInsertRowid || result.lastInsertRowID || result.lastInsertId || 0));
}

export function getPhoneLookupJobById(id) {
  return phoneLookupJobDto(
    queryOne(
      getDb(),
      `
        SELECT j.*, c.name AS client_name, c.phone AS client_phone
        FROM phone_lookup_jobs j
        LEFT JOIN clients c ON c.id = j.client_id
        WHERE j.id = ?
        LIMIT 1
      `,
      [Number(id)]
    )
  );
}

export function listPhoneLookupJobs(params = {}) {
  const database = getDb();
  const filters = [];
  const values = [];

  if (params.status) {
    filters.push('j.status = ?');
    values.push(String(params.status));
  }
  if (params.client_id) {
    filters.push('j.client_id = ?');
    values.push(Number(params.client_id));
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const limit = Math.min(Math.max(Number(params.limit || 100), 1), 500);
  const jobs = queryAll(
    database,
    `
      SELECT j.*, c.name AS client_name, c.phone AS client_phone
      FROM phone_lookup_jobs j
      LEFT JOIN clients c ON c.id = j.client_id
      ${where}
      ORDER BY datetime(j.created_at) DESC, j.id DESC
      LIMIT ${limit}
    `,
    values
  ).map(phoneLookupJobDto);

  const stats = queryAll(
    database,
    `
      SELECT status, COUNT(*) AS total
      FROM phone_lookup_jobs
      GROUP BY status
    `
  ).reduce((acc, row) => ({ ...acc, [row.status || 'unknown']: Number(row.total || 0) }), {});

  return { jobs, stats };
}

export function updatePhoneLookupJob(id, patch = {}) {
  const database = getDb();
  const current = getPhoneLookupJobById(Number(id));
  if (!current) {
    return null;
  }

  const next = {
    status: patch.status ?? current.status,
    attempts: patch.attempts ?? current.attempts,
    error_message: patch.error_message ?? current.error_message ?? '',
    started_at: patch.started_at ?? current.started_at ?? null,
    finished_at: patch.finished_at ?? current.finished_at ?? null,
    updated_at: nowIso(),
  };
  database
    .prepare('UPDATE phone_lookup_jobs SET status = ?, attempts = ?, error_message = ?, started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?')
    .run(next.status, next.attempts, next.error_message, next.started_at, next.finished_at, next.updated_at, Number(id));
  persistDb();
  return getPhoneLookupJobById(Number(id));
}

export function enqueuePhoneLookupForMarginClients(params = {}) {
  const database = getDb();
  const source = String(params.source || 'Nova Vida');
  const limit = Math.min(Math.max(Number(params.limit || process.env.PHONE_LOOKUP_MAX_PER_RUN || 50), 1), 500);
  const force = params.force === true || String(params.force || '') === '1';
  const filters = [
    'LENGTH(c.cpf) = 11',
    'COALESCE(c.best_net_margin, c.current_margin, 0) > 0',
    "LOWER(COALESCE(c.status_atendimento, c.status, '')) NOT IN ('sem_interesse', 'bloqueado', 'nao_abordar', 'nÃ£o_abordar', 'nao abordar', 'nÃ£o abordar', 'finalizado_sem_interesse')",
  ];

  if (!force) {
    filters.push("NOT EXISTS (SELECT 1 FROM client_phones p WHERE p.client_id = c.id AND p.status = 'active')");
    filters.push("NOT EXISTS (SELECT 1 FROM phone_lookup_jobs j WHERE j.client_id = c.id AND j.status IN ('pending', 'running'))");
  }
  if (params.campaign_id) {
    filters.push('(c.campaign_id = ? OR b.campaign_id = ?)');
  }
  if (params.base_id) {
    filters.push('c.base_id = ?');
  }

  const values = [];
  if (params.campaign_id) {
    values.push(Number(params.campaign_id), Number(params.campaign_id));
  }
  if (params.base_id) {
    values.push(Number(params.base_id));
  }

  const clients = queryAll(
    database,
    `
      SELECT c.id
      FROM clients c
      LEFT JOIN bases b ON b.id = c.base_id
      WHERE ${filters.join(' AND ')}
      ORDER BY COALESCE(c.best_net_margin, c.current_margin, 0) DESC, c.id ASC
      LIMIT ${limit}
    `,
    values
  );

  const jobs = [];
  for (const client of clients) {
    const job = createPhoneLookupJob({ clientId: Number(client.id), userId: params.userId, source });
    if (job) jobs.push(job);
  }

  return { created: jobs.length, jobs };
}

function insertInteraction(database, { clientId, userId, type, note = '', privateNote = '' }) {
  const client = queryOne(
    database,
    `
      SELECT c.id, COALESCE(c.campaign_id, b.campaign_id) AS campaign_id
      FROM clients c
      LEFT JOIN bases b ON b.id = c.base_id
      WHERE c.id = ?
      LIMIT 1
    `,
    [clientId]
  );
  database
    .prepare(
      'INSERT INTO interactions (client_id, user_id, campaign_id, type, note, private_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(clientId, userId, client?.campaign_id ?? null, type, note, privateNote, nowIso());
}

function updateClientStatus(database, id, statusAtendimento, assignedTo = null) {
  const client = queryOne(
    database,
    `
      SELECT c.id, COALESCE(c.campaign_id, b.campaign_id) AS campaign_id
      FROM clients c
      LEFT JOIN bases b ON b.id = c.base_id
      WHERE c.id = ?
      LIMIT 1
    `,
    [id]
  );
  database
    .prepare('UPDATE clients SET status_atendimento = ?, status = ?, assigned_to = COALESCE(?, assigned_to), updated_at = ? WHERE id = ?')
    .run(statusAtendimento, statusAtendimento, assignedTo, nowIso(), id);
  if (client?.campaign_id) {
    refreshCampaignTotals(database, client.campaign_id);
  }
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
  const client = queryOne(
    database,
    `
      SELECT c.id, COALESCE(c.campaign_id, b.campaign_id) AS campaign_id
      FROM clients c
      LEFT JOIN bases b ON b.id = c.base_id
      WHERE c.id = ?
      LIMIT 1
    `,
    [id]
  );
  if (!client) {
    return null;
  }

  database
    .prepare(
      'INSERT INTO scheduled_returns (client_id, user_id, campaign_id, return_at, note, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, userId, client.campaign_id ?? null, return_at, note, 'pending', nowIso());
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
  const client = queryOne(
    database,
    `
      SELECT c.id, COALESCE(c.campaign_id, b.campaign_id) AS campaign_id
      FROM clients c
      LEFT JOIN bases b ON b.id = c.base_id
      WHERE c.id = ?
      LIMIT 1
    `,
    [id]
  );
  if (!client) {
    return null;
  }

  database
    .prepare(
      'INSERT INTO deals (client_id, user_id, campaign_id, bank, amount, installment, term, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(id, userId, client.campaign_id ?? null, bank, amount, installment, term, note, nowIso());

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

function parseWhatsappJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function mapWhatsappConfig(row, { includeSecret = false } = {}) {
  if (!row) {
    return null;
  }
  const config = {
    id: Number(row.id),
    provider: row.provider || 'unofficial',
    api_url: row.api_url || '',
    has_token: Boolean(row.encrypted_token),
    default_country_code: row.default_country_code || '55',
    default_number: row.default_number || '',
    instance_id: row.instance_id || '',
    enabled: Number(row.enabled ?? 1) === 1,
    send_delay_seconds: Number(row.send_delay_seconds || 5),
    daily_limit_per_number: Number(row.daily_limit_per_number || 30),
    status: row.status || 'not_configured',
    qrcode: row.qrcode || '',
    last_error: row.last_error || '',
    last_test_at: row.last_test_at || null,
    connected_at: row.connected_at || null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
  if (includeSecret) {
    config.encrypted_token = row.encrypted_token || '';
  }
  return config;
}

export function getWhatsappConfigRecord({ includeSecret = false } = {}) {
  const database = getDb();
  const row = queryOne(database, 'SELECT * FROM whatsapp_configs ORDER BY id ASC LIMIT 1');
  return mapWhatsappConfig(row, { includeSecret });
}

export function saveWhatsappConfigRecord(input = {}) {
  const database = getDb();
  const now = nowIso();
  const current = queryOne(database, 'SELECT * FROM whatsapp_configs ORDER BY id ASC LIMIT 1');
  const next = {
    provider: input.provider ?? current?.provider ?? 'unofficial',
    api_url: input.api_url ?? current?.api_url ?? '',
    encrypted_token: input.encrypted_token ?? current?.encrypted_token ?? '',
    default_country_code: input.default_country_code ?? current?.default_country_code ?? '55',
    default_number: input.default_number ?? current?.default_number ?? '',
    instance_id: input.instance_id ?? current?.instance_id ?? '',
    enabled: input.enabled === undefined ? Number(current?.enabled ?? 1) : input.enabled ? 1 : 0,
    send_delay_seconds: Number(input.send_delay_seconds ?? current?.send_delay_seconds ?? 5),
    daily_limit_per_number: Number(input.daily_limit_per_number ?? current?.daily_limit_per_number ?? 30),
    status: input.status ?? current?.status ?? 'not_configured',
    qrcode: input.qrcode ?? current?.qrcode ?? '',
    last_error: input.last_error ?? current?.last_error ?? '',
    last_test_at: input.last_test_at ?? current?.last_test_at ?? null,
    connected_at: input.connected_at ?? current?.connected_at ?? null,
    updated_by: input.updated_by ?? current?.updated_by ?? null,
  };

  if (current) {
    database
      .prepare(
        `
          UPDATE whatsapp_configs
          SET provider = ?, api_url = ?, encrypted_token = ?, default_country_code = ?, default_number = ?,
              instance_id = ?, enabled = ?, send_delay_seconds = ?, daily_limit_per_number = ?, status = ?,
              qrcode = ?, last_error = ?, last_test_at = ?, connected_at = ?, updated_by = ?, updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        next.provider,
        next.api_url,
        next.encrypted_token,
        next.default_country_code,
        next.default_number,
        next.instance_id,
        next.enabled,
        next.send_delay_seconds,
        next.daily_limit_per_number,
        next.status,
        next.qrcode,
        next.last_error,
        next.last_test_at,
        next.connected_at,
        next.updated_by,
        now,
        current.id
      );
  } else {
    database
      .prepare(
        `
          INSERT INTO whatsapp_configs (
            provider, api_url, encrypted_token, default_country_code, default_number, instance_id,
            enabled, send_delay_seconds, daily_limit_per_number, status, qrcode, last_error,
            last_test_at, connected_at, updated_by, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        next.provider,
        next.api_url,
        next.encrypted_token,
        next.default_country_code,
        next.default_number,
        next.instance_id,
        next.enabled,
        next.send_delay_seconds,
        next.daily_limit_per_number,
        next.status,
        next.qrcode,
        next.last_error,
        next.last_test_at,
        next.connected_at,
        next.updated_by,
        now,
        now
      );
  }
  persistDb();
  return getWhatsappConfigRecord();
}

function mapWhatsappTemplate(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    active: Number(row.active ?? 1) === 1,
    variables: parseWhatsappJson(row.variables, []),
  };
}

function parseWhatsappFlowKeywords(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item) => String(item || '').trim().toLowerCase())
          .filter(Boolean);
      }
    } catch {
      // fallback split
    }
    return trimmed
      .split(/[,;\n|]/g)
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function mapWhatsappFlow(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    initial_template_id: row.initial_template_id ? Number(row.initial_template_id) : null,
    fallback_human_after: Number(row.fallback_human_after || 2),
    active: Number(row.active ?? 1) === 1,
  };
}

function mapWhatsappFlowStep(row) {
  if (!row) return null;
  return {
    ...row,
    id: Number(row.id),
    flow_id: Number(row.flow_id),
    step_order: Number(row.step_order || 1),
    trigger_keywords: parseWhatsappFlowKeywords(row.trigger_keywords),
    should_assign_human: Number(row.should_assign_human || 0) === 1,
    should_stop_flow: Number(row.should_stop_flow || 0) === 1,
  };
}

export function listWhatsappTemplates(params = {}) {
  const database = getDb();
  const filters = [];
  const values = [];
  if (params.active !== undefined) {
    filters.push('active = ?');
    values.push(params.active ? 1 : 0);
  }
  const rows = queryAll(
    database,
    `
      SELECT *
      FROM whatsapp_templates
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY active DESC, name ASC
    `,
    values
  );
  return rows.map(mapWhatsappTemplate);
}

export function getWhatsappTemplateById(id) {
  const row = queryOne(getDb(), 'SELECT * FROM whatsapp_templates WHERE id = ?', [Number(id)]);
  return mapWhatsappTemplate(row);
}

export function saveWhatsappTemplateRecord(input = {}) {
  const database = getDb();
  const now = nowIso();
  const variables = JSON.stringify(Array.isArray(input.variables) ? input.variables : []);
  if (input.id) {
    database
      .prepare('UPDATE whatsapp_templates SET name = ?, category = ?, body = ?, variables = ?, active = ?, updated_at = ? WHERE id = ?')
      .run(input.name, input.category || 'abordagem', input.body || '', variables, input.active === false ? 0 : 1, now, Number(input.id));
  } else {
    database
      .prepare('INSERT INTO whatsapp_templates (name, category, body, variables, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.name, input.category || 'abordagem', input.body || '', variables, input.active === false ? 0 : 1, now, now);
  }
  persistDb();
  return input.id ? getWhatsappTemplateById(input.id) : mapWhatsappTemplate(queryOne(database, 'SELECT * FROM whatsapp_templates ORDER BY id DESC LIMIT 1'));
}

export function listWhatsappFlows(params = {}) {
  const database = getDb();
  const filters = [];
  const values = [];
  if (params.active !== undefined) {
    filters.push('f.active = ?');
    values.push(params.active ? 1 : 0);
  }
  if (params.search) {
    filters.push('(f.name LIKE ? OR f.description LIKE ?)');
    const term = `%${String(params.search).trim()}%`;
    values.push(term, term);
  }
  const rows = queryAll(
    database,
    `
      SELECT f.*, t.name AS initial_template_name
      FROM whatsapp_flows f
      LEFT JOIN whatsapp_templates t ON t.id = f.initial_template_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY f.active DESC, datetime(f.updated_at) DESC, f.id DESC
    `,
    values
  ).map(mapWhatsappFlow);

  if (params.with_steps === false) {
    return rows.map((flow) => ({ ...flow, steps: [] }));
  }

  return rows.map((flow) => {
    const steps = queryAll(
      database,
      `
        SELECT *
        FROM whatsapp_flow_steps
        WHERE flow_id = ?
        ORDER BY step_order ASC, id ASC
      `,
      [flow.id]
    ).map(mapWhatsappFlowStep);
    return {
      ...flow,
      steps,
    };
  });
}

export function getWhatsappFlowById(id) {
  return listWhatsappFlows({ with_steps: true }).find((flow) => flow.id === Number(id)) || null;
}

export function saveWhatsappFlowRecord(input = {}) {
  const database = getDb();
  const now = nowIso();
  const name = String(input.name || '').trim();
  if (!name) {
    throw new Error('Nome do fluxo obrigatorio.');
  }
  const description = String(input.description || '').trim();
  const initialTemplateId = input.initial_template_id ? Number(input.initial_template_id) : null;
  const initialMessage = String(input.initial_message || '').trim();
  const fallbackMessage = String(input.fallback_message || '').trim();
  const fallbackHumanAfter = Math.max(1, Number(input.fallback_human_after || 2));
  const active = input.active === false ? 0 : 1;
  const steps = Array.isArray(input.steps) ? input.steps : [];

  const tx = database.transaction(() => {
    let flowId = input.id ? Number(input.id) : null;
    if (flowId) {
      database
        .prepare(
          `
            UPDATE whatsapp_flows
            SET name = ?, description = ?, initial_template_id = ?, initial_message = ?, fallback_message = ?,
                fallback_human_after = ?, active = ?, updated_at = ?
            WHERE id = ?
          `
        )
        .run(name, description, initialTemplateId, initialMessage, fallbackMessage, fallbackHumanAfter, active, now, flowId);
    } else {
      database
        .prepare(
          `
            INSERT INTO whatsapp_flows (
              name, description, initial_template_id, initial_message, fallback_message, fallback_human_after, active, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `
        )
        .run(name, description, initialTemplateId, initialMessage, fallbackMessage, fallbackHumanAfter, active, now, now);
      flowId = Number(queryOne(database, 'SELECT id FROM whatsapp_flows ORDER BY id DESC LIMIT 1')?.id || 0);
    }

    database.prepare('DELETE FROM whatsapp_flow_steps WHERE flow_id = ?').run(flowId);
    const insertStep = database.prepare(
      `
        INSERT INTO whatsapp_flow_steps (
          flow_id, step_order, trigger_keywords, response_message, action_type, client_status_to_apply, should_assign_human, should_stop_flow, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );
    steps.forEach((rawStep, index) => {
      const triggerKeywords = parseWhatsappFlowKeywords(rawStep?.trigger_keywords || rawStep?.keywords || []);
      insertStep.run(
        flowId,
        Number(rawStep?.step_order || index + 1),
        JSON.stringify(triggerKeywords),
        String(rawStep?.response_message || '').trim(),
        String(rawStep?.action_type || 'none').trim().toLowerCase(),
        String(rawStep?.client_status_to_apply || '').trim().toLowerCase(),
        rawStep?.should_assign_human ? 1 : 0,
        rawStep?.should_stop_flow ? 1 : 0,
        now,
        now
      );
    });
    return flowId;
  });

  const flowId = tx();
  persistDb();
  return getWhatsappFlowById(flowId);
}

export function createWhatsappFlowExecutionRecord(input = {}) {
  const database = getDb();
  const now = nowIso();
  database
    .prepare(
      `
        INSERT INTO whatsapp_flow_executions (
          flow_id, client_id, phone, current_step_id, status, unmatched_count, started_at, finished_at, last_message_at, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      Number(input.flow_id),
      Number(input.client_id),
      String(input.phone || ''),
      input.current_step_id ? Number(input.current_step_id) : null,
      String(input.status || 'active'),
      Number(input.unmatched_count || 0),
      input.started_at || now,
      input.finished_at || null,
      input.last_message_at || now,
      input.created_by ? Number(input.created_by) : null,
      now,
      now
    );
  persistDb();
  return queryOne(database, 'SELECT * FROM whatsapp_flow_executions ORDER BY id DESC LIMIT 1');
}

export function updateWhatsappFlowExecutionRecord(id, patch = {}) {
  const database = getDb();
  const current = queryOne(database, 'SELECT * FROM whatsapp_flow_executions WHERE id = ?', [Number(id)]);
  if (!current) return null;
  const next = {
    current_step_id: patch.current_step_id !== undefined ? patch.current_step_id : current.current_step_id,
    status: patch.status ?? current.status,
    unmatched_count: patch.unmatched_count !== undefined ? Number(patch.unmatched_count || 0) : Number(current.unmatched_count || 0),
    finished_at: patch.finished_at !== undefined ? patch.finished_at : current.finished_at,
    last_message_at: patch.last_message_at !== undefined ? patch.last_message_at : current.last_message_at,
  };
  database
    .prepare(
      `
        UPDATE whatsapp_flow_executions
        SET current_step_id = ?, status = ?, unmatched_count = ?, finished_at = ?, last_message_at = ?, updated_at = ?
        WHERE id = ?
      `
    )
    .run(
      next.current_step_id ? Number(next.current_step_id) : null,
      String(next.status || current.status || 'active'),
      Number(next.unmatched_count || 0),
      next.finished_at || null,
      next.last_message_at || null,
      nowIso(),
      Number(id)
    );
  persistDb();
  return queryOne(database, 'SELECT * FROM whatsapp_flow_executions WHERE id = ?', [Number(id)]);
}

export function listWhatsappFlowExecutions(params = {}) {
  const database = getDb();
  const filters = [];
  const values = [];
  if (params.client_id) {
    filters.push('e.client_id = ?');
    values.push(Number(params.client_id));
  }
  if (params.flow_id) {
    filters.push('e.flow_id = ?');
    values.push(Number(params.flow_id));
  }
  if (params.status) {
    filters.push('e.status = ?');
    values.push(String(params.status));
  }
  const limit = Math.min(Math.max(Number(params.limit || 100), 1), 500);
  return queryAll(
    database,
    `
      SELECT e.*, f.name AS flow_name, c.name AS client_name, c.cpf AS client_cpf
      FROM whatsapp_flow_executions e
      LEFT JOIN whatsapp_flows f ON f.id = e.flow_id
      LEFT JOIN clients c ON c.id = e.client_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY datetime(e.updated_at) DESC, e.id DESC
      LIMIT ${limit}
    `,
    values
  );
}

export function getActiveWhatsappFlowExecutionForClient(clientId) {
  if (!clientId) return null;
  const database = getDb();
  return queryOne(
    database,
    `
      SELECT *
      FROM whatsapp_flow_executions
      WHERE client_id = ?
        AND status IN ('active', 'waiting_response')
      ORDER BY datetime(updated_at) DESC, id DESC
      LIMIT 1
    `,
    [Number(clientId)]
  );
}

export function createWhatsappFlowLogRecord(input = {}) {
  const database = getDb();
  const now = nowIso();
  database
    .prepare(
      `
        INSERT INTO whatsapp_flow_logs (
          flow_execution_id, client_id, phone, inbound_message, matched_trigger, outbound_message, action_taken, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      Number(input.flow_execution_id),
      Number(input.client_id),
      String(input.phone || ''),
      String(input.inbound_message || ''),
      String(input.matched_trigger || ''),
      String(input.outbound_message || ''),
      String(input.action_taken || ''),
      now
    );
  persistDb();
  return queryOne(database, 'SELECT * FROM whatsapp_flow_logs ORDER BY id DESC LIMIT 1');
}

export function listWhatsappFlowLogs(params = {}) {
  const database = getDb();
  const filters = [];
  const values = [];
  if (params.flow_execution_id) {
    filters.push('l.flow_execution_id = ?');
    values.push(Number(params.flow_execution_id));
  }
  if (params.client_id) {
    filters.push('l.client_id = ?');
    values.push(Number(params.client_id));
  }
  const limit = Math.min(Math.max(Number(params.limit || 100), 1), 500);
  return queryAll(
    database,
    `
      SELECT l.*, c.name AS client_name, c.cpf AS client_cpf, e.flow_id, f.name AS flow_name
      FROM whatsapp_flow_logs l
      LEFT JOIN clients c ON c.id = l.client_id
      LEFT JOIN whatsapp_flow_executions e ON e.id = l.flow_execution_id
      LEFT JOIN whatsapp_flows f ON f.id = e.flow_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY datetime(l.created_at) DESC, l.id DESC
      LIMIT ${limit}
    `,
    values
  );
}

export function createWhatsappMessageRecord(input = {}) {
  const database = getDb();
  const now = nowIso();
  database
    .prepare(
      `
        INSERT INTO whatsapp_messages (
          client_id, phone, direction, provider, template_id, message_body, status, provider_message_id,
          error_message, sent_by, sent_at, delivered_at, read_at, received_at, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.client_id ?? null,
      input.phone || '',
      input.direction || 'outbound',
      input.provider || 'unofficial',
      input.template_id ?? null,
      input.message_body || '',
      input.status || 'pending',
      input.provider_message_id || '',
      input.error_message || '',
      input.sent_by ?? null,
      input.sent_at ?? null,
      input.delivered_at ?? null,
      input.read_at ?? null,
      input.received_at ?? null,
      now
    );
  persistDb();
  return queryOne(database, 'SELECT * FROM whatsapp_messages ORDER BY id DESC LIMIT 1');
}

export function updateWhatsappMessageRecord(id, patch = {}) {
  const database = getDb();
  const current = queryOne(database, 'SELECT * FROM whatsapp_messages WHERE id = ?', [Number(id)]);
  if (!current) return null;
  const next = {
    status: patch.status ?? current.status,
    provider_message_id: patch.provider_message_id ?? current.provider_message_id ?? '',
    error_message: patch.error_message ?? current.error_message ?? '',
    delivered_at: patch.delivered_at ?? current.delivered_at ?? null,
    read_at: patch.read_at ?? current.read_at ?? null,
    received_at: patch.received_at ?? current.received_at ?? null,
  };
  database
    .prepare(
      'UPDATE whatsapp_messages SET status = ?, provider_message_id = ?, error_message = ?, delivered_at = ?, read_at = ?, received_at = ? WHERE id = ?'
    )
    .run(next.status, next.provider_message_id, next.error_message, next.delivered_at, next.read_at, next.received_at, Number(id));
  persistDb();
  return queryOne(database, 'SELECT * FROM whatsapp_messages WHERE id = ?', [Number(id)]);
}

export function listWhatsappMessages(params = {}) {
  const database = getDb();
  const filters = [];
  const values = [];
  if (params.client_id) {
    filters.push('m.client_id = ?');
    values.push(Number(params.client_id));
  }
  if (params.status) {
    filters.push('m.status = ?');
    values.push(String(params.status));
  }
  if (params.direction) {
    filters.push('m.direction = ?');
    values.push(String(params.direction));
  }
  if (params.search) {
    const term = `%${String(params.search).trim()}%`;
    filters.push('(m.phone LIKE ? OR m.message_body LIKE ? OR m.provider_message_id LIKE ? OR c.name LIKE ?)');
    values.push(term, term, term, term);
  }
  const limit = Math.min(Math.max(Number(params.limit || 100), 1), 500);
  return queryAll(
    database,
    `
      SELECT m.*, c.name AS client_name, c.cpf AS client_cpf
      FROM whatsapp_messages m
      LEFT JOIN clients c ON c.id = m.client_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY datetime(COALESCE(m.sent_at, m.received_at, m.created_at)) DESC, m.id DESC
      LIMIT ${limit}
    `,
    values
  );
}

export function createWhatsappSendJobRecord(input = {}) {
  const database = getDb();
  const now = nowIso();
  database
    .prepare(
      'INSERT INTO whatsapp_send_jobs (client_id, phone, template_id, message_body, status, scheduled_at, sent_at, error_message, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      input.client_id ?? null,
      input.phone || '',
      input.template_id ?? null,
      input.message_body || '',
      input.status || 'pending',
      input.scheduled_at ?? null,
      input.sent_at ?? null,
      input.error_message || '',
      input.created_by ?? null,
      now
    );
  persistDb();
  return queryOne(database, 'SELECT * FROM whatsapp_send_jobs ORDER BY id DESC LIMIT 1');
}

export function listWhatsappSendJobs(params = {}) {
  const database = getDb();
  const filters = [];
  const values = [];
  if (params.status) {
    filters.push('status = ?');
    values.push(String(params.status));
  }
  if (params.client_id) {
    filters.push('client_id = ?');
    values.push(Number(params.client_id));
  }
  const limit = Math.min(Math.max(Number(params.limit || 100), 1), 500);
  return queryAll(
    database,
    `
      SELECT *
      FROM whatsapp_send_jobs
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY datetime(COALESCE(scheduled_at, created_at)) ASC, id ASC
      LIMIT ${limit}
    `,
    values
  );
}

export function updateWhatsappSendJobRecord(id, patch = {}) {
  const database = getDb();
  const current = queryOne(database, 'SELECT * FROM whatsapp_send_jobs WHERE id = ?', [Number(id)]);
  if (!current) return null;
  const next = {
    status: patch.status ?? current.status,
    scheduled_at: patch.scheduled_at ?? current.scheduled_at ?? null,
    sent_at: patch.sent_at ?? current.sent_at ?? null,
    error_message: patch.error_message ?? current.error_message ?? '',
  };
  database
    .prepare('UPDATE whatsapp_send_jobs SET status = ?, scheduled_at = ?, sent_at = ?, error_message = ? WHERE id = ?')
    .run(next.status, next.scheduled_at, next.sent_at, next.error_message, Number(id));
  persistDb();
  return queryOne(database, 'SELECT * FROM whatsapp_send_jobs WHERE id = ?', [Number(id)]);
}

export function countWhatsappMessagesSentToday({ phone, provider }) {
  const database = getDb();
  const day = nowIso().slice(0, 10);
  const row = queryOne(
    database,
    `
      SELECT COUNT(*) AS total
      FROM whatsapp_messages
      WHERE phone = ?
        AND provider = ?
        AND direction = 'outbound'
        AND status IN ('sent', 'delivered', 'read')
        AND substr(COALESCE(sent_at, created_at), 1, 10) = ?
    `,
    [phone || '', provider || 'unofficial', day]
  );
  return Number(row?.total || 0);
}

export function getLastWhatsappOutboundByPhone(phone) {
  const database = getDb();
  return queryOne(
    database,
    `
      SELECT *
      FROM whatsapp_messages
      WHERE phone = ?
        AND direction = 'outbound'
        AND status IN ('sent', 'delivered', 'read')
      ORDER BY datetime(COALESCE(sent_at, created_at)) DESC, id DESC
      LIMIT 1
    `,
    [phone || '']
  );
}

export function findClientByPhone(phone) {
  const database = getDb();
  const normalized = normalizePhoneToBrazilInternational(phone);
  const digits = cleanDigits(phone);
  if (!normalized && !digits) {
    return null;
  }
  const row = queryOne(
    database,
    `
      ${getClientBaseQuery()}
      LEFT JOIN client_phones cp ON cp.client_id = c.id
      WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(c.phone, ''), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '') IN (?, ?)
         OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(cp.phone_number, ''), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '') IN (?, ?)
         OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(cp.normalized_phone, ''), '+', ''), ' ', ''), '-', ''), '(', ''), ')', '') IN (?, ?)
      ORDER BY c.id DESC
      LIMIT 1
    `,
    [normalized, digits, normalized, digits, normalized, digits]
  );
  return row ? clientDto(database, row, getClientMargins(database, row.id), [], [], []) : null;
}

export function updateClientWhatsappState(clientId, patch = {}) {
  const database = getDb();
  const current = queryOne(database, 'SELECT * FROM clients WHERE id = ?', [Number(clientId)]);
  if (!current) return null;
  const updates = [];
  const values = [];
  if (patch.whatsapp_allowed !== undefined) {
    updates.push('whatsapp_allowed = ?');
    values.push(patch.whatsapp_allowed ? 1 : 0);
  }
  if (patch.whatsapp_opt_out !== undefined) {
    updates.push('whatsapp_opt_out = ?');
    values.push(patch.whatsapp_opt_out ? 1 : 0);
  }
  if (patch.whatsapp_blocked !== undefined) {
    updates.push('whatsapp_blocked = ?');
    values.push(patch.whatsapp_blocked ? 1 : 0);
  }
  if (patch.whatsapp_last_contact_at !== undefined) {
    updates.push('whatsapp_last_contact_at = ?');
    values.push(patch.whatsapp_last_contact_at || null);
  }
  if (patch.whatsapp_last_response_at !== undefined) {
    updates.push('whatsapp_last_response_at = ?');
    values.push(patch.whatsapp_last_response_at || null);
  }
  if (patch.whatsapp_status !== undefined) {
    updates.push('whatsapp_status = ?');
    values.push(String(patch.whatsapp_status || 'ready'));
  }
  if (patch.status_atendimento !== undefined) {
    updates.push('status_atendimento = ?');
    values.push(String(patch.status_atendimento || current.status_atendimento || 'novo_na_fila'));
    updates.push('status = ?');
    values.push(String(patch.status_atendimento || current.status || 'novo_na_fila'));
  }
  if (!updates.length) {
    return getClientById(Number(clientId));
  }
  updates.push('updated_at = ?');
  values.push(nowIso());
  values.push(Number(clientId));
  database.prepare(`UPDATE clients SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  persistDb();
  return getClientById(Number(clientId));
}

export function getDashboardData(params = {}) {
  const database = getDb();
  const filters = [];
  const values = [];

  if (String(params.include_archived || '') !== '1' && params.include_archived !== true) {
    filters.push('COALESCE(b.is_active, 1) = 1');
  }

  if (params.base_id) {
    filters.push('c.base_id = ?');
    values.push(Number(params.base_id));
  }

  if (params.campaign_id) {
    filters.push('(c.campaign_id = ? OR b.campaign_id = ?)');
    values.push(Number(params.campaign_id), Number(params.campaign_id));
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
        SUM(CASE WHEN status_atendimento = 'finalizado' AND date(c.updated_at) = date('now') THEN 1 ELSE 0 END) AS finished_today,
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
    filters.push('c.base_id = ?');
    values.push(Number(params.base_id));
  }

  if (params.campaign_id) {
    filters.push('(c.campaign_id = ? OR b.campaign_id = ?)');
    values.push(Number(params.campaign_id), Number(params.campaign_id));
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
    filters.push('(c.campaign_id = ? OR b.campaign_id = ?)');
    values.push(Number(params.campaign_id), Number(params.campaign_id));
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
      LEFT JOIN campaigns cam ON cam.id = COALESCE(c.campaign_id, b.campaign_id)
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
  const result = database
    .prepare(
      `
        INSERT INTO users (name, login, email, password_hash, role, is_active, last_login_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(name, login, login, passwordHash, normalizeUserRole(role), isActive ? 1 : 0, null, now, now);
  const insertedId = Number(result?.lastInsertRowid || result?.lastInsertRowID || result?.lastInsertId || 0);
  return getUserById(insertedId) || getUserByLogin(login);
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

function mapAverbadorCredentialRow(row) {
  if (!row) {
    return null;
  }
  return {
    ...row,
    id: Number(row.id),
    requires_captcha: Boolean(Number(row.requires_captcha || 0)),
    requires_assisted_login: Boolean(Number(row.requires_assisted_login || 0)),
    created_by: row.created_by === null || row.created_by === undefined ? null : Number(row.created_by),
    updated_by: row.updated_by === null || row.updated_by === undefined ? null : Number(row.updated_by),
  };
}

export function listAverbadorCredentials() {
  const database = getDb();
  return queryAll(
    database,
    `
      SELECT *
      FROM averbador_credentials
      ORDER BY portal_name ASC, portal_id ASC
    `
  ).map(mapAverbadorCredentialRow);
}

export function getAverbadorCredentialById(id) {
  const database = getDb();
  return mapAverbadorCredentialRow(queryOne(database, 'SELECT * FROM averbador_credentials WHERE id = ? LIMIT 1', [Number(id)]));
}

export function getAverbadorCredentialByPortalId(portalId) {
  const database = getDb();
  return mapAverbadorCredentialRow(
    queryOne(database, 'SELECT * FROM averbador_credentials WHERE portal_id = ? LIMIT 1', [String(portalId || '')])
  );
}

export function upsertAverbadorCredential(input = {}) {
  const database = getDb();
  const now = nowIso();
  const portalId = String(input.portal_id || input.portalId || '').trim();
  const current = getAverbadorCredentialByPortalId(portalId);
  const payload = {
    portal_name: String(input.portal_name || input.portalName || current?.portal_name || ''),
    portal_url: String(input.portal_url || input.portalUrl || current?.portal_url || ''),
    login: String(input.login || current?.login || ''),
    encrypted_password:
      input.encrypted_password !== undefined
        ? String(input.encrypted_password || '')
        : String(current?.encrypted_password || ''),
    requires_captcha: input.requires_captcha || input.requiresCaptcha ? 1 : 0,
    requires_assisted_login: input.requires_assisted_login || input.requiresAssistedLogin ? 1 : 0,
    session_status: String(input.session_status || input.sessionStatus || current?.session_status || 'nao_conectado'),
    last_access_at: input.last_access_at ?? input.lastAccessAt ?? current?.last_access_at ?? null,
    session_expires_at: input.session_expires_at ?? input.sessionExpiresAt ?? current?.session_expires_at ?? null,
    last_test_at: input.last_test_at ?? input.lastTestAt ?? current?.last_test_at ?? null,
    last_error: String(input.last_error ?? input.lastError ?? current?.last_error ?? ''),
    updated_by: input.updated_by ?? input.updatedBy ?? current?.updated_by ?? null,
  };

  if (current) {
    database
      .prepare(
        `
          UPDATE averbador_credentials
          SET portal_name = ?,
              portal_url = ?,
              login = ?,
              encrypted_password = ?,
              requires_captcha = ?,
              requires_assisted_login = ?,
              session_status = ?,
              last_access_at = ?,
              session_expires_at = ?,
              last_test_at = ?,
              last_error = ?,
              updated_by = ?,
              updated_at = ?
          WHERE id = ?
        `
      )
      .run(
        payload.portal_name,
        payload.portal_url,
        payload.login,
        payload.encrypted_password,
        payload.requires_captcha,
        payload.requires_assisted_login,
        payload.session_status,
        payload.last_access_at,
        payload.session_expires_at,
        payload.last_test_at,
        payload.last_error,
        payload.updated_by,
        now,
        current.id
      );
    return getAverbadorCredentialById(current.id);
  }

  const result = database
    .prepare(
      `
        INSERT INTO averbador_credentials (
          portal_id,
          portal_name,
          portal_url,
          login,
          encrypted_password,
          requires_captcha,
          requires_assisted_login,
          session_status,
          last_access_at,
          session_expires_at,
          last_test_at,
          last_error,
          created_by,
          updated_by,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      portalId,
      payload.portal_name,
      payload.portal_url,
      payload.login,
      payload.encrypted_password,
      payload.requires_captcha,
      payload.requires_assisted_login,
      payload.session_status,
      payload.last_access_at,
      payload.session_expires_at,
      payload.last_test_at,
      payload.last_error,
      input.created_by ?? input.createdBy ?? null,
      payload.updated_by,
      now,
      now
    );

  return getAverbadorCredentialById(Number(result?.lastInsertRowid || 0));
}

export function updateAverbadorCredentialById(id, input = {}) {
  const current = getAverbadorCredentialById(id);
  if (!current) {
    return null;
  }
  return upsertAverbadorCredential({ ...current, ...input, portal_id: current.portal_id });
}

export function upsertAverbadorSession(input = {}) {
  const database = getDb();
  const now = nowIso();
  const credentialId = Number(input.credential_id || input.credentialId || 0);
  const current = queryOne(
    database,
    'SELECT * FROM averbador_sessions WHERE credential_id = ? ORDER BY datetime(updated_at) DESC, id DESC LIMIT 1',
    [credentialId]
  );
  const status = String(input.status || current?.status || 'nao_conectado');
  const portalId = String(input.portal_id || input.portalId || current?.portal_id || '');
  const storageStatePath = String(input.storage_state_path || input.storageStatePath || current?.storage_state_path || '');
  const cookiesPath = String(input.cookies_path || input.cookiesPath || current?.cookies_path || '');
  const lastLoginAt = input.last_login_at ?? input.lastLoginAt ?? current?.last_login_at ?? null;
  const expiresAt = input.expires_at ?? input.expiresAt ?? current?.expires_at ?? null;
  const requiresManualAction = input.requires_manual_action || input.requiresManualAction ? 1 : 0;
  const lastError = String(input.last_error ?? input.lastError ?? current?.last_error ?? '');

  if (current) {
    database
      .prepare(
        `
          UPDATE averbador_sessions
          SET portal_id = ?,
              status = ?,
              storage_state_path = ?,
              cookies_path = ?,
              last_login_at = ?,
              expires_at = ?,
              requires_manual_action = ?,
              last_error = ?,
              updated_at = ?
          WHERE id = ?
        `
      )
      .run(portalId, status, storageStatePath, cookiesPath, lastLoginAt, expiresAt, requiresManualAction, lastError, now, current.id);
    return queryOne(database, 'SELECT * FROM averbador_sessions WHERE id = ? LIMIT 1', [current.id]);
  }

  const result = database
    .prepare(
      `
        INSERT INTO averbador_sessions (
          credential_id,
          portal_id,
          status,
          storage_state_path,
          cookies_path,
          last_login_at,
          expires_at,
          requires_manual_action,
          last_error,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(credentialId, portalId, status, storageStatePath, cookiesPath, lastLoginAt, expiresAt, requiresManualAction, lastError, now, now);

  return queryOne(database, 'SELECT * FROM averbador_sessions WHERE id = ? LIMIT 1', [Number(result?.lastInsertRowid || 0)]);
}

export function insertCredentialConnectionLog(input = {}) {
  const database = getDb();
  const now = nowIso();
  const result = database
    .prepare(
      `
        INSERT INTO credential_connection_logs (
          credential_id,
          portal_id,
          action,
          status,
          message,
          error_message,
          created_at,
          created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    )
    .run(
      input.credential_id ?? input.credentialId ?? null,
      String(input.portal_id || input.portalId || ''),
      String(input.action || ''),
      String(input.status || ''),
      String(input.message || ''),
      String(input.error_message || input.errorMessage || ''),
      now,
      input.created_by ?? input.createdBy ?? null
    );
  return queryOne(database, 'SELECT * FROM credential_connection_logs WHERE id = ? LIMIT 1', [Number(result?.lastInsertRowid || 0)]);
}

export function listCredentialConnectionLogs(params = {}) {
  const database = getDb();
  const values = [];
  const clauses = [];
  if (params.portal_id || params.portalId) {
    clauses.push('l.portal_id = ?');
    values.push(String(params.portal_id || params.portalId));
  }
  if (params.credential_id || params.credentialId) {
    clauses.push('l.credential_id = ?');
    values.push(Number(params.credential_id || params.credentialId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return queryAll(
    database,
    `
      SELECT
        l.*,
        c.portal_name,
        c.portal_url,
        u.name AS created_by_name
      FROM credential_connection_logs l
      LEFT JOIN averbador_credentials c ON c.id = l.credential_id
      LEFT JOIN users u ON u.id = l.created_by
      ${where}
      ORDER BY datetime(l.created_at) DESC, l.id DESC
      LIMIT 200
    `,
    values
  ).map((row) => ({
    ...row,
    id: Number(row.id),
    credential_id: row.credential_id === null || row.credential_id === undefined ? null : Number(row.credential_id),
    created_by: row.created_by === null || row.created_by === undefined ? null : Number(row.created_by),
  }));
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
          not_found_count,
          error_count,
          captcha_count,
          status,
          started_at,
          finished_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 'pendente', NULL, NULL, ?, ?)
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
    not_found_count: Number(row.not_found_count || 0),
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
    not_found_count: 'not_found_count',
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
  const numericKeys = new Set(['total_cpfs', 'processed_count', 'success_count', 'no_margin_count', 'not_found_count', 'error_count', 'captcha_count', 'user_id']);
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
    not_found_count: Number(row.not_found_count || 0),
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
  const filters = [];
  const values = [];

  if (String(params.include_archived || '') !== '1' && params.include_archived !== true) {
    filters.push('COALESCE(b.is_active, 1) = 1');
  }

  if (params.campaign_id) {
    filters.push('b.campaign_id = ?');
    values.push(Number(params.campaign_id));
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
  return queryAll(
    database,
    `
      SELECT
        b.*,
        c.name AS campaign_name,
        c.convenio AS campaign_convenio,
        c.description AS campaign_description,
        c.product_focus AS campaign_product_focus,
        c.status AS campaign_status
      FROM bases b
      LEFT JOIN campaigns c ON c.id = b.campaign_id
      ${whereClause}
      ORDER BY COALESCE(datetime(b.updated_at), datetime(b.created_at)) DESC, b.id DESC
    `
    ,
    values
  ).map((row) => ({
    ...row,
    campaign_name: row.campaign_name || '',
    campaign_convenio: row.campaign_convenio || '',
    campaign_description: row.campaign_description || '',
    campaign_product_focus: row.campaign_product_focus || '',
    campaign_status: row.campaign_status || '',
  }));
}

export function getCampaigns(params = {}) {
  const database = getDb();
  const role = String(params.role || '').toLowerCase();
  const userId = Number(params.user_id || 0);
  const rows = queryAll(
    database,
    `
      SELECT
        c.*,
        u.name AS created_by_name
      FROM campaigns c
      LEFT JOIN users u ON u.id = c.created_by
      ORDER BY
        CASE c.status
          WHEN 'active' THEN 0
          WHEN 'inactive' THEN 1
          WHEN 'archived' THEN 2
          ELSE 3
        END,
        datetime(c.updated_at) DESC,
        datetime(c.created_at) DESC,
        c.id DESC
    `
  );

  return rows
    .map((row) => campaignDto(database, row))
    .filter((campaign) => {
      if (String(params.include_archived || '') === '1' || params.include_archived === true) {
        return true;
      }
      return campaign.status !== 'archived';
    })
    .filter((campaign) => isCampaignVisibleToUser(database, campaign, userId, role));
}

export function getCampaignById(id, params = {}) {
  const database = getDb();
  const row = queryOne(
    database,
    `
      SELECT
        c.*,
        u.name AS created_by_name
      FROM campaigns c
      LEFT JOIN users u ON u.id = c.created_by
      WHERE c.id = ?
      LIMIT 1
    `,
    [id]
  );

  if (!row) {
    return null;
  }

  const campaign = campaignDto(database, row);
  const role = String(params.role || '').toLowerCase();
  const userId = Number(params.user_id || 0);
  if (!isCampaignVisibleToUser(database, campaign, userId, role) && role !== 'gerencial' && role !== 'admin') {
    return null;
  }

  return {
    ...campaign,
    bases: getBases({ campaign_id: id, include_archived: params.include_archived }),
    users: getCampaignUsers(database, id).map((user) => ({
      id: Number(user.user_id),
      name: user.user_name || '',
      login: user.user_login || '',
      role: user.user_role || 'vendedor',
    })),
  };
}

export function createCampaignRecordPublic(payload = {}, createdBy = null) {
  const database = getDb();
  const existingName = normalizeBaseText(payload.name || payload.nome || '');
  if (!existingName) {
    return null;
  }

  const normalizedStatus = normalizeCampaignStatus(payload.status || 'active');
  const activeDuplicate = queryOne(
    database,
    `SELECT id FROM campaigns WHERE lower(name) = lower(?) AND status <> 'archived' LIMIT 1`,
    [existingName]
  );
  if (activeDuplicate && Number(activeDuplicate.id) !== Number(payload.id || 0)) {
    throw new Error('Ja existe uma campanha ativa com este nome.');
  }

  const campaign = createCampaignRecord(database, payload, createdBy);
  if (payload.user_ids && Array.isArray(payload.user_ids)) {
    setCampaignUsers(database, campaign.id, payload.user_ids, payload.role || 'vendedor');
  }
  if (normalizedStatus !== 'archived') {
    refreshCampaignTotals(database, campaign.id);
  }
  persistDb();
  return getCampaignById(campaign.id, { include_archived: true });
}

export function updateCampaignRecord(id, payload = {}) {
  const database = getDb();
  const current = queryOne(database, 'SELECT * FROM campaigns WHERE id = ?', [id]);
  if (!current) {
    return null;
  }

  const nextName = normalizeBaseText(payload.name || payload.nome || current.name);
  const nextConvenio = normalizeBaseText(payload.convenio || payload.orgao || current.convenio || '');
  const nextDescription = normalizeBaseText(payload.description || payload.descricao || current.description || '');
  const nextProductFocus = normalizeCampaignProductFocus(payload.product_focus || payload.productFocus || current.product_focus || 'outros');
  const nextStatus = normalizeCampaignStatus(payload.status || current.status || 'active');
  const nextNotes = normalizeBaseText(payload.internal_notes || payload.observacao || current.internal_notes || '');
  const nextFileName = normalizeBaseText(payload.file_name || payload.arquivo_original || current.file_name || '');

  const duplicate = queryOne(
    database,
    `SELECT id FROM campaigns WHERE lower(name) = lower(?) AND id <> ? AND status <> 'archived' LIMIT 1`,
    [nextName, id]
  );
  if (duplicate) {
    throw new Error('Ja existe uma campanha ativa com este nome.');
  }

  database
    .prepare(
      `
        UPDATE campaigns
        SET
          name = ?,
          convenio = ?,
          description = ?,
          product_focus = ?,
          status = ?,
          internal_notes = ?,
          file_name = COALESCE(NULLIF(?, ''), file_name),
          created_by = COALESCE(?, created_by),
          updated_at = ?
        WHERE id = ?
      `
    )
    .run(
      nextName,
      nextConvenio,
      nextDescription,
      nextProductFocus,
      nextStatus,
      nextNotes,
      nextFileName,
      payload.created_by ?? payload.createdBy ?? null,
      nowIso(),
      id
    );

  if (Array.isArray(payload.user_ids)) {
    setCampaignUsers(database, id, payload.user_ids, payload.role || 'vendedor');
  }

  refreshCampaignTotals(database, id);
  persistDb();
  return getCampaignById(id, { include_archived: true });
}

export function setCampaignUsers(databaseOrId, campaignIdOrUsers, maybeUserIds, maybeRole = 'vendedor') {
  const database = typeof databaseOrId === 'object' && databaseOrId.__isAdapter ? databaseOrId : getDb();
  const campaignId = typeof databaseOrId === 'object' && databaseOrId.__isAdapter ? Number(campaignIdOrUsers) : Number(databaseOrId);
  const userIds = Array.isArray(typeof databaseOrId === 'object' && databaseOrId.__isAdapter ? maybeUserIds : campaignIdOrUsers)
    ? (typeof databaseOrId === 'object' && databaseOrId.__isAdapter ? maybeUserIds : campaignIdOrUsers)
    : [];
  const role = typeof databaseOrId === 'object' && databaseOrId.__isAdapter ? maybeRole : maybeUserIds || 'vendedor';

  if (!campaignId) {
    return null;
  }

  database.prepare('DELETE FROM campaign_users WHERE campaign_id = ?').run(campaignId);
  const insert = database.prepare('INSERT INTO campaign_users (campaign_id, user_id, role, created_at) VALUES (?, ?, ?, ?)');
  for (const userId of userIds) {
    const numericUserId = Number(userId);
    if (!numericUserId) continue;
    insert.run(campaignId, numericUserId, role, nowIso());
  }
  persistDb();
  return getCampaignUsers(database, campaignId);
}

export function archiveCampaignRecord(id, archived = true) {
  const database = getDb();
  const current = queryOne(database, 'SELECT * FROM campaigns WHERE id = ?', [id]);
  if (!current) {
    return null;
  }

  database
    .prepare('UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?')
    .run(archived ? 'archived' : 'inactive', nowIso(), id);
  persistDb();
  return getCampaignById(id, { include_archived: true });
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
