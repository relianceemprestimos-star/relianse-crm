import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { cleanDigits } from '../../utils.js';
import { dedupePhones } from './phoneNormalizer.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function configuredUrl() {
  return String(process.env.NOVA_VIDA_URL || '').trim().replace(/\/$/, '');
}

function hasCredentials() {
  return Boolean(
    configuredUrl() &&
      String(process.env.NOVA_VIDA_USERNAME || process.env.NOVA_VIDA_USER || '').trim() &&
      String(process.env.NOVA_VIDA_PASSWORD || '').trim()
  );
}

function configuredClient() {
  return String(process.env.NOVA_VIDA_CLIENT || process.env.NOVA_VIDA_CUSTOMER || process.env.NOVA_VIDA_TENANT || '').trim();
}

function getFixturePath() {
  return String(process.env.NOVA_VIDA_FIXTURE_PATH || '').trim();
}

function getPythonBin() {
  return String(process.env.PYTHON_BIN || process.env.PYTHON || 'python').trim();
}

function safeMessage(value) {
  return String(value || '')
    .replace(String(process.env.NOVA_VIDA_PASSWORD || ''), '[senha]')
    .slice(0, 500);
}

function normalizeLookupPhone(value) {
  const digits = cleanDigits(value);
  return digits.startsWith('55') && digits.length > 11 ? digits.slice(2) : digits;
}

async function runNovaVidaCli(args = []) {
  const scriptPath = path.join(__dirname, 'nova_vida_cli.py');
  try {
    const { stdout, stderr } = await execFileAsync(getPythonBin(), [scriptPath, ...args], {
      cwd: path.resolve(__dirname, '../../../..'),
      timeout: Number(process.env.NOVA_VIDA_TIMEOUT_MS || 90000),
      maxBuffer: 1024 * 1024 * 4,
      env: {
        ...process.env,
        NOVA_VIDA_HEADLESS: String(process.env.NOVA_VIDA_HEADLESS ?? 'true'),
      },
    });
    const text = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}';
    const parsed = JSON.parse(text);
    if (stderr) {
      parsed.stderr = safeMessage(stderr);
    }
    return parsed;
  } catch (error) {
    return {
      source: 'Nova Vida',
      status: 'failed',
      code: 'NOVA_VIDA_WORKER_ERROR',
      phones: [],
      message: safeMessage(error instanceof Error ? error.message : 'Erro ao executar worker Nova Vida.'),
    };
  }
}

function readFixture(client) {
  const fixturePath = getFixturePath();
  if (!fixturePath) return null;
  const fullPath = path.resolve(fixturePath);
  if (!fs.existsSync(fullPath)) return null;
  const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const cpf = cleanDigits(client.cpf);
  const phone = normalizeLookupPhone(client.phone || client.telefone);
  if (Array.isArray(raw)) {
    return raw.find((entry) => {
      const entryPhones = [
        entry.phone,
        entry.telefone,
        entry.celular,
        ...(Array.isArray(entry.phones) ? entry.phones : []),
        ...(Array.isArray(entry.telefones) ? entry.telefones : []),
      ];
      return (
        (cpf && cleanDigits(entry.cpf) === cpf) ||
        (client.name && String(entry.name || '').toLowerCase() === String(client.name || '').toLowerCase()) ||
        (phone && entryPhones.some((value) => normalizeLookupPhone(typeof value === 'object' ? value.number || value.phone_number || value.normalized : value) === phone))
      );
    }) || null;
  }
  return raw[cpf] || raw[String(client.name || '').toLowerCase()] || raw[phone] || null;
}

export function getNovaVidaDiagnostics() {
  return {
    source: 'Nova Vida',
    configured: hasCredentials(),
    hasUrl: Boolean(configuredUrl()),
    host: configuredUrl() ? new URL(configuredUrl()).host : '',
    hasUsername: Boolean(String(process.env.NOVA_VIDA_USERNAME || process.env.NOVA_VIDA_USER || '').trim()),
    hasClient: Boolean(configuredClient()),
    hasPassword: Boolean(String(process.env.NOVA_VIDA_PASSWORD || '').trim()),
    fixtureMode: Boolean(getFixturePath()),
    storageStateConfigured: Boolean(String(process.env.NOVA_VIDA_STORAGE_STATE || '').trim()),
  };
}

export async function mapNovaVidaFlow() {
  if (!hasCredentials()) {
    return {
      source: 'Nova Vida',
      status: 'requires_manual_login',
      code: 'NOVA_VIDA_NOT_CONFIGURED',
      message: 'Configure NOVA_VIDA_URL, NOVA_VIDA_USERNAME/NOVA_VIDA_USER, NOVA_VIDA_CLIENT e NOVA_VIDA_PASSWORD no .env.',
      loginOk: false,
    };
  }
  return runNovaVidaCli(['map']);
}

export async function lookupPhoneNovaVida(client) {
  const fixture = readFixture(client);
  if (fixture) {
    const phones = dedupePhones(fixture.phones || fixture.telefones || []);
    return {
      source: 'Nova Vida',
      cpf: cleanDigits(client.cpf),
      name: client.name || fixture.name || '',
      phones,
      status: phones.length ? 'success' : 'not_found',
      message: phones.length ? 'Telefones carregados por fixture autorizada.' : 'Nenhum telefone encontrado na fixture.',
    };
  }

  if (!hasCredentials()) {
    return {
      source: 'Nova Vida',
      cpf: cleanDigits(client.cpf),
      name: client.name || '',
      phones: [],
      status: 'requires_manual_login',
      code: 'NOVA_VIDA_NOT_CONFIGURED',
      message: 'Configure NOVA_VIDA_URL, NOVA_VIDA_USERNAME e NOVA_VIDA_PASSWORD no .env para ativar a consulta.',
    };
  }

  const result = await runNovaVidaCli([
    'search',
    '--cpf',
    cleanDigits(client.cpf),
    '--name',
    client.name || '',
    '--phone',
    normalizeLookupPhone(client.phone || client.telefone),
  ]);
  const phones = dedupePhones(result.phones || []);
  return {
    source: 'Nova Vida',
    cpf: cleanDigits(result.cpf || client.cpf),
    name: result.name || client.name || '',
    full_name: result.full_name || result.name || client.name || '',
    birth_date: result.birth_date || '',
    age: result.age ?? null,
    gender: result.gender || '',
    mother_name: result.mother_name || '',
    father_name: result.father_name || '',
    email: result.email || '',
    emails: Array.isArray(result.emails) ? result.emails : [],
    addresses: Array.isArray(result.addresses) ? result.addresses : [],
    extra: result.extra || {},
    raw_data: result.raw_data || {},
    phones,
    status: result.status || (phones.length ? 'success' : 'not_found'),
    code: result.code || '',
    message:
      result.code === 'NOVA_VIDA_SESSION_EXPIRED_MANUAL_LOGIN_REQUIRED'
        ? 'Sessao Nova Vida expirada. Login manual necessario.'
        : result.message || (phones.length ? 'Telefones encontrados no Nova Vida.' : 'Nenhum telefone encontrado no Nova Vida.'),
    stage: result.stage || '',
    reconnectAttempted: Boolean(result.reconnectAttempted),
    reconnectOk: Boolean(result.reconnectOk),
    raw: {
      page: result.page,
      navigationCandidates: result.navigationCandidates,
      inputCount: result.inputCount,
      reconnectAttempted: Boolean(result.reconnectAttempted),
      reconnectOk: Boolean(result.reconnectOk),
    },
  };
}

export async function searchPhoneNovaVida({ cpf = '', name = '', phone = '' } = {}) {
  return lookupPhoneNovaVida({
    cpf,
    name,
    phone,
    phones: [],
  });
}
