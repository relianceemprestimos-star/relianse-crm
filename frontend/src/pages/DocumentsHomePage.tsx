import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check, Clock, FileText, Upload, UserRoundCheck, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';

import { Badge, Button, Card, SectionHeader } from '../components/ui';
import { api } from '../lib/api';
import { maskPhone } from '../lib/privacy';
import type { DispatchCampaign } from '../types';

export default function DocumentsHomePage() {
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<DispatchCampaign[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        setLoading(true);
        const response = await api.getDispatchCampaigns();
        if (!active) return;
        setCampaigns(response.campanhas || []);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar documentos.');
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  const activeCampaign = campaigns[0];
  const summary = useMemo(() => {
    const total = campaigns.reduce((sum, campaign) => sum + Number(campaign.total_respostas || 0), 0);
    const accepted = campaigns.reduce((sum, campaign) => sum + Number(campaign.total_aceites || 0), 0);
    return { total, accepted, pending: Math.max(total - accepted, 0) };
  }, [campaigns]);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="WhatsApp & Documentos"
        description="Atendimento automatizado, checklist documental e formalização controlada."
        action={<Badge tone="accent">Zaia ativa</Badge>}
      />

      <div className="grid gap-6 xl:grid-cols-[0.85fr_1.55fr_1fr]">
        <Card className="overflow-hidden">
          <div className="border-b border-border p-5">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-bold text-white">Fila de atendimento</h3>
              <Badge tone="info">{summary.total || campaigns.length}</Badge>
            </div>
            <div className="mt-4 rounded-2xl border border-border bg-bg/70 px-4 py-3 text-sm text-slate-500">Buscar contato ou protocolo...</div>
          </div>
          <div className="divide-y divide-border/70">
            {(campaigns.length ? campaigns.slice(0, 6) : fallbackContacts).map((item, index) => {
              const name = 'nome' in item ? item.nome : item.name;
              const convenio = 'convenio' in item ? item.convenio : item.convenio;
              const status = 'status' in item ? item.status : item.status;
              return (
                <button
                  key={`${name}-${index}`}
                  className="block w-full px-5 py-4 text-left transition hover:bg-white/5"
                  onClick={() => ('id' in item ? navigate(`/campanhas/disparo/${item.id}`) : undefined)}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-500/20 font-bold text-emerald-200">
                      {name.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate font-semibold text-white">{name}</p>
                        <span className="text-xs text-slate-500">09:{42 - index}</span>
                      </div>
                      <p className="mt-1 truncate text-xs text-slate-500">{convenio || 'Campanha'} · {status || 'Aguardando docs'}</p>
                      <p className="mt-2 text-xs text-accent">{index % 2 ? 'Enviou documentos' : 'Aguardando resposta'}</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-border p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-bold text-white">{activeCampaign?.nome || 'Campanha Maio/2025'}</h3>
                <p className="text-sm text-slate-400">{maskPhone(activeCampaign?.sessao_rewhats || '(11) 98765-4321')} · atendimento via Zaia</p>
              </div>
              <Button variant="secondary" onClick={() => navigate('/campanhas/disparos')}>
                Transferir para humano
              </Button>
            </div>
            <div className="mt-4 grid gap-3 text-sm sm:grid-cols-4">
              <Line label="Convênio" value={activeCampaign?.convenio || 'Governador SP'} />
              <Line label="Produto" value={activeCampaign?.produto || 'Empréstimo consignado'} />
              <Line label="Banco base" value={activeCampaign?.banco || 'Banco BMG'} />
              <Line label="Status" value={activeCampaign?.status || 'Zaia ativa'} />
            </div>
          </div>

          <div className="space-y-4 bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,.12),transparent_28%)] p-5">
            <div className="ml-auto max-w-lg rounded-2xl bg-blue-600/25 px-4 py-3 text-sm text-blue-50">
              Oie, tudo bem? Seu pedido de simulação foi aprovado. Posso seguir com o envio do contrato após receber os documentos?
              <div className="mt-2 text-right text-xs text-blue-200">09:37</div>
            </div>
            <div className="max-w-md rounded-2xl bg-white/8 px-4 py-3 text-sm text-slate-100">
              Perfeito! Pode seguir sim. Já vou enviar os documentos.
              <div className="mt-2 text-right text-xs text-slate-500">09:41</div>
            </div>
            <div className="max-w-xl rounded-2xl border border-border bg-bg/70 p-4">
              <p className="mb-3 font-semibold text-white">Documentos enviados</p>
              <div className="grid gap-3 sm:grid-cols-4">
                {['Holerite_05_2025.pdf', 'RG_cliente.jpg', 'Extrato_30_dias.pdf', 'Dados_bancarios.pdf'].map((name) => (
                  <div key={name} className="rounded-xl border border-border bg-white/5 p-3">
                    <FileText size={20} className="text-slate-300" />
                    <p className="mt-3 truncate text-xs font-semibold text-white">{name}</p>
                    <p className="text-xs text-slate-500">Recebido</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>

        <div className="space-y-6">
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="font-bold text-white">Checklist documental</h3>
              <div className="flex h-12 w-12 items-center justify-center rounded-full border border-accent text-sm font-bold text-accent">75%</div>
            </div>
            <div className="space-y-3">
              <Checklist label="Holerite" detail="Mês atual" status="Recebido" icon={<Check size={16} />} />
              <Checklist label="RG/CNH" detail="Frente e verso" status="Recebido" icon={<Check size={16} />} />
              <Checklist label="Dados bancários" detail="Comprovante ou print do app" status="Ilegível" danger icon={<XCircle size={16} />} />
              <Checklist label="Extrato 30 dias" detail="Conta do recebimento" status="Pendente" warning icon={<Clock size={16} />} />
            </div>
          </Card>

          <Card className="p-5">
            <h3 className="font-bold text-white">Status do processo</h3>
            <div className="mt-5 grid grid-cols-3 gap-3 text-center">
              <Stage done label="Docs recebidos" />
              <Stage active label="Checklist" />
              <Stage label="Formalização" />
            </div>
          </Card>

          <Button className="w-full justify-between py-4" onClick={() => activeCampaign ? navigate(`/campanhas/disparo/${activeCampaign.id}/documentos`) : navigate('/campanhas/disparos')}>
            Abrir checklist real
            <ArrowRight size={16} />
          </Button>
          <Button variant="secondary" className="w-full justify-between py-4" onClick={() => navigate('/campanhas/disparos')}>
            <span className="flex items-center gap-2">
              <Upload size={16} />
              Ver campanhas
            </span>
            <ArrowRight size={16} />
          </Button>
        </div>
      </div>

      {loading ? <p className="text-sm text-slate-500">Carregando dados documentais...</p> : null}
    </div>
  );
}

const fallbackContacts = [
  { name: 'Maria de Souza', convenio: 'Governador SP', status: 'Aguardando resposta' },
  { name: 'João Henrique Silva', convenio: 'Prefeitura Ribeirão', status: 'Quer simulação' },
  { name: 'Ana Clara Lima', convenio: 'INSS', status: 'Enviou docs' },
  { name: 'Rogério Martins', convenio: 'Governador SP', status: 'Transferir humano' },
];

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg/60 p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

function Checklist({ label, detail, status, icon, danger = false, warning = false }: { label: string; detail: string; status: string; icon: ReactNode; danger?: boolean; warning?: boolean }) {
  const tone = danger ? 'bg-red-500/15 text-red-300' : warning ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300';
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg/60 p-4">
      <div className="flex items-center gap-3">
        <FileText size={18} className="text-slate-400" />
        <div>
          <p className="font-semibold text-white">{label}</p>
          <p className="text-xs text-slate-500">{detail}</p>
        </div>
      </div>
      <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${tone}`}>
        {status}
        {icon}
      </span>
    </div>
  );
}

function Stage({ label, done = false, active = false }: { label: string; done?: boolean; active?: boolean }) {
  return (
    <div>
      <div
        className={[
          'mx-auto flex h-10 w-10 items-center justify-center rounded-full border text-sm font-bold',
          done ? 'border-accent bg-accent text-slate-950' : active ? 'border-info bg-info/10 text-blue-300' : 'border-slate-600 text-slate-500',
        ].join(' ')}
      >
        {done ? <Check size={16} /> : active ? '2' : '3'}
      </div>
      <p className="mt-2 text-xs text-slate-400">{label}</p>
    </div>
  );
}
