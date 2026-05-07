import { Navigate, Route, Routes } from 'react-router-dom';

import { Shell } from './components/Shell';
import { ProtectedRoute } from './components/ProtectedRoute';
import { RoleGuard } from './components/RoleGuard';
import DashboardPage from './pages/DashboardPage';
import CampaignsPage from './pages/CampaignsPage';
import CampaignDetailPage from './pages/CampaignDetailPage';
import UploadPage from './pages/UploadPage';
import BasesPage from './pages/BasesPage';
import QueuePage from './pages/QueuePage';
import AttendancePage from './pages/AttendancePage';
import ReportsPage from './pages/ReportsPage';
import WhatsAppPage from './pages/WhatsAppPage';
import SettingsPage from './pages/SettingsPage';
import RibeiraoPage from './pages/RibeiraoPage';
import PhoneLookupPage from './pages/PhoneLookupPage';
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
          <Route path="/campanhas" element={<CampaignsPage />} />
          <Route path="/campanhas/:id" element={<CampaignDetailPage />} />
          <Route path="/fila" element={<QueuePage />} />
          <Route path="/atendimento" element={<AttendancePage />} />
          <Route path="/whatsapp" element={<WhatsAppPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/bases" element={<BasesPage />} />
          <Route path="/relatorios" element={<ReportsPage />} />
          <Route path="/consulta-ribeirao" element={<RibeiraoPage />} />
          <Route path="/consulta-telefones" element={<PhoneLookupPage />} />
          <Route path="/configuracoes" element={<SettingsPage />} />

          <Route element={<RoleGuard allowedRoles={['gerencial']} />}>
            <Route path="/usuarios" element={<UsersPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
