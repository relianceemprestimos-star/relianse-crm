import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, MessageCircleMore, Smartphone, UserCheck } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import { formatCurrencyDisplay, getMarginSummary } from '../lib/margins';
import { maskCpfForList, maskPhoneForList } from '../lib/privacy';
import { openWhatsAppWeb, openWhatsAppConversation } from '../lib/whatsapp';
import type { DashboardData, Settings } from '../types';
import { Badge, Button, Card, SectionHeader } from '../components/ui';

export default function WhatsAppPage() {
  const navigate = useNavigate();
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        setLoading(true);
        const [dashboardResponse, settingsResponse] = await Promise.all([api.getDashboard(), api.getSettings()]);
        if (!active) return;
        setDashboard(dashboardResponse);
        setSettings(settingsResponse.settings);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar WhatsApp Web.');
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
  }, []);

  const lastEvent = dashboard?.recentActivity?.[0] || null;
  const nextClient = dashboard?.nextClient?.client || null;

  async function openSpecificClient() {
    if (!nextClient || !settings) {
      toast.error('Não há cliente para abrir.');
      return;
    }

    const link = openWhatsAppConversation(nextClient, settings.whatsapp_message, settings);
    if (!link) {
      toast.error('Telefone indisponível.');
      return;
    }

    try {
      await api.openWhatsappLog(nextClient.id);
    } catch {
      // ignore
    }

    toast.success('Conversa aberta em nova aba.');
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        title="WhatsApp Web"
        description="Acesse rapidamente suas conversas com clientes sem embutir o mensageiro dentro do sistema."
      />

      <Card className="border-accent/20 bg-accent/5 p-4">
        <p className="text-sm font-semibold text-white">Envios exigem opt-in ativo do cliente.</p>
        <p className="mt-1 text-sm text-slate-400">Use esta tela apenas para contato operacional autorizado e registrado no CRM.</p>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm text-slate-400">Acesso rápido</p>
              <h3 className="mt-2 text-3xl font-bold text-white">Abra o WhatsApp Web em uma nova aba</h3>
              <p className="mt-3 max-w-2xl text-sm text-slate-400">
                Use esta área para entrar nas conversas gerais. Para iniciar contato com um cliente específico, use o botão dentro da tela de atendimento.
              </p>
            </div>
            <Badge tone="accent">Atalho seguro</Badge>
          </div>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <Button className="px-6 py-4 text-base" onClick={() => openWhatsAppWeb()}>
              <Smartphone size={18} />
              Abrir WhatsApp Web
            </Button>
            <Button variant="secondary" className="px-6 py-4 text-base" onClick={() => navigate('/atendimento')}>
              <ArrowRight size={18} />
              Ir para atendimento
            </Button>
          </div>
        </Card>

        <div className="space-y-6">
          <Card className="p-6">
            <p className="text-sm text-slate-400">Último cliente atendido</p>
            {lastEvent ? (
              <div className="mt-4 space-y-3">
                <p className="text-2xl font-bold text-white">{lastEvent.client_name || 'Cliente'}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Line label="CPF" value={maskCpfForList(lastEvent.cpf)} />
                  <Line label="Telefone" value={maskPhoneForList(lastEvent.phone)} />
                  <Line label="Margem" value={formatCurrencyDisplay(lastEvent.best_net_margin)} />
                  <Line label="Status" value={lastEvent.status || '-'} />
                </div>
              </div>
            ) : (
              <div className="mt-4 text-sm text-slate-500">Ainda não há histórico suficiente para destacar um cliente recente.</div>
            )}
          </Card>

          <Card className="p-6">
            <p className="text-sm text-slate-400">Próximo cliente da fila</p>
            {nextClient ? (
              <div className="mt-4 space-y-3">
                <p className="text-2xl font-bold text-white">{nextClient.name}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Line label="CPF" value={maskCpfForList(nextClient.cpf)} />
                  <Line label="Telefone" value={maskPhoneForList(nextClient.phone)} />
                  <Line label="E-mail" value={nextClient.email || '-'} />
                  <Line label="Melhor margem" value={getMarginSummary(nextClient).bestNetMarginFormatted} />
                </div>
                <div className="grid gap-3 rounded-2xl border border-border bg-bg/60 p-4">
                  <MarginLine label="Consignação" value={nextClient.margem_liquida_consignacao} />
                  <MarginLine label="Crédito" value={nextClient.margem_liquida_credito} />
                  <MarginLine label="Cartão" value={nextClient.margem_liquida_cartao} />
                </div>
                <div className="flex gap-3 pt-2">
                  <Button
                    className="px-5 py-3"
                    onClick={() => navigate(`/atendimento?clientId=${nextClient.id}${nextClient.base_id ? `&base_id=${nextClient.base_id}` : ''}`)}
                  >
                    <UserCheck size={16} />
                    Ir para atendimento
                  </Button>
                  <Button variant="secondary" className="px-5 py-3" onClick={() => void openSpecificClient()}>
                    <MessageCircleMore size={16} />
                    Abrir conversa
                  </Button>
                </div>
              </div>
            ) : (
              <div className="mt-4 text-sm text-slate-500">Nenhum cliente na fila agora.</div>
            )}
          </Card>
        </div>
      </div>

      <Card className="p-6">
        <p className="text-sm text-slate-400">Explicação rápida</p>
        <p className="mt-3 max-w-4xl text-sm text-slate-300">
          Use esta área para abrir o WhatsApp Web em uma nova aba e conversar com seus clientes. Para iniciar conversa com um cliente específico, use o botão Abrir WhatsApp Web dentro da tela de atendimento.
        </p>
      </Card>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg/60 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

function MarginLine({ label, value }: { label: string; value: number | null | undefined }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-slate-400">{label}</span>
      <span className="font-semibold text-white">{formatCurrencyDisplay(value)}</span>
    </div>
  );
}
