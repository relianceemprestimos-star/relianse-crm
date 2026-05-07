import { useEffect, useMemo, useState } from 'react';
import { Bookmark, Calendar, ChevronRight, Copy, Home, Info, Mail, MapPin, Phone, RotateCcw, Save, Search, User } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import type { Client, ClientAddress, PhoneLookupHistoryItem } from '../types';
import { Badge, Button, Card, Input } from '../components/ui';

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
type ResultTab = 'summary' | 'phones' | 'addresses' | 'emails';

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

const tabs: Array<{ id: ResultTab; label: string }> = [
  { id: 'summary', label: 'Resumo' },
  { id: 'phones', label: 'Telefones' },
  { id: 'addresses', label: 'Endereços' },
  { id: 'emails', label: 'E-mails' },
];

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

function addressValue(address?: ClientAddress) {
  return address?.address_full || address?.full_address || '';
}

function formatDate(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('pt-BR');
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
  const [statusFilter, setStatusFilter] = useState('');
  const [activeTab, setActiveTab] = useState<ResultTab>('summary');
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

  function handleClientSearchChange(value: string) {
    setClientSearch(value);
    if (selectedClient && value.trim() !== selectedClient.name) {
      setSelectedClient(null);
    }
  }

  const resultPhones = useMemo(() => result?.phones || [], [result]);
  const resultAddresses = useMemo(() => result?.addresses || [], [result]);
  const resultEmails = useMemo(() => {
    const emails = result?.emails || [];
    const values = emails.map(emailValue).filter(Boolean);
    if (result?.email && !values.includes(result.email)) values.unshift(result.email);
    return values;
  }, [result]);
  const primaryAddress = resultAddresses[0];
  const primaryPhone = resultPhones[0];
  const primaryEmail = resultEmails[0] || '';
  const filteredHistory = useMemo(() => {
    const term = historyFilter.trim().toLowerCase();
    return history.filter((item) => {
      if (statusFilter && item.status !== statusFilter) return false;
      if (!term) return true;
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
  }, [history, historyFilter, statusFilter]);

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
    setActiveTab('summary');
  }

  async function handleSearch() {
    try {
      setLoading(true);
      const typedSearch = clientSearch.trim();
      const typedDigits = typedSearch.replace(/\D/g, '');
      const effectiveCpf = cpf.trim() || (typedDigits.length === 11 ? typedDigits : '');
      const effectiveName = name.trim() || (!effectiveCpf && typedSearch ? typedSearch : '');
      const response = await api.searchPhones({
        cpf: effectiveCpf,
        name: effectiveName,
        phone: typedSearch,
        client_id: selectedClient?.id || null,
      });
      const normalized = normalizeConsultation(response);
      setResult(normalized);
      setActiveTab('summary');
      if (normalized.cache_hit) {
        toast.success('Consulta carregada do histórico salvo.');
      } else if (normalized.status === 'success') {
        toast.success('Consulta realizada e salva.');
      } else if (normalized.status === 'requires_manual_login') {
        toast.error(normalized.message || 'Sessao expirada. Login manual necessario.');
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
      setActiveTab('summary');
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
    <div className="space-y-7">
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent shadow-[0_0_36px_rgba(0,209,193,.12)]">
          <Phone size={25} />
        </div>
        <div>
          <h1 className="text-3xl font-black tracking-tight text-white">Consulta telefone</h1>
          <p className="mt-1 text-sm text-slate-400">Pesquise informações de clientes e visualize telefones, endereços e e-mails vinculados.</p>
        </div>
      </div>

      <Card className="overflow-visible rounded-3xl border-accent/15 bg-panel/80 p-6 shadow-[0_22px_70px_rgba(0,0,0,.22)]">
        <div className="grid gap-5 lg:grid-cols-[1.4fr_0.75fr_1.05fr]">
            <label className="relative block text-sm text-slate-300">
              Cliente do CRM
              <div className="relative mt-2">
                <Input
                  className="h-12 rounded-full pr-12"
                  value={clientSearch}
                  onChange={(event) => handleClientSearchChange(event.target.value)}
                  placeholder="Digite o nome, CPF ou telefone do cliente"
                />
                <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-500" size={18} />
              </div>
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
              <Input className="mt-2 h-12 rounded-full" value={cpf} onChange={(event) => setCpf(event.target.value)} placeholder="Digite o CPF" />
            </label>

            <label className="block text-sm text-slate-300">
              Nome
              <Input className="mt-2 h-12 rounded-full" value={name} onChange={(event) => setName(event.target.value)} placeholder="Digite o nome do cliente" />
            </label>
        </div>

        <div className="mt-5 flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex flex-wrap gap-3">
            <Button className="rounded-full px-8 shadow-[0_0_28px_rgba(0,209,193,.18)]" onClick={() => void handleSearch()} disabled={loading}>
              <Search size={16} />
              {loading ? 'Buscando...' : 'Buscar'}
            </Button>
            <Button variant="secondary" className="rounded-full px-7" onClick={clearFields}>
              <RotateCcw size={16} />
              Limpar campos
            </Button>
            <Button variant="secondary" className="rounded-full px-7" onClick={() => void handleSaveCurrent()} disabled={saving || !result?.consultation_id}>
              <Save size={16} />
              {saving ? 'Salvando...' : 'Salvar busca atual'}
            </Button>
          </div>

          <div className="flex min-w-[280px] items-center gap-3 rounded-2xl border border-border bg-bg/60 px-4 py-3 text-xs text-slate-400">
            <Info size={17} className="shrink-0 text-slate-300" />
            <div>
              <p className="font-bold text-accent">Dicas de busca</p>
              <p>Use CPF, nome ou telefone para encontrar o cliente desejado.</p>
            </div>
          </div>
        </div>

        {(selectedClient || result) ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {selectedClient ? <Badge tone="accent">Cliente selecionado: {selectedClient.name}</Badge> : null}
            {result?.cache_hit ? <Badge tone="success">Carregado do CRM</Badge> : null}
            {result?.consulted_at ? <Badge tone="neutral">Consulta: {formatDate(result.consulted_at)}</Badge> : null}
          </div>
        ) : null}
      </Card>

      <Card className="overflow-hidden rounded-3xl border-accent/15 bg-panel/90 shadow-[0_24px_90px_rgba(0,0,0,.24)]">
        <div className="border-b border-border/80 bg-gradient-to-r from-accent/10 via-white/[0.03] to-transparent p-6">
          {result ? (
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="flex items-start gap-4">
                <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
                  <User size={28} />
                </div>
                <div>
                  <h2 className="text-2xl font-black tracking-tight text-white">
                    {result.full_name || result.name || 'Cliente consultado'}
                  </h2>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-sm text-slate-400">
                    <span>CPF <strong className="text-slate-200">{result.cpf || '-'}</strong></span>
                    {selectedClient?.created_at_formatted || selectedClient?.created_at ? (
                      <span>Cliente desde <strong className="text-slate-200">{selectedClient.created_at_formatted || formatDate(selectedClient.created_at)}</strong></span>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="flex flex-col items-start gap-3 lg:items-end">
                <div className="flex flex-wrap gap-2 lg:justify-end">
                  <Badge tone={statusTone(result.status)}>{statusLabel(result.status)}</Badge>
                  <Badge tone="neutral">{result.origin || result.source || 'Consulta salva'}</Badge>
                </div>
                <div className="rounded-full border border-border bg-bg/70 px-4 py-2 text-xs text-slate-300">
                  Dados atualizados em {formatDate(result.consulted_at) || '-'}
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-3xl border border-dashed border-border bg-bg/50 p-8 text-center">
              <p className="text-sm uppercase tracking-[0.25em] text-slate-500">Resultado do cliente</p>
              <h2 className="mt-2 text-2xl font-black text-white">Pesquise um CPF, nome ou cliente para visualizar o cadastro.</h2>
              <p className="mx-auto mt-3 max-w-2xl text-sm text-slate-400">
                Quando houver consulta salva válida, os dados aparecem do CRM. Caso contrário, o sistema busca online e salva o snapshot automaticamente.
              </p>
            </div>
          )}
        </div>

        {result ? (
          <>
            <div className="flex gap-0 overflow-x-auto border-b border-border/80 px-6 pt-4">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex items-center gap-2 rounded-t-2xl border px-5 py-3 text-sm font-semibold transition ${
                    activeTab === tab.id
                      ? 'border-accent/40 border-b-accent bg-accent/10 text-accent shadow-[inset_0_-2px_0_rgba(0,209,193,1)]'
                      : 'border-border bg-bg/40 text-slate-300 hover:border-accent/40 hover:text-white'
                  }`}
                >
                  {tab.label}
                  {tab.id === 'phones' ? <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{resultPhones.length}</span> : null}
                  {tab.id === 'addresses' ? <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{resultAddresses.length}</span> : null}
                  {tab.id === 'emails' ? <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs">{resultEmails.length}</span> : null}
                </button>
              ))}
            </div>

            <div className="p-6">
              {activeTab === 'summary' ? (
                <div className="grid gap-3 rounded-3xl border border-border bg-bg/40 p-3 xl:grid-cols-4">
                  <SummaryBlock title="Dados pessoais" icon={<Calendar size={18} />}>
                    <PersonalLine label="Nascimento" value={`${result.birth_date || '-'}${result.age ? ` (${result.age} anos)` : ''}`} />
                    <PersonalLine label="Sexo" value={result.gender || '-'} />
                    <PersonalLine label="Nome da mãe" value={result.mother_name || '-'} />
                    <PersonalLine label="Nome do pai" value={result.father_name || '-'} />
                  </SummaryBlock>

                  <SummaryBlock title={`Telefones (${resultPhones.length})`} icon={<Phone size={18} />}>
                    {primaryPhone ? (
                      <div className="space-y-2">
                        {resultPhones.slice(0, 5).map((phone, index) => (
                          <PhoneRow key={`${phoneValue(phone)}-${index}`} phone={phone} onCopy={() => void copyPhone(phone)} />
                        ))}
                        <InlineLink label="Ver todos os telefones" onClick={() => setActiveTab('phones')} />
                      </div>
                    ) : (
                      <EmptyState text="Nenhum telefone encontrado." />
                    )}
                  </SummaryBlock>

                  <SummaryBlock title={`Endereço (${resultAddresses.length})`} icon={<Home size={18} />}>
                    {primaryAddress ? (
                      <div className="space-y-4">
                        <div className="border-b border-border pb-4">
                          <p className="leading-relaxed text-slate-200">{addressValue(primaryAddress)}</p>
                          <p className="mt-2 text-xs text-slate-500">{[primaryAddress.city, primaryAddress.state, primaryAddress.zipcode || primaryAddress.zip_code].filter(Boolean).join(' - ')}</p>
                        </div>
                        <div className="space-y-2">
                          <Button
                            variant="ghost"
                            className="w-full justify-between rounded-2xl border border-border px-4 py-3"
                            onClick={() => window.open(`https://www.google.com/maps/search/${encodeURIComponent(addressValue(primaryAddress))}`, '_blank')}
                          >
                            <span className="inline-flex items-center gap-2"><MapPin size={14} />Ver no mapa</span>
                            <ChevronRight size={16} />
                          </Button>
                          <InlineLink label="Ver todos os endereços" onClick={() => setActiveTab('addresses')} />
                        </div>
                      </div>
                    ) : (
                      <EmptyState text="Nenhum endereço encontrado." />
                    )}
                  </SummaryBlock>

                  <SummaryBlock title={`E-mail (${resultEmails.length})`} icon={<Mail size={18} />}>
                    {primaryEmail ? (
                      <div className="space-y-4">
                        <div className="flex items-start gap-3 border-b border-border pb-4">
                          <Mail size={17} className="mt-0.5 text-slate-400" />
                          <div>
                            <p className="font-semibold text-white">{primaryEmail}</p>
                            <p className="mt-1 text-xs text-slate-500">Principal</p>
                          </div>
                        </div>
                        <InlineLink label="Ver todos os e-mails" onClick={() => setActiveTab('emails')} />
                      </div>
                    ) : (
                      <EmptyState text="Nenhum e-mail encontrado." />
                    )}
                  </SummaryBlock>
                </div>
              ) : null}

              {activeTab === 'phones' ? (
                <PanelGrid>
                  {resultPhones.length ? (
                    resultPhones.map((phone, index) => (
                      <div key={`${phoneValue(phone)}-${index}`} className="rounded-2xl border border-border bg-bg/60 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-bold text-white">{phoneValue(phone)}</p>
                            <p className="mt-1 text-xs text-slate-500">{phoneType(phone) || 'tipo não informado'}</p>
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
                </PanelGrid>
              ) : null}

              {activeTab === 'addresses' ? (
                <div className="space-y-3">
                  {resultAddresses.length ? (
                    resultAddresses.map((address, index) => (
                      <div key={`${addressValue(address)}-${index}`} className="rounded-2xl border border-border bg-bg/60 p-4">
                        <p className="font-semibold text-white">{addressValue(address) || '-'}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          {[address.city, address.state, address.zipcode || address.zip_code].filter(Boolean).join(' - ')}
                        </p>
                      </div>
                    ))
                  ) : (
                    <EmptyState text="Nenhum endereço retornado." />
                  )}
                </div>
              ) : null}

              {activeTab === 'emails' ? (
                <div className="flex flex-wrap gap-2">
                  {resultEmails.length ? resultEmails.map((email) => <Badge key={email} tone="neutral">{email}</Badge>) : <EmptyState text="Nenhum e-mail retornado." />}
                </div>
              ) : null}

              {result.message ? (
                <p className="mt-6 rounded-2xl border border-border bg-bg/70 p-4 text-sm text-slate-300">{result.message}</p>
              ) : null}
            </div>
          </>
        ) : null}
      </Card>

      <Card className="rounded-3xl border-accent/15 bg-panel/90 p-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <h3 className="text-xl font-bold text-white">Clientes consultados</h3>
            <p className="mt-1 text-sm text-slate-400">Histórico das últimas consultas realizadas.</p>
          </div>
          <div className="grid w-full gap-3 md:grid-cols-[1fr_220px] xl:max-w-2xl">
            <Input value={historyFilter} onChange={(event) => setHistoryFilter(event.target.value)} placeholder="Filtrar por cliente, CPF ou telefone" />
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className="w-full rounded-2xl border border-border bg-bg/80 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/10"
            >
              <option value="">Todos os status</option>
              <option value="success">Sucesso</option>
              <option value="failed">Falha</option>
                  <option value="requires_manual_login">Requer login manual</option>
              <option value="expired">Expirada</option>
            </select>
          </div>
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className="min-w-[980px] text-left text-sm">
            <thead className="bg-bg/80 text-slate-400">
              <tr>
                {['Data da consulta', 'Cliente', 'CPF', 'Telefones', 'Status', 'Origem', 'Ação'].map((header) => (
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
                    <Button variant="ghost" className="rounded-2xl border border-accent/60 px-4 py-2 text-accent" onClick={() => void openDetails(item)}>
                      Detalhes
                      <ChevronRight size={15} />
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

function SummaryBlock({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-panelAlt/70 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,.03)]">
      <div className="flex items-center gap-3 border-b border-border pb-4">
        <span className="text-slate-400">{icon}</span>
        <h3 className="text-base font-bold text-white">{title}</h3>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function PersonalLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 py-3">
      <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg/80 text-slate-400">
        <Bookmark size={14} />
      </span>
      <div>
        <p className="text-xs text-slate-500">{label}</p>
        <p className="mt-1 text-sm font-semibold text-slate-100">{value}</p>
      </div>
    </div>
  );
}

function PhoneRow({ phone, onCopy }: { phone: ResultPhone; onCopy: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg/60 px-3 py-2">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
          <Phone size={16} />
        </span>
        <div>
          <p className="text-sm font-bold text-white">{phoneValue(phone)}</p>
          <p className="text-xs text-slate-500">{phoneType(phone) || 'tipo não informado'}</p>
        </div>
      </div>
      <button type="button" className="rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-accent" onClick={onCopy}>
        <Copy size={16} />
      </button>
    </div>
  );
}

function InlineLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="inline-flex items-center gap-2 text-sm font-semibold text-accent hover:brightness-110" onClick={onClick}>
      {label}
      <ChevronRight size={15} />
    </button>
  );
}

function PanelGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-white/3 p-4 text-sm text-slate-500">
      {text}
    </div>
  );
}
