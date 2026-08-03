import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';

import { Badge, Card, SectionHeader, Select, StatCard } from '../components/ui';
import { api } from '../lib/api';
import { maskPhone } from '../lib/privacy';
import type { DocumentChecklist } from '../types';

function tone(status: string) {
  if (status === 'completo') return 'success';
  if (status === 'pendente') return 'danger';
  return 'neutral';
}

export default function CampaignDocumentsPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [rows, setRows] = useState<DocumentChecklist[]>([]);
  const [summary, setSummary] = useState({ total: 0, completos: 0, pendentes: 0, isentos: 0 });
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (!id) return;
    api
      .getCampaignDocuments(id)
      .then((response) => {
        setRows(response.checklists || []);
        setSummary(response.resumo || summary);
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : 'Falha ao carregar documentos.'));
  }, [id]);

  const visibleRows = useMemo(() => rows.filter((row) => !status || row.status === status), [rows, status]);

  return (
    <div className="space-y-6">
      <SectionHeader title="Documentos da campanha" description="Acompanhe documentos recebidos e pendencias por cliente." />

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Total" value={summary.total} />
        <StatCard label="Completos" value={summary.completos} />
        <StatCard label="Pendentes" value={summary.pendentes} />
        <StatCard label="Isentos" value={summary.isentos} />
      </div>

      <Card className="p-5">
        <Select className="max-w-xs" value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">Todos os status</option>
          <option value="completo">Completo</option>
          <option value="pendente">Pendente</option>
          <option value="aguardando_humano">Aguardando humano</option>
        </Select>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="px-5 py-4">Cliente</th>
                <th className="px-5 py-4">Telefone</th>
                <th className="px-5 py-4">Banco</th>
                <th className="px-5 py-4">Status</th>
                <th className="px-5 py-4">Recebidos</th>
                <th className="px-5 py-4">Pendencias</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {visibleRows.map((row) => (
                <tr
                  key={`${row.campanha_id}:${row.telefone}`}
                  className="cursor-pointer text-slate-300 transition hover:bg-white/5"
                  onClick={() => navigate(`/campanhas/disparo/${id}/cliente/${encodeURIComponent(row.telefone)}/documentos`)}
                >
                  <td className="px-5 py-4 font-semibold text-white">{row.nome_cliente || 'Cliente'}</td>
                  <td className="px-5 py-4">{maskPhone(row.telefone)}</td>
                  <td className="px-5 py-4">{row.banco}</td>
                  <td className="px-5 py-4">
                    <Badge tone={tone(row.status) as any}>{row.status}</Badge>
                  </td>
                  <td className="px-5 py-4">{row.documentos_recebidos || 0}</td>
                  <td className="px-5 py-4">{row.pendentes?.map((item) => item.label).join(', ') || '-'}</td>
                </tr>
              ))}
              {!visibleRows.length ? (
                <tr>
                  <td colSpan={6} className="px-5 py-10 text-center text-slate-400">
                    Nenhum checklist encontrado.
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
