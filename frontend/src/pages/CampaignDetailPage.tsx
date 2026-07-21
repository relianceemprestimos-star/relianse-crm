import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Archive, ClipboardList, FileSpreadsheet, Plus, Users } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import type { Campaign } from '../types';
import { Badge, Button, Card, SectionHeader, StatCard } from '../components/ui';

function toneFromStatus(status: Campaign['status']) {
  if (status === 'active') return 'success';
  if (status === 'inactive') return 'warning';
  return 'neutral';
}

export default function CampaignDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        setLoading(true);
        const response = await api.getCampaign(Number(id));
        if (!active) return;
        setCampaign(response.campaign);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar campanha.');
      } finally {
        if (active) setLoading(false);
      }
    }

    if (id) {
      void load();
    }

    return () => {
      active = false;
    };
  }, [id]);

  if (loading) {
    return <Card className="p-8 text-center text-slate-400">Carregando campanha...</Card>;
  }

  if (!campaign) {
    return <Card className="p-8 text-center text-slate-400">Campanha nao encontrada.</Card>;
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        title={campaign.name}
        description="Acompanhe os números da campanha, bases vinculadas e o próximo passo da operação."
        action={
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => navigate(`/atendimento?campaign_id=${campaign.id}`)}>
              <ClipboardList size={16} />
              Iniciar atendimento da campanha
            </Button>
            <Button variant="secondary" onClick={() => navigate(`/clientes?campaign_id=${campaign.id}`)}>
              Ver clientes
            </Button>
            <Button variant="secondary" onClick={() => navigate(`/relatorios?campaign_id=${campaign.id}`)}>
              Relatório
            </Button>
            <Button variant="secondary" onClick={() => navigate(`/upload?campaign_id=${campaign.id}`)}>
              <Plus size={16} />
              Subir base
            </Button>
          </div>
        }
      />

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Total de clientes" value={campaign.total_clients || 0} icon={<Users size={18} />} />
        <StatCard label="Bases" value={campaign.total_bases || 0} />
        <StatCard label="Pendentes" value={campaign.total_pendente || 0} />
        <StatCard label="Em atendimento" value={campaign.total_em_atendimento || 0} />
      </div>

      <Card className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <Badge tone={toneFromStatus(campaign.status) as any}>{campaign.status}</Badge>
              <Badge tone="accent">{campaign.product_focus || 'outros'}</Badge>
            </div>
            <p className="mt-4 text-sm text-slate-400">{campaign.convenio || 'Convênio não informado'}</p>
            <p className="mt-2 text-base text-slate-300">{campaign.description || 'Sem descrição cadastrada.'}</p>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={() => navigate(`/upload?campaign_id=${campaign.id}`)}>
              <FileSpreadsheet size={16} />
              Subir nova base
            </Button>
            <Button variant="secondary" onClick={() => navigate(`/campanhas?edit=${campaign.id}`)}>
              Editar campanha
            </Button>
            <Button variant="ghost" onClick={async () => { await api.archiveCampaign(campaign.id, true); toast.success('Campanha arquivada.'); navigate('/campanhas'); }}>
              <Archive size={16} />
              Inativar campanha
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="p-5">
          <p className="text-sm text-slate-400">Finalizados</p>
          <p className="mt-3 text-2xl font-bold text-white">{campaign.total_finalizados || 0}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-slate-400">Convertidos</p>
          <p className="mt-3 text-2xl font-bold text-white">{campaign.total_convertidos || 0}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-slate-400">Sem interesse</p>
          <p className="mt-3 text-2xl font-bold text-white">{campaign.total_sem_interesse || 0}</p>
        </Card>
      </div>

      <Card className="p-6">
        <p className="text-sm uppercase tracking-[0.22em] text-slate-500">Bases vinculadas</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(campaign.bases || []).map((base) => (
            <button
              key={base.id}
              type="button"
              className="rounded-3xl border border-border bg-bg/70 p-4 text-left transition hover:border-accent/40 hover:bg-accent/5"
              onClick={() => navigate(`/bases?highlight=${base.id}`)}
            >
              <p className="font-semibold text-white">{base.nome_base}</p>
              <p className="mt-1 text-sm text-slate-400">{base.tipo_base}</p>
              <p className="mt-1 text-xs text-slate-500">{base.convenio}</p>
            </button>
          ))}
          {!campaign.bases?.length ? <p className="text-sm text-slate-500">Nenhuma base vinculada ainda.</p> : null}
        </div>
      </Card>

      <Card className="p-6">
        <p className="text-sm uppercase tracking-[0.22em] text-slate-500">Vendedores autorizados</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {(campaign.users || []).map((item) => (
            <Badge key={item.id} tone="accent">
              {item.name}
            </Badge>
          ))}
          {!campaign.users?.length ? <p className="text-sm text-slate-500">Liberada para todos os vendedores ativos.</p> : null}
        </div>
      </Card>
    </div>
  );
}
