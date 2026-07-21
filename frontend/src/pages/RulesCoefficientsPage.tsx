import { useEffect, useState } from 'react';
import { Calculator, Save, ShieldCheck } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import type { Settings } from '../types';
import { Badge, Button, Card, Input, SectionHeader } from '../components/ui';

const emptySettings: Settings = {
  company_name: 'Reliance CRM',
  attendant_name: '',
  whatsapp_message: '',
  allow_column_editing: 'true',
  daily_limit: '50',
  theme: 'dark',
  expected_columns: '',
  ribeirao_consignado_coefficient: '',
  ribeirao_consignado_rate: '',
  ribeirao_cartao_coefficient: '',
  ribeirao_cartao_rate: '',
};

export default function RulesCoefficientsPage() {
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        setLoading(true);
        const response = await api.getSettings();
        if (!active) return;
        setSettings((current) => ({ ...current, ...response.settings }));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar regras e coeficientes.');
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

  async function handleSave() {
    try {
      setSaving(true);
      const response = await api.saveSettings({
        ribeirao_consignado_coefficient: settings.ribeirao_consignado_coefficient || '',
        ribeirao_consignado_rate: settings.ribeirao_consignado_rate || '',
        ribeirao_cartao_coefficient: settings.ribeirao_cartao_coefficient || '',
        ribeirao_cartao_rate: settings.ribeirao_cartao_rate || '',
      });
      setSettings((current) => ({ ...current, ...response.settings }));
      toast.success('Coeficientes salvos.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar coeficientes.');
    } finally {
      setSaving(false);
    }
  }

  function updateField(field: keyof Settings, value: string) {
    setSettings((current) => ({ ...current, [field]: value }));
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Regras & Coeficientes"
        description="Cadastre os coeficientes usados na etapa de cálculo sem alterar a consulta de margem."
        action={
          <Badge tone="accent">
            <ShieldCheck size={14} className="mr-2" />
            Uso interno
          </Badge>
        }
      />

      {loading ? (
        <Card className="p-8 text-sm text-slate-400">Carregando regras...</Card>
      ) : (
        <Card className="p-6">
          <div className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-accent">Prefeitura</p>
              <h3 className="mt-2 text-2xl font-bold text-white">Prefeitura de Ribeirão Preto</h3>
              <p className="mt-2 max-w-3xl text-sm text-slate-400">
                Preencha Consignado e Cartão separadamente. Quando a automação encontrar margem, o cálculo usa o produto correto e fica pendente se algum coeficiente ainda não estiver cadastrado.
              </p>
            </div>
            <Button onClick={() => void handleSave()} disabled={saving}>
              <Save size={16} />
              {saving ? 'Salvando...' : 'Salvar coeficientes'}
            </Button>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <ProductCoefficientCard
              title="Consignado"
              coefficient={settings.ribeirao_consignado_coefficient || ''}
              rate={settings.ribeirao_consignado_rate || ''}
              onCoefficientChange={(value) => updateField('ribeirao_consignado_coefficient', value)}
              onRateChange={(value) => updateField('ribeirao_consignado_rate', value)}
            />
            <ProductCoefficientCard
              title="Cartão"
              coefficient={settings.ribeirao_cartao_coefficient || ''}
              rate={settings.ribeirao_cartao_rate || ''}
              onCoefficientChange={(value) => updateField('ribeirao_cartao_coefficient', value)}
              onRateChange={(value) => updateField('ribeirao_cartao_rate', value)}
            />
          </div>
        </Card>
      )}
    </div>
  );
}

function ProductCoefficientCard({
  title,
  coefficient,
  rate,
  onCoefficientChange,
  onRateChange,
}: {
  title: string;
  coefficient: string;
  rate: string;
  onCoefficientChange: (value: string) => void;
  onRateChange: (value: string) => void;
}) {
  return (
    <div className="rounded-3xl border border-border bg-bg/60 p-5">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/15 text-accent">
          <Calculator size={18} />
        </div>
        <div>
          <h4 className="font-semibold text-white">{title}</h4>
          <p className="text-xs text-slate-500">Coeficiente e taxa do produto</p>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm text-slate-300">
          Coeficiente
          <Input className="mt-2" value={coefficient} onChange={(event) => onCoefficientChange(event.target.value)} placeholder="Ex.: 0,0420" inputMode="decimal" />
        </label>
        <label className="block text-sm text-slate-300">
          Taxa
          <Input className="mt-2" value={rate} onChange={(event) => onRateChange(event.target.value)} placeholder="Ex.: 1,79%" inputMode="decimal" />
        </label>
      </div>
    </div>
  );
}
