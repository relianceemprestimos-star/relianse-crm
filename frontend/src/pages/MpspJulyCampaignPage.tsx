import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Download, MessageCircle, Search, ShieldCheck, UserRoundCheck, Users } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import { formatCurrencyDisplay, getMarginSummary } from '../lib/margins';
import { createWhatsAppLink } from '../lib/whatsapp';
import type { Campaign, Client, Settings } from '../types';
import { Badge, Button, Card, Input, SectionHeader, StatCard } from '../components/ui';

const TARGET_CAMPAIGN_NAME = 'MPSP Gratificação Natalina Julho 2026';

type QuickFilter = 'todos' | 'com_margem' | 'nao_permite';

function rawValue(client: Client, key: string) {
  const raw = client.raw_data || {};
  const value = raw[key];
  return value === null || value === undefined ? '' : String(value);
}

function portalStatus(client: Client) {
  return rawValue(client, 'Portal Status') || (client.consulta_status === 'com_marg' ? 'MP_CONFIRMADO_COM_MARGEM' : 'CLIENTE_NAO_PERMITE_CONSULTA');
}

function portalLabel(client: Client) {
  const status = portalStatus(client);
  if (status === 'MP_CONFIRMADO_COM_MARGEM') return 'Com margem';
  if (status === 'CLIENTE_NAO_PERMITE_CONSULTA') return 'Não permite consulta';
  return rawValue(client, 'Retorno Portal') || status || '-';
}

function portalTone(client: Client) {
  const status = portalStatus(client);
  if (status === 'MP_CONFIRMADO_COM_MARGEM') return 'success';
  if (status === 'CLIENTE_NAO_PERMITE_CONSULTA') return 'warning';
  return 'neutral';
}

function onlyDigits(value: string) {
  return String(value || '').replace(/\D/g, '');
}

export default function MpspJulyCampaignPage() {
  const navigate = useNavigate();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [startingId, setStartingId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('todos');

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        setLoading(true);
        const [campaignResponse, settingsResponse] = await Promise.all([
          api.getCampaigns({ include_archived: '1' }),
          api.getSettings().catch(() => ({ settings: null as Settings | null })),
        ]);
        if (!active) return;

        const found =
          (campaignResponse.campaigns || []).find((item) => item.name === TARGET_CAMPAIGN_NAME) ||
          (campaignResponse.campaigns || []).find((item) => item.name?.toLowerCase().includes('mpsp'));

        if (!found) {
          setCampaign(null);
          setClients([]);
          setSettings(settingsResponse.settings);
          return;
        }

        setCampaign(found);
        setSettings(settingsResponse.settings);
        const clientsResponse = await api.getClients({ campaign_id: found.id, include_archived: '1' });
        if (!active) return;
        setClients(clientsResponse.clients || []);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar a campanha MPSP.');
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  const sortedClients = useMemo(
    () =>
      [...clients].sort((a, b) => {
        const marginA = Number(a.margem_liquida_consignacao ?? a.best_net_margin ?? 0);
        const marginB = Number(b.margem_liquida_consignacao ?? b.best_net_margin ?? 0);
        return marginB - marginA;
      }),
    [clients]
  );

  const filteredClients = useMemo(() => {
    const term = search.trim().toLowerCase();
    return sortedClients.filter((client) => {
      if (quickFilter === 'com_margem' && portalStatus(client) !== 'MP_CONFIRMADO_COM_MARGEM') return false;
      if (quickFilter === 'nao_permite' && portalStatus(client) !== 'CLIENTE_NAO_PERMITE_CONSULTA') return false;
      if (!term) return true;
      return (
        client.name.toLowerCase().includes(term) ||
        onlyDigits(client.cpf).includes(onlyDigits(term)) ||
        onlyDigits(client.phone).includes(onlyDigits(term))
      );
    });
  }, [quickFilter, search, sortedClients]);

  const totals = useMemo(
    () => ({
      total: clients.length,
      comMargem: clients.filter((client) => portalStatus(client) === 'MP_CONFIRMADO_COM_MARGEM').length,
      naoPermite: clients.filter((client) => portalStatus(client) === 'CLIENTE_NAO_PERMITE_CONSULTA').length,
      comTelefone: clients.filter((client) => Boolean(client.phone || client.phones?.length)).length,
    }),
    [clients]
  );

  async function startClient(client: Client) {
    try {
      setStartingId(client.id);
      const started = await api.startClient(client.id);
      toast.success('Cliente enviado para atendimento.');
      navigate(`/atendimento?clientId=${started.client.id}${campaign ? `&campaign_id=${campaign.id}` : ''}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao iniciar atendimento.');
    } finally {
      setStartingId(null);
    }
  }

  async function openWhatsapp(client: Client) {
    if (!settings) {
      toast.error('Configurações do WhatsApp indisponíveis.');
      return;
    }
    const link = createWhatsAppLink(client, settings.whatsapp_message, settings);
    if (!link) {
      toast.error('Telefone indisponível.');
      return;
    }
    try {
      await api.openWhatsappLog(client.id);
      window.open(link, '_blank', 'noopener,noreferrer');
      toast.success('WhatsApp aberto.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'WhatsApp bloqueado por regra de consentimento.');
    }
  }

  async function exportCampaign() {
    if (!campaign) return;
    try {
      const blob = await api.exportClientsWithPhones({ campaign_id: campaign.id });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'mpsp-gratificacao-julho-2026-clientes.xlsx';
      link.click();
      URL.revokeObjectURL(url);
      toast.success('Download da campanha gerado.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao exportar campanha.');
    }
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        title="MPSP Julho"
        description="Clientes da gratificação natalina de julho já confirmados no Portal do Consignado e enriquecidos com Datafour."
        action={
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => navigate(campaign ? `/fila?campaign_id=${campaign.id}` : '/fila')}>
              <Users size={16} />
              Ver na fila
            </Button>
            <Button variant="secondary" onClick={() => void exportCampaign()} disabled={!campaign}>
              <Download size={16} />
              Baixar
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Clientes na aba" value={totals.total} icon={<Users size={18} />} />
        <StatCard label="Com margem" value={totals.comMargem} />
        <StatCard label="Não permite consulta" value={totals.naoPermite} />
        <StatCard label="Com telefone" value={totals.comTelefone} />
      </div>

      {!loading && !campaign ? (
        <Card className="p-8">
          <h3 className="text-lg font-semibold text-white">Campanha MPSP não encontrada</h3>
          <p className="mt-2 text-sm text-slate-400">
            Não encontrei a campanha {TARGET_CAMPAIGN_NAME}. Reimporte a base ou abra Campanhas para conferir se ela foi arquivada.
          </p>
          <Button className="mt-5" onClick={() => navigate('/campanhas')}>
            Abrir campanhas
          </Button>
        </Card>
      ) : null}

      <Card className="p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap gap-2">
            <FilterButton active={quickFilter === 'todos'} onClick={() => setQuickFilter('todos')}>
              Todos
            </FilterButton>
            <FilterButton active={quickFilter === 'com_margem'} onClick={() => setQuickFilter('com_margem')}>
              Com margem
            </FilterButton>
            <FilterButton active={quickFilter === 'nao_permite'} onClick={() => setQuickFilter('nao_permite')}>
              Não permite
            </FilterButton>
          </div>
          <div className="relative w-full xl:max-w-md">
            <Search size={16} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
            <Input className="pl-10" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar nome, CPF ou telefone" />
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h3 className="text-lg font-semibold text-white">Todos os clientes MPSP Julho</h3>
            <p className="text-sm text-slate-500">Ordenado pela maior margem líquida disponível.</p>
          </div>
          <Badge tone="neutral">{filteredClients.length} registros</Badge>
        </div>

        {loading ? (
          <div className="p-8 text-sm text-slate-400">Carregando MPSP Julho...</div>
        ) : filteredClients.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-[1500px] text-left text-sm">
              <thead className="bg-bg/80 text-slate-400">
                <tr>
                  {['Nome', 'CPF', 'Telefone', 'Portal', 'Cargo', 'Margem bruta', 'Margem líquida', 'Melhor margem', 'Aniversário', 'Status', 'Ação'].map((header) => (
                    <th key={header} className="px-5 py-4 font-medium">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredClients.map((client) => {
                  const summary = getMarginSummary(client);
                  return (
                    <tr key={client.id} className="border-t border-border/80">
                      <td className="px-5 py-4">
                        <div className="font-semibold text-white">{client.name}</div>
                        <div className="mt-1 text-xs text-slate-500">{client.base_name || campaign?.name || '-'}</div>
                      </td>
                      <td className="px-5 py-4 text-slate-300">{client.cpf}</td>
                      <td className="px-5 py-4 text-slate-300">{client.phone || '-'}</td>
                      <td className="px-5 py-4">
                        <Badge tone={portalTone(client) as any}>{portalLabel(client)}</Badge>
                      </td>
                      <td className="px-5 py-4 text-slate-300">{rawValue(client, 'Cargo') || '-'}</td>
                      <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(client.margem_bruta_consignacao)}</td>
                      <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(client.margem_liquida_consignacao)}</td>
                      <td className="px-5 py-4 text-slate-300">
                        <div className="font-semibold text-white">{summary.bestProductLabel}</div>
                        <div className="text-xs text-slate-500">{summary.bestNetMarginFormatted}</div>
                      </td>
                      <td className="px-5 py-4">
                        <Badge tone="accent">{rawValue(client, 'Aniversariante') || 'Julho'}</Badge>
                      </td>
                      <td className="px-5 py-4">
                        <Badge tone={client.status_atendimento === 'em_atendimento' ? 'accent' : 'neutral'}>
                          {client.status_label || client.status_atendimento || client.status}
                        </Badge>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex gap-2">
                          <Button variant="secondary" className="px-4 py-2" onClick={() => void startClient(client)} disabled={startingId === client.id}>
                            <UserRoundCheck size={15} />
                            Atender
                          </Button>
                          <Button variant="ghost" className="px-4 py-2" onClick={() => void openWhatsapp(client)}>
                            <MessageCircle size={15} />
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
          <div className="p-8 text-sm text-slate-400">Nenhum cliente encontrado neste filtro.</div>
        )}
      </Card>

      <Card className="flex items-start gap-3 border-info/20 bg-info/5 p-5">
        <ShieldCheck className="mt-1 text-info" size={20} />
        <div>
          <p className="font-semibold text-white">Critério desta aba</p>
          <p className="mt-1 text-sm text-slate-400">
            Entram aqui somente clientes confirmados como MPSP no Portal do Consignado: com margem carregada ou cliente confirmado que não permite consulta.
          </p>
        </div>
      </Card>
    </div>
  );
}

function FilterButton({ active, children, onClick }: { active: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button
      className={[
        'rounded-xl border px-4 py-2 text-sm font-semibold transition',
        active ? 'border-info/40 bg-info/20 text-white' : 'border-border text-slate-400 hover:bg-white/5 hover:text-white',
      ].join(' ')}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
