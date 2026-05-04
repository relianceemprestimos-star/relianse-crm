import { Navigate, Route, Routes } from 'react-router-dom';

import { Shell } from './components/Shell';
import { ProtectedRoute } from './components/ProtectedRoute';
import { RoleGuard } from './components/RoleGuard';
import DashboardPage from './pages/DashboardPage';
import UploadPage from './pages/UploadPage';
import BasesPage from './pages/BasesPage';
import QueuePage from './pages/QueuePage';
import AttendancePage from './pages/AttendancePage';
import ReportsPage from './pages/ReportsPage';
import WhatsAppPage from './pages/WhatsAppPage';
import SettingsPage from './pages/SettingsPage';
import RibeiraoPage from './pages/RibeiraoPage';
import UsersPage from './pages/UsersPage';
import LoginPage from './pages/LoginPage';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/fila" element={<QueuePage />} />
          <Route path="/atendimento" element={<AttendancePage />} />
          <Route path="/whatsapp" element={<WhatsAppPage />} />

          <Route element={<RoleGuard allowedRoles={['gerencial']} />}>
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/bases" element={<BasesPage />} />
            <Route path="/relatorios" element={<ReportsPage />} />
            <Route path="/consulta-ribeirao" element={<RibeiraoPage />} />
            <Route path="/usuarios" element={<UsersPage />} />
            <Route path="/configuracoes" element={<SettingsPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

