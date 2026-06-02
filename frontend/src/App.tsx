import { Navigate, Route, Routes } from 'react-router-dom';

import { Shell } from './components/Shell';
import { ProtectedRoute } from './components/ProtectedRoute';
import { RoleGuard } from './components/RoleGuard';
import DashboardPage from './pages/DashboardPage';
import CampaignsPage from './pages/CampaignsPage';
import CampaignDetailPage from './pages/CampaignDetailPage';
import CampaignOpportunitiesPage from './pages/CampaignOpportunitiesPage';
import CreateDispatchCampaignPage from './pages/CreateDispatchCampaignPage';
import CampaignPreviewPage from './pages/CampaignPreviewPage';
import CampaignDryRunPage from './pages/CampaignDryRunPage';
import CampaignDispatchPage from './pages/CampaignDispatchPage';
import CampaignTrackingPage from './pages/CampaignTrackingPage';
import UploadPage from './pages/UploadPage';
import BasesPage from './pages/BasesPage';
import QueuePage from './pages/QueuePage';
import AttendancePage from './pages/AttendancePage';
import ReportsPage from './pages/ReportsPage';
import WhatsAppPage from './pages/WhatsAppPage';
import WhatsAppApiPage from './pages/WhatsAppApiPage';
import SettingsPage from './pages/SettingsPage';
import RibeiraoPage from './pages/RibeiraoPage';
import PhoneLookupPage from './pages/PhoneLookupPage';
import CredentialsPage from './pages/CredentialsPage';
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
          <Route path="/campanhas/oportunidades" element={<CampaignOpportunitiesPage />} />
          <Route path="/campanhas/nova" element={<CreateDispatchCampaignPage />} />
          <Route path="/campanhas/:id/previa" element={<CampaignPreviewPage />} />
          <Route path="/campanhas/:id/dry-run" element={<CampaignDryRunPage />} />
          <Route path="/campanhas/:id/disparo" element={<CampaignDispatchPage />} />
          <Route path="/campanhas/:id/acompanhamento" element={<CampaignTrackingPage />} />
          <Route path="/campanhas/:id" element={<CampaignDetailPage />} />
          <Route path="/fila" element={<QueuePage />} />
          <Route path="/atendimento" element={<AttendancePage />} />
          <Route path="/whatsapp" element={<WhatsAppPage />} />
          <Route path="/whatsapp-api" element={<WhatsAppApiPage />} />
          <Route path="/whatsapp-fluxos" element={<WhatsAppApiPage />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/bases" element={<BasesPage />} />
          <Route path="/relatorios" element={<ReportsPage />} />
          <Route path="/consulta-margem" element={<RibeiraoPage />} />
          <Route path="/consulta-ribeirao" element={<RibeiraoPage />} />
          <Route path="/consulta-telefones" element={<PhoneLookupPage />} />
          <Route path="/configuracoes" element={<SettingsPage />} />

          <Route element={<RoleGuard allowedRoles={['gerencial']} />}>
            <Route path="/credenciais" element={<CredentialsPage />} />
            <Route path="/usuarios" element={<UsersPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
