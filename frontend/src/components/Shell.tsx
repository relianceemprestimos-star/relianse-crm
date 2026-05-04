import { useEffect, useMemo, useState } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Files,
  Landmark,
  LayoutDashboard,
  Layers3,
  LogOut,
  MessagesSquare,
  Settings,
  Users,
  Zap,
} from 'lucide-react';

import { Badge, Button, Card } from './ui';
import { ACCESS_SESSION_CHANGED_EVENT, getAccessSession, roleLabel } from '../lib/session';
import { useAuth } from './AuthProvider';

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  allowedRoles?: Array<'gerencial' | 'vendedor'>;
};

const navItems: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, allowedRoles: ['gerencial', 'vendedor'] },
  { to: '/upload', label: 'Upload de Listas', icon: Files, allowedRoles: ['gerencial'] },
  { to: '/bases', label: 'Bases', icon: Layers3, allowedRoles: ['gerencial'] },
  { to: '/fila', label: 'Fila de Clientes', icon: Users, allowedRoles: ['gerencial', 'vendedor'] },
  { to: '/atendimento', label: 'Atendimentos', icon: ClipboardList, allowedRoles: ['gerencial', 'vendedor'] },
  { to: '/relatorios', label: 'Relatorios', icon: Zap, allowedRoles: ['gerencial'] },
  { to: '/whatsapp', label: 'WhatsApp Web', icon: MessagesSquare, allowedRoles: ['gerencial', 'vendedor'] },
  { to: '/consulta-ribeirao', label: 'Consulta Ribeirão', icon: Landmark, allowedRoles: ['gerencial'] },
  { to: '/usuarios', label: 'Usuários', icon: Users, allowedRoles: ['gerencial'] },
  { to: '/configuracoes', label: 'Configurações', icon: Settings, allowedRoles: ['gerencial'] },
];

const pageTitles: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/upload': 'Upload de Listas',
  '/bases': 'Bases',
  '/fila': 'Fila de Clientes',
  '/atendimento': 'Atendimento',
  '/relatorios': 'Relatorios e acompanhamento',
  '/whatsapp': 'WhatsApp Web',
  '/consulta-ribeirao': 'Consulta Ribeirão',
  '/usuarios': 'Usuários',
  '/configuracoes': 'Configurações',
};

function getPathKey(pathname: string) {
  const exact = navItems.find((item) => pathname.startsWith(item.to));
  return exact?.to || '/dashboard';
}

export function Shell() {
  const [collapsed, setCollapsed] = useState(false);
  const [accessSession, setAccessSession] = useState(() => getAccessSession());
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const currentKey = useMemo(() => getPathKey(location.pathname), [location.pathname]);
  const pageTitle = pageTitles[currentKey] || 'Relianse CRM';

  useEffect(() => {
    const handleSessionChange = () => setAccessSession(getAccessSession());
    window.addEventListener(ACCESS_SESSION_CHANGED_EVENT, handleSessionChange);
    window.addEventListener('storage', handleSessionChange);
    return () => {
      window.removeEventListener(ACCESS_SESSION_CHANGED_EVENT, handleSessionChange);
      window.removeEventListener('storage', handleSessionChange);
    };
  }, []);

  const activeUser = user || accessSession;
  const normalizedRole = (activeUser.role === 'admin' ? 'gerencial' : activeUser.role) as 'gerencial' | 'vendedor';
  const visibleNavItems = navItems.filter((item) => !item.allowedRoles || item.allowedRoles.includes(normalizedRole));
  const initials = activeUser.name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] || '')
    .join('')
    .toUpperCase();

  return (
    <div className="min-h-screen bg-bg text-slate-100">
      <aside
        className={`fixed inset-y-0 left-0 z-40 hidden border-r border-border bg-[#07131D]/95 backdrop-blur-xl transition-all duration-300 lg:flex ${
          collapsed ? 'w-20' : 'w-72'
        }`}
      >
        <div className="flex w-full flex-col">
          <div className="flex items-center gap-3 border-b border-white/5 px-5 py-5">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-cyan-400 text-slate-950 shadow-[0_0_35px_rgba(0,209,193,.25)]">
              <Zap size={20} strokeWidth={2.6} />
            </div>
            {!collapsed ? (
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-slate-500">CRM premium</p>
                <h1 className="text-lg font-bold text-white">Relianse CRM</h1>
              </div>
            ) : null}
          </div>

          <nav className="flex-1 space-y-2 px-3 py-5">
            {visibleNavItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    [
                      'group flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-medium transition-all duration-200',
                      isActive
                        ? 'border-accent/20 bg-accent/12 text-white shadow-[0_0_30px_rgba(0,209,193,.10)]'
                        : 'border-transparent text-slate-400 hover:border-border hover:bg-white/5 hover:text-slate-100',
                    ].join(' ')
                  }
                >
                  <Icon size={18} className="shrink-0 text-accent" />
                  {!collapsed ? <span>{item.label}</span> : null}
                </NavLink>
              );
            })}
          </nav>

          <div className="border-t border-white/5 p-4">
            <Card className="border-white/5 bg-white/3 p-4">
              {!collapsed ? (
                <>
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Ambiente</p>
                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">Modo escuro ativo</p>
                      <p className="text-xs text-slate-500">Pronto para operação comercial.</p>
                    </div>
                    <Badge tone="accent">Online</Badge>
                  </div>
                </>
              ) : (
                <div className="flex justify-center">
                  <Badge tone="accent">On</Badge>
                </div>
              )}
            </Card>

            <Button variant="secondary" className="mt-4 w-full justify-center" onClick={() => setCollapsed((value) => !value)}>
              {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              {!collapsed ? 'Recolher menu' : null}
            </Button>
          </div>
        </div>
      </aside>

      <div className={collapsed ? 'min-h-screen transition-all duration-300 lg:pl-20' : 'min-h-screen transition-all duration-300 lg:pl-72'}>
        <header className="sticky top-0 z-30 border-b border-border bg-bg/80 px-6 py-4 backdrop-blur-xl">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-sm text-slate-500">Relianse CRM</p>
              <h2 className="text-2xl font-bold tracking-tight text-white">{pageTitle}</h2>
            </div>

            <div className="flex items-center gap-3">
              <button className="rounded-2xl border border-border bg-panel px-3 py-3 text-slate-300 transition hover:bg-white/5">
                <Bell size={18} />
              </button>
              <button className="rounded-2xl border border-border bg-panel px-3 py-3 text-slate-300 transition hover:bg-white/5">
                <CircleHelp size={18} />
              </button>

              <div className="flex items-center gap-3 rounded-2xl border border-border bg-panel px-4 py-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gradient-to-br from-accent to-blue-500 font-bold text-slate-950">
                  {initials || 'CA'}
                </div>
                <div className="leading-tight">
                  <p className="text-sm font-semibold text-white">{activeUser.name}</p>
                  <p className="text-xs text-slate-500">{roleLabel(activeUser.role)}</p>
                </div>
                <ChevronDown size={16} className="text-slate-500" />
              </div>

              <Button
                variant="secondary"
                className="px-4 py-3"
                onClick={() => {
                  void logout();
                  navigate('/login', { replace: true });
                }}
              >
                <LogOut size={16} />
                Sair
              </Button>
            </div>
          </div>
        </header>

        <main className="px-6 py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

