import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Send, TriangleAlert } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import { formatMoney } from '../lib/privacy';
import { Badge, Button, Card, SectionHeader, StatCard } from '../components/ui';

export default function CampaignDispatchPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    api
      .getDispatchCampaign(id)
      .then(setData)
      .catch((error) => toast.error(error instanceof Error ? error.message : 'Falha ao carregar campanha.'));
  }, [id]);

  async function start() {
    try {
      setStarting(true);
      await api.startDispatchCampaign(id, confirmed);
      toast.success('Disparo iniciado.');
      navigate(`/campanhas/${id}/acompanhamento`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Disparo bloqueado.');
    } finally {
      setStarting(false);
    }
  }

  if (!data) {
    return <Card className="p-8 text-center text-slate-400">Carregando campanha...</Card>;
  }

  const campanha = data.campanha;
  const clientes = data.clientes || [];
  const totalValue = clientes.reduce((sum: number, row: any) => sum + Number(row.valor_liberado || 0), 0);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Disparo controlado"
        description="Última confirmação antes de qualquer envio real."
        action={<Button variant="secondary" onClick={() => navigate(`/campanhas/${id}/acompanhamento`)}>Acompanhar</Button>}
      />

      <Card className="border-danger/40 bg-danger/10 p-5">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-1 text-red-300" />
          <div>
            <p className="font-semibold text-white">Você está prestes a enviar mensagens reais para {clientes.length} clientes.</p>
            <p className="mt-1 text-sm text-slate-300">Esta etapa só deve ser usada depois de conferir prévia, dry-run, público e chip. O backend mantém trava adicional de envio real.</p>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Status" value={campanha.status} />
        <StatCard label="Clientes" value={clientes.length} />
        <StatCard label="Valor estimado" value={formatMoney(totalValue)} />
        <StatCard label="Chip" value={campanha.sessao_rewhats || 'não configurado'} />
      </div>

      <Card className="p-5">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <label className="flex items-start gap-3 text-sm text-slate-300">
            <input className="mt-1" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>Confirmo que revisei a campanha, o dry-run, o público e autorizo o disparo real.</span>
          </label>
          <Button variant="danger" onClick={start} disabled={!confirmed || starting || campanha.status !== 'PRONTA_PARA_DISPARO'}>
            <Send size={16} />
            DISPARAR AGORA
          </Button>
        </div>
        {campanha.status !== 'PRONTA_PARA_DISPARO' ? (
          <p className="mt-4 text-sm text-amber-300">A campanha ainda não está PRONTA_PARA_DISPARO. Rode dry-run e aprove antes.</p>
        ) : null}
      </Card>

      <Card className="p-5">
        <h3 className="text-lg font-bold text-white">Resumo</h3>
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge tone="accent">{campanha.convenio}</Badge>
          <Badge tone="accent">{campanha.banco}</Badge>
          <Badge tone="accent">Coef. {campanha.coeficiente}</Badge>
          <Badge tone="accent">{campanha.prazo}x</Badge>
        </div>
      </Card>
    </div>
  );
}
