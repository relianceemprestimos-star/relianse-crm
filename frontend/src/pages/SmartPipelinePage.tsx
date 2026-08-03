import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  Clock,
  Database,
  FileDown,
  Megaphone,
  Phone,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  Upload,
  Users,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { Badge, Button, Card, SectionHeader, Select, StatCard } from '../components/ui';
import { api } from '../lib/api';
import { formatMoney } from '../lib/privacy';
import type { Base, CampaignOpportunity, CampaignOpportunitySummary, DispatchCampaign } from '../types';

type StepStatus = 'done' | 'current' | 'waiting';
type DownloadBaseScope = 'prefeitura_ribeirao' | 'gov_sp';

const DOWNLOAD_BASE_SCOPES: Array<{ value: DownloadBaseScope; label: string }> = [
  { value: 'prefeitura_ribeirao', label: 'Prefeitura de Ribeirão' },
  { value: 'gov_sp', label: 'Governo de SP' },
];

const EMPTY_PIPELINE_SUMMARY: CampaignOpportunitySummary = {
  total_importado: 0,
  com_margem: 0,
  sem_margem: 0,
  erro_margem: 0,
  elegiveis: 0,
  sem_oportunidade: 0,
  analise_manual: 0,
  com_telefone: 0,
  sem_telefone: 0,
  aguardando_coeficiente: 0,
};

const GROUP_LABELS: Record<string, string> = {
  FUTURO_ELEGIVEL: 'Futuro elegível',
  BIB_ELEGIVEL: 'BIB elegível',
  BIB_PRAZO_REDUZIDO: 'BIB prazo reduzido',
  GOV_SP_ELEGIVEL: 'Gov SP elegível',
  SEM_BANCO: 'Sem banco',
  GOV_SP_SEM_BANCO: 'Gov SP sem banco',
  ANALISE_MANUAL: 'Análise manual',
  SEM_TELEFONE: 'Sem telefone',
  SEM_OPORTUNIDADE: 'Sem oportunidade',
  SEM_MARGEM_CONSIGNADO: 'Sem margem',
};

function pct(value: number, total: number) {
  if (!total) return '0%';
  return `${((value / total) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

function moneyRange(value: number) {
  if (value <= 5000) return 'Até 5k';
  if (value <= 10000) return '5k a 10k';
  if (value <= 15000) return '10k a 15k';
  if (value <= 20000) return '15k a 20k';
  if (value <= 30000) return '20k a 30k';
  return 'Acima de 30k';
}

function isPipelineBase(base: Base) {
  const type = String(base.tipo_base || '').toLowerCase();
  const notes = String(base.observacao || '').toLowerCase();
  return notes.includes('[finalidade:esteira]') || type.includes('esteira') || type.includes('campanha');
}

function normalizeSearchText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function baseMatchesDownloadScope(base: Base, scope: DownloadBaseScope) {
  const text = normalizeSearchText([
    base.nome_base,
    base.convenio,
    base.tipo_base,
    base.estado,
    base.cidade,
    base.observacao,
    base.arquivo_original,
  ].filter(Boolean).join(' '));

  if (scope === 'prefeitura_ribeirao') {
    return text.includes('ribeirao') || (text.includes('prefeitura') && text.includes('rp'));
  }

  return (
    text.includes('gov sp') ||
    text.includes('governo sp') ||
    text.includes('governo de sao paulo') ||
    text.includes('governo estadual') ||
    text.includes('sao paulo')
  );
}

export default function SmartPipelinePage() {
  const navigate = useNavigate();
  const [bases, setBases] = useState<Base[]>([]);
  const [opportunities, setOpportunities] = useState<CampaignOpportunity[]>([]);
  const [pipelineSummary, setPipelineSummary] = useState<CampaignOpportunitySummary>(EMPTY_PIPELINE_SUMMARY);
  const [pipelineGroups, setPipelineGroups] = useState<Array<{ grupo: string; total: number }>>([]);
  const [campaigns, setCampaigns] = useState<DispatchCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [importScope, setImportScope] = useState<DownloadBaseScope>('prefeitura_ribeirao');
  const [downloadScope, setDownloadScope] = useState<DownloadBaseScope>('prefeitura_ribeirao');
  const [downloadBaseId, setDownloadBaseId] = useState('');

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        setLoading(true);
        const [basesResponse, opportunitiesResponse, dispatchResponse] = await Promise.all([
          api.getBases({ include_archived: '1' }).catch(() => ({ bases: [] as Base[] })),
          api.getCampaignOpportunities().catch(() => ({ oportunidades: [] as CampaignOpportunity[], total: 0, coeficiente: null, prazo: null, resumo: EMPTY_PIPELINE_SUMMARY, grupos: [] })),
          api.getDispatchCampaigns().catch(() => ({ campanhas: [] as DispatchCampaign[] })),
        ]);

        if (!active) return;
        setBases(basesResponse.bases || []);
        setOpportunities(opportunitiesResponse.oportunidades || []);
        setPipelineSummary(opportunitiesResponse.resumo || EMPTY_PIPELINE_SUMMARY);
        setPipelineGroups(opportunitiesResponse.grupos || []);
        setCampaigns(dispatchResponse.campanhas || []);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar a esteira.');
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  const pipelineBases = useMemo(() => bases.filter(isPipelineBase), [bases]);
  const downloadBaseCandidates = useMemo(
    () => pipelineBases.filter((base) => baseMatchesDownloadScope(base, downloadScope)),
    [downloadScope, pipelineBases]
  );

  useEffect(() => {
    if (!downloadBaseCandidates.length) {
      if (downloadBaseId) setDownloadBaseId('');
      return;
    }

    if (!downloadBaseCandidates.some((base) => String(base.id) === String(downloadBaseId))) {
      setDownloadBaseId(String(downloadBaseCandidates[0].id));
    }
  }, [downloadBaseCandidates, downloadBaseId]);

  async function handleDownloadSelectedBase() {
    const selectedBase = downloadBaseCandidates.find((base) => String(base.id) === String(downloadBaseId));
    if (!selectedBase) {
      toast.error('Importe primeiro uma base da Esteira para este convênio.');
      return;
    }

    try {
      const blob = await api.exportClientsWithPhones({ base_id: selectedBase.id });
      const url = window.URL.createObjectURL(blob);
      const safeName = String(selectedBase.nome_base || `base-${selectedBase.id}`)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
      const link = document.createElement('a');
      link.href = url;
      link.download = `${safeName || `base-${selectedBase.id}`}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success('Download da base iniciado.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao baixar a base.');
    }
  }

  function openPipelineImport() {
    navigate(`/upload?purpose=esteira&convenio=${importScope}`);
  }

  const metrics = useMemo(() => {
    const totalBase = pipelineSummary.total_importado || pipelineBases.reduce((sum, base) => sum + Number(base.total_clientes || 0), 0);
    const withMargin = pipelineSummary.com_margem || pipelineBases.reduce((sum, base) => sum + Number(base.total_com_margem || 0), 0);
    const withPhone = pipelineSummary.com_telefone || opportunities.filter((row) => row.telefone).length;
    const eligible = pipelineSummary.elegiveis || opportunities.length;
    const readyCampaign = campaigns.reduce((sum, campaign) => sum + Number(campaign.total_disparos || 0), 0);
    const byConvenio = opportunities.reduce<Record<string, CampaignOpportunity[]>>((acc, row) => {
      const key = row.convenio_label || row.convenio || 'Convênio';
      acc[key] = acc[key] || [];
      acc[key].push(row);
      return acc;
    }, {});
    const operational = opportunities.reduce<Record<string, number>>((acc, row) => {
      const range = moneyRange(Number(row.valor_liberado || 0));
      acc[range] = (acc[range] || 0) + 1;
      return acc;
    }, {});

    return { totalBase, withMargin, withPhone, eligible, readyCampaign, byConvenio, operational };
  }, [campaigns, opportunities, pipelineBases, pipelineSummary]);

  const steps: Array<{ label: string; hint: string; status: StepStatus; icon: typeof Check }> = [
    { label: 'Base importada', hint: metrics.totalBase ? 'Concluído' : 'Aguardando', status: metrics.totalBase ? 'done' : 'waiting', icon: Check },
    { label: 'Margem consultada', hint: metrics.withMargin ? 'Concluído' : 'Aguardando', status: metrics.withMargin ? 'done' : 'waiting', icon: Check },
    { label: 'Regras aplicadas', hint: opportunities.length ? 'Concluído' : 'Aguardando', status: opportunities.length ? 'done' : 'waiting', icon: Check },
    { label: 'Nova Vida', hint: metrics.withPhone ? 'Em andamento' : 'Aguardando', status: metrics.withPhone ? 'current' : 'waiting', icon: Phone },
    { label: 'Simulação', hint: opportunities.length ? 'Pronto' : pipelineSummary.aguardando_coeficiente ? 'Aguardando coeficiente' : 'Aguardando', status: opportunities.length ? 'done' : pipelineSummary.aguardando_coeficiente ? 'current' : 'waiting', icon: TrendingUp },
    { label: 'Classificação', hint: opportunities.length ? 'Pronto' : metrics.eligible ? 'Aguardando coeficiente' : 'Aguardando', status: opportunities.length ? 'done' : metrics.eligible ? 'current' : 'waiting', icon: ShieldCheck },
    { label: 'Campanha', hint: campaigns.length ? 'Configurada' : 'Aguardando', status: campaigns.length ? 'done' : 'waiting', icon: Megaphone },
    { label: 'Disparo', hint: metrics.readyCampaign ? 'Pronto' : 'Aguardando', status: metrics.readyCampaign ? 'current' : 'waiting', icon: Send },
  ];

  const convenioEntries = Object.entries(metrics.byConvenio).slice(0, 2);
  const activeCampaign = campaigns[0];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Esteira Inteligente"
        description="Acompanhe o fluxo automatizado da base importada até o disparo controlado da campanha."
        action={
          <div className="flex flex-wrap gap-3">
            <Button onClick={openPipelineImport}>
              <Upload size={16} />
              Importar base da esteira
            </Button>
            <Button variant="secondary" onClick={() => navigate('/bases')}>
              Ver bases
              <ArrowRight size={16} />
            </Button>
          </div>
        }
      />

      {!pipelineBases.length ? (
        <Card className="border-accent/20 bg-accent/8 p-5">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <Badge tone="accent">Primeiro passo</Badge>
              <h3 className="mt-3 text-xl font-bold text-white">Importe uma base específica para a Esteira</h3>
              <p className="mt-1 max-w-3xl text-sm text-slate-300">
                Bases usadas só para consulta de margem não entram aqui. Para aparecer nessa tela, importe com a finalidade
                <span className="font-semibold text-white"> Esteira/Campanha</span>.
              </p>
            </div>
            <div className="grid w-full gap-3 md:grid-cols-[260px_180px] xl:max-w-md">
              <label className="block text-sm text-slate-300">
                Convênio da base
                <Select className="mt-2" value={importScope} onChange={(event) => setImportScope(event.target.value as DownloadBaseScope)}>
                  {DOWNLOAD_BASE_SCOPES.map((scope) => (
                    <option key={scope.value} value={scope.value}>
                      {scope.label}
                    </option>
                  ))}
                </Select>
              </label>
              <Button className="mt-7 shrink-0" onClick={openPipelineImport}>
                <Upload size={16} />
                Importar agora
              </Button>
            </div>
          </div>
        </Card>
      ) : null}

      <Card className="p-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-2xl">
            <Badge tone="accent">Download controlado</Badge>
            <h3 className="mt-3 text-xl font-bold text-white">Escolha a base que vai baixar</h3>
            <p className="mt-1 text-sm text-slate-400">
              A origem Governo de SP pode reunir vários órgãos dentro do mesmo portal; o CRM usa o vínculo retornado na consulta.
            </p>
          </div>

          <div className="grid w-full gap-3 md:grid-cols-[220px_1fr_180px] xl:max-w-4xl">
            <label className="block text-sm text-slate-300">
              Convênio
              <Select className="mt-2" value={downloadScope} onChange={(event) => setDownloadScope(event.target.value as DownloadBaseScope)}>
                {DOWNLOAD_BASE_SCOPES.map((scope) => (
                  <option key={scope.value} value={scope.value}>
                    {scope.label}
                  </option>
                ))}
              </Select>
            </label>

            <label className="block text-sm text-slate-300">
              Base importada
              <Select className="mt-2" value={downloadBaseId} onChange={(event) => setDownloadBaseId(event.target.value)} disabled={!downloadBaseCandidates.length}>
                {downloadBaseCandidates.length ? (
                  downloadBaseCandidates.map((base) => (
                    <option key={base.id} value={base.id}>
                      {base.nome_base} - {Number(base.total_clientes || 0).toLocaleString('pt-BR')} clientes
                    </option>
                  ))
                ) : (
                  <option value="">Nenhuma base encontrada</option>
                )}
              </Select>
            </label>

            <Button className="mt-7" onClick={() => void handleDownloadSelectedBase()} disabled={!downloadBaseCandidates.length}>
              <FileDown size={16} />
              Baixar base
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
          {steps.map((step, index) => {
            const Icon = step.icon;
            return (
              <div key={step.label} className="flex min-w-[120px] flex-1 items-center gap-4">
                <div className="flex flex-col items-center text-center">
                  <div
                    className={[
                      'flex h-11 w-11 items-center justify-center rounded-full border text-sm font-bold',
                      step.status === 'done' ? 'border-accent bg-accent text-slate-950' : '',
                      step.status === 'current' ? 'border-info bg-info/10 text-blue-300 shadow-[0_0_20px_rgba(59,130,246,.25)]' : '',
                      step.status === 'waiting' ? 'border-slate-600 bg-white/5 text-slate-400' : '',
                    ].join(' ')}
                  >
                    {step.status === 'done' ? <Icon size={18} /> : index + 1}
                  </div>
                  <p className="mt-3 text-sm font-semibold text-white">{step.label}</p>
                  <p className={step.status === 'current' ? 'text-xs text-blue-300' : 'text-xs text-slate-400'}>{step.hint}</p>
                </div>
                {index < steps.length - 1 ? <ArrowRight className="hidden flex-none text-slate-500 lg:block" size={18} /> : null}
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Base importada" value={metrics.totalBase.toLocaleString('pt-BR')} hint="100% do total" icon={<Users size={18} />} />
        <StatCard label="Com margem" value={metrics.withMargin.toLocaleString('pt-BR')} hint={`${pct(metrics.withMargin, metrics.totalBase)} do total`} icon={<Database size={18} />} />
        <StatCard label="Com telefone" value={metrics.withPhone.toLocaleString('pt-BR')} hint={`${pct(metrics.withPhone, metrics.totalBase)} do total`} icon={<Phone size={18} />} />
        <StatCard label="Elegíveis" value={metrics.eligible.toLocaleString('pt-BR')} hint={`${pct(metrics.eligible, metrics.totalBase)} do total`} icon={<ShieldCheck size={18} />} />
        <StatCard label="Prontos p/ disparo" value={(activeCampaign?.total_disparos || metrics.readyCampaign || 0).toLocaleString('pt-BR')} hint="Campanha controlada" icon={<Send size={18} />} />
      </div>

      <Card className="p-5">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h3 className="text-lg font-bold text-white">Resultado do processamento</h3>
            <p className="mt-1 text-sm text-slate-400">
              A base da Esteira passa por margem, regras, Nova Vida e fica aguardando coeficiente quando necessário.
            </p>
          </div>
          {pipelineSummary.aguardando_coeficiente ? (
            <Button onClick={() => navigate('/campanhas/coeficiente')}>
              Cadastrar coeficiente
              <ArrowRight size={16} />
            </Button>
          ) : null}
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <SummaryBox label="Sem margem" value={pipelineSummary.sem_margem} />
          <SummaryBox label="Erro na margem" value={pipelineSummary.erro_margem} />
          <SummaryBox label="Sem telefone" value={pipelineSummary.sem_telefone} />
          <SummaryBox label="Análise manual" value={pipelineSummary.analise_manual} />
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {(pipelineGroups.length ? pipelineGroups : [{ grupo: 'AGUARDANDO_PROCESSAMENTO', total: 0 }]).slice(0, 8).map((group) => (
            <div key={group.grupo} className="rounded-2xl border border-border bg-bg/55 p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-slate-500">{group.grupo}</p>
              <p className="mt-2 text-base font-bold text-white">{GROUP_LABELS[group.grupo] || group.grupo}</p>
              <p className="mt-1 text-2xl font-bold text-accent">{Number(group.total || 0).toLocaleString('pt-BR')}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.45fr_0.75fr]">
        <div className="space-y-6">
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-lg font-bold text-white">Resumo por convênio</h3>
              <button className="text-sm font-semibold text-info" onClick={() => navigate('/campanhas/oportunidades')}>
                Ver todas
              </button>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              {(convenioEntries.length ? convenioEntries : [['Prefeitura Ribeirão', [] as CampaignOpportunity[]], ['Governo de SP', [] as CampaignOpportunity[]]]).map(
                ([name, rows]) => {
                  const total = rows.length;
                  const consignado = rows.filter((row) => row.produto === 'consignado').length;
                  const card = rows.filter((row) => String(row.produto).includes('cartao')).length;
                  const value = rows.reduce((sum, row) => sum + Number(row.valor_liberado || 0), 0);
                  return (
                    <div key={name} className="rounded-2xl border border-border bg-bg/55 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-base font-bold text-white">{name}</p>
                          <p className="text-xs text-slate-500">Elegíveis e produtos sugeridos</p>
                        </div>
                        <Badge tone={total ? 'success' : 'neutral'}>{total ? 'Ativo' : 'Aguardando'}</Badge>
                      </div>
                      <div className="mt-4 space-y-3 text-sm">
                        <MixLine label="Consignado" value={consignado} total={Math.max(total, 1)} />
                        <MixLine label="Cartão" value={card} total={Math.max(total, 1)} />
                        <MixLine label="Valor liberado" value={formatMoney(value)} total={1} textOnly />
                      </div>
                    </div>
                  );
                }
              )}
            </div>
          </Card>

          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-lg font-bold text-white">Fila operacional</h3>
              <button className="text-sm font-semibold text-info" onClick={() => navigate('/fila')}>
                Ver todas
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <QueueMetric label="Aguardando margem" value={Math.max(metrics.totalBase - metrics.withMargin, 0)} icon={<Clock size={16} />} />
              <QueueMetric label="Consultando" value={metrics.withMargin} icon={<SlidersHorizontal size={16} />} />
              <QueueMetric label="Sem oportunidade" value={Math.max(metrics.withMargin - metrics.eligible, 0)} icon={<Sparkles size={16} />} />
              <QueueMetric label="Com telefone" value={metrics.withPhone} icon={<Phone size={16} />} />
              <QueueMetric label="Pronto para campanha" value={metrics.eligible} icon={<Check size={16} />} />
            </div>
          </Card>
        </div>

        <Card className="p-5">
          <h3 className="text-lg font-bold text-white">Próxima ação</h3>
          <p className="mt-1 text-sm text-slate-400">Recomendações para manter o fluxo andando.</p>
          <div className="mt-5 space-y-4">
            <ActionCard
              title="Cadastrar coeficientes do dia"
              description="Mantém simulações precisas para campanhas."
              button="Cadastrar agora"
              onClick={() => navigate('/campanhas/coeficiente')}
              tone="blue"
            />
            <ActionCard
              title="Escolher público para disparo"
              description={`${metrics.eligible.toLocaleString('pt-BR')} elegíveis prontos para seleção.`}
              button="Escolher público"
              onClick={() => navigate('/campanhas/oportunidades')}
              tone="green"
            />
            <ActionCard
              title="Validar documentos"
              description="Acompanhe checklist e formalização."
              button="Abrir documentos"
              onClick={() => navigate('/documentos')}
              tone="purple"
            />
          </div>
        </Card>
      </div>
      {loading ? <p className="text-sm text-slate-500">Atualizando dados da esteira...</p> : null}
      <p className="text-xs text-slate-500">
        Mostrando apenas bases com finalidade Esteira/Campanha. Bases de consulta de margem ficam em Base & Margem.
      </p>
    </div>
  );
}

function MixLine({ label, value, total, textOnly = false }: { label: string; value: string | number; total: number; textOnly?: boolean }) {
  const numeric = typeof value === 'number' ? value : 0;
  return (
    <div className="grid grid-cols-[120px_1fr_80px] items-center gap-3">
      <span className="text-slate-300">{label}</span>
      <div className="h-2 rounded-full bg-white/8">
        {!textOnly ? <div className="h-2 rounded-full bg-info" style={{ width: `${Math.min(100, (numeric / total) * 100)}%` }} /> : null}
      </div>
      <span className="text-right font-semibold text-white">{value}</span>
    </div>
  );
}

function QueueMetric({ label, value, icon }: { label: string; value: number; icon: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-bg/55 p-4">
      <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-white/8 text-accent">{icon}</div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-bold text-white">{value.toLocaleString('pt-BR')}</p>
    </div>
  );
}

function SummaryBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-border bg-bg/55 p-4">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-bold text-white">{Number(value || 0).toLocaleString('pt-BR')}</p>
    </div>
  );
}

function ActionCard({
  title,
  description,
  button,
  onClick,
  tone,
}: {
  title: string;
  description: string;
  button: string;
  onClick: () => void;
  tone: 'blue' | 'green' | 'purple';
}) {
  const tones = {
    blue: 'from-blue-600 to-blue-500',
    green: 'from-emerald-600 to-emerald-500',
    purple: 'from-violet-600 to-violet-500',
  };
  return (
    <div className="rounded-2xl border border-border bg-bg/55 p-4">
      <div className={`mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br ${tones[tone]} text-white`}>
        <TrendingUp size={20} />
      </div>
      <p className="font-bold text-white">{title}</p>
      <p className="mt-1 text-sm text-slate-400">{description}</p>
      <Button className="mt-4 w-full justify-between" onClick={onClick}>
        {button}
        <ArrowRight size={16} />
      </Button>
    </div>
  );
}
