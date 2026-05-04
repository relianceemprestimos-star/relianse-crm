import { useEffect, useState, type ReactNode } from 'react';
import { KeyRound, MoonStar, Save, Settings as SettingsIcon, UserCircle2, Users, Volume2, Webhook } from 'lucide-react';
import toast from 'react-hot-toast';

import { useAuth } from '../components/AuthProvider';
import { UsersManagerPanel } from '../components/UsersManagerPanel';
import { api } from '../lib/api';
import { roleLabel } from '../lib/session';
import type { Settings } from '../types';
import { Badge, Button, Card, Input, SectionHeader, Textarea } from '../components/ui';

export default function SettingsPage() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<Settings>({
    company_name: 'Relianse CRM',
    attendant_name: 'Carlos Andrade',
    whatsapp_message:
      'Oie, {nome}, tudo bem? Ã‰ a Aline. Vi aqui que apareceu uma oportunidade no seu consignado. Posso te enviar uma simulaÃ§Ã£o sem compromisso?',
    allow_column_editing: 'true',
    daily_limit: '50',
    theme: 'dark',
    expected_columns:
      'cpf, nome, telefone, e-mail, margem bruta consignaÃ§Ã£o, margem lÃ­quida consignaÃ§Ã£o, margem bruta crÃ©dito, margem lÃ­quida crÃ©dito, margem bruta cartÃ£o, margem lÃ­quida cartÃ£o, status, mensagem',
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        setLoading(true);
        const response = await api.getSettings();
        if (!active) return;
        setSettings((current) => ({ ...current, ...response.settings }));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Falha ao carregar configurações.');
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
      const response = await api.saveSettings(settings);
      setSettings(response.settings);
      toast.success('Configurações salvas.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar configurações.');
    } finally {
      setSaving(false);
    }
  }

  async function handleChangePassword() {
    if (!passwordForm.currentPassword.trim() || !passwordForm.newPassword.trim() || !passwordForm.confirmPassword.trim()) {
      toast.error('Preencha todos os campos da senha.');
      return;
    }

    try {
      setPasswordSaving(true);
      await api.changePassword({
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
        confirmPassword: passwordForm.confirmPassword,
      });
      toast.success('Senha alterada com sucesso.');
      setPasswordForm({
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao alterar senha.');
    } finally {
      setPasswordSaving(false);
    }
  }

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Configurações"
        description="Ajuste os dados padrão da operação, a mensagem de WhatsApp e as preferências de carregamento da planilha."
        action={
          <Badge tone="accent">
            <MoonStar size={14} className="mr-2" />
            Tema escuro ativo
          </Badge>
        }
      />

      {loading ? (
        <Card className="p-8 text-sm text-slate-400">Carregando configurações...</Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
          <Card className="p-6">
            <div className="space-y-6">
              <SectionBlock icon={<UserCircle2 size={18} />} title="Conta ativa">
                <div className="rounded-2xl border border-border bg-bg/60 p-4">
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">Usuário logado</p>
                  <p className="mt-2 text-lg font-semibold text-white">{user?.name || '-'}</p>
                  <p className="mt-1 text-sm text-slate-400">{user?.login || '-'}</p>
                  <p className="mt-3 text-xs text-slate-500">Perfil atual: {roleLabel(user?.role)}</p>
                </div>
              </SectionBlock>

              <SectionBlock icon={<SettingsIcon size={18} />} title="Empresa">
                <Input
                  value={settings.company_name}
                  onChange={(event) => setSettings((current) => ({ ...current, company_name: event.target.value }))}
                  placeholder="Nome da empresa"
                />
              </SectionBlock>

              <SectionBlock icon={<UserCircle2 size={18} />} title="Atendente padrão">
                <Input
                  value={settings.attendant_name}
                  onChange={(event) => setSettings((current) => ({ ...current, attendant_name: event.target.value }))}
                  placeholder="Nome do atendente"
                />
              </SectionBlock>

              <SectionBlock icon={<Volume2 size={18} />} title="Mensagem padrão para WhatsApp">
                <Textarea
                  rows={6}
                  value={settings.whatsapp_message}
                  onChange={(event) => setSettings((current) => ({ ...current, whatsapp_message: event.target.value }))}
                />
                <p className="mt-2 text-xs text-slate-500">
                  Variáveis aceitas: {'{nome}'}, {'{cpf}'}, {'{telefone}'}, {'{margem_consignacao_liquida}'}, {'{margem_credito_liquida}'}, {'{margem_cartao_liquida}'}, {'{melhor_margem}'}, {'{melhor_produto}'}
                </p>
              </SectionBlock>

              <SectionBlock icon={<Webhook size={18} />} title="Upload">
                <Textarea
                  rows={3}
                  value={settings.expected_columns || ''}
                  onChange={(event) => setSettings((current) => ({ ...current, expected_columns: event.target.value }))}
                  placeholder="Colunas esperadas no upload"
                />
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <label className="block text-sm text-slate-300">
                    Permitir editar colunas
                    <Input
                      className="mt-2"
                      value={settings.allow_column_editing}
                      onChange={(event) => setSettings((current) => ({ ...current, allow_column_editing: event.target.value }))}
                    />
                  </label>
                  <label className="block text-sm text-slate-300">
                    Limite diário por vendedor
                    <Input
                      className="mt-2"
                      value={settings.daily_limit}
                      onChange={(event) => setSettings((current) => ({ ...current, daily_limit: event.target.value }))}
                    />
                  </label>
                </div>
              </SectionBlock>

              <SectionBlock icon={<KeyRound size={18} />} title="Minha conta">
                <div className="space-y-3">
                  <label className="block text-sm text-slate-300">
                    Senha atual
                    <Input
                      className="mt-2"
                      type="password"
                      value={passwordForm.currentPassword}
                      onChange={(event) => setPasswordForm((current) => ({ ...current, currentPassword: event.target.value }))}
                      placeholder="Digite sua senha atual"
                    />
                  </label>
                  <label className="block text-sm text-slate-300">
                    Nova senha
                    <Input
                      className="mt-2"
                      type="password"
                      value={passwordForm.newPassword}
                      onChange={(event) => setPasswordForm((current) => ({ ...current, newPassword: event.target.value }))}
                      placeholder="Digite sua nova senha"
                    />
                  </label>
                  <label className="block text-sm text-slate-300">
                    Confirmar nova senha
                    <Input
                      className="mt-2"
                      type="password"
                      value={passwordForm.confirmPassword}
                      onChange={(event) => setPasswordForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                      placeholder="Confirme a nova senha"
                    />
                  </label>
                  <Button className="w-full py-4" onClick={() => void handleChangePassword()} disabled={passwordSaving}>
                    <KeyRound size={16} />
                    {passwordSaving ? 'Alterando...' : 'Alterar senha'}
                  </Button>
                </div>
              </SectionBlock>

              {user?.role === 'gerencial' ? (
                <SectionBlock icon={<Users size={18} />} title="Usuários do sistema">
                  <UsersManagerPanel />
                </SectionBlock>
              ) : null}
            </div>
          </Card>

          <div className="space-y-6">
            <Card className="p-6">
              <p className="text-sm text-slate-400">Resumo</p>
              <div className="mt-4 space-y-3">
                <Summary label="Empresa" value={settings.company_name} />
                <Summary label="Atendente padrão" value={settings.attendant_name} />
                <Summary label="Tema" value={settings.theme} />
                <Summary label="Limite diário" value={settings.daily_limit} />
              </div>
            </Card>

            <Card className="p-6">
              <p className="text-sm text-slate-400">Mensagem ativa</p>
              <div className="mt-4 rounded-2xl border border-border bg-bg/60 p-4 text-sm text-slate-300">{settings.whatsapp_message}</div>
            </Card>

            <Button className="w-full py-4 text-base" onClick={() => void handleSave()} disabled={saving}>
              <Save size={16} />
              {saving ? 'Salvando...' : 'Salvar configurações'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionBlock({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-border bg-bg/60 p-5">
      <div className="flex items-center gap-3">
        <div className="rounded-2xl border border-accent/20 bg-accent/10 p-2 text-accent">{icon}</div>
        <h3 className="font-semibold text-white">{title}</h3>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-bg/60 px-4 py-3">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-white">{value || '-'}</p>
    </div>
  );
}
