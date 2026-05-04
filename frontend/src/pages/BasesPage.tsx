import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive, ArrowRight, FileText, PencilLine, RefreshCcw, ShieldCheck, Layers3 } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import type { Base } from '../types';
import { Badge, Button, Card, SectionHeader, StatCard } from '../components/ui';
import { formatCurrencyDisplay } from '../lib/margins';

type ViewMode = 'active' | 'archived' | 'all';

export default function BasesPage() {
  const navigate = useNavigate();
  const [bases, setBases] = useState<Base[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('active');

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        setLoading(true);
        const response = await api.getBases({ include_archived: '1' });
        if (!active) {
          return;
        }
        setBases(response.bases || []);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar bases.');
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  const visibleBases = useMemo(() => {
    if (viewMode === 'all') {
      return bases;
    }
    return bases.filter((base) => (viewMode === 'active' ? Number(base.is_active ?? 1) === 1 : Number(base.is_active ?? 1) === 0));
  }, [bases, viewMode]);

  const totals = useMemo(() => {
    const activeBases = bases.filter((base) => Number(base.is_active ?? 1) === 1);
    return {
      totalBases: bases.length,
      activeBases: activeBases.length,
      totalClients: bases.reduce((sum, base) => sum + Number(base.total_clientes || 0), 0),
      positiveClients: bases.reduce((sum, base) => sum + Number(base.total_com_margem || 0), 0),
    };
  }, [bases]);

  async function handleRename(base: Base) {
    const nextName = window.prompt('Novo nome da base', base.nome_base);
    if (!nextName || nextName.trim() === base.nome_base) {
      return;
    }

    try {
      const response = await api.renameBase(base.id, nextName.trim());
      setBases((current) => current.map((item) => (item.id === base.id ? response.base : item)));
      toast.success('Base renomeada com sucesso.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao renomear a base.');
    }
  }

  async function handleArchive(base: Base) {
    const shouldArchive = Number(base.is_active ?? 1) === 1;
    const confirmed = window.confirm(shouldArchive ? 'Arquivar esta base?' : 'Reativar esta base?');
    if (!confirmed) {
      return;
    }

    try {
      const response = await api.archiveBase(base.id, shouldArchive);
      setBases((current) => current.map((item) => (item.id === base.id ? response.base : item)));
      toast.success(shouldArchive ? 'Base arquivada.' : 'Base reativada.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao atualizar a base.');
    }
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Bases"
        description="Cada importação vira uma base própria, com origem clara, filtros e histórico organizado."
      />

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Total de bases" value={totals.totalBases} icon={<Layers3 size={18} />} />
        <StatCard label="Bases ativas" value={totals.activeBases} icon={<ShieldCheck size={18} />} />
        <StatCard label="Clientes importados" value={totals.totalClients} icon={<FileText size={18} />} />
        <StatCard label="Com margem positiva" value={totals.positiveClients} icon={<RefreshCcw size={18} />} />
      </div>

      <Card className="p-5">
        <div className="flex flex-wrap gap-2">
          <Button variant={viewMode === 'active' ? 'primary' : 'secondary'} onClick={() => setViewMode('active')}>
            Ativas
          </Button>
          <Button variant={viewMode === 'archived' ? 'primary' : 'secondary'} onClick={() => setViewMode('archived')}>
            Arquivadas
          </Button>
          <Button variant={viewMode === 'all' ? 'primary' : 'secondary'} onClick={() => setViewMode('all')}>
            Todas
          </Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h3 className="text-lg font-semibold text-white">Lista de bases</h3>
            <p className="text-sm text-slate-500">Nome, origem, convênio e situação de cada importação.</p>
          </div>
          <Badge tone="neutral">{visibleBases.length} registros</Badge>
        </div>

        {loading ? (
          <div className="p-8 text-sm text-slate-400">Carregando bases...</div>
        ) : visibleBases.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-[1600px] text-left text-sm">
              <thead className="bg-bg/80 text-slate-400">
                <tr>
                  {['Nome da base', 'Tipo', 'Convênio / órgão', 'Estado', 'Cidade', 'Total', 'Com margem', 'Sem margem', 'Erros', 'Importação', 'Status', 'Ações'].map((header) => (
                    <th key={header} className="px-5 py-4 font-medium">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleBases.map((base) => {
                  const active = Number(base.is_active ?? 1) === 1;
                  return (
                    <tr key={base.id} className="border-t border-border/80">
                      <td className="px-5 py-4">
                        <div className="font-semibold text-white">{base.nome_base}</div>
                        <div className="mt-1 text-xs text-slate-500">{base.arquivo_original || '-'}</div>
                      </td>
                      <td className="px-5 py-4 text-slate-300">{base.tipo_base}</td>
                      <td className="px-5 py-4 text-slate-300">{base.convenio || '-'}</td>
                      <td className="px-5 py-4 text-slate-300">{base.estado || '-'}</td>
                      <td className="px-5 py-4 text-slate-300">{base.cidade || '-'}</td>
                      <td className="px-5 py-4 text-slate-300">{base.total_clientes}</td>
                      <td className="px-5 py-4 text-slate-300">{base.total_com_margem}</td>
                      <td className="px-5 py-4 text-slate-300">{base.total_sem_margem}</td>
                      <td className="px-5 py-4 text-slate-300">{base.total_erro}</td>
                      <td className="px-5 py-4 text-slate-300">{new Date(base.created_at || Date.now()).toLocaleString('pt-BR')}</td>
                      <td className="px-5 py-4">
                        <Badge tone={active ? 'success' : 'neutral'}>{active ? 'Ativa' : 'Arquivada'}</Badge>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex flex-wrap gap-2">
                          <Button variant="secondary" className="px-4 py-2" onClick={() => navigate(`/fila?base_id=${base.id}`)}>
                            Atender
                          </Button>
                          <Button variant="ghost" className="px-4 py-2" onClick={() => navigate(`/relatorios?base_id=${base.id}`)}>
                            Relatório
                          </Button>
                          <Button variant="ghost" className="px-4 py-2" onClick={() => handleRename(base)}>
                            <PencilLine size={16} />
                            Renomear
                          </Button>
                          <Button variant="ghost" className="px-4 py-2" onClick={() => handleArchive(base)}>
                            <Archive size={16} />
                            {active ? 'Arquivar' : 'Reativar'}
                          </Button>
                          <Button variant="ghost" className="px-4 py-2" onClick={() => navigate(`/atendimento?base_id=${base.id}`)}>
                            <ArrowRight size={16} />
                            Continuar
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
          <div className="p-8 text-sm text-slate-500">Nenhuma base encontrada para este filtro.</div>
        )}
      </Card>

      <Card className="p-5 text-sm text-slate-400">
        Cada upload gera uma base separada. O mesmo CPF pode existir em mais de uma base sem sobrescrever o histórico.
      </Card>
    </div>
  );
}
