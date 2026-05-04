import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api } from '../lib/api';
import {
  ACCESS_SESSION_CHANGED_EVENT,
  clearAuthSession,
  getAuthToken,
  getAuthUser,
  setAuthSession,
  type AccessSession,
} from '../lib/session';

type AuthContextValue = {
  user: AccessSession | null;
  loading: boolean;
  login: (login: string, password: string) => Promise<AccessSession>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<AccessSession | null>;
  isAuthenticated: boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AccessSession | null>(() => getAuthUser());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      const token = getAuthToken();
      if (!token) {
        if (active) {
          setUser(null);
          setLoading(false);
        }
        return;
      }

      try {
        const response = await api.getAuthMe();
        if (!active) {
          return;
        }
        setUser(response.user);
        setAuthSession({ token, user: response.user });
      } catch {
        clearAuthSession();
        if (active) {
          setUser(null);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void bootstrap();

    const handleSessionChange = () => {
      const current = getAuthUser();
      setUser(current);
      setLoading(false);
    };

    window.addEventListener(ACCESS_SESSION_CHANGED_EVENT, handleSessionChange);
    window.addEventListener('storage', handleSessionChange);

    return () => {
      active = false;
      window.removeEventListener(ACCESS_SESSION_CHANGED_EVENT, handleSessionChange);
      window.removeEventListener('storage', handleSessionChange);
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      isAuthenticated: Boolean(user),
      login: async (login, password) => {
        const response = await api.login({ login, password });
        setAuthSession(response);
        setUser(response.user);
        return response.user;
      },
      logout: async () => {
        try {
          await api.logout();
        } catch {
          // ignore logout errors
        } finally {
          clearAuthSession();
          setUser(null);
        }
      },
      refreshUser: async () => {
        const token = getAuthToken();
        if (!token) {
          clearAuthSession();
          setUser(null);
          return null;
        }

        const response = await api.getAuthMe();
        setUser(response.user);
        setAuthSession({ token, user: response.user });
        return response.user;
      },
    }),
    [loading, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider.');
  }
  return context;
}
