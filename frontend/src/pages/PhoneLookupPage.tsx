import { useEffect, useMemo, useState } from 'react';
import { Copy, RotateCcw, Save, Search } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import type { Client, ClientAddress, PhoneLookupHistoryItem } from '../types';
import { Badge, Button, Card, Input, SectionHeader } from '../components/ui';

type ResultPhone = {
  number?: string;
  phone_number?: string;
  normalized?: string;
  normalized_phone?: string;
  type?: string;
  phone_type?: string;
  quality?: string;
  label?: string;
  raw_label?: string;
};

type ResultEmail = string | { email?: string; is_primary?: boolean };

type LookupResult = {
  status: string;
  source: string;
  origin?: string;
  cache_hit?: boolean;
  consultation_id?: number | null;
  client_id?: number | null;
  cpf: string;
  name: string;
  full_name?: string;
  birth_date?: string;
  age?: number | null;
  gender?: string;
  mother_name?: string;
  father_name?: string;
  email?: string;
  emails?: ResultEmail[];
  addresses?: ClientAddress[];
  raw_data?: Record<string, unknown>;
  phones: ResultPhone[];
  message?: string;
  code?: string;
  consulted_at?: string;
  expires_at?: string;
};

const statusLabels: Record<string, string> = {
  success: 'Sucesso',
  failed: 'Falha',
  requires_manual_login: 'Requer login manual',
  expired: 'Expirada',
};

function statusTone(status: string): 'neutral' | 'accent' | 'success' | 'danger' | 'info' {
  if (status === 'success') return 'success';
  if (status === 'failed' || status === 'requires_manual_login') return 'danger';
  return 'neutral';
}

function statusLabel(status: string) {
  return statusLabels[status] || status || '-';
}

function emailValue(item: ResultEmail) {
  return typeof item === 'string' ? item : item?.email || '';
}

function phoneValue(phone: ResultPhone) {
  return phone.normalized || phone.normalized_phone || phone.phone_number || phone.number || '';
}

function phoneType(phone: ResultPhone) {
  return phone.type || phone.phone_type || '';
}

function normalizeConsultation(item: any): LookupResult {
  const emails = Array.isArray(item.emails) ? item.emails : [];
  return {
    status: item.status || 'failed',
    source: item.source || item.origin || 'Consulta salva',
    origin: item.origin || item.source || 'Consulta salva',
    cache_hit: item.cache_hit ?? true,
    consultation_id: item.consultation_id || item.id || null,
    client_id: item.client_id ?? null,
    cpf: item.cpf || '',
    name: item.name || item.nome || item.full_name || '',
    full_name: item.full_name || item.name || item.nome || '',
    birth_date: item.birth_date || '',
    age: item.age ?? null,
    gender: item.gender || '',
    mother_name: item.mother_name || '',
    father_name: item.father_name || '',
    email: item.email || emailValue(emails[0]) || '',
    emails,
    addresses: Array.isArray(item.addresses) ? item.addresses : [],
    raw_data: item.raw_data || {},
    phones: Array.isArray(item.phones) ? item.phones : [],
    message: item.message || item.error_message || '',
    code: item.code || '',
    consulted_at: item.consulted_at || item.created_at || '',
    expires_at: item.expires_at || '',
  };
}

export default function PhoneLookupPage() {
  const [cpf, setCpf] = useState('');
  const [name, setName] = useState('');
  const [clientSearch, setClientSearch] = useState('');
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [clientOptions, setClientOptions] = useState<Client[]>([]);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [history, setHistory] = useState<PhoneLookupHistoryItem[]>([]);
  const [historyFilter, setHistoryFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadHistory();
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      if (!clientSearch.trim()) {
        setClientOptions([]);
        return;
      }
      try {
        const response = await api.getClients({ search: clientSearch, include_archived: '1' });
        if (!active) return;
        setClientOptions(response.clients.slice(0, 8));
      } catch {
        if (active) setClientOptions([]);
      }
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [clientSearch]);

  const resultPhones = useMemo(() => result?.phones || [], [result]);
  const resultAddresses = useMemo(() => result?.addresses || [], [result]);
  const resultEmails = useMemo(() => {
    const emails = result?.emails || [];
    const values = emails.map(emailValue).filter(Boolean);
    if (result?.email && !values.includes(result.email)) values.unshift(result.email);
    return values;
  }, [result]);
  const filteredHistory = useMemo(() => {
    const term = historyFilter.trim().toLowerCase();
    if (!term) return history;
    return history.filter((item) => {
      const text = [
        item.client_name,
        item.name,
        item.nome,
        item.full_name,
        item.cpf,
        item.telefone_pesquisado,
        item.status,
        item.source,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return text.includes(term);
    });
  }, [history, historyFilter]);

  async function loadHistory() {
    const response = await api.getPhoneLookupHistory({ limit: 80 });
    setHistory(response.rows || []);
  }

  function chooseClient(client: Client) {
    setSelectedClient(client);
    setClientSearch(client.name);
    setCpf(client.cpf || '');
    setName(client.name || '');
    setClientOptions([]);
  }

  function clearFields() {
    setCpf('');
    setName('');
    setClientSearch('');
    setSelectedClient(null);
    setClientOptions([]);
    setResult(null);
  }

  async function handleSearch() {
    try {
      setLoading(true);
      const response = await api.searchPhones({
        cpf,
        name,
        phone: clientSearch,
        client_id: selectedClient?.id || null,
      });
      const normalized = normalizeConsultation(response);
      setResult(normalized);
      if (normalized.cache_hit) {
        toast.success('Consulta carregada do histórico salvo.');
      } else if (normalized.status === 'success') {
        toast.success('Consulta realizada e salva.');
      } else if (normalized.status === 'requires_manual_login') {
        toast.error('A fonte solicitou login manual ou validacao.');
      } else {
        toast.error(normalized.message || 'Consulta nao concluida.');
      }
      await loadHistory();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao consultar.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveCurrent() {
    if (!result?.consultation_id) {
      toast.error('Nenhuma consulta atual para salvar.');
      return;
    }
    try {
      setSaving(true);
      const response = await api.saveCurrentPhoneLookup({
        consultation_id: result.consultation_id,
        client_id: selectedClient?.id || result.client_id || null,
      });
      setResult(normalizeConsultation(response.consultation));
      await loadHistory();
      toast.success(selectedClient ? 'Consulta vinculada ao cliente.' : 'Consulta mantida no historico.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar consulta.');
    } finally {
      setSaving(false);
    }
  }

  async function openDetails(item: PhoneLookupHistoryItem) {
    try {
      const response = await api.getPhoneLookupConsultation(item.id);
      const normalized = normalizeConsultation(response.consultation);
      setResult(normalized);
      setCpf(normalized.cpf || '');
      setName(normalized.full_name || normalized.name || '');
      setClientSearch(response.consultation.client_name || normalized.full_name || normalized.name || '');
      toast.success('Consulta reaberta.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao abrir detalhes.');
    }
  }

  async function copyPhone(phone: ResultPhone) {
    const value = phoneValue(phone);
    if (!value) return;
    await navigator.clipboard?.writeText(value);
    toast.success('Telefone copiado.');
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Consulta telefone"
        description="Pesquise informacoes de clientes e visualize telefones, enderecos e e-mails vinculados."
      />

      <Card className="p-6">
        <div className="grid gap-4 lg:grid-cols-[1.35fr_0.8fr_0.9fr]">
          <label className="relative block text-sm text-slate-300">
            Cliente do CRM
            <Input
              className="mt-2"
              value={clientSearch}
              onChange={(event) => setClientSearch(event.target.value)}
              placeholder="Digite o nome, CPF ou telefone do cliente"
            />
            {clientOptions.length ? (
              <div className="absolute z-20 mt-2 max-h-72 w-full overflow-auto rounded-2xl border border-border bg-bg/95 p-2 shadow-2xl">
                {clientOptions.map((client) => (
                  <button
                    key={client.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-4 rounded-xl px-3 py-2 text-left text-sm text-slate-300 hover:bg-white/5"
                    onClick={() => chooseClient(client)}
                  >
                    <span className="font-semibold text-white">{client.name}</span>
                    <span className="text-xs text-slate-500">{client.cpf || client.phone || '-'}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </label>

          <label className="block text-sm text-slate-300">
            CPF
            <Input className="mt-2" value={cpf} onChange={(event) => setCpf(event.target.value)} placeholder="Digite o CPF" />
          </label>

          <label className="block text-sm text-slate-300">
            Nome
            <Input className="mt-2" value={name} onChange={(event) => setName(event.target.value)} placeholder="Digite o nome do cliente" />
          </label>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={() => void handleSearch()} disabled={loading}>
            <Search size={16} />
            {loading ? 'Buscando...' : 'Buscar'}
          </Button>
          <Button variant="secondary" onClick={clearFields}>
            <RotateCcw size={16} />
            Limpar campos
          </Button>
          <Button variant="secondary" onClick={() => void handleSaveCurrent()} disabled={saving || !result?.consultation_id}>
            <Save size={16} />
            {saving ? 'Salvando...' : 'Salvar busca atual'}
          </Button>
          {selectedClient ? <Badge tone="accent">Cliente selecionado: {selectedClient.name}</Badge> : null}
          {result?.cache_hit ? <Badge tone="success">Carregado do CRM</Badge> : null}
        </div>
      </Card>

      <div className="grid gap-5 xl:grid-cols-2">
        <Card className="p-6">
          <CardTitle title="Dados pessoais" />
          {result ? (
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <Info label="Nome" value={result.full_name || result.name || '-'} />
              <Info label="CPF" value={result.cpf || '-'} />
              <Info label="Nascimento" value={result.birth_date || '-'} />
              <Info label="Idade" value={result.age === null || result.age === undefined ? '-' : String(result.age)} />
              <Info label="Sexo" value={result.gender || '-'} />
              <Info label="Nome da mae" value={result.mother_name || '-'} />
              <Info label="Nome do pai" value={result.father_name || '-'} />
              <Info label="Origem" value={result.origin || result.source || '-'} />
            </div>
          ) : (
            <EmptyState text="Os dados pessoais da consulta aparecem aqui." />
          )}
          {result?.message ? <p className="mt-4 rounded-2xl border border-border bg-bg/70 p-4 text-sm text-slate-300">{result.message}</p> : null}
        </Card>

        <Card className="p-6">
          <CardTitle title="Telefones" count={resultPhones.length} />
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {resultPhones.length ? (
              resultPhones.map((phone, index) => (
                <div key={`${phoneValue(phone)}-${index}`} className="rounded-2xl border border-border bg-bg/60 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-bold text-white">{phoneValue(phone)}</p>
                      <p className="mt-1 text-xs text-slate-500">{phoneType(phone) || 'tipo nao informado'}</p>
                    </div>
                    <Button variant="ghost" className="px-3 py-2" onClick={() => void copyPhone(phone)}>
                      <Copy size={14} />
                      Copiar
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <EmptyState text="Nenhum telefone para exibir." />
            )}
          </div>
        </Card>

        <Card className="p-6">
          <CardTitle title="Enderecos" count={resultAddresses.length} />
          <div className="mt-5 space-y-3">
            {resultAddresses.length ? (
              resultAddresses.map((address, index) => (
                <div key={`${address.address_full || address.full_address}-${index}`} className="rounded-2xl border border-border bg-bg/60 p-4">
                  <p className="font-semibold text-white">{address.address_full || address.full_address || '-'}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {[address.city, address.state, address.zipcode || address.zip_code].filter(Boolean).join(' - ')}
                  </p>
                </div>
              ))
            ) : (
              <EmptyState text="Nenhum endereco retornado." />
            )}
          </div>
        </Card>

        <Card className="p-6">
          <CardTitle title="E-mails" count={resultEmails.length} />
          <div className="mt-5 flex flex-wrap gap-2">
            {resultEmails.length ? resultEmails.map((email) => <Badge key={email} tone="neutral">{email}</Badge>) : <EmptyState text="Nenhum e-mail retornado." />}
          </div>
        </Card>
      </div>

      <Card className="p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm text-slate-400">Historico salvo por ate 60 dias</p>
            <h3 className="text-xl font-bold text-white">Clientes consultados</h3>
          </div>
          <div className="w-full lg:max-w-md">
            <Input value={historyFilter} onChange={(event) => setHistoryFilter(event.target.value)} placeholder="Filtrar por cliente, CPF, telefone ou status" />
          </div>
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className="min-w-[980px] text-left text-sm">
            <thead className="bg-bg/80 text-slate-400">
              <tr>
                {['Data da consulta', 'Cliente', 'CPF', 'Telefones', 'Status', 'Origem', 'Acao'].map((header) => (
                  <th key={header} className="px-5 py-4 font-medium">{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredHistory.map((item) => (
                <tr key={item.id} className="border-t border-border/80">
                  <td className="px-5 py-4 text-slate-300">{item.consulted_at_formatted || item.created_at_formatted || item.consulted_at || item.created_at}</td>
                  <td className="px-5 py-4 font-semibold text-white">{item.client_name || item.full_name || item.name || item.nome || '-'}</td>
                  <td className="px-5 py-4 text-slate-300">{item.cpf || '-'}</td>
                  <td className="px-5 py-4 text-slate-300">{item.phones_count ?? item.phones_found_count ?? 0}</td>
                  <td className="px-5 py-4">
                    <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>
                  </td>
                  <td className="px-5 py-4 text-slate-300">{item.source || item.origin || '-'}</td>
                  <td className="px-5 py-4">
                    <Button variant="ghost" className="px-3 py-2" onClick={() => void openDetails(item)}>
                      Detalhes
                    </Button>
                  </td>
                </tr>
              ))}
              {!filteredHistory.length ? (
                <tr>
                  <td className="px-5 py-8 text-center text-slate-500" colSpan={7}>Nenhuma consulta encontrada.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function CardTitle({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-xl font-bold text-white">{title}</h3>
      {count !== undefined ? <Badge tone="neutral">{count}</Badge> : null}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg/60 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-1 font-semibold text-white">{value}</p>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-white/3 p-4 text-sm text-slate-500">
      {text}
    </div>
  );
}
