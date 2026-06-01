import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TRANSPARENT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function repoRoot() {
  return path.resolve(__dirname, '..', '..', '..');
}

export function getAutomationRegistryRoot() {
  return path.resolve(
    process.env.AUTOMATION_REGISTRY_PATH ||
      process.env.AUTOMATION_REGISTRY_ROOT ||
      path.join(repoRoot(), 'automation-registry')
  );
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeId(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function walkJsonFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walkJsonFiles(fullPath);
    }
    return entry.isFile() && entry.name.endsWith('.json') ? [fullPath] : [];
  });
}

function maskCpf(value = '') {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length !== 11) {
    return digits ? `${digits.slice(0, 3)}***${digits.slice(-2)}` : '';
  }
  return `${digits.slice(0, 3)}.***.***-${digits.slice(-2)}`;
}

function sanitizeForLog(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => {
        const normalizedKey = normalizeId(key);
        if (normalizedKey.includes('password') || normalizedKey.includes('senha') || normalizedKey.includes('token') || normalizedKey.includes('secret')) {
          return [key, '[redacted]'];
        }
        if (normalizedKey.includes('cpf')) {
          return [key, maskCpf(entryValue)];
        }
        return [key, sanitizeForLog(entryValue)];
      })
    );
  }
  if (typeof value === 'string' && /^\D*\d{11}\D*$/.test(value)) {
    return maskCpf(value);
  }
  return value;
}

function publicFlow(flow, filePath = '') {
  return {
    ...flow,
    registry_file: filePath ? path.relative(getAutomationRegistryRoot(), filePath) : flow.registry_file || '',
    registry_root: getAutomationRegistryRoot(),
  };
}

export function listAutomationFlows() {
  const root = getAutomationRegistryRoot();
  const files = walkJsonFiles(path.join(root, 'convenios'));
  return files
    .map((filePath) => {
      const flow = safeReadJson(filePath);
      return flow ? publicFlow(flow, filePath) : null;
    })
    .filter(Boolean)
    .sort((a, b) => String(a.convenio_nome || a.convenio_id).localeCompare(String(b.convenio_nome || b.convenio_id)));
}

export function getAutomationFlow(identifier = '') {
  const normalized = normalizeId(identifier);
  if (!normalized) {
    return null;
  }

  return (
    listAutomationFlows().find((flow) => {
      const candidates = [
        flow.convenio_id,
        flow.convenio_nome,
        flow.portal,
        flow.registry_file,
        ...(Array.isArray(flow.aliases) ? flow.aliases : []),
      ].map(normalizeId);
      return candidates.includes(normalized);
    }) || null
  );
}

export function getValidatedAutomationFlow(identifier = '') {
  const normalized = normalizeId(identifier);
  if (!normalized) {
    return null;
  }

  return (
    listAutomationFlows().find((flow) => {
      if (normalizeId(flow.status) !== 'validado') {
        return false;
      }
      const candidates = [
        flow.convenio_id,
        flow.convenio_nome,
        flow.portal,
        flow.registry_file,
        ...(Array.isArray(flow.aliases) ? flow.aliases : []),
      ].map(normalizeId);
      return candidates.includes(normalized);
    }) || null
  );
}

export function getAutomationRegistrySummary() {
  const flows = listAutomationFlows();
  const failures = listAutomationFailures();
  return {
    root: getAutomationRegistryRoot(),
    total: flows.length,
    validated: flows.filter((flow) => normalizeId(flow.status) === 'validado').length,
    candidate: flows.filter((flow) => normalizeId(flow.status) === 'candidato').length,
    flows: flows.map((flow) => ({
      convenio_id: flow.convenio_id,
      convenio_nome: flow.convenio_nome,
      portal: flow.portal,
      status: flow.status,
      ultima_validacao: flow.ultima_validacao,
      ultima_falha: failures.find((failure) => normalizeId(failure.convenio_id) === normalizeId(flow.convenio_id))?.created_at || '',
      login_url: flow.login_url,
      consulta_url: flow.consulta_url,
      fluxo_versao: flow.fluxo_versao,
      fluxo_ativo: flow.fluxo_ativo,
      registry_file: flow.registry_file,
    })),
    recent_failures: failures.slice(0, 20),
  };
}

export function resolveAutomationForPortal(portalId = '') {
  const normalizedPortalId = normalizeId(portalId || 'prefeitura_ribeirao_preto');
  return getValidatedAutomationFlow(normalizedPortalId);
}

export function applyAutomationFlowToPayload(payload = {}) {
  const flow = resolveAutomationForPortal(payload.portal_id || payload.portalId || payload.convenio_id);
  if (!flow) {
    return { payload, flow: null };
  }

  return {
    flow,
    payload: {
      ...payload,
      portal_id: flow.convenio_id || payload.portal_id,
      portal_url: flow.login_url || payload.portal_url,
      consulta_url: flow.consulta_url || payload.consulta_url || flow.login_url || payload.portal_url,
      automation_registry_flow: flow.registry_file,
      automation_registry_version: flow.fluxo_versao || '',
    },
  };
}

function ensureRunDirs() {
  const root = getAutomationRegistryRoot();
  const dirs = ['runs', 'runs/logs', 'runs/screenshots', 'runs/html-dumps'];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
}

function artifactBaseName({ convenioId, stage }) {
  const timestamp = nowIso().replace(/[:.]/g, '-');
  return `${timestamp}-${normalizeId(convenioId || 'convenio')}-${normalizeId(stage || 'falha')}`;
}

export function recordAutomationFailure({
  convenioId = '',
  portalId = '',
  stage = '',
  action = '',
  error = null,
  message = '',
  sessionId = null,
  raw = null,
  html = '',
  screenshot = null,
} = {}) {
  ensureRunDirs();
  const root = getAutomationRegistryRoot();
  const flow = resolveAutomationForPortal(convenioId || portalId);
  const resolvedConvenioId = flow?.convenio_id || convenioId || portalId || 'desconhecido';
  const createdAt = nowIso();
  const baseName = artifactBaseName({ convenioId: resolvedConvenioId, stage: stage || error?.stage || action || 'falha' });
  const logPath = path.join(root, 'runs', 'logs', `${baseName}.json`);
  const htmlPath = path.join(root, 'runs', 'html-dumps', `${baseName}.html`);
  const screenshotPath = path.join(root, 'runs', 'screenshots', `${baseName}.png`);
  const candidatePath = flow
    ? path.join(root, path.dirname(flow.registry_file), `${path.basename(flow.registry_file, '.json')}.${baseName}.candidate.json`)
    : '';

  const failure = {
    created_at: createdAt,
    convenio_id: resolvedConvenioId,
    convenio_nome: flow?.convenio_nome || '',
    portal: flow?.portal || '',
    action,
    stage: stage || error?.stage || raw?.stage || '',
    error_code: String(error?.code || raw?.code || raw?.error_code || '').toUpperCase(),
    message: message || error?.message || raw?.message || 'Falha tecnica na automacao.',
    session_id: sessionId,
    active_flow_version: flow?.fluxo_versao || '',
    active_flow_file: flow?.registry_file || '',
    log_file: path.relative(root, logPath),
    html_dump_file: path.relative(root, htmlPath),
    screenshot_file: path.relative(root, screenshotPath),
    candidate_version_file: candidatePath ? path.relative(root, candidatePath) : '',
    raw: sanitizeForLog(raw || {}),
  };

  const htmlContent =
    html ||
    `<!doctype html><html><head><meta charset="utf-8"><title>Automation failure</title></head><body><pre>${escapeHtml(
      JSON.stringify(failure, null, 2)
    )}</pre></body></html>`;

  fs.writeFileSync(htmlPath, htmlContent, 'utf-8');
  if (Buffer.isBuffer(screenshot)) {
    fs.writeFileSync(screenshotPath, screenshot);
  } else if (typeof screenshot === 'string' && screenshot.trim()) {
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'));
  } else {
    fs.writeFileSync(screenshotPath, Buffer.from(TRANSPARENT_PNG_BASE64, 'base64'));
  }
  fs.writeFileSync(logPath, JSON.stringify(failure, null, 2), 'utf-8');

  if (candidatePath && !fs.existsSync(candidatePath)) {
    const candidate = {
      ...flow,
      status: 'candidato',
      fluxo_base: flow.fluxo_versao || '',
      criado_em: createdAt,
      motivo: 'Criado automaticamente apos falha tecnica. Nao promover sem revalidacao.',
      falha_origem: path.relative(root, logPath),
    };
    fs.writeFileSync(candidatePath, JSON.stringify(candidate, null, 2), 'utf-8');
  }

  return failure;
}

export function listAutomationFailures() {
  const root = getAutomationRegistryRoot();
  const logsDir = path.join(root, 'runs', 'logs');
  if (!fs.existsSync(logsDir)) {
    return [];
  }

  return fs
    .readdirSync(logsDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => safeReadJson(path.join(logsDir, file)))
    .filter(Boolean)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

export function registerAutomationRevalidation({ convenioId = '', requestedBy = '', note = '' } = {}) {
  const failure = recordAutomationFailure({
    convenioId,
    action: 'revalidacao_solicitada',
    stage: 'painel_tecnico',
    message: note || 'Revalidacao solicitada pelo painel tecnico.',
    raw: { requested_by: requestedBy },
  });
  return {
    ok: true,
    message: 'Revalidacao registrada. Execute o fluxo e promova nova versao somente apos validar.',
    registry_event: failure,
  };
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
