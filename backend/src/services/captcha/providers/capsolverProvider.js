export const CAPSOLVER_PROVIDER = 'CAPSOLVER';

const API_BASE_URL = 'https://api.capsolver.com';

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function capsolverPost(path, payload, timeoutMs = 30000) {
  const controller = timeoutSignal(timeoutMs);
  try {
    const response = await fetch(`${API_BASE_URL}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.errorDescription || `CapSolver HTTP ${response.status}`);
      error.code = data?.errorCode || 'CAPSOLVER_HTTP_ERROR';
      error.raw = data;
      throw error;
    }
    return data;
  } finally {
    controller.done();
  }
}

export async function getCapSolverBalance(apiKey, timeoutMs = 30000) {
  if (!String(apiKey || '').trim()) {
    const error = new Error('API Key CapSolver ausente.');
    error.code = 'CONFIG_MISSING';
    throw error;
  }
  const data = await capsolverPost('getBalance', { clientKey: String(apiKey).trim() }, timeoutMs);
  if (data.errorId) {
    const error = new Error(data.errorDescription || data.errorCode || 'Saldo CapSolver indisponível.');
    error.code = data.errorCode || 'BALANCE_UNAVAILABLE';
    error.raw = data;
    throw error;
  }
  return data;
}

export async function solveWithCapSolver(context = {}, config = {}) {
  const startedAt = Date.now();
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) {
    return {
      ok: false,
      provider: CAPSOLVER_PROVIDER,
      status: 'CONFIG_MISSING',
      code: 'CONFIG_MISSING',
      message: 'API Key CapSolver ausente.',
      durationMs: Date.now() - startedAt,
    };
  }

  const captchaType = String(context.captchaType || context.captcha_type || '').toLowerCase();
  const websiteURL = String(context.url || context.websiteURL || context.websiteUrl || '').trim();
  const siteKey = String(context.siteKey || context.site_key || context.websiteKey || '').trim();
  let task = context.task || null;

  if (!task && captchaType.includes('recaptcha')) {
    task = {
      type: config.taskType || 'ReCaptchaV2TaskProxyLess',
      websiteURL,
      websiteKey: siteKey,
      isInvisible: Boolean(context.isInvisible || context.invisible),
    };
  }

  if (!task && (captchaType.includes('image') || captchaType.includes('text'))) {
    const body = String(context.imageBase64 || context.body || '').trim();
    task = body ? { type: 'ImageToTextTask', body } : null;
  }

  if (!task) {
    return {
      ok: false,
      provider: CAPSOLVER_PROVIDER,
      status: 'EXTERNAL_PROVIDER_FAILED',
      code: 'CAPTCHA_TYPE_NOT_SUPPORTED',
      message: 'Tipo de CAPTCHA sem payload compatível para provider externo.',
      durationMs: Date.now() - startedAt,
    };
  }

  const timeoutMs = Number(config.timeoutMs || 120000);
  const pollIntervalMs = Number(config.pollIntervalMs || 3000);
  const created = await capsolverPost('createTask', { clientKey: apiKey, task }, Math.min(timeoutMs, 30000));
  if (created.errorId) {
    return {
      ok: false,
      provider: CAPSOLVER_PROVIDER,
      status: 'EXTERNAL_PROVIDER_FAILED',
      code: created.errorCode || 'PROVIDER_ERROR',
      message: created.errorDescription || 'Falha ao criar tarefa no provider externo.',
      rawProviderStatus: JSON.stringify({ errorCode: created.errorCode || '' }),
      durationMs: Date.now() - startedAt,
    };
  }

  const taskId = created.taskId || '';
  if (!taskId) {
    return {
      ok: false,
      provider: CAPSOLVER_PROVIDER,
      status: 'EXTERNAL_PROVIDER_FAILED',
      code: 'TASK_ID_MISSING',
      message: 'Provider externo não retornou taskId.',
      rawProviderStatus: JSON.stringify({ status: created.status || '' }),
      durationMs: Date.now() - startedAt,
    };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const result = await capsolverPost('getTaskResult', { clientKey: apiKey, taskId }, Math.min(timeoutMs, 30000));
    if (result.errorId) {
      return {
        ok: false,
        provider: CAPSOLVER_PROVIDER,
        status: 'EXTERNAL_PROVIDER_FAILED',
        taskId,
        code: result.errorCode || 'PROVIDER_ERROR',
        message: result.errorDescription || 'Provider externo retornou erro.',
        rawProviderStatus: JSON.stringify({ errorCode: result.errorCode || '', status: result.status || '' }),
        durationMs: Date.now() - startedAt,
      };
    }
    if (result.status === 'ready') {
      const solution = result.solution || {};
      const token = solution.gRecaptchaResponse || solution.token || solution.text || '';
      return {
        ok: Boolean(token),
        provider: CAPSOLVER_PROVIDER,
        status: token ? 'EXTERNAL_PROVIDER_SOLVED' : 'EXTERNAL_PROVIDER_FAILED',
        taskId,
        solution: token,
        rawSolution: solution,
        rawProviderStatus: JSON.stringify({ status: result.status }),
        durationMs: Date.now() - startedAt,
        costEstimated: Number(config.costEstimated || 0.002),
        message: token ? 'Provider externo resolveu o CAPTCHA.' : 'Provider externo retornou solução vazia.',
      };
    }
    if (result.status === 'failed') {
      return {
        ok: false,
        provider: CAPSOLVER_PROVIDER,
        status: 'EXTERNAL_PROVIDER_FAILED',
        taskId,
        code: 'PROVIDER_FAILED',
        message: 'Provider externo falhou na resolução.',
        rawProviderStatus: JSON.stringify({ status: result.status }),
        durationMs: Date.now() - startedAt,
      };
    }
  }

  return {
    ok: false,
    provider: CAPSOLVER_PROVIDER,
    status: 'EXTERNAL_PROVIDER_TIMEOUT',
    taskId,
    code: 'PROVIDER_TIMEOUT',
    message: 'Tempo limite aguardando provider externo.',
    durationMs: Date.now() - startedAt,
  };
}
