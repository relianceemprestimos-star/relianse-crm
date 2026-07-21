import { useEffect, useState } from 'react';
import { Download, RefreshCcw } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import type { CaptchaEngineReport } from '../types';
import { Badge, Button, Card, Input, SectionHeader, Select, StatCard } from '../components/ui';

type Filters = {
  from: string;
  to: string;
  portal: string;
  batch_id: string;
  status: string;
  provider: string;
};

export default function CaptchaReportPage() {
  const [data, setData] = useState<CaptchaEngineReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>({ from: '', to: '', portal: '', batch_id: '', status: '', provider: '' });

  async function load() {
    try {
      setLoading(true);
      setData(await api.getCaptchaReport(filters));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar relatório.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [filters.from, filters.to, filters.portal, filters.batch_id, filters.status, filters.provider]);

  async function exportCsv() {
    try {
      const blob = await api.exportCaptchaLogs(filters);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'motor-captcha-logs.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao exportar CSV.');
    }
  }

  const totals = data?.totals;

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Motor de CAPTCHA"
        description="Consumo, falhas, economia estimada e casos enviados para ação manual."
        action={
          <Button variant="secondary" onClick={() => void load()}>
            <RefreshCcw size={16} />
            Atualizar
          </Button>
        }
      />

      <Card className="p-5">
        <div className="grid gap-3 xl:grid-cols-6">
          <label className="text-sm text-slate-300">
            Período inicial
            <Input className="mt-2" type="date" value={filters.from} onChange={(event) => setFilters((current) => ({ ...current, from: event.target.value }))} />
          </label>
          <label className="text-sm text-slate-300">
            Período final
            <Input className="mt-2" type="date" value={filters.to} onChange={(event) => setFilters((current) => ({ ...current, to: event.target.value }))} />
          </label>
          <label className="text-sm text-slate-300">
            Portal
            <Input className="mt-2" value={filters.portal} onChange={(event) => setFilters((current) => ({ ...current, portal: event.target.value }))} placeholder="governo_amapa" />
          </label>
          <label className="text-sm text-slate-300">
            Lote
            <Input className="mt-2" value={filters.batch_id} onChange={(event) => setFilters((current) => ({ ...current, batch_id: event.target.value }))} />
          </label>
          <label className="text-sm text-slate-300">
            Status
            <Input className="mt-2" value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))} placeholder="MANUAL_AUTH_REQUIRED" />
          </label>
          <label className="text-sm text-slate-300">
            Provider
            <Select className="mt-2" value={filters.provider} onChange={(event) => setFilters((current) => ({ ...current, provider: event.target.value }))}>
              <option value="">Todos</option>
              <option value="INTERNAL_OCR">OCR interno</option>
              <option value="CAPSOLVER">CapSolver</option>
              <option value="MANUAL">Manual</option>
            </Select>
          </label>
        </div>
      </Card>

      {loading || !totals ? (
        <Card className="p-8 text-sm text-slate-400">Carregando relatório...</Card>
      ) : (
        <>
          <div className="grid gap-4 xl:grid-cols-4">
            <StatCard label="CAPTCHAs detectados" value={totals.detected} />
            <StatCard label="Resolvidos por OCR" value={totals.ocr_solved} />
            <StatCard label="Resolvidos por provider" value={totals.external_solved} />
            <StatCard label="Ação manual" value={totals.manual_required} />
          </div>
          <div className="grid gap-4 xl:grid-cols-4">
            <StatCard label="Taxa OCR" value={`${totals.ocr_success_rate}%`} />
            <StatCard label="Taxa provider" value={`${totals.external_success_rate}%`} />
            <StatCard label="Custo estimado" value={`$ ${totals.cost_estimated.toFixed(4)}`} />
            <StatCard label="Economia estimada" value={`$ ${totals.estimated_savings.toFixed(4)}`} />
          </div>

          <Card className="p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-white">Últimos eventos</h3>
              <Button variant="secondary" onClick={() => void exportCsv()}>
                <Download size={16} />
                Exportar CSV
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-[0.16em] text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Data</th>
                    <th className="px-3 py-2">Portal</th>
                    <th className="px-3 py-2">Lote</th>
                    <th className="px-3 py-2">CPF</th>
                    <th className="px-3 py-2">Provider</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Erro</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.rows || []).map((row) => (
                    <tr key={row.id} className="border-t border-border text-slate-300">
                      <td className="px-3 py-3">{row.created_at ? new Date(row.created_at).toLocaleString('pt-BR') : '-'}</td>
                      <td className="px-3 py-3">{row.portal_label || row.portal}</td>
                      <td className="px-3 py-3">{row.batch_id || '-'}</td>
                      <td className="px-3 py-3">{row.cpf_masked || '-'}</td>
                      <td className="px-3 py-3">{row.provider || '-'}</td>
                      <td className="px-3 py-3">
                        <Badge tone={row.status.includes('SOLVED') || row.status === 'TOKEN_APPLIED' ? 'success' : row.status.includes('FAILED') || row.status.includes('MANUAL') ? 'danger' : 'accent'}>
                          {row.status}
                        </Badge>
                      </td>
                      <td className="max-w-xs truncate px-3 py-3">{row.error_message || row.error_code || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
