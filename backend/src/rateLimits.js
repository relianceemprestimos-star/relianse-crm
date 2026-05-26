function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clientKey(req) {
  return String(req.ip || req.get?.('x-forwarded-for') || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

export function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const key = clientKey(req);
    const current = hits.get(key);

    if (!current || current.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    current.count += 1;
    if (current.count > max) {
      const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ message, code: 'RATE_LIMITED' });
    }

    return next();
  };
}

export function assertRateLimit(bucket, key, { windowMs, max, message }) {
  const now = Date.now();
  const hitKey = `${bucket}:${String(key || 'unknown')}`;
  const limiter = createRateLimiter.__hits || new Map();
  createRateLimiter.__hits = limiter;
  const current = limiter.get(hitKey);

  if (!current || current.resetAt <= now) {
    limiter.set(hitKey, { count: 1, resetAt: now + windowMs });
    return;
  }

  current.count += 1;
  if (current.count > max) {
    const error = new Error(message);
    error.status = 429;
    error.code = 'RATE_LIMITED';
    throw error;
  }
}

export function assertLoginRateLimit(login) {
  assertRateLimit('login', String(login || '').trim().toLowerCase(), {
    windowMs: 15 * 60 * 1000,
    max: numberFromEnv('RATE_LIMIT_LOGIN_PER_15_MIN', 5),
    message: 'Muitas tentativas de login. Aguarde antes de tentar novamente.',
  });
}

export function assertCommunicationRateLimit(key) {
  assertRateLimit('communication', key, {
    windowMs: 60 * 1000,
    max: numberFromEnv('RATE_LIMIT_COMMUNICATION_PER_MINUTE', 30),
    message: 'Limite de comunicacao atingido. Aguarde antes de enviar novamente.',
  });
}

export const loginLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: numberFromEnv('RATE_LIMIT_LOGIN_PER_15_MIN', 5),
  message: 'Muitas tentativas de login. Aguarde antes de tentar novamente.',
});

export const communicationLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: numberFromEnv('RATE_LIMIT_COMMUNICATION_PER_MINUTE', 30),
  message: 'Limite de comunicacao atingido. Aguarde antes de enviar novamente.',
});

export const globalLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: numberFromEnv('RATE_LIMIT_GLOBAL_PER_MINUTE', 300),
  message: 'Muitas requisicoes. Aguarde antes de tentar novamente.',
});
