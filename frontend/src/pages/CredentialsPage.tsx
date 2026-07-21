import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  LockKeyhole,
  RefreshCcw,
  Save,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { ApiError, api } from '../lib/api';
import type { AverbadorCredential, CredentialConnectionLog, CredentialPortalConfig, CredentialProfileData } from '../types';
import { Badge, Button, Card, Input, SectionHeader } from '../components/ui';

type Draft = {
  portal_url: string;
  api_url: string;
  login: string;
  password: string;
  credential_profile: CredentialProfileData;
};

const DEFAULT_PORTAL_ID = 'prefeitura_ribeirao_preto';

function getInitialPortalId() {
  if (typeof window === 'undefined') return DEFAULT_PORTAL_ID;
  const portalId = new URLSearchParams(window.location.search).get('portal');
  return portalId || DEFAULT_PORTAL_ID;
}

function portalLabel(portal?: Partial<CredentialPortalConfig & AverbadorCredential> | null) {
  return portal?.name || portal?.portal_name || 'Portal';
}

function statusTone(status?: string): 'neutral' | 'accent' | 'success' | 'danger' | 'info' {
  if (status === 'sessao_ativa') return 'success';
  if (status === 'login_assistido_necessario') return 'info';
  if (status === 'erro_conexao' || status === 'sessao_expirada') return 'danger';
  return 'neutral';
}

function statusLabel(status?: string) {
  const labels: Record<string, string> = {
    sessao_ativa: 'Sessão ativa',
    sessao_expirada: 'Sessão expirada',
    nao_conectado: 'Não conectado',
    login_assistido_necessario: 'Login assistido necessário',
    erro_conexao: 'Erro de conexão',
  };
  return labels[String(status || '')] || 'Não conectado';
}

function actionLabel(action?: string) {
  const labels: Record<string, string> = {
    create: 'Criada',
    update: 'Atualizada',
    test: 'Teste',
    assisted_login_start: 'Login assistido iniciado',
    assisted_login_confirm: 'Sessão confirmada',
  };
  return labels[String(action || '')] || action || '-';
}

function formatDateTime(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function emptyCredentialProfile(): CredentialProfileData {
  return {
    department: '',
    email: '',
    cellphone: '',
    question_1: '',
    answer_1: '',
    question_2: '',
    answer_2: '',
  };
}

function normalizeCredentialProfile(profile?: CredentialProfileData | null): CredentialProfileData {
  return {
    ...emptyCredentialProfile(),
    ...(profile || {}),
  };
}

function requiresProfileCompletion(portalId?: string | null) {
  return portalId === 'prefeitura_ribeirao_preto';
}

export default function CredentialsPage() {
  const [portals, setPortals] = useState<CredentialPortalConfig[]>([]);
  const [credentials, setCredentials] = useState<AverbadorCredential[]>([]);
  const [logs, setLogs] = useState<CredentialConnectionLog[]>([]);
  const [selectedPortalId, setSelectedPortalId] = useState(getInitialPortalId);
  const [draft, setDraft] = useState<Draft>({
    portal_url: '',
    api_url: '',
    login: '',
    password: '',
    credential_profile: emptyCredentialProfile(),
  });
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState('');

  const selectedPortal = portals.find((portal) => portal.id === selectedPortalId) || portals[0] || null;
  const selectedCredential = credentials.find((credential) => credential.portal_id === selectedPortalId) || null;
  const requiresAssistedLogin = Boolean(selectedPortal?.requiresAssistedLogin || selectedCredential?.requires_assisted_login);
  const providerPending = selectedPortal?.providerStatus === 'pending_provider';

  const portalRows = useMemo(() => {
    return portals.map((portal) => ({
      portal,
      credential: credentials.find((item) => item.portal_id === portal.id) || null,
    }));
  }, [credentials, portals]);

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    const credential = credentials.find((item) => item.portal_id === selectedPortalId);
    const portal = portals.find((item) => item.id === selectedPortalId);
    setDraft({
      portal_url: credential?.portal_url || portal?.url || '',
      api_url: credential?.api_url || portal?.apiBaseUrl || '',
      login: credential?.login || '',
      password: '',
      credential_profile: normalizeCredentialProfile(credential?.credential_profile),
    });
  }, [credentials, portals, selectedPortalId]);

  async function loadAll() {
    try {
      setLoading(true);
      const [portalResponse, credentialResponse, logResponse] = await Promise.all([
        api.getCredentialPortals(),
        api.getCredentials(),
        api.getCredentialLogs(),
      ]);
      setPortals(portalResponse.portals || []);
      setCredentials(credentialResponse.credentials || []);
      setLogs(logResponse.rows || []);
      const availablePortalIds = new Set((portalResponse.portals || []).map((portal) => portal.id));
      const requestedPortalId = getInitialPortalId();
      setSelectedPortalId((currentPortalId) => {
        if (availablePortalIds.has(requestedPortalId)) return requestedPortalId;
        if (availablePortalIds.has(currentPortalId)) return currentPortalId;
        return portalResponse.portals?.[0]?.id || DEFAULT_PORTAL_ID;
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar credenciais.');
    } finally {
      setLoading(false);
    }
  }

  async function persistCredential(silent = false) {
    if (!selectedPortal) return null;
    try {
      setActionLoading('save');
      const payload = {
        portal_id: selectedPortal.id,
        portal_url: draft.portal_url || selectedPortal.url,
        api_url: draft.api_url || selectedPortal.apiBaseUrl || '',
        login: draft.login,
        password: draft.password,
        credential_profile: draft.credential_profile,
      };
      const response = selectedCredential?.id
        ? await api.updateCredential(selectedCredential.id, payload)
        : await api.saveCredential(payload);
      setCredentials((items) => {
        const next = items.filter((item) => item.portal_id !== response.credential.portal_id);
        return [...next, response.credential];
      });
      setDraft((current) => ({ ...current, password: '' }));
      if (!silent) toast.success('Credencial salva com segurança.');
      await refreshLogs();
      return response.credential;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar credencial.');
      return null;
    } finally {
      setActionLoading('');
    }
  }

  async function refreshLogs() {
    const response = await api.getCredentialLogs();
    setLogs(response.rows || []);
  }

  async function handleTest() {
    if (providerPending) {
      toast.error('O conector deste portal ainda não está implementado.');
      return;
    }
    const credential = await persistCredential(true);
    if (!credential?.id) {
      toast.error('Salve a credencial antes de testar.');
      return;
    }
    try {
      setActionLoading('test');
      const response = await api.testCredential(credential.id);
      setCredentials((items) => [...items.filter((item) => item.portal_id !== response.credential.portal_id), response.credential]);
      await refreshLogs();
      toast.success('Teste de conexão registrado.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao testar conexão.');
    } finally {
      setActionLoading('');
    }
  }

  async function handleAssistedLogin() {
    const credential = selectedCredential || (await persistCredential(true));
    if (!credential?.id) {
      toast.error('Salve a credencial antes de iniciar o login assistido.');
      return;
    }
    try {
      setActionLoading('assisted');
      const response = await api.startAssistedLogin(credential.id);
      setCredentials((items) => [...items.filter((item) => item.portal_id !== response.credential.portal_id), response.credential]);
      await refreshLogs();
      if (response.portal_url) {
        window.open(response.portal_url, '_blank', 'noopener,noreferrer');
      }
      toast.success('Login assistido iniciado. Conclua o acesso no portal e confirme a sessão.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao iniciar login assistido.');
    } finally {
      setActionLoading('');
    }
  }

  async function handleConfirmAssistedLogin() {
    if (!selectedCredential?.id) {
      toast.error('Salve a credencial antes de confirmar a sessão.');
      return;
    }
    try {
      setActionLoading('confirm');
      const response = await api.confirmAssistedLogin(selectedCredential.id);
      setCredentials((items) => [...items.filter((item) => item.portal_id !== response.credential.portal_id), response.credential]);
      await refreshLogs();
      toast.success('Sessão assistida confirmada.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao confirmar sessão.');
    } finally {
      setActionLoading('');
    }
  }

  async function handlePortalQuickConnect(portalId: string) {
    selectPortal(portalId);
    const portal = portals.find((item) => item.id === portalId);
    const credential = credentials.find((item) => item.portal_id === portalId);

    if (!portal) {
      toast.error('Portal não encontrado.');
      return;
    }

    if (!credential?.id) {
      toast.error('Salve a credencial deste portal antes de conectar.');
      return;
    }

    if (portal.providerStatus === 'pending_provider') {
      toast.error('O conector deste portal ainda não está implementado.');
      return;
    }

    try {
      setActionLoading(`quick-connect:${portalId}`);
      if (portal.requiresAssistedLogin) {
        const response = await api.startAssistedLogin(credential.id);
        setCredentials((items) => [...items.filter((item) => item.portal_id !== response.credential.portal_id), response.credential]);
        await refreshLogs();
        if (response.portal_url) {
          window.open(response.portal_url, '_blank', 'noopener,noreferrer');
        }
        toast.success('Login assistido iniciado. Conclua o acesso no portal e confirme a sessão.');
        return;
      }

      const response = await api.testCredential(credential.id);
      setCredentials((items) => [...items.filter((item) => item.portal_id !== response.credential.portal_id), response.credential]);
      await refreshLogs();
      toast.success('Portal conectado com sucesso.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao conectar portal.';
      toast.error(message);
    } finally {
      setActionLoading('');
    }
  }

  function openPortal() {
    const url = draft.portal_url || selectedPortal?.url;
    if (!url) {
      toast.error('URL do portal não configurada.');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function selectPortal(portalId: string) {
    setSelectedPortalId(portalId);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `/credenciais?portal=${encodeURIComponent(portalId)}`);
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Central de Credenciais"
        description="Conecte e gerencie as credenciais dos portais de consulta de margem."
        action={<Badge tone="accent">Averbadores</Badge>}
      />

      <Card className="overflow-hidden border-accent/10 bg-gradient-to-br from-panel via-panel to-cyan-950/10 p-2">
        <div className="flex flex-wrap gap-2">
          {portals.map((portal) => {
            const active = portal.id === selectedPortalId;
            return (
              <button
                key={portal.id}
                type="button"
                onClick={() => selectPortal(portal.id)}
                className={[
                  'rounded-2xl border px-5 py-4 text-left text-sm font-semibold transition',
                  active
                    ? 'border-accent/60 bg-accent/15 text-white shadow-[0_0_24px_rgba(0,209,193,.12)]'
                    : 'border-transparent bg-white/3 text-slate-400 hover:border-border hover:bg-white/5 hover:text-slate-100',
                ].join(' ')}
              >
                <span className="block">{portal.name}</span>
                <span className="mt-1 block text-xs font-normal text-slate-500">
                  {portal.providerStatus === 'pending_provider'
                    ? 'Conector pendente'
                    : portal.requiresAssistedLogin
                      ? 'Login assistido'
                      : 'Login direto'}
                </span>
              </button>
            );
          })}
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <Card className="p-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-sm text-slate-400">Portal selecionado</p>
              <h3 className="mt-1 text-2xl font-bold text-white">Credenciais - {portalLabel(selectedPortal)}</h3>
            </div>
            <Badge tone={statusTone(selectedCredential?.session_status)}>
              {statusLabel(selectedCredential?.session_status)}
            </Badge>
          </div>

          <div className="mt-6 grid gap-4">
            <label className="block text-sm font-medium text-slate-300">
              URL do portal
              <Input
                className="mt-2"
                value={draft.portal_url}
                onChange={(event) => setDraft((current) => ({ ...current, portal_url: event.target.value }))}
                placeholder={selectedPortal?.url || 'https://'}
              />
            </label>

            <label className="block text-sm font-medium text-slate-300">
              URL da API
              <Input
                className="mt-2"
                value={draft.api_url}
                onChange={(event) => setDraft((current) => ({ ...current, api_url: event.target.value }))}
                placeholder={selectedPortal?.apiBaseUrl || 'Opcional para portais com API'}
              />
              {selectedPortal?.providerStatus === 'implemented_rf1_api' ? (
                <p className="mt-2 text-xs text-slate-500">
                  Este convênio usa a API RF1 para consulta. Se ficar vazio, o CRM tenta inferir pela URL do portal.
                </p>
              ) : null}
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block text-sm font-medium text-slate-300">
                Login
                <Input
                  className="mt-2"
                  value={draft.login}
                  onChange={(event) => setDraft((current) => ({ ...current, login: event.target.value }))}
                  placeholder="Usuário autorizado"
                  autoComplete="off"
                />
              </label>

              <label className="block text-sm font-medium text-slate-300">
                Senha
                <div className="relative mt-2">
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    value={draft.password}
                    onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))}
                    placeholder={selectedCredential?.has_password ? 'Senha salva - preencha para trocar' : 'Senha autorizada'}
                    autoComplete="new-password"
                    className="pr-12"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-xl p-2 text-slate-400 transition hover:bg-white/5 hover:text-white"
                    aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </label>
            </div>

            {requiresProfileCompletion(selectedPortal?.id) ? (
              <div className="rounded-3xl border border-cyan-400/20 bg-cyan-500/5 p-5">
                <div className="mb-4">
                  <p className="text-sm font-semibold text-white">Complemento de acesso do portal</p>
                  <p className="mt-1 text-xs leading-6 text-slate-400">
                    Use estes campos quando o portal pedir “Complete seu cadastro” antes de liberar a sessão automática.
                  </p>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <label className="block text-sm font-medium text-slate-300">
                    Departamento
                    <Input
                      className="mt-2"
                      value={draft.credential_profile.department || ''}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          credential_profile: { ...current.credential_profile, department: event.target.value },
                        }))
                      }
                      placeholder="Departamento exibido no portal"
                    />
                  </label>

                  <label className="block text-sm font-medium text-slate-300">
                    E-mail
                    <Input
                      className="mt-2"
                      value={draft.credential_profile.email || ''}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          credential_profile: { ...current.credential_profile, email: event.target.value },
                        }))
                      }
                      placeholder="E-mail solicitado pelo portal"
                    />
                  </label>

                  <label className="block text-sm font-medium text-slate-300">
                    Celular
                    <Input
                      className="mt-2"
                      value={draft.credential_profile.cellphone || ''}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          credential_profile: { ...current.credential_profile, cellphone: event.target.value },
                        }))
                      }
                      placeholder="Celular solicitado pelo portal"
                    />
                  </label>

                  <div className="hidden md:block" />

                  <label className="block text-sm font-medium text-slate-300">
                    Pergunta 1
                    <Input
                      className="mt-2"
                      value={draft.credential_profile.question_1 || ''}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          credential_profile: { ...current.credential_profile, question_1: event.target.value },
                        }))
                      }
                      placeholder="Texto da pergunta 1"
                    />
                  </label>

                  <label className="block text-sm font-medium text-slate-300">
                    Resposta 1
                    <Input
                      className="mt-2"
                      value={draft.credential_profile.answer_1 || ''}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          credential_profile: { ...current.credential_profile, answer_1: event.target.value },
                        }))
                      }
                      placeholder="Resposta da pergunta 1"
                    />
                  </label>

                  <label className="block text-sm font-medium text-slate-300">
                    Pergunta 2
                    <Input
                      className="mt-2"
                      value={draft.credential_profile.question_2 || ''}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          credential_profile: { ...current.credential_profile, question_2: event.target.value },
                        }))
                      }
                      placeholder="Texto da pergunta 2"
                    />
                  </label>

                  <label className="block text-sm font-medium text-slate-300">
                    Resposta 2
                    <Input
                      className="mt-2"
                      value={draft.credential_profile.answer_2 || ''}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          credential_profile: { ...current.credential_profile, answer_2: event.target.value },
                        }))
                      }
                      placeholder="Resposta da pergunta 2"
                    />
                  </label>
                </div>
              </div>
            ) : null}
          </div>

          <div className="mt-6 rounded-3xl border border-border bg-bg/60 p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-sm font-semibold text-white">Status da sessão</p>
                <p className="mt-1 text-sm text-slate-400">
                  {selectedCredential?.session_status_label || statusLabel(selectedCredential?.session_status)}
                </p>
              </div>
              <Badge tone={statusTone(selectedCredential?.session_status)}>
                {selectedCredential?.session_status === 'sessao_ativa' ? 'Ativa' : statusLabel(selectedCredential?.session_status)}
              </Badge>
            </div>

            <div className="mt-5 grid gap-3 text-sm md:grid-cols-2">
              <StatusLine label="Último acesso" value={formatDateTime(selectedCredential?.last_access_at)} />
              <StatusLine label="Validade da sessão" value={formatDateTime(selectedCredential?.session_expires_at)} />
              <StatusLine label="Última tentativa de teste" value={formatDateTime(selectedCredential?.last_test_at)} />
              <StatusLine label="Mensagem de erro" value={selectedCredential?.last_error || '-'} danger={Boolean(selectedCredential?.last_error)} />
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <Button onClick={() => void persistCredential()} disabled={actionLoading === 'save'}>
              <Save size={16} />
              {actionLoading === 'save' ? 'Salvando...' : 'Salvar credencial'}
            </Button>
            <Button variant="secondary" onClick={() => void handleTest()} disabled={actionLoading === 'test' || providerPending}>
              <RefreshCcw size={16} />
              {actionLoading === 'test' ? 'Conectando...' : providerPending ? 'Conector pendente' : 'Testar login'}
            </Button>
            {requiresAssistedLogin ? (
              <>
                <Button className="bg-lime-300 text-slate-950 hover:brightness-105" onClick={() => void handleAssistedLogin()} disabled={actionLoading === 'assisted'}>
                  <ShieldCheck size={16} />
                  {actionLoading === 'assisted' ? 'Iniciando...' : 'Iniciar login assistido'}
                </Button>
                <Button variant="secondary" onClick={() => void handleConfirmAssistedLogin()} disabled={actionLoading === 'confirm' || !selectedCredential?.id}>
                  <CheckCircle2 size={16} />
                  Confirmar sessão ativa
                </Button>
              </>
            ) : (
              <Button className="bg-lime-300 text-slate-950 hover:brightness-105" onClick={() => void handleTest()} disabled={actionLoading === 'test' || providerPending}>
                <KeyRound size={16} />
                {providerPending ? 'Ainda não disponível' : 'Salvar e conectar'}
              </Button>
            )}
            <Button variant="ghost" onClick={openPortal}>
              <ExternalLink size={16} />
              Abrir portal
            </Button>
          </div>
        </Card>

        <div className="space-y-6">
          {requiresAssistedLogin ? (
            <Card className="border-amber-400/30 bg-amber-500/10 p-6">
              <div className="flex items-start gap-3">
                <div className="rounded-2xl border border-amber-300/30 bg-amber-300/10 p-3 text-amber-200">
                  <AlertTriangle size={20} />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">Este portal exige CAPTCHA</h3>
                  <p className="mt-2 text-sm text-amber-50/85">
                    O acesso ao portal requer resolução de CAPTCHA em cada login.
                  </p>
                  <div className="mt-5 rounded-2xl border border-amber-300/20 bg-slate-950/35 p-4">
                    <p className="font-semibold text-white">Login assistido obrigatório</p>
                    <p className="mt-1 text-sm text-amber-50/80">
                      Este portal exige autenticação com CAPTCHA. Utilize o login assistido para realizar o acesso com segurança.
                    </p>
                  </div>
                  <p className="mt-4 text-xs text-amber-50/75">
                    Suas credenciais são criptografadas e protegidas. Em nenhuma hipótese a senha é armazenada em texto puro.
                  </p>
                </div>
              </div>
            </Card>
          ) : null}

          <Card className="p-6">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl border border-accent/20 bg-accent/10 p-3 text-accent">
                <Sparkles size={20} />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Aproveite os fluxos já existentes</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  Os portais já implementados utilizam os mesmos fluxos de consulta em lote do CRM/Codex, garantindo agilidade e padronização.
                </p>
                <div className="mt-5 grid gap-3 text-sm">
                  <FlowLine label="Prefeitura de Ribeirão Preto" value="Worker Playwright existente conectado ao lote." tone="success" />
                  <FlowLine label="Estado de SP / TJSP" value="Login automatizado pelo robô com CapSolver." tone="success" />
                  <FlowLine label="Prefeitura de Santana de Parnaíba" value="API RF1 para consulta; robô com CapSolver fica como fallback." tone="success" />
                  <FlowLine label="Prefeitura de Ananindeua" value="API RF1 para consulta individual e lote." tone="success" />
                  <FlowLine label="Governo do Amapá" value="Credencial centralizada; provider pendente." tone="neutral" />
                </div>
              </div>
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/10 p-3 text-cyan-200">
                <LockKeyhole size={20} />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Segurança operacional</h3>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  A senha é criptografada no backend, não aparece em logs e não é enviada de volta para a tela. Acesso restrito ao perfil gerencial.
                </p>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <Card className="p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h3 className="text-xl font-bold text-white">Histórico de conexões</h3>
            <p className="mt-1 text-sm text-slate-400">Status dos portais e últimas ações registradas.</p>
          </div>
          <Button variant="secondary" onClick={() => void loadAll()} disabled={loading}>
            <RefreshCcw size={16} />
            Atualizar
          </Button>
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-[0.16em] text-slate-500">
                <th className="px-4 py-3">Portal</th>
                <th className="px-4 py-3">Último acesso</th>
                <th className="px-4 py-3">Status da sessão</th>
                <th className="px-4 py-3">Ações</th>
              </tr>
            </thead>
            <tbody>
              {portalRows.map(({ portal, credential }) => (
                <tr key={portal.id} className="border-b border-border/70">
                  <td className="px-4 py-4">
                    <p className="font-semibold text-white">{portal.name}</p>
                    <p className="mt-1 text-xs text-slate-500">{credential?.portal_url || portal.url}</p>
                  </td>
                  <td className="px-4 py-4 text-slate-300">{formatDateTime(credential?.last_access_at)}</td>
                  <td className="px-4 py-4">
                    <Badge tone={statusTone(credential?.session_status)}>{statusLabel(credential?.session_status)}</Badge>
                  </td>
                  <td className="px-4 py-4">
                    <div className="flex flex-wrap gap-2">
                      <Button variant="secondary" className="px-3 py-2" onClick={() => selectPortal(portal.id)}>
                        Abrir
                      </Button>
                      <Button variant="ghost" className="px-3 py-2" onClick={() => selectPortal(portal.id)}>
                        Editar
                      </Button>
                      <Button
                        variant="ghost"
                        className="px-3 py-2"
                        onClick={() => void handlePortalQuickConnect(portal.id)}
                        disabled={actionLoading === `quick-connect:${portal.id}`}
                      >
                        {portal.requiresAssistedLogin
                          ? actionLoading === `quick-connect:${portal.id}`
                            ? 'Iniciando...'
                            : 'Assistido'
                          : actionLoading === `quick-connect:${portal.id}`
                            ? 'Conectando...'
                            : 'Conectar'}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-xl font-bold text-white">Logs de conexão</h3>
            <p className="mt-1 text-sm text-slate-400">Registro técnico sem senha, tokens ou cookies.</p>
          </div>
          <Badge tone="neutral">{logs.length} eventos</Badge>
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-[0.16em] text-slate-500">
                <th className="px-4 py-3">Data</th>
                <th className="px-4 py-3">Portal</th>
                <th className="px-4 py-3">Ação</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Mensagem</th>
              </tr>
            </thead>
            <tbody>
              {logs.length ? (
                logs.map((log) => (
                  <tr key={log.id} className="border-b border-border/70">
                    <td className="px-4 py-4 text-slate-300">{formatDateTime(log.created_at)}</td>
                    <td className="px-4 py-4 text-slate-300">{log.portal_name || log.portal_id}</td>
                    <td className="px-4 py-4 text-slate-300">{actionLabel(log.action)}</td>
                    <td className="px-4 py-4">
                      <Badge tone={log.status === 'success' ? 'success' : log.status === 'failed' ? 'danger' : 'info'}>{log.status || '-'}</Badge>
                    </td>
                    <td className="px-4 py-4 text-slate-400">{log.error_message || log.message || '-'}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                    Nenhum teste ou conexão registrado ainda.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function StatusLine({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="rounded-2xl border border-border bg-panel/70 px-4 py-3">
      <p className="text-xs uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className={['mt-1 text-sm font-semibold', danger ? 'text-red-200' : 'text-slate-200'].join(' ')}>{value}</p>
    </div>
  );
}

function FlowLine({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'success' | 'info' | 'neutral';
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-2xl border border-border bg-bg/60 px-4 py-3">
      <div>
        <p className="font-semibold text-white">{label}</p>
        <p className="mt-1 text-xs text-slate-500">{value}</p>
      </div>
      <Badge tone={tone}>{tone === 'success' ? 'Ativo' : tone === 'info' ? 'Assistido' : 'Pendente'}</Badge>
    </div>
  );
}
