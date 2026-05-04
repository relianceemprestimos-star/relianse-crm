import { SectionHeader } from '../components/ui';
import { UsersManagerPanel } from '../components/UsersManagerPanel';

export default function UsersPage() {
  return (
    <div className="space-y-8">
      <SectionHeader
        title="Usuários"
        description="Cadastre vendedores e gerenciais que terão acesso ao CRM."
      />
      <UsersManagerPanel />
    </div>
  );
}
