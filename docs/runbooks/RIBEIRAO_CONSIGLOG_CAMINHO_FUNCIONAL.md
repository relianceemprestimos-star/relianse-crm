# Caminho funcional — Ribeirão / Consiglog

Data: 2026-07-15

## Objetivo

Preservar o caminho que voltou a funcionar para consulta de margem em lote da Prefeitura de Ribeirão Preto no portal Consiglog/SAEC.

Este documento existe para evitar regressão: o robô já rodou esse fluxo em produção e não deve voltar a tratar o pós-login do portal como erro fatal.

## Fluxo validado

1. O backend usa a credencial salva da Central de Credenciais para `prefeitura_ribeirao_preto`.
2. A sessão é iniciada pela rota `POST /api/ribeirao/session/start`.
3. O robô acessa `https://saec.consiglog.com.br/Login.aspx`.
4. Se o portal informar usuário já logado, o robô confirma a desconexão da sessão anterior e reenvia a segunda etapa.
5. Se aparecer `COMPLETE SEU CADASTRO`, o robô preenche o complemento usando o perfil salvo da credencial.
6. Após salvar o complemento, se o portal cair em `Erro.aspx`, o robô deve seguir o link/caminho de volta para `LoginSelecao.aspx` em vez de falhar.
7. Em `LoginSelecao.aspx`, o robô seleciona `PREFEITURA RIBEIRÃO PRETO | SP - RIBEIRÃO PRETO`.
8. O portal precisa chegar em `Inicial/Inicial.aspx` com menu operacional visível.
9. O robô navega para `Margem/ConsultaMargem.aspx`.
10. O lote consulta CPF a CPF e grava retorno positivo, sem margem, não encontrado ou erro.

## Pontos críticos que não podem regredir

- O perfil complementar da credencial deve persistir em volume de dados, não dentro da imagem Docker.
- O caminho `Erro.aspx -> LoginSelecao.aspx` depois do complemento de cadastro é esperado e não deve ser tratado como erro fatal.
- A mensagem `Usuário já logado` deve derrubar a sessão anterior e seguir o login automaticamente.
- O lote deve aceitar `POST /api/ribeirao/batch/:id/resume` e continuar a partir dos CPFs pendentes.
- A leitura de margem negativa/sem margem precisa ser gravada como resultado válido, não como falha.

## Arquivos responsáveis

- `backend/src/services/credentials/credentialService.js`
  - Define `CREDENTIAL_PROFILE_DIR` em `DATA_DIR/credential_profiles` quando a variável explícita não existir.
  - Evita perder o perfil complementar no rebuild do container.

- `backend/src/services/averbadores/ribeirao/ribeirao_cli.py`
  - Trata usuário já logado.
  - Preenche complemento cadastral quando necessário.
  - Segue `Voltar/LoginSelecao` quando o portal cai em `Erro.aspx` após salvar complemento.
  - Seleciona o convênio de Ribeirão e navega para `ConsultaMargem.aspx`.

## Prova em produção

Em 2026-07-15, após publicar o hotfix, a sessão retornou conectada e o lote #17 saiu do erro antigo.

Contadores observados na retomada:

- Total: 2500
- Processados: 8
- Positivos: 5
- Sem margem: 2
- Erros: 1, herdado da tentativa antes da correção
- Status: `em_andamento`

Logs observados:

- `complete cadastro detectado apos retry; preenchendo antes de novo clique`
- `erro apos salvar complemento; seguindo link Voltar/LoginSelecao`
- `convenio clique executado metodo=locator_click: true`
- `URL depois do clique: https://saec.consiglog.com.br/Inicial/Inicial.aspx`
- `URL depois do clique: https://saec.consiglog.com.br/Margem/ConsultaMargem.aspx`
- `status final do CPF: sem_marg`

## Validação operacional

Comandos seguros usados na VPS:

```bash
curl -fsS http://127.0.0.1:4000/api/health
```

Retomar lote via API autenticada:

```http
POST /api/ribeirao/batch/:id/resume
```

Consultar status:

```http
GET /api/ribeirao/batch/:id/status
```

## Regra de manutenção

Antes de mexer neste fluxo, validar primeiro um lote pequeno de Ribeirão e confirmar que:

- sessão conecta;
- portal chega em `ConsultaMargem.aspx`;
- lote processa mais de 1 CPF;
- resultado sem margem é salvo como negativo/sem margem;
- o painel volta a mostrar progresso.

Nunca publicar alteração neste robô apenas porque o build passou. O fluxo precisa ser testado no portal real.
