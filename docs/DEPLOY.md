# Deploy

## Regra principal

Deploy em producao so deve ocorrer com aprovacao explicita do aluno.

Esta fase reorganiza menu, tema, campanhas e documentacao. Ela nao deve publicar automaticamente na VPS.

## Validacao antes de publicar

1. Rodar build do frontend/backend pelo comando principal do projeto.
2. Rodar testes disponiveis.
3. Confirmar que `.env` real nao entrou no Git.
4. Confirmar que Credenciais, Consulta de Margem, Consulta de Telefones e Campanhas abrem.
5. Confirmar que WhatsApp real continua bloqueado sem opt-in ativo.
6. Confirmar que rotas antigas de atendimento/fila ainda respondem via links internos.

## Variaveis importantes

- `FEATURE_CAMPAIGNS_OPERATION_CENTER=true`
- `FEATURE_THEME_TOGGLE=true`
- `WHATSAPP_REQUIRE_ACTIVE_OPT_IN=true`

## Pos-deploy

Depois de publicar, validar no navegador:

- Alternancia de tema claro/escuro.
- Menu lateral simplificado.
- Campanhas filtrando por grupo.
- Credenciais visivel para usuario gerencial.
- Consulta de margem em lote sem regressao.
- Consulta de telefone sem regressao.
