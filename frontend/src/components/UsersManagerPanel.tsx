import { useEffect, useMemo, useState } from 'react';
import { Edit3, KeyRound, Plus, RefreshCcw, ShieldCheck, ShieldOff, UserCog, Users } from 'lucide-react';
import toast from 'react-hot-toast';

import { api } from '../lib/api';
import type { UserRecord } from '../types';
import { Badge, Button, Card, Input, Modal, Select, StatCard } from './ui';

type UserFormState = {
  name: string;
  login: string;
  password: string;
  confirmPassword: string;
  role: 'gerencial' | 'vendedor';
  is_active: boolean;
};

const emptyForm: UserFormState = {
  name: '',
  login: '',
  password: '',
  confirmPassword: '',
  role: 'vendedor',
  is_active: true,
};

export function UsersManagerPanel() {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserRecord | null>(null);
  const [form, setForm] = useState<UserFormState>(emptyForm);
  const [passwordForm, setPasswordForm] = useState({ password: '', confirmPassword: '' });

  useEffect(() => {
    void loadUsers();
  }, []);

  async function loadUsers() {
    try {
      setLoading(true);
      const response = await api.getUsers();
      setUsers(response.users || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao carregar usuários.');
    } finally {
      setLoading(false);
    }
  }

  const stats = useMemo(() => {
    const active = users.filter((user) => user.is_active);
    return {
      total: users.length,
      vendedores: active.filter((user) => normalizeRole(user.role) === 'vendedor').length,
      gerenciais: active.filter((user) => normalizeRole(user.role) === 'gerencial').length,
      inativos: users.filter((user) => !user.is_active).length,
    };
  }, [users]);

  function openCreate() {
    setSelectedUser(null);
    setForm(emptyForm);
    setCreateOpen(true);
  }

  function openEdit(user: UserRecord) {
    setSelectedUser(user);
    setForm({
      name: user.name || '',
      login: user.login || '',
      password: '',
      confirmPassword: '',
      role: normalizeRole(user.role),
      is_active: user.is_active,
    });
    setEditOpen(true);
  }

  function openPassword(user: UserRecord) {
    setSelectedUser(user);
    setPasswordForm({ password: '', confirmPassword: '' });
    setPasswordOpen(true);
  }

  async function handleSaveUser() {
    if (!form.name.trim() || !form.login.trim()) {
      toast.error('Preencha todos os campos obrigatórios.');
      return;
    }
    if (createOpen) {
      if (!form.password.trim() || !form.confirmPassword.trim()) {
        toast.error('Preencha todos os campos obrigatórios.');
        return;
      }
      if (form.password !== form.confirmPassword) {
        toast.error('As senhas precisam ser iguais.');
        return;
      }
    }

    try {
      setSaving(true);
      if (createOpen) {
        await api.createUser({
          name: form.name.trim(),
          login: form.login.trim(),
          password: form.password,
          role: form.role,
          is_active: form.is_active,
        });
        toast.success('Usuário cadastrado com sucesso.');
      } else if (selectedUser) {
        await api.updateUser(selectedUser.id, {
          name: form.name.trim(),
          login: form.login.trim(),
          role: form.role,
          is_active: form.is_active,
        });
        toast.success('Usuário atualizado com sucesso.');
      }
      setCreateOpen(false);
      setEditOpen(false);
      await loadUsers();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao salvar usuário.');
    } finally {
      setSaving(false);
    }
  }

  async function handleSavePassword() {
    if (!selectedUser) {
      return;
    }

    if (!passwordForm.password.trim() || !passwordForm.confirmPassword.trim()) {
      toast.error('Informe a nova senha e a confirmação.');
      return;
    }
    if (passwordForm.password !== passwordForm.confirmPassword) {
      toast.error('As senhas precisam ser iguais.');
      return;
    }

    try {
      setSaving(true);
      await api.updateUserPassword(selectedUser.id, {
        password: passwordForm.password,
        confirm_password: passwordForm.confirmPassword,
      });
      toast.success('Senha atualizada com sucesso.');
      setPasswordOpen(false);
      await loadUsers();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao alterar senha.');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(user: UserRecord) {
    const confirmed = window.confirm(user.is_active ? 'Tem certeza que deseja inativar este usuário?' : 'Reativar este usuário?');
    if (!confirmed) {
      return;
    }

    try {
      await api.toggleUserActive(user.id);
      toast.success(user.is_active ? 'Usuário inativado.' : 'Usuário reativado.');
      await loadUsers();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Falha ao atualizar status do usuário.');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Button onClick={openCreate}>
          <Plus size={16} />
          Cadastrar usuário
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-4">
        <StatCard label="Total de usuários" value={stats.total} icon={<Users size={18} />} />
        <StatCard label="Vendedores ativos" value={stats.vendedores} icon={<UserCog size={18} />} />
        <StatCard label="Gerenciais ativos" value={stats.gerenciais} icon={<ShieldCheck size={18} />} />
        <StatCard label="Usuários inativos" value={stats.inativos} icon={<ShieldOff size={18} />} />
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h3 className="text-lg font-semibold text-white">Lista de usuários</h3>
            <p className="text-sm text-slate-500">Controle de acesso, perfis e senha.</p>
          </div>
          <Button variant="secondary" onClick={() => void loadUsers()}>
            <RefreshCcw size={16} />
            Recarregar
          </Button>
        </div>

        {loading ? (
          <div className="p-8 text-sm text-slate-400">Carregando usuários...</div>
        ) : users.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-[1400px] text-left text-sm">
              <thead className="bg-bg/80 text-slate-400">
                <tr>
                  {['Nome', 'Login', 'Perfil', 'Status', 'Criado em', 'Último acesso', 'Ações'].map((header) => (
                    <th key={header} className="px-5 py-4 font-medium">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-t border-border/80">
                    <td className="px-5 py-4">
                      <p className="font-semibold text-white">{user.name}</p>
                      <p className="mt-1 text-xs text-slate-500">ID #{user.id}</p>
                    </td>
                    <td className="px-5 py-4 text-slate-300">{user.login}</td>
                    <td className="px-5 py-4">
                      <Badge tone={normalizeRole(user.role) === 'gerencial' ? 'accent' : 'success'}>
                        {normalizeRole(user.role) === 'gerencial' ? 'Gerencial' : 'Vendedor'}
                      </Badge>
                    </td>
                    <td className="px-5 py-4">
                      <Badge tone={user.is_active ? 'success' : 'neutral'}>{user.is_active ? 'Ativo' : 'Inativo'}</Badge>
                    </td>
                    <td className="px-5 py-4 text-slate-300">{formatDate(user.created_at)}</td>
                    <td className="px-5 py-4 text-slate-300">{formatDate(user.last_login_at)}</td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap gap-2">
                        <Button variant="secondary" className="px-4 py-2" onClick={() => openEdit(user)}>
                          <Edit3 size={16} />
                          Editar
                        </Button>
                        <Button variant="ghost" className="px-4 py-2" onClick={() => openPassword(user)}>
                          <KeyRound size={16} />
                          Alterar senha
                        </Button>
                        <Button variant="ghost" className="px-4 py-2" onClick={() => void handleToggleActive(user)}>
                          {user.is_active ? 'Inativar' : 'Reativar'}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-sm text-slate-500">Nenhum usuário cadastrado.</div>
        )}
      </Card>

      <Modal
        open={createOpen || editOpen}
        title={createOpen ? 'Cadastrar usuário' : 'Editar usuário'}
        description="Defina nome, login, senha, perfil e status de acesso."
        onClose={() => {
          setCreateOpen(false);
          setEditOpen(false);
        }}
      >
        <div className="space-y-4">
          <Input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="Nome completo" />
          <Input value={form.login} onChange={(event) => setForm((current) => ({ ...current, login: event.target.value }))} placeholder="Login" />
          {createOpen ? (
            <>
              <Input
                type="password"
                value={form.password}
                onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                placeholder="Senha"
              />
              <Input
                type="password"
                value={form.confirmPassword}
                onChange={(event) => setForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                placeholder="Confirmar senha"
              />
            </>
          ) : null}
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block text-sm text-slate-300">
              Perfil
              <Select className="mt-2" value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value as 'gerencial' | 'vendedor' }))}>
                <option value="vendedor">Vendedor</option>
                <option value="gerencial">Gerencial</option>
              </Select>
            </label>
            <label className="block text-sm text-slate-300">
              Status
              <Select
                className="mt-2"
                value={form.is_active ? '1' : '0'}
                onChange={(event) => setForm((current) => ({ ...current, is_active: event.target.value === '1' }))}
              >
                <option value="1">Ativo</option>
                <option value="0">Inativo</option>
              </Select>
            </label>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="secondary"
              onClick={() => {
                setCreateOpen(false);
                setEditOpen(false);
              }}
            >
              Cancelar
            </Button>
            <Button onClick={() => void handleSaveUser()} disabled={saving}>
              {saving ? 'Salvando...' : 'Salvar usuário'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={passwordOpen}
        title="Alterar senha"
        description={selectedUser ? `Nova senha para ${selectedUser.name}` : 'Nova senha do usuário'}
        onClose={() => setPasswordOpen(false)}
      >
        <div className="space-y-4">
          <Input
            type="password"
            value={passwordForm.password}
            onChange={(event) => setPasswordForm((current) => ({ ...current, password: event.target.value }))}
            placeholder="Nova senha"
          />
          <Input
            type="password"
            value={passwordForm.confirmPassword}
            onChange={(event) => setPasswordForm((current) => ({ ...current, confirmPassword: event.target.value }))}
            placeholder="Confirmar nova senha"
          />
          <div className="flex justify-end gap-3 pt-2">
            <Button variant="secondary" onClick={() => setPasswordOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={() => void handleSavePassword()} disabled={saving}>
              {saving ? 'Salvando...' : 'Atualizar senha'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function normalizeRole(role: string) {
  const text = String(role || '').toLowerCase();
  if (text === 'gerencial' || text === 'admin') {
    return 'gerencial';
  }
  return 'vendedor';
}

function formatDate(value?: string | null) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}
