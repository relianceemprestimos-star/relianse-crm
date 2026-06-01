import { useEffect, useState } from 'react';
import { Check, Clock, Save, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';

import { Badge, Button, Card, Input, SectionHeader } from '../components/ui';
import { api } from '../lib/api';
import type { BankCoefficient } from '../types';

export default function CampaignCoefficientPage() {
  const [bankRows, setBankRows] = useState<BankCoefficient[]>([]);
  const [bankSummary, setBankSummary] = useState({ data: new Date().toISOString().slice(0, 10), ativos: 0, aguardando: 0 });
  const [savingKey, setSavingKey] = useState('');

  useEffect(() => {
    let active = true;
    api
      .getBankCoefficientsToday()
      .then((response) => {
        if (!active) return;
        setBankRows(response.bancos || []);
        setBankSummary({ data: response.data, ativos: response.ativos, aguardando: response.aguardando });
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : 'Falha ao carregar coeficiente.'));
    return () => {
      active = false;
    };
  }, []);

  function updateBankRow(index: number, patch: Partial<BankCoefficient>) {
    setBankRows((current) => current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  }

  function decimalValue(value: unknown) {
    return Number(String(value ?? '').replace(',', '.'));
  }

  async function saveBank(row: BankCoefficient) {
    const coefficientValue = decimalValue(row.coeficiente);
    const taxValue = row.taxa === null || row.taxa === undefined || row.taxa === '' ? null : decimalValue(row.taxa);
    const termValue = Number(row.prazo);
    if (!Number.isFinite(coefficientValue) || coefficientValue <= 0 || !Number.isFinite(termValue) || termValue <= 0) {
      toast.error('Informe coeficiente e prazo válidos para este banco.');
      return;
    }
    if (taxValue !== null && (!Number.isFinite(taxValue) || taxValue < 0)) {
      toast.error('Informe uma taxa válida para este banco.');
      return;
    }

    try {
      setSavingKey(`${row.convenio}:${row.banco}:${row.produto}`);
      const saved = await api.saveBankCoefficient({
        convenio: row.convenio,
        banco: row.banco,
        banco_label: row.banco_label,
        produto: row.produto || 'consignado',
        coeficiente: coefficientValue,
        taxa: taxValue,
        prazo: termValue,
        primeiro_vencimento_dias: row.primeiro_vencimento_dias ?? null,
        status: row.status === 'inativo' ? 'inativo' : 'ativo',
      });
      setBankRows(saved.bancos || []);
      setBankSummary({ data: saved.data, ativos: saved.ativos, aguardando: saved.aguardando });
      toast.success(`Coeficiente salvo para ${row.banco_label || row.banco}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar coeficiente do banco.');
    } finally {
      setSavingKey('');
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Regras & Coeficientes"
        description="O sistema aplica regras reais por convênio, banco, idade e referência de contrato."
      />

      <Card className="p-5">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-white">Coeficientes e taxas por banco</h3>
            <p className="text-sm text-slate-400">Preencha por banco. O que não estiver cadastrado fica aguardando e não entra na seleção de disparo.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={bankSummary.ativos ? 'success' : 'danger'}>
              {bankSummary.ativos ? `${bankSummary.ativos} ativos` : 'Pendente'}
            </Badge>
            <span className="text-sm text-slate-400">Data: {bankSummary.data}</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-border text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2">Convênio</th>
                <th className="px-3 py-2">Banco</th>
                <th className="px-3 py-2">Produto</th>
                <th className="px-3 py-2">Coeficiente</th>
                <th className="px-3 py-2">Taxa</th>
                <th className="px-3 py-2">Prazo</th>
                <th className="px-3 py-2">1º venc.</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {bankRows.map((row, index) => {
                const key = `${row.convenio}:${row.banco}:${row.produto}`;
                return (
                  <tr key={key} className="text-slate-300">
                    <td className="px-3 py-3">{row.convenio === 'gov_sp' ? 'Governo de SP' : 'Prefeitura'}</td>
                    <td className="px-3 py-3 font-semibold text-white">{row.banco_label}</td>
                    <td className="px-3 py-3">{row.produto}</td>
                    <td className="px-3 py-3">
                      <Input
                        inputMode="decimal"
                        value={row.coeficiente ?? ''}
                        onChange={(event) => updateBankRow(index, { coeficiente: event.target.value as unknown as number })}
                        placeholder="Ex: 0,02516"
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Input
                        inputMode="decimal"
                        value={row.taxa ?? ''}
                        onChange={(event) => updateBankRow(index, { taxa: event.target.value as unknown as number })}
                        placeholder="Ex: 1,72"
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Input
                        inputMode="numeric"
                        value={row.prazo ?? ''}
                        onChange={(event) => updateBankRow(index, { prazo: event.target.value as unknown as number })}
                        placeholder="84"
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Input
                        inputMode="numeric"
                        value={row.primeiro_vencimento_dias ?? ''}
                        onChange={(event) => updateBankRow(index, { primeiro_vencimento_dias: event.target.value as unknown as number })}
                        placeholder="45"
                      />
                    </td>
                    <td className="px-3 py-3">
                      <select
                        className="w-full rounded-2xl border border-border bg-bg/80 px-3 py-3 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/10"
                        value={row.status === 'inativo' ? 'inativo' : 'ativo'}
                        onChange={(event) => updateBankRow(index, { status: event.target.value })}
                      >
                        <option value="ativo">Ativo</option>
                        <option value="inativo">Inativo</option>
                      </select>
                    </td>
                    <td className="px-3 py-3">
                      <Button className="w-full" onClick={() => void saveBank(row)} disabled={savingKey === key}>
                        <Save size={16} />
                        Salvar
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
	        <RuleCard
	          title="Prefeitura"
	          products={['Futuro Previdência', 'BIB']}
	          rules={[
	            ['Futuro Previdência: mulher até 52 anos e 11 meses', 'validar pela data inicial', 'ok'],
	            ['Futuro Previdência: homem até 56 anos e 11 meses', 'validar pela data inicial', 'ok'],
	            ['BIB: mulher até 60 anos e homem até 65 anos no fim do contrato', 'somente consignado', 'info'],
	            ['Futuro: cartão enquanto houver margem; BIB: até 48x', 'coeficiente diário obrigatório', 'warn'],
	          ]}
	          columns={['Banco', 'Produto', 'Prazo', 'Mulher', 'Homem', 'Referência']}
	          rows={[
	            ['Futuro Previdência', 'Consignado', '120x', 'até 52a 11m', 'até 56a 11m', 'Data inicial'],
	            ['Futuro Previdência', 'Cartão consignado', '96x', 'até 52a 11m', 'até 56a 11m', 'Data inicial'],
	            ['BIB', 'Consignado', 'até 48x', 'fim contrato até 60a', 'fim contrato até 65a', 'Data final'],
	          ]}
	        />
	        <RuleCard
	          title="Governo de SP"
	          products={['Daycoval', 'BMG', 'Santander', 'Banco do Brasil', 'Amigoz']}
	          rules={[
	            ['Fim do contrato até 79 anos e 11 meses', 'regra geral de idade do governo', 'ok'],
	            ['Até 70 anos: Daycoval/BMG; acima de 70: Santander/Banco do Brasil', 'seleção por idade', 'info'],
	            ['Cartão com margem bruta diferente da líquida', 'vai para atendimento manual', 'danger'],
	          ]}
	          columns={['Banco', 'Produto', 'Prazo', 'Regra de idade', 'Referência', 'Status']}
	          rows={[
	            ['Daycoval / BMG', 'Consignado', '96x', 'até 70 anos', 'Fim contrato até 79a 11m', 'Ativo'],
	            ['Santander / Banco do Brasil', 'Consignado', '96x', 'acima de 70 anos', 'Fim contrato até 79a 11m', 'Ativo'],
	            ['Amigoz', 'Cartão consignado / benefício', '96x', 'regra governo', 'Saque 70%', 'Ativo'],
	            ['Daycoval (TJSP)', 'Cartões', '96x', 'exceção TJSP', 'Taxa referência 4,10', 'Ativo'],
	          ]}
	        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
        <Card className="p-5">
          <h3 className="text-lg font-bold text-white">Validações automáticas</h3>
          <p className="mt-1 text-sm text-slate-400">Status retornados pelo motor de regras.</p>
          <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <Validation label="IDADE_OK" detail="Idade dentro da faixa permitida" tone="success" />
            <Validation label="IDADE_FORA_REGRA" detail="Idade fora da faixa permitida" tone="warning" />
            <Validation label="SEM_COEFICIENTE_ATIVO" detail="Não há coeficiente ativo" tone="danger" />
            <Validation label="SEM_OPORTUNIDADE" detail="Nenhuma oferta elegível" tone="neutral" />
            <Validation label="PRONTO_PARA_SIMULAÇÃO" detail="Regras válidas para simulação" tone="info" />
          </div>
        </Card>
        <Card className="p-5">
          <h3 className="text-lg font-bold text-white">Regra ativa por campanha</h3>
          <div className="mt-4 space-y-3 text-sm">
            <Line label="Campanha" value="Campanha Maio/2025" />
            <Line label="Convênios" value="Prefeitura / Governo de SP" />
	            <Line label="Bancos Prefeitura" value="Futuro Previdência / BIB" />
	            <Line label="Bancos Governo de SP" value="Daycoval / BMG / Santander / Banco do Brasil / Amigoz" />
	            <Line label="Prazos" value="GOV 96x; Futuro 120x/96x; BIB 48x" />
            <Line label="Status" value={bankSummary.ativos ? `${bankSummary.ativos} bancos atualizados` : 'Pendente'} />
          </div>
        </Card>
      </div>
    </div>
  );
}

function RuleCard({
  title,
  products,
  rules,
  columns,
  rows,
}: {
  title: string;
  products: string[];
  rules: Array<[string, string, 'ok' | 'info' | 'danger' | 'warn']>;
  columns?: string[];
  rows: string[][];
}) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border p-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xl font-bold text-white">{title}</h3>
          <Badge tone="success">Ativo</Badge>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {products.map((product) => (
            <Badge key={product} tone="info">{product}</Badge>
          ))}
        </div>
      </div>
      <div className="p-5">
        <p className="mb-3 text-sm font-semibold text-white">Regras de negócio</p>
        <div className="space-y-2">
          {rules.map(([condition, result, tone]) => (
            <div key={condition} className="grid gap-3 rounded-xl border border-border bg-bg/55 p-3 text-sm md:grid-cols-[1fr_30px_1fr] md:items-center">
              <StatusIcon tone={tone} />
              <span className="text-slate-300">{condition}</span>
              <span className={tone === 'danger' ? 'font-semibold text-red-300' : 'text-slate-200'}>{result}</span>
            </div>
          ))}
        </div>

        <p className="mb-3 mt-5 text-sm font-semibold text-white">Coeficientes do dia</p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-border text-xs text-slate-500">
              <tr>
                {(columns || ['Banco', 'Produto', 'Prazo', 'Coeficiente', '1º vencimento', 'Idade máx.']).map((head) => (
                  <th key={head} className="px-3 py-2">{head}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {rows.map((row) => (
                <tr key={row.join('-')} className="text-slate-300">
                  {row.map((cell, index) => <td key={`${cell}-${index}`} className="px-3 py-2">{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

function StatusIcon({ tone }: { tone: 'ok' | 'info' | 'danger' | 'warn' }) {
  if (tone === 'danger') return <XCircle size={18} className="text-red-400 md:order-first" />;
  if (tone === 'warn') return <Clock size={18} className="text-amber-400 md:order-first" />;
  if (tone === 'info') return <Clock size={18} className="text-blue-400 md:order-first" />;
  return <Check size={18} className="text-emerald-400 md:order-first" />;
}

function Validation({ label, detail, tone }: { label: string; detail: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }) {
  const colors = {
    success: 'text-emerald-300 bg-emerald-500/15',
    warning: 'text-amber-300 bg-amber-500/15',
    danger: 'text-red-300 bg-red-500/15',
    neutral: 'text-violet-300 bg-violet-500/15',
    info: 'text-blue-300 bg-blue-500/15',
  };
  return (
    <div className="rounded-2xl border border-border bg-bg/55 p-4">
      <div className={`mb-3 inline-flex rounded-full px-3 py-1 text-xs font-semibold ${colors[tone]}`}>{label}</div>
      <p className="text-sm text-slate-300">{detail}</p>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/70 pb-2">
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold text-white">{value}</span>
    </div>
  );
}
