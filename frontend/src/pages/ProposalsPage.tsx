import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, CircleDollarSign, HandCoins, Landmark, ListChecks } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import { formatCpfDisplay, formatPhoneDisplay } from '../lib/whatsapp';
import type { ReportResponse } from '../types';
import { Badge, Button, Card, SectionHeader, StatCard } from '../components/ui';

export default function ProposalsPage() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ReportResponse | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        setLoading(true);
        const response = await api.getReports();
        if (!active) return;
        setData(response);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar propostas.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  const rows = data?.rows || [];
  const totals = data?.totals || {};
  const convertedRows = rows.filter((row) => row.status === 'convertido');
  const stats = useMemo(() => {
    const digitadas = convertedRows.length;
    const emAnalise = rows.filter((row) => row.status === 'em_atendimento').length;
    const pendencia = rows.filter((row) => row.status === 'aguardando_retorno').length;
    const canceladas = rows.filter((row) => row.status === 'sem_interesse').length;
    const finalizadas = rows.filter((row) => row.status === 'finalizado').length;
    return {
      digitadas,
      emAnalise,
      pendencia,
      aguardandoAssinatura: 0,
      aguardandoPagamento: 0,
      pagas: Number(totals.converted || 0),
      canceladas,
      comissaoPrevista: convertedRows.length * 120,
      comissaoRecebida: finalizadas * 120,
    };
  }, [convertedRows, rows, totals.converted, totals.finalized]);

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Propostas"
        description="Acompanhe o funil de propostas de consignado, desde digitação até pagamento e controle de comissão."
        action={
          <Button variant="secondary">
            <ListChecks size={16} />
            Nova proposta
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-5">
        <StatCard label="Digitadas" value={stats.digitadas} icon={<Landmark size={18} />} />
        <StatCard label="Em análise" value={stats.emAnalise} />
        <StatCard label="Com pendência" value={stats.pendencia} />
        <StatCard label="Aguardando assinatura" value={stats.aguardandoAssinatura} />
        <StatCard label="Aguardando pagamento" value={stats.aguardandoPagamento} />
      </div>

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Propostas pagas" value={stats.pagas} icon={<CircleDollarSign size={18} />} />
        <StatCard label="Canceladas" value={stats.canceladas} />
        <StatCard label="Comissão prevista" value={`R$ ${stats.comissaoPrevista.toLocaleString('pt-BR')}`} icon={<HandCoins size={18} />} />
        <StatCard label="Comissão recebida" value={`R$ ${stats.comissaoRecebida.toLocaleString('pt-BR')}`} icon={<CalendarClock size={18} />} />
      </div>

      <Card className="p-5 text-sm text-slate-300">
        Bancos foco: Santander, BMG, PAN, Daycoval, Banco do Brasil, Digio, Futuro Previdência, Banco Industrial do Brasil, Cashcard e Amigoz.
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h3 className="text-lg font-semibold text-white">Pipeline operacional</h3>
            <p className="text-sm text-slate-500">Clientes convertidos e em andamento para evolução de proposta.</p>
          </div>
          <Badge tone="neutral">{rows.length} registros</Badge>
        </div>

        {loading ? (
          <div className="p-8 text-sm text-slate-400">Carregando propostas...</div>
        ) : rows.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-[1500px] text-left text-sm">
              <thead className="bg-bg/80 text-slate-400">
                <tr>
                  {['Cliente', 'CPF', 'Telefone', 'Banco', 'Produto', 'Valor liberado', 'Status', 'Pendência', 'Vendedor', 'Data'].map((header) => (
                    <th key={header} className="px-5 py-4 font-medium">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 200).map((row) => (
                  <tr key={row.id} className="border-t border-border/80">
                    <td className="px-5 py-4 font-semibold text-white">{row.name}</td>
                    <td className="px-5 py-4 text-slate-300">{formatCpfDisplay(row.cpf)}</td>
                    <td className="px-5 py-4 text-slate-300">{formatPhoneDisplay(row.phone || '') || '-'}</td>
                    <td className="px-5 py-4 text-slate-300">{String((row as any).bank || '-')}</td>
                    <td className="px-5 py-4 text-slate-300">{row.best_product_label || '-'}</td>
                    <td className="px-5 py-4 text-slate-300">{row.best_net_margin_formatted || '-'}</td>
                    <td className="px-5 py-4">
                      <Badge tone={row.status === 'convertido' ? 'success' : row.status === 'aguardando_retorno' ? 'info' : 'neutral'}>
                        {statusLabel(row.status)}
                      </Badge>
                    </td>
                    <td className="px-5 py-4 text-slate-300">{String((row as any).pending_reason || '-')}</td>
                    <td className="px-5 py-4 text-slate-300">{row.assigned_to_name || '-'}</td>
                    <td className="px-5 py-4 text-slate-300">{row.updated_at_formatted || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-sm text-slate-500">Sem registros de proposta no momento.</div>
        )}
      </Card>
    </div>
  );
}

function statusLabel(status: string) {
  if (status === 'convertido') return 'Digitada';
  if (status === 'em_atendimento') return 'Em análise';
  if (status === 'aguardando_retorno') return 'Com pendência';
  if (status === 'finalizado') return 'Finalizada';
  if (status === 'sem_interesse') return 'Cancelada';
  return status || 'Novo';
}
