import { Navigate, Outlet } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';

import { useAuth } from './AuthProvider';
import { Card } from './ui';
import type { AccessRole } from '../lib/session';

export function RoleGuard({ allowedRoles = ['gerencial'] }: { allowedRoles?: AccessRole[] }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <Card className="mx-auto max-w-2xl p-8">
        <div className="flex items-center justify-center py-10 text-sm text-slate-400">Validando permissao...</div>
      </Card>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const normalizedRole = user.role === 'admin' ? 'gerencial' : user.role;
  if (!allowedRoles.includes(normalizedRole as 'gerencial' | 'vendedor')) {
    return (
      <Card className="mx-auto max-w-2xl p-8">
        <div className="flex items-start gap-4">
          <div className="rounded-2xl border border-danger/20 bg-danger/10 p-3 text-danger">
            <ShieldAlert size={22} />
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Acesso restrito</p>
            <h3 className="mt-2 text-2xl font-bold text-white">Acesso restrito ao perfil gerencial.</h3>
            <p className="mt-3 max-w-xl text-sm text-slate-400">
              Esta área fica disponível apenas para usuários gerenciais do Relianse CRM.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return <Outlet />;
}
