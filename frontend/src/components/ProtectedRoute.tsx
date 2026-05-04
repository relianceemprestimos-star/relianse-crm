import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from './AuthProvider';
import { Card } from './ui';

export function ProtectedRoute() {
  const { loading, isAuthenticated } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg px-4">
        <Card className="w-full max-w-md p-8 text-center">
          <p className="text-sm uppercase tracking-[0.24em] text-slate-500">Autenticando</p>
          <h3 className="mt-3 text-2xl font-bold text-white">Carregando sessao segura</h3>
          <p className="mt-2 text-sm text-slate-400">Verificando acesso ao Relianse CRM...</p>
        </Card>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}

