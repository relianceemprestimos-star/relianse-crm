import { useEffect, useMemo, useState } from 'react';
import { Bot, KeyRound, Save, ShieldCheck, WalletCards } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import type { CaptchaEngineConfig, CaptchaPortalRule } from '../types';
import { Badge, Button, Card, Input, SectionHeader, Select } from '../components/ui';

const emptyRule: CaptchaPortalRule = {
  ocrEnabled: false,
  externalEnabled: false,
  fallbackManual: true,
  batchLimit: 20,
  dailyLimit: 100,
  pauseAfterFailures: 3,
};

export default function CaptchaEnginePage() {
  const [config, setConfig] = useState<CaptchaEngineConfig | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        setLoading(true);
        const response = await api.getCaptchaEngineConfig();
        if (active) setConfig(response.config);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar Motor de CAPTCHA.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, []);

  const statusTone = config?.enabled ? 'success' : 'danger';
  const keyStatus = useMemo(() => (config?.capsolverApiKeyConfigured ? config.capsolverApiKeyMasked : 'Não configurada'), [config]);

  function update<K extends keyof CaptchaEngineConfig>(key: K, value: CaptchaEngineConfig[K]) {
    setConfig((current) => (current ? { ...current, [key]: value } : current));
  }

  function updateRule(portalId: string, patch: Partial<CaptchaPortalRule>) {
    setConfig((current) => {
      if (!current) return current;
      const currentRule = current.portalRules?.[portalId] || emptyRule;
      const portalRules = {
        ...current.portalRules,
        [portalId]: { ...currentRule, ...patch },
      };
      return {
        ...current,
        portalRules,
        portals: current.portals.map((portal) => (portal.id === portalId ? { ...portal, rules: portalRules[portalId] } : portal)),
      };
    });
  }

  async function save() {
    if (!config) return;
    try {
      setSaving(true);
      const response = await api.saveCaptchaEngineConfig({ ...config, capsolverApiKey: apiKey || undefined });
      setConfig(response.config);
      setApiKey('');
      toast.success('Motor de CAPTCHA salvo.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar Motor de CAPTCHA.');
    } finally {
      setSaving(false);
    }
  }

  async function testProvider() {
    try {
      setTesting(true);
      const result = await api.testCaptchaProvider();
      if (result.ok) toast.success('Provider externo respondeu.');
      else toast.error(result.message || 'Provider externo indisponível.');
      const response = await api.getCaptchaEngineConfig();
      setConfig(response.config);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao testar provider.');
    } finally {
      setTesting(false);
    }
  }

  async function checkBalance() {
    try {
      const result = await api.getCaptchaBalance();
      if (!result.ok) {
        toast.error(result.message || 'Saldo indisponível.');
        return;
      }
      toast.success(`Saldo consultado: ${JSON.stringify(result.balance || {})}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao consultar saldo.');
    }
  }

  if (loading || !config) {
    return <Card className="p-8 text-sm text-slate-400">Carregando Motor de CAPTCHA...</Card>;
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Motor de CAPTCHA"
        description="Gerencie OCR interno, provider externo opcional e fallback manual para os portais de margem."
        action={<Badge tone={statusTone}>{config.enabled ? 'Ativo' : 'Inativo'}</Badge>}
      />

      <div className="grid gap-4 xl:grid-cols-4">
        <Card className="p-5">
          <p className="text-sm text-slate-400">Motor</p>
          <p className="mt-2 text-2xl font-bold text-white">{config.enabled ? 'Ativo' : 'Inativo'}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-slate-400">OCR interno</p>
          <p className="mt-2 text-2xl font-bold text-white">{config.internalOcrEnabled ? 'Ligado' : 'Desligado'}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-slate-400">Provider externo</p>
          <p className="mt-2 text-2xl font-bold text-white">{config.externalProviderEnabled ? 'Ligado' : 'Desligado'}</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-slate-400">API Key</p>
          <p className="mt-2 text-lg font-bold text-white">{keyStatus}</p>
        </Card>
      </div>

      <Card className="p-6">
        <div className="grid gap-4 lg:grid-cols-3">
          <label className="text-sm text-slate-300">
            Ativar Motor
            <Select className="mt-2" value={String(config.enabled)} onChange={(event) => update('enabled', event.target.value === 'true')}>
              <option value="true">Sim</option>
              <option value="false">Não</option>
            </Select>
          </label>
          <label className="text-sm text-slate-300">
            Modo padrão
            <Select className="mt-2" value={config.defaultMode} onChange={(event) => update('defaultMode', event.target.value)}>
              <option value="manual">Manual</option>
              <option value="internal_ocr">OCR interno</option>
              <option value="external">Provider externo</option>
              <option value="hybrid">Híbrido</option>
            </Select>
          </label>
          <label className="text-sm text-slate-300">
            Ativar OCR interno
            <Select className="mt-2" value={String(config.internalOcrEnabled)} onChange={(event) => update('internalOcrEnabled', event.target.value === 'true')}>
              <option value="true">Sim</option>
              <option value="false">Não</option>
            </Select>
          </label>
          <label className="text-sm text-slate-300">
            Confiança mínima OCR
            <Input className="mt-2" type="number" step="0.01" min="0" max="1" value={config.internalOcrMinConfidence} onChange={(event) => update('internalOcrMinConfidence', Number(event.target.value))} />
          </label>
          <label className="text-sm text-slate-300">
            Provider padrão
            <Select className="mt-2" value={config.externalProvider} onChange={(event) => update('externalProvider', event.target.value)}>
              <option value="none">Nenhum</option>
              <option value="capsolver">CapSolver</option>
            </Select>
          </label>
          <label className="text-sm text-slate-300">
            Ativar provider externo
            <Select className="mt-2" value={String(config.externalProviderEnabled)} onChange={(event) => update('externalProviderEnabled', event.target.value === 'true')}>
              <option value="true">Sim</option>
              <option value="false">Não</option>
            </Select>
          </label>
          <label className="text-sm text-slate-300">
            Ativar CapSolver
            <Select className="mt-2" value={String(config.capsolverEnabled)} onChange={(event) => update('capsolverEnabled', event.target.value === 'true')}>
              <option value="true">Sim</option>
              <option value="false">Não</option>
            </Select>
          </label>
          <label className="text-sm text-slate-300">
            API Key CapSolver
            <Input className="mt-2" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config.capsolverApiKeyMasked || 'CAP-...'} />
          </label>
          <label className="text-sm text-slate-300">
            Limite diário externo
            <Input className="mt-2" type="number" value={config.dailyLimit} onChange={(event) => update('dailyLimit', Number(event.target.value))} />
          </label>
          <label className="text-sm text-slate-300">
            Limite por lote
            <Input className="mt-2" type="number" value={config.batchLimit} onChange={(event) => update('batchLimit', Number(event.target.value))} />
          </label>
          <label className="text-sm text-slate-300">
            Timeout provider ms
            <Input className="mt-2" type="number" value={config.timeoutMs} onChange={(event) => update('timeoutMs', Number(event.target.value))} />
          </label>
          <label className="text-sm text-slate-300">
            Polling ms
            <Input className="mt-2" type="number" value={config.pollIntervalMs} onChange={(event) => update('pollIntervalMs', Number(event.target.value))} />
          </label>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button onClick={() => void save()} disabled={saving}>
            <Save size={16} />
            {saving ? 'Salvando...' : 'Salvar configurações'}
          </Button>
          <Button variant="secondary" onClick={() => void testProvider()} disabled={testing}>
            <ShieldCheck size={16} />
            {testing ? 'Testando...' : 'Testar CapSolver'}
          </Button>
          <Button variant="secondary" onClick={() => void checkBalance()}>
            <WalletCards size={16} />
            Consultar saldo CapSolver
          </Button>
        </div>
        {config.lastError ? <p className="mt-4 text-sm text-amber-200">{config.lastError}</p> : null}
      </Card>

      <Card className="p-6">
        <div className="mb-4 flex items-center gap-2">
          <Bot size={18} className="text-accent" />
          <h3 className="text-lg font-semibold text-white">Portais habilitados</h3>
        </div>
        <div className="grid gap-4">
          {config.portals.map((portal) => (
            <div key={portal.id} className="grid gap-3 rounded-2xl border border-border bg-bg/50 p-4 lg:grid-cols-[1.2fr_repeat(5,0.8fr)]">
              <div>
                <p className="font-semibold text-white">{portal.label}</p>
                <p className="text-xs text-slate-500">{portal.id}</p>
              </div>
              <Toggle label="OCR" value={portal.rules?.ocrEnabled} onChange={(value) => updateRule(portal.id, { ocrEnabled: value })} />
              <Toggle label="Provider" value={portal.rules?.externalEnabled} onChange={(value) => updateRule(portal.id, { externalEnabled: value })} />
              <Toggle label="Fallback" value={portal.rules?.fallbackManual} onChange={(value) => updateRule(portal.id, { fallbackManual: value })} />
              <Input type="number" value={portal.rules?.batchLimit ?? 20} onChange={(event) => updateRule(portal.id, { batchLimit: Number(event.target.value) })} />
              <Input type="number" value={portal.rules?.pauseAfterFailures ?? 3} onChange={(event) => updateRule(portal.id, { pauseAfterFailures: Number(event.target.value) })} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value?: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="text-sm text-slate-300">
      {label}
      <Select className="mt-2" value={String(Boolean(value))} onChange={(event) => onChange(event.target.value === 'true')}>
        <option value="true">Sim</option>
        <option value="false">Não</option>
      </Select>
    </label>
  );
}
