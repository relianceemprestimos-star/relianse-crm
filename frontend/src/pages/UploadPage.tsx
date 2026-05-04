import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, FileSpreadsheet, LoaderCircle, ShieldAlert, UploadCloud, X } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import { formatCurrencyDisplay } from '../lib/margins';
import type { Campaign, UploadAnalysis } from '../types';
import { Badge, Button, Card, Input, SectionHeader } from '../components/ui';

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes)) {
    return '-';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PREVIEW_COLUMNS = [
  { label: 'CPF', key: 'cpf' },
  { label: 'Nome', key: 'name' },
  { label: 'Margem Bruta ConsignaÃ§Ã£o', key: 'margem_bruta_consignacao' },
  { label: 'Margem LÃ­quida ConsignaÃ§Ã£o', key: 'margem_liquida_consignacao' },
  { label: 'Margem Bruta CrÃ©dito', key: 'margem_bruta_credito' },
  { label: 'Margem LÃ­quida CrÃ©dito', key: 'margem_liquida_credito' },
  { label: 'Margem Bruta CartÃ£o', key: 'margem_bruta_cartao' },
  { label: 'Margem LÃ­quida CartÃ£o', key: 'margem_liquida_cartao' },
  { label: 'Status', key: 'consulta_status' },
  { label: 'Mensagem', key: 'consulta_mensagem' },
] as const;

export default function UploadPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignId, setCampaignId] = useState(() => searchParams.get('campaign_id') || '');
  const [campaignName, setCampaignName] = useState('');
  const [baseName, setBaseName] = useState('GOV SP - Maio 2026');
  const [baseType, setBaseType] = useState('Governo Estadual');
  const [convenio, setConvenio] = useState('Governo de SÃ£o Paulo');
  const [estado, setEstado] = useState('SP');
  const [cidade, setCidade] = useState('');
  const [notes, setNotes] = useState('');
  const [analysis, setAnalysis] = useState<UploadAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState('');

  const fileSummary = useMemo(() => {
    if (!file) return null;
    return {
      name: file.name,
      size: formatBytes(file.size),
      type: file.type || 'application/octet-stream',
    };
  }, [file]);

  useEffect(() => {
    let active = true;
    async function loadCampaigns() {
      try {
        const response = await api.getCampaigns({ include_archived: '0' });
        if (!active) return;
        const items = response.campaigns || [];
        setCampaigns(items);
        if (!campaignId && items.length) {
          setCampaignId(String(items[0].id));
        }
      } catch {
        // ignore campaign loading issues
      }
    }

    void loadCampaigns();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (file) {
      void previewFile(file);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  function openFilePicker() {
    inputRef.current?.click();
  }

  function handleFileSelection(selected: File | null) {
    setFile(selected);
    if (selected && (!baseName || baseName === 'GOV SP - Maio 2026')) {
      const suggested = selected.name
        .replace(/\.[^.]+$/, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (suggested) {
        setBaseName(suggested.toUpperCase().includes('GOV') ? suggested.toUpperCase() : suggested);
      }
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const selected = event.dataTransfer.files?.[0] || null;
    handleFileSelection(selected);
  }

  async function previewFile(selectedFile: File) {
    try {
      setLoading(true);
      const response = await api.uploadSpreadsheet(selectedFile, 'preview', {
        nome_base: baseName,
        tipo_base: baseType,
        convenio,
        estado,
        cidade,
        notes,
        campaign_id: campaignName.trim() ? null : campaignId || null,
        campaign_name: campaignName.trim() || undefined,
      });
      if (response.mode === 'preview') {
        setAnalysis(response.analysis);
        setLastCheckedAt(new Date().toLocaleString('pt-BR'));
        toast.success('Planilha validada com sucesso.');
      }
    } catch (error) {
      setAnalysis(null);
      toast.error(error instanceof Error ? error.message : 'Falha ao validar a planilha.');
    } finally {
      setLoading(false);
    }
  }

  async function handleImport() {
    if (!file) {
      toast.error('Escolha uma planilha para importar.');
      return;
    }
    if (!baseName.trim() || !baseType.trim() || !convenio.trim() || !estado.trim()) {
      toast.error('Preencha nome, tipo, convênio e estado da base antes de importar.');
      return;
    }
    if (!campaignName.trim() && !campaignId) {
      toast.error('Selecione uma campanha ou crie uma nova antes de importar.');
      return;
    }

    try {
      setImporting(true);
      const response = await api.uploadSpreadsheet(file, 'import', {
        nome_base: baseName,
        tipo_base: baseType,
        convenio,
        estado,
        cidade,
        notes,
        campaign_id: campaignName.trim() ? null : campaignId || null,
        campaign_name: campaignName.trim() || undefined,
      });
      if (response.mode === 'import') {
        toast.success('Lista importada com sucesso.');
        navigate('/fila');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao importar a lista.');
    } finally {
      setImporting(false);
    }
  }

  function resetUpload() {
    setFile(null);
    setAnalysis(null);
    setLastCheckedAt('');
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }

  const validationTone = !analysis
    ? 'neutral'
    : analysis.summary.invalid_rows > 0
      ? 'danger'
      : analysis.summary.warnings > 0
        ? 'info'
        : 'success';

  const recognized = analysis?.recognizedFields || {};
  const previewRows = analysis?.rows ?? [];
  const baseForm = {
    nome_base: baseName,
    tipo_base: baseType,
    convenio,
    estado,
    cidade,
    notes,
  };

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Upload de Listas"
        description="Arraste sua planilha ou clique para enviar. O sistema lÃª todas as colunas, identifica margens por produto e prepara a fila de atendimento."
      />

      <Card className="p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-[0.22em] text-slate-500">IdentificaÃ§Ã£o da base</p>
            <h3 className="mt-1 text-xl font-semibold text-white">Defina a origem antes de importar</h3>
          </div>
          <Badge tone="accent">ObrigatÃ³rio</Badge>
        </div>

        <div className="mt-5 grid gap-4 xl:grid-cols-2">
          <label className="block text-sm text-slate-300 xl:col-span-2">
            Campanha
            <div className="mt-2 grid gap-3 xl:grid-cols-[1fr_1fr]">
              <select
                className="w-full rounded-2xl border border-border bg-bg/80 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/10"
                value={campaignName.trim() ? '' : campaignId}
                onChange={(event) => {
                  setCampaignId(event.target.value);
                  if (event.target.value) {
                    setCampaignName('');
                  }
                }}
              >
                <option value="">Selecione uma campanha</option>
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </select>
              <Input
                value={campaignName}
                onChange={(event) => {
                  setCampaignName(event.target.value);
                  if (event.target.value.trim()) {
                    setCampaignId('');
                  }
                }}
                placeholder="Ou crie uma nova campanha"
              />
            </div>
          </label>
          <label className="block text-sm text-slate-300">
            Nome da base
            <Input className="mt-2" value={baseName} onChange={(event) => setBaseName(event.target.value)} placeholder="Ex: GOV SP - Maio 2026" />
          </label>
          <label className="block text-sm text-slate-300">
            Tipo da base
            <select className="mt-2 w-full rounded-2xl border border-border bg-bg/80 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/10" value={baseType} onChange={(event) => setBaseType(event.target.value)}>
              <option value="Governo Estadual">Governo Estadual</option>
              <option value="Prefeitura">Prefeitura</option>
              <option value="SPPREV">SPPREV</option>
              <option value="PolÃ­cia Militar">PolÃ­cia Militar</option>
              <option value="CÃ¢mara">CÃ¢mara</option>
              <option value="Autarquia">Autarquia</option>
              <option value="Outro">Outro</option>
            </select>
          </label>
          <label className="block text-sm text-slate-300">
            ConvÃªnio / Ã“rgÃ£o
            <Input className="mt-2" value={convenio} onChange={(event) => setConvenio(event.target.value)} placeholder="Ex: Governo de SÃ£o Paulo" />
          </label>
          <label className="block text-sm text-slate-300">
            Estado
            <select className="mt-2 w-full rounded-2xl border border-border bg-bg/80 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/10" value={estado} onChange={(event) => setEstado(event.target.value)}>
              {['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'].map((uf) => (
                <option key={uf} value={uf}>
                  {uf}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-slate-300">
            Cidade
            <Input className="mt-2" value={cidade} onChange={(event) => setCidade(event.target.value)} placeholder="Ex: RibeirÃ£o Preto" />
          </label>
          <label className="block text-sm text-slate-300 xl:col-span-2">
            Observação
            <textarea
              className="mt-2 w-full rounded-2xl border border-border bg-bg/80 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/10 placeholder:text-slate-500"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Ex: Base consultada em maio com margens atualizadas"
              rows={3}
            />
          </label>
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <Card className="p-6">
          <div
            className="flex min-h-[280px] cursor-pointer flex-col items-center justify-center rounded-3xl border border-dashed border-border bg-bg/70 px-6 text-center transition hover:border-accent/40 hover:bg-accent/5"
            onClick={openFilePicker}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openFilePicker();
              }
            }}
          >
            <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-accent/15 text-accent">
              <UploadCloud size={30} />
            </div>
            <h3 className="mt-5 text-2xl font-bold text-white">Arraste sua planilha ou clique para enviar</h3>
            <p className="mt-2 text-sm text-slate-400">Formatos aceitos: .xlsx, .xls, .csv</p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              <Button
                type="button"
                className="px-6 py-3"
                onClick={(event) => {
                  event.stopPropagation();
                  openFilePicker();
                }}
              >
                <FileSpreadsheet size={16} />
                Selecionar arquivo
              </Button>
              <Button
                variant="secondary"
                className="px-6 py-3"
                onClick={(event) => {
                  event.stopPropagation();
                  resetUpload();
                }}
                type="button"
              >
                <X size={16} />
                Cancelar
              </Button>
            </div>
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(event) => {
                const selected = event.target.files?.[0] || null;
                handleFileSelection(selected);
                event.target.value = '';
              }}
            />
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <p className="text-sm text-slate-400">Campos reconhecidos</p>
              <div className="mt-4 space-y-2">
                <FieldStatus label="CPF" field={recognized.cpf} />
                <FieldStatus label="Nome" field={recognized.name} />
                <FieldStatus label="Telefone" field={recognized.phone} />
                <FieldStatus label="E-mail" field={recognized.email} />
                <FieldStatus label="Margem Bruta ConsignaÃ§Ã£o" field={recognized.consignacao_gross} />
                <FieldStatus label="Margem LÃ­quida ConsignaÃ§Ã£o" field={recognized.consignacao_net} />
                <FieldStatus label="Margem Bruta CrÃ©dito" field={recognized.credito_gross} />
                <FieldStatus label="Margem LÃ­quida CrÃ©dito" field={recognized.credito_net} />
                <FieldStatus label="Margem Bruta CartÃ£o" field={recognized.cartao_gross} />
                <FieldStatus label="Margem LÃ­quida CartÃ£o" field={recognized.cartao_net} />
                <FieldStatus label="Status" field={recognized.status} />
                <FieldStatus label="Mensagem" field={recognized.message} />
              </div>
            </Card>

            <Card className="p-5">
              <p className="text-sm text-slate-400">ValidaÃ§Ã£o</p>
              <div className="mt-4 space-y-2 text-sm text-slate-300">
                <p>CPF Ã© convertido para texto limpo e alerta caso venha invÃ¡lido ou incompleto.</p>
                <p>Todas as colunas sÃ£o salvas no raw_data_json para preservar a linha original.</p>
                <p>Margens negativas, positivas e zero sÃ£o normalizadas para nÃºmero decimal.</p>
              </div>
            </Card>
          </div>

          <div className="mt-6 overflow-hidden rounded-3xl border border-border">
            <div className="flex items-center justify-between border-b border-border bg-white/3 px-5 py-4">
              <h4 className="font-semibold text-white">PrÃ©via da planilha</h4>
              <Badge tone={validationTone as 'neutral' | 'accent' | 'success' | 'danger' | 'info'}>
                {!analysis
                  ? 'Aguardando validaÃ§Ã£o'
                  : analysis.summary.invalid_rows > 0
                    ? 'Com alertas'
                    : analysis.summary.warnings > 0
                      ? 'Validado com alertas'
                      : 'Validado'}
              </Badge>
            </div>

            {analysis ? (
              <div className="overflow-x-auto">
                <table className="min-w-[1380px] text-left text-sm">
                  <thead className="bg-bg/80 text-slate-400">
                    <tr>
                      {PREVIEW_COLUMNS.map((column) => (
                        <th key={column.key} className="px-5 py-4 font-medium">
                          {column.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.slice(0, 12).map((row) => (
                      <tr key={`${row.rowNumber}-${row.cpf}`} className="border-t border-border/80">
                        <td className="px-5 py-4 text-slate-300">{row.cpf || '-'}</td>
                        <td className="px-5 py-4 font-semibold text-white">
                          {row.name || '-'}
                          {row.row_alerts?.length ? <div className="mt-1 text-xs text-amber-300">CPF invÃ¡lido ou linha com alerta</div> : null}
                        </td>
                        <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(row.margem_bruta_consignacao)}</td>
                        <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(row.margem_liquida_consignacao)}</td>
                        <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(row.margem_bruta_credito)}</td>
                        <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(row.margem_liquida_credito)}</td>
                        <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(row.margem_bruta_cartao)}</td>
                        <td className="px-5 py-4 text-slate-300">{formatCurrencyDisplay(row.margem_liquida_cartao)}</td>
                        <td className="px-5 py-4">
                          <Badge tone={statusTone(row.consulta_status)}>{row.consulta_status_label || row.consulta_status}</Badge>
                        </td>
                        <td className="px-5 py-4 text-slate-300">{row.consulta_mensagem || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-8 text-sm text-slate-500">Escolha uma planilha para visualizar a prÃ©via antes da importaÃ§Ã£o.</div>
            )}
          </div>
        </Card>

        <div className="space-y-6">
          <Card className="p-6">
            <p className="text-sm text-slate-400">Resumo do arquivo</p>
            <div className="mt-5 space-y-4">
              <SummaryLine label="Nome do arquivo" value={fileSummary?.name || '-'} />
              <SummaryLine label="Tamanho" value={fileSummary?.size || '-'} />
              <SummaryLine label="Total de clientes encontrados" value={analysis?.summary.total_rows ?? 0} />
              <SummaryLine label="Status da validaÃ§Ã£o" value={!analysis ? 'Aguardando' : analysis.summary.invalid_rows ? 'Com falhas' : 'Pronto'} />
              <SummaryLine label="Data/hora" value={lastCheckedAt || new Date().toLocaleString('pt-BR')} />
            </div>
          </Card>

          <Card className="p-6">
            <p className="text-sm text-slate-400">Resumo da base</p>
            <div className="mt-4 space-y-3">
              <SummaryLine label="Nome da base" value={baseForm.nome_base || '-'} />
              <SummaryLine label="Tipo" value={baseForm.tipo_base || '-'} />
              <SummaryLine label="ConvÃªnio / Ã³rgÃ£o" value={baseForm.convenio || '-'} />
              <SummaryLine label="Estado" value={baseForm.estado || '-'} />
              <SummaryLine label="Cidade" value={baseForm.cidade || '-'} />
            </div>
          </Card>

          <Card className="p-6">
            <p className="text-sm text-slate-400">AÃ§Ãµes</p>
            <div className="mt-4 space-y-3">
              <Button variant="secondary" className="w-full py-4" onClick={() => void previewFile(file as File)} disabled={!file || loading}>
                {loading ? <LoaderCircle className="animate-spin" size={16} /> : <ShieldAlert size={16} />}
                Validar dados
              </Button>
              <Button className="w-full py-4" onClick={() => void handleImport()} disabled={!file || importing}>
                {importing ? <LoaderCircle className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
                Importar lista
              </Button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function FieldStatus({ label, field }: { label: string; field?: { status: string; source_column: string; alerts?: string[] } }) {
  const tone = fieldTone(field?.status || 'not_found');
  const labelText = field?.status === 'identified' ? 'Identificado' : field?.status === 'alert' ? 'Com alerta' : 'NÃ£o encontrado';

  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-bg/60 px-4 py-3">
      <span className="text-sm text-slate-200">{label}</span>
      <Badge tone={tone}>{labelText}</Badge>
    </div>
  );
}

function fieldTone(status: string) {
  if (status === 'identified') return 'success';
  if (status === 'alert') return 'info';
  return 'neutral';
}

function statusTone(status?: string) {
  if (status === 'com_marg') return 'success';
  if (status === 'erro') return 'danger';
  return 'neutral';
}

function SummaryLine({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border border-border bg-bg/60 px-4 py-3">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-white">{value}</p>
    </div>
  );
}



