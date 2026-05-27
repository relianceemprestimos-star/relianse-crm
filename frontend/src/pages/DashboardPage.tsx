import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, MessageCircleMore, RefreshCcw, Upload, Users } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import { formatCurrencyDisplay, getMarginSummary } from '../lib/margins';
import { maskCpfForList, maskPhoneForList } from '../lib/privacy';
import { openWhatsAppConversation, openWhatsAppWeb } from '../lib/whatsapp';
import type { Base, DashboardData, Settings } from '../types';
import { Badge, Button, Card, SectionHeader, Select, StatCard } from '../components/ui';

export default function DashboardPage() {
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [bases, setBases] = useState<Base[]>([]);
  const [selectedBaseId, setSelectedBaseId] = useState('');
  const [loading, setLoading] = useState(true);
  const [startingClient, setStartingClient] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadBases() {
      try {
        const response = await api.getBases({ include_archived: '1' });
        if (!active) return;
        setBases(response.bases || []);
      } catch {
        // ignore; dashboard can still load
      }
    }

    void loadBases();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        setLoading(true);
        const [dashboardResponse, settingsResponse] = await Promise.all([
          api.getDashboard(selectedBaseId ? { base_id: selectedBaseId } : {}),
          api.getSettings(),
        ]);
        if (!active) return;
        setDashboard(dashboardResponse);
        setSettings(settingsResponse.settings);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar o dashboard.');
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [selectedBaseId]);

  const nextClient = dashboard?.nextClient?.client;
  const queueTotal = dashboard?.nextClient?.queue_total ?? 0;
  const queuePosition = dashboard?.nextClient?.queue_position ?? 0;
  const stats = dashboard?.stats || {};
  const marginSummary = nextClient ? getMarginSummary(nextClient) : null;

  async function handleStartNext() {
    if (!nextClient) {
      toast('Não há clientes na fila no momento.');
      return;
    }

    try {
      setStartingClient(true);
      const started = await api.startClient(nextClient.id);
      toast.success('Atendimento iniciado.');
      navigate(`/atendimento?clientId=${started.client.id}${selectedBaseId ? `&base_id=${selectedBaseId}` : ''}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Não foi possível iniciar o atendimento.');
    } finally {
      setStartingClient(false);
    }
  }

  function handleOpenClientWhatsApp() {
    if (!nextClient || !settings) {
      return;
    }

    const link = openWhatsAppConversation(nextClient, settings.whatsapp_message, settings);
    if (!link) {
      toast.error('Telefone indisponível para abrir o WhatsApp.');
      return;
    }

    toast.success('WhatsApp aberto em nova aba.');
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Visão geral da operação"
        description="Acompanhe a fila, veja a melhor margem disponível e avance o próximo cliente sem poluição visual."
        action={
          <div className="w-full max-w-xs">
            <Select value={selectedBaseId} onChange={(event) => setSelectedBaseId(event.target.value)}>
              <option value="">Todas as bases</option>
              {bases.map((base) => (
                <option key={base.id} value={base.id}>
                  {base.nome_base}
                </option>
              ))}
            </Select>
          </div>
        }
      />

      {loading ? (
        <Card className="p-8 text-sm text-slate-400">Carregando painel...</Card>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-4">
            <StatCard label="Clientes na fila" value={stats.queue_clients ?? 0} hint="Novos e aguardando retorno" icon={<Users size={18} />} />
            <StatCard label="Em atendimento" value={stats.active_clients ?? 0} hint="Cliente em uso por vendedor" icon={<RefreshCcw size={18} />} />
            <StatCard label="Finalizados hoje" value={stats.finished_today ?? 0} hint="Encerrados nesta data" icon={<ArrowRight size={18} />} />
            <StatCard label="Retornos agendados" value={stats.scheduled_returns ?? 0} hint="Pendências de volta" icon={<MessageCircleMore size={18} />} />
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.45fr_0.85fr]">
            <Card className="p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm text-slate-400">Próximo cliente da fila</p>
                  <h3 className="mt-2 text-2xl font-bold text-white">Foco total no atendimento</h3>
                </div>
                <Badge tone="accent">{queuePosition && queueTotal ? `${queuePosition} de ${queueTotal}` : 'Fila vazia'}</Badge>
              </div>

              {nextClient ? (
                <div className="mt-6 grid gap-6 lg:grid-cols-[1.35fr_0.65fr]">
                  <div className="space-y-4">
                    <div>
                      <p className="text-xs uppercase tracking-[0.24em] text-slate-500">Nome</p>
                      <p className="mt-2 text-3xl font-bold text-white">{nextClient.name}</p>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <InfoLine label="CPF" value={maskCpfForList(nextClient.cpf)} />
                      <InfoLine label="Telefone" value={maskPhoneForList(nextClient.phone)} />
                      <InfoLine label="E-mail" value={nextClient.email || '-'} />
                      <InfoLine label="Status consulta" value={nextClient.consulta_status_label || nextClient.consulta_status || '-'} />
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <MarginMini label="Consignação" value={nextClient.margem_liquida_consignacao} />
                      <MarginMini label="Crédito" value={nextClient.margem_liquida_credito} />
                      <MarginMini label="Cartão" value={nextClient.margem_liquida_cartao} />
                    </div>

                    <div className="rounded-3xl border border-border bg-bg/60 p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Melhor margem</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Badge tone="accent">{marginSummary?.bestProductLabel || nextClient.best_product_label || '-'}</Badge>
                        <span className="text-lg font-semibold text-white">{marginSummary?.bestNetMarginFormatted || nextClient.best_net_margin_formatted || '-'}</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Badge tone="info">{nextClient.status_label || 'Novo na fila'}</Badge>
                      {nextClient.campaign_name ? <Badge tone="neutral">{nextClient.campaign_name}</Badge> : null}
                      {nextClient.assigned_to_name ? <Badge tone="success">Atendido por {nextClient.assigned_to_name}</Badge> : null}
                    </div>

                    <div className="rounded-3xl border border-border bg-bg/60 p-4">
                      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Origem da base</p>
                      <div className="mt-2 grid gap-2 text-sm text-slate-300">
                        <div>
                          <span className="text-slate-500">Nome:</span> {nextClient.base_name || nextClient.campaign_name || '-'}
                        </div>
                        <div>
                          <span className="text-slate-500">Tipo:</span> {nextClient.base_type || '-'}
                        </div>
                        <div>
                          <span className="text-slate-500">Convênio:</span> {nextClient.base_convenio || '-'}
                        </div>
                        <div>
                          <span className="text-slate-500">Arquivo:</span> {nextClient.base_file_name || nextClient.campaign_file_name || '-'}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <Button className="w-full py-4 text-base" onClick={handleStartNext} disabled={startingClient}>
                      {startingClient ? 'Iniciando...' : 'Iniciar atendimento'}
                    </Button>
                    <Button variant="secondary" className="w-full py-4 text-base" onClick={handleOpenClientWhatsApp}>
                      Abrir WhatsApp Web
                    </Button>
                    <Button variant="secondary" className="w-full py-4 text-base" onClick={() => navigate('/fila')}>
                      Ver fila completa
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-6 rounded-3xl border border-dashed border-border bg-white/3 p-8 text-slate-400">
                  Não há clientes na fila agora. Assim que uma planilha for importada, o próximo atendimento aparece aqui.
                </div>
              )}
            </Card>

            <div className="space-y-6">
              <Card className="p-6">
                <p className="text-sm text-slate-400">Ações rápidas</p>
                <div className="mt-5 space-y-3">
                  <Button className="w-full justify-between py-4" onClick={() => openWhatsAppWeb()}>
                    <span className="flex items-center gap-2">
                      <MessageCircleMore size={18} />
                      Abrir WhatsApp Web
                    </span>
                    <ArrowRight size={16} />
                  </Button>
                  <Button variant="secondary" className="w-full justify-between py-4" onClick={handleStartNext}>
                    <span className="flex items-center gap-2">
                      <RefreshCcw size={18} />
                      Iniciar atendimento
                    </span>
                    <ArrowRight size={16} />
                  </Button>
                  <Button variant="secondary" className="w-full justify-between py-4" onClick={() => navigate('/upload')}>
                    <span className="flex items-center gap-2">
                      <Upload size={18} />
                      Importar nova lista
                    </span>
                    <ArrowRight size={16} />
                  </Button>
                  <Button variant="secondary" className="w-full justify-between py-4" onClick={() => navigate('/fila')}>
                    <span className="flex items-center gap-2">
                      <Users size={18} />
                      Ver agenda / fila
                    </span>
                    <ArrowRight size={16} />
                  </Button>
                </div>
              </Card>

              <Card className="p-6">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-slate-400">Últimas movimentações</p>
                  <Badge tone="neutral">{dashboard?.recentActivity?.length || 0} eventos</Badge>
                </div>
                <div className="mt-4 space-y-3">
                  {dashboard?.recentActivity?.length ? (
                    dashboard.recentActivity.map((item) => (
                      <div key={item.id} className="rounded-2xl border border-border bg-bg/60 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-semibold text-white">{item.client_name || 'Cliente'}</p>
                            <p className="mt-1 text-sm text-slate-400">{item.note || item.type}</p>
                          </div>
                          <Badge tone="accent">{item.type}</Badge>
                        </div>
                        <p className="mt-3 text-xs text-slate-500">
                          {item.user_name || 'Sistema'} • {new Date(item.created_at).toLocaleString('pt-BR')}
                        </p>
                      </div>
                    ))
                  ) : (
                    <div className="rounded-2xl border border-dashed border-border bg-white/3 p-4 text-sm text-slate-500">
                      Nenhuma interação registrada ainda.
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
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

function MarginMini({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="rounded-2xl border border-border bg-bg/60 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-white">{formatCurrencyDisplay(value ?? 0)}</p>
    </div>
  );
}
