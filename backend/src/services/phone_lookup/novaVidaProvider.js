import fs from 'node:fs';
import path from 'node:path';

import { cleanDigits } from '../../utils.js';
import { dedupePhones } from './phoneNormalizer.js';

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

function getFixturePath() {
  return String(process.env.NOVA_VIDA_FIXTURE_PATH || '').trim();
}

function readFixture(client) {
  const fixturePath = getFixturePath();
  if (!fixturePath) return null;
  const fullPath = path.resolve(fixturePath);
  if (!fs.existsSync(fullPath)) return null;
  const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const cpf = cleanDigits(client.cpf);
  if (Array.isArray(raw)) {
    return raw.find((entry) => cleanDigits(entry.cpf) === cpf || String(entry.name || '').toLowerCase() === String(client.name || '').toLowerCase()) || null;
  }
  return raw[cpf] || raw[String(client.name || '').toLowerCase()] || null;
}

export function getNovaVidaDiagnostics() {
  return {
    source: 'Nova Vida',
    configured: hasCredentials(),
    hasUrl: Boolean(configuredUrl()),
    host: configuredUrl() ? new URL(configuredUrl()).host : '',
    hasUsername: Boolean(String(process.env.NOVA_VIDA_USERNAME || process.env.NOVA_VIDA_USER || '').trim()),
    hasPassword: Boolean(String(process.env.NOVA_VIDA_PASSWORD || '').trim()),
    fixtureMode: Boolean(getFixturePath()),
  };
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

  return {
    source: 'Nova Vida',
    cpf: cleanDigits(client.cpf),
    name: client.name || '',
    phones: [],
    status: 'requires_manual_login',
    code: 'NOVA_VIDA_PROVIDER_PENDING_MAPPING',
    message:
      'Credenciais configuradas. Falta mapear o fluxo real de pesquisa do Nova Vida com Playwright/API antes de consultar clientes reais automaticamente.',
  };
}
