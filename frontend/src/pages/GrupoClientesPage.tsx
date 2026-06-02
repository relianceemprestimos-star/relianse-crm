import { useEffect, useState } from 'react';
import { ArrowLeft, FileText, Filter } from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate, useParams } from 'react-router-dom';

import { Badge, Button, Card, SectionHeader, Select, StatCard } from '../components/ui';
import { api } from '../lib/api';
import type { PipelineGroupClient } from '../types';

const valueRanges = [
  { value: '', label: 'Todas as faixas' },
  { value: 'ate_5k', label: 'Até 5k' },
  { value: '5k_10k', label: '5k a 10k' },
  { value: '10k_15k', label: '10k a 15k' },
  { value: '15k_20k', label: '15k a 20k' },
  { value: '20k_30k', label: '20k a 30k' },
  { value: 'acima_30k', label: 'Acima de 30k' },
];

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
}

function productLabel(value: string) {
  const labels: Record<string, string> = {
    consignado: 'Consignado',
    cartao_consignado: 'Cartão consignado',
    cartao_beneficio: 'Cartão benefício',
  };
  return labels[value] || value || '-';
}

export default function GrupoClientesPage() {
  const params = useParams();
  const navigate = useNavigate();
  const esteiraId = Number(params.id || 0);
  const grupo = String(params.grupo || '');
  const [rows, setRows] = useState<PipelineGroupClient[]>([]);
  const [groupLabel, setGroupLabel] = useState('');
  const [range, setRange] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    if (!esteiraId || !grupo) return;
    setLoading(true);
    try {
      const response = await api.getPipelineGroupClients(esteiraId, grupo, range ? { faixa_valor: range } : {});
      setRows(response.clientes || []);
      setGroupLabel(response.grupo_label || grupo);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar clientes.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [esteiraId, grupo, range]);

  const totalValue = rows.reduce((sum, row) => sum + Number(row.valor_liberado || 0), 0);
  const ready = rows.filter((row) => Number(row.valor_liberado || 0) > 0).length;

  return (
    <div className="space-y-6">
      <SectionHeader
        title={groupLabel || 'Clientes do grupo'}
        description="Lista operacional sem CPF aberto. Abra o atendimento individual quando precisar confirmar dados sensíveis."
        action={
          <Button variant="secondary" onClick={() => navigate(`/esteira/${esteiraId}/grupos`)}>
            <ArrowLeft size={16} />
            Voltar aos grupos
          </Button>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Clientes" value={rows.length} hint={loading ? 'carregando' : 'neste grupo'} />
        <StatCard label="Prontos" value={ready} hint="com valor liberado" />
        <StatCard label="Valor total" value={money(totalValue)} hint="soma simulada" />
      </div>

      <Card className="p-5">
        <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
          <div>
            <label className="text-sm font-semibold text-slate-300">Faixa de valor</label>
            <Select className="mt-2" value={range} onChange={(event) => setRange(event.target.value)}>
              {valueRanges.map((item) => (
                <option key={item.value || 'all'} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="secondary" onClick={() => void load()}>
            <Filter size={16} />
            Filtrar
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Cliente</th>
                <th className="px-4 py-3">Convênio</th>
                <th className="px-4 py-3">Banco</th>
                <th className="px-4 py-3">Produto</th>
                <th className="px-4 py-3">Margem</th>
                <th className="px-4 py-3">Valor liberado</th>
                <th className="px-4 py-3">Faixa</th>
                <th className="px-4 py-3">Idade</th>
                <th className="px-4 py-3">Telefone</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {rows.map((row) => (
                <tr key={row.id} className="text-slate-300">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-white">{row.nome || `Cliente #${row.client_id}`}</p>
                    <p className="text-xs text-slate-500">ID {row.client_id} · CPF oculto em lista</p>
                  </td>
                  <td className="px-4 py-3">{row.convenio_label || row.convenio}</td>
                  <td className="px-4 py-3">{row.banco_label || row.banco || '-'}</td>
                  <td className="px-4 py-3">{productLabel(row.produto)}</td>
                  <td className="px-4 py-3">{money(row.margem_disponivel)}</td>
                  <td className="px-4 py-3 font-semibold text-white">{row.valor_liberado ? money(row.valor_liberado) : '-'}</td>
                  <td className="px-4 py-3">{row.faixa_valor_label || '-'}</td>
                  <td className="px-4 py-3">{row.idade ?? '-'}</td>
                  <td className="px-4 py-3">
                    <Badge tone={row.telefone_status === 'com_telefone' ? 'success' : 'neutral'}>
                      {row.telefone_status === 'com_telefone' ? 'Com telefone' : 'Sem telefone'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={row.status_regra === 'PRONTO_PARA_SIMULACAO' ? 'success' : 'info'}>{row.status_regra || row.grupo}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && !rows.length ? (
          <div className="flex items-center gap-3 p-6 text-sm text-slate-400">
            <FileText size={18} />
            Nenhum cliente neste filtro.
          </div>
        ) : null}
      </Card>
    </div>
  );
}
