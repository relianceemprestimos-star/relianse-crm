# Plano de testes

## Validacao automatizada

Rodar sempre que houver mudanca:

- `npm run build`
- `npm test --if-present`

Se houver workspace/backend configurado:

- `npm test --workspace backend --if-present`

## Validacao manual minima

1. Login com usuario gerencial.
2. Alternar tema claro/escuro.
3. Abrir Campanhas.
4. Trocar grupo de campanhas.
5. Abrir uma campanha existente.
6. Abrir Credenciais.
7. Abrir Consulta de Margem.
8. Abrir Consulta de Telefones.
9. Confirmar que menu lateral nao exibe Clientes, Atendimentos, Propostas, Upload, Bases ou WhatsApp como atalhos principais.
10. Confirmar que envio WhatsApp real exige opt-in ativo.

## Nao aplicavel nesta fase

- Teste E2E completo de disparo.
- Teste real de portal externo.
- Deploy em VPS.
