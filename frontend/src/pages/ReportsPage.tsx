import { useEffect, useMemo, useState } from 'react';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import { formatCpfDisplay, formatPhoneDisplay } from '../lib/whatsapp';
import { formatCurrencyDisplay, productLabel } from '../lib/margins';
import type { Base, Campaign, ClientsResponse, ProductType, ReportResponse } from '../types';
import { Badge, Card, Input, Select, SectionHeader, StatCard } from '../components/ui';

type ReportFilters = {
  from: string;
  to: string;
  user_id: string;
  status_atendimento: string;
  consulta_status: string;
  campaign_id: string;
  base_id: string;
  base_type: string;
  convenio: string;
  estado: string;
  cidade: string;
};

export default function ReportsPage() {
  const [data, setData] = useState<ReportResponse | null>(null);
  const [bases, setBases] = useState<Base[]>([]);
  const [options, setOptions] = useState<ClientsResponse['meta'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<ReportFilters>({
    from: '',
    to: '',
    user_id: '',
    status_atendimento: '',
    consulta_status: '',
    campaign_id: '',
    base_id: '',
    base_type: '',
    convenio: '',
    estado: '',
    cidade: '',
  });

  useEffect(() => {
    let active = true;

    async function loadBases() {
      try {
        const response = await api.getBases({ include_archived: '1' });
        if (!active) return;
        setBases(response.bases || []);
      } catch {
        // ignore base list failures
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
        const [reportsResponse, clientsResponse] = await Promise.all([api.getReports(filters), api.getClients()]);
        if (!active) return;
        setData(reportsResponse);
        setOptions(clientsResponse.meta);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar relatórios.');
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
  }, [filters]);

  const totals = data?.totals || {};
  const conversionBase = (totals.finalized || 0) + (totals.converted || 0) + (totals.no_interest || 0);
  const conversionRate = conversionBase ? Math.round(((totals.converted || 0) / conversionBase) * 100) : 0;
  const productStats = data?.productStats || [];
  const bestProductCard = useMemo(() => {
    const sorted = [...productStats].sort((a, b) => (b.positive_count || 0) - (a.positive_count || 0));
    return sorted[0] || null;
  }, [productStats]);

  const baseOptions = bases.length ? bases : options?.bases || [];
  const campaignOptions: Campaign[] = options?.campaigns || [];

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Relatórios e acompanhamento"
        description="Acompanhe o volume de atendimentos, margem positiva por base e os casos com erro de consulta."
      />

      <Card className="p-5">
        <div className="grid gap-3 xl:grid-cols-6">
          <label className="block text-sm text-slate-300">
            Campanha
            <Select className="mt-2" value={filters.campaign_id} onChange={(event) => setFilters((current) => ({ ...current, campaign_id: event.target.value }))}>
              <option value="">Todas</option>
              {campaignOptions.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </Select>
          </label>

          <label className="block text-sm text-slate-300">
            Base
            <Select className="mt-2" value={filters.base_id} onChange={(event) => setFilters((current) => ({ ...current, base_id: event.target.value }))}>
              <option value="">Todas</option>
              {baseOptions.map((base) => (
                <option key={base.id} value={base.id}>
                  {base.nome_base}
                </option>
              ))}
            </Select>
          </label>

          <label className="block text-sm text-slate-300">
            Tipo da base
            <Select className="mt-2" value={filters.base_type} onChange={(event) => setFilters((current) => ({ ...current, base_type: event.target.value }))}>
              <option value="">Todos</option>
              {Array.from(new Set(baseOptions.map((base) => base.tipo_base).filter(Boolean))).map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
          </label>

          <label className="block text-sm text-slate-300">
            Convênio
            <Select className="mt-2" value={filters.convenio} onChange={(event) => setFilters((current) => ({ ...current, convenio: event.target.value }))}>
              <option value="">Todos</option>
              {Array.from(new Set(baseOptions.map((base) => base.convenio).filter(Boolean))).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          </label>

          <label className="block text-sm text-slate-300">
            Estado
            <Select className="mt-2" value={filters.estado} onChange={(event) => setFilters((current) => ({ ...current, estado: event.target.value }))}>
              <option value="">Todos</option>
              {Array.from(new Set(baseOptions.map((base) => base.estado).filter(Boolean))).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          </label>

          <label className="block text-sm text-slate-300">
            Cidade
            <Select className="mt-2" value={filters.cidade} onChange={(event) => setFilters((current) => ({ ...current, cidade: event.target.value }))}>
              <option value="">Todas</option>
              {Array.from(new Set(baseOptions.map((base) => base.cidade).filter(Boolean))).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </Select>
          </label>

          <label className="block text-sm text-slate-300">
            Vendedor
            <Select className="mt-2" value={filters.user_id} onChange={(event) => setFilters((current) => ({ ...current, user_id: event.target.value }))}>
              <option value="">Todos</option>
              {options?.users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </Select>
          </label>

          <label className="block text-sm text-slate-300">
            Status atendimento
            <Select className="mt-2" value={filters.status_atendimento} onChange={(event) => setFilters((current) => ({ ...current, status_atendimento: event.target.value }))}>
              <option value="">Todos</option>
              <option value="novo_na_fila">Novo na fila</option>
              <option value="em_atendimento">Em atendimento</option>
              <option value="aguardando_retorno">Aguardando retorno</option>
              <option value="finalizado">Finalizado</option>
              <option value="sem_interesse">Sem interesse</option>
              <option value="convertido">Convertido</option>
            </Select>
          </label>

          <label className="block text-sm text-slate-300">
            Status consulta
            <Select className="mt-2" value={filters.consulta_status} onChange={(event) => setFilters((current) => ({ ...current, consulta_status: event.target.value }))}>
              <option value="">Todos</option>
              <option value="com_marg">Com margem</option>
              <option value="sem_marg">Sem margem</option>
              <option value="erro">Erro</option>
            </Select>
          </label>

          <label className="block text-sm text-slate-300">
            Período inicial
            <Input className="mt-2" type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} />
          </label>

          <label className="block text-sm text-slate-300">
            Período final
            <Input className="mt-2" type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} />
          </label>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Clientes importados" value={totals.total_clients ?? 0} />
        <StatCard label="Clientes com margem positiva" value={totals.with_margin ?? 0} />
        <StatCard label="Clientes sem margem" value={totals.without_margin ?? 0} />
        <StatCard label="Clientes com erro" value={totals.with_error ?? 0} />
      </div>

      <div className="grid gap-4 xl:grid-cols-4">
        <Card className="p-5">
          <p className="text-sm text-slate-400">Melhor produto por volume</p>
          <p className="mt-3 text-2xl font-bold text-white">{bestProductCard ? productLabel(bestProductCard.product_type as ProductType) : '-'}</p>
          <p className="mt-2 text-sm text-slate-400">{bestProductCard ? `${bestProductCard.positive_count} clientes com margem positiva` : 'Sem dados suficientes'}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-slate-400">Margem positiva consignação</p>
          <p className="mt-3 text-2xl font-bold text-white">{productStats.find((item) => item.product_type === 'consignacao')?.positive_count || 0}</p>
          <p className="mt-2 text-sm text-slate-400">Registros com margem líquida positiva</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-slate-400">Margem positiva crédito</p>
          <p className="mt-3 text-2xl font-bold text-white">{productStats.find((item) => item.product_type === 'credito')?.positive_count || 0}</p>
          <p className="mt-2 text-sm text-slate-400">Registros com margem líquida positiva</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-slate-400">Margem positiva cartão</p>
          <p className="mt-3 text-2xl font-bold text-white">{productStats.find((item) => item.product_type === 'cartao')?.positive_count || 0}</p>
          <p className="mt-2 text-sm text-slate-400">Registros com margem líquida positiva</p>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <Card className="p-6">
          <p className="text-sm text-slate-400">Evolução diária de atendimentos</p>
          <div className="mt-5 h-[320px]">
            {loading ? (
              <div className="flex h-full items-center justify-center text-sm text-slate-500">Carregando gráfico...</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data?.daily || []}>
                  <XAxis dataKey="day" tickLine={false} axisLine={false} stroke="#94A3B8" />
                  <YAxis tickLine={false} axisLine={false} stroke="#94A3B8" />
                  <Tooltip
                    contentStyle={{
                      background: '#0D1822',
                      border: '1px solid #1F2D3A',
                      borderRadius: 18,
                      color: '#fff',
                    }}
                  />
                  <Line type="monotone" dataKey="total" stroke="#00D1C1" strokeWidth={3} dot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card className="p-6">
          <p className="text-sm text-slate-400">Resumo da operação</p>
          <div className="mt-4 space-y-3">
            <LineItem label="Conversão" value={`${conversionRate}%`} />
            <LineItem label="Clientes com erro" value={totals.with_error ?? 0} />
            <LineItem label="Clientes com margem positiva" value={totals.with_margin ?? 0} />
            <LineItem label="Clientes sem margem" value={totals.without_margin ?? 0} />
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h3 className="text-lg font-semibold text-white">Tabela de acompanhamento</h3>
            <p className="text-sm text-slate-500">Últimas interações com base, consulta e atendimento.</p>
          </div>
          <Badge tone="neutral">{data?.rows.length || 0} registros</Badge>
        </div>

        {loading ? (
          <div className="p-8 text-sm text-slate-400">Carregando dados...</div>
        ) : data?.rows.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-[1500px] text-left text-sm">
              <thead className="bg-bg/80 text-slate-400">
                <tr>
                  {['Cliente', 'CPF', 'Base', 'Status consulta', 'Melhor produto', 'Melhor margem líquida', 'Último atendimento', 'Status atendimento', 'Observações'].map((column) => (
                    <th key={column} className="px-5 py-4 font-medium">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id} className="border-t border-border/80">
                    <td className="px-5 py-4">
                      <p className="font-semibold text-white">{row.name}</p>
                      <p className="mt-1 text-xs text-slate-500">{formatPhoneDisplay(row.phone)}</p>
                    </td>
                    <td className="px-5 py-4 text-slate-300">{formatCpfDisplay(row.cpf)}</td>
                    <td className="px-5 py-4">
                      <p className="font-semibold text-white">{row.base_name || row.campaign_name || '-'}</p>
                      <p className="mt-1 text-xs text-slate-500">{row.base_type || row.base_convenio || '-'}</p>
                    </td>
                    <td className="px-5 py-4">
                      <Badge tone={consultaTone(row.consulta_status)}>{row.consulta_status_label || row.consulta_status || '-'}</Badge>
                    </td>
                    <td className="px-5 py-4 text-slate-300">{row.best_product_label || productLabel(row.best_product_type || '')}</td>
                    <td className="px-5 py-4 text-slate-300">{row.best_net_margin_formatted || formatCurrencyDisplay(row.best_net_margin)}</td>
                    <td className="px-5 py-4 text-slate-300">{row.last_interaction_at_formatted || '-'}</td>
                    <td className="px-5 py-4">
                      <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                    </td>
                    <td className="px-5 py-4 text-slate-300">
                      <div className="max-w-lg space-y-1">
                        <p>{row.last_note || row.consulta_mensagem || 'Sem observação'}</p>
                        <p className="text-xs text-slate-500">{row.updated_at_formatted || '-'}</p>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-sm text-slate-400">Nenhum dado encontrado para os filtros aplicados.</div>
        )}
      </Card>
    </div>
  );
}

function LineItem({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg/60 px-4 py-3">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

function statusTone(status: string) {
  if (status === 'convertido') return 'success';
  if (status === 'aguardando_retorno') return 'info';
  if (status === 'em_atendimento') return 'accent';
  if (status === 'sem_interesse' || status === 'finalizado') return 'neutral';
  return 'neutral';
}

function consultaTone(status?: string) {
  if (status === 'com_marg') return 'success';
  if (status === 'erro') return 'danger';
  return 'neutral';
}
