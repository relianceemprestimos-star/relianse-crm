export type AccessRole = 'gerencial' | 'vendedor' | 'admin';

export interface AccessSession {
  id?: number;
  name: string;
  login?: string;
  role: AccessRole;
  is_active?: boolean;
  last_login_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface AuthSession {
  token: string;
  user: AccessSession;
}

const TOKEN_KEY = 'relianse.auth.token';
const USER_KEY = 'relianse.auth.user';
export const ACCESS_SESSION_CHANGED_EVENT = 'relianse-access-session-changed';

const DEFAULT_SESSION: AccessSession = {
  name: 'Visitante',
  login: '',
  role: 'vendedor',
  is_active: false,
};

function readJson<T>(key: string): T | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function getAuthToken() {
  if (typeof window === 'undefined') {
    return '';
  }
  return window.localStorage.getItem(TOKEN_KEY) || '';
}

export function getAuthUser(): AccessSession | null {
  const user = readJson<AccessSession>(USER_KEY);
  if (!user) {
    return null;
  }

  return {
    ...DEFAULT_SESSION,
    ...user,
    name: typeof user.name === 'string' && user.name.trim() ? user.name.trim() : DEFAULT_SESSION.name,
    login: typeof user.login === 'string' ? user.login : '',
    role: user.role === 'gerencial' || user.role === 'vendedor' || user.role === 'admin' ? user.role : DEFAULT_SESSION.role,
    is_active: user.is_active !== false,
  };
}

export function getAccessSession(): AccessSession {
  return getAuthUser() || DEFAULT_SESSION;
}

export function setAuthSession(session: AuthSession) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(TOKEN_KEY, session.token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(session.user));
  window.dispatchEvent(new Event(ACCESS_SESSION_CHANGED_EVENT));
}

export function updateAuthUser(user: Partial<AccessSession>) {
  if (typeof window === 'undefined') {
    return;
  }

  const current = getAuthUser() || DEFAULT_SESSION;
  const next: AccessSession = {
    ...current,
    ...user,
    name: user.name && user.name.trim() ? user.name.trim() : current.name,
    login: user.login !== undefined ? user.login : current.login,
    role: user.role === 'gerencial' || user.role === 'vendedor' || user.role === 'admin' ? user.role : current.role,
    is_active: user.is_active !== undefined ? user.is_active : current.is_active,
  };
  window.localStorage.setItem(USER_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(ACCESS_SESSION_CHANGED_EVENT));
}

export function clearAuthSession() {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
  window.dispatchEvent(new Event(ACCESS_SESSION_CHANGED_EVENT));
}

export function setAccessSession(session: Partial<AccessSession>) {
  updateAuthUser(session);
}

export function canAccessRibeirao(role?: string) {
  return role === 'gerencial' || role === 'admin' || role === 'vendedor';
}

export function roleLabel(role?: string) {
  if (role === 'gerencial' || role === 'admin') return 'Gerencial';
  if (role === 'vendedor') return 'Vendedor';
  return 'Visitante';
}
