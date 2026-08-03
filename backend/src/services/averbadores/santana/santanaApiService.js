const DEFAULT_TIMEOUT_MS = 30_000;

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function createApiError(code, message, status = 400, details = null) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

export function normalizeSantanaApiBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    throw createApiError(
      'SANTANA_API_URL_NOT_CONFIGURED',
      'Informe a URL oficial da API RF1 na Central de Credenciais.'
    );
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw createApiError('SANTANA_API_URL_INVALID', 'A URL da API RF1 é inválida.');
  }
  if (parsed.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw createApiError('SANTANA_API_URL_INSECURE', 'A API RF1 deve usar HTTPS em produção.');
  }
  parsed.pathname = parsed.pathname
    .replace(/\/Usuario\/login-api\/?$/i, '')
    .replace(/\/login-api\/?$/i, '')
    .replace(/\/+$/g, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

export function inferSantanaApiBaseUrl({ apiBaseUrl = '', portalUrl = '' } = {}) {
  const explicit = String(apiBaseUrl || process.env.SANTANA_API_BASE_URL || '').trim();
  if (explicit) {
    return normalizeSantanaApiBaseUrl(explicit);
  }
  const portal = String(portalUrl || '').trim();
  if (!portal) {
    return '';
  }
  try {
    const parsed = new URL(portal);
    if (/^[a-z0-9-]+\.rf1consig\.com\.br$/i.test(parsed.hostname) && !/api\./i.test(parsed.hostname)) {
      parsed.hostname = parsed.hostname.replace(/^([a-z0-9-]+)\./i, '$1api.');
      parsed.pathname = '';
      parsed.search = '';
      parsed.hash = '';
      return normalizeSantanaApiBaseUrl(parsed.toString());
    }
  } catch {
    return '';
  }
  return '';
}

function extractToken(payload) {
  if (typeof payload === 'string') {
    return payload.trim();
  }
  const candidates = [
    payload?.token,
    payload?.jwt,
    payload?.accessToken,
    payload?.access_token,
    payload?.bearerToken,
    payload?.data?.token,
    payload?.data?.jwt,
    payload?.data?.accessToken,
    payload?.data?.access_token,
    payload?.resultado?.token,
  ];
  return String(candidates.find(Boolean) || '').trim();
}

function authorizationHeader(token) {
  const value = String(token || '').trim();
  return /^bearer\s+/i.test(value) ? value : `Bearer ${value}`;
}

async function requestJson(url, options = {}, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = raw;
    }
    if (!response.ok) {
      const apiMessage =
        payload?.message ||
        payload?.mensagem ||
        payload?.errors?.[0]?.message ||
        (typeof payload === 'string' ? payload : '');
      throw createApiError(
        response.status === 401 || response.status === 422 ? 'SANTANA_API_LOGIN_REJECTED' : 'SANTANA_API_ERROR',
        apiMessage || `A API RF1 respondeu com status ${response.status}.`,
        response.status,
        { status: response.status }
      );
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw createApiError('SANTANA_API_TIMEOUT', 'A API RF1 de Santana demorou demais para responder.', 504);
    }
    if (error?.code) {
      throw error;
    }
    throw createApiError(
      'SANTANA_API_UNREACHABLE',
      'Não foi possível conectar à API RF1 de Santana.',
      503
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function authenticateSantanaApi({ apiBaseUrl, login, password, fetchImpl = fetch }) {
  const baseUrl = normalizeSantanaApiBaseUrl(apiBaseUrl);
  const cpf = digits(login);
  if (cpf.length !== 11 || !String(password || '')) {
    throw createApiError('SANTANA_CREDENTIAL_INVALID', 'Informe CPF de login e senha válidos para Santana.');
  }
  const payload = await requestJson(
    `${baseUrl}/Usuario/login-api`,
    {
      method: 'POST',
      body: JSON.stringify({ cpf, senha: String(password) }),
    },
    fetchImpl
  );
  const token = extractToken(payload);
  if (!token) {
    throw createApiError(
      'SANTANA_API_TOKEN_MISSING',
      'A API RF1 aceitou a chamada, mas não devolveu o token JWT esperado.',
      502
    );
  }
  return { token, baseUrl };
}

export async function findSantanaServerPreliminary({ baseUrl, token, cpf, fetchImpl = fetch }) {
  const normalizedCpf = digits(cpf).padStart(11, '0');
  if (normalizedCpf.length !== 11) {
    throw createApiError('INVALID_CPF', 'Informe um CPF válido para consultar Santana.');
  }
  return requestJson(
    `${normalizeSantanaApiBaseUrl(baseUrl)}/Servidor/buscar-preliminar-api?cpfOuMatricula=${encodeURIComponent(normalizedCpf)}`,
    { headers: { Authorization: authorizationHeader(token) } },
    fetchImpl
  );
}

function collectUuidCandidates(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectUuidCandidates(item, output));
    return output;
  }
  if (!value || typeof value !== 'object') {
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/^(uuid|guid)(servidor)?$/i.test(key) && typeof item === 'string' && item.trim()) {
      output.push(item.trim());
    }
    if (item && typeof item === 'object') {
      collectUuidCandidates(item, output);
    }
  }
  return output;
}

export function extractSantanaServerUuids(payload) {
  const directCandidates = [];
  const roots = Array.isArray(payload)
    ? payload
    : [
        ...(Array.isArray(payload?.servidores) ? payload.servidores : []),
        ...(Array.isArray(payload?.data) ? payload.data : []),
        ...(Array.isArray(payload?.resultado) ? payload.resultado : []),
        payload?.servidor,
        payload,
      ].filter(Boolean);

  for (const item of roots) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const uuidKey = Object.keys(item).find((key) => /^(uuid|guid)(servidor)?$/i.test(key));
    const looksLikeServer = Object.keys(item).some((key) => /^(cpf|matricula|nome)$/i.test(key));
    if (uuidKey && looksLikeServer && typeof item[uuidKey] === 'string' && item[uuidKey].trim()) {
      directCandidates.push(item[uuidKey].trim());
    }
  }

  if (directCandidates.length) {
    return [...new Set(directCandidates)];
  }

  return [...new Set(collectUuidCandidates(payload))];
}

export async function findSantanaServerComplete({ baseUrl, token, uuidServidor, fetchImpl = fetch }) {
  if (!String(uuidServidor || '').trim()) {
    throw createApiError('SANTANA_SERVER_UUID_MISSING', 'A busca preliminar não retornou o identificador do servidor.');
  }
  return requestJson(
    `${normalizeSantanaApiBaseUrl(baseUrl)}/Servidor/buscar-completo-api?uuidServidor=${encodeURIComponent(uuidServidor)}`,
    { headers: { Authorization: authorizationHeader(token) } },
    fetchImpl
  );
}

function collectFirstString(value, matchers = []) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = collectFirstString(item, matchers);
      if (found) return found;
    }
    return '';
  }
  if (!value || typeof value !== 'object') {
    return '';
  }
  for (const [key, item] of Object.entries(value)) {
    if (matchers.some((matcher) => matcher.test(key)) && item !== null && item !== undefined && typeof item !== 'object') {
      const text = String(item).trim();
      if (text) return text;
    }
  }
  for (const item of Object.values(value)) {
    if (item && typeof item === 'object') {
      const found = collectFirstString(item, matchers);
      if (found) return found;
    }
  }
  return '';
}

function parseNumericValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = String(value ?? '').trim();
  if (!text) return null;
  const normalized = text
    .replace(/[^\d,.-]/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function collectMargins(value, path = [], output = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectMargins(item, [...path, String(index)], output));
    return output;
  }
  if (!value || typeof value !== 'object') {
    return output;
  }
  for (const [key, item] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (/^margens?$/i.test(key) && Array.isArray(item)) {
      item.forEach((margin, index) => {
        if (!margin || typeof margin !== 'object') return;
        const amount = parseNumericValue(margin.valor ?? margin.value ?? margin.margem);
        const serviceName =
          margin.servico?.nome ||
          margin.servico?.nomeFolha ||
          margin.nomeServico ||
          margin.nome ||
          margin.descricao ||
          key;
        if (amount !== null) {
          output.push({
            key: String(serviceName || key),
            path: [...nextPath, String(index), String(serviceName || 'valor')].join('.'),
            value: amount,
          });
        }
      });
    }
    if (/margem/i.test(key) && (typeof item === 'number' || typeof item === 'string')) {
      const amount = parseNumericValue(item);
      if (amount !== null) {
        output.push({ key, path: nextPath.join('.'), value: amount });
      }
    }
    if (item && typeof item === 'object') {
      collectMargins(item, nextPath, output);
    }
  }
  return output;
}

export function extractSantanaMargins(payload) {
  return collectMargins(payload);
}

function marginValueByTerms(margins, includeTerms = [], excludeTerms = []) {
  const normalizedInclude = includeTerms.map((term) => String(term).toLowerCase());
  const normalizedExclude = excludeTerms.map((term) => String(term).toLowerCase());
  const found = margins.find((margin) => {
    const text = `${margin.key || ''} ${margin.path || ''}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return normalizedInclude.every((term) => text.includes(term)) && !normalizedExclude.some((term) => text.includes(term));
  });
  return found ? found.value : null;
}

function summarizeSantanaServer(payload, margins = []) {
  return {
    nome: collectFirstString(payload, [/^nome$/i, /nome.*servidor/i, /nome.*cliente/i]),
    matricula: collectFirstString(payload, [/matricula/i]),
    secretaria: collectFirstString(payload, [/secretaria/i, /orgao/i, /lotacao/i]),
    vinculo: collectFirstString(payload, [/vinculo/i, /cargo/i, /situacao/i]),
    situacao: collectFirstString(payload, [/situacao/i, /status/i]),
    data_nascimento: collectFirstString(payload, [/nascimento/i, /data.*nasc/i]),
    margem_consignado:
      marginValueByTerms(margins, ['consign']) ??
      marginValueByTerms(margins, ['facultativa']) ??
      marginValueByTerms(margins, ['disponivel'], ['cartao']),
    margem_cartao: marginValueByTerms(margins, ['cartao'], ['beneficio']),
    margem_cartao_beneficio:
      marginValueByTerms(margins, ['cartao', 'beneficio', 'saque']) ??
      marginValueByTerms(margins, ['cartao', 'beneficio']),
  };
}

export async function querySantanaCpfWithToken({
  baseUrl,
  token,
  cpf,
  fetchImpl = fetch,
}) {
  const preliminary = await findSantanaServerPreliminary({
    baseUrl,
    token,
    cpf,
    fetchImpl,
  });
  const uuids = extractSantanaServerUuids(preliminary);
  if (!uuids.length) {
    return {
      status: 'nao_encontrado',
      cpf: digits(cpf).padStart(11, '0'),
      preliminary,
      servidores: [],
      margins: [],
    };
  }
  const servidores = [];
  for (const uuidServidor of uuids) {
    const complete = await findSantanaServerComplete({
      baseUrl,
      token,
      uuidServidor,
      fetchImpl,
    });
    servidores.push({ uuid_servidor: uuidServidor, data: complete });
  }
  const margins = servidores.flatMap((item) => extractSantanaMargins(item.data));
  const summary = summarizeSantanaServer(servidores[0]?.data || {}, margins);
  return {
    status: 'sucesso',
    cpf: digits(cpf).padStart(11, '0'),
    preliminary,
    servidores,
    margins,
    ...summary,
  };
}

export async function querySantanaCpf({
  apiBaseUrl,
  login,
  password,
  cpf,
  fetchImpl = fetch,
}) {
  const authenticated = await authenticateSantanaApi({ apiBaseUrl, login, password, fetchImpl });
  return querySantanaCpfWithToken({
    baseUrl: authenticated.baseUrl,
    token: authenticated.token,
    cpf,
    fetchImpl,
  });
}

export async function testSantanaApiCredential({ apiBaseUrl, login, password, fetchImpl = fetch }) {
  await authenticateSantanaApi({ apiBaseUrl, login, password, fetchImpl });
  return { ok: true };
}
