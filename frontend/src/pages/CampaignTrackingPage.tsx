import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import { formatMoney, productLabel } from '../lib/privacy';
import { Badge, Card, SectionHeader, Select, StatCard } from '../components/ui';

function statusTone(status: string) {
  const text = String(status || '').toLowerCase();
  if (['enviado', 'respondeu', 'aceitou', 'concluida'].includes(text)) return 'success';
  if (['erro', 'recusou', 'numero_errado'].includes(text)) return 'danger';
  if (['humano', 'pausada'].includes(text)) return 'info';
  return 'neutral';
}

export default function CampaignTrackingPage() {
  const { id = '' } = useParams();
  const [data, setData] = useState<any>(null);
  const [statusFilter, setStatusFilter] = useState('');

  async function load(silent = false) {
    try {
      const response = await api.getDispatchCampaign(id);
      setData(response);
    } catch (error) {
      if (!silent) toast.error(error instanceof Error ? error.message : 'Falha ao carregar acompanhamento.');
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 10000);
    return () => window.clearInterval(timer);
  }, [id]);

  const clientes = data?.clientes || [];
  const filtered = useMemo(
    () => (statusFilter ? clientes.filter((row: any) => String(row.status || '') === statusFilter) : clientes),
    [clientes, statusFilter]
  );
  const contadores = data?.contadores || {};
  const total = clientes.length;
  const enviados = Number(contadores.enviado || contadores.ENVIADO || data?.campanha?.total_enviados || 0);

  if (!data) {
    return <Card className="p-8 text-center text-slate-400">Carregando acompanhamento...</Card>;
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Acompanhamento da campanha"
        description="Status dos clientes e evolução da campanha controlada."
        action={
          <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">Todos os status</option>
            {Object.keys(contadores).map((status) => (
              <option key={status} value={status}>{status}</option>
            ))}
          </Select>
        }
      />

      <div className="grid gap-4 xl:grid-cols-5">
        <StatCard label="Total" value={total} />
        <StatCard label="Enviados" value={enviados} />
        <StatCard label="Respondeu" value={contadores.respondeu || contadores.RESPONDEU || 0} />
        <StatCard label="Aceitou" value={contadores.aceitou || contadores.ACEITOU || 0} />
        <StatCard label="Status" value={data.campanha.status} />
      </div>

      <Card className="p-5">
        <div className="h-3 overflow-hidden rounded-full bg-white/5">
          <div className="h-full bg-accent" style={{ width: `${total ? Math.min(100, (enviados / total) * 100) : 0}%` }} />
        </div>
        <p className="mt-2 text-sm text-slate-400">{enviados} de {total} enviados</p>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="px-5 py-4">Nome</th>
                <th className="px-5 py-4">Produto</th>
                <th className="px-5 py-4">Valor</th>
                <th className="px-5 py-4">Status</th>
                <th className="px-5 py-4">Atualização</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {filtered.map((row: any) => (
                <tr key={row.id} className="text-slate-300">
                  <td className="px-5 py-4 font-semibold text-white">{row.nome || '-'}</td>
                  <td className="px-5 py-4">{productLabel(row.produto)}</td>
                  <td className="px-5 py-4">{formatMoney(row.valor_liberado)}</td>
                  <td className="px-5 py-4"><Badge tone={statusTone(row.status) as any}>{row.status}</Badge></td>
                  <td className="px-5 py-4 text-slate-400">{row.status_atualizado_em || row.enviado_em || '-'}</td>
                </tr>
              ))}
              {!filtered.length ? (
                <tr><td className="px-5 py-8 text-center text-slate-500" colSpan={5}>Nenhum cliente neste filtro.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
