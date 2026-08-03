# Layout do repositorio

O projeto segue a separacao por funcao para manter operacao e manutencao mais seguras.

## Estrutura principal

- `frontend/` - interface web
- `backend/` - API, regras de negocio e robos
- `backend/src/services/credentials/` - credenciais e segredos criptografados
- `backend/src/services/phone_lookup/` - consulta de telefones e integrações Nova Vida
- `backend/src/services/whatsapp/` - mensageria e filas de WhatsApp
- `backend/src/services/averbadores/ribeirao/` - fluxo de averbacao de Ribeirao
- `scripts/ops/` - manutencao e reparo de VPS
- `scripts/phone_lookup/` - utilitarios locais do fluxo Nova Vida
- `docs/` - regras, arquitetura e guias operacionais

## Regras de organizacao

- Um fluxo novo deve entrar na pasta da propria funcao.
- Robos diferentes nao devem compartilhar a mesma pasta so por conveniencia.
- Segredos reais ficam apenas em `.env` local e nunca no Git.
- O repositorio versiona somente exemplos de ambiente em `.env.example`.
