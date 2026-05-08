import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  MessageCircle,
  PlugZap,
  QrCode,
  RefreshCcw,
  Save,
  Send,
  Settings2,
  Workflow,
  Plus,
  Trash2,
  PlayCircle,
  StopCircle,
} from 'lucide-react';
import toast from 'react-hot-toast';

import { Badge, Button, Card, Input, SectionHeader, Select, Textarea } from '../components/ui';
import { api, ApiError } from '../lib/api';
import type {
  WhatsappConfig,
  WhatsappFlow,
  WhatsappFlowExecution,
  WhatsappFlowLog,
  WhatsappMessage,
  WhatsappTemplate,
} from '../types';

type TabKey = 'conexao' | 'templates' | 'fluxos' | 'historico';

const statusLabels: Record<string, string> = {
  connected: 'Conectado',
  configured: 'Configurado',
  not_configured: 'Nao configurado',
  disconnected: 'Desconectado',
  disabled: 'Desativado',
  error: 'Erro',
  sent: 'Enviada',
  delivered: 'Entregue',
  read: 'Lida',
  failed: 'Falha',
  received: 'Recebida',
  pending: 'Pendente',
  blocked_by_rule: 'Bloqueado por regra',
};

const flowStatusLabels: Record<string, string> = {
  active: 'Ativo',
  waiting_response: 'Aguardando resposta',
  completed: 'Concluido',
  stopped: 'Parado',
  assigned_to_human: 'Humano assumiu',
  opt_out: 'Opt-out',
  failed: 'Falhou',
};

function statusTone(status?: string): 'neutral' | 'success' | 'danger' | 'info' {
  if (['connected', 'sent', 'delivered', 'read', 'received', 'completed'].includes(String(status))) return 'success';
  if (['error', 'failed', 'disabled', 'opt_out'].includes(String(status))) return 'danger';
  if (['active', 'waiting_response', 'assigned_to_human', 'pending'].includes(String(status))) return 'info';
  return 'neutral';
}

function dateTime(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function parseKeywordsToArray(input: string) {
  return input
    .split(/[,;\n|]/g)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function keywordsToText(input: string[] | undefined) {
  return Array.isArray(input) ? input.join(', ') : '';
}

type FlowStepForm = {
  id?: number;
  step_order: number;
  trigger_keywords_text: string;
  response_message: string;
  action_type: string;
  client_status_to_apply: string;
  should_assign_human: boolean;
  should_stop_flow: boolean;
};

type FlowForm = {
  id?: number;
  name: string;
  description: string;
  initial_template_id: string;
  initial_message: string;
  fallback_message: string;
  fallback_human_after: number;
  active: boolean;
  steps: FlowStepForm[];
};

function emptyFlowForm(): FlowForm {
  return {
    name: '',
    description: '',
    initial_template_id: '',
    initial_message: '',
    fallback_message:
      'Desculpa, {{nome}}, nao consegui entender. Voce pode responder com: 1 - Pode mandar, 2 - Nao tenho interesse, 3 - Falar com atendente.',
    fallback_human_after: 2,
    active: true,
    steps: [
      {
        step_order: 1,
        trigger_keywords_text: '',
        response_message: '',
        action_type: 'none',
        client_status_to_apply: '',
        should_assign_human: false,
        should_stop_flow: false,
      },
    ],
  };
}

function flowToForm(flow: WhatsappFlow): FlowForm {
  return {
    id: flow.id,
    name: flow.name || '',
    description: flow.description || '',
    initial_template_id: flow.initial_template_id ? String(flow.initial_template_id) : '',
    initial_message: flow.initial_message || '',
    fallback_message:
      flow.fallback_message ||
      'Desculpa, {{nome}}, nao consegui entender. Voce pode responder com: 1 - Pode mandar, 2 - Nao tenho interesse, 3 - Falar com atendente.',
    fallback_human_after: Number(flow.fallback_human_after || 2),
    active: flow.active !== false,
    steps:
      flow.steps?.map((step, index) => ({
        id: step.id,
        step_order: Number(step.step_order || index + 1),
        trigger_keywords_text: keywordsToText(step.trigger_keywords),
        response_message: step.response_message || '',
        action_type: step.action_type || 'none',
        client_status_to_apply: step.client_status_to_apply || '',
        should_assign_human: Boolean(step.should_assign_human),
        should_stop_flow: Boolean(step.should_stop_flow),
      })) || [],
  };
}

export default function WhatsAppApiPage() {
  const location = useLocation();
  const [activeTab, setActiveTab] = useState<TabKey>('conexao');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState<{ connected?: boolean; status?: string; message?: string; qrcode?: string } | null>(null);
  const [config, setConfig] = useState<Partial<WhatsappConfig> & { token?: string }>({
    provider: 'unofficial',
    enabled: true,
    send_delay_seconds: 120,
    daily_limit_per_number: 30,
    default_country_code: '55',
  });
  const [messages, setMessages] = useState<WhatsappMessage[]>([]);
  const [templates, setTemplates] = useState<WhatsappTemplate[]>([]);
  const [templateForm, setTemplateForm] = useState({ id: '', name: '', category: 'abordagem', body: '' });
  const [sendForm, setSendForm] = useState({ client_id: '', phone: '', template_id: '', message: '' });
  const [flows, setFlows] = useState<WhatsappFlow[]>([]);
  const [flowForm, setFlowForm] = useState<FlowForm>(emptyFlowForm());
  const [executions, setExecutions] = useState<WhatsappFlowExecution[]>([]);
  const [flowLogs, setFlowLogs] = useState<WhatsappFlowLog[]>([]);
  const [startFlowForm, setStartFlowForm] = useState({ flow_id: '', client_id: '', phone: '' });

  const selectedTemplate = useMemo(
    () => templates.find((template) => String(template.id) === String(sendForm.template_id)),
    [sendForm.template_id, templates]
  );

  const currentStatus = status?.status || config.status || 'not_configured';
  const qrcode = status?.qrcode || config.qrcode || '';

  async function load() {
    setLoading(true);
    try {
      const [statusResponse, messagesResponse, templatesResponse, flowsResponse, executionsResponse, logsResponse] =
        await Promise.all([
          api.getWhatsappStatus(),
          api.getWhatsappMessages({ limit: 80 }),
          api.getWhatsappTemplates({}),
          api.getWhatsappFlows({}),
          api.getWhatsappFlowExecutions({ limit: 80 }),
          api.getWhatsappFlowLogs({ limit: 120 }),
        ]);

      setStatus(statusResponse);
      setConfig({
        provider: statusResponse.config?.provider || 'unofficial',
        api_url: statusResponse.config?.api_url || '',
        default_country_code: statusResponse.config?.default_country_code || '55',
        default_number: statusResponse.config?.default_number || '',
        instance_id: statusResponse.config?.instance_id || '',
        enabled: statusResponse.config?.enabled !== false,
        send_delay_seconds: statusResponse.config?.send_delay_seconds || 120,
        daily_limit_per_number: statusResponse.config?.daily_limit_per_number || 30,
        status: statusResponse.config?.status,
        has_token: statusResponse.config?.has_token,
        token: '',
      });
      setMessages(messagesResponse.rows || []);
      setTemplates(templatesResponse.rows || []);
      setFlows(flowsResponse.rows || []);
      setExecutions(executionsResponse.rows || []);
      setFlowLogs(logsResponse.rows || []);
      if ((flowsResponse.rows || []).length && !flowForm.id) {
        setFlowForm(flowToForm(flowsResponse.rows[0]));
        setStartFlowForm((current) => ({ ...current, flow_id: String(flowsResponse.rows[0].id) }));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar modulo WhatsApp.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (location.pathname.includes('/whatsapp-fluxos')) {
      setActiveTab('fluxos');
    }
  }, [location.pathname]);

  useEffect(() => {
    if (selectedTemplate && !sendForm.message) {
      setSendForm((current) => ({ ...current, message: selectedTemplate.body }));
    }
  }, [selectedTemplate, sendForm.message]);

  async function runAction(action: 'save' | 'connect' | 'reconnect' | 'test') {
    setBusy(action);
    try {
      if (action === 'save') {
        await api.saveWhatsappConfig(config);
        toast.success('Configuracao salva.');
      }
      if (action === 'connect') {
        await api.connectWhatsapp();
        toast.success('Conexao solicitada.');
      }
      if (action === 'reconnect') {
        await api.reconnectWhatsapp();
        toast.success('Reconexao solicitada.');
      }
      if (action === 'test') {
        await api.testWhatsapp();
        toast.success('Teste executado.');
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha na acao do WhatsApp.');
    } finally {
      setBusy('');
    }
  }

  async function refreshQrcode() {
    setBusy('qrcode');
    try {
      const response = await api.getWhatsappQrcode();
      setStatus((current) => ({
        ...(current || {}),
        qrcode: response.qrcode,
        status: response.status || current?.status,
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar QR Code.');
    } finally {
      setBusy('');
    }
  }

  async function sendManualMessage() {
    setBusy('send');
    try {
      await api.sendWhatsapp({
        client_id: sendForm.client_id || undefined,
        phone: sendForm.phone,
        template_id: sendForm.template_id || undefined,
        message: sendForm.message,
      });
      toast.success('Mensagem enviada e registrada.');
      setSendForm((current) => ({ ...current, message: '' }));
      const response = await api.getWhatsappMessages({ limit: 80 });
      setMessages(response.rows || []);
    } catch (error) {
      if (error instanceof ApiError) {
        const response = await api.getWhatsappMessages({ limit: 80 });
        setMessages(response.rows || []);
      }
      toast.error(error instanceof Error ? error.message : 'Falha ao enviar mensagem.');
    } finally {
      setBusy('');
    }
  }

  async function testSend() {
    if (!config.default_number) {
      toast.error('Configure um numero padrao para teste.');
      return;
    }
    setBusy('test-send');
    try {
      await api.sendWhatsapp({
        phone: config.default_number,
        message: 'Teste de conectividade WhatsApp API - Reliance CRM',
      });
      toast.success('Teste de envio executado.');
      const response = await api.getWhatsappMessages({ limit: 80 });
      setMessages(response.rows || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha no teste de envio.');
    } finally {
      setBusy('');
    }
  }

  async function saveTemplateFromForm() {
    if (!templateForm.name.trim() || !templateForm.body.trim()) {
      toast.error('Preencha nome e corpo do template.');
      return;
    }
    setBusy('template');
    try {
      if (templateForm.id) {
        await api.updateWhatsappTemplate(Number(templateForm.id), templateForm);
      } else {
        await api.saveWhatsappTemplate(templateForm);
      }
      const response = await api.getWhatsappTemplates({});
      setTemplates(response.rows || []);
      setTemplateForm({ id: '', name: '', category: 'abordagem', body: '' });
      toast.success('Template salvo.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar template.');
    } finally {
      setBusy('');
    }
  }

  function addFlowStep() {
    setFlowForm((current) => ({
      ...current,
      steps: [
        ...current.steps,
        {
          step_order: current.steps.length + 1,
          trigger_keywords_text: '',
          response_message: '',
          action_type: 'none',
          client_status_to_apply: '',
          should_assign_human: false,
          should_stop_flow: false,
        },
      ],
    }));
  }

  function removeFlowStep(index: number) {
    setFlowForm((current) => ({
      ...current,
      steps: current.steps
        .filter((_, stepIndex) => stepIndex !== index)
        .map((step, stepIndex) => ({
          ...step,
          step_order: stepIndex + 1,
        })),
    }));
  }

  function updateFlowStep(index: number, patch: Partial<FlowStepForm>) {
    setFlowForm((current) => ({
      ...current,
      steps: current.steps.map((step, stepIndex) => (stepIndex === index ? { ...step, ...patch } : step)),
    }));
  }

  async function saveFlowForm() {
    if (!flowForm.name.trim()) {
      toast.error('Informe o nome do fluxo.');
      return;
    }
    setBusy('flow-save');
    try {
      const payload = {
        id: flowForm.id,
        name: flowForm.name,
        description: flowForm.description,
        initial_template_id: flowForm.initial_template_id ? Number(flowForm.initial_template_id) : null,
        initial_message: flowForm.initial_message,
        fallback_message: flowForm.fallback_message,
        fallback_human_after: Number(flowForm.fallback_human_after || 2),
        active: flowForm.active,
        steps: flowForm.steps.map((step, index) => ({
          id: step.id,
          step_order: index + 1,
          trigger_keywords: parseKeywordsToArray(step.trigger_keywords_text),
          response_message: step.response_message,
          action_type: step.action_type,
          client_status_to_apply: step.client_status_to_apply,
          should_assign_human: step.should_assign_human,
          should_stop_flow: step.should_stop_flow,
        })),
      };
      const response = flowForm.id
        ? await api.updateWhatsappFlow(flowForm.id, payload)
        : await api.saveWhatsappFlow(payload);
      toast.success(flowForm.id ? 'Fluxo atualizado.' : 'Fluxo criado.');
      const flowsResponse = await api.getWhatsappFlows({});
      setFlows(flowsResponse.rows || []);
      if (response.flow) {
        setFlowForm(flowToForm(response.flow));
      }
      const logsResponse = await api.getWhatsappFlowLogs({ limit: 120 });
      setFlowLogs(logsResponse.rows || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar fluxo.');
    } finally {
      setBusy('');
    }
  }

  async function startFlow() {
    if (!startFlowForm.flow_id || !startFlowForm.client_id) {
      toast.error('Informe fluxo e cliente para iniciar.');
      return;
    }
    setBusy('flow-start');
    try {
      await api.startWhatsappFlow({
        flow_id: Number(startFlowForm.flow_id),
        client_id: Number(startFlowForm.client_id),
        phone: startFlowForm.phone || undefined,
      });
      toast.success('Fluxo iniciado para o cliente.');
      const [executionsResponse, logsResponse] = await Promise.all([
        api.getWhatsappFlowExecutions({ limit: 80 }),
        api.getWhatsappFlowLogs({ limit: 120 }),
      ]);
      setExecutions(executionsResponse.rows || []);
      setFlowLogs(logsResponse.rows || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao iniciar fluxo.');
    } finally {
      setBusy('');
    }
  }

  async function stopFlow(executionId: number) {
    setBusy(`flow-stop-${executionId}`);
    try {
      await api.stopWhatsappFlow({ execution_id: executionId, reason: 'stopped' });
      toast.success('Fluxo interrompido.');
      const executionsResponse = await api.getWhatsappFlowExecutions({ limit: 80 });
      setExecutions(executionsResponse.rows || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao interromper fluxo.');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="WhatsApp API"
        description="Conecte o provedor, configure templates, gerencie fluxos e acompanhe o historico de mensagens."
      />

      <Card className="p-3">
        <div className="flex flex-wrap gap-2">
          {[
            { key: 'conexao', label: 'Conexao', icon: Settings2 },
            { key: 'templates', label: 'Templates', icon: MessageCircle },
            { key: 'fluxos', label: 'Fluxos', icon: Workflow },
            { key: 'historico', label: 'Historico', icon: CheckCircle2 },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key as TabKey)}
                className={`inline-flex items-center gap-2 rounded-2xl border px-4 py-2 text-sm ${
                  active ? 'border-accent/50 bg-accent/15 text-white' : 'border-border bg-panelAlt text-slate-300 hover:border-accent/30'
                }`}
              >
                <Icon size={16} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </Card>

      {activeTab === 'conexao' ? (
        <>
          <div className="grid gap-5 xl:grid-cols-[1.2fr_.8fr]">
            <Card className="p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-3">
                    <span className="rounded-2xl border border-accent/30 bg-accent/10 p-3 text-accent">
                      <Settings2 size={20} />
                    </span>
                    <div>
                      <h3 className="text-lg font-bold text-white">Configuracao do provedor</h3>
                      <p className="text-sm text-slate-400">Tokens ficam somente no backend. O frontend nao recebe o valor salvo.</p>
                    </div>
                  </div>
                </div>
                <Badge tone={statusTone(currentStatus)}>{statusLabels[currentStatus] || currentStatus}</Badge>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-sm text-slate-300">Provedor</span>
                  <Select value={config.provider || 'unofficial'} onChange={(event) => setConfig({ ...config, provider: event.target.value })}>
                    <option value="unofficial">API nao oficial / QR Code</option>
                    <option value="meta">Meta WhatsApp Business Platform</option>
                  </Select>
                </label>
                <label className="space-y-2">
                  <span className="text-sm text-slate-300">API URL</span>
                  <Input
                    placeholder="https://api.seuprovedor.com"
                    value={config.api_url || ''}
                    onChange={(event) => setConfig({ ...config, api_url: event.target.value })}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm text-slate-300">Token/API key</span>
                  <Input
                    type="password"
                    placeholder={config.has_token ? 'Token salvo. Preencha apenas para trocar.' : 'Cole o token do provedor'}
                    value={config.token || ''}
                    onChange={(event) => setConfig({ ...config, token: event.target.value })}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm text-slate-300">Instance ID / numero da sessao</span>
                  <Input
                    placeholder="Opcional"
                    value={config.instance_id || ''}
                    onChange={(event) => setConfig({ ...config, instance_id: event.target.value })}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm text-slate-300">Numero padrao</span>
                  <Input
                    placeholder="+5516999999999"
                    value={config.default_number || ''}
                    onChange={(event) => setConfig({ ...config, default_number: event.target.value })}
                  />
                </label>
                <label className="space-y-2">
                  <span className="text-sm text-slate-300">Limite diario por numero</span>
                  <Input
                    type="number"
                    min={1}
                    value={config.daily_limit_per_number || 30}
                    onChange={(event) => setConfig({ ...config, daily_limit_per_number: Number(event.target.value || 30) })}
                  />
                </label>
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <Button onClick={() => runAction('save')} disabled={busy === 'save'}>
                  <Save size={16} /> Salvar configuracao
                </Button>
                <Button variant="secondary" onClick={() => runAction('test')} disabled={Boolean(busy)}>
                  <CheckCircle2 size={16} /> Testar conexao
                </Button>
                <Button variant="secondary" onClick={() => runAction('connect')} disabled={Boolean(busy)}>
                  <PlugZap size={16} /> Conectar
                </Button>
                <Button variant="secondary" onClick={() => runAction('reconnect')} disabled={Boolean(busy)}>
                  <RefreshCcw size={16} /> Reconectar
                </Button>
                <Button variant="secondary" onClick={refreshQrcode} disabled={Boolean(busy)}>
                  <QrCode size={16} /> Atualizar QR Code
                </Button>
                <Button variant="secondary" onClick={testSend} disabled={Boolean(busy)}>
                  <Send size={16} /> Testar envio
                </Button>
              </div>
            </Card>

            <div className="space-y-5">
              <Card className="p-6">
                <div className="flex items-center gap-3">
                  <span className="rounded-2xl border border-accent/30 bg-accent/10 p-3 text-accent">
                    <MessageCircle size={20} />
                  </span>
                  <div>
                    <h3 className="text-lg font-bold text-white">Status da conexao</h3>
                    <p className="text-sm text-slate-400">Ultimo teste: {dateTime(config.last_test_at)}</p>
                  </div>
                </div>
                <div className="mt-5 rounded-2xl border border-border bg-bg/70 p-4">
                  <p className="text-sm text-slate-400">Estado atual</p>
                  <p className="mt-1 text-xl font-bold text-white">{statusLabels[currentStatus] || currentStatus}</p>
                  <p className="mt-2 text-xs text-slate-500">Ultima conexao: {dateTime(config.connected_at)}</p>
                  {status?.message || config.last_error ? <p className="mt-2 text-sm text-amber-200">{status?.message || config.last_error}</p> : null}
                </div>
              </Card>

              <Card className="p-6">
                <div className="flex items-center gap-3">
                  <QrCode className="text-accent" size={20} />
                  <h3 className="text-lg font-bold text-white">QR Code</h3>
                </div>
                {qrcode ? (
                  <div className="mt-4 rounded-2xl border border-border bg-white p-4 text-center">
                    {qrcode.startsWith('data:image') ? (
                      <img src={qrcode} alt="QR Code WhatsApp" className="mx-auto max-h-64" />
                    ) : (
                      <p className="break-all text-xs text-slate-800">{qrcode}</p>
                    )}
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl border border-dashed border-border p-6 text-center text-sm text-slate-400">
                    QR Code aparecera aqui quando o provedor nao oficial retornar a conexao por WhatsApp Web.
                  </div>
                )}
              </Card>
            </div>
          </div>

          <Card className="p-6">
            <div className="mb-5 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-white">Envio manual</h3>
                <p className="text-sm text-slate-400">
                  Envio controlado. O backend bloqueia clientes sem interesse, bloqueados ou sem telefone valido.
                </p>
              </div>
              <Badge tone="info">Sem disparo em massa</Badge>
            </div>
            <div className="grid gap-4 lg:grid-cols-[.4fr_.6fr]">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                <Input
                  placeholder="ID do cliente opcional"
                  value={sendForm.client_id}
                  onChange={(event) => setSendForm({ ...sendForm, client_id: event.target.value })}
                />
                <Input placeholder="Telefone com DDD" value={sendForm.phone} onChange={(event) => setSendForm({ ...sendForm, phone: event.target.value })} />
                <Select
                  value={sendForm.template_id}
                  onChange={(event) =>
                    setSendForm({
                      ...sendForm,
                      template_id: event.target.value,
                      message: templates.find((template) => String(template.id) === event.target.value)?.body || sendForm.message,
                    })
                  }
                >
                  <option value="">Mensagem manual</option>
                  {templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-3">
                <Textarea
                  rows={6}
                  placeholder="Digite a mensagem ou selecione um template"
                  value={sendForm.message}
                  onChange={(event) => setSendForm({ ...sendForm, message: event.target.value })}
                />
                <Button
                  onClick={sendManualMessage}
                  disabled={busy === 'send' || !sendForm.message.trim() || (!sendForm.phone.trim() && !sendForm.client_id.trim())}
                >
                  <Send size={16} /> Enviar mensagem
                </Button>
              </div>
            </div>
          </Card>
        </>
      ) : null}

      {activeTab === 'templates' ? (
        <Card className="p-6">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-lg font-bold text-white">Templates</h3>
              <p className="text-sm text-slate-400">Crie e edite templates para envio manual e respostas de webhook.</p>
            </div>
          </div>
          <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
            <div className="space-y-3">
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => setTemplateForm({ id: String(template.id), name: template.name, category: template.category, body: template.body })}
                  className="w-full rounded-2xl border border-border bg-bg/60 p-3 text-left text-sm text-slate-200 hover:border-accent/40"
                >
                  <p className="font-semibold text-white">{template.name}</p>
                  <p className="mt-1 text-xs text-slate-500">{template.category}</p>
                </button>
              ))}
            </div>
            <div className="space-y-3">
              <Input placeholder="Nome do template" value={templateForm.name} onChange={(event) => setTemplateForm({ ...templateForm, name: event.target.value })} />
              <Select value={templateForm.category} onChange={(event) => setTemplateForm({ ...templateForm, category: event.target.value })}>
                <option value="abordagem">abordagem</option>
                <option value="resposta_interesse">resposta_interesse</option>
                <option value="retorno">retorno</option>
                <option value="opt_out">opt_out</option>
                <option value="agendamento">agendamento</option>
                <option value="humano_assumir">humano_assumir</option>
              </Select>
              <Textarea rows={5} placeholder="Use {{nome}} para personalizar." value={templateForm.body} onChange={(event) => setTemplateForm({ ...templateForm, body: event.target.value })} />
              <div className="flex gap-2">
                <Button onClick={saveTemplateFromForm} disabled={busy === 'template'}>
                  <Save size={16} /> {templateForm.id ? 'Atualizar template' : 'Criar template'}
                </Button>
                <Button variant="secondary" onClick={() => setTemplateForm({ id: '', name: '', category: 'abordagem', body: '' })}>
                  Limpar
                </Button>
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      {activeTab === 'fluxos' ? (
        <div className="grid gap-5 xl:grid-cols-[0.95fr_1.05fr]">
          <Card className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-bold text-white">Fluxos criados</h3>
                <p className="text-sm text-slate-400">Selecione um fluxo para editar ou crie um novo.</p>
              </div>
              <Button
                variant="secondary"
                onClick={() => {
                  setFlowForm(emptyFlowForm());
                }}
              >
                <Plus size={16} /> Novo fluxo
              </Button>
            </div>
            <div className="space-y-2">
              {flows.map((flow) => (
                <button
                  key={flow.id}
                  type="button"
                  onClick={() => setFlowForm(flowToForm(flow))}
                  className={`w-full rounded-2xl border p-3 text-left ${
                    flowForm.id === flow.id ? 'border-accent/50 bg-accent/10' : 'border-border bg-bg/60 hover:border-accent/30'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold text-white">{flow.name}</p>
                    <Badge tone={flow.active ? 'success' : 'neutral'}>{flow.active ? 'Ativo' : 'Inativo'}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">{flow.description || 'Sem descricao'}</p>
                </button>
              ))}
              {!flows.length ? <p className="rounded-2xl border border-border bg-bg/60 p-4 text-sm text-slate-400">Nenhum fluxo cadastrado.</p> : null}
            </div>

            <div className="mt-6 space-y-3 rounded-2xl border border-border bg-bg/60 p-4">
              <h4 className="font-semibold text-white">Iniciar fluxo por cliente</h4>
              <Select value={startFlowForm.flow_id} onChange={(event) => setStartFlowForm({ ...startFlowForm, flow_id: event.target.value })}>
                <option value="">Selecione o fluxo</option>
                {flows.filter((flow) => flow.active).map((flow) => (
                  <option key={flow.id} value={flow.id}>
                    {flow.name}
                  </option>
                ))}
              </Select>
              <Input placeholder="ID do cliente" value={startFlowForm.client_id} onChange={(event) => setStartFlowForm({ ...startFlowForm, client_id: event.target.value })} />
              <Input placeholder="Telefone (opcional)" value={startFlowForm.phone} onChange={(event) => setStartFlowForm({ ...startFlowForm, phone: event.target.value })} />
              <Button onClick={startFlow} disabled={busy === 'flow-start'}>
                <PlayCircle size={16} /> Iniciar fluxo
              </Button>
            </div>
          </Card>

          <Card className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-bold text-white">{flowForm.id ? 'Editar fluxo' : 'Novo fluxo'}</h3>
              <Badge tone={flowForm.active ? 'success' : 'neutral'}>{flowForm.active ? 'Ativo' : 'Inativo'}</Badge>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Input placeholder="Nome do fluxo" value={flowForm.name} onChange={(event) => setFlowForm({ ...flowForm, name: event.target.value })} />
              <Select value={flowForm.active ? '1' : '0'} onChange={(event) => setFlowForm({ ...flowForm, active: event.target.value === '1' })}>
                <option value="1">Ativo</option>
                <option value="0">Inativo</option>
              </Select>
            </div>
            <div className="mt-3">
              <Textarea rows={2} placeholder="Descricao do fluxo" value={flowForm.description} onChange={(event) => setFlowForm({ ...flowForm, description: event.target.value })} />
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <Select
                value={flowForm.initial_template_id}
                onChange={(event) => setFlowForm({ ...flowForm, initial_template_id: event.target.value })}
              >
                <option value="">Template inicial (opcional)</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </Select>
              <Input
                type="number"
                min={1}
                value={flowForm.fallback_human_after}
                onChange={(event) => setFlowForm({ ...flowForm, fallback_human_after: Number(event.target.value || 2) })}
                placeholder="Falhas nao entendidas para humano"
              />
            </div>
            <div className="mt-3 space-y-3">
              <Textarea
                rows={4}
                placeholder="Mensagem inicial (se vazio, usa template inicial)"
                value={flowForm.initial_message}
                onChange={(event) => setFlowForm({ ...flowForm, initial_message: event.target.value })}
              />
              <Textarea
                rows={3}
                placeholder="Mensagem para resposta nao entendida"
                value={flowForm.fallback_message}
                onChange={(event) => setFlowForm({ ...flowForm, fallback_message: event.target.value })}
              />
            </div>

            <div className="mt-5 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold text-white">Respostas esperadas</h4>
                <Button variant="secondary" onClick={addFlowStep}>
                  <Plus size={16} /> Adicionar resposta
                </Button>
              </div>
              {flowForm.steps.map((step, index) => (
                <div key={`${step.id || 'new'}-${index}`} className="rounded-2xl border border-border bg-bg/60 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-200">Resposta {index + 1}</p>
                    <button type="button" onClick={() => removeFlowStep(index)} className="text-slate-400 hover:text-red-300">
                      <Trash2 size={16} />
                    </button>
                  </div>
                  <div className="grid gap-3 md:grid-cols-2">
                    <Input
                      placeholder="Gatilhos (separados por virgula)"
                      value={step.trigger_keywords_text}
                      onChange={(event) => updateFlowStep(index, { trigger_keywords_text: event.target.value })}
                    />
                    <Select value={step.action_type} onChange={(event) => updateFlowStep(index, { action_type: event.target.value })}>
                      <option value="none">Sem acao</option>
                      <option value="interest">Interesse</option>
                      <option value="opt_out">Opt-out</option>
                      <option value="human">Humano assumir</option>
                    </Select>
                    <Input
                      placeholder="Status do cliente (ex: em_atendimento)"
                      value={step.client_status_to_apply}
                      onChange={(event) => updateFlowStep(index, { client_status_to_apply: event.target.value })}
                    />
                    <div className="flex items-center gap-3 text-sm text-slate-300">
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={step.should_assign_human}
                          onChange={(event) => updateFlowStep(index, { should_assign_human: event.target.checked })}
                        />
                        Humano assumir
                      </label>
                      <label className="inline-flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={step.should_stop_flow}
                          onChange={(event) => updateFlowStep(index, { should_stop_flow: event.target.checked })}
                        />
                        Parar fluxo
                      </label>
                    </div>
                  </div>
                  <Textarea
                    className="mt-3"
                    rows={3}
                    placeholder="Resposta automatica"
                    value={step.response_message}
                    onChange={(event) => updateFlowStep(index, { response_message: event.target.value })}
                  />
                </div>
              ))}
            </div>
            <div className="mt-4">
              <Button onClick={saveFlowForm} disabled={busy === 'flow-save'}>
                <Save size={16} /> {flowForm.id ? 'Atualizar fluxo' : 'Criar fluxo'}
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {activeTab === 'historico' ? (
        <div className="space-y-5">
          <Card className="p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-white">Execucoes de fluxo</h3>
                <p className="text-sm text-slate-400">Historico de fluxos iniciados por cliente.</p>
              </div>
              {loading ? <Badge>Carregando</Badge> : <Badge tone="accent">{executions.length} execucoes</Badge>}
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-border text-sm">
                <thead className="text-left text-xs uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="py-3 pr-4">Cliente</th>
                    <th className="py-3 pr-4">Fluxo</th>
                    <th className="py-3 pr-4">Status</th>
                    <th className="py-3 pr-4">Ultima atividade</th>
                    <th className="py-3 pr-4">Acao</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70 text-slate-200">
                  {executions.map((execution) => (
                    <tr key={execution.id}>
                      <td className="py-3 pr-4">{execution.client_name || `#${execution.client_id}`}</td>
                      <td className="py-3 pr-4">{execution.flow_name || execution.flow_id}</td>
                      <td className="py-3 pr-4">
                        <Badge tone={statusTone(execution.status)}>{flowStatusLabels[execution.status] || execution.status}</Badge>
                      </td>
                      <td className="py-3 pr-4 text-slate-400">{dateTime(execution.last_message_at || execution.updated_at)}</td>
                      <td className="py-3 pr-4">
                        {['active', 'waiting_response'].includes(String(execution.status)) ? (
                          <Button
                            variant="secondary"
                            onClick={() => stopFlow(execution.id)}
                            disabled={busy === `flow-stop-${execution.id}`}
                            className="px-3 py-2 text-xs"
                          >
                            <StopCircle size={14} /> Parar
                          </Button>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  ))}
                  {!executions.length ? (
                    <tr>
                      <td className="py-8 text-center text-slate-500" colSpan={5}>
                        Nenhuma execucao de fluxo registrada.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-white">Logs de fluxo e mensagens</h3>
                <p className="text-sm text-slate-400">Entradas/saidas avaliadas pelos gatilhos dos fluxos.</p>
              </div>
              <Badge tone="accent">{flowLogs.length} logs</Badge>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-border text-sm">
                <thead className="text-left text-xs uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="py-3 pr-4">Data</th>
                    <th className="py-3 pr-4">Cliente</th>
                    <th className="py-3 pr-4">Fluxo</th>
                    <th className="py-3 pr-4">Entrada</th>
                    <th className="py-3 pr-4">Acao</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70 text-slate-200">
                  {flowLogs.map((log) => (
                    <tr key={log.id}>
                      <td className="py-3 pr-4 text-slate-400">{dateTime(log.created_at)}</td>
                      <td className="py-3 pr-4">{log.client_name || `#${log.client_id}`}</td>
                      <td className="py-3 pr-4">{log.flow_name || '-'}</td>
                      <td className="py-3 pr-4">{log.inbound_message || '-'}</td>
                      <td className="py-3 pr-4">{log.action_taken || '-'}</td>
                    </tr>
                  ))}
                  {!flowLogs.length ? (
                    <tr>
                      <td className="py-8 text-center text-slate-500" colSpan={5}>
                        Nenhum log de fluxo registrado.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-6">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-white">Historico de mensagens</h3>
                <p className="text-sm text-slate-400">Mensagens enviadas, recebidas e falhas registradas pelo CRM.</p>
              </div>
              <Badge tone="accent">{messages.length} registros</Badge>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-border text-sm">
                <thead className="text-left text-xs uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="py-3 pr-4">Data</th>
                    <th className="py-3 pr-4">Cliente</th>
                    <th className="py-3 pr-4">Telefone</th>
                    <th className="py-3 pr-4">Direcao</th>
                    <th className="py-3 pr-4">Status</th>
                    <th className="py-3 pr-4">Erro</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70 text-slate-200">
                  {messages.map((message) => (
                    <tr key={message.id}>
                      <td className="py-3 pr-4 text-slate-400">{dateTime(message.sent_at || message.received_at || message.created_at)}</td>
                      <td className="py-3 pr-4">{message.client_name || '-'}</td>
                      <td className="py-3 pr-4">{message.phone}</td>
                      <td className="py-3 pr-4">{message.direction === 'inbound' ? 'Recebida' : 'Enviada'}</td>
                      <td className="py-3 pr-4">
                        <Badge tone={statusTone(message.status)}>{statusLabels[message.status] || message.status}</Badge>
                      </td>
                      <td className="py-3 pr-4 text-xs text-amber-200">{message.error_message || '-'}</td>
                    </tr>
                  ))}
                  {!messages.length ? (
                    <tr>
                      <td className="py-8 text-center text-slate-500" colSpan={6}>
                        Nenhuma mensagem registrada ainda.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : null}

      <Card className="border-amber-400/20 bg-amber-400/5 p-5">
        <div className="flex gap-3">
          <AlertTriangle className="mt-1 text-amber-300" size={20} />
          <p className="text-sm text-amber-100">
            API nao oficial deve ser usada apenas para atendimento manual/controlado. Nao ha disparo em massa nesta implementacao, e mensagens para
            clientes bloqueados ou sem interesse sao barradas no backend.
          </p>
        </div>
      </Card>
    </div>
  );
}
