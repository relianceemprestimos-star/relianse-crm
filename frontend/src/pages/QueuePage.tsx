import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Search, UserRoundCheck, Users } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import { formatCurrencyDisplay, getMarginSummary } from '../lib/margins';
import { openWhatsAppConversation } from '../lib/whatsapp';
import type { Base, Client, ClientsResponse, Settings } from '../types';
import { Badge, Button, Card, Input, Select, SectionHeader, StatCard } from '../components/ui';

type QueueFilters = {
  status_atendimento: string;
  consulta_status: string;
  base_id: string;
  base_type: string;
  convenio: string;
  estado: string;
  cidade: string;
  assigned_to: string;
  margin_state: string;
  best_product_type: string;
  search: string;
};

export default function QueuePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [response, setResponse] = useState<ClientsResponse | null>(null);
  const [bases, setBases] = useState<Base[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [startingId, setStartingId] = useState<number | null>(null);
  const [filters, setFilters] = useState<QueueFilters>(() => ({
    status_atendimento: '',
    consulta_status: '',
    base_id: searchParams.get('base_id') || '',
    base_type: '',
    convenio: '',
    estado: '',
    cidade: '',
    assigned_to: '',
    margin_state: '',
    best_product_type: '',
    search: '',
  }));

  useEffect(() => {
    let active = true;
    async function loadBases() {
      try {
        const response = await api.getBases({ include_archived: '1' });
        if (!active) return;
        setBases(response.bases || []);
      } catch {
        // Keep working even if the base list fails.
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
        const [clientsResponse, settingsResponse] = await Promise.all([api.getClients(filters), api.getSettings()]);
        if (!active) return;
        setResponse(clientsResponse);
        setSettings(settingsResponse.settings);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar a fila.');
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [filters]);

  async function startClient(client: Client) {
    try {
      setStartingId(client.id);
      const started = await api.startClient(client.id);
      toast.success('Cliente enviado para atendimento.');
      navigate(`/atendimento?clientId=${started.client.id}${filters.base_id ? `&base_id=${filters.base_id}` : ''}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao iniciar atendimento.');
    } finally {
      setStartingId(null);
    }
  }

  async function handleStartNext() {
    try {
      const next = await api.getNextClient(baseScopeFilters(filters));
      if (!next.next) {
        toast('Não há clientes disponíveis para atendimento.');
        return;
      }
      await startClient(next.next.client);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao buscar o próximo cliente.');
    }
  }

  async function handleOpenClientWhatsapp(client: Client) {
    if (!settings) {
      return;
    }

    const link = openWhatsAppConversation(client, settings.whatsapp_message, settings);
    if (!link) {
      toast.error('Telefone indisponível.');
      return;
    }

    try {
      await api.openWhatsappLog(client.id);
      toast.success('WhatsApp aberto.');
    } catch {
      toast.success('WhatsApp aberto.');
    }
  }

  const stats = response?.meta.stats || {};
  const availableBases = bases.length ? bases : response?.meta.bases || response?.meta.campaigns || [];
  const users = response?.meta.users || [];

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Fila de Clientes"
        description="Visualize a posição dos clientes, filtre por base e avance o próximo atendimento com um clique."
        action={
          <Button onClick={handleStartNext}>
            <UserRoundCheck size={16} />
            Atender próximo cliente
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Clientes na fila" value={stats.novo_na_fila ?? 0} icon={<Users size={18} />} />
        <StatCard label="Em atendimento" value={stats.em_atendimento ?? 0} />
        <StatCard label="Finalizados" value={stats.finalizado ?? 0} />
        <StatCard label="Retornos agendados" value={stats.aguardando_retorno ?? 0} />
      </div>

      <Card className="p-5">
        <div className="grid gap-3 xl:grid-cols-6">
          <label className="block text-sm text-slate-300">
            Base
            <Select className="mt-2" value={filters.base_id} onChange={(event) => setFilters((current) => ({ ...current, base_id: event.target.value }))}>
              <option value="">Todas</option>
              {availableBases.map((base) => (
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
              {Array.from(new Set(availableBases.map((base) => base.tipo_base).filter(Boolean))).map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
          </label>

          <label className="block text-sm text-slate-300">
            Convênio / órgão
            <Select className="mt-2" value={filters.convenio} onChange={(event) => setFilters((current) => ({ ...current, convenio: event.target.value }))}>
              <option value="">Todos</option>
              {Array.from(new Set(availableBases.map((base) => base.convenio).filter(Boolean))).map((item) => (
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
              {Array.from(new Set(availableBases.map((base) => base.estado).filter(Boolean))).map((item) => (
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
              {Array.from(new Set(availableBases.map((base) => base.cidade).filter(Boolean))).map((item) => (
                <option key={item} value={item}>
                  {item}
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
            Vendedor
            <Select className="mt-2" value={filters.assigned_to} onChange={(event) => setFilters((current) => ({ ...current, assigned_to: event.target.value }))}>
              <option value="">Todos</option>
              {users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </Select>
          </label>

          <label className="block text-sm text-slate-300">
            Melhor produto
            <Select className="mt-2" value={filters.best_product_type} onChange={(event) => setFilters((current) => ({ ...current, best_product_type: event.target.value }))}>
              <option value="">Todos</option>
              <option value="consignacao">Consignação</option>
              <option value="credito">Crédito</option>
              <option value="cartao">Cartão</option>
            </Select>
          </label>

          <label className="block text-sm text-slate-300 xl:col-span-2">
            Buscar
            <div className="relative mt-2">
              <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
              <Input className="pl-10" value={filters.search} onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))} placeholder="Nome, CPF ou telefone" />
            </div>
          </label>

          <label className="block text-sm text-slate-300">
            Filtro de margem
            <Select className="mt-2" value={filters.margin_state} onChange={(event) => setFilters((current) => ({ ...current, margin_state: event.target.value }))}>
              <option value="">Todos</option>
              <option value="positive">Com margem</option>
              <option value="zero">Sem margem</option>
              <option value="negative">Negativa</option>
              <option value="error">Erro</option>
            </Select>
          </label>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h3 className="text-lg font-semibold text-white">Clientes em fila</h3>
            <p className="text-sm text-slate-500">Organização por status, posição, consulta e base.</p>
          </div>
          <Badge tone="neutral">{response?.clients.length || 0} registros</Badge>
        </div>

        {loading ? (
          <div className="p-8 text-sm text-slate-400">Carregando fila...</div>
        ) : response?.clients.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-[1700px] text-left text-sm">
              <thead className="bg-bg/80 text-slate-400">
                <tr>
                  {['Nome', 'CPF', 'Telefone', 'Base', 'Status atendimento', 'Status consulta', 'Margem líquida consignação', 'Margem líquida crédito', 'Margem líquida cartão', 'Melhor margem', 'Último atendimento', 'Ação'].map((header) => (
                    <th key={header} className="px-5 py-4 font-medium">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {response.clients.map((client) => {
                  const summary = getMarginSummary(client);
                  return (
                    <tr key={client.id} className="border-t border-border/80">
                      <td className="px-5 py-4">
                        <div className="font-semibold text-white">{client.name}</div>
                        <div className="mt-1 text-xs text-slate-500">Posição #{client.queue_position}</div>
                      </td>
                      <td className="px-5 py-4 text-slate-300">{client.cpf}</td>
                      <td className="px-5 py-4 text-slate-300">{client.phone || '-'}</td>
                      <td className="px-5 py-4">
                        <div className="font-semibold text-white">{client.base_name || client.campaign_name || '-'}</div>
                        <div className="mt-1 text-xs text-slate-500">{client.base_type || client.base_convenio || '-'}</div>
                      </td>
                      <td className="px-5 py-4">
                        <Badge tone={badgeTone(client.status_atendimento || client.status)}>{client.status_label || client.status_atendimento || client.status}</Badge>
                      </td>
                      <td className="px-5 py-4">
                        <Badge tone={consultaTone(client.consulta_status)}>{client.consulta_status_label || client.consulta_status}</Badge>
                      </td>
                      <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(client.margem_liquida_consignacao)}</td>
                      <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(client.margem_liquida_credito)}</td>
                      <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(client.margem_liquida_cartao)}</td>
                      <td className="px-5 py-4 text-slate-300">
                        <div className="font-semibold text-white">{summary.bestProductLabel}</div>
                        <div className="text-xs text-slate-500">{summary.bestNetMarginFormatted}</div>
                      </td>
                      <td className="px-5 py-4 text-slate-300">{client.last_interaction_at_formatted || '-'}</td>
                      <td className="px-5 py-4">
                        <div className="flex gap-2">
                          <Button variant="secondary" className="px-4 py-2" onClick={() => void startClient(client)} disabled={startingId === client.id}>
                            Atender
                          </Button>
                          <Button variant="ghost" className="px-4 py-2" onClick={() => void handleOpenClientWhatsapp(client)}>
                            WhatsApp
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-sm text-slate-400">Nenhum cliente encontrado com os filtros atuais.</div>
        )}
      </Card>
    </div>
  );
}

function badgeTone(status?: string) {
  if (status === 'convertido') return 'success';
  if (status === 'sem_interesse' || status === 'finalizado') return 'neutral';
  if (status === 'aguardando_retorno') return 'info';
  if (status === 'em_atendimento') return 'accent';
  return 'neutral';
}

function consultaTone(status?: string) {
  if (status === 'com_marg') return 'success';
  if (status === 'erro') return 'danger';
  return 'neutral';
}

function baseScopeFilters(filters: Pick<QueueFilters, 'base_id' | 'base_type' | 'convenio' | 'estado' | 'cidade'>) {
  return {
    base_id: filters.base_id || undefined,
    base_type: filters.base_type || undefined,
    convenio: filters.convenio || undefined,
    estado: filters.estado || undefined,
    cidade: filters.cidade || undefined,
  };
}
