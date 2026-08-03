import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle, Clock, Download, FlaskConical, Megaphone, Plus, Send, ShieldCheck, Users } from 'lucide-react';
import toast from 'react-hot-toast';

import { Badge, Button, Card, SectionHeader, StatCard } from '../components/ui';
import { api } from '../lib/api';
import type { DispatchCampaign } from '../types';

function statusTone(status: string) {
  if (status === 'concluida') return 'success';
  if (status === 'em_andamento') return 'info';
  return 'neutral';
}

export default function DispatchCampaignsPage() {
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<DispatchCampaign[]>([]);

  useEffect(() => {
    api
      .getDispatchCampaigns()
      .then((response) => setCampaigns(response.campanhas || []))
      .catch((error) => toast.error(error instanceof Error ? error.message : 'Falha ao carregar disparos.'));
  }, []);

  const activeCampaign = campaigns[0];
  const totalBase = campaigns.reduce((sum, campaign) => sum + Number(campaign.total_disparos || 0), 0);
  const totalResponses = campaigns.reduce((sum, campaign) => sum + Number(campaign.total_respostas || 0), 0);
  const totalAccepts = campaigns.reduce((sum, campaign) => sum + Number(campaign.total_aceites || 0), 0);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Campanhas"
        description="Prévia, aprovação e disparo controlado."
        action={
          <Button onClick={() => navigate('/campanhas/oportunidades')}>
            <Plus size={16} />
            Nova campanha
          </Button>
        }
      />

      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <h3 className="text-lg font-bold text-accent">Campanha ativa</h3>
          <Badge tone={activeCampaign ? 'success' : 'neutral'}>{activeCampaign ? activeCampaign.status : 'Aguardando'}</Badge>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <InfoBox label="Nome da campanha" value={activeCampaign?.nome || 'Campanha Maio/2025'} />
          <InfoBox label="Convênio" value={activeCampaign?.convenio || 'Governo de SP'} />
          <InfoBox label="Produto" value={activeCampaign?.produto || 'Empréstimo Consignado'} />
          <InfoBox label="Banco base" value={activeCampaign?.banco || 'Banco do Brasil'} />
          <InfoBox label="Coeficiente" value={activeCampaign?.coeficiente ? `${activeCampaign.coeficiente}x` : '1,24x'} />
          <InfoBox label="Prazo" value={activeCampaign?.prazo ? `${activeCampaign.prazo} meses` : '84 meses'} />
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Base filtrada" value={totalBase || 0} hint="100% do total" icon={<Users size={18} />} />
        <StatCard label="Elegíveis" value={Math.max(totalBase - 35, 0)} hint="Após regras" icon={<ShieldCheck size={18} />} />
        <StatCard label="Selecionados p/ disparo" value={activeCampaign?.total_disparos || 0} hint="Campanha atual" icon={<Send size={18} />} />
        <StatCard label="Respostas" value={totalResponses} hint="Retorno acumulado" icon={<Clock size={18} />} />
        <StatCard label="Aceites" value={totalAccepts} hint="Convertidos no fluxo" icon={<CheckCircle size={18} />} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_0.85fr]">
        <Card className="p-5">
          <h3 className="text-lg font-bold text-white">Prévia do disparo</h3>
          <div className="mt-4 space-y-3 text-sm">
            <PreviewLine label="Mensagem inicial" value={activeCampaign?.mensagem_inicial || 'Oie, {nome}, é a Aline. Tudo bem?'} />
            <PreviewLine label="Mensagem de follow-up" value={activeCampaign?.followup_mensagem || 'Estou entrando em contato porque, devido ao seu vínculo...'} />
            <PreviewLine label="Janela de envio" value={`${activeCampaign?.janela_inicio || '08:00'} – ${activeCampaign?.janela_fim || '20:00'}`} />
            <PreviewLine label="Intervalo entre disparos" value={`${activeCampaign?.intervalo_envios_segundos || 600} segundos`} />
            <PreviewLine label="Prioridade de fila" value="Alta" />
          </div>
          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <Button variant="secondary" onClick={() => activeCampaign ? navigate(`/campanhas/disparo/${activeCampaign.id}`) : navigate('/campanhas/oportunidades')}>
              <FlaskConical size={16} />
              Dry-run
            </Button>
            <Button onClick={() => activeCampaign ? navigate(`/campanhas/disparo/${activeCampaign.id}`) : navigate('/campanhas/oportunidades')}>
              <ShieldCheck size={16} />
              Aprovar campanha
            </Button>
            <Button variant="success" onClick={() => activeCampaign ? navigate(`/campanhas/disparo/${activeCampaign.id}`) : navigate('/campanhas/oportunidades')}>
              <Send size={16} />
              Enviar para disparo
            </Button>
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="text-lg font-bold text-white">Escolha dos chips</h3>
          <div className="mt-4 space-y-3">
            {['(11) 98765-4321', '(11) 97654-3210', '(11) 96543-2109', '(11) 95432-1098'].map((phone, index) => (
              <div key={phone} className="grid grid-cols-[1fr_96px_70px] items-center gap-3 rounded-xl border border-border bg-bg/55 p-3 text-sm">
                <span className="font-semibold text-white">{phone}</span>
                <Badge tone={index === 3 ? 'neutral' : index === 2 ? 'danger' : 'success'}>{index === 3 ? 'Pausado' : index === 2 ? 'Aquecendo' : 'Conectado'}</Badge>
                <span className="text-right text-slate-300">{index === 3 ? 0 : 150 - index * 30}</span>
              </div>
            ))}
          </div>
          <Button variant="secondary" className="mt-4 w-full justify-between" onClick={() => navigate('/configuracoes')}>
            Gerenciar chips
            <Megaphone size={16} />
          </Button>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border p-5">
          <h3 className="text-lg font-bold text-white">Histórico de campanhas</h3>
          <Button variant="secondary" onClick={() => toast('Exportação será ligada ao relatório final.')}>
            <Download size={16} />
            Exportar
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="px-5 py-4">Nome</th>
                <th className="px-5 py-4">Convênio</th>
                <th className="px-5 py-4">Status</th>
                <th className="px-5 py-4">Disparos</th>
                <th className="px-5 py-4">Respostas</th>
                <th className="px-5 py-4">Aceites</th>
                <th className="px-5 py-4">Data</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {campaigns.map((campaign) => (
                <tr
                  key={campaign.id}
                  className="cursor-pointer text-slate-300 transition hover:bg-white/5"
                  onClick={() => navigate(`/campanhas/disparo/${campaign.id}`)}
                >
                  <td className="px-5 py-4 font-semibold text-white">{campaign.nome}</td>
                  <td className="px-5 py-4">{campaign.convenio}</td>
                  <td className="px-5 py-4">
                    <Badge tone={statusTone(campaign.status) as any}>{campaign.status}</Badge>
                  </td>
                  <td className="px-5 py-4">{campaign.total_disparos}</td>
                  <td className="px-5 py-4">{campaign.total_respostas}</td>
                  <td className="px-5 py-4">{campaign.total_aceites}</td>
                  <td className="px-5 py-4">{campaign.criada_em}</td>
                </tr>
              ))}
              {!campaigns.length ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-slate-400">
                    Nenhuma campanha de disparo criada ainda.
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

function InfoBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-border bg-bg/60 p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-bold text-white">{value}</p>
    </div>
  );
}

function PreviewLine({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="grid gap-3 border-b border-border/70 pb-3 md:grid-cols-[180px_1fr]">
      <span className="text-slate-400">{label}</span>
      <span className="rounded-xl border border-border bg-bg/60 px-3 py-2 font-semibold text-white">{value}</span>
    </div>
  );
}
