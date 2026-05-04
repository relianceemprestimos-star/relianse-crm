import { getUserById, getUserByLogin, recordUserLogin } from './db.js';
import { signAuthToken, verifyAuthToken, verifyPassword } from './security.js';

function normalizeRole(role) {
  const text = String(role || '').toLowerCase();
  if (text === 'admin' || text === 'gerencial') {
    return 'gerencial';
  }
  return 'vendedor';
}

function publicUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: Number(user.id),
    name: user.name || '',
    login: user.login || user.email || '',
    role: normalizeRole(user.role),
    is_active: Number(user.is_active ?? 1) === 1,
    last_login_at: user.last_login_at || null,
    created_at: user.created_at || '',
    updated_at: user.updated_at || user.created_at || '',
  };
}

export function loginWithCredentials({ login, password }) {
  const user = getUserByLogin(login);
  if (!user) {
    throw new Error('Login ou senha inválidos.');
  }

  if (Number(user.is_active ?? 1) !== 1) {
    throw new Error('Usuário inativo. Fale com o gerencial.');
  }

  if (!verifyPassword(password, user.password_hash)) {
    throw new Error('Login ou senha inválidos.');
  }

  recordUserLogin(user.id);
  const refreshed = getUserById(user.id) || user;

  const payload = {
    sub: String(refreshed.id),
    role: normalizeRole(refreshed.role),
    name: refreshed.name || '',
    login: refreshed.login || refreshed.email || '',
  };

  return {
    token: signAuthToken(payload),
    user: publicUser({ ...refreshed, role: normalizeRole(refreshed.role) }),
  };
}

export function authMiddleware(req, res, next) {
  const header = String(req.get('authorization') || '').trim();
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({ message: 'Faça login para continuar.' });
  }

  try {
    const payload = verifyAuthToken(token);
    const userId = Number(payload?.sub || payload?.user_id || 0);
    if (!userId) {
      return res.status(401).json({ message: 'Sessão inválida. Faça login novamente.' });
    }

    const user = getUserById(userId);
    if (!user || Number(user.is_active ?? 1) !== 1) {
      return res.status(401).json({ message: 'Usuário inativo. Fale com o gerencial.' });
    }

    req.user = publicUser(user);
    req.auth = payload;
    return next();
  } catch {
    return res.status(401).json({ message: 'Sessão expirada. Faça login novamente.' });
  }
}

export function roleMiddleware(roles = []) {
  const allowed = new Set((roles || []).map((role) => normalizeRole(role)));
  return (req, res, next) => {
    const role = normalizeRole(req.user?.role);
    if (allowed.size && !allowed.has(role)) {
      return res.status(403).json({ message: 'Acesso restrito ao perfil gerencial.' });
    }
    return next();
  };
}

export function getAuthUser(req) {
  return req.user || null;
}
