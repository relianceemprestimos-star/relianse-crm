import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';

import { Badge, Button, Card, SectionHeader, StatCard } from '../components/ui';
import { api } from '../lib/api';
import { maskPhone } from '../lib/privacy';
import type { ClientDocument, DocumentChecklist } from '../types';

const docLabels: Record<string, string> = {
  rg_cnh: 'RG ou CNH',
  comprovante_endereco: 'Comprovante de endereco',
  holerite: 'Holerite',
  dados_bancarios: 'Dados bancarios',
  extrato: 'Extrato bancario',
  imagem_nao_classificada: 'Imagem recebida',
  pdf_nao_classificado: 'PDF recebido',
};

function flag(value: unknown) {
  return value === true || Number(value || 0) === 1;
}

function statusBadge(received: boolean, required: boolean) {
  if (!required) return <Badge tone="neutral">Isento</Badge>;
  return received ? <Badge tone="success">Recebido</Badge> : <Badge tone="danger">Pendente</Badge>;
}

export default function ClientDocumentsPage() {
  const { id = '', telefone = '' } = useParams();
  const decodedPhone = decodeURIComponent(telefone);
  const [checklist, setChecklist] = useState<DocumentChecklist | null>(null);
  const [documents, setDocuments] = useState<ClientDocument[]>([]);
  const [pending, setPending] = useState<Array<{ tipo: string; label: string }>>([]);

  async function load() {
    if (!id || !decodedPhone) return;
    try {
      const response = await api.getClientDocumentChecklist(id, decodedPhone);
      setChecklist(response.checklist);
      setDocuments(response.documentos || []);
      setPending(response.pendentes || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar checklist.');
    }
  }

  useEffect(() => {
    void load();
  }, [id, decodedPhone]);

  async function validate(document: ClientDocument, status: 'validado' | 'rejeitado') {
    try {
      await api.validateClientDocument(document.id, { status });
      toast.success(status === 'validado' ? 'Documento validado.' : 'Documento rejeitado.');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao atualizar documento.');
    }
  }

  async function markDigital() {
    try {
      await api.markDigitalAccount({ campanha_id: id, telefone: decodedPhone });
      toast.success('Extrato marcado como obrigatorio.');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao marcar conta digital.');
    }
  }

  async function openDocument(document: ClientDocument) {
    try {
      const blob = await api.openClientDocument(document.id);
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener,noreferrer');
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao abrir documento.');
    }
  }

  async function processAi(document: ClientDocument) {
    try {
      await api.processClientDocumentAi(document.id);
      toast.success('Documento processado pelo Document AI.');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao processar Document AI.');
      await load();
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeader title="Documentos do cliente" description={`Telefone ${maskPhone(decodedPhone)} · uso interno autorizado.`} />

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Status" value={checklist?.status || '-'} />
        <StatCard label="Pendentes" value={pending.length} />
        <StatCard label="Recebidos" value={documents.length} />
        <StatCard label="Banco" value={checklist?.banco || '-'} />
      </div>

      <Card className="p-5">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <div className="rounded-2xl border border-border bg-bg/70 p-4">
            <p className="text-sm font-semibold text-white">RG ou CNH</p>
            <div className="mt-3">{statusBadge(flag(checklist?.recebeu_rg_cnh), flag(checklist?.requer_rg_cnh))}</div>
          </div>
          <div className="rounded-2xl border border-border bg-bg/70 p-4">
            <p className="text-sm font-semibold text-white">Comprovante</p>
            <div className="mt-3">{statusBadge(flag(checklist?.recebeu_comprovante), flag(checklist?.requer_comprovante))}</div>
          </div>
          <div className="rounded-2xl border border-border bg-bg/70 p-4">
            <p className="text-sm font-semibold text-white">Holerite</p>
            <div className="mt-3">{statusBadge(flag(checklist?.recebeu_holerite), flag(checklist?.requer_holerite))}</div>
          </div>
          <div className="rounded-2xl border border-border bg-bg/70 p-4">
            <p className="text-sm font-semibold text-white">Dados bancarios</p>
            <div className="mt-3">{statusBadge(flag(checklist?.recebeu_dados_bancarios), flag(checklist?.requer_dados_bancarios))}</div>
          </div>
          <div className="rounded-2xl border border-border bg-bg/70 p-4">
            <p className="text-sm font-semibold text-white">Extrato</p>
            <div className="mt-3">{statusBadge(flag(checklist?.recebeu_extrato), flag(checklist?.requer_extrato))}</div>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button variant="secondary" onClick={markDigital}>Conta digital: exigir extrato</Button>
          <Button variant="secondary" disabled={!pending.length}>Cobrar pendencias via Zaia</Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-[0.16em] text-slate-500">
              <tr>
                <th className="px-5 py-4">Tipo</th>
                <th className="px-5 py-4">Arquivo</th>
                <th className="px-5 py-4">Status</th>
                <th className="px-5 py-4">Recebido</th>
                <th className="px-5 py-4">Acoes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {documents.map((document) => (
                <tr key={document.id} className="text-slate-300">
                  <td className="px-5 py-4">{docLabels[document.tipo_documento] || document.tipo_documento}</td>
                  <td className="px-5 py-4 font-semibold text-white">{document.nome_arquivo}</td>
                  <td className="px-5 py-4">
                    <Badge tone={document.status === 'validado' ? 'success' : document.status === 'rejeitado' ? 'danger' : 'neutral'}>
                      {document.status}
                    </Badge>
                  </td>
                  <td className="px-5 py-4">{document.recebido_em}</td>
                  <td className="px-5 py-4">
                    <div className="flex flex-wrap gap-2">
                      {document.url_arquivo ? (
                        <Button variant="secondary" onClick={() => openDocument(document)}>
                          <ExternalLink size={16} />
                          Abrir
                        </Button>
                      ) : null}
                      <Button variant="secondary" onClick={() => validate(document, 'validado')}>Validar</Button>
                      <Button variant="ghost" onClick={() => validate(document, 'rejeitado')}>Rejeitar</Button>
                      <Button variant="secondary" onClick={() => processAi(document)}>Processar IA</Button>
                    </div>
                    {document.document_ai_status ? (
                      <p className="mt-2 text-xs text-slate-500">
                        Document AI: {document.document_ai_status}
                        {document.document_ai_error ? ` - ${document.document_ai_error}` : ''}
                      </p>
                    ) : null}
                    {document.document_ai_text ? (
                      <details className="mt-2 rounded-2xl border border-border bg-bg/70 p-3 text-xs text-slate-300">
                        <summary className="cursor-pointer font-semibold text-white">Texto extraido</summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap">{document.document_ai_text.slice(0, 4000)}</pre>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))}
              {!documents.length ? (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center text-slate-400">
                    Nenhum documento recebido ainda.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
