import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Archive, ArrowRight, Filter, Search, Upload, Users } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import { formatCpfDisplay, formatPhoneDisplay } from '../lib/whatsapp';
import type { Base, Campaign, Client, ClientsResponse } from '../types';
import { Badge, Button, Card, Input, SectionHeader, Select, StatCard } from '../components/ui';

type ClientFilters = {
  search: string;
  campaign_id: string;
  base_id: string;
  status_atendimento: string;
  consulta_status: string;
};

export default function ClientsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  const [response, setResponse] = useState<ClientsResponse | null>(null);
  const [bases, setBases] = useState<Base[]>([]);
  const [filters, setFilters] = useState<ClientFilters>({
    search: searchParams.get('search') || '',
    campaign_id: searchParams.get('campaign_id') || '',
    base_id: searchParams.get('base_id') || '',
    status_atendimento: searchParams.get('status_atendimento') || '',
    consulta_status: searchParams.get('consulta_status') || '',
  });

  useEffect(() => {
    const nextFilters = {
      search: searchParams.get('search') || '',
      campaign_id: searchParams.get('campaign_id') || '',
      base_id: searchParams.get('base_id') || '',
      status_atendimento: searchParams.get('status_atendimento') || '',
      consulta_status: searchParams.get('consulta_status') || '',
    };
    setFilters((current) => (
      current.search === nextFilters.search &&
      current.campaign_id === nextFilters.campaign_id &&
      current.base_id === nextFilters.base_id &&
      current.status_atendimento === nextFilters.status_atendimento &&
      current.consulta_status === nextFilters.consulta_status
        ? current
        : nextFilters
    ));
  }, [searchParams]);

  function updateFilters(next: Partial<ClientFilters>) {
    setFilters((current) => {
      const updated = { ...current, ...next };
      const params = new URLSearchParams();
      Object.entries(updated).forEach(([key, value]) => {
        if (value) params.set(key, value);
      });
      setSearchParams(params, { replace: true });
      return updated;
    });
  }

  useEffect(() => {
    let active = true;
    async function loadBases() {
      try {
        const res = await api.getBases({ include_archived: '1' });
        if (active) setBases(res.bases || []);
      } catch {
        // keep page functional even if base list fails
      }
    }
    void loadBases();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void loadClients();
    }, 180);

    async function loadClients() {
      try {
        setLoading(true);
        const res = await api.getClients(filters);
        if (!active) return;
        setResponse(res);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar clientes.');
      } finally {
        if (active) setLoading(false);
      }
    }

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [filters]);

  const campaigns: Campaign[] = response?.meta.campaigns || [];
  const clients = response?.clients || [];
  const stats = useMemo(() => {
    const withPhone = clients.filter((client) => Boolean(client.phone?.trim()) || (client.phones?.length || 0) > 0).length;
    const withoutPhone = clients.length - withPhone;
    const withMargin = clients.filter((client) => client.consulta_status === 'com_marg').length;
    const withoutMargin = clients.filter((client) => client.consulta_status === 'sem_marg').length;
    const duplicated = clients.filter((client) => client.has_duplicate_in_other_base).length;
    return {
      total: clients.length,
      withPhone,
      withoutPhone,
      withMargin,
      withoutMargin,
      duplicated,
    };
  }, [clients]);

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Clientes"
        description="Central operacional das bases importadas, dados de clientes, telefones e margens para atendimento de consignado."
        action={
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => navigate('/upload')}>
              <Upload size={16} />
              Importar nova lista
            </Button>
            <Button variant="secondary" onClick={() => navigate('/bases')}>
              <Archive size={16} />
              Bases importadas
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-6">
        <StatCard label="Total de clientes" value={stats.total} icon={<Users size={18} />} />
        <StatCard label="Com telefone" value={stats.withPhone} />
        <StatCard label="Sem telefone" value={stats.withoutPhone} />
        <StatCard label="Com margem" value={stats.withMargin} />
        <StatCard label="Sem margem" value={stats.withoutMargin} />
        <StatCard label="Duplicados" value={stats.duplicated} icon={<Filter size={18} />} />
      </div>

      <Card className="p-5">
        <div className="grid gap-3 xl:grid-cols-5">
          <label className="block text-sm text-slate-300 xl:col-span-2">
            Cliente
            <div className="relative mt-2">
              <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
              <Input
                className="pl-10"
                value={filters.search}
                onChange={(event) => updateFilters({ search: event.target.value })}
                placeholder="Nome, CPF ou telefone"
              />
            </div>
          </label>
          <label className="block text-sm text-slate-300">
            Campanha
            <Select className="mt-2" value={filters.campaign_id} onChange={(event) => updateFilters({ campaign_id: event.target.value })}>
              <option value="">Todas</option>
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="block text-sm text-slate-300">
            Base
            <Select className="mt-2" value={filters.base_id} onChange={(event) => updateFilters({ base_id: event.target.value })}>
              <option value="">Todas</option>
              {bases.map((base) => (
                <option key={base.id} value={base.id}>
                  {base.nome_base}
                </option>
              ))}
            </Select>
          </label>
          <label className="block text-sm text-slate-300">
            Status
            <Select className="mt-2" value={filters.status_atendimento} onChange={(event) => updateFilters({ status_atendimento: event.target.value })}>
              <option value="">Todos</option>
              <option value="novo_na_fila">Novo</option>
              <option value="em_atendimento">Em atendimento</option>
              <option value="aguardando_retorno">Aguardando retorno</option>
              <option value="sem_interesse">Sem interesse</option>
              <option value="convertido">Convertido</option>
              <option value="finalizado">Finalizado</option>
            </Select>
          </label>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h3 className="text-lg font-semibold text-white">Lista de clientes</h3>
            <p className="text-sm text-slate-500">Dados pessoais, vínculo com base/campanha, margem e status operacional.</p>
          </div>
          <Badge tone="neutral">{clients.length} registros</Badge>
        </div>

        {loading ? (
          <div className="p-8 text-sm text-slate-400">Carregando clientes...</div>
        ) : clients.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-[1500px] text-left text-sm">
              <thead className="bg-bg/80 text-slate-400">
                <tr>
                  {['Nome', 'CPF', 'Telefone', 'E-mail', 'Convênio / Base', 'Matrícula', 'Margem', 'Status', 'Ações'].map((header) => (
                    <th key={header} className="px-5 py-4 font-medium">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {clients.slice(0, 200).map((client) => (
                  <tr key={client.id} className="border-t border-border/80">
                    <td className="px-5 py-4">
                      <div className="font-semibold text-white">{client.name}</div>
                      <div className="mt-1 text-xs text-slate-500">{client.campaign_name || '-'}</div>
                    </td>
                    <td className="px-5 py-4 text-slate-300">{formatCpfDisplay(client.cpf)}</td>
                    <td className="px-5 py-4 text-slate-300">{formatPhoneDisplay(client.phone || '') || '-'}</td>
                    <td className="px-5 py-4 text-slate-300">{client.email || '-'}</td>
                    <td className="px-5 py-4 text-slate-300">{client.base_convenio || client.base_name || '-'}</td>
                    <td className="px-5 py-4 text-slate-300">{String(client.raw_data?.matricula || client.raw_data?.Matricula || '-')}</td>
                    <td className="px-5 py-4">
                      <Badge tone={client.consulta_status === 'com_marg' ? 'success' : client.consulta_status === 'erro' ? 'danger' : 'neutral'}>
                        {client.best_net_margin_formatted || client.consulta_status_label || '-'}
                      </Badge>
                    </td>
                    <td className="px-5 py-4">
                      <Badge tone={statusTone(client.status_atendimento || client.status)}>{client.status_label || client.status_atendimento || client.status}</Badge>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap gap-2">
                        <Button variant="secondary" className="px-4 py-2" onClick={() => navigate(`/atendimento?clientId=${client.id}`)}>
                          Atender
                        </Button>
                        <Button variant="ghost" className="px-4 py-2" onClick={() => navigate(`/consulta-telefones?client_id=${client.id}`)}>
                          Telefones
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-sm text-slate-500">
            Nenhum cliente encontrado com os filtros atuais.
            <div className="mt-3">
              <Button onClick={() => navigate('/upload')}>
                <ArrowRight size={16} />
                Importar nova lista
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function statusTone(status?: string): 'neutral' | 'accent' | 'success' | 'danger' | 'info' {
  if (status === 'convertido') return 'success';
  if (status === 'em_atendimento') return 'accent';
  if (status === 'aguardando_retorno') return 'info';
  if (status === 'sem_interesse') return 'danger';
  return 'neutral';
}
