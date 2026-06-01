import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Calculator, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';

import { Badge, Button, Card, Input, SectionHeader, Select, StatCard } from '../components/ui';
import { api } from '../lib/api';
import { formatMoney, maskCpf, maskPhone, productLabel } from '../lib/privacy';
import type { CampaignOpportunity } from '../types';

const SELECTION_KEY = 'crm_dispatch_campaign_selection';

function productTone(product: string) {
  if (product === 'consignado') return 'success';
  if (product === 'cartao_consignado') return 'info';
  return 'accent';
}

export default function CampaignOpportunitiesPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<CampaignOpportunity[]>([]);
  const [selected, setSelected] = useState<Record<string, CampaignOpportunity>>({});
  const [loading, setLoading] = useState(false);
  const [coefficient, setCoefficient] = useState<{ coeficiente: number | null; prazo: number | null } | null>(null);
  const [filters, setFilters] = useState({
    convenio: '',
    produto: '',
    banco: '',
    faixa_valor: '',
    faixa_min: '',
    faixa_max: '',
    idade_min: '',
    idade_max: '',
    ordem: 'valor_desc',
  });

  async function load() {
    try {
      setLoading(true);
      const response = await api.getCampaignOpportunities(filters);
      setRows(response.oportunidades || []);
      setCoefficient({ coeficiente: response.coeficiente, prazo: response.prazo });
    } catch (error) {
      setRows([]);
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar oportunidades.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const selectedRows = useMemo(() => Object.values(selected), [selected]);
  const selectedTotal = selectedRows.reduce((sum, row) => sum + (row.valor_liberado || 0), 0);

  function keyOf(row: CampaignOpportunity) {
    return `${row.client_id}:${row.produto}:${row.banco || ''}`;
  }

  function toggle(row: CampaignOpportunity) {
    const key = keyOf(row);
    setSelected((current) => {
      const next = { ...current };
      if (next[key]) {
        delete next[key];
      } else {
        next[key] = row;
      }
      return next;
    });
  }

  function createCampaign() {
    if (!selectedRows.length) {
      toast.error('Selecione ao menos um cliente.');
      return;
    }
    sessionStorage.setItem(SELECTION_KEY, JSON.stringify(selectedRows));
    navigate('/campanhas/nova');
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Oportunidades de campanha"
        description="Clientes com telefone e margem disponivel para abordagem interna autorizada."
        action={
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => navigate('/campanhas/coeficiente')}>
              <Calculator size={16} />
              Coeficiente
            </Button>
            <Button onClick={createCampaign} disabled={!selectedRows.length}>
              Criar campanha
              <ArrowRight size={16} />
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Oportunidades" value={rows.length} />
        <StatCard label="Selecionados" value={selectedRows.length} />
        <StatCard label="Carteira estimada" value={formatMoney(selectedTotal)} />
        <StatCard label="Prazo" value={coefficient?.prazo || '-'} hint={coefficient?.coeficiente ? `Coef. ${coefficient.coeficiente}` : 'Cadastre o coeficiente'} />
      </div>

      <Card className="p-5">
        <div className="grid gap-3 lg:grid-cols-10">
          <Select value={filters.convenio} onChange={(event) => setFilters((current) => ({ ...current, convenio: event.target.value }))}>
            <option value="">Todos os convenios</option>
            <option value="gov_sp">Governo de SP</option>
            <option value="prefeitura_rp">Pref. Ribeirao Preto</option>
          </Select>
          <Select value={filters.produto} onChange={(event) => setFilters((current) => ({ ...current, produto: event.target.value }))}>
            <option value="">Todos os produtos</option>
            <option value="consignado">Consignado</option>
            <option value="cartao_consignado">Cartao consignado</option>
            <option value="cartao_beneficio">Cartao beneficio</option>
          </Select>
          <Select value={filters.banco} onChange={(event) => setFilters((current) => ({ ...current, banco: event.target.value }))}>
            <option value="">Todos os bancos</option>
            <option value="daycoval">Daycoval</option>
            <option value="bmg">BMG</option>
            <option value="santander">Santander</option>
            <option value="banco_brasil">Banco do Brasil</option>
            <option value="amigoz">Amigoz</option>
            <option value="futuro_previdencia">Futuro Previdência</option>
            <option value="bib">BIB</option>
          </Select>
          <Select value={filters.faixa_valor} onChange={(event) => setFilters((current) => ({ ...current, faixa_valor: event.target.value, faixa_min: '', faixa_max: '' }))}>
            <option value="">Todas as faixas</option>
            <option value="ate_5k">Até 5k</option>
            <option value="5k_a_10k">5k a 10k</option>
            <option value="10k_a_15k">10k a 15k</option>
            <option value="15k_a_20k">15k a 20k</option>
            <option value="acima_20k">Acima de 20k</option>
          </Select>
          <Input placeholder="Valor minimo" value={filters.faixa_min} onChange={(event) => setFilters((current) => ({ ...current, faixa_min: event.target.value }))} />
          <Input placeholder="Valor maximo" value={filters.faixa_max} onChange={(event) => setFilters((current) => ({ ...current, faixa_max: event.target.value }))} />
          <Input placeholder="Idade min" inputMode="numeric" value={filters.idade_min} onChange={(event) => setFilters((current) => ({ ...current, idade_min: event.target.value }))} />
          <Input placeholder="Idade max" inputMode="numeric" value={filters.idade_max} onChange={(event) => setFilters((current) => ({ ...current, idade_max: event.target.value }))} />
          <Select value={filters.ordem} onChange={(event) => setFilters((current) => ({ ...current, ordem: event.target.value }))}>
            <option value="valor_desc">Maior valor</option>
            <option value="valor_asc">Menor valor</option>
            <option value="nome_asc">Nome A-Z</option>
          </Select>
          <Button variant="secondary" onClick={load} disabled={loading}>
            <RefreshCw size={16} />
            Filtrar
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="px-5 py-4">Selecionar</th>
                <th className="px-5 py-4">Cliente</th>
                <th className="px-5 py-4">Convenio</th>
                <th className="px-5 py-4">Produto</th>
                <th className="px-5 py-4">Banco</th>
                <th className="px-5 py-4">Margem</th>
                <th className="px-5 py-4">Valor</th>
                <th className="px-5 py-4">Telefone</th>
                <th className="px-5 py-4">Idade</th>
                <th className="px-5 py-4">Grupo</th>
                <th className="px-5 py-4">Complemento</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {rows.map((row) => (
                <tr key={keyOf(row)} className="text-slate-300">
                  <td className="px-5 py-4">
                    <input type="checkbox" checked={Boolean(selected[keyOf(row)])} onChange={() => toggle(row)} />
                  </td>
                  <td className="px-5 py-4">
                    <p className="font-semibold text-white">{row.nome}</p>
                    <p className="text-xs text-slate-500">{maskCpf(row.cpf)}</p>
                  </td>
                  <td className="px-5 py-4">{row.convenio_label || row.convenio}</td>
                  <td className="px-5 py-4">
                    <Badge tone={productTone(row.produto) as any}>{productLabel(row.produto)}</Badge>
                  </td>
                  <td className="px-5 py-4">
                    <p className="font-semibold text-white">{row.banco_label || row.banco || '-'}</p>
                    <p className="text-xs text-slate-500">{row.faixa_valor_label || '-'}</p>
                  </td>
                  <td className="px-5 py-4">{formatMoney(row.margem_disponivel)}</td>
                  <td className="px-5 py-4 font-semibold text-white">{formatMoney(row.valor_liberado)}</td>
                  <td className="px-5 py-4">{maskPhone(row.telefone)}</td>
                  <td className="px-5 py-4">{row.idade ?? '-'}</td>
                  <td className="px-5 py-4">{row.grupo || '-'}</td>
                  <td className="px-5 py-4">
                    {row.oferta_complementar ? <Badge tone="neutral">+ {productLabel(row.produto_complementar || '')}</Badge> : '-'}
                  </td>
                </tr>
              ))}
              {!rows.length ? (
                <tr>
                  <td colSpan={11} className="px-5 py-10 text-center text-slate-400">
                    {loading ? 'Carregando oportunidades...' : 'Nenhuma oportunidade pronta. Se houver elegíveis, cadastre o coeficiente do banco para liberar a simulação.'}
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
