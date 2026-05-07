import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive, Edit3, Plus, Upload, Users } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import type { Campaign, UserRecord } from '../types';
import { useAuth } from '../components/AuthProvider';
import { Badge, Button, Card, Input, Modal, SectionHeader, Select, StatCard, Textarea } from '../components/ui';

type CampaignFormState = {
  name: string;
  convenio: string;
  description: string;
  product_focus: string;
  status: 'active' | 'inactive' | 'archived';
  internal_notes: string;
  user_ids: number[];
};

const initialForm: CampaignFormState = {
  name: '',
  convenio: '',
  description: '',
  product_focus: 'outros',
  status: 'active',
  internal_notes: '',
  user_ids: [],
};

function statusTone(status: Campaign['status']) {
  if (status === 'active') return 'success';
  if (status === 'inactive') return 'warning';
  return 'neutral';
}

export default function CampaignsPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canAssignUsers = user.role === 'gerencial' || user.role === 'admin';
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [form, setForm] = useState<CampaignFormState>(initialForm);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        setLoading(true);
        const [campaignResponse, usersResponse] = await Promise.all([
          api.getCampaigns({ include_archived: '1' }),
          canAssignUsers ? api.getUsers() : Promise.resolve({ users: [] as UserRecord[] }),
        ]);
        if (!active) return;
        setCampaigns(campaignResponse.campaigns || []);
        setUsers(usersResponse.users || []);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar campanhas.');
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [canAssignUsers]);

  const totals = useMemo(
    () => ({
      total: campaigns.length,
      active: campaigns.filter((campaign) => campaign.status === 'active').length,
      clients: campaigns.reduce((sum, campaign) => sum + (campaign.total_clients || 0), 0),
      positive: campaigns.reduce((sum, campaign) => sum + (campaign.total_em_atendimento || 0), 0),
    }),
    [campaigns]
  );

  function openCreate() {
    setEditing(null);
    setForm(initialForm);
    setModalOpen(true);
  }

  function openEdit(campaign: Campaign) {
    setEditing(campaign);
    setForm({
      name: campaign.name || '',
      convenio: campaign.convenio || '',
      description: campaign.description || '',
      product_focus: campaign.product_focus || 'outros',
      status: (campaign.status as CampaignFormState['status']) || 'active',
      internal_notes: campaign.internal_notes || '',
      user_ids: (campaign.users || []).map((item) => item.id),
    });
    setModalOpen(true);
  }

  async function saveCampaign() {
    if (!form.name.trim() || !form.convenio.trim()) {
      toast.error('Informe nome e convênio da campanha.');
      return;
    }

    try {
      setSaving(true);
      const payload = {
        name: form.name.trim(),
        convenio: form.convenio.trim(),
        description: form.description.trim(),
        product_focus: form.product_focus,
        status: form.status,
        internal_notes: form.internal_notes.trim(),
        user_ids: canAssignUsers ? form.user_ids : undefined,
        role: 'vendedor',
      };

      if (editing) {
        await api.updateCampaign(editing.id, payload);
        toast.success('Campanha atualizada com sucesso.');
      } else {
        await api.createCampaign(payload);
        toast.success('Campanha criada com sucesso.');
      }

      const response = await api.getCampaigns({ include_archived: '1' });
      setCampaigns(response.campaigns || []);
      setEditing(null);
      setForm(initialForm);
      setModalOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar campanha.');
    } finally {
      setSaving(false);
    }
  }

  async function archiveCampaign(campaign: Campaign) {
    const confirmed = window.confirm(`Arquivar a campanha "${campaign.name}"?`);
    if (!confirmed) return;
    try {
      await api.archiveCampaign(campaign.id, true);
      toast.success('Campanha arquivada.');
      const response = await api.getCampaigns({ include_archived: '1' });
      setCampaigns(response.campaigns || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao arquivar campanha.');
    }
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Campanhas"
        description="Organize suas bases por convênio, órgão ou estratégia de atendimento."
        action={
          <Button onClick={openCreate}>
            <Plus size={16} />
            Nova campanha
          </Button>
        }
      />

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Total de campanhas" value={totals.total} icon={<Users size={18} />} />
        <StatCard label="Campanhas ativas" value={totals.active} />
        <StatCard label="Clientes importados" value={totals.clients} />
        <StatCard label="Clientes em atendimento" value={totals.positive} />
      </div>

      {loading ? (
        <Card className="p-8 text-center text-slate-400">Carregando campanhas...</Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {campaigns.map((campaign) => (
            <Card key={campaign.id} className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-xl font-semibold text-white">{campaign.name}</h3>
                    <Badge tone={statusTone(campaign.status) as any}>{campaign.status}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-slate-400">{campaign.convenio || 'Convênio não informado'}</p>
                </div>
                <Badge tone="accent">{campaign.product_focus || 'outros'}</Badge>
              </div>

              <p className="mt-4 text-sm text-slate-400">{campaign.description || 'Sem descrição informada.'}</p>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-border bg-bg/70 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Clientes</p>
                  <p className="mt-2 text-2xl font-bold text-white">{campaign.total_clients || 0}</p>
                </div>
                <div className="rounded-2xl border border-border bg-bg/70 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Bases</p>
                  <p className="mt-2 text-2xl font-bold text-white">{campaign.total_bases || 0}</p>
                </div>
                <div className="rounded-2xl border border-border bg-bg/70 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Pendentes</p>
                  <p className="mt-2 text-2xl font-bold text-white">{campaign.total_pendente || 0}</p>
                </div>
                <div className="rounded-2xl border border-border bg-bg/70 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Em atendimento</p>
                  <p className="mt-2 text-2xl font-bold text-white">{campaign.total_em_atendimento || 0}</p>
                </div>
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <Button onClick={() => navigate(`/campanhas/${campaign.id}`)}>
                  Abrir campanha
                </Button>
                <Button variant="secondary" onClick={() => navigate(`/fila?campaign_id=${campaign.id}`)}>
                  Ver fila
                </Button>
                <Button variant="secondary" onClick={() => navigate(`/relatorios?campaign_id=${campaign.id}`)}>
                  Relatório
                </Button>
                <Button variant="secondary" onClick={() => navigate(`/upload?campaign_id=${campaign.id}`)}>
                  <Upload size={16} />
                  Subir base
                </Button>
                <Button variant="secondary" onClick={() => openEdit(campaign)}>
                  <Edit3 size={16} />
                  Editar
                </Button>
                <Button variant="ghost" onClick={() => archiveCampaign(campaign)}>
                  <Archive size={16} />
                  Arquivar
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
            setForm(initialForm);
            setModalOpen(false);
          }
        }}
        title={editing ? 'Editar campanha' : 'Nova campanha'}
        description="Defina a estratégia, o convênio e os vendedores autorizados."
      >
        <div className="space-y-4">
          <label className="block text-sm text-slate-300">
            Nome da campanha
            <Input className="mt-2" value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Ex: GOV SP - Maio 2026" />
          </label>
          <label className="block text-sm text-slate-300">
            Convênio/órgão
            <Input className="mt-2" value={form.convenio} onChange={(event) => setForm((current) => ({ ...current, convenio: event.target.value }))} placeholder="Ex: Governo de São Paulo" />
          </label>
          <label className="block text-sm text-slate-300">
            Descrição
            <Textarea className="mt-2" value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} placeholder="Base de servidores..." rows={3} />
          </label>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block text-sm text-slate-300">
              Produto foco
              <Select className="mt-2" value={form.product_focus} onChange={(event) => setForm((current) => ({ ...current, product_focus: event.target.value }))}>
                <option value="outros">Outros</option>
                <option value="novo consignado">Novo consignado</option>
                <option value="refinanciamento">Refinanciamento</option>
                <option value="portabilidade">Portabilidade</option>
                <option value="redução de taxa">Redução de taxa</option>
                <option value="cartão consignado">Cartão consignado</option>
                <option value="saque cartão">Saque cartão</option>
                <option value="consulta de margem">Consulta de margem</option>
              </Select>
            </label>
            <label className="block text-sm text-slate-300">
              Status
              <Select className="mt-2" value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as CampaignFormState['status'] }))}>
                <option value="active">Ativa</option>
                <option value="inactive">Inativa</option>
                <option value="archived">Arquivada</option>
              </Select>
            </label>
          </div>
          {canAssignUsers ? (
            <label className="block text-sm text-slate-300">
              Vendedores autorizados
              <Select
                multiple
                className="mt-2 min-h-32"
                value={form.user_ids.map(String)}
                onChange={(event) => {
                  const selected = Array.from(event.currentTarget.selectedOptions).map((option) => Number(option.value));
                  setForm((current) => ({ ...current, user_ids: selected }));
                }}
              >
                {users.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} ({item.role})
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          <label className="block text-sm text-slate-300">
            Observação interna
            <Textarea className="mt-2" value={form.internal_notes} onChange={(event) => setForm((current) => ({ ...current, internal_notes: event.target.value }))} rows={3} />
          </label>

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => { setEditing(null); setForm(initialForm); setModalOpen(false); }}>
              Cancelar
            </Button>
            <Button onClick={saveCampaign} disabled={saving}>
              Salvar campanha
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
