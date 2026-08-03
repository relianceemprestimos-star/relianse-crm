import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Send, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';

import { Badge, Button, Card, Input, SectionHeader, StatCard } from '../components/ui';
import { api } from '../lib/api';
import { formatMoney, maskCpf, maskPhone, productLabel } from '../lib/privacy';
import type { CampaignOpportunity, ReWhatsSession } from '../types';

const SELECTION_KEY = 'crm_dispatch_campaign_selection';

export default function DispatchCampaignNewPage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<CampaignOpportunity[]>([]);
  const [name, setName] = useState('');
  const [session, setSession] = useState('');
  const [sessions, setSessions] = useState<ReWhatsSession[]>([]);
  const [bank, setBank] = useState('banco_futuro');
  const [santanderAccount, setSantanderAccount] = useState(false);
  const [bibDifferentAccount, setBibDifferentAccount] = useState(false);
  const [initialMessage, setInitialMessage] = useState('Oie, {nome} 👋 é a Aline, tudo bem?');
  const [followUpMessage, setFollowUpMessage] = useState('');
  const [followUpHours, setFollowUpHours] = useState('24');
  const [sendStart, setSendStart] = useState('08:00');
  const [sendEnd, setSendEnd] = useState('20:00');
  const [intervalSeconds, setIntervalSeconds] = useState('8');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const raw = sessionStorage.getItem(SELECTION_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setRows(parsed);
      }
    } catch {
      setRows([]);
    }
  }, []);

  useEffect(() => {
    api
      .getReWhatsSessions()
      .then((response) => {
        setSessions(response.sessoes || []);
        const online = (response.sessoes || []).find((item) => item.conectado);
        if (online && !session) {
          setSession(online.id);
        }
      })
      .catch(() => {
        setSessions([]);
      });
  }, []);

  const totalValue = rows.reduce((sum, row) => sum + (row.valor_liberado || 0), 0);
  const productBreakdown = useMemo(
    () =>
      rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.produto] = (acc[row.produto] || 0) + 1;
        return acc;
      }, {}),
    [rows]
  );

  function removeRow(row: CampaignOpportunity) {
    setRows((current) => current.filter((item) => `${item.client_id}:${item.produto}` !== `${row.client_id}:${row.produto}`));
  }

  async function confirm() {
    if (!name.trim() || !rows.length) {
      toast.error('Informe o nome e mantenha ao menos um cliente.');
      return;
    }

    try {
      setSaving(true);
      const created = await api.createDispatchCampaign({
        nome: name.trim(),
        convenio: 'todos',
        sessao_rewhats: session.trim(),
        banco: bank,
        produto: 'todos',
        faixa_valor: 'todos',
        mensagem_inicial: initialMessage,
        followup_mensagem: followUpMessage,
        followup_intervalo_horas: Number(followUpHours || 0),
        janela_inicio: sendStart,
        janela_fim: sendEnd,
        intervalo_envios_segundos: Number(intervalSeconds || 8),
        correntista_santander: santanderAccount,
        conta_diferente_holerite: bibDifferentAccount,
        clientes: rows,
      });
      await api.runCampaignDryRun(created.campanha_id);
      sessionStorage.removeItem(SELECTION_KEY);
      toast.success('Campanha criada em dry-run e pronta para disparo.');
      navigate(`/campanhas/disparo/${created.campanha_id}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao criar campanha.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Nova campanha de disparo"
        description="Revise os clientes antes de acionar o ReWhats. Envio ativo exige opt-in e uso interno autorizado."
      />

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Clientes" value={rows.length} />
        <StatCard label="Carteira estimada" value={formatMoney(totalValue)} />
        <StatCard label="Consignado" value={productBreakdown.consignado || 0} />
        <StatCard label="Cartoes" value={(productBreakdown.cartao_consignado || 0) + (productBreakdown.cartao_beneficio || 0)} />
      </div>

      <Card className="p-5">
        <div className="grid gap-4 md:grid-cols-3">
          <label className="block text-sm text-slate-300">
            Nome da campanha
            <Input className="mt-2" value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex: Ribeirao - Oportunidades de hoje" />
          </label>
          <label className="block text-sm text-slate-300">
            Sessao/chip ReWhats
            {sessions.length ? (
              <select
                className="mt-2 w-full rounded-2xl border border-border bg-bg/80 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/10"
                value={session}
                onChange={(event) => setSession(event.target.value)}
              >
                {sessions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.nome || `Sessao ${item.id}`} {item.numero ? `- ${item.numero}` : ''} {item.conectado ? '(online)' : '(offline)'}
                  </option>
                ))}
              </select>
            ) : (
              <Input className="mt-2" value={session} onChange={(event) => setSession(event.target.value)} placeholder="Ex: atendimento-01" />
            )}
          </label>
          <label className="block text-sm text-slate-300">
            Banco
            <select
              className="mt-2 w-full rounded-2xl border border-border bg-bg/80 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/10"
              value={bank}
              onChange={(event) => setBank(event.target.value)}
            >
              <option value="banco_futuro">Banco Futuro</option>
              <option value="bib">BIB</option>
              <option value="bmg">BMG</option>
              <option value="daycoval">Daycoval</option>
              <option value="santander">Santander</option>
              <option value="banco_brasil">Banco do Brasil</option>
              <option value="amigoz">Amigoz</option>
              <option value="cashcard">Cashcard</option>
            </select>
          </label>
        </div>
        {bank === 'santander' ? (
          <label className="mt-4 flex items-center gap-3 text-sm text-slate-300">
            <input type="checkbox" checked={santanderAccount} onChange={(event) => setSantanderAccount(event.target.checked)} />
            Cliente correntista Santander
          </label>
        ) : null}
        {bank === 'bib' ? (
          <label className="mt-4 flex items-center gap-3 text-sm text-slate-300">
            <input type="checkbox" checked={bibDifferentAccount} onChange={(event) => setBibDifferentAccount(event.target.checked)} />
            Conta de liberacao diferente do holerite
          </label>
        ) : null}
        <div className="mt-5 flex justify-end gap-3">
          <Button variant="secondary" onClick={() => navigate('/campanhas/oportunidades')}>
            Voltar
          </Button>
          <Button onClick={confirm} disabled={saving || !rows.length}>
            <Send size={16} />
            Confirmar e disparar
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm text-slate-300">
            Mensagem inicial
            <textarea
              className="mt-2 w-full rounded-2xl border border-border bg-bg/80 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/10"
              rows={3}
              value={initialMessage}
              onChange={(event) => setInitialMessage(event.target.value)}
            />
          </label>
          <label className="block text-sm text-slate-300">
            Follow-up configurado, sem executar agora
            <textarea
              className="mt-2 w-full rounded-2xl border border-border bg-bg/80 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/10"
              rows={3}
              value={followUpMessage}
              onChange={(event) => setFollowUpMessage(event.target.value)}
              placeholder="Mensagem de follow-up opcional"
            />
          </label>
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-4">
          <label className="block text-sm text-slate-300">
            Follow-up horas
            <Input className="mt-2" value={followUpHours} onChange={(event) => setFollowUpHours(event.target.value)} />
          </label>
          <label className="block text-sm text-slate-300">
            Janela inicio
            <Input className="mt-2" value={sendStart} onChange={(event) => setSendStart(event.target.value)} />
          </label>
          <label className="block text-sm text-slate-300">
            Janela fim
            <Input className="mt-2" value={sendEnd} onChange={(event) => setSendEnd(event.target.value)} />
          </label>
          <label className="block text-sm text-slate-300">
            Intervalo segundos
            <Input className="mt-2" value={intervalSeconds} onChange={(event) => setIntervalSeconds(event.target.value)} />
          </label>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="px-5 py-4">Cliente</th>
                <th className="px-5 py-4">Produto</th>
                <th className="px-5 py-4">Valor</th>
                <th className="px-5 py-4">Telefone</th>
                <th className="px-5 py-4">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {rows.map((row) => (
                <tr key={`${row.client_id}:${row.produto}`} className="text-slate-300">
                  <td className="px-5 py-4">
                    <p className="font-semibold text-white">{row.nome}</p>
                    <p className="text-xs text-slate-500">{maskCpf(row.cpf)}</p>
                  </td>
                  <td className="px-5 py-4">
                    <Badge tone="accent">{productLabel(row.produto)}</Badge>
                  </td>
                  <td className="px-5 py-4 font-semibold text-white">{formatMoney(row.valor_liberado)}</td>
                  <td className="px-5 py-4">{maskPhone(row.telefone)}</td>
                  <td className="px-5 py-4">
                    <Button variant="ghost" onClick={() => removeRow(row)}>
                      <Trash2 size={16} />
                      Remover
                    </Button>
                  </td>
                </tr>
              ))}
              {!rows.length ? (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center text-slate-400">
                    Nenhum cliente selecionado.
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
