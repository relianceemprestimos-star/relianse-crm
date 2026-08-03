import { useEffect, useMemo, useState } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  Database,
  Files,
  Home,
  KeyRound,
  Landmark,
  LayoutDashboard,
  LogOut,
  Megaphone,
  MessagesSquare,
  MoonStar,
  PhoneCall,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  SunMedium,
  Target,
  Upload,
  Users,
} from 'lucide-react';

import { Badge, Button, Card } from './ui';
import { ACCESS_SESSION_CHANGED_EVENT, getAccessSession, roleLabel } from '../lib/session';
import { useAuth } from './AuthProvider';
import { useTheme } from './ThemeProvider';

type NavItem = {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  allowedRoles?: Array<'gerencial' | 'vendedor'>;
};

const navItems: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: Home, allowedRoles: ['gerencial', 'vendedor'] },
  { to: '/esteira-inteligente', label: 'Esteira Inteligente', icon: SlidersHorizontal, allowedRoles: ['gerencial', 'vendedor'] },
  { to: '/bases', label: 'Base & Margem', icon: Database, allowedRoles: ['gerencial'] },
  { to: '/upload', label: 'Importar Listas', icon: Upload, allowedRoles: ['gerencial'] },
  { to: '/consulta-ribeirao', label: 'Consulta de Margem', icon: Landmark, allowedRoles: ['gerencial'] },
  { to: '/credenciais', label: 'Credenciais', icon: KeyRound, allowedRoles: ['gerencial'] },
  { to: '/consulta-telefones', label: 'Busca de Telefones', icon: PhoneCall, allowedRoles: ['gerencial'] },
  { to: '/fila', label: 'Fila de Clientes', icon: Users, allowedRoles: ['gerencial', 'vendedor'] },
  { to: '/atendimento', label: 'Atendimentos', icon: ClipboardList, allowedRoles: ['gerencial', 'vendedor'] },
  { to: '/campanhas/coeficiente', label: 'Regras & Coeficientes', icon: SlidersHorizontal, allowedRoles: ['gerencial'] },
  { to: '/campanhas/oportunidades', label: 'Oportunidades', icon: Target, allowedRoles: ['gerencial', 'vendedor'] },
  { to: '/campanhas/disparos', label: 'Campanhas', icon: Megaphone, allowedRoles: ['gerencial', 'vendedor'] },
  { to: '/campanhas/mpsp-julho', label: 'MPSP Julho', icon: ShieldCheck, allowedRoles: ['gerencial', 'vendedor'] },
  { to: '/whatsapp', label: 'WhatsApp', icon: MessagesSquare, allowedRoles: ['gerencial', 'vendedor'] },
  { to: '/documentos', label: 'Documentos', icon: Files, allowedRoles: ['gerencial', 'vendedor'] },
  { to: '/relatorios', label: 'Relatórios', icon: LayoutDashboard, allowedRoles: ['gerencial'] },
  { to: '/configuracoes', label: 'Configurações', icon: Settings, allowedRoles: ['gerencial'] },
];

const pageTitles: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/esteira-inteligente': 'Esteira Inteligente',
  '/campanhas': 'Campanhas',
  '/campanhas/': 'Campanhas',
  '/campanhas/coeficiente': 'Regras & Coeficientes',
  '/campanhas/oportunidades': 'Oportunidades',
  '/campanhas/disparos': 'Campanhas',
  '/campanhas/mpsp-julho': 'MPSP Julho',
  '/documentos': 'Documentos',
  '/upload': 'Upload de Listas',
  '/bases': 'Base & Margem',
  '/fila': 'Fila de Clientes',
  '/atendimento': 'Atendimento',
  '/relatorios': 'Relatórios',
  '/whatsapp': 'WhatsApp & Documentos',
  '/consulta-ribeirao': 'Consulta de Margem',
  '/credenciais': 'Credenciais dos Portais',
  '/consulta-telefones': 'Busca de Telefones',
  '/usuarios': 'Usuários',
  '/configuracoes': 'Configurações',
};

function getPathKey(pathname: string) {
  const sorted = [...navItems].sort((a, b) => b.to.length - a.to.length);
  const exact = sorted.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
  if (exact) return exact.to;
  if (pathname.startsWith('/campanhas/nova')) return '/campanhas/disparos';
  if (pathname.startsWith('/campanhas/disparo/')) return '/campanhas/disparos';
  if (pathname.startsWith('/campanhas/')) return '/campanhas/disparos';
  return '/dashboard';
}

export function Shell() {
  const [collapsed, setCollapsed] = useState(false);
  const [accessSession, setAccessSession] = useState(() => getAccessSession());
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
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
  const activeCampaignLabel = 'MPSP Julho 2026';

  return (
    <div className="min-h-screen bg-bg text-slate-100">
      <aside
        className={`fixed inset-y-0 left-0 z-40 hidden border-r border-border bg-panel/95 backdrop-blur-xl transition-all duration-300 lg:flex ${
          collapsed ? 'w-20' : 'w-64'
        }`}
      >
        <div className="flex w-full flex-col">
          <div className="flex items-center gap-3 border-b border-white/5 px-5 py-6">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-accent/40 bg-blue-500/10 text-accent shadow-[0_0_35px_rgba(59,130,246,.22)]">
              <span className="text-xl font-black">R</span>
            </div>
            {!collapsed ? (
              <div>
                <h1 className="text-xl font-black tracking-tight text-white">RELIANCE <span className="text-info">CRM</span></h1>
              </div>
            ) : null}
          </div>

          <nav className="flex-1 space-y-2 overflow-y-auto px-3 py-5">
            {visibleNavItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    [
                      'group flex items-center gap-3 rounded-xl border px-4 py-3 text-sm font-semibold transition-all duration-200',
                      isActive
                        ? 'border-info/30 bg-info/25 text-white shadow-[0_0_30px_rgba(59,130,246,.12)]'
                        : 'border-transparent text-slate-400 hover:border-border hover:bg-white/5 hover:text-slate-100',
                    ].join(' ')
                  }
                >
                  <Icon size={19} className="shrink-0" />
                  {!collapsed ? <span>{item.label}</span> : null}
                </NavLink>
              );
            })}
          </nav>

          <div className="border-t border-white/5 p-4">
            <Card className="border-white/5 bg-white/3 p-4">
              {!collapsed ? (
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-slate-700 font-bold text-white">{initials || 'AO'}</div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-white">Área Operacional</p>
                      <p className="truncate text-xs text-slate-500">{activeUser.login || activeUser.name}</p>
                    </div>
                    <ChevronDown size={15} className="ml-auto text-slate-500" />
                  </div>
                  <div className="rounded-2xl border border-border bg-bg/60 p-1">
                    <div className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Aparência</div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setTheme('dark')}
                        className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition ${
                          theme === 'dark'
                            ? 'bg-panelAlt text-white shadow-sm'
                            : 'text-slate-400 hover:bg-white/5 hover:text-white'
                        }`}
                      >
                        <MoonStar size={16} />
                        Escuro
                      </button>
                      <button
                        type="button"
                        onClick={() => setTheme('light')}
                        className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition ${
                          theme === 'light'
                            ? 'bg-panelAlt text-white shadow-sm'
                            : 'text-slate-400 hover:bg-white/5 hover:text-white'
                        }`}
                      >
                        <SunMedium size={16} />
                        Claro
                      </button>
                    </div>
                  </div>
                </div>
              ) : <Badge tone="accent">On</Badge>}
            </Card>

            <Button variant="secondary" className="mt-4 w-full justify-center" onClick={() => setCollapsed((value) => !value)}>
              {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              {!collapsed ? 'Recolher menu' : null}
            </Button>
          </div>
        </div>
      </aside>

      <div className={collapsed ? 'min-h-screen transition-all duration-300 lg:pl-20' : 'min-h-screen transition-all duration-300 lg:pl-64'}>
        <header className="sticky top-0 z-30 border-b border-border bg-bg/82 px-6 py-4 backdrop-blur-xl">
          <div className="flex flex-col gap-4 2xl:flex-row 2xl:items-center 2xl:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-3 lg:flex-row lg:items-center">
              <div className="relative w-full max-w-xl">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" size={20} />
                <input
                  className="w-full rounded-xl border border-border bg-panel/80 py-3 pl-12 pr-16 text-sm text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-info/60 focus:ring-2 focus:ring-info/10"
                  placeholder="Buscar por CPF, nome, telefone ou protocolo..."
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg bg-white/8 px-2 py-1 text-xs font-semibold text-slate-300">⌘ K</span>
              </div>
              <button
                className="flex min-w-[280px] items-center justify-between gap-4 rounded-xl border border-border bg-panel/80 px-4 py-3 text-left transition hover:border-info/40"
                onClick={() => navigate('/campanhas/mpsp-julho')}
              >
                <div className="flex items-center gap-3">
                  <Megaphone size={20} className="text-slate-300" />
                  <div>
                    <p className="text-xs text-slate-500">Campanha ativa</p>
                    <p className="text-sm font-semibold text-white">{activeCampaignLabel}</p>
                  </div>
                </div>
                <ChevronDown size={16} className="text-slate-400" />
              </button>
            </div>

            <div className="flex items-center justify-between gap-3 2xl:justify-end">
              <div className="2xl:hidden">
                <p className="text-sm text-slate-500">Reliance CRM</p>
                <h2 className="text-xl font-bold tracking-tight text-white">{pageTitle}</h2>
              </div>
              <button className="relative rounded-xl border border-border bg-panel px-3 py-3 text-slate-300 transition hover:bg-white/5">
                <Bell size={18} />
                <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-info text-[10px] font-bold text-white">3</span>
              </button>
              <button className="rounded-xl border border-border bg-panel px-3 py-3 text-slate-300 transition hover:bg-white/5">
                <CircleHelp size={18} />
              </button>

              <div className="hidden items-center gap-3 rounded-xl border border-border bg-panel px-4 py-2 md:flex">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-700 font-bold text-white">
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
                className="rounded-xl px-4 py-3"
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

        <main className="px-4 py-6 lg:px-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
