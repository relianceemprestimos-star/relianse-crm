import { cleanDigits } from '../../utils.js';
import { getCredentialSecretByPortal } from '../credentials/credentialService.js';
import { dedupePhones } from './phoneNormalizer.js';

const SOURCE = 'Datafour';
const API_BASE = 'https://api.datafile.com.br/';

let tokenCache = {
  token: '',
  expiresAt: 0,
  login: '',
};

function configuredApiBase() {
  return String(process.env.DATAFOUR_API_URL || API_BASE).trim().replace(/\/?$/, '/');
}

function configuredUrl() {
  return String(process.env.DATAFOUR_URL || 'https://datafile.com.br/login/').trim();
}

function configuredLogin() {
  let credential = null;
  try {
    credential = getCredentialSecretByPortal('datafour');
  } catch {
    credential = null;
  }
  return String(process.env.DATAFOUR_USERNAME || process.env.DATAFOUR_LOGIN || process.env.DATAFOUR_EMAIL || credential?.login || '').trim();
}

function configuredPassword() {
  let credential = null;
  try {
    credential = getCredentialSecretByPortal('datafour');
  } catch {
    credential = null;
  }
  return String(process.env.DATAFOUR_PASSWORD || credential?.password || '').trim();
}

function hasCredentials() {
  return Boolean(configuredLogin() && configuredPassword());
}

function shouldUse360() {
  return String(process.env.DATAFOUR_USE_360 || 'false').trim().toLowerCase() === 'true';
}

function safeMessage(value) {
  return String(value || '').replace(configuredPassword(), '[senha]').slice(0, 500);
}

function normalizeBirthDate(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = text.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return text;
}

function ageFromBirthDate(value = '') {
  const birthDate = normalizeBirthDate(value);
  const match = birthDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const birth = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(birth.getTime())) return null;
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age -= 1;
  }
  return age >= 0 && age < 130 ? age : null;
}

function normalizeEmailList(record = {}) {
  return [record.Email, record.Email2, record.email, record.email2, ...(Array.isArray(record.Emails) ? record.Emails : [])]
    .map((item) => (item && typeof item === 'object' ? item.email || item.Email || item.value : item))
    .map((item) => String(item || '').trim())
    .filter((item, index, list) => item && item.includes('@') && list.indexOf(item) === index);
}

function collectNestedValues(payload, keyPattern) {
  const found = [];
  const visit = (value) => {
    if (!value || found.length > 50) return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (keyPattern.test(String(key))) {
        if (Array.isArray(item)) {
          found.push(...item);
        } else {
          found.push(item);
        }
      }
      visit(item);
    }
  };
  visit(payload);
  return found;
}

function normalizeAddressList(record = {}) {
  const addresses = [];
  const direct = {
    street: record.Logradouro || record.logradouro || '',
    number: record.Numero || record.numero || '',
    complement: record.Complemento || record.complemento || '',
    district: record.Bairro || record.bairro || '',
    city: record.Cidade || record.cidade || '',
    state: record.Uf || record.UF || record.Estado || record.estado || '',
    zipcode: cleanDigits(record.Cep || record.CEP || record.cep || ''),
  };
  const full = [direct.street, direct.number, direct.complement, direct.district, direct.city, direct.state, direct.zipcode].filter(Boolean).join(', ');
  if (full) {
    addresses.push({ ...direct, address_full: full, source: SOURCE });
  }
  const nested = Array.isArray(record.Enderecos || record.enderecos) ? record.Enderecos || record.enderecos : [];
  for (const item of nested) {
    const address = {
      street: item.Logradouro || item.logradouro || item.Endereco || item.endereco || '',
      number: item.Numero || item.numero || '',
      complement: item.Complemento || item.complemento || '',
      district: item.Bairro || item.bairro || '',
      city: item.Cidade || item.cidade || '',
      state: item.Uf || item.UF || item.Estado || item.estado || '',
      zipcode: cleanDigits(item.Cep || item.CEP || item.cep || ''),
      source: SOURCE,
    };
    address.address_full =
      item.EnderecoCompleto ||
      item.enderecoCompleto ||
      item.address_full ||
      [address.street, address.number, address.complement, address.district, address.city, address.state, address.zipcode].filter(Boolean).join(', ');
    if (address.address_full && !addresses.some((existing) => existing.address_full === address.address_full)) {
      addresses.push(address);
    }
  }
  return addresses;
}

function normalizePhoneList(record = {}) {
  const rawPhones = [
    record.Telefone,
    record.Celular,
    record.Whatsapp,
    record.phone,
    ...(Array.isArray(record.Telefones) ? record.Telefones : []),
    ...(Array.isArray(record.telefones) ? record.telefones : []),
  ].filter(Boolean);

  const phones = rawPhones
    .map((item) => {
      if (typeof item === 'object') {
        return {
          number: item.Telefone || item.Celular || item.Numero || item.numero || item.phone || item.telefone || '',
          type: item.Tipo || item.tipo || item.Descricao || item.descricao || '',
          quality: item.Qualidade || item.qualidade || item.Score || item.score || '',
          raw_label: item.Tipo || item.tipo || item.Descricao || item.descricao || '',
          source: SOURCE,
        };
      }
      return { number: item, source: SOURCE };
    })
    .filter((item) => item.number);

  return dedupePhones(phones).sort((a, b) => {
    const score = (phone) => {
      const type = String(phone.type || '').toLowerCase();
      const raw = String(phone.raw_label || '').toLowerCase();
      if (type.includes('whatsapp') || raw.includes('whatsapp')) return 0;
      if (type.includes('cel') || raw.includes('cel') || cleanDigits(phone.normalized).replace(/^55/, '').length === 11) return 1;
      return 2;
    };
    return score(a) - score(b);
  });
}

function extractCadastro(payload = {}) {
  if (Array.isArray(payload.Cadastro)) return payload.Cadastro[0] || null;
  if (Array.isArray(payload.cadastro)) return payload.cadastro[0] || null;
  if (payload.Cadastro && typeof payload.Cadastro === 'object') return payload.Cadastro;
  if (payload.pessoa && typeof payload.pessoa === 'object') return payload.pessoa;
  if (payload.result && Array.isArray(payload.result)) return payload.result[0] || null;
  if (payload.results && Array.isArray(payload.results)) return payload.results[0] || null;
  return payload && typeof payload === 'object' ? payload : null;
}

function normalizeDatafourResult(payload = {}, fallback = {}) {
  const record = extractCadastro(payload) || {};
  const cpf = cleanDigits(record.Doc || record.CPF || record.cpf || fallback.cpf || '');
  const fullName = String(record.Nome || record.nome || record.NomeCompleto || record.full_name || fallback.name || '').trim();
  const birthDate = normalizeBirthDate(record.DataNascimento || record.Nascimento || record.birth_date || '');
  const phones = dedupePhones([...normalizePhoneList(record), ...normalizePhoneList({ Telefones: collectNestedValues(payload, /^(telefones|contatos|phones)$/i) })]).sort((a, b) => {
    const score = (phone) => (String(phone.type || '').toLowerCase().includes('fix') ? 2 : cleanDigits(phone.normalized).replace(/^55/, '').length === 11 ? 0 : 1);
    return score(a) - score(b);
  });
  const emails = [...normalizeEmailList(record), ...collectNestedValues(payload, /^emails?$/i).flatMap((item) => normalizeEmailList({ Email: item }))].filter(
    (item, index, list) => item && list.indexOf(item) === index
  );
  const addresses = [...normalizeAddressList(record), ...normalizeAddressList({ Enderecos: collectNestedValues(payload, /^enderecos?$/i) })];
  return {
    source: SOURCE,
    cpf,
    name: fullName,
    full_name: fullName,
    birth_date: birthDate,
    age: ageFromBirthDate(birthDate),
    gender: String(record.Genero || record.Sexo || record.gender || '').trim(),
    mother_name: String(record.NomeMae || record.Mae || record.mother_name || '').trim(),
    father_name: String(record.NomePai || record.Pai || record.father_name || '').trim(),
    email: emails[0] || '',
    emails,
    addresses,
    phones,
    raw_data: {
      provider: SOURCE,
      top_level_keys: Object.keys(payload || {}),
      record_keys: Object.keys(record || {}),
    },
  };
}

async function requestJson(path, { method = 'GET', body = null, token = '' } = {}) {
  const response = await fetch(`${configuredApiBase()}${path.replace(/^\//, '')}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(parsed?.message || parsed?.error || `Datafour HTTP ${response.status}`);
    error.status = response.status;
    error.payload = parsed;
    throw error;
  }
  return parsed;
}

async function authToken() {
  const login = configuredLogin();
  if (tokenCache.token && tokenCache.login === login && tokenCache.expiresAt > Date.now() + 60000) {
    return tokenCache.token;
  }
  const parsed = await requestJson('auth', {
    method: 'POST',
    body: { login: configuredLogin(), password: configuredPassword(), rememberMe: true },
  });
  const token = parsed?.user?.token || parsed?.token || '';
  if (!token) {
    const error = new Error('Datafour nao retornou token de autenticacao.');
    error.code = 'DATAFOUR_AUTH_TOKEN_MISSING';
    throw error;
  }
  tokenCache = {
    token,
    login,
    expiresAt: Date.now() + 45 * 60 * 1000,
  };
  return token;
}

export function getDatafourDiagnostics() {
  return {
    source: SOURCE,
    configured: hasCredentials(),
    hasUrl: Boolean(configuredUrl()),
    host: configuredUrl() ? new URL(configuredUrl()).host : '',
    apiHost: new URL(configuredApiBase()).host,
    hasUsername: Boolean(configuredLogin()),
    hasPassword: Boolean(configuredPassword()),
    use360: shouldUse360(),
  };
}

export async function mapDatafourFlow() {
  if (!hasCredentials()) {
    return {
      source: SOURCE,
      status: 'requires_manual_login',
      code: 'DATAFOUR_NOT_CONFIGURED',
      message: 'Configure DATAFOUR_USERNAME/DATAFOUR_LOGIN e DATAFOUR_PASSWORD no ambiente.',
      loginOk: false,
    };
  }
  try {
    const token = await authToken();
    const info = await requestJson('info-conta', { token });
    return {
      source: SOURCE,
      status: 'success',
      code: '',
      message: 'Datafour autenticado com sucesso.',
      loginOk: true,
      raw_data: { top_level_keys: Object.keys(info || {}) },
    };
  } catch (error) {
    return {
      source: SOURCE,
      status: 'failed',
      code: error?.code || 'DATAFOUR_AUTH_FAILED',
      message: safeMessage(error instanceof Error ? error.message : 'Falha ao autenticar no Datafour.'),
      loginOk: false,
    };
  }
}

export async function lookupPhoneDatafour(client = {}) {
  const cpf = cleanDigits(client.cpf);
  const name = String(client.name || '').trim();
  const phone = cleanDigits(client.phone || client.telefone || '');
  if (!hasCredentials()) {
    return {
      source: SOURCE,
      cpf,
      name,
      phones: [],
      status: 'requires_manual_login',
      code: 'DATAFOUR_NOT_CONFIGURED',
      message: 'Configure a credencial Datafour para ativar a consulta.',
    };
  }
  try {
    const token = await authToken();
    let payload = null;
    if (cpf.length === 11) {
      payload = await requestJson(`pessoa-fisica/${cpf}`, { token });
      if (shouldUse360()) {
        try {
          const extra = await requestJson('consulta-360', { method: 'POST', token, body: { doc: cpf, confirmar: true } });
          payload = { ...payload, consulta360: extra };
        } catch {
          payload = { ...payload, consulta360_unavailable: true };
        }
      }
    } else if (phone) {
      payload = await requestJson('ConsultarPessoaFisicaPorTelefone', { method: 'POST', token, body: { telefone: phone } });
    } else if (name) {
      payload = await requestJson('ConsultarPessoaFisicaPorNome', { method: 'POST', token, body: { nome: name } });
    } else {
      return {
        source: SOURCE,
        cpf,
        name,
        phones: [],
        status: 'failed',
        code: 'DATAFOUR_SEARCH_INPUT_REQUIRED',
        message: 'Informe CPF, nome ou telefone para consultar no Datafour.',
      };
    }

    const normalized = normalizeDatafourResult(payload, { cpf, name, phone });
    const hasData = Boolean(normalized.full_name || normalized.phones.length || normalized.emails.length || normalized.addresses.length);
    return {
      ...normalized,
      status: hasData ? 'success' : 'not_found',
      code: hasData ? '' : 'DATAFOUR_NOT_FOUND',
      message: hasData ? 'Dados encontrados no Datafour.' : 'Nenhum dado encontrado no Datafour.',
    };
  } catch (error) {
    return {
      source: SOURCE,
      cpf,
      name,
      phones: [],
      status: error?.status === 401 || error?.status === 403 ? 'requires_manual_login' : 'failed',
      code: error?.status === 401 || error?.status === 403 ? 'DATAFOUR_AUTH_FAILED' : 'DATAFOUR_LOOKUP_ERROR',
      message: safeMessage(error instanceof Error ? error.message : 'Erro ao consultar Datafour.'),
    };
  }
}

export async function searchPhoneDatafour({ cpf = '', name = '', phone = '' } = {}) {
  return lookupPhoneDatafour({ cpf, name, phone, phones: [] });
}
