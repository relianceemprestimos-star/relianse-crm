import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, MessageSquare, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import { formatMoney, productLabel } from '../lib/privacy';
import { Badge, Button, Card, Input, SectionHeader, Select, StatCard, Textarea } from '../components/ui';
import type { CampaignOpportunity } from '../types';

const SELECTION_KEY = 'crm_dispatch_campaign_selection';

export default function CreateDispatchCampaignPage() {
  const navigate = useNavigate();
  const [selectedRows, setSelectedRows] = useState<CampaignOpportunity[]>([]);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    nome: `Campanha ${new Date().toLocaleDateString('pt-BR')}`,
    sessao_rewhats: '',
    mensagem_inicial: 'Oie, {nome}, é a Aline. Tudo bem?',
    mensagem_followup: 'Estou entrando em contato porque, devido ao seu vínculo, apareceu uma possibilidade de crédito consignado para você. Posso te enviar uma simulação sem compromisso?',
    intervalo_followup_horas: 2,
    janela_inicio: '08:00',
    janela_fim: '20:00',
    intervalo_envios_segundos: 8,
  });

  useEffect(() => {
    const raw = sessionStorage.getItem(SELECTION_KEY);
    if (!raw) {
      toast.error('Selecione clientes em Oportunidades antes de criar a campanha.');
      navigate('/campanhas/oportunidades');
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      setSelectedRows(Array.isArray(parsed) ? parsed : []);
    } catch {
      setSelectedRows([]);
    }
  }, [navigate]);

  const first = selectedRows[0];
  const total = selectedRows.reduce((sum, row) => sum + Number(row.valor_liberado || 0), 0);
  const resumo = useMemo(() => {
    const faixa = selectedRows.reduce<Record<string, number>>((acc, row) => {
      const key = row.faixa_valor_label || row.faixa_valor || 'Sem faixa';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return Object.entries(faixa);
  }, [selectedRows]);

  async function createCampaign() {
    if (!selectedRows.length) {
      toast.error('Nenhum cliente selecionado.');
      return;
    }
    if (!form.nome.trim()) {
      toast.error('Informe o nome da campanha.');
      return;
    }

    try {
      setSaving(true);
      const response = await api.createDispatchCampaign({
        ...form,
        convenio: first?.convenio || 'todos',
        produto: first?.produto || '',
        banco: first?.banco || '',
        grupo: first?.grupo || '',
        faixa_valor: first?.faixa_valor || '',
        clientes: selectedRows,
        filtros: { apenas_com_telefone: true, excluir_opt_out: true },
      });
      sessionStorage.removeItem(SELECTION_KEY);
      toast.success('Campanha criada. Confira a prévia antes do dry-run.');
      navigate(`/campanhas/${response.campanha_id}/previa`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao criar campanha.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Criar campanha controlada"
        description="Monte a campanha a partir do público selecionado. Nenhuma mensagem é enviada nesta etapa."
        action={
          <Button variant="secondary" onClick={() => navigate('/campanhas/oportunidades')}>
            Voltar para oportunidades
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Clientes selecionados" value={selectedRows.length} />
        <StatCard label="Valor estimado" value={formatMoney(total)} />
        <StatCard label="Banco base" value={first?.banco_label || first?.banco || '-'} />
        <StatCard label="Produto" value={first?.produto ? productLabel(first.produto) : '-'} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="p-5">
          <div className="flex items-center gap-2">
            <MessageSquare size={18} className="text-accent" />
            <h3 className="text-lg font-bold text-white">Configuração do disparo</h3>
          </div>
          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="block text-sm text-slate-300 md:col-span-2">
              Nome da campanha
              <Input className="mt-2" value={form.nome} onChange={(event) => setForm((current) => ({ ...current, nome: event.target.value }))} />
            </label>
            <label className="block text-sm text-slate-300">
              Chip/sessão ReWhats
              <Input className="mt-2" value={form.sessao_rewhats} onChange={(event) => setForm((current) => ({ ...current, sessao_rewhats: event.target.value }))} placeholder="Ex: aline-principal" />
            </label>
            <label className="block text-sm text-slate-300">
              Intervalo entre envios
              <Select className="mt-2" value={String(form.intervalo_envios_segundos)} onChange={(event) => setForm((current) => ({ ...current, intervalo_envios_segundos: Number(event.target.value) }))}>
                <option value="8">8 segundos</option>
                <option value="15">15 segundos</option>
                <option value="30">30 segundos</option>
                <option value="60">60 segundos</option>
              </Select>
            </label>
            <label className="block text-sm text-slate-300">
              Janela início
              <Input className="mt-2" type="time" value={form.janela_inicio} onChange={(event) => setForm((current) => ({ ...current, janela_inicio: event.target.value }))} />
            </label>
            <label className="block text-sm text-slate-300">
              Janela fim
              <Input className="mt-2" type="time" value={form.janela_fim} onChange={(event) => setForm((current) => ({ ...current, janela_fim: event.target.value }))} />
            </label>
            <label className="block text-sm text-slate-300 md:col-span-2">
              Mensagem inicial
              <Textarea className="mt-2" rows={3} value={form.mensagem_inicial} onChange={(event) => setForm((current) => ({ ...current, mensagem_inicial: event.target.value }))} />
              <p className="mt-1 text-xs text-slate-500">Variáveis: {'{nome}'} {'{valor_liberado}'} {'{prazo}'} {'{parcela}'}</p>
            </label>
            <label className="block text-sm text-slate-300 md:col-span-2">
              Follow-up após 2 horas
              <Textarea className="mt-2" rows={3} value={form.mensagem_followup} onChange={(event) => setForm((current) => ({ ...current, mensagem_followup: event.target.value }))} />
            </label>
          </div>
        </Card>

        <Card className="p-5">
          <div className="flex items-center gap-2">
            <ShieldCheck size={18} className="text-green-300" />
            <h3 className="text-lg font-bold text-white">Travas ativas</h3>
          </div>
          <div className="mt-5 space-y-3 text-sm text-slate-300">
            <p><Badge tone="success">OK</Badge> Dry-run obrigatório antes de aprovar.</p>
            <p><Badge tone="success">OK</Badge> Opt-out fica excluído da campanha.</p>
            <p><Badge tone="success">OK</Badge> CPF não aparece completo em listas.</p>
            <p><Badge tone="danger">Bloqueado</Badge> Disparo real exige aprovação explícita.</p>
          </div>
          <div className="mt-6 space-y-2 text-sm">
            {resumo.map(([faixa, count]) => (
              <div key={faixa} className="flex justify-between rounded-2xl border border-border bg-bg/60 px-4 py-3">
                <span className="text-slate-400">{faixa}</span>
                <span className="font-semibold text-white">{count}</span>
              </div>
            ))}
          </div>
          <Button className="mt-6 w-full" onClick={createCampaign} disabled={saving || !selectedRows.length}>
            Criar campanha
            <ArrowRight size={16} />
          </Button>
        </Card>
      </div>
    </div>
  );
}
