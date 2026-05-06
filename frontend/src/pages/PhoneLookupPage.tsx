import { useEffect, useMemo, useState } from 'react';
import { Copy, PhoneCall, Save, Search } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import type { Client, ClientAddress, PhoneLookupHistoryItem } from '../types';
import { Badge, Button, Card, Input, SectionHeader } from '../components/ui';

type ResultPhone = {
  number?: string;
  normalized?: string;
  normalized_phone?: string;
  type?: string;
  quality?: string;
  is_whatsapp?: boolean | null;
  source?: string;
  raw_label?: string;
};

type LookupResult = {
  status: string;
  source: string;
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
  emails?: string[];
  addresses?: ClientAddress[];
  raw_data?: Record<string, unknown>;
  phones: ResultPhone[];
  message?: string;
  code?: string;
};

export default function PhoneLookupPage() {
  const [cpf, setCpf] = useState('');
  const [name, setName] = useState('');
  const [clientSearch, setClientSearch] = useState('');
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);
  const [clientOptions, setClientOptions] = useState<Client[]>([]);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [history, setHistory] = useState<PhoneLookupHistoryItem[]>([]);
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
  const resultEmails = useMemo(() => result?.emails || (result?.email ? [result.email] : []), [result]);

  async function loadHistory() {
    const response = await api.getPhoneLookupHistory({ limit: 20 });
    setHistory(response.rows || []);
  }

  function chooseClient(client: Client) {
    setSelectedClient(client);
    setClientSearch(client.name);
    setCpf(client.cpf || '');
    setName(client.name || '');
    setClientOptions([]);
  }

  async function handleSearch() {
    try {
      setLoading(true);
      const response = await api.searchPhones({
        cpf,
        name,
        client_id: selectedClient?.id || null,
      });
      setResult(response);
      if (response.status === 'success') {
        toast.success(`${response.phones.length} telefone(s) encontrado(s).`);
      } else if (response.status === 'requires_manual_login') {
        toast.error('Nova Vida solicitou login manual ou validação.');
      } else if (response.status === 'not_found') {
        toast('Nenhum telefone encontrado.');
      } else {
        toast.error(response.message || 'Consulta não concluída.');
      }
      await loadHistory();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao consultar telefones.');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveAll() {
    if (!selectedClient?.id) {
      toast.error('Selecione um cliente para salvar os telefones.');
      return;
    }
    if (!resultPhones.length) {
      toast.error('Nenhum telefone para salvar.');
      return;
    }
    try {
      setSaving(true);
      const saved = await api.savePhonesToClient({
        client_id: selectedClient.id,
        phones: resultPhones,
        enrichment: result || undefined,
      });
      toast.success(`${saved.saved} telefone(s) salvo(s) no cliente.`);
      await loadHistory();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar telefones.');
    } finally {
      setSaving(false);
    }
  }

  async function copyPhone(phone: ResultPhone) {
    const value = phone.normalized || phone.normalized_phone || phone.number || '';
    if (!value) return;
    await navigator.clipboard?.writeText(value);
    toast.success('Telefone copiado.');
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Consulta de Telefones"
        description="Busque telefones no Nova Vida e salve automaticamente no cadastro do cliente."
        action={<Badge tone="accent">Fonte: Nova Vida</Badge>}
      />

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <Card className="p-6">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-accent/15 p-3 text-accent">
              <PhoneCall size={20} />
            </div>
            <div>
              <p className="text-sm text-slate-400">Busca manual</p>
              <h3 className="text-xl font-bold text-white">Pesquisar cliente no Nova Vida</h3>
            </div>
          </div>

          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <label className="block text-sm text-slate-300 md:col-span-2">
              Cliente do CRM
              <Input className="mt-2" value={clientSearch} onChange={(event) => setClientSearch(event.target.value)} placeholder="Digite nome, CPF ou telefone do cliente" />
              {clientOptions.length ? (
                <div className="mt-2 rounded-2xl border border-border bg-bg/95 p-2">
                  {clientOptions.map((client) => (
                    <button
                      key={client.id}
                      type="button"
                      className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm text-slate-300 hover:bg-white/5"
                      onClick={() => chooseClient(client)}
                    >
                      <span>{client.name}</span>
                      <span className="text-xs text-slate-500">{client.cpf}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </label>

            <label className="block text-sm text-slate-300">
              CPF
              <Input className="mt-2" value={cpf} onChange={(event) => setCpf(event.target.value)} placeholder="00000000000" />
            </label>
            <label className="block text-sm text-slate-300">
              Nome
              <Input className="mt-2" value={name} onChange={(event) => setName(event.target.value)} placeholder="Nome do cliente" />
            </label>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <Button onClick={() => void handleSearch()} disabled={loading}>
              <Search size={16} />
              {loading ? 'Buscando...' : 'Buscar no Nova Vida'}
            </Button>
            <Button variant="secondary" onClick={() => void handleSaveAll()} disabled={saving || !resultPhones.length}>
              <Save size={16} />
              Salvar todos no cliente
            </Button>
          </div>

          {selectedClient ? (
            <div className="mt-5 rounded-2xl border border-accent/20 bg-accent/10 p-4 text-sm text-slate-200">
              Cliente selecionado: <strong>{selectedClient.name}</strong>
            </div>
          ) : null}
        </Card>

        <Card className="p-6">
          <p className="text-sm text-slate-400">Resultado</p>
          <h3 className="mt-1 text-xl font-bold text-white">{result?.name || 'Nenhuma consulta feita'}</h3>
          <div className="mt-3 flex flex-wrap gap-2">
            {result ? <Badge tone={result.status === 'success' ? 'success' : result.status === 'requires_manual_login' ? 'danger' : 'neutral'}>{result.status}</Badge> : null}
            {result?.source ? <Badge tone="accent">{result.source}</Badge> : null}
          </div>

          {result?.message ? <p className="mt-4 rounded-2xl border border-border bg-bg/70 p-4 text-sm text-slate-300">{result.message}</p> : null}

          {result ? (
            <div className="mt-5 grid gap-3 text-sm md:grid-cols-2">
              <LookupLine label="Nome" value={result.full_name || result.name || '-'} />
              <LookupLine label="CPF" value={result.cpf || '-'} />
              <LookupLine label="Nascimento" value={result.birth_date || '-'} />
              <LookupLine label="Idade" value={result.age === null || result.age === undefined ? '-' : String(result.age)} />
              <LookupLine label="Sexo" value={result.gender || '-'} />
              <LookupLine label="Nome da mãe" value={result.mother_name || '-'} />
              <LookupLine label="Nome do pai" value={result.father_name || '-'} />
              <LookupLine label="E-mail principal" value={result.email || resultEmails[0] || '-'} />
            </div>
          ) : null}

          <div className="mt-6">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Telefones</p>
          </div>
          <div className="mt-3 space-y-3">
            {resultPhones.length ? (
              resultPhones.map((phone, index) => (
                <div key={`${phone.normalized || phone.normalized_phone || phone.number}-${index}`} className="rounded-2xl border border-border bg-bg/60 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-white">{phone.normalized || phone.normalized_phone || phone.number}</p>
                      <p className="mt-1 text-xs text-slate-500">
                        {phone.type || 'tipo não informado'} • {phone.quality || 'qualidade não informada'} • Nova Vida
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="ghost" className="px-3 py-2" onClick={() => void copyPhone(phone)}>
                        <Copy size={14} />
                        Copiar
                      </Button>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-border bg-white/3 p-4 text-sm text-slate-500">
                Os telefones encontrados aparecerão aqui.
              </div>
            )}
          </div>

          <div className="mt-6">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Endereços</p>
            <div className="mt-3 space-y-3">
              {resultAddresses.length ? (
                resultAddresses.map((address, index) => (
                  <div key={`${address.address_full}-${index}`} className="rounded-2xl border border-border bg-bg/60 p-4 text-sm text-slate-300">
                    <p className="font-semibold text-white">{address.address_full || '-'}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {[address.street, address.number, address.complement, address.district, address.city, address.state, address.zipcode].filter(Boolean).join(' • ')}
                    </p>
                  </div>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-border bg-white/3 p-4 text-sm text-slate-500">Nenhum endereço retornado.</div>
              )}
            </div>
          </div>

          <div className="mt-6">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-500">E-mails</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {resultEmails.length ? resultEmails.map((email) => <Badge key={email} tone="neutral">{email}</Badge>) : <span className="text-sm text-slate-500">Nenhum e-mail retornado.</span>}
            </div>
          </div>

          {result?.raw_data ? (
            <details className="mt-6 rounded-2xl border border-border bg-bg/60 p-4 text-sm text-slate-400">
              <summary className="cursor-pointer font-semibold text-white">Ver detalhes técnicos</summary>
              <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(result.raw_data, null, 2)}</pre>
            </details>
          ) : null}
        </Card>
      </div>

      <Card className="p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm text-slate-400">Histórico de consultas</p>
            <h3 className="text-xl font-bold text-white">Últimas buscas</h3>
          </div>
          <Badge tone="neutral">{history.length} registros</Badge>
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className="min-w-[900px] text-left text-sm">
            <thead className="bg-bg/80 text-slate-400">
              <tr>
                {['Data', 'Cliente', 'CPF', 'Status', 'Telefones', 'Nascimento', 'Endereço', 'Erro'].map((header) => (
                  <th key={header} className="px-5 py-4 font-medium">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map((item) => (
                <tr key={item.id} className="border-t border-border/80">
                  <td className="px-5 py-4 text-slate-300">{item.created_at_formatted || item.created_at}</td>
                  <td className="px-5 py-4 font-semibold text-white">{item.client_name || item.name || '-'}</td>
                  <td className="px-5 py-4 text-slate-300">{item.cpf || item.cpf_masked || '-'}</td>
                  <td className="px-5 py-4">
                    <Badge tone={item.status === 'success' || item.status === 'saved' ? 'success' : item.status === 'requires_manual_login' || item.status === 'failed' ? 'danger' : 'neutral'}>
                      {item.status}
                    </Badge>
                  </td>
                  <td className="px-5 py-4 text-slate-300">{item.phones_found_count}</td>
                  <td className="px-5 py-4 text-slate-300">{item.has_birth_date ? 'Sim' : '-'}</td>
                  <td className="px-5 py-4 text-slate-300">{item.has_address ? 'Sim' : '-'}</td>
                  <td className="px-5 py-4 text-slate-400">{item.error_message || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function LookupLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg/60 p-3">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-1 font-semibold text-white">{value}</p>
    </div>
  );
}
