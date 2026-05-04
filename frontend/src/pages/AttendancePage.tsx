import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Eye,
  MessageCircleMore,
  MoveLeft,
  MoveRight,
  Send,
  ThumbsDown,
  ThumbsUp,
  TimerReset,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import { formatCpfDisplay, formatPhoneDisplay, openWhatsAppConversation } from '../lib/whatsapp';
import { formatCurrencyDisplay, marginState, productLabel } from '../lib/margins';
import type { Client, Settings } from '../types';
import { useAuth } from '../components/AuthProvider';
import { Badge, Button, Card, Input, Modal, SectionHeader, Textarea } from '../components/ui';

type TimelineItem = {
  id: number;
  type: string;
  note?: string;
  private_note?: string;
  created_at: string;
  user_name?: string;
};

export default function AttendancePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [client, setClient] = useState<Client | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingAction, setSavingAction] = useState(false);
  const [note, setNote] = useState('');
  const [privateMode, setPrivateMode] = useState(false);
  const [privateNote, setPrivateNote] = useState('');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleNote, setScheduleNote] = useState('');
  const [convertForm, setConvertForm] = useState({
    bank: '',
    amount: '',
    installment: '',
    term: '',
    note: '',
  });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [queuePosition, setQueuePosition] = useState<{ current: number; total: number }>({ current: 0, total: 0 });

  const baseScope = useMemo(
    () => ({
      campaign_id: searchParams.get('campaign_id') || undefined,
      base_id: searchParams.get('base_id') || undefined,
    }),
    [searchParams]
  );

  useEffect(() => {
    let active = true;
    async function loadSettings() {
      try {
        const [settingsResponse, dashboardResponse] = await Promise.all([api.getSettings(), api.getDashboard(baseScope)]);
        if (!active) return;
        setSettings(settingsResponse.settings);
        setQueuePosition({
          current: dashboardResponse.nextClient?.queue_position ?? 0,
          total: dashboardResponse.nextClient?.queue_total ?? dashboardResponse.stats.queue_clients ?? 0,
        });
      } catch {
        // ignore
      }
    }

    void loadSettings();
    return () => {
      active = false;
    };
  }, [baseScope]);

  useEffect(() => {
    let active = true;
    async function loadClient() {
      try {
        setLoading(true);
        const idParam = searchParams.get('clientId');
        if (idParam) {
          const details = await api.getClient(Number(idParam));
          if (!active) return;
          setClient(details.client);
          setTimeline((details.interactions || []).map((item: TimelineItem) => item));
          setQueuePosition((current) => ({
            current: details.client.queue_position,
            total: current.total,
          }));

          if (details.client.status_atendimento !== 'em_atendimento') {
            const started = await api.startClient(details.client.id);
            if (!active) return;
            setClient(started.client);
            setTimeline((started.interactions || []).map((item: TimelineItem) => item));
          }
        } else {
          const nextResponse = await api.getNextClient(baseScope);
          if (!nextResponse.next) {
            if (active) setClient(null);
            toast('NÃ£o hÃ¡ clientes na fila no momento.');
            return;
          }

          const started = await api.startClient(nextResponse.next.client.id);
          if (!active) return;
          setSearchParams(
            {
              clientId: String(started.client.id),
              ...(baseScope.campaign_id ? { campaign_id: String(baseScope.campaign_id) } : {}),
              ...(baseScope.base_id ? { base_id: String(baseScope.base_id) } : {}),
            },
            { replace: true }
          );
          setClient(started.client);
          setTimeline((started.interactions || []).map((item: TimelineItem) => item));
          setQueuePosition({
            current: nextResponse.next.queue_position,
            total: nextResponse.next.queue_total,
          });
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar o atendimento.');
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadClient();
    return () => {
      active = false;
    };
  }, [searchParams, setSearchParams, baseScope]);

  const charCount = note.length + privateNote.length;
  const canProceed = useMemo(() => note.trim().length > 0 || privateNote.trim().length > 0, [note, privateNote]);
  const rawData = client?.raw_data || (client?.raw_data_json ? safeParse(client.raw_data_json) : {});
  const cons = client ? marginState(client.margem_liquida_consignacao) : marginState(null);
  const cred = client ? marginState(client.margem_liquida_credito) : marginState(null);
  const card = client ? marginState(client.margem_liquida_cartao) : marginState(null);

  async function refreshClient(clientId = client?.id) {
    if (!clientId) return;
    const details = await api.getClient(clientId);
    setClient(details.client);
    setTimeline((details.interactions || []).map((item: TimelineItem) => item));
  }

  async function openClientWhatsApp() {
    if (!client || !settings) return;

    const link = openWhatsAppConversation(client, settings.whatsapp_message, settings);
    if (!link) {
      toast.error('Telefone indisponÃ­vel para o WhatsApp.');
      return;
    }

    try {
      await api.openWhatsappLog(client.id);
    } catch {
      // ignore logging failure
    }

    toast.success('WhatsApp aberto em nova aba.');
    await refreshClient();
  }

  async function saveObservation(noteText = note, privateText = privateNote) {
    if (!client) return;
    await api.addInteraction(client.id, {
      type: 'observacao',
      note: noteText,
      private_note: privateText,
    });
    await refreshClient();
  }

  async function goNextClient(force = false) {
    if (!client) return;

    if (!force && !canProceed) {
      toast.error('Registre uma observaÃ§Ã£o ou escolha uma aÃ§Ã£o antes de avanÃ§ar.');
      return;
    }

    const next = await api.getNextClient(baseScope);
    if (!next.next) {
      toast.success('Fim da fila por enquanto.');
      return;
    }

    if (next.next.client.id === client.id) {
      toast('Ainda nÃ£o hÃ¡ prÃ³ximo cliente disponÃ­vel.');
      return;
    }

    const started = await api.startClient(next.next.client.id);
    setSearchParams(
      {
        clientId: String(started.client.id),
        ...(baseScope.campaign_id ? { campaign_id: String(baseScope.campaign_id) } : {}),
        ...(baseScope.base_id ? { base_id: String(baseScope.base_id) } : {}),
      },
      { replace: true }
    );
    setClient(started.client);
    setTimeline((started.interactions || []).map((item: TimelineItem) => item));
    setNote('');
    setPrivateNote('');
    setPrivateMode(false);
    setScheduleNote('');
    setScheduleDate('');
    setConvertForm({ bank: '', amount: '', installment: '', term: '', note: '' });
    toast.success('PrÃ³ximo cliente carregado.');
  }

  async function handleFinalizar() {
    if (!client) return;
    if (!canProceed) {
      const confirmed = window.confirm('VocÃª quer finalizar sem observaÃ§Ã£o registrada?');
      if (!confirmed) return;
    }

    try {
      setSavingAction(true);
      await api.finalizeClient(client.id, { note, private_note: privateMode ? privateNote : '' });
      toast.success('Atendimento finalizado.');
      setNote('');
      setPrivateNote('');
      setPrivateMode(false);
      await goNextClient(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao finalizar atendimento.');
    } finally {
      setSavingAction(false);
    }
  }

  async function handleNoInterest() {
    if (!client) return;
    const confirmed = window.confirm('Confirmar marcaÃ§Ã£o como sem interesse?');
    if (!confirmed) return;

    try {
      setSavingAction(true);
      await api.markNoInterest(client.id, { note, private_note: privateMode ? privateNote : '' });
      toast.success('Cliente marcado como sem interesse.');
      setNote('');
      setPrivateNote('');
      setPrivateMode(false);
      await goNextClient(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao marcar como sem interesse.');
    } finally {
      setSavingAction(false);
    }
  }

  async function handleScheduleReturn() {
    if (!client || !scheduleDate) {
      toast.error('Informe data e hora do retorno.');
      return;
    }

    try {
      setSavingAction(true);
      await api.scheduleReturn(client.id, {
        returnAt: scheduleDate,
        note: scheduleNote || note,
        private_note: privateMode ? privateNote : '',
      });
      toast.success('Retorno agendado.');
      setScheduleOpen(false);
      await goNextClient(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao agendar retorno.');
    } finally {
      setSavingAction(false);
    }
  }

  async function handleConvert() {
    if (!client) return;

    try {
      setSavingAction(true);
      await api.convertClient(client.id, {
        bank: convertForm.bank,
        amount: Number(convertForm.amount || 0),
        installment: Number(convertForm.installment || 0),
        term: Number(convertForm.term || 0),
        note: convertForm.note || note,
        private_note: privateMode ? privateNote : '',
      });
      toast.success('Cliente marcado como convertido.');
      setConvertOpen(false);
      await goNextClient(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar conversÃ£o.');
    } finally {
      setSavingAction(false);
    }
  }

  async function handleSaveObservationOnly() {
    if (!client || (!note.trim() && !privateNote.trim())) {
      toast.error('Digite uma observaÃ§Ã£o antes de salvar.');
      return;
    }

    try {
      setSavingAction(true);
      await saveObservation();
      toast.success('ObservaÃ§Ã£o salva.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar observaÃ§Ã£o.');
    } finally {
      setSavingAction(false);
    }
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Atendimento"
        description="Foque no cliente atual, registre tudo e avance sem perder o contexto da fila."
        action={<Badge tone="accent">{queuePosition.current && queuePosition.total ? `Cliente ${queuePosition.current} de ${queuePosition.total}` : 'Fila em atendimento'}</Badge>}
      />

      {loading ? (
        <Card className="p-8 text-sm text-slate-400">Carregando atendimento...</Card>
      ) : client ? (
        <div className="space-y-6">
          <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
            <Card className="p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm text-slate-400">Cliente atual</p>
                  <h3 className="mt-2 text-3xl font-bold text-white">{client.name}</h3>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge tone="info">{client.status_label || client.status_atendimento || client.status}</Badge>
                    <Badge tone={consultaTone(client.consulta_status)}>{client.consulta_status_label || client.consulta_status}</Badge>
                    {client.base_name ? <Badge tone="neutral">{client.base_name}</Badge> : null}
                    {client.assigned_to_name ? <Badge tone="success">{client.assigned_to_name}</Badge> : null}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    onClick={() =>
                      navigate(
                        `/fila${
                          baseScope.campaign_id || baseScope.base_id
                            ? `?${baseScope.campaign_id ? `campaign_id=${baseScope.campaign_id}` : ''}${
                                baseScope.campaign_id && baseScope.base_id ? '&' : ''
                              }${baseScope.base_id ? `base_id=${baseScope.base_id}` : ''}`
                            : ''
                        }`
                      )
                    }
                  >
                    <MoveLeft size={16} />
                    Voltar Ã  fila
                  </Button>
                  <Button variant="secondary" onClick={() => void goNextClient()}>
                    <MoveRight size={16} />
                    PrÃ³ximo cliente
                  </Button>
                </div>
              </div>

                            <div className="mt-6 grid gap-3 md:grid-cols-2">
                <InfoLine label="CPF" value={formatCpfDisplay(client.cpf)} />
                <InfoLine label="Telefone" value={formatPhoneDisplay(client.phone)} />
                <InfoLine label="E-mail" value={client.email || '-'} />
                <InfoLine label="Campanha" value={client.campaign_name || client.base_name || '-'} />
                <InfoLine label="Origem da lista" value={client.base_name || client.campaign_name || '-'} />
                <InfoLine label="Tipo da base" value={client.base_type || '-'} />
                <InfoLine label="Conv?nio / ?rg?o" value={client.base_convenio || '-'} />
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <Button className="py-4" onClick={() => void openClientWhatsApp()}>
                  <MessageCircleMore size={16} />
                  Abrir WhatsApp Web
                </Button>
                <Button variant="secondary" className="py-4" onClick={() => setRawOpen(true)}>
                  <Eye size={16} />
                  Ver dados originais
                </Button>
                <Badge tone="neutral">Vendedor: {client.assigned_to_name || user?.name || 'â€”'}</Badge>
              </div>

              {client.has_duplicate_in_other_base ? (
                <div className="mt-4 rounded-2xl border border-accent/20 bg-accent/10 p-4 text-sm text-slate-200">
                  <p className="font-semibold text-white">Cliente encontrado em outras bases</p>
                  <p className="mt-1 text-slate-300">Este CPF aparece em mÃºltiplas bases importadas.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(client.duplicate_bases || []).map((base) => (
                      <Badge key={base.id} tone="accent">
                        {base.nome_base}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-4 rounded-2xl border border-border bg-bg/60 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Origem da base</p>
                <div className="mt-3 grid gap-2 text-sm text-slate-300">
                  <div>
                    <span className="text-slate-500">Nome:</span> {client.base_name || '-'}
                  </div>
                  <div>
                    <span className="text-slate-500">Tipo:</span> {client.base_type || '-'}
                  </div>
                  <div>
                    <span className="text-slate-500">ConvÃªnio:</span> {client.base_convenio || '-'}
                  </div>
                  <div>
                    <span className="text-slate-500">Estado/Cidade:</span> {client.base_state || '-'}{client.base_city ? ` / ${client.base_city}` : ''}
                  </div>
                  <div>
                    <span className="text-slate-500">Arquivo:</span> {client.base_file_name || '-'}
                  </div>
                </div>
              </div>
            </Card>

            <Card className="p-6">
              <p className="text-sm text-slate-400">PosiÃ§Ã£o na fila</p>
              <div className="mt-3 rounded-3xl border border-border bg-bg/60 p-5">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Atual</p>
                <p className="mt-2 text-3xl font-bold text-white">{client.queue_position || queuePosition.current || '-'}</p>
              </div>
              <div className="mt-4 grid gap-3">
                <InfoLine label="Status atendimento" value={client.status_label || client.status_atendimento || client.status} />
                <InfoLine label="Status consulta" value={client.consulta_status_label || client.consulta_status} />
                <InfoLine label="Mensagem da consulta" value={client.consulta_mensagem || '-'} />
              </div>
            </Card>
          </div>

          <Card className="p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-slate-400">Margens por produto</p>
                <h3 className="text-xl font-bold text-white">ConsignaÃ§Ã£o, CrÃ©dito e CartÃ£o</h3>
              </div>
              <Badge tone="accent">{client.best_product_label || productLabel(client.best_product_type || '')}</Badge>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-3">
              <MarginCard title="ConsignaÃ§Ã£o" gross={client.margem_bruta_consignacao} net={client.margem_liquida_consignacao} state={cons} />
              <MarginCard title="CrÃ©dito" gross={client.margem_bruta_credito} net={client.margem_liquida_credito} state={cred} />
              <MarginCard title="CartÃ£o" gross={client.margem_bruta_cartao} net={client.margem_liquida_cartao} state={card} />
            </div>
          </Card>

          <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
            <Card className="p-6">
              <p className="text-sm text-slate-400">Registro do atendimento</p>
              <Textarea
                rows={8}
                className="mt-4"
                placeholder="Digite aqui suas observaÃ§Ãµes..."
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                <span>{charCount} caracteres</span>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={privateMode} onChange={(event) => setPrivateMode(event.target.checked)} />
                  Adicionar observaÃ§Ã£o privada
                </label>
              </div>
              {privateMode ? (
                <Textarea
                  rows={4}
                  className="mt-3"
                  placeholder="ObservaÃ§Ã£o privada..."
                  value={privateNote}
                  onChange={(event) => setPrivateNote(event.target.value)}
                />
              ) : null}
              <div className="mt-4 flex flex-wrap gap-3">
                <Button variant="secondary" onClick={() => void handleSaveObservationOnly()} disabled={savingAction}>
                  <Send size={16} />
                  Salvar observaÃ§Ã£o
                </Button>
                <Button variant="secondary" onClick={() => setScheduleOpen(true)}>
                  <CalendarClock size={16} />
                  Agendar retorno
                </Button>
                <Button variant="secondary" onClick={() => setConvertOpen(true)}>
                  <ThumbsUp size={16} />
                  Convertido
                </Button>
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-400">Linha do tempo do contato</p>
                <Badge tone="neutral">{timeline.length} eventos</Badge>
              </div>
              <div className="mt-4 space-y-3">
                {timeline.length ? (
                  timeline.map((item) => (
                    <div key={item.id} className="rounded-2xl border border-border bg-bg/60 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold text-white">{timelineLabel(item.type)}</p>
                          <p className="mt-1 text-sm text-slate-400">{item.note || item.private_note || 'Sem observaÃ§Ã£o'}</p>
                        </div>
                        <Badge tone="accent">{new Date(item.created_at).toLocaleString('pt-BR')}</Badge>
                      </div>
                      <p className="mt-3 text-xs text-slate-500">{item.user_name || 'Carlos Andrade'}</p>
                    </div>
                  ))
                ) : (
                  <div className="rounded-2xl border border-dashed border-border bg-white/3 p-4 text-sm text-slate-500">
                    Nenhum evento registrado ainda.
                  </div>
                )}
              </div>
            </Card>
          </div>

          <Card className="p-6">
            <div className="grid gap-3 md:grid-cols-5">
              <Button className="py-4" onClick={() => void handleFinalizar()} disabled={savingAction}>
                <CheckCircle2 size={16} />
                Finalizar atendimento
              </Button>
              <Button variant="secondary" className="py-4" onClick={() => setScheduleOpen(true)} disabled={savingAction}>
                <CalendarClock size={16} />
                Agendar retorno
              </Button>
              <Button variant="secondary" className="py-4" onClick={() => void handleNoInterest()} disabled={savingAction}>
                <ThumbsDown size={16} />
                Sem interesse
              </Button>
              <Button variant="secondary" className="py-4" onClick={() => setConvertOpen(true)} disabled={savingAction}>
                <ThumbsUp size={16} />
                Convertido
              </Button>
              <Button variant="ghost" className="py-4" onClick={() => void goNextClient()} disabled={savingAction}>
                <ArrowRight size={16} />
                PrÃ³ximo cliente
              </Button>
            </div>
          </Card>
        </div>
      ) : (
        <Card className="p-8 text-sm text-slate-400">NÃ£o hÃ¡ clientes disponÃ­veis para atendimento.</Card>
      )}

      <Modal
        open={scheduleOpen}
        title="Agendar retorno"
        description="Defina a data, hora e a observaÃ§Ã£o do prÃ³ximo contato."
        onClose={() => setScheduleOpen(false)}
      >
        <div className="space-y-4">
          <Input type="datetime-local" value={scheduleDate} onChange={(event) => setScheduleDate(event.target.value)} />
          <Textarea rows={4} placeholder="ObservaÃ§Ã£o do retorno..." value={scheduleNote} onChange={(event) => setScheduleNote(event.target.value)} />
          <div className="flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setScheduleOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void handleScheduleReturn()} disabled={savingAction}>
              <TimerReset size={16} />
              Agendar
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={convertOpen}
        title="Marcar como convertido"
        description="Informe os dados principais da venda."
        onClose={() => setConvertOpen(false)}
        widthClass="max-w-3xl"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Input placeholder="Banco" value={convertForm.bank} onChange={(event) => setConvertForm((current) => ({ ...current, bank: event.target.value }))} />
          <Input placeholder="Valor fechado" value={convertForm.amount} onChange={(event) => setConvertForm((current) => ({ ...current, amount: event.target.value }))} />
          <Input placeholder="Parcelas" value={convertForm.installment} onChange={(event) => setConvertForm((current) => ({ ...current, installment: event.target.value }))} />
          <Input placeholder="Prazo" value={convertForm.term} onChange={(event) => setConvertForm((current) => ({ ...current, term: event.target.value }))} />
          <Textarea
            rows={4}
            className="md:col-span-2"
            placeholder="ObservaÃ§Ã£o da conversÃ£o..."
            value={convertForm.note}
            onChange={(event) => setConvertForm((current) => ({ ...current, note: event.target.value }))}
          />
        </div>
        <div className="mt-4 flex justify-end gap-3">
          <Button variant="secondary" onClick={() => setConvertOpen(false)}>
            Cancelar
          </Button>
          <Button onClick={() => void handleConvert()} disabled={savingAction}>
            <ThumbsUp size={16} />
            Confirmar conversÃ£o
          </Button>
        </div>
      </Modal>

      <Modal
        open={rawOpen}
        title="Dados originais da planilha"
        description="Todas as colunas da linha importada."
        onClose={() => setRawOpen(false)}
        widthClass="max-w-4xl"
      >
        <div className="max-h-[60vh] overflow-auto rounded-2xl border border-border bg-bg/70 p-4 text-sm text-slate-200">
          <pre className="whitespace-pre-wrap break-words">{JSON.stringify(rawData, null, 2)}</pre>
        </div>
      </Modal>
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg/60 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}

function MarginCard({
  title,
  gross,
  net,
  state,
}: {
  title: string;
  gross: number | null | undefined;
  net: number | null | undefined;
  state: { tone: 'neutral' | 'accent' | 'success' | 'danger' | 'info'; label: string };
}) {
  return (
    <div className="rounded-3xl border border-border bg-bg/60 p-5">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-lg font-semibold text-white">{title}</h4>
        <Badge tone={state.tone}>{state.label}</Badge>
      </div>
      <div className="mt-4 space-y-2 text-sm">
        <p className="text-slate-400">Margem bruta</p>
        <p className="font-semibold text-white">{formatCurrencyDisplay(gross)}</p>
        <p className="text-slate-400">Margem lÃ­quida</p>
        <p className="font-semibold text-white">{formatCurrencyDisplay(net)}</p>
      </div>
    </div>
  );
}

function timelineLabel(type: string) {
  const labels: Record<string, string> = {
    atendimento_iniciado: 'Atendimento iniciado',
    observacao: 'ObservaÃ§Ã£o adicionada',
    retorno_agendado: 'Retorno agendado',
    finalizado: 'Finalizado',
    sem_interesse: 'Sem interesse',
    convertido: 'Convertido',
    whatsapp_aberto: 'WhatsApp aberto',
  };

  return labels[type] || type;
}

function consultaTone(status?: string) {
  if (status === 'com_marg') return 'success';
  if (status === 'erro') return 'danger';
  return 'neutral';
}

function safeParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
