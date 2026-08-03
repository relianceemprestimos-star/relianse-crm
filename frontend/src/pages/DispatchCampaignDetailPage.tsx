import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';

import { Badge, Card, SectionHeader, Select, StatCard } from '../components/ui';
import { api } from '../lib/api';
import { formatMoney, maskCpf, maskPhone, productLabel } from '../lib/privacy';
import type { DispatchCampaign, DispatchCampaignClient } from '../types';

function statusTone(status: string) {
  if (['enviado', 'respondeu', 'aceitou', 'concluida'].includes(status)) return 'success';
  if (['erro', 'recusou', 'numero_errado'].includes(status)) return 'danger';
  if (status === 'em_andamento') return 'info';
  return 'neutral';
}

export default function DispatchCampaignDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState<DispatchCampaign | null>(null);
  const [clients, setClients] = useState<DispatchCampaignClient[]>([]);
  const [counters, setCounters] = useState<Record<string, number>>({});
  const [statusFilter, setStatusFilter] = useState('');
  const [dryRunning, setDryRunning] = useState(false);

  async function load(silent = false) {
    if (!id) return;
    try {
      const response = await api.getDispatchCampaign(id);
      setCampaign(response.campanha);
      setClients(response.clientes || []);
      setCounters(response.contadores || {});
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : 'Falha ao carregar campanha.');
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 10000);
    return () => window.clearInterval(timer);
  }, [id]);

  const visibleClients = useMemo(
    () => clients.filter((client) => !statusFilter || client.status === statusFilter),
    [clients, statusFilter]
  );
  const sent = counters.enviado || counters.respondeu || counters.aceitou || 0;
  const progress = clients.length ? Math.round(((campaign?.total_disparos || sent) / clients.length) * 100) : 0;

  async function runDryRun() {
    if (!id) return;
    try {
      setDryRunning(true);
      await api.runCampaignDryRun(id);
      toast.success('Dry-run concluido. Nenhuma mensagem real foi enviada.');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao executar dry-run.');
    } finally {
      setDryRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title={campaign?.nome || 'Acompanhamento da campanha'}
        description="Painel de acompanhamento dos disparos enviados pelo ReWhats."
      />

      <div className="grid gap-4 xl:grid-cols-5">
        <StatCard label="Total" value={clients.length} />
        <StatCard label="Enviados" value={campaign?.total_disparos || 0} />
        <StatCard label="Respostas" value={campaign?.total_respostas || 0} />
        <StatCard label="Aceites" value={campaign?.total_aceites || 0} />
        <StatCard label="Progresso" value={`${progress}%`} />
      </div>

      <Card className="p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={statusTone(campaign?.status || '') as any}>{campaign?.status || 'carregando'}</Badge>
            <span className="text-sm text-slate-400">Coeficiente {campaign?.coeficiente || '-'} · Prazo {campaign?.prazo || '-'}</span>
          </div>
          <Select className="md:max-w-xs" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">Todos os status</option>
            <option value="pendente">Pendente</option>
            <option value="enviado">Enviado</option>
            <option value="respondeu">Respondeu</option>
            <option value="aceitou">Aceitou</option>
            <option value="recusou">Recusou</option>
            <option value="erro">Erro</option>
          </Select>
          <button
            className="rounded-2xl border border-border bg-panelAlt px-4 py-3 text-sm font-semibold text-slate-100 transition hover:border-accent/40 hover:bg-accent/10"
            onClick={() => navigate(`/campanhas/disparo/${id}/documentos`)}
          >
            Documentos
          </button>
          <button
            className="rounded-2xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm font-semibold text-accent transition hover:bg-accent/15 disabled:opacity-50"
            onClick={runDryRun}
            disabled={dryRunning}
          >
            Dry-run
          </button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="px-5 py-4">Cliente</th>
                <th className="px-5 py-4">Produto</th>
                <th className="px-5 py-4">Valor</th>
                <th className="px-5 py-4">Telefone</th>
                <th className="px-5 py-4">Status</th>
                <th className="px-5 py-4">Atualizado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {visibleClients.map((client) => (
                <tr key={client.id} className="text-slate-300">
                  <td className="px-5 py-4">
                    <p className="font-semibold text-white">{client.nome || 'Cliente'}</p>
                    <p className="text-xs text-slate-500">{maskCpf(client.cpf)}</p>
                  </td>
                  <td className="px-5 py-4">{productLabel(client.produto)}</td>
                  <td className="px-5 py-4 font-semibold text-white">{formatMoney(client.valor_liberado)}</td>
                  <td className="px-5 py-4">{maskPhone(client.telefone)}</td>
                  <td className="px-5 py-4">
                    <Badge tone={statusTone(client.status) as any}>{client.status}</Badge>
                  </td>
                  <td className="px-5 py-4">{client.status_atualizado_em || client.enviado_em || '-'}</td>
                </tr>
              ))}
              {!visibleClients.length ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-slate-400">
                    Nenhum cliente neste status.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
