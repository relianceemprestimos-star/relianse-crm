import rateLimit from 'express-rate-limit';

function standardHandler(_req, res) {
  return res.status(429).json({
    code: 'RATE_LIMITED',
    message: 'Muitas tentativas em pouco tempo. Aguarde e tente novamente.',
  });
}

const loginAttempts = new Map();

export function assertLoginRateLimit(login) {
  const key = String(login || '').trim().toLowerCase() || 'unknown';
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const limit = Number(process.env.RATE_LIMIT_LOGIN_PER_15_MIN || 5);
  const current = loginAttempts.get(key) || { count: 0, resetAt: now + windowMs };

  if (current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }

  if (current.count >= limit) {
    throw new Error('Muitas tentativas de login. Aguarde antes de tentar novamente.');
  }

  current.count += 1;
  loginAttempts.set(key, current);
}

export const globalRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_GLOBAL_PER_MINUTE || 300),
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
});

export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_LOGIN_PER_15_MIN || 5),
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
});

export const communicationRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_COMMUNICATION_PER_MINUTE || 30),
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
});

export const sensitiveLookupRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_LOOKUP_PER_MINUTE || 60),
  standardHeaders: true,
  legacyHeaders: false,
  handler: standardHandler,
});
