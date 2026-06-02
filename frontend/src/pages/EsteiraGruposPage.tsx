import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Calculator, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import { useNavigate, useParams } from 'react-router-dom';

import { Badge, Button, Card, SectionHeader, Select, StatCard } from '../components/ui';
import { api } from '../lib/api';
import type { Base, PipelineGroup } from '../types';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value || 0));
}

function groupTone(group: PipelineGroup) {
  if (group.grupo === 'AGUARDANDO_COEFICIENTE') return 'danger';
  if (group.status === 'pronto' || group.total_valor_liberado > 0) return 'success';
  return 'neutral';
}

export default function EsteiraGruposPage() {
  const params = useParams();
  const navigate = useNavigate();
  const [bases, setBases] = useState<Base[]>([]);
  const [selectedBaseId, setSelectedBaseId] = useState(() => Number(params.id || 0));
  const [groups, setGroups] = useState<PipelineGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [simulating, setSimulating] = useState(false);

  const selectedBase = useMemo(() => bases.find((base) => Number(base.id) === Number(selectedBaseId)) || null, [bases, selectedBaseId]);
  const readyGroups = groups.filter((group) => group.total_valor_liberado > 0);
  const waitingGroups = groups.filter((group) => group.grupo === 'AGUARDANDO_COEFICIENTE');

  async function load(nextBaseId = selectedBaseId) {
    setLoading(true);
    try {
      const baseResponse = await api.getBases({ include_archived: '1' });
      const baseRows = baseResponse.bases || [];
      setBases(baseRows);
      const effectiveId = Number(nextBaseId || baseRows[0]?.id || 0);
      setSelectedBaseId(effectiveId);
      if (effectiveId) {
        const groupResponse = await api.getPipelineGroups(effectiveId);
        setGroups(groupResponse.grupos || []);
      } else {
        setGroups([]);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar grupos da esteira.');
    } finally {
      setLoading(false);
    }
  }

  async function simulate() {
    if (!selectedBaseId) {
      toast.error('Selecione uma base.');
      return;
    }
    setSimulating(true);
    try {
      const response = await api.simulatePipeline(selectedBaseId);
      setGroups(response.grupos || []);
      toast.success(response.aguardando_coeficiente ? 'Base simulada, mas há itens aguardando coeficiente.' : 'Base simulada e classificada.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao simular base.');
    } finally {
      setSimulating(false);
    }
  }

  useEffect(() => {
    void load(Number(params.id || 0));
  }, [params.id]);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Grupos da Esteira"
        description="Escolha uma base importada, rode a simulação e acompanhe os grupos prontos para seleção futura. Nenhum disparo é feito aqui."
        action={
          <Button onClick={simulate} disabled={!selectedBaseId || simulating}>
            <Calculator size={16} />
            {simulating ? 'Simulando...' : 'Simular base'}
          </Button>
        }
      />

      <Card className="p-5">
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
          <div>
            <label className="text-sm font-semibold text-slate-300">Base da esteira</label>
            <Select
              className="mt-2"
              value={selectedBaseId || ''}
              onChange={(event) => {
                const next = Number(event.target.value || 0);
                setSelectedBaseId(next);
                if (next) navigate(`/esteira/${next}/grupos`);
              }}
            >
              <option value="">Selecione uma base</option>
              {bases.map((base) => (
                <option key={base.id} value={base.id}>
                  #{base.id} - {base.nome_base} ({base.convenio || 'sem convenio'})
                </option>
              ))}
            </Select>
          </div>
          <Button variant="secondary" onClick={() => void load(selectedBaseId)} disabled={loading}>
            <RefreshCw size={16} />
            Atualizar
          </Button>
        </div>
        {selectedBase ? (
          <p className="mt-3 text-sm text-slate-400">
            Convênio: <span className="font-semibold text-white">{selectedBase.convenio || 'não informado'}</span> · Clientes importados:{' '}
            <span className="font-semibold text-white">{selectedBase.total_clientes || 0}</span>
          </p>
        ) : null}
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard label="Grupos" value={groups.length} hint="classificações disponíveis" />
        <StatCard label="Prontos" value={readyGroups.reduce((sum, group) => sum + group.total_clientes, 0)} hint="com valor liberado" />
        <StatCard label="Aguardando" value={waitingGroups.reduce((sum, group) => sum + group.total_clientes, 0)} hint="pendente de coeficiente" />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {groups.map((group) => (
          <Card key={group.grupo} className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Badge tone={groupTone(group)}>{group.status || 'classificado'}</Badge>
                <h3 className="mt-3 text-xl font-bold text-white">{group.grupo_label || group.grupo}</h3>
                <p className="mt-1 text-sm text-slate-400">{group.grupo}</p>
              </div>
              <div className="text-right">
                <p className="text-3xl font-bold text-white">{group.total_clientes}</p>
                <p className="text-xs text-slate-500">clientes</p>
              </div>
            </div>
            <div className="mt-4 rounded-2xl border border-border bg-bg/60 p-4">
              <p className="text-sm text-slate-400">Valor liberado total</p>
              <p className="mt-1 text-lg font-semibold text-white">{money(group.total_valor_liberado)}</p>
            </div>
            <Button className="mt-4 w-full justify-between" variant="secondary" onClick={() => navigate(`/esteira/${selectedBaseId}/grupos/${group.grupo}`)}>
              Ver clientes
              <ArrowRight size={16} />
            </Button>
          </Card>
        ))}
      </div>

      {!loading && !groups.length ? (
        <Card className="p-6 text-sm text-slate-400">
          Nenhum grupo salvo para esta base. Rode a simulação após a margem e a Nova Vida terminarem; se faltar coeficiente, o CRM separa como aguardando.
        </Card>
      ) : null}
    </div>
  );
}
