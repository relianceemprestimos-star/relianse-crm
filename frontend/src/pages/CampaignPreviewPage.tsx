import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FlaskConical } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import { formatMoney, productLabel } from '../lib/privacy';
import { Badge, Button, Card, SectionHeader, StatCard } from '../components/ui';

export default function CampaignPreviewPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    api
      .getDispatchCampaignPreview(id)
      .then(setData)
      .catch((error) => toast.error(error instanceof Error ? error.message : 'Falha ao carregar prévia.'));
  }, [id]);

  async function runDryRun() {
    try {
      setRunning(true);
      await api.runDispatchCampaignDryRun(id);
      toast.success('Dry-run concluído. Nenhuma mensagem foi enviada.');
      navigate(`/campanhas/${id}/dry-run`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao executar dry-run.');
    } finally {
      setRunning(false);
    }
  }

  if (!data) {
    return <Card className="p-8 text-center text-slate-400">Carregando prévia...</Card>;
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Prévia da campanha"
        description="Confira exatamente o público, chip e mensagem montada antes do dry-run."
        action={
          <Button onClick={runDryRun} disabled={running}>
            <FlaskConical size={16} />
            Rodar dry-run
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Clientes" value={data.total || 0} />
        <StatCard label="Valor total" value={formatMoney(data.resumo?.valor_total_estimado || 0)} />
        <StatCard label="Banco" value={data.resumo?.banco || '-'} />
        <StatCard label="Chip" value={data.resumo?.chip || 'não configurado'} />
      </div>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="px-5 py-4">Cliente</th>
                <th className="px-5 py-4">Produto</th>
                <th className="px-5 py-4">Valor</th>
                <th className="px-5 py-4">Prazo</th>
                <th className="px-5 py-4">Chip</th>
                <th className="px-5 py-4">Mensagem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {(data.previa || []).map((row: any) => (
                <tr key={row.id} className="text-slate-300">
                  <td className="px-5 py-4">
                    <p className="font-semibold text-white">{row.nome || '-'}</p>
                    <p className="text-xs text-slate-500">{row.cpf || '***.***.***-**'}</p>
                  </td>
                  <td className="px-5 py-4"><Badge tone="accent">{productLabel(row.produto)}</Badge></td>
                  <td className="px-5 py-4 font-semibold text-white">{formatMoney(row.valor_liberado)}</td>
                  <td className="px-5 py-4">{row.prazo || '-'}</td>
                  <td className="px-5 py-4">{row.chip_seria_usado || '-'}</td>
                  <td className="px-5 py-4 text-slate-400">{row.mensagem_montada}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
