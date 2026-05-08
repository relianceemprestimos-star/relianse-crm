import { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import toast from 'react-hot-toast';

import { Badge, Button, Card, Input, SectionHeader, Select, Textarea } from '../components/ui';
import { api, ApiError } from '../lib/api';
import type { WhatsappConfig, WhatsappMessage, WhatsappTemplate } from '../types';

const statusLabels: Record<string, string> = {
  connected: 'Conectado',
  configured: 'Configurado',
  not_configured: 'Não configurado',
  disconnected: 'Desconectado',
  disabled: 'Desativado',
  error: 'Erro',
  sent: 'Enviada',
  delivered: 'Entregue',
  read: 'Lida',
  failed: 'Falha',
  received: 'Recebida',
};

function statusTone(status?: string): 'neutral' | 'success' | 'danger' {
  if (['connected', 'sent', 'delivered', 'read', 'received'].includes(String(status))) return 'success';
  if (['error', 'failed', 'disabled'].includes(String(status))) return 'danger';
  return 'neutral';
}

function dateTime(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

export default function WhatsAppApiPage() {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState<{ connected?: boolean; status?: string; message?: string; qrcode?: string } | null>(null);
  const [config, setConfig] = useState<Partial<WhatsappConfig> & { token?: string }>({
    provider: 'unofficial',
    enabled: true,
    send_delay_seconds: 5,
    daily_limit_per_number: 30,
    default_country_code: '55',
  });
  const [messages, setMessages] = useState<WhatsappMessage[]>([]);
  const [templates, setTemplates] = useState<WhatsappTemplate[]>([]);
  const [sendForm, setSendForm] = useState({ client_id: '', phone: '', template_id: '', message: '' });

  const selectedTemplate = useMemo(
    () => templates.find((template) => String(template.id) === String(sendForm.template_id)),
    [sendForm.template_id, templates]
  );

  async function load() {
    setLoading(true);
    try {
      const [statusResponse, messagesResponse, templatesResponse] = await Promise.all([
        api.getWhatsappStatus(),
        api.getWhatsappMessages({ limit: 80 }),
        api.getWhatsappTemplates({ active: 1 }),
      ]);
      setStatus(statusResponse);
      setConfig({
        provider: statusResponse.config?.provider || 'unofficial',
        api_url: statusResponse.config?.api_url || '',
        default_country_code: statusResponse.config?.default_country_code || '55',
        default_number: statusResponse.config?.default_number || '',
        instance_id: statusResponse.config?.instance_id || '',
        enabled: statusResponse.config?.enabled !== false,
        send_delay_seconds: statusResponse.config?.send_delay_seconds || 5,
        daily_limit_per_number: statusResponse.config?.daily_limit_per_number || 30,
        status: statusResponse.config?.status,
        has_token: statusResponse.config?.has_token,
        token: '',
      });
      setMessages(messagesResponse.rows || []);
      setTemplates(templatesResponse.rows || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar WhatsApp API.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

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
        toast.success('Configuração salva.');
      }
      if (action === 'connect') {
        await api.connectWhatsapp();
        toast.success('Conexão solicitada.');
      }
      if (action === 'reconnect') {
        await api.reconnectWhatsapp();
        toast.success('Reconexão solicitada.');
      }
      if (action === 'test') {
        await api.testWhatsapp();
        toast.success('Teste executado.');
      }
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha na ação do WhatsApp.');
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
      if (error instanceof ApiError && error.data && typeof error.data === 'object') {
        const response = await api.getWhatsappMessages({ limit: 80 });
        setMessages(response.rows || []);
      }
      toast.error(error instanceof Error ? error.message : 'Falha ao enviar mensagem.');
    } finally {
      setBusy('');
    }
  }

  const currentStatus = status?.status || config.status || 'not_configured';
  const qrcode = status?.qrcode || config.qrcode || '';

  return (
    <div className="space-y-6">
      <SectionHeader
        title="WhatsApp API"
        description="Configure o provedor, teste a conexão e envie mensagens manuais com histórico no cadastro do cliente."
      />

      <div className="grid gap-5 xl:grid-cols-[1.2fr_.8fr]">
        <Card className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <span className="rounded-2xl border border-accent/30 bg-accent/10 p-3 text-accent">
                  <Settings2 size={20} />
                </span>
                <div>
                  <h3 className="text-lg font-bold text-white">Configuração do provedor</h3>
                  <p className="text-sm text-slate-400">Tokens ficam somente no backend. O frontend não recebe o valor salvo.</p>
                </div>
              </div>
            </div>
            <Badge tone={statusTone(currentStatus)}>{statusLabels[currentStatus] || currentStatus}</Badge>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm text-slate-300">Provedor</span>
              <Select value={config.provider || 'unofficial'} onChange={(event) => setConfig({ ...config, provider: event.target.value })}>
                <option value="unofficial">API não oficial / QR Code</option>
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
              <span className="text-sm text-slate-300">Instance ID / número da sessão</span>
              <Input
                placeholder="Opcional"
                value={config.instance_id || ''}
                onChange={(event) => setConfig({ ...config, instance_id: event.target.value })}
              />
            </label>
            <label className="space-y-2">
              <span className="text-sm text-slate-300">Número padrão</span>
              <Input
                placeholder="+5516999999999"
                value={config.default_number || ''}
                onChange={(event) => setConfig({ ...config, default_number: event.target.value })}
              />
            </label>
            <label className="space-y-2">
              <span className="text-sm text-slate-300">Limite diário por número</span>
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
              <Save size={16} /> Salvar configuração
            </Button>
            <Button variant="secondary" onClick={() => runAction('test')} disabled={Boolean(busy)}>
              <CheckCircle2 size={16} /> Testar conexão
            </Button>
            <Button variant="secondary" onClick={() => runAction('connect')} disabled={Boolean(busy)}>
              <PlugZap size={16} /> Conectar
            </Button>
            <Button variant="secondary" onClick={() => runAction('reconnect')} disabled={Boolean(busy)}>
              <RefreshCcw size={16} /> Reconectar
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
                <h3 className="text-lg font-bold text-white">Status da conexão</h3>
                <p className="text-sm text-slate-400">Último teste: {dateTime(config.last_test_at)}</p>
              </div>
            </div>
            <div className="mt-5 rounded-2xl border border-border bg-bg/70 p-4">
              <p className="text-sm text-slate-400">Estado atual</p>
              <p className="mt-1 text-xl font-bold text-white">{statusLabels[currentStatus] || currentStatus}</p>
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
                {qrcode.startsWith('data:image') ? <img src={qrcode} alt="QR Code WhatsApp" className="mx-auto max-h-64" /> : <p className="break-all text-xs text-slate-800">{qrcode}</p>}
              </div>
            ) : (
              <div className="mt-4 rounded-2xl border border-dashed border-border p-6 text-center text-sm text-slate-400">
                QR Code aparecerá aqui quando o provedor não oficial retornar a conexão por WhatsApp Web.
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card className="p-6">
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h3 className="text-lg font-bold text-white">Envio manual</h3>
            <p className="text-sm text-slate-400">Envio controlado. O backend bloqueia clientes sem interesse, bloqueados ou sem telefone válido.</p>
          </div>
          <Badge tone="info">Sem disparo em massa</Badge>
        </div>
        <div className="grid gap-4 lg:grid-cols-[.4fr_.6fr]">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
            <Input placeholder="ID do cliente opcional" value={sendForm.client_id} onChange={(event) => setSendForm({ ...sendForm, client_id: event.target.value })} />
            <Input placeholder="Telefone com DDD" value={sendForm.phone} onChange={(event) => setSendForm({ ...sendForm, phone: event.target.value })} />
            <Select
              value={sendForm.template_id}
              onChange={(event) => setSendForm({ ...sendForm, template_id: event.target.value, message: templates.find((template) => String(template.id) === event.target.value)?.body || sendForm.message })}
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
            <Button onClick={sendManualMessage} disabled={busy === 'send' || !sendForm.message.trim() || (!sendForm.phone.trim() && !sendForm.client_id.trim())}>
              <Send size={16} /> Enviar mensagem
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-white">Histórico de envios e webhooks</h3>
            <p className="text-sm text-slate-400">Mensagens enviadas, recebidas e falhas registradas pelo CRM.</p>
          </div>
          {loading ? <Badge>Carregando</Badge> : <Badge tone="accent">{messages.length} registros</Badge>}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="text-left text-xs uppercase tracking-[0.18em] text-slate-500">
              <tr>
                <th className="py-3 pr-4">Data</th>
                <th className="py-3 pr-4">Cliente</th>
                <th className="py-3 pr-4">Telefone</th>
                <th className="py-3 pr-4">Direção</th>
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

      <Card className="border-amber-400/20 bg-amber-400/5 p-5">
        <div className="flex gap-3">
          <AlertTriangle className="mt-1 text-amber-300" size={20} />
          <p className="text-sm text-amber-100">
            API não oficial deve ser usada apenas para atendimento manual/controlado. Não há disparo em massa nesta implementação, e mensagens para clientes bloqueados ou sem interesse são barradas no backend.
          </p>
        </div>
      </Card>
    </div>
  );
}
