import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { LockKeyhole, LogIn, Sparkles } from 'lucide-react';
import toast from 'react-hot-toast';

import { useAuth } from '../components/AuthProvider';
import { Badge, Button, Card, Input } from '../components/ui';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, user, loading } = useAuth();
  const [loginValue, setLoginValue] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) {
      navigate('/dashboard', { replace: true });
    }
  }, [navigate, user]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-4">
        <Card className="w-full max-w-md p-8 text-center">
          <p className="text-sm uppercase tracking-[0.24em] text-slate-500">Reliance CRM</p>
          <h1 className="mt-3 text-2xl font-bold text-white">Carregando acesso</h1>
          <p className="mt-2 text-sm text-slate-400">Verificando sua sessao segura...</p>
        </Card>
      </div>
    );
  }

  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!loginValue.trim() || !password.trim()) {
      toast.error('Informe login e senha.');
      return;
    }

    try {
      setSubmitting(true);
      await login(loginValue.trim(), password);
      const target = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname || '/dashboard';
      navigate(target, { replace: true });
      toast.success('Bem-vindo ao Reliance CRM.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao entrar no sistema.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-bg px-4">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(0,209,193,0.14),_transparent_36%),linear-gradient(180deg,#050B12_0%,#071018_100%)]" />
      <div className="absolute -left-24 top-16 h-72 w-72 rounded-full bg-accent/10 blur-3xl" />
      <div className="absolute -right-24 bottom-8 h-80 w-80 rounded-full bg-blue-500/10 blur-3xl" />

      <Card className="relative z-10 w-full max-w-md border-border/80 bg-[#0B1520]/95 p-8 shadow-[0_0_50px_rgba(0,0,0,.35)] backdrop-blur-xl">
        <div className="mb-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-3xl bg-gradient-to-br from-accent to-cyan-400 text-slate-950 shadow-[0_0_35px_rgba(0,209,193,.3)]">
            <Sparkles size={22} strokeWidth={2.5} />
          </div>
          <p className="mt-4 text-xs uppercase tracking-[0.3em] text-slate-500">Reliance CRM</p>
          <h1 className="mt-2 text-3xl font-bold text-white">Entrar no sistema</h1>
          <p className="mt-2 text-sm text-slate-400">Acesse sua Ã¡rea de atendimento</p>
        </div>

        <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <label className="block text-sm text-slate-300">
            Login
            <Input className="mt-2" value={loginValue} onChange={(event) => setLoginValue(event.target.value)} placeholder="Digite seu login" autoComplete="username" />
          </label>
          <label className="block text-sm text-slate-300">
            Senha
            <Input className="mt-2" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Digite sua senha" autoComplete="current-password" />
          </label>

          <Button className="mt-4 w-full py-4 text-base" type="submit" disabled={submitting}>
            <LogIn size={18} />
            {submitting ? 'Entrando...' : 'Entrar'}
          </Button>
        </form>

        <div className="mt-6 flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg/70 px-4 py-3 text-sm text-slate-300">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-accent/20 bg-accent/10 p-2 text-accent">
              <LockKeyhole size={16} />
            </div>
            <div>
              <p className="font-semibold text-white">Acesso protegido</p>
              <p className="text-xs text-slate-500">UsuÃ¡rios ativos com senha hash.</p>
            </div>
          </div>
          <Badge tone="accent">Seguro</Badge>
        </div>
      </Card>
    </div>
  );
}

