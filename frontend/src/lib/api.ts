import type {
  AuthResponse,
  ChangePasswordResponse,
  Base,
  Campaign,
  Client,
  ClientsResponse,
  DashboardData,
  RibeiraoBatchPreview,
  RibeiraoBatchRecord,
  RibeiraoBatchResultItem,
  RibeiraoBatchSourceType,
  RibeiraoHistoryItem,
  RibeiraoConfigStatus,
  RibeiraoQueryResult,
  RibeiraoSession,
  RibeiraoSessionStatus,
  ReportResponse,
  Settings,
  UserRecord,
  UploadAnalysis,
  RibeiraoDiagnostics,
  ClientPhone,
  ClientAddress,
  ClientEnrichmentData,
  PhoneLookupJob,
  PhoneLookupHistoryItem,
  AverbadorCredential,
  CredentialConnectionLog,
  CredentialPortalConfig,
  WhatsappConfig,
  WhatsappMessage,
  WhatsappTemplate,
} from '../types';
import { clearAuthSession, getAccessSession, getAuthToken } from './session';

const API_URL = String(import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  code?: string;
  status?: number;
  data?: unknown;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  const isFormData = init.body instanceof FormData;
  const accessSession = getAccessSession();
  const token = getAuthToken();

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  headers.set('x-crm-role', accessSession.role);
  headers.set('x-crm-user-name', accessSession.name);

  if (!isFormData && init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (response.status === 401) {
    clearAuthSession();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.assign('/login');
    }
    const error = new ApiError(data?.message || 'Sessão expirada. Faça login novamente.');
    error.code = data?.code;
    error.status = response.status;
    error.data = data;
    throw error;
  }

  if (!response.ok) {
    const error = new ApiError(data?.message || 'Erro inesperado na API.');
    error.code = data?.code;
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data as T;
}

async function requestBlob(path: string, init: RequestInit = {}): Promise<Blob> {
  const headers = new Headers(init.headers || {});
  const isFormData = init.body instanceof FormData;
  const accessSession = getAccessSession();
  const token = getAuthToken();

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  headers.set('x-crm-role', accessSession.role);
  headers.set('x-user-role', accessSession.role);
  headers.set('x-crm-user-name', accessSession.name);

  if (!isFormData && init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
  });

  if (response.status === 401) {
    clearAuthSession();
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.assign('/login');
    }
    const error = new ApiError('Sessão expirada. Faça login novamente.');
    error.status = response.status;
    error.data = null;
    throw error;
  }

  if (!response.ok) {
    const text = await response.text();
    let message = 'Erro inesperado na API.';
    try {
      const parsed = text ? JSON.parse(text) : null;
      message = parsed?.message || message;
    } catch {
      message = text || message;
    }
    const error = new ApiError(message);
    error.status = response.status;
    error.data = null;
    throw error;
  }

  return response.blob();
}

function buildQuery(params: Record<string, string | number | undefined | null>) {
  const searchParams = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      searchParams.set(key, String(value));
    }
  });
  const query = searchParams.toString();
  return query ? `?${query}` : '';
}

export const api = {
  login: (payload: { login: string; password: string }) =>
    request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  changePassword: (payload: { currentPassword: string; newPassword: string; confirmPassword: string }) =>
    request<ChangePasswordResponse>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getAuthMe: () => request<{ user: AuthResponse['user'] }>('/api/auth/me'),
  logout: () =>
    request<{ message: string }>('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getUsers: () => request<{ users: UserRecord[] }>('/api/users'),
  createUser: (payload: { name: string; login: string; password: string; role: string; is_active: boolean }) =>
    request<{ user: UserRecord }>('/api/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateUser: (id: number, payload: { name: string; login: string; role: string; is_active: boolean }) =>
    request<{ user: UserRecord }>(`/api/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  updateUserPassword: (id: number, payload: { password: string; confirm_password: string }) =>
    request<{ user: UserRecord }>(`/api/users/${id}/password`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  toggleUserActive: (id: number) =>
    request<{ user: UserRecord }>(`/api/users/${id}/toggle-active`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getCampaigns: (filters: Record<string, string | number | undefined | null> = {}) =>
    request<{ campaigns: Campaign[] }>(`/api/campaigns${buildQuery(filters)}`),
  getCampaign: (id: number, filters: Record<string, string | number | undefined | null> = {}) =>
    request<{ campaign: Campaign }>(`/api/campaigns/${id}${buildQuery(filters)}`),
  createCampaign: (payload: {
    name: string;
    convenio: string;
    description?: string;
    product_focus?: string;
    status?: string;
    internal_notes?: string;
    file_name?: string;
    user_ids?: number[];
    role?: string;
  }) =>
    request<{ campaign: Campaign }>('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateCampaign: (id: number, payload: {
    name: string;
    convenio: string;
    description?: string;
    product_focus?: string;
    status?: string;
    internal_notes?: string;
    file_name?: string;
    user_ids?: number[];
    role?: string;
  }) =>
    request<{ campaign: Campaign }>(`/api/campaigns/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  archiveCampaign: (id: number, archived = true) =>
    request<{ campaign: Campaign }>(`/api/campaigns/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived }),
    }),
  updateCampaignUsers: (id: number, payload: { user_ids: number[]; role?: string }) =>
    request<{ campaignUsers: Array<{ id: number; name: string; login: string; role: string }> }>(`/api/campaigns/${id}/users`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getDashboard: (filters: Record<string, string | number | undefined | null> = {}) =>
    request<DashboardData>(`/api/dashboard${buildQuery(filters)}`),
  getSettings: () => request<{ settings: Settings }>('/api/settings'),
  getRibeiraoConfig: () => request<{ config: RibeiraoConfigStatus }>('/api/ribeirao/config'),
  getRibeiraoDiagnostics: () => request<{ diagnostics: RibeiraoDiagnostics }>('/api/ribeirao/diagnostics'),
  getCredentialPortals: () => request<{ portals: CredentialPortalConfig[] }>('/api/credentials/portals'),
  getCredentials: () => request<{ credentials: AverbadorCredential[] }>('/api/credentials'),
  getCredential: (portalId: string) => request<{ credential: AverbadorCredential }>(`/api/credentials/${portalId}`),
  saveCredential: (payload: { portal_id: string; portal_url?: string; login?: string; password?: string }) =>
    request<{ credential: AverbadorCredential }>('/api/credentials', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateCredential: (id: number, payload: { portal_url?: string; login?: string; password?: string }) =>
    request<{ credential: AverbadorCredential }>(`/api/credentials/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  testCredential: (id: number) =>
    request<{ credential: AverbadorCredential }>(`/api/credentials/${id}/test`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  startAssistedLogin: (id: number) =>
    request<{ credential: AverbadorCredential; portal_url: string; message: string }>(`/api/credentials/${id}/assisted-login/start`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  confirmAssistedLogin: (id: number) =>
    request<{ credential: AverbadorCredential }>(`/api/credentials/${id}/assisted-login/confirm`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getCredentialLogs: (filters: Record<string, string | number | undefined | null> = {}) =>
    request<{ rows: CredentialConnectionLog[] }>(`/api/credentials/logs${buildQuery(filters)}`),
  getBases: (filters: Record<string, string | number | undefined | null> = {}) =>
    request<{ bases: Base[] }>(`/api/bases${buildQuery(filters)}`),
  renameBase: (id: number, nome_base: string) =>
    request<{ base: Base }>(`/api/bases/${id}/rename`, {
      method: 'POST',
      body: JSON.stringify({ nome_base }),
    }),
  archiveBase: (id: number, archived = true) =>
    request<{ base: Base }>(`/api/bases/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ archived }),
    }),
  saveSettings: (settings: Partial<Settings>) =>
    request<{ settings: Settings }>('/api/settings', {
      method: 'POST',
      body: JSON.stringify(settings),
    }),
  getClients: (filters: Record<string, string | number | undefined | null> = {}) =>
    request<ClientsResponse>(`/api/clients${buildQuery(filters)}`),
  exportClientsWithPhones: (filters: Record<string, string | number | undefined | null> = {}) =>
    requestBlob(`/api/clients/export${buildQuery(filters)}`),
  getClient: (id: number) => request<{ client: Client; interactions: any[]; scheduled_returns: any[]; deals: any[] }>(`/api/clients/${id}`),
  getNextClient: (filters: Record<string, string | number | undefined | null> = {}) =>
    request<{ next: { client: Client; queue_total: number; queue_position: number } | null }>(`/api/clients/next${buildQuery(filters)}`),
  startClient: (id: number, userId = 1) =>
    request<{ client: Client; interactions: any[]; scheduled_returns: any[]; deals: any[] }>(`/api/clients/${id}/start`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId }),
    }),
  addInteraction: (id: number, payload: { userId?: number; type?: string; note?: string; private_note?: string }) =>
    request<{ client: Client; interactions: any[]; scheduled_returns: any[]; deals: any[] }>(`/api/clients/${id}/interactions`, {
      method: 'POST',
      body: JSON.stringify({
        user_id: payload.userId ?? 1,
        type: payload.type || 'observacao',
        note: payload.note || '',
        private_note: payload.private_note || '',
      }),
    }),
  scheduleReturn: (
    id: number,
    payload: { userId?: number; returnAt: string; note?: string; private_note?: string }
  ) =>
    request<{ client: Client; interactions: any[]; scheduled_returns: any[]; deals: any[] }>(`/api/clients/${id}/schedule-return`, {
      method: 'POST',
      body: JSON.stringify({
        user_id: payload.userId ?? 1,
        return_at: payload.returnAt,
        note: payload.note || '',
        private_note: payload.private_note || '',
      }),
    }),
  finalizeClient: (id: number, payload: { userId?: number; note?: string; private_note?: string }) =>
    request<{ client: Client; interactions: any[]; scheduled_returns: any[]; deals: any[] }>(`/api/clients/${id}/finalize`, {
      method: 'POST',
      body: JSON.stringify({
        user_id: payload.userId ?? 1,
        note: payload.note || '',
        private_note: payload.private_note || '',
      }),
    }),
  markNoInterest: (id: number, payload: { userId?: number; note?: string; private_note?: string }) =>
    request<{ client: Client; interactions: any[]; scheduled_returns: any[]; deals: any[] }>(`/api/clients/${id}/no-interest`, {
      method: 'POST',
      body: JSON.stringify({
        user_id: payload.userId ?? 1,
        note: payload.note || '',
        private_note: payload.private_note || '',
      }),
    }),
  convertClient: (
    id: number,
    payload: {
      userId?: number;
      bank?: string;
      amount?: number;
      installment?: number;
      term?: number;
      note?: string;
      private_note?: string;
    }
  ) =>
    request<{ client: Client; interactions: any[]; scheduled_returns: any[]; deals: any[] }>(`/api/clients/${id}/converted`, {
      method: 'POST',
      body: JSON.stringify({
        user_id: payload.userId ?? 1,
        bank: payload.bank || '',
        amount: payload.amount || 0,
        installment: payload.installment || 0,
        term: payload.term || 0,
        note: payload.note || '',
        private_note: payload.private_note || '',
      }),
    }),
  openWhatsappLog: (id: number, userId = 1) =>
    request<{ client: Client; interactions: any[]; scheduled_returns: any[]; deals: any[] }>(`/api/clients/${id}/whatsapp-open`, {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, note: 'WhatsApp Web aberto para o cliente' }),
    }),
  getClientPhones: (id: number) => request<{ phones: ClientPhone[] }>(`/api/clients/${id}/phones`),
  lookupClientPhone: (id: number, force = false) =>
    request<{ job: PhoneLookupJob; result?: any; client?: Client }>(`/api/clients/${id}/phone-lookup`, {
      method: 'POST',
      body: JSON.stringify({ force, run_now: true }),
    }),
  setPrimaryPhone: (clientId: number, phoneId: number) =>
    request<{ client: Client; interactions: any[]; scheduled_returns: any[]; deals: any[] }>(`/api/clients/${clientId}/phones/${phoneId}/primary`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  inactivatePhone: (clientId: number, phoneId: number) =>
    request<{ client: Client; interactions: any[]; scheduled_returns: any[]; deals: any[] }>(`/api/clients/${clientId}/phones/${phoneId}/inactivate`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  queuePhoneLookupMarginClients: (payload: { campaign_id?: string | number; base_id?: string | number; force?: boolean } = {}) =>
    request<{ created: number; jobs: PhoneLookupJob[] }>('/api/phone-lookup/bulk/margin-clients', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  runPhoneLookupWorker: (max = 50) =>
    request<{ processed: number; results: unknown[] }>('/api/phone-lookup/worker/run', {
      method: 'POST',
      body: JSON.stringify({ max }),
    }),
  getPhoneLookupJobs: (filters: Record<string, string | number | undefined | null> = {}) =>
    request<{ jobs: PhoneLookupJob[]; stats: Record<string, number> }>(`/api/phone-lookup/jobs${buildQuery(filters)}`),
  searchPhones: (payload: { cpf?: string; name?: string; phone?: string; client_id?: number | string | null }) =>
    request<{
      status: string;
      source: string;
      origin?: string;
      cache_hit?: boolean;
      consultation_id?: number | null;
      client_id?: number | null;
      cpf: string;
      name: string;
      full_name?: string;
      birth_date?: string;
      age?: number | null;
      gender?: string;
      mother_name?: string;
      father_name?: string;
      email?: string;
      emails?: string[];
      addresses?: ClientAddress[];
      raw_data?: Record<string, unknown>;
      phones: ClientPhone[];
      message?: string;
      code?: string;
      consulted_at?: string;
      expires_at?: string;
    }>(
      '/api/phone-lookup/search',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  savePhonesToClient: (payload: { client_id: number | string; phones: Array<Partial<ClientPhone> & { number?: string; normalized?: string }>; enrichment?: Record<string, unknown> }) =>
    request<{ client: Client; phones: ClientPhone[]; saved: number; enrichment?: ClientEnrichmentData | null }>('/api/phone-lookup/save-to-client', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getPhoneLookupHistory: (filters: Record<string, string | number | undefined | null> = {}) =>
    request<{ rows: PhoneLookupHistoryItem[] }>(`/api/phone-lookup/history${buildQuery(filters)}`),
  getPhoneLookupConsultation: (id: number | string) =>
    request<{ consultation: PhoneLookupHistoryItem & {
      source: string;
      origin?: string;
      cache_hit?: boolean;
      consultation_id?: number;
      full_name?: string;
      birth_date?: string;
      age?: number | null;
      gender?: string;
      mother_name?: string;
      father_name?: string;
      email?: string;
      emails?: Array<{ email: string; is_primary?: boolean }>;
      addresses?: ClientAddress[];
      phones?: ClientPhone[];
      raw_data?: Record<string, unknown>;
    } }>(`/api/phone-lookup/consultations/${id}`),
  saveCurrentPhoneLookup: (payload: { consultation_id?: number | string | null; client_id?: number | string | null }) =>
    request<{ consultation: PhoneLookupHistoryItem }>('/api/phone-lookup/save-current', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  uploadSpreadsheet: (
    file: File,
    mode: 'preview' | 'import',
    baseInput: {
      nome_base?: string;
      tipo_base?: string;
      convenio?: string;
      estado?: string;
      cidade?: string;
      notes?: string;
      observacao?: string;
      campaign_id?: number | string | null;
      campaign_name?: string;
    } = {}
  ) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('mode', mode);
    if (baseInput.nome_base) formData.append('nome_base', baseInput.nome_base);
    if (baseInput.tipo_base) formData.append('tipo_base', baseInput.tipo_base);
    if (baseInput.convenio) formData.append('convenio', baseInput.convenio);
    if (baseInput.estado) formData.append('estado', baseInput.estado);
    if (baseInput.cidade) formData.append('cidade', baseInput.cidade);
    if (baseInput.notes) {
      formData.append('notes', baseInput.notes);
      formData.append('observacao', baseInput.notes);
    } else if (baseInput.observacao) {
      formData.append('notes', baseInput.observacao);
      formData.append('observacao', baseInput.observacao);
    }
    if (baseInput.campaign_id !== undefined && baseInput.campaign_id !== null && baseInput.campaign_id !== '') {
      formData.append('campaign_id', String(baseInput.campaign_id));
    }
    if (baseInput.campaign_name) {
      formData.append('campaign_name', baseInput.campaign_name);
    }
    return request<
      | { mode: 'preview'; file: { name: string; size: number; mime: string }; analysis: UploadAnalysis }
      | { mode: 'import'; message: string; redirectTo: string; result: unknown }
    >('/api/upload', {
      method: 'POST',
      body: formData,
    });
  },
  getReports: (filters: Record<string, string | number | undefined | null> = {}) =>
    request<ReportResponse>(`/api/reports${buildQuery(filters)}`),
  startRibeiraoSession: (payload: {
    login: string;
    password: string;
    timeout_seconds?: number;
    slow_mo?: number;
    user_id?: number;
  }) =>
    request<{ session: RibeiraoSession; message: string }>('/api/ribeirao/session/start', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getRibeiraoSessionStatus: (id: number) =>
    request<{ session: RibeiraoSession }>(`/api/ribeirao/session/${id}/status`),
  queryRibeiraoCpf: (payload: {
    session_id: number;
    cpf: string;
    login?: string;
    password?: string;
    user_id?: number;
    client_id?: number | null;
    base_id?: number | null;
  }) =>
    request<{ query: RibeiraoQueryResult; client_matches: Array<Record<string, unknown>>; standardized: Record<string, unknown> }>('/api/ribeirao/query', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getRibeiraoHistory: (filters: Record<string, string | number | undefined | null> = {}) =>
    request<{ rows: RibeiraoHistoryItem[] }>('/api/ribeirao/history' + buildQuery(filters)),
  getRibeiraoHistoryItem: (id: number) =>
    request<{ item: RibeiraoHistoryItem }>(`/api/ribeirao/history/${id}`),
  applyRibeiraoHistoryToClient: (
    id: number,
    payload: { client_id: number; base_id?: number | null; user_id?: number }
  ) =>
    request<{ client: Client }>(`/api/ribeirao/history/${id}/apply`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  uploadRibeiraoBatchPreview: (file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    return request<{ file: { name: string; size: number; mime: string }; preview: RibeiraoBatchPreview }>(
      '/api/ribeirao/batch/upload-preview',
      {
        method: 'POST',
        body: formData,
      }
    );
  },
  startRibeiraoBatch: (payload: {
    cpfs?: string[];
    session_id: number;
    portal_id?: string;
    login?: string;
    password?: string;
    source_type?: RibeiraoBatchSourceType | 'upload' | 'base';
    source_file_name?: string;
    base_id?: number | string | null;
    delay_seconds_min?: number;
    delay_seconds_max?: number;
  }) =>
    request<{ message: string; batch: RibeiraoBatchRecord }>('/api/ribeirao/batch/start', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getRibeiraoBatchHistory: (filters: Record<string, string | number | undefined | null> = {}) =>
    request<{ rows: RibeiraoBatchRecord[] }>('/api/ribeirao/batch/history' + buildQuery(filters)),
  getRibeiraoBatchStatus: (id: number) => request<{ batch: RibeiraoBatchRecord }>(`/api/ribeirao/batch/${id}/status`),
  getRibeiraoBatchResults: (id: number) =>
    request<{ batch: RibeiraoBatchRecord; rows: RibeiraoBatchResultItem[] }>(`/api/ribeirao/batch/${id}/results`),
  pauseRibeiraoBatch: (id: number) => request<{ batch: RibeiraoBatchRecord }>(`/api/ribeirao/batch/${id}/pause`, { method: 'POST', body: JSON.stringify({}) }),
  resumeRibeiraoBatch: (id: number) => request<{ batch: RibeiraoBatchRecord }>(`/api/ribeirao/batch/${id}/resume`, { method: 'POST', body: JSON.stringify({}) }),
  cancelRibeiraoBatch: (id: number) => request<{ batch: RibeiraoBatchRecord }>(`/api/ribeirao/batch/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) }),
  exportRibeiraoBatch: async (id: number) => {
    const blob = await requestBlob(`/api/ribeirao/batch/${id}/export`);
    return blob;
  },
  getWhatsappStatus: () =>
    request<{ config: WhatsappConfig | null; connected?: boolean; status?: string; message?: string; qrcode?: string; code?: string }>(
      '/api/whatsapp/status'
    ),
  getWhatsappConfig: () => request<{ config: WhatsappConfig | null }>('/api/whatsapp/config'),
  saveWhatsappConfig: (payload: Partial<WhatsappConfig> & { token?: string }) =>
    request<{ config: WhatsappConfig }>('/api/whatsapp/config', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  connectWhatsapp: () => request<{ config: WhatsappConfig; connected?: boolean; status?: string; qrcode?: string }>('/api/whatsapp/connect', { method: 'POST', body: JSON.stringify({}) }),
  reconnectWhatsapp: () => request<{ config: WhatsappConfig; connected?: boolean; status?: string; qrcode?: string }>('/api/whatsapp/reconnect', { method: 'POST', body: JSON.stringify({}) }),
  getWhatsappQrcode: () => request<{ qrcode: string; status?: string }>('/api/whatsapp/qrcode'),
  testWhatsapp: () => request<{ config: WhatsappConfig; connected?: boolean; status?: string; message?: string }>('/api/whatsapp/test', { method: 'POST', body: JSON.stringify({}) }),
  sendWhatsapp: (payload: { client_id?: number | string | null; phone?: string; message: string; template_id?: number | string | null }) =>
    request<{ message: WhatsappMessage; provider_result?: unknown }>('/api/whatsapp/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  sendWhatsappTemplate: (payload: { client_id?: number | string | null; phone?: string; template_id: number | string; variables?: Record<string, string> }) =>
    request<{ message: WhatsappMessage; provider_result?: unknown }>('/api/whatsapp/send-template', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getWhatsappMessages: (filters: Record<string, string | number | undefined | null> = {}) =>
    request<{ rows: WhatsappMessage[] }>(`/api/whatsapp/messages${buildQuery(filters)}`),
  getWhatsappTemplates: (filters: Record<string, string | number | undefined | null> = {}) =>
    request<{ rows: WhatsappTemplate[] }>(`/api/whatsapp/templates${buildQuery(filters)}`),
  saveWhatsappTemplate: (payload: Partial<WhatsappTemplate>) =>
    request<{ template: WhatsappTemplate }>('/api/whatsapp/templates', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateWhatsappTemplate: (id: number | string, payload: Partial<WhatsappTemplate>) =>
    request<{ template: WhatsappTemplate }>(`/api/whatsapp/templates/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
};

export { API_URL };
