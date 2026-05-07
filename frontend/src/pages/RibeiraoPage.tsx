import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  FileDown,
  PauseCircle,
  PlayCircle,
  RefreshCcw,
  Search,
  ShieldAlert,
  Sparkles,
  StopCircle,
  Upload,
  UserRoundSearch,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { ApiError, api } from '../lib/api';
import { formatCurrencyDisplay } from '../lib/margins';
import { getAccessSession } from '../lib/session';
import type {
  Base,
  RibeiraoBatchPreview,
  RibeiraoBatchRecord,
  RibeiraoBatchResultItem,
  RibeiraoDiagnostics,
  RibeiraoHistoryItem,
  RibeiraoSession,
  RibeiraoSessionStatus,
} from '../types';
import { Badge, Button, Card, Input, SectionHeader, Select } from '../components/ui';

type ProductView = {
  product_type: string;
  gross_margin: number | null;
  net_margin: number | null;
  source_gross_column?: string;
  source_net_column?: string;
  state?: { label: string; tone: 'neutral' | 'accent' | 'success' | 'danger' | 'info' };
};

type TabKey = 'individual' | 'batch' | 'history';
type BatchSourceMode = 'upload' | 'base';

const MARGIN_CONNECTIONS = [
  { value: 'prefeitura-ribeirao-preto', label: 'Prefeitura de Ribeirão Preto', enabled: true },
  { value: 'governo-amapa', label: 'Governo do Amapá', enabled: false },
  { value: 'governo-sp-tjsp', label: 'Governo de SP / Tribunal de Justiça de SP', enabled: false },
] as const;

const RETURN_CHANNEL = 'Portal';

const HISTORY_FILTER_DEFAULTS = {
  from: '',
  to: '',
  status: '',
  cpf: '',
  user_id: '',
};

const ROLE_SESSION_KEY = 'relianse.ribeirao.sessionId';
const BATCH_SESSION_KEY = 'relianse.ribeirao.batchId';

export default function RibeiraoPage() {
  const sessionSession = getAccessSession();
  const [activeTab, setActiveTab] = useState<TabKey>('batch');
  const [selectedConnection, setSelectedConnection] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [session, setSession] = useState<RibeiraoSession | null>(null);
  const [ribeiraoDiagnostics, setRibeiraoDiagnostics] = useState<RibeiraoDiagnostics | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionRefreshing, setSessionRefreshing] = useState(false);
  const [cpf, setCpf] = useState('');
  const [queryLoading, setQueryLoading] = useState(false);
  const [currentResult, setCurrentResult] = useState<RibeiraoHistoryItem | null>(null);
  const [history, setHistory] = useState<RibeiraoHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyFilters, setHistoryFilters] = useState(HISTORY_FILTER_DEFAULTS);
  const [bases, setBases] = useState<Base[]>([]);
  const [batchSourceMode, setBatchSourceMode] = useState<BatchSourceMode>('upload');
  const [batchPreview, setBatchPreview] = useState<RibeiraoBatchPreview | null>(null);
  const [batchPreviewFileName, setBatchPreviewFileName] = useState('');
  const [batchStartLoading, setBatchStartLoading] = useState(false);
  const [batchBaseId, setBatchBaseId] = useState('all');
  const [batchDelayMin, setBatchDelayMin] = useState('3');
  const [batchDelayMax, setBatchDelayMax] = useState('8');
  const [currentBatch, setCurrentBatch] = useState<RibeiraoBatchRecord | null>(null);
  const [batchHistory, setBatchHistory] = useState<RibeiraoBatchRecord[]>([]);
  const [batchHistoryLoading, setBatchHistoryLoading] = useState(false);
  const [batchResults, setBatchResults] = useState<RibeiraoBatchResultItem[]>([]);
  const [batchResultsLoading, setBatchResultsLoading] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState<RibeiraoBatchRecord | null>(null);

  useEffect(() => {
    const sessionId = Number(window.localStorage.getItem(ROLE_SESSION_KEY) || 0);
    if (sessionId) {
      void refreshSessionStatus(sessionId);
    }
    const savedBatch = Number(window.localStorage.getItem(BATCH_SESSION_KEY) || 0);
    if (savedBatch) {
      void refreshBatchStatus(savedBatch);
    }
    void loadRibeiraoDiagnostics();
    void loadHistory(historyFilters);
    void loadBatchHistory();
    void loadBases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const sessionId = session?.id;
    if (sessionId) {
      window.localStorage.setItem(ROLE_SESSION_KEY, String(sessionId));
    }
  }, [session?.id]);

  useEffect(() => {
    const batchId = currentBatch?.id;
    if (batchId) {
      window.localStorage.setItem(BATCH_SESSION_KEY, String(batchId));
    } else {
      window.localStorage.removeItem(BATCH_SESSION_KEY);
    }
  }, [currentBatch?.id]);

  useEffect(() => {
    const handleStorage = () => {
      const saved = Number(window.localStorage.getItem(ROLE_SESSION_KEY) || 0);
      if (saved && (!session || session.id !== saved)) {
        void refreshSessionStatus(saved);
      }
      const savedBatch = Number(window.localStorage.getItem(BATCH_SESSION_KEY) || 0);
      if (savedBatch && (!currentBatch || currentBatch.id !== savedBatch)) {
        void refreshBatchStatus(savedBatch);
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [session, currentBatch]);

  useEffect(() => {
    if (!currentBatch?.id || !isBatchActive(currentBatch.status)) {
      return;
    }

    const timer = window.setInterval(() => {
      void refreshBatchStatus(currentBatch.id);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [currentBatch?.id, currentBatch?.status]);

  const visibleHistory = useMemo(() => history, [history]);
  const ribeiraoUrlReady = Boolean(ribeiraoDiagnostics?.ribeiraoConfigured);
  const stats = useMemo(() => {
    const total = history.length;
    const withMargin = history.filter((item) => item.consulta_status === 'com_marg').length;
    const withoutMargin = history.filter((item) => item.consulta_status === 'sem_marg').length;
    const notFound = history.filter((item) => item.consulta_status === 'nao_encontrado').length;
    const errors = history.filter((item) => item.consulta_status === 'erro' || item.consulta_status === 'login_error').length;
    const captcha = history.filter((item) => item.consulta_status === 'captcha_required').length;
    return { total, withMargin, withoutMargin, notFound, errors, captcha };
  }, [history]);

  const batchStats = useMemo(() => {
    const rows = batchHistory;
    return {
      total: rows.length,
      active: rows.filter((item) => isBatchActive(item.status)).length,
      concluded: rows.filter((item) => item.status === 'concluido').length,
      paused: rows.filter((item) => item.status === 'pausado' || item.status === 'aguardando_captcha').length,
    };
  }, [batchHistory]);

  async function loadBases() {
    try {
      const response = await api.getBases();
      setBases(response.bases || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar bases.');
    }
  }

  async function loadRibeiraoDiagnostics() {
    try {
      const response = await api.getRibeiraoDiagnostics();
      setRibeiraoDiagnostics(response.diagnostics);
    } catch (error) {
      setRibeiraoDiagnostics(null);
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar configuração do averbador.');
    }
  }

  async function loadHistory(filters = historyFilters) {
    try {
      setHistoryLoading(true);
      const response = await api.getRibeiraoHistory(filters);
      setHistory((response.rows || []).filter(Boolean));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar o histórico Ribeirão.');
    } finally {
      setHistoryLoading(false);
    }
  }

  async function loadBatchHistory() {
    try {
      setBatchHistoryLoading(true);
      const response = await api.getRibeiraoBatchHistory();
      setBatchHistory((response.rows || []).filter(Boolean));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar o histórico de lotes.');
    } finally {
      setBatchHistoryLoading(false);
    }
  }

  async function refreshSessionStatus(sessionId = session?.id) {
    if (!sessionId) {
      return;
    }
    try {
      setSessionRefreshing(true);
      const response = await api.getRibeiraoSessionStatus(sessionId);
      const nextSession = response.session;
      if (shouldPersistSession(nextSession)) {
        setSession(nextSession);
      } else {
        setSession(null);
        window.localStorage.removeItem(ROLE_SESSION_KEY);
      }
    } catch (error) {
      setSession(null);
      window.localStorage.removeItem(ROLE_SESSION_KEY);
      toast.error(getFriendlyRibeiraoError(error, 'Falha ao atualizar status da sessão.'));
    } finally {
      setSessionRefreshing(false);
    }
  }

  async function refreshBatchStatus(batchId = currentBatch?.id) {
    if (!batchId) {
      return;
    }
    try {
      const response = await api.getRibeiraoBatchStatus(batchId);
      setCurrentBatch(response.batch);
      if (selectedBatch && selectedBatch.id === batchId) {
        await loadBatchResults(batchId, response.batch);
      }
      await loadBatchHistory();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao atualizar status do lote.');
    }
  }

  async function loadBatchResults(batchId: number, batchOverride?: RibeiraoBatchRecord) {
    try {
      setBatchResultsLoading(true);
      const response = await api.getRibeiraoBatchResults(batchId);
      setBatchResults((response.rows || []).filter(Boolean));
      setSelectedBatch(batchOverride || response.batch || null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar os resultados do lote.');
    } finally {
      setBatchResultsLoading(false);
    }
  }

  async function handleStartSession() {
    if (!ribeiraoDiagnostics?.ribeiraoConfigured) {
      toast.error(ribeiraoDiagnostics?.hint || 'Configure a URL do averbador no servidor antes de iniciar a sessão.');
      return;
    }

    if (!login.trim() || !password.trim()) {
      toast.error('Informe login e senha.');
      return;
    }

    try {
      setSessionLoading(true);
      const response = await api.startRibeiraoSession({
        login: login.trim(),
        password,
        timeout_seconds: 900,
        slow_mo: 0,
      });
      const nextSession = response.session || null;
      if (shouldPersistSession(nextSession)) {
        setSession(nextSession);
        window.localStorage.setItem(ROLE_SESSION_KEY, String(nextSession?.id || ''));
      } else {
        setSession(null);
        window.localStorage.removeItem(ROLE_SESSION_KEY);
      }
      if (nextSession?.status === 'conectado') {
        toast.success(response.message || 'Sessão conectada.');
      } else if (
        nextSession?.status === 'aguardando_captcha_manual' ||
        nextSession?.status === 'aguardando_validacao_manual' ||
        nextSession?.status === 'conectando'
      ) {
        toast(response.message || 'Aguardando autenticação manual no navegador aberto.');
      } else if (
        nextSession?.status === 'erro_login' ||
        nextSession?.status === 'login_error' ||
        nextSession?.error_code
      ) {
        toast.error(getSessionDisplayMessage(nextSession));
      } else if (nextSession?.status === 'sessao_expirada' || nextSession?.status === 'expired') {
        toast.error('A sessão expirou. Inicie novamente.');
      } else {
        toast.success(response.message || 'Sessão iniciada.');
      }
      await loadHistory();
    } catch (error) {
      const errorData = error instanceof ApiError ? (error.data as any) : null;
      const fallbackSession = errorData?.session || (errorData?.session_id ? {
        id: Number(errorData.session_id),
        user_id: getAccessSession()?.id || 0,
        status: String(errorData.status || errorData.code || 'erro').toLowerCase(),
        message: errorData.message || (error instanceof Error ? error.message : ''),
        error_code: String(errorData.code || '').toUpperCase() || null,
        stage: errorData.stage || null,
      } : null);
      if (fallbackSession) {
        setSession(fallbackSession as RibeiraoSession);
      } else {
        setSession(null);
        window.localStorage.removeItem(ROLE_SESSION_KEY);
      }
      toast.error(getFriendlyRibeiraoError(error, 'Falha ao iniciar sessão.'));
    } finally {
      setSessionLoading(false);
    }
  }

  async function handleQueryCpf() {
    if (!sessionReady || !session?.id) {
      toast.error(getSessionBlockingMessage(session));
      return;
    }
    const sessionId = session.id;

    const digits = cpf.replace(/\D/g, '');
    if (digits.length !== 11) {
      toast.error('Informe um CPF válido.');
      return;
    }

    try {
      setQueryLoading(true);
      const response = await api.queryRibeiraoCpf({
        session_id: sessionId,
        cpf: digits,
        login: login.trim(),
        password,
      });
      if (response.query) {
        setCurrentResult({
          ...response.query,
          client_matches: response.client_matches as RibeiraoHistoryItem['client_matches'],
        });
        toast.success('Consulta executada com sucesso.');
        await loadHistory();
        await refreshSessionStatus(sessionId);
      }
    } catch (error) {
      toast.error(getFriendlyRibeiraoError(error, 'Falha ao consultar CPF.'));
    } finally {
      setQueryLoading(false);
    }
  }

  async function handleApplyToClient(queryId: number, match: NonNullable<RibeiraoHistoryItem['client_matches']>[number]) {
    if (!match?.id) {
      toast.error('Cliente vinculado inválido.');
      return;
    }
    try {
      const response = await api.applyRibeiraoHistoryToClient(queryId, {
        client_id: match.id,
        base_id: match.base_id || undefined,
      });
      toast.success(`Margens atualizadas para ${response.client?.name || 'o cliente'}.`);
    } catch (error) {
      toast.error(getFriendlyRibeiraoError(error, 'Falha ao aplicar o resultado.'));
    }
  }

  async function handleBatchFileSelect(file: File | null) {
    if (!file) {
      setBatchPreview(null);
      return;
    }

    try {
      const response = await api.uploadRibeiraoBatchPreview(file);
      setBatchPreview(response.preview);
      setBatchPreviewFileName(response.file.name);
      toast.success(`Prévia carregada: ${response.preview.valid_rows} CPFs válidos.`);
    } catch (error) {
      setBatchPreview(null);
      toast.error(getFriendlyRibeiraoError(error, 'Falha ao analisar a planilha.'));
    }
  }

  async function handleStartBatch() {
    if (!selectedConnection) {
      toast.error('Selecione uma conexão antes de iniciar a consulta.');
      return;
    }
    if (selectedConnection !== 'prefeitura-ribeirao-preto') {
      toast.error('Esta conexão ainda está em preparação. Use Prefeitura de Ribeirão Preto por enquanto.');
      return;
    }
    if (!sessionReady || !session?.id) {
      toast.error('Para consultar em lote, primeiro conecte a sessão com o averbador.');
      return;
    }
    const sessionId = session.id;
    if (!login.trim() || !password.trim()) {
      toast.error('Informe login e senha da sessão.');
      return;
    }

    const delayMin = Number(batchDelayMin || 0);
    const delayMax = Number(batchDelayMax || 0);
    if (Number.isNaN(delayMin) || Number.isNaN(delayMax) || delayMin < 0 || delayMax < delayMin) {
      toast.error('Informe um intervalo válido entre consultas.');
      return;
    }

    if (batchSourceMode === 'upload' && !batchPreview?.cpfs?.length) {
      toast.error('Envie uma planilha com CPFs válidos antes de iniciar o lote.');
      return;
    }

    try {
      setBatchStartLoading(true);
      const response = await api.startRibeiraoBatch({
        session_id: sessionId,
        login: login.trim(),
        password,
        delay_seconds_min: delayMin,
        delay_seconds_max: delayMax,
        ...(batchSourceMode === 'upload'
          ? {
              source_type: 'upload' as const,
              source_file_name: batchPreviewFileName || 'planilha_upload',
              cpfs: batchPreview?.cpfs || [],
            }
          : {
              source_type: 'base' as const,
              base_id: batchBaseId,
            }),
      });
      setCurrentBatch(response.batch);
      setActiveTab('batch');
      toast.success(response.message || 'Lote iniciado.');
      await loadBatchHistory();
    } catch (error) {
      toast.error(getFriendlyRibeiraoError(error, 'Falha ao iniciar o lote.'));
    } finally {
      setBatchStartLoading(false);
    }
  }

  async function handlePauseBatch() {
    if (!currentBatch?.id) return;
    try {
      const response = await api.pauseRibeiraoBatch(currentBatch.id);
      setCurrentBatch(response.batch);
      await loadBatchHistory();
    } catch (error) {
      toast.error(getFriendlyRibeiraoError(error, 'Falha ao pausar o lote.'));
    }
  }

  async function handleResumeBatch() {
    if (!currentBatch?.id) return;
    try {
      const response = await api.resumeRibeiraoBatch(currentBatch.id);
      setCurrentBatch(response.batch);
      await loadBatchHistory();
    } catch (error) {
      toast.error(getFriendlyRibeiraoError(error, 'Falha ao continuar o lote.'));
    }
  }

  async function handleCancelBatch() {
    if (!currentBatch?.id) return;
    const confirmed = window.confirm('Tem certeza que deseja cancelar este lote?');
    if (!confirmed) {
      return;
    }
    try {
      const response = await api.cancelRibeiraoBatch(currentBatch.id);
      setCurrentBatch(response.batch);
      await loadBatchHistory();
    } catch (error) {
      toast.error(getFriendlyRibeiraoError(error, 'Falha ao cancelar o lote.'));
    }
  }

  async function handleExportBatch(batchId: number) {
    try {
      const blob = await api.exportRibeiraoBatch(batchId);
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `lote-ribeirao-${batchId}.xlsx`;
      anchor.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(getFriendlyRibeiraoError(error, 'Falha ao exportar o lote.'));
    }
  }

  async function openBatchDetails(batch: RibeiraoBatchRecord) {
    setActiveTab('batch');
    await loadBatchResults(batch.id, batch);
  }

  const selectedProducts = (currentResult?.margins || []) as ProductView[];
  const currentClientMatches = (currentResult?.client_matches || []).filter(
    (match): match is NonNullable<RibeiraoHistoryItem['client_matches']>[number] => Boolean(match && match.id)
  );
  const sessionReady = isConnectedSession(session);
  const currentSessionState = session?.status || 'desconhecido';

  const batchProgress = currentBatch
    ? currentBatch.total_cpfs
      ? Math.min(100, Math.round((currentBatch.processed_count / currentBatch.total_cpfs) * 100))
      : 0
    : 0;

  const selectedBase = bases.find((base) => String(base.id) === String(batchBaseId));
  const batchSourceSummary =
    batchSourceMode === 'upload'
      ? batchPreview
        ? `${batchPreview.valid_rows} CPFs válidos de ${batchPreview.total_rows} linhas`
        : 'Envie uma planilha para iniciar o lote'
      : batchBaseId === 'all'
        ? `${bases.length} bases ativas`
        : selectedBase
          ? `${selectedBase.total_clientes} clientes na base`
          : 'Selecione uma base importada';
  const selectedConnectionLabel = getMarginConnectionLabel(selectedConnection);
  const batchCpfCount = batchSourceMode === 'upload' ? batchPreview?.valid_rows || 0 : selectedBase?.total_clientes || 0;
  const canStartMarginBatch = Boolean(selectedConnection && batchSourceMode === 'upload' && batchPreview?.cpfs?.length);

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Consulta de Margem"
        description="Consulte margens em lote por conexão autorizada, com arquivo de CPFs e retorno pelo portal."
        action={<Badge tone="accent">Perfil: {sessionSession.role}</Badge>}
      />

      <div className="flex flex-wrap gap-3">
        <TabButton active={activeTab === 'individual'} onClick={() => setActiveTab('individual')}>
          Consulta individual
        </TabButton>
        <TabButton active={activeTab === 'batch'} onClick={() => setActiveTab('batch')}>
          Consulta em lote
        </TabButton>
        <TabButton active={activeTab === 'history'} onClick={() => setActiveTab('history')}>
          Histórico
        </TabButton>
      </div>

      <div className="grid gap-4 xl:grid-cols-4">
        <MetricCard label="Consultas" value={stats.total} icon={<Search size={18} />} />
        <MetricCard label="Com margem" value={stats.withMargin} icon={<CheckCircle2 size={18} />} />
        <MetricCard label="Sem margem" value={stats.withoutMargin} icon={<Sparkles size={18} />} />
        <MetricCard label="Erros / CAPTCHA" value={stats.errors + stats.captcha} icon={<ShieldAlert size={18} />} />
      </div>

      {activeTab === 'individual' ? (
        <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
          <Card className="p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm text-slate-400">Acesso ao averbador</p>
                <h3 className="mt-2 text-2xl font-bold text-white">Sessão autorizada</h3>
              </div>
              <Badge tone={sessionTone(currentSessionState)}>{sessionLabel(currentSessionState)}</Badge>
            </div>

            <div className="mt-5 space-y-4">
              <label className="block text-sm text-slate-300">
                Login
                <Input className="mt-2" value={login} onChange={(event) => setLogin(event.target.value)} placeholder="Usuário autorizado" />
              </label>
              <label className="block text-sm text-slate-300">
                Senha
                <Input className="mt-2" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Senha autorizada" />
              </label>

              <div className="rounded-2xl border border-border bg-bg/60 p-4 text-sm text-slate-300">
                <p className="font-semibold text-white">Status da sessão</p>
                <p className="mt-2 text-slate-400">{getSessionDisplayMessage(session)}</p>
                {session?.error_code || session?.stage ? (
                  <div className="mt-3 rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-xs text-slate-300">
                    <p>
                      Código técnico: <span className="font-semibold text-white">{session?.error_code || 'N/A'}</span>
                    </p>
                    <p className="mt-1">
                      Etapa: <span className="font-semibold text-white">{session?.stage || 'N/A'}</span>
                    </p>
                  </div>
                ) : null}
                {session?.id ? <p className="mt-2 text-xs text-slate-500">Sessão #{session.id}</p> : null}
              </div>

              {!ribeiraoUrlReady ? (
                <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
                  <p className="font-semibold text-white">URL do averbador não configurada no servidor.</p>
                  <p className="mt-1 text-amber-100/90">
                    {ribeiraoDiagnostics?.hint || 'Configure RIBEIRAO_AVERBADOR_URL no .env da VPS e reinicie os containers.'}
                  </p>
                  {ribeiraoDiagnostics?.ribeiraoHost ? (
                    <p className="mt-2 text-xs text-amber-50/80">
                      Host detectado: {ribeiraoDiagnostics.ribeiraoHost}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <Button className="py-4" onClick={() => void handleStartSession()} disabled={sessionLoading || !ribeiraoUrlReady}>
                  <UserRoundSearch size={16} />
                  {sessionLoading ? 'Iniciando...' : ribeiraoUrlReady ? 'Iniciar sessão' : 'Configure a URL do averbador'}
                </Button>
                <Button variant="secondary" className="py-4" onClick={() => void refreshSessionStatus()} disabled={sessionRefreshing || !session?.id}>
                  <RefreshCcw size={16} />
                  {sessionRefreshing ? 'Atualizando...' : 'Atualizar status'}
                </Button>
              </div>

              <div className="rounded-3xl border border-accent/20 bg-accent/10 p-4 text-sm text-slate-200">
                <p className="font-semibold text-white">Autenticação assistida</p>
                <p className="mt-1 text-slate-300">
                  Se o portal abrir uma confirmação manual, conclua no navegador aberto pelo sistema. A consulta continua assim que a sessão for validada.
                </p>
              </div>
            </div>
          </Card>

          <Card className="p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm text-slate-400">Consulta individual por CPF</p>
                <h3 className="mt-2 text-2xl font-bold text-white">Executar consulta</h3>
              </div>
              <Badge tone="neutral">{session?.id ? `Sessão ${session.id}` : 'Sem sessão'}</Badge>
            </div>

            <div className="mt-5 space-y-4">
              <label className="block text-sm text-slate-300">
                CPF
                <Input
                  className="mt-2"
                  value={cpf}
                  onChange={(event) => setCpf(event.target.value)}
                  placeholder="123.456.789-09"
                />
              </label>

              <Button className="w-full py-4 text-base" onClick={() => void handleQueryCpf()} disabled={queryLoading || !sessionReady || !ribeiraoUrlReady}>
                <Search size={16} />
                {queryLoading
                  ? 'Consultando margem no averbador...'
                  : !ribeiraoUrlReady
                    ? 'Configure a URL do averbador'
                    : sessionReady
                      ? 'Consultar margem'
                      : 'Conecte a sessão para consultar'}
              </Button>

              <div className="rounded-2xl border border-border bg-bg/60 p-4 text-sm text-slate-300">
                <p className="font-semibold text-white">Mensagem de apoio</p>
                <p className="mt-2 text-slate-400">
                  {sessionReady
                    ? 'O sistema salva a consulta, mascara o CPF no histórico e preserva o resultado bruto para auditoria.'
                    : getSessionBlockingMessage(session)}
                </p>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {activeTab === 'individual' ? (
        <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
          <Card className="p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-slate-400">Resultado da consulta</p>
                <h3 className="text-xl font-bold text-white">
                  {currentResult?.nome || currentResult?.cpf || 'Nenhum resultado carregado'}
                </h3>
              </div>
              {currentResult ? <Badge tone={queryTone(currentResult.consulta_status)}>{currentResult.consulta_status_label || currentResult.consulta_status}</Badge> : null}
            </div>

            {currentResult ? (
              <div className="mt-5 space-y-5">
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <InfoLine label="CPF" value={currentResult.cpf || '-'} />
                  <InfoLine label="Nome" value={currentResult.nome || '-'} />
                  <InfoLine label="Matrícula" value={currentResult.matricula || '-'} />
                  <InfoLine label="Órgão / Convênio" value={currentResult.orgao || '-'} />
                  <InfoLine label="Cargo" value={currentResult.cargo || '-'} />
                  <InfoLine label="Vínculo" value={currentResult.vinculo || '-'} />
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Margens explícitas</p>
                      <h4 className="mt-1 text-lg font-semibold text-white">Consignável e cartão com bruto e líquido</h4>
                    </div>
                    <Badge tone="accent">4 campos principais</Badge>
                  </div>

                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <ExplicitMarginCard title="Margem empréstimo total" value={currentResult.margem_emprestimo_total ?? currentResult.margem_consignavel_bruta} tone={marginTone(currentResult.margem_emprestimo_total ?? currentResult.margem_consignavel_bruta)} />
                    <ExplicitMarginCard title="Margem empréstimo disponível" value={currentResult.margem_emprestimo_disponivel ?? currentResult.margem_consignavel_liquida} tone={marginTone(currentResult.margem_emprestimo_disponivel ?? currentResult.margem_consignavel_liquida)} />
                    <ExplicitMarginCard title="Margem cartão total" value={currentResult.margem_cartao_total ?? currentResult.margem_cartao_bruta} tone={marginTone(currentResult.margem_cartao_total ?? currentResult.margem_cartao_bruta)} />
                    <ExplicitMarginCard title="Margem cartão disponível" value={currentResult.margem_cartao_disponivel ?? currentResult.margem_cartao_liquida} tone={marginTone(currentResult.margem_cartao_disponivel ?? currentResult.margem_cartao_liquida)} />
                  </div>
                </div>

                <div className="grid gap-4 lg:grid-cols-3">
                  {selectedProducts.map((product) => (
                    <ProductCard key={product.product_type} product={product} />
                  ))}
                </div>

                <div className="rounded-3xl border border-border bg-bg/60 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Mensagem da consulta</p>
                  <p className="mt-3 text-sm text-slate-200">{currentResult.mensagem || '-'}</p>
                  <div className="mt-3 text-xs text-slate-500">Consulta em {currentResult.created_at_formatted || currentResult.created_at || '-'}</div>
                </div>

                <div className="rounded-3xl border border-border bg-bg/60 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Bases vinculadas</p>
                      <h4 className="mt-1 text-lg font-semibold text-white">Cliente encontrado em bases importadas</h4>
                    </div>
                    <Badge tone="neutral">{currentClientMatches.length} registros</Badge>
                  </div>

                  {currentClientMatches.length ? (
                    <div className="mt-4 space-y-3">
                      {currentClientMatches.map((match) => (
                        <div key={match.id} className="rounded-2xl border border-border bg-panel p-4">
                          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                            <div>
                              <p className="font-semibold text-white">{match.name}</p>
                              <p className="mt-1 text-sm text-slate-400">
                                {match.base_name || '-'} {match.base_state ? `- ${match.base_state}` : ''}
                              </p>
                              <p className="mt-1 text-xs text-slate-500">
                                Atendimento: {match.status_atendimento || '-'} | Melhor margem: {match.best_product_type || '-'} {formatCurrencyDisplay(match.best_net_margin ?? null)}
                              </p>
                            </div>
                            <Button variant="secondary" onClick={() => void handleApplyToClient(currentResult.id, match)}>
                              <ArrowRight size={16} />
                              Atualizar cliente
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-2xl border border-dashed border-border bg-white/3 p-4 text-sm text-slate-500">
                      CPF não encontrado em bases importadas.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-5 rounded-3xl border border-dashed border-border bg-white/3 p-8 text-sm text-slate-500">
                Execute uma consulta para ver aqui os dados, as margens por produto e os resultados relacionados.
              </div>
            )}
          </Card>

          <Card className="p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-slate-400">Consulta em lote</p>
                <h3 className="text-xl font-bold text-white">Estrutura operacional</h3>
              </div>
              <Badge tone="neutral">Lote</Badge>
            </div>

            <div className="mt-4 space-y-3 text-sm text-slate-400">
              <p>Upload de CPFs ou seleção de base para processar em sequência.</p>
              <p>O fluxo permanece sequencial, com pausa automática para CAPTCHA e retomada manual.</p>
            </div>

            <div className="mt-5 rounded-3xl border border-border bg-bg/60 p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-300">Progresso</span>
                <span className="text-sm text-slate-500">{currentBatch ? `${currentBatch.processed_count}/${currentBatch.total_cpfs}` : '0/0'}</span>
              </div>
              <div className="mt-3 h-2 rounded-full bg-white/5">
                <div className="h-2 rounded-full bg-accent" style={{ width: `${batchProgress}%` }} />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-slate-500">
                <span>Total: {currentBatch?.total_cpfs || 0}</span>
                <span>Consultados: {currentBatch?.processed_count || 0}</span>
                <span>Sucesso: {currentBatch?.success_count || 0}</span>
                <span>Sem margem: {currentBatch?.no_margin_count || 0}</span>
                <span>Não encontrado: {currentBatch?.not_found_count || 0}</span>
                <span>Erros: {currentBatch?.error_count || 0}</span>
                <span>Captcha: {currentBatch?.captcha_count || 0}</span>
              </div>
              <Badge className="mt-4" tone={batchStatusTone(currentBatch?.status)}>
                {batchStatusLabel(currentBatch?.status)}
              </Badge>
            </div>

            <div className="mt-4 flex flex-wrap gap-3">
              <Button variant="secondary" className="py-4" onClick={() => setActiveTab('batch')}>
                Ir para lote
              </Button>
              {currentBatch?.id ? (
                <>
                  <Button variant="secondary" className="py-4" onClick={() => void handlePauseBatch()} disabled={!isBatchActive(currentBatch?.status)}>
                    <PauseCircle size={16} />
                    Pausar
                  </Button>
                  <Button variant="secondary" className="py-4" onClick={() => void handleResumeBatch()} disabled={currentBatch?.status !== 'pausado' && currentBatch?.status !== 'aguardando_captcha' && currentBatch?.status !== 'pausado_sessao_expirada'}>
                    <PlayCircle size={16} />
                    Continuar
                  </Button>
                  <Button variant="ghost" className="py-4" onClick={() => void handleCancelBatch()} disabled={currentBatch?.status === 'cancelado' || currentBatch?.status === 'concluido'}>
                    <StopCircle size={16} />
                    Cancelar
                  </Button>
                  <Button variant="ghost" className="py-4" onClick={() => void handleExportBatch(currentBatch.id)}>
                    <FileDown size={16} />
                    Exportar resultado
                  </Button>
                </>
              ) : null}
            </div>
          </Card>
        </div>
      ) : null}

      {activeTab === 'batch' ? (
        <div className="space-y-6">
          <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
            <div className="space-y-5">
              <Card className="border-cyan-400/15 bg-gradient-to-br from-[#07131d] via-panel to-[#07131d] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300/80">1. Conexão</p>
                    <h3 className="mt-2 text-xl font-bold text-white">Credenciais do portal</h3>
                    <p className="mt-1 text-sm text-slate-400">Selecione a conexão autorizada para consulta de margem.</p>
                  </div>
                  <Badge tone={selectedConnection ? 'success' : 'neutral'}>{selectedConnection ? 'Selecionada' : 'Pendente'}</Badge>
                </div>

                <label className="mt-5 block text-sm font-medium text-slate-300">
                  Credenciais do portal
                  <Select
                    className="mt-2 h-14 rounded-2xl border-cyan-400/20 bg-[#071018] px-4 text-base text-white shadow-inner shadow-black/30"
                    value={selectedConnection}
                    onChange={(event) => setSelectedConnection(event.target.value)}
                  >
                    <option value="">— selecione a conexão —</option>
                    <option value="prefeitura-ribeirao-preto">Prefeitura de Ribeirão Preto</option>
                    <option value="governo-amapa">Governo do Amapá</option>
                    <optgroup label="Governo de SP">
                      <option value="governo-sp-tjsp">Tribunal de Justiça de SP</option>
                    </optgroup>
                  </Select>
                </label>
              </Card>

              <Card className="border-cyan-400/15 bg-gradient-to-br from-[#07131d] via-panel to-[#07131d] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300/80">2. Arquivo CSV</p>
                    <h3 className="mt-2 text-xl font-bold text-white">Uma coluna de CPFs, com ou sem formatação</h3>
                  </div>
                  <Badge tone={batchPreview?.valid_rows ? 'success' : 'neutral'}>{batchPreview?.valid_rows || 0} CPFs</Badge>
                </div>

                <label className="mt-5 flex min-h-[170px] cursor-pointer flex-col items-center justify-center rounded-[28px] border border-dashed border-cyan-300/35 bg-[#061018]/80 px-6 py-8 text-center transition hover:border-lime-300/70 hover:bg-lime-300/5">
                  <Upload size={28} className="text-cyan-300" />
                  <span className="mt-3 text-lg font-bold text-white">Clique ou arraste o CSV para esta área</span>
                  <span className="mt-1 text-sm text-slate-400">.csv ou .txt • máx. 450 CPFs</span>
                  <input
                    className="hidden"
                    type="file"
                    accept=".csv,.txt"
                    onChange={(event) => void handleBatchFileSelect(event.target.files?.[0] || null)}
                  />
                </label>

                <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-slate-400">
                  {batchPreviewFileName ? (
                    <span className="text-slate-200">{batchPreviewFileName} • {batchSourceSummary}</span>
                  ) : (
                    'Apenas uma coluna será considerada para leitura dos CPFs.'
                  )}
                </div>
              </Card>

              <Card className="border-cyan-400/15 bg-gradient-to-br from-[#07131d] via-panel to-[#07131d] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-cyan-300/80">3. Retorno</p>
                <h3 className="mt-2 text-xl font-bold text-white">Como receber os resultados</h3>
                <label className="mt-5 block text-sm font-medium text-slate-300">
                  Retorno
                  <Select className="mt-2 h-14 rounded-2xl border-cyan-400/20 bg-[#071018] px-4 text-base text-white" value="portal" disabled>
                    <option value="portal">Apenas Portal</option>
                  </Select>
                </label>
              </Card>
            </div>

            <Card className="sticky top-5 h-fit border-cyan-400/20 bg-gradient-to-br from-[#081a22] via-panel to-[#071018] p-6 shadow-[0_24px_80px_rgba(0,0,0,0.35)]">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-slate-400">Resumo</p>
                  <h3 className="mt-1 text-2xl font-bold text-white">Pronto para consulta</h3>
                </div>
                <Badge tone={canStartMarginBatch ? 'success' : 'neutral'}>{canStartMarginBatch ? 'Liberado' : 'Aguardando'}</Badge>
              </div>

              <div className="mt-6 space-y-3">
                <SummaryRow label="Conexão" value={selectedConnectionLabel || '—'} />
                <SummaryRow label="CPFs" value={batchCpfCount} />
                <SummaryRow label="Saldo restante" value={0} />
                <SummaryRow label="Retorno" value={RETURN_CHANNEL} />
              </div>

              <Button
                className="mt-7 w-full rounded-2xl border border-lime-200/30 bg-lime-300 px-5 py-5 text-base font-black text-slate-950 shadow-[0_18px_50px_rgba(190,242,100,0.2)] transition hover:bg-lime-200 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/10 disabled:text-slate-500 disabled:shadow-none"
                onClick={() => void handleStartBatch()}
                disabled={batchStartLoading || !canStartMarginBatch}
              >
                <Search size={18} />
                {batchStartLoading ? 'Iniciando lote...' : 'Consultar Margem em Lote'}
              </Button>

              {!canStartMarginBatch ? (
                <p className="mt-3 text-center text-sm text-amber-100/80">Selecione uma conexão e envie um arquivo com CPFs.</p>
              ) : null}
              <p className="mt-4 text-center text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200/80">
                Conexão segura e criptografada
              </p>

              {currentBatch ? (
                <div className="mt-6 rounded-3xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-slate-300">Lote #{currentBatch.id}</span>
                    <span className="text-slate-500">{currentBatch.processed_count}/{currentBatch.total_cpfs}</span>
                  </div>
                  <div className="mt-3 h-2 rounded-full bg-white/10">
                    <div className="h-2 rounded-full bg-lime-300 transition-all" style={{ width: `${batchProgress}%` }} />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="secondary" className="px-3 py-2" onClick={() => void handlePauseBatch()} disabled={!isBatchActive(currentBatch?.status)}>
                      Pausar
                    </Button>
                    <Button variant="secondary" className="px-3 py-2" onClick={() => void handleResumeBatch()} disabled={currentBatch?.status !== 'pausado' && currentBatch?.status !== 'aguardando_captcha' && currentBatch?.status !== 'pausado_sessao_expirada'}>
                      Continuar
                    </Button>
                    <Button variant="ghost" className="px-3 py-2" onClick={() => void handleExportBatch(currentBatch.id)}>
                      Exportar
                    </Button>
                  </div>
                </div>
              ) : null}
            </Card>
          </div>

          <Card className="overflow-hidden border-cyan-400/15 bg-gradient-to-br from-[#07131d] via-panel to-[#07131d] shadow-[0_24px_80px_rgba(0,0,0,0.25)]">
            <div className="flex flex-col gap-3 border-b border-cyan-400/10 px-6 py-5 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="text-xl font-bold text-white">Consultas recentes</h3>
                <p className="mt-1 text-sm text-slate-500">Últimos lotes enviados para consulta de margem.</p>
              </div>
              <Badge tone="neutral">{batchHistory.length} registros</Badge>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-[900px] text-left text-sm">
                <thead className="bg-[#050d14] text-slate-400">
                  <tr>
                    {['ID', 'Conexão', 'CPFs', 'Data / Hora', 'Retorno', 'Status'].map((column) => (
                      <th key={column} className="px-6 py-4 font-medium">
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {batchHistory.length ? (
                    batchHistory.slice(0, 8).map((batch) => (
                      <tr key={batch.id} className="border-t border-white/10">
                        <td className="px-6 py-4 font-semibold text-white">#{batch.id}</td>
                        <td className="px-6 py-4 text-slate-300">{batchConnectionLabel(batch)}</td>
                        <td className="px-6 py-4 text-slate-300">{batch.total_cpfs}</td>
                        <td className="px-6 py-4 text-slate-300">{formatBatchDate(batch.created_at)}</td>
                        <td className="px-6 py-4 text-slate-300">Portal</td>
                        <td className="px-6 py-4">
                          <Badge tone={batchStatusTone(batch.status)}>{batchStatusLabel(batch.status)}</Badge>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="px-6 py-8 text-center text-slate-500">
                        Nenhuma consulta recente encontrada.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}

      {false && activeTab === 'batch' ? (
        <div className="space-y-6">
          <div className="grid gap-6 xl:grid-cols-[1.05fr_0.95fr]">
            <Card className="p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-slate-400">Origem dos CPFs</p>
                  <h3 className="mt-2 text-2xl font-bold text-white">Consulta em lote</h3>
                </div>
                <Badge tone="accent">Sequencial</Badge>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-2">
                <Button variant={batchSourceMode === 'upload' ? 'primary' : 'secondary'} className="py-4" onClick={() => setBatchSourceMode('upload')}>
                  <Upload size={16} />
                  Enviar planilha
                </Button>
                <Button variant={batchSourceMode === 'base' ? 'primary' : 'secondary'} className="py-4" onClick={() => setBatchSourceMode('base')}>
                  <LayersIcon />
                  Usar base do CRM
                </Button>
              </div>

              {batchSourceMode === 'upload' ? (
                <div className="mt-5 space-y-4">
                  <label className="block text-sm text-slate-300">
                    Arquivo de CPFs
                    <Input
                      className="mt-2"
                      type="file"
                      accept=".xlsx,.xls,.csv"
                      onChange={(event) => void handleBatchFileSelect(event.target.files?.[0] || null)}
                    />
                  </label>

                  <div className="rounded-2xl border border-border bg-bg/60 p-4 text-sm text-slate-300">
                    <p className="font-semibold text-white">Prévia do lote</p>
                    <p className="mt-2 text-slate-400">{batchSourceSummary}</p>
                    {batchPreview ? (
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500">
                        <span>Total: {batchPreview.total_rows}</span>
                        <span>Válidos: {batchPreview.valid_rows}</span>
                        <span>Inválidos: {batchPreview.invalid_rows}</span>
                        <span>Coluna: {batchPreview.cpf_column || '-'}</span>
                      </div>
                    ) : null}
                  </div>

                  {batchPreview ? (
                    <div className="overflow-x-auto rounded-3xl border border-border">
                      <table className="min-w-[760px] text-left text-sm">
                        <thead className="bg-bg/80 text-slate-400">
                          <tr>
                            {['Linha', 'CPF', 'Status', 'Alertas'].map((column) => (
                              <th key={column} className="px-4 py-3 font-medium">
                                {column}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {batchPreview.preview_rows.slice(0, 8).map((row) => (
                            <tr key={row.rowNumber} className="border-t border-border/80">
                              <td className="px-4 py-3 text-slate-300">{row.rowNumber}</td>
                              <td className="px-4 py-3 text-slate-300">{row.cpf_display}</td>
                              <td className="px-4 py-3">
                                <Badge tone={row.isValid ? 'success' : 'danger'}>{row.isValid ? 'Válido' : 'Inválido'}</Badge>
                              </td>
                              <td className="px-4 py-3 text-slate-400">{row.alerts.join(' • ') || '-'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="mt-5 space-y-4">
                  <label className="block text-sm text-slate-300">
                    Selecionar base
                    <Select className="mt-2" value={batchBaseId} onChange={(event) => setBatchBaseId(event.target.value)}>
                      <option value="all">Todas as bases ativas</option>
                      {bases.map((base) => (
                        <option key={base.id} value={base.id}>
                          {base.nome_base}
                        </option>
                      ))}
                    </Select>
                  </label>

                  <div className="rounded-2xl border border-border bg-bg/60 p-4 text-sm text-slate-300">
                    <p className="font-semibold text-white">Resumo da base</p>
                    <p className="mt-2 text-slate-400">{batchSourceSummary}</p>
                    {batchBaseId !== 'all' && selectedBase ? (
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-slate-500">
                        <span>Tipo: {selectedBase.tipo_base || '-'}</span>
                        <span>Convênio: {selectedBase.convenio || '-'}</span>
                        <span>Estado: {selectedBase.estado || '-'}</span>
                        <span>Cidade: {selectedBase.cidade || '-'}</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              )}

              <div className="mt-5 grid gap-3 md:grid-cols-2">
                <label className="block text-sm text-slate-300">
                  Intervalo mínimo entre consultas
                  <Input className="mt-2" type="number" min="0" step="1" value={batchDelayMin} onChange={(event) => setBatchDelayMin(event.target.value)} />
                </label>
                <label className="block text-sm text-slate-300">
                  Intervalo máximo entre consultas
                  <Input className="mt-2" type="number" min="0" step="1" value={batchDelayMax} onChange={(event) => setBatchDelayMax(event.target.value)} />
                </label>
              </div>

              <Button className="mt-5 w-full py-4 text-base" onClick={() => void handleStartBatch()} disabled={batchStartLoading || !sessionReady || !ribeiraoUrlReady}>
                <Search size={16} />
                {batchStartLoading
                  ? 'Iniciando lote...'
                  : !ribeiraoUrlReady
                    ? 'Configure a URL do averbador'
                    : sessionReady
                      ? 'Iniciar consulta em lote'
                      : 'Conecte a sessão para consultar em lote'}
              </Button>
            </Card>

            <Card className="p-6">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-slate-400">Progresso</p>
                  <h3 className="mt-2 text-2xl font-bold text-white">
                    {currentBatch ? `Lote #${currentBatch.id}` : 'Nenhum lote em execução'}
                  </h3>
                </div>
                <Badge tone={batchStatusTone(currentBatch?.status)}>{batchStatusLabel(currentBatch?.status)}</Badge>
              </div>

              <div className="mt-5 rounded-2xl border border-border bg-bg/60 p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-300">Progresso</span>
                  <span className="text-sm text-slate-500">{currentBatch ? `${currentBatch.processed_count}/${currentBatch.total_cpfs}` : '0/0'}</span>
                </div>
                <div className="mt-3 h-2 rounded-full bg-white/5">
                  <div className="h-2 rounded-full bg-accent transition-all" style={{ width: `${batchProgress}%` }} />
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
                <StatLine label="Total" value={currentBatch?.total_cpfs || 0} />
                <StatLine label="Consultados" value={currentBatch?.processed_count || 0} />
                <StatLine label="Sucesso" value={currentBatch?.success_count || 0} />
                <StatLine label="Sem margem" value={currentBatch?.no_margin_count || 0} />
                <StatLine label="Não encontrado" value={currentBatch?.not_found_count || 0} />
                <StatLine label="Erros" value={currentBatch?.error_count || 0} />
                <StatLine label="CAPTCHA" value={currentBatch?.captcha_count || 0} />
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <Button variant="secondary" onClick={() => void handlePauseBatch()} disabled={!isBatchActive(currentBatch?.status)}>
                  <PauseCircle size={16} />
                  Pausar
                </Button>
                <Button variant="secondary" onClick={() => void handleResumeBatch()} disabled={currentBatch?.status !== 'pausado' && currentBatch?.status !== 'aguardando_captcha' && currentBatch?.status !== 'pausado_sessao_expirada'}>
                  <PlayCircle size={16} />
                  Continuar
                </Button>
                <Button variant="ghost" onClick={() => void handleCancelBatch()} disabled={!currentBatch || currentBatch.status === 'cancelado' || currentBatch.status === 'concluido'}>
                  <StopCircle size={16} />
                  Cancelar
                </Button>
                {currentBatch?.id ? (
                  <Button variant="ghost" onClick={() => void handleExportBatch(currentBatch.id)}>
                    <FileDown size={16} />
                    Exportar resultado
                  </Button>
                ) : null}
              </div>
            </Card>
          </div>

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-white">Histórico de lotes</h3>
                <p className="text-sm text-slate-500">Acompanhe origem, status e progresso dos lotes.</p>
              </div>
              <Badge tone="neutral">{batchStats.total} lotes</Badge>
            </div>

            {batchHistoryLoading ? (
              <div className="p-8 text-sm text-slate-400">Carregando histórico de lotes...</div>
            ) : batchHistory.length ? (
              <div className="overflow-x-auto">
                <table className="min-w-[1500px] text-left text-sm">
                  <thead className="bg-bg/80 text-slate-400">
                    <tr>
                      {['Data/hora', 'Origem', 'Base', 'Total', 'Consultados', 'Sucesso', 'Sem margem', 'Não encontrado', 'Erros', 'Status do lote', 'Usuário', 'Ações'].map((column) => (
                        <th key={column} className="px-5 py-4 font-medium">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {batchHistory.map((batch) => (
                      <tr key={batch.id} className="border-t border-border/80">
                        <td className="px-5 py-4 text-slate-300">{formatBatchDate(batch.created_at)}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.source_type || '-'}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.base_name || batch.source_file_name || '-'}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.total_cpfs}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.processed_count}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.success_count}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.no_margin_count}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.not_found_count || 0}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.error_count}</td>
                        <td className="px-5 py-4">
                          <Badge tone={batchStatusTone(batch.status)}>{batchStatusLabel(batch.status)}</Badge>
                        </td>
                        <td className="px-5 py-4 text-slate-300">{batch.user_name || '-'}</td>
                        <td className="px-5 py-4">
                          <div className="flex flex-wrap gap-2">
                            <Button variant="secondary" className="px-4 py-2" onClick={() => void openBatchDetails(batch)}>
                              Ver detalhes
                            </Button>
                            <Button variant="ghost" className="px-4 py-2" onClick={() => void handleExportBatch(batch.id)}>
                              Exportar
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-8 text-sm text-slate-500">Nenhum lote encontrado.</div>
            )}
          </Card>

          {selectedBatch ? (
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-border px-5 py-4">
                <div>
                  <h3 className="text-lg font-semibold text-white">Resultados do lote #{selectedBatch.id}</h3>
                  <p className="text-sm text-slate-500">
                    {selectedBatch.base_name || selectedBatch.source_file_name || 'Origem não informada'} · {batchStatusLabel(selectedBatch.status)}
                  </p>
                </div>
                <Badge tone={batchStatusTone(selectedBatch.status)}>{selectedBatch.processed_count}/{selectedBatch.total_cpfs}</Badge>
              </div>

              {batchResultsLoading ? (
                <div className="p-8 text-sm text-slate-400">Carregando resultados do lote...</div>
              ) : batchResults.length ? (
                <div className="overflow-x-auto">
                  <table className="min-w-[1700px] text-left text-sm">
                    <thead className="bg-bg/80 text-slate-400">
                      <tr>
                        {['CPF', 'Nome', 'Matrícula', 'Cargo', 'Vínculo', 'Status consulta', 'Melhor produto', 'Melhor margem líquida', 'Empréstimo total', 'Empréstimo disponível', 'Cartão total', 'Cartão disponível', 'Mensagem', 'Data/hora', 'Ação'].map((column) => (
                          <th key={column} className="px-5 py-4 font-medium">
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {batchResults.map((item) => (
                        <tr key={item.id} className="border-t border-border/80">
                          <td className="px-5 py-4 text-slate-300">{item.cpf || '-'}</td>
                          <td className="px-5 py-4">
                            <p className="font-semibold text-white">{item.nome || '-'}</p>
                            <p className="mt-1 text-xs text-slate-500">{item.orgao || item.matricula || '-'}</p>
                          </td>
                          <td className="px-5 py-4 text-slate-300">{item.matricula || '-'}</td>
                          <td className="px-5 py-4 text-slate-300">{item.cargo || '-'}</td>
                          <td className="px-5 py-4 text-slate-300">{item.vinculo || '-'}</td>
                          <td className="px-5 py-4">
                            <Badge tone={queryTone(item.consulta_status)}>{item.consulta_status_label || item.consulta_status}</Badge>
                          </td>
                          <td className="px-5 py-4 text-slate-300">{item.best_product_type || '-'}</td>
                          <td className="px-5 py-4 text-slate-300">{item.best_net_margin_formatted || formatCurrencyDisplay(item.best_net_margin ?? null)}</td>
                          <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(item.margem_emprestimo_total ?? getBatchNetMargin(item, 'credito'))}</td>
                          <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(item.margem_emprestimo_disponivel ?? getBatchNetMargin(item, 'credito'))}</td>
                          <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(item.margem_cartao_total ?? null)}</td>
                          <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(item.margem_cartao_disponivel ?? null)}</td>
                          <td className="px-5 py-4 text-slate-300">{item.mensagem || '-'}</td>
                          <td className="px-5 py-4 text-slate-300">{item.created_at_formatted || item.created_at || '-'}</td>
                          <td className="px-5 py-4">
                            {(item.client_matches || []).filter((match) => Boolean(match && match.id)).length ? (
                              <div className="space-y-2">
                                {(item.client_matches || [])
                                  .filter((match): match is NonNullable<RibeiraoHistoryItem['client_matches']>[number] => Boolean(match && match.id))
                                  .map((match) => (
                                    <div key={match.id} className="flex items-center gap-2">
                                      <Button variant="secondary" className="px-4 py-2" onClick={() => void handleApplyToClient(item.id, match)}>
                                        Atualizar cliente
                                      </Button>
                                      <span className="text-xs text-slate-500">{match.base_name || '-'}</span>
                                    </div>
                                  ))}
                              </div>
                            ) : (
                              <span className="text-slate-500">Sem cliente</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-8 text-sm text-slate-500">Nenhum resultado encontrado para este lote.</div>
              )}
            </Card>
          ) : null}
        </div>
      ) : null}

      {activeTab === 'history' ? (
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-white">Histórico de lotes</h3>
                <p className="text-sm text-slate-500">Filtre os lotes concluídos, pausados e em execução.</p>
              </div>
              <Badge tone="neutral">{batchStats.total} lotes</Badge>
            </div>

            {batchHistoryLoading ? (
              <div className="p-8 text-sm text-slate-400">Carregando histórico de lotes...</div>
            ) : batchHistory.length ? (
              <div className="overflow-x-auto">
                <table className="min-w-[1500px] text-left text-sm">
                  <thead className="bg-bg/80 text-slate-400">
                    <tr>
                      {['Data/hora', 'Origem', 'Base', 'Total de CPFs', 'Consultados', 'Sucesso', 'Sem margem', 'Não encontrado', 'Erros', 'Status do lote', 'Usuário', 'Ações'].map((column) => (
                        <th key={column} className="px-5 py-4 font-medium">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {batchHistory.map((batch) => (
                      <tr key={batch.id} className="border-t border-border/80">
                        <td className="px-5 py-4 text-slate-300">{formatBatchDate(batch.created_at)}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.source_type || '-'}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.base_name || batch.source_file_name || '-'}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.total_cpfs}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.processed_count}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.success_count}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.no_margin_count}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.not_found_count || 0}</td>
                        <td className="px-5 py-4 text-slate-300">{batch.error_count}</td>
                        <td className="px-5 py-4">
                          <Badge tone={batchStatusTone(batch.status)}>{batchStatusLabel(batch.status)}</Badge>
                        </td>
                        <td className="px-5 py-4 text-slate-300">{batch.user_name || '-'}</td>
                        <td className="px-5 py-4">
                          <div className="flex flex-wrap gap-2">
                            <Button variant="secondary" className="px-4 py-2" onClick={() => void openBatchDetails(batch)}>
                              Ver detalhes
                            </Button>
                            <Button variant="ghost" className="px-4 py-2" onClick={() => void handleExportBatch(batch.id)}>
                              Exportar
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-8 text-sm text-slate-500">Nenhum lote encontrado.</div>
            )}
          </Card>

          <Card className="overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h3 className="text-lg font-semibold text-white">Histórico de consultas individuais</h3>
                <p className="text-sm text-slate-500">Filtre por período, CPF, usuário e status.</p>
              </div>
              <Badge tone="neutral">{visibleHistory.length} registros</Badge>
            </div>

            <div className="grid gap-3 border-b border-border bg-white/3 px-5 py-4 xl:grid-cols-6">
              <label className="block text-sm text-slate-300">
                Período inicial
                <Input className="mt-2" type="date" value={historyFilters.from} onChange={(event) => setHistoryFilters((current) => ({ ...current, from: event.target.value }))} />
              </label>
              <label className="block text-sm text-slate-300">
                Período final
                <Input className="mt-2" type="date" value={historyFilters.to} onChange={(event) => setHistoryFilters((current) => ({ ...current, to: event.target.value }))} />
              </label>
              <label className="block text-sm text-slate-300">
                Status
                <Select className="mt-2" value={historyFilters.status} onChange={(event) => setHistoryFilters((current) => ({ ...current, status: event.target.value }))}>
                      <option value="">Todos</option>
                      <option value="com_marg">Com margem</option>
                      <option value="sem_marg">Sem margem</option>
                      <option value="nao_encontrado">Nao encontrado</option>
                      <option value="erro">Erro</option>
                      <option value="captcha_required">CAPTCHA</option>
                      <option value="login_error">Login</option>
                </Select>
              </label>
              <label className="block text-sm text-slate-300">
                CPF
                <Input className="mt-2" value={historyFilters.cpf} onChange={(event) => setHistoryFilters((current) => ({ ...current, cpf: event.target.value }))} placeholder="CPF ou parte" />
              </label>
              <label className="block text-sm text-slate-300">
                Usuário
                <Input className="mt-2" value={historyFilters.user_id} onChange={(event) => setHistoryFilters((current) => ({ ...current, user_id: event.target.value }))} placeholder="ID do usuário" />
              </label>
              <div className="flex items-end gap-2">
                <Button className="w-full py-3" onClick={() => void loadHistory(historyFilters)} disabled={historyLoading}>
                  <RefreshCcw size={16} />
                  Filtrar
                </Button>
              </div>
            </div>

            {historyLoading ? (
              <div className="p-8 text-sm text-slate-400">Carregando histórico...</div>
            ) : history.length ? (
              <div className="overflow-x-auto">
                <table className="min-w-[1500px] text-left text-sm">
                  <thead className="bg-bg/80 text-slate-400">
                    <tr>
                      {['Data/hora', 'CPF', 'Nome', 'Status', 'Melhor margem', 'Usuário', 'Ações'].map((column) => (
                        <th key={column} className="px-5 py-4 font-medium">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((item) => (
                      <tr key={item.id} className="border-t border-border/80">
                        <td className="px-5 py-4 text-slate-300">{item.created_at_formatted || item.created_at || '-'}</td>
                        <td className="px-5 py-4 text-slate-300">{item.cpf || '-'}</td>
                        <td className="px-5 py-4">
                          <p className="font-semibold text-white">{item.nome || '-'}</p>
                          <p className="mt-1 text-xs text-slate-500">{item.orgao || item.matricula || '-'}</p>
                        </td>
                        <td className="px-5 py-4">
                          <Badge tone={queryTone(item.consulta_status)}>{item.consulta_status_label || item.consulta_status}</Badge>
                        </td>
                        <td className="px-5 py-4 text-slate-300">
                          {item.best_product_type || '-'} {item.best_net_margin_formatted || formatCurrencyDisplay(item.best_net_margin ?? null)}
                        </td>
                        <td className="px-5 py-4 text-slate-300">{item.user_name || '-'}</td>
                        <td className="px-5 py-4">
                          <Button variant="secondary" className="px-4 py-2" onClick={() => void handleOpenHistory(item)}>
                            Ver detalhes
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-8 text-sm text-slate-500">Nenhuma consulta encontrada para os filtros aplicados.</div>
            )}
          </Card>
        </div>
      ) : null}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-black/20 px-4 py-3">
      <span className="text-sm text-slate-400">{label}</span>
      <span className="text-right text-sm font-bold text-white">{value}</span>
    </div>
  );
}

function getMarginConnectionLabel(value: string) {
  return MARGIN_CONNECTIONS.find((connection) => connection.value === value)?.label || '';
}

function batchConnectionLabel(batch: RibeiraoBatchRecord) {
  if (String(batch.base_name || batch.source_file_name || '').toLowerCase().includes('amap')) {
    return 'Governo do Amapá';
  }
  if (String(batch.base_name || batch.source_file_name || '').toLowerCase().includes('tjsp')) {
    return 'Governo de SP / Tribunal de Justiça de SP';
  }
  return 'Prefeitura de Ribeirão Preto';
}

function MetricCard({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-400">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-white">{value}</p>
        </div>
        <div className="rounded-2xl border border-white/8 bg-white/5 p-3 text-accent">{icon}</div>
      </div>
    </Card>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'rounded-2xl border px-4 py-3 text-sm font-medium transition',
        active
          ? 'border-accent/20 bg-accent/12 text-white'
          : 'border-border bg-panel text-slate-400 hover:bg-white/5 hover:text-slate-100',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg/60 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

function ExplicitMarginCard({ title, value, tone }: { title: string; value: number | null | undefined; tone: ReturnType<typeof marginTone>['tone'] }) {
  return (
    <div className="rounded-3xl border border-border bg-bg/60 p-5">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-white">{title}</h4>
        <Badge tone={tone}>{marginLabel(value)}</Badge>
      </div>
      <p className="mt-4 text-2xl font-bold tracking-tight text-white">{formatCurrencyDisplay(value ?? null)}</p>
    </div>
  );
}

function ProductCard({ product }: { product: ProductView }) {
  return (
    <div className="rounded-3xl border border-border bg-bg/60 p-5">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-lg font-semibold text-white">{productLabel(product.product_type)}</h4>
        <Badge tone={product.state?.tone || marginTone(product.net_margin)}>{product.state?.label || marginLabel(product.net_margin)}</Badge>
      </div>
      <div className="mt-4 space-y-2 text-sm">
        <div>
          <p className="text-slate-400">Margem bruta</p>
          <p className="font-semibold text-white">{formatCurrencyDisplay(product.gross_margin ?? null)}</p>
        </div>
        <div>
          <p className="text-slate-400">Margem líquida</p>
          <p className="font-semibold text-white">{formatCurrencyDisplay(product.net_margin ?? null)}</p>
        </div>
      </div>
    </div>
  );
}

function StatLine({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-border bg-bg/60 px-4 py-3">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-2 text-lg font-semibold text-white">{value}</p>
    </div>
  );
}

function queryTone(status?: string) {
  if (status === 'com_marg') return 'success';
  if (status === 'nao_encontrado') return 'neutral';
  if (status === 'erro' || status === 'login_error') return 'danger';
  if (status === 'captcha_required') return 'info';
  return 'neutral';
}

function sessionTone(status?: RibeiraoSessionStatus) {
  if (status === 'no_conectado') return 'neutral';
  if (status === 'conectado') return 'success';
  if (status === 'aguardando_captcha_manual' || status === 'aguardando_validacao_manual' || status === 'captcha_required') return 'info';
  if (status === 'erro_login' || status === 'login_error' || status === 'sessao_expirada' || status === 'expired' || status === 'erro' || status === 'portal_unavailable' || status === 'error') return 'danger';
  return 'neutral';
}

function sessionLabel(status?: RibeiraoSessionStatus) {
  if (status === 'no_conectado') return 'Não conectado';
  if (status === 'conectado') return 'Conectado';
  if (status === 'aguardando_captcha_manual' || status === 'aguardando_validacao_manual' || status === 'captcha_required') return 'Aguardando validação manual';
  if (status === 'erro_login' || status === 'login_error') return 'Erro de login';
  if (status === 'sessao_expirada' || status === 'expired') return 'Sessão expirada';
  if (status === 'conectando') return 'Conectando ao portal';
  if (status === 'erro' || status === 'portal_unavailable' || status === 'error') return 'Erro de conexão';
  return 'Não conectado';
}

function productLabel(productType: string) {
  if (productType === 'consignacao') return 'Consignação';
  if (productType === 'credito') return 'Crédito';
  if (productType === 'cartao') return 'Cartão';
  return productType || 'Outros';
}

function marginTone(value: number | null | undefined) {
  if (value === null || value === undefined) return 'neutral';
  if (value > 0) return 'success';
  if (value === 0) return 'neutral';
  return 'danger';
}

function marginLabel(value: number | null | undefined) {
  if (value === null || value === undefined) return 'Sem dado';
  if (value > 0) return 'Disponível';
  if (value === 0) return 'Sem margem';
  return 'Negativa';
}

function isConnectedSession(session?: RibeiraoSession | null) {
  return Boolean(session && session.id && session.status === 'conectado');
}

function getSessionBlockingMessage(session?: RibeiraoSession | null) {
  if (!session?.id) {
    return 'Nenhuma sessão ativa com o portal da Prefeitura. Inicie a sessão antes de consultar.';
  }
  const errorCode = String(session.error_code || '').toUpperCase();
  if (session.status === 'conectando') {
    return 'A sessão ainda está conectando ao portal. Aguarde a autenticação manual e clique em Atualizar status.';
  }
  if (session.status === 'aguardando_captcha_manual' || session.status === 'aguardando_validacao_manual' || session.status === 'captcha_required') {
    return 'O portal solicitou validação manual. Resolva no navegador aberto e clique em Atualizar status.';
  }
  if (['LOGIN_FIELDS_NOT_FOUND', 'LOGIN_BUTTON_NOT_FOUND'].includes(errorCode)) {
    return errorCode === 'LOGIN_FIELDS_NOT_FOUND'
      ? 'O sistema não encontrou os campos de login do portal. O layout pode ter mudado.'
      : 'O sistema não encontrou o botão de login do portal.';
  }
  if (['LOGIN_TIMEOUT', 'LOGIN_STILL_ON_SAME_PAGE'].includes(errorCode)) {
    return errorCode === 'LOGIN_TIMEOUT'
      ? 'O portal não respondeu após tentar login.'
      : 'O portal não avançou após informar o login. Pode ser validação por JavaScript, certificado digital ou bloqueio do portal.';
  }
  if (['PORTAL_CHANGED', 'SELECTOR_ERROR', 'CONVENIO_ACTION_NOT_FOUND', 'CONVENIO_SELECTION_FAILED', 'CONVENIO_NOT_FOUND', 'LOGIN_OK_NAVIGATION_FAILED', 'LOGIN_REJECTED', 'UNKNOWN_LOGIN_ERROR', 'DNS_RESOLUTION_FAILED', 'CHROMIUM_DNS_FAILED', 'WORKER_INTERNAL_ERROR', 'USER_ALREADY_LOGGED_CONFIRM_FAILED'].includes(errorCode) || session.status === 'erro_login' || session.status === 'login_error') {
    if (errorCode === 'LOGIN_OK_NAVIGATION_FAILED') {
      return 'Login aceito, mas não foi possível abrir Consulta de Margem.';
    }
    if (errorCode === 'DNS_RESOLUTION_FAILED') {
      return 'Não foi possível resolver o endereço do portal no servidor. Verifique DNS da VPS/container.';
    }
    if (errorCode === 'PORTAL_CHANGED') {
      return 'O layout do portal mudou e o fluxo de login não foi reconhecido.';
    }
    if (errorCode === 'SELECTOR_ERROR') {
      return 'O sistema encontrou o portal, mas não reconheceu os elementos de login nesta tela.';
    }
    if (errorCode === 'CONVENIO_ACTION_NOT_FOUND') {
      return 'O login foi aceito, mas o sistema não encontrou o botão de acesso do convênio.';
    }
    if (errorCode === 'CONVENIO_SELECTION_FAILED') {
      return 'O login foi aceito, mas o portal não avançou após selecionar o convênio.';
    }
    if (errorCode === 'CONVENIO_NOT_FOUND') {
      return 'O login foi aceito, mas o convênio de Ribeirão Preto não foi encontrado.';
    }
    if (errorCode === 'PORTAL_UNREACHABLE') {
      return 'Não foi possível acessar o portal da Prefeitura no momento.';
    }
    if (errorCode === 'LOGIN_REJECTED') {
      return 'O portal recusou o login/senha informados.';
    }
    return 'Login ou senha do averbador inválidos.';
  }
  if (session.status === 'sessao_expirada' || session.status === 'expired') {
    return 'A sessão expirou. Inicie uma nova sessão para continuar.';
  }
  if (session.status === 'erro' || session.status === 'portal_unavailable' || session.status === 'error') {
    return 'Não foi possível acessar o portal da Prefeitura no momento.';
  }
  return 'Você precisa iniciar e validar a sessão com o portal antes de consultar CPF.';
}

function getSessionDisplayMessage(session?: RibeiraoSession | null) {
  if (!session?.id) {
    return 'Não conectado. Inicie a sessão e conclua a autenticação no navegador aberto.';
  }

  const status = String(session.status || '').toLowerCase();
  const message = String(session.message || '').trim();
  const errorCode = String(session.error_code || '').toUpperCase();

  if (status === 'conectado') {
    return !isTechnicalBrowserMessage(message) && message ? message : 'Sessão conectada com sucesso.';
  }
  if (status === 'conectando') {
    return 'Conectando ao portal. Aguarde a autenticação manual e clique em Atualizar status.';
  }
  if (status === 'aguardando_captcha_manual' || status === 'aguardando_validacao_manual' || status === 'captcha_required') {
    return 'O portal solicitou validação manual. Resolva no navegador aberto e clique em Atualizar status.';
  }
  if (errorCode === 'LOGIN_FIELDS_NOT_FOUND') {
    return 'O sistema não encontrou os campos de login do portal. O layout pode ter mudado.';
  }
  if (errorCode === 'LOGIN_BUTTON_NOT_FOUND') {
    return 'O sistema não encontrou o botão de login do portal.';
  }
  if (errorCode === 'LOGIN_PASSWORD_FIELD_NOT_FOUND') {
    return 'O sistema chegou na segunda etapa do login, mas não encontrou o campo de senha.';
  }
  if (errorCode === 'CONVENIO_ACTION_NOT_FOUND') {
    return 'O login foi aceito, mas o sistema não encontrou o botão de acesso do convênio.';
  }
  if (errorCode === 'CONVENIO_SELECTION_FAILED') {
    return 'O login foi aceito, mas o portal não avançou após selecionar o convênio.';
  }
  if (errorCode === 'CONVENIO_NOT_FOUND') {
    return 'O login foi aceito, mas o convênio de Ribeirão Preto não foi encontrado.';
  }
  if (errorCode === 'LOGIN_TIMEOUT') {
    return 'O portal não respondeu após tentar login.';
  }
  if (errorCode === 'LOGIN_STILL_ON_SAME_PAGE') {
    return 'O portal não avançou após informar o login. Pode ser validação por JavaScript, certificado digital ou bloqueio do portal.';
  }
  if (errorCode === 'LOGIN_OK_NAVIGATION_FAILED') {
    return 'Login aceito, mas não foi possível abrir Consulta de Margem.';
  }
  if (errorCode === 'DNS_RESOLUTION_FAILED') {
    return 'Não foi possível resolver o endereço do portal no servidor. Verifique DNS da VPS/container.';
  }
  if (errorCode === 'CHROMIUM_DNS_FAILED') {
    return 'O navegador interno do servidor não conseguiu resolver o portal, mesmo com DNS do container funcionando.';
  }
  if (errorCode === 'WORKER_INTERNAL_ERROR') {
    return 'Erro interno no worker de login.';
  }
  if (errorCode === 'USER_ALREADY_LOGGED_CONFIRM_FAILED') {
    return 'O portal informou que o usu?rio j? estava logado, mas n?o foi poss?vel confirmar a desconex?o autom?tica.';
  }
  if (errorCode === 'PORTAL_CHANGED') {
    return 'O layout do portal mudou e o fluxo de login não foi reconhecido.';
  }
  if (errorCode === 'SELECTOR_ERROR') {
    return 'O sistema encontrou o portal, mas não reconheceu os elementos de login nesta tela.';
  }
  if (errorCode === 'PORTAL_UNREACHABLE') {
    return 'Não foi possível acessar o portal da Prefeitura no momento.';
  }
  if (errorCode === 'LOGIN_REJECTED') {
    return 'O portal recusou o login/senha informados.';
  }
  if (status === 'portal_unreachable' || status === 'portal_unavailable') {
    return 'Não foi possível acessar o portal da Prefeitura no momento.';
  }
  if (status === 'erro_login' || status === 'login_error') {
    return 'O portal recusou o login/senha informados.';
  }
  if (status === 'sessao_expirada' || status === 'expired') {
    return 'A sessão expirou. Inicie uma nova sessão para continuar.';
  }
  if (status === 'erro' || status === 'portal_unavailable' || status === 'browser_launch_error' || status === 'error') {
    return 'Erro ao iniciar navegador de consulta no servidor. Verifique configuração do Playwright em produção.';
  }
  return !isTechnicalBrowserMessage(message) && message ? message : getSessionBlockingMessage(session);
}

function shouldPersistSession(session?: RibeiraoSession | null) {
  if (!session?.id) {
    return false;
  }
  const status = String(session.status || '').toLowerCase();
  return ['conectado', 'conectando', 'aguardando_captcha_manual', 'aguardando_validacao_manual', 'captcha_required'].includes(status);
}

function isTechnicalBrowserMessage(value?: string | null) {
  const text = String(value || '').toLowerCase();
  return (
    text.includes('browsertype.launch') ||
    text.includes('target page, context or browser has been closed') ||
    text.includes('missing x server') ||
    text.includes('$display') ||
    text.includes('headed browser') ||
    text.includes('playwright') ||
    text.includes('chromium') ||
    text.includes('xvfb')
  );
}

function getFriendlyRibeiraoError(error: unknown, fallback: string) {
  const code = error instanceof ApiError ? String(error.code || '').toUpperCase() : '';
  if (code === 'BROWSER_LAUNCH_ERROR') {
    return 'Erro ao iniciar navegador de consulta no servidor. Verifique configuração do Playwright em produção.';
  }
  if (code === 'LOGIN_ERROR' || code === 'LOGIN_REJECTED') {
    return 'O portal recusou o login/senha informados.';
  }
  if (code === 'PORTAL_UNREACHABLE') {
    return 'Não foi possível acessar o portal da Prefeitura no momento.';
  }
  if (code === 'DNS_RESOLUTION_FAILED') {
    return 'Não foi possível resolver o endereço do portal no servidor. Verifique DNS da VPS/container.';
  }
  if (code === 'CHROMIUM_DNS_FAILED') {
    return 'O navegador interno do servidor não conseguiu resolver o portal, mesmo com DNS do container funcionando.';
  }
  if (code === 'WORKER_INTERNAL_ERROR') {
    return 'Erro interno no worker de login.';
  }
  if (code === 'USER_ALREADY_LOGGED_CONFIRM_FAILED') {
    return 'O portal informou que o usu?rio j? estava logado, mas n?o foi poss?vel confirmar a desconex?o autom?tica.';
  }
  if (code === 'LOGIN_FIELDS_NOT_FOUND') {
    return 'O sistema não encontrou os campos de login do portal. O layout pode ter mudado.';
  }
  if (code === 'LOGIN_BUTTON_NOT_FOUND') {
    return 'O sistema não encontrou o botão de login do portal.';
  }
  if (code === 'LOGIN_PASSWORD_FIELD_NOT_FOUND') {
    return 'O sistema chegou na segunda etapa do login, mas não encontrou o campo de senha.';
  }
  if (code === 'CONVENIO_ACTION_NOT_FOUND') {
    return 'O login foi aceito, mas o sistema não encontrou o botão de acesso do convênio.';
  }
  if (code === 'CONVENIO_SELECTION_FAILED') {
    return 'O login foi aceito, mas o portal não avançou após selecionar o convênio.';
  }
  if (code === 'CONVENIO_NOT_FOUND') {
    return 'O login foi aceito, mas o convênio de Ribeirão Preto não foi encontrado.';
  }
  if (code === 'LOGIN_TIMEOUT') {
    return 'O portal não respondeu após tentar login.';
  }
  if (code === 'LOGIN_STILL_ON_SAME_PAGE') {
    return 'O portal não avançou após informar o login. Pode ser validação por JavaScript, certificado digital ou bloqueio do portal.';
  }
  if (code === 'PORTAL_CHANGED') {
    return 'O layout do portal mudou e o fluxo de login não foi reconhecido.';
  }
  if (code === 'SELECTOR_ERROR') {
    return 'O sistema encontrou o portal, mas não reconheceu os elementos de login nesta tela.';
  }
  if (code === 'LOGIN_OK_NAVIGATION_FAILED') {
    return 'Login aceito, mas não foi possível abrir Consulta de Margem.';
  }
  if (code === 'CAPTCHA_REQUIRED' || code === 'MANUAL_AUTH_REQUIRED') {
    return 'O portal solicitou validação manual.';
  }
  if (code === 'RESULT_TABLE_NOT_FOUND') {
    return 'Não encontrei a tabela Detalhes da Margem.';
  }
  if (code === 'MARGIN_ROWS_NOT_FOUND') {
    return 'Encontrei a página, mas não localizei as linhas de margem.';
  }
  if (code === 'PARSE_MARGIN_ERROR') {
    return 'Encontrei os textos, mas não consegui converter os valores de margem.';
  }
  if (code === 'CPF_NOT_FOUND') {
    return 'O portal informou que o CPF não foi encontrado.';
  }
  if (code === 'NO_ACTIVE_SESSION') {
    return 'Nenhuma sessão ativa com o portal da Prefeitura. Inicie a sessão antes de consultar.';
  }
  if (code === 'MISSING_RIBEIRAO_URL') {
    return 'URL do averbador não configurada no servidor. Configure o .env da VPS e reinicie os containers.';
  }

  const message = error instanceof Error ? error.message : '';
  if (isTechnicalBrowserMessage(message)) {
    return 'Erro ao iniciar navegador de consulta no servidor. Verifique configuração do Playwright em produção.';
  }
  return message || fallback;
}

function batchStatusTone(status?: string) {
  if (status === 'concluido') return 'success';
  if (status === 'pausado' || status === 'aguardando_captcha') return 'info';
  if (status === 'pausado_sessao_expirada' || status === 'erro' || status === 'cancelado') return 'danger';
  if (status === 'em_andamento') return 'accent';
  return 'neutral';
}

function batchStatusLabel(status?: string) {
  if (status === 'em_andamento') return 'Em andamento';
  if (status === 'pausado') return 'Pausado';
  if (status === 'aguardando_captcha') return 'Aguardando confirmação';
  if (status === 'pausado_sessao_expirada') return 'Sessão expirada';
  if (status === 'concluido') return 'Concluído';
  if (status === 'cancelado') return 'Cancelado';
  if (status === 'erro') return 'Erro';
  return 'Pendente';
}

function isBatchActive(status?: string) {
  return status === 'em_andamento';
}

function getBatchNetMargin(item: RibeiraoBatchResultItem, productType: string) {
  const product = item.margins?.find((margin) => margin.product_type === productType);
  return product?.net_margin ?? null;
}

function formatBatchDate(value?: string | null) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function LayersIcon() {
  return (
    <span className="inline-flex h-4 w-4 items-center justify-center rounded-sm border border-current text-[10px]">
      B
    </span>
  );
}
