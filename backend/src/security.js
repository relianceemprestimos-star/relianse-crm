import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const DEFAULT_JWT_SECRET = 'relianse-crm-dev-secret';
const warned = new Set();

export function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || '').trim();
  if (secret) {
    return secret;
  }

  if (!warned.has('jwt')) {
    warned.add('jwt');
    console.warn('JWT_SECRET nao configurado. Usando segredo de desenvolvimento apenas para o MVP.');
  }

  return DEFAULT_JWT_SECRET;
}

export function getTokenExpiresIn() {
  return String(process.env.TOKEN_EXPIRES_IN || '8h').trim() || '8h';
}

export function getBcryptSaltRounds() {
  const parsed = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 10;
}

export function hashPassword(password) {
  return bcrypt.hashSync(String(password ?? ''), getBcryptSaltRounds());
}

export function verifyPassword(password, passwordHash) {
  if (!passwordHash) {
    return false;
  }
  return bcrypt.compareSync(String(password ?? ''), String(passwordHash));
}

export function signAuthToken(payload) {
  return jwt.sign(payload, getJwtSecret(), {
    expiresIn: getTokenExpiresIn(),
  });
}

export function verifyAuthToken(token) {
  return jwt.verify(token, getJwtSecret());
}
