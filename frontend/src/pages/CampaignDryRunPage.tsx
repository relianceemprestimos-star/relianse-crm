import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import { formatMoney, productLabel } from '../lib/privacy';
import { Badge, Button, Card, SectionHeader, StatCard } from '../components/ui';

export default function CampaignDryRunPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    api
      .runDispatchCampaignDryRun(id)
      .then(setData)
      .catch((error) => toast.error(error instanceof Error ? error.message : 'Falha ao carregar dry-run.'));
  }, [id]);

  async function approve() {
    try {
      setApproving(true);
      await api.approveDispatchCampaign(id);
      toast.success('Campanha aprovada para disparo controlado.');
      navigate(`/campanhas/${id}/disparo`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao aprovar campanha.');
    } finally {
      setApproving(false);
    }
  }

  if (!data) {
    return <Card className="p-8 text-center text-slate-400">Carregando dry-run...</Card>;
  }

  const seriam = data.seriam_enviados || [];
  const excluidos = data.excluidos || [];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Dry-run da campanha"
        description="Simulação completa do disparo. Nenhuma mensagem real foi enviada."
        action={
          <Button onClick={approve} disabled={approving || !seriam.length}>
            <CheckCircle2 size={16} />
            Aprovar para disparo
          </Button>
        }
      />

      <Card className="border-accent/30 bg-accent/10 p-5">
        <div className="flex items-center gap-3">
          <ShieldAlert className="text-accent" />
          <div>
            <p className="font-semibold text-white">SIMULAÇÃO — nenhuma mensagem foi enviada</p>
            <p className="text-sm text-slate-400">O sistema apenas montou payloads e gravou o dry-run no banco.</p>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        <StatCard label="Seriam enviados" value={seriam.length} />
        <StatCard label="Excluídos" value={excluidos.length} />
        <StatCard label="Status" value={data.campanha?.status || 'DRY_RUN_OK'} />
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-border p-5">
          <h3 className="text-lg font-bold text-white">Seriam enviados</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="px-5 py-4">Nome</th>
                <th className="px-5 py-4">Telefone</th>
                <th className="px-5 py-4">Produto</th>
                <th className="px-5 py-4">Valor</th>
                <th className="px-5 py-4">Mensagem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {seriam.map((row: any) => (
                <tr key={`${row.client_id}:${row.telefone}`} className="text-slate-300">
                  <td className="px-5 py-4 font-semibold text-white">{row.nome || '-'}</td>
                  <td className="px-5 py-4">{row.telefone || '-'}</td>
                  <td className="px-5 py-4"><Badge tone="accent">{productLabel(row.produto)}</Badge></td>
                  <td className="px-5 py-4">{formatMoney(row.valor_liberado)}</td>
                  <td className="px-5 py-4 text-slate-400">{row.mensagem}</td>
                </tr>
              ))}
              {!seriam.length ? (
                <tr><td className="px-5 py-8 text-center text-slate-500" colSpan={5}>Nenhum cliente apto no dry-run.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="text-lg font-bold text-white">Excluídos</h3>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {excluidos.map((row: any) => (
            <div key={`${row.client_id}:${row.motivo_exclusao}`} className="rounded-2xl border border-border bg-bg/70 p-4">
              <p className="font-semibold text-white">{row.nome || '-'}</p>
              <p className="mt-1 text-sm text-slate-400">{row.motivo_exclusao}</p>
            </div>
          ))}
          {!excluidos.length ? <p className="text-sm text-slate-500">Nenhum excluído.</p> : null}
        </div>
      </Card>
    </div>
  );
}
