# Especificação — Aba Campanhas (CRM Consignado)

**Versão:** 2.0
**Data:** 22/07/2026
**Changelog v2:** regra de próximo cliente, timeout de reserva, máquina de estados, validação de fechado, taxa de conversão precisa, fluxo de retornos, produtos/bancos fixos, limites de upload, retenção de histórico, comportamento offline, testes de concorrência.

---

## PREMISSAS DE IMPLEMENTAÇÃO

Antes de alterar qualquer arquivo, faça uma auditoria da arquitetura atual para identificar:

* stack do frontend;
* stack do backend;
* estrutura de rotas;
* autenticação;
* perfis e permissões;
* banco de dados;
* cadastro atual de clientes;
* integrações existentes com Datafour;
* automação de consulta de margem da Prefeitura de Ribeirão Preto;
* estrutura atual de campanhas;
* armazenamento de documentos;
* histórico de atendimentos;
* componentes visuais reutilizáveis;
* padrões de layout já utilizados no sistema.

Não crie um aplicativo paralelo.

Não crie novo login.

Não substitua a arquitetura existente.

Não altere globalmente o design do CRM.

Não mexa em integrações, automações, páginas ou módulos que não sejam necessários para esta implementação.

Faça uma evolução incremental dentro da estrutura atual.

Antes de implementar, produza um relatório curto da auditoria contendo:

1. Arquivos e módulos envolvidos.
2. Estrutura atual que será reaproveitada.
3. Alterações necessárias no banco.
4. Alterações necessárias no backend.
5. Alterações necessárias no frontend.
6. Riscos encontrados.
7. Plano de implementação incremental.

Depois da auditoria, implemente a primeira versão funcional conforme os requisitos abaixo.

---

## OBJETIVO

Transformar a aba **Campanhas** em uma mesa operacional de atendimento de crédito consignado.

O fluxo principal deve ser:

1. O vendedor abre a aba Campanhas.
2. Escolhe uma campanha disponível.
3. Clica em "Iniciar atendimento".
4. O sistema apresenta um cliente da campanha.
5. O vendedor consulta ou visualiza dados cadastrais.
6. O vendedor consulta ou visualiza as margens.
7. O vendedor entra em contato com o cliente.
8. Registra observações.
9. Seleciona uma tabulação.
10. Salva o atendimento.
11. O sistema apresenta o próximo cliente.

---

## MÁQUINA DE ESTADOS DO ATENDIMENTO

O atendimento segue uma máquina de estados com transições válidas definidas abaixo. Nenhuma transição fora deste diagrama é permitida.

```
disponível
  → reservado (vendedor clica "Iniciar atendimento")

reservado
  → em_atendimento (mesa de atendimento é carregada)
  → disponível (cancelamento, timeout ou liberação gerencial)

em_atendimento
  → tabulado:negociando (vendedor salva com tabulação "Negociando")
  → tabulado:sem_interesse (vendedor salva com tabulação "Sem interesse")
  → tabulado:sem_contato (vendedor salva com tabulação "Sem contato")
  → tabulado:fechado_aguardando (vendedor salva com tabulação "Fechado")
  → disponível (cancelamento, timeout ou liberação gerencial)

tabulado:negociando
  → disponível (retorno agendado passa, ou fila reciclada)
  → reservado (novo atendimento iniciado)

tabulado:sem_interesse
  → disponível (imediatamente disponível para reabordagem)

tabulado:sem_contato
  → disponível (imediatamente disponível para nova tentativa)

tabulado:fechado_aguardando
  → fechado_validado (gerencial confirma)
  → tabulado:negociando (gerencial devolve — documentação incompleta, dados incorretos)

fechado_validado
  → (estado final para o ciclo da campanha)
```

Estados impossíveis que o sistema deve impedir:

* `fechado` sem tabulação preenchida;
* `reservado` sem vendedor associado;
* `em_atendimento` com dois vendedores;
* `tabulado` sem observação mínima;
* `fechado_aguardando` sem os campos obrigatórios de fechamento.

---

## CAMPANHAS INICIAIS

Cadastrar ou disponibilizar visualmente três campanhas:

### Prefeitura de Ribeirão Preto

Status: **Ativa.**

Essa será a única campanha funcional no piloto.

### Governo do Estado de São Paulo

Status: **Em standby.**

O botão de iniciar atendimento deve ficar desabilitado.

Mostrar a mensagem: "Campanha ainda não liberada para atendimento."

### Prefeitura de São Paulo

Status: **Em standby.**

O botão de iniciar atendimento deve ficar desabilitado.

Mostrar a mensagem: "Campanha ainda não liberada para atendimento."

Estados visuais:

* verde: ativa;
* cinza: standby;
* amarelo: pausada;
* vermelho: erro ou indisponibilidade.

---

## REGRA DE CONVÊNIO

Cada campanha pertence a um único convênio.

No piloto, os clientes da campanha Prefeitura de Ribeirão Preto pertencem somente a esse convênio.

Não é necessário permitir que o mesmo cliente participe de duas campanhas neste primeiro momento.

Mesmo assim, não duplique registros de clientes desnecessariamente caso o sistema já possua um cadastro central.

Reaproveite o cadastro de clientes existente.

---

## DISTRIBUIÇÃO E ORDEM DOS CLIENTES

### Ordem padrão de distribuição

Quando o vendedor clica "Iniciar atendimento" ou "Salvar e próximo cliente", o sistema entrega o próximo cliente seguindo esta ordem:

1. **Retornos agendados para o vendedor atual cuja data/hora já passou ou é agora.** Prioridade absoluta — o vendedor agendou, ele recebe.
2. **Fila geral por ordem de inserção na campanha (FIFO)**, excluindo clientes com reserva ativa no momento.

O gerencial pode reordenar a fila futuramente. Nesta fase, a ordem FIFO é fixa.

### Critérios que NÃO devem impedir atendimento

Não criar prioridade automática nem bloqueio baseado em:

* cliente nunca trabalhado;
* margem positiva;
* telefone válido;
* dados atualizados;
* número de tentativas;
* contato recente;
* resultado anterior.

Um cliente pode ser trabalhado novamente porque:

* a oferta pode ter mudado;
* outro vendedor pode fazer uma abordagem melhor;
* o cliente pode mudar de opinião;
* a margem pode mudar;
* pode existir refinanciamento mesmo sem margem;
* pode existir uma nova fonte de telefone;
* a situação comercial pode mudar de um dia para outro.

### Reserva temporária de cliente

A única regra obrigatória é evitar atendimento simultâneo do mesmo cliente.

Quando um vendedor iniciar um atendimento, o cliente deve ficar temporariamente reservado para ele.

Exemplo: "Em atendimento por Maria Silva desde 14:32."

Outro vendedor não pode iniciar o mesmo cliente enquanto a reserva estiver ativa.

### Timeout da reserva

**Timeout padrão: 30 minutos de inatividade.**

Configurável pelo gerencial entre 15 e 120 minutos.

O frontend deve enviar um heartbeat a cada 5 minutos enquanto a mesa de atendimento estiver aberta e ativa. Se o heartbeat parar (vendedor fechou a aba, deslogou, internet caiu), o timer de inatividade começa a contar.

Aos 25 minutos de inatividade (5 minutos antes do timeout), exibir um aviso ao vendedor caso ele retorne: "Sua reserva expira em 5 minutos. Salve o atendimento para não perder os dados."

### Liberação da reserva

A reserva deve ser liberada quando:

* o atendimento for salvo;
* o vendedor cancelar o atendimento;
* a sessão expirar;
* o timeout de inatividade for atingido;
* um usuário gerencial liberar manualmente.

A reserva não pode se transformar em bloqueio permanente.

### Solicitação de liberação

Na tabela de clientes, se o cliente está reservado, mostrar "Em atendimento por Maria desde 14:32".

O gerencial pode clicar "Liberar reserva" a qualquer momento.

O vendedor comum vê apenas o indicador de que o cliente está indisponível e pode pegar outro.

---

## PERFIS E PROTEÇÃO DO CPF

Reaproveitar os perfis existentes.

Considerar pelo menos:

* vendedor;
* master ou gerencial.

### Perfil vendedor

Na tela inicial, tabelas, listas e cards, o CPF deve aparecer mascarado.

Formato: `***.***.***-00`

Manter apenas os dois últimos dígitos visíveis.

O vendedor:

* não pode visualizar CPF completo nas listas;
* não pode copiar CPF completo;
* não pode exportar CPF completo;
* pode consultar Datafour pelo CRM;
* pode consultar margem pelo CRM;
* pode usar o cliente normalmente sem receber o CPF completo no frontend.

O backend pode usar o CPF completo internamente para as integrações.

Não enviar o CPF completo ao frontend do vendedor se isso não for necessário.

### Perfil master ou gerencial

O perfil gerencial pode:

* visualizar CPF completo;
* copiar CPF;
* exportar CPF;
* forçar atualização cadastral;
* forçar nova consulta de margem;
* corrigir dados;
* acessar logs;
* gerenciar campanhas;
* liberar reservas;
* acessar documentos conforme as permissões atuais;
* validar ou devolver atendimentos marcados como "Fechado".

Aplicar a proteção também nas APIs.

Não fazer apenas uma máscara visual no frontend.

---

## TELA INICIAL DA ABA CAMPANHAS

### Cabeçalho

Título: "Campanhas"

Mostrar o estado das integrações:

* "Datafour — Conectado"
* "Margem Ribeirão — Conectado"

### Alerta de retornos agendados

Antes de qualquer outro conteúdo, se o vendedor tiver retornos agendados para hoje:

> "Você tem **X retornos agendados** para hoje."

Botão: "Ver retornos"

Ao clicar, filtrar a tabela para mostrar apenas os clientes com retorno agendado para o vendedor logado.

Retornos atrasados (data/hora já passou sem atendimento) ficam destacados em amarelo com o texto: "Retorno atrasado — agendado para DD/MM às HH:MM".

### Cards de campanhas

Mostrar os três convênios:

* Prefeitura de Ribeirão Preto;
* Governo do Estado de São Paulo;
* Prefeitura de São Paulo.

Cada card deve mostrar:

* nome;
* status;
* total de clientes, quando disponível;
* quantidade atendida;
* quantidade negociando;
* quantidade fechada (validada);
* botão para abrir.

Nas campanhas em standby, desabilitar ações operacionais.

### Indicadores da campanha ativa

Mostrar:

* total de clientes;
* atendimentos realizados;
* negociando;
* sem contato;
* sem interesse;
* fechados (aguardando validação);
* fechados (validados);
* retornos agendados;
* valor total fechado (apenas validados);
* taxa de conversão.

#### Definição da taxa de conversão

```
Taxa de conversão = Fechados validados / Atendimentos concluídos no período
```

**Atendimento concluído** = qualquer atendimento com tabulação salva (Negociando, Sem interesse, Sem contato ou Fechado).

Clientes ainda não trabalhados **não** entram no denominador.

Clientes em atendimento ativo (reservados, sem tabulação) **não** entram no denominador.

Somente atendimentos com status `fechado_validado` entram no numerador.

### Tabela de clientes

Mostrar pelo menos:

* nome;
* CPF mascarado ou completo conforme o perfil;
* telefone principal;
* margem líquida consignado;
* última atualização da margem;
* último atendimento;
* status;
* vendedor atual, se estiver reservado;
* indicador de retorno agendado, se houver.

Não tornar a tabela o único fluxo de atendimento.

A ação principal deve ser o botão: "Iniciar atendimento".

---

## MESA DE ATENDIMENTO

Ao clicar em "Iniciar atendimento", abrir uma tela ou painel de atendimento contendo três áreas.

### Área 1: informações do cliente

Mostrar:

* nome;
* CPF conforme permissão;
* data de nascimento;
* matrícula;
* convênio;
* cidade;
* estado;
* e-mail;
* endereço;
* telefones.

### Área 2: dados, margem e histórico

Mostrar:

* integração Datafour;
* botão de atualização cadastral;
* margens;
* botão de consulta de margem;
* histórico de atendimentos;
* histórico de atualizações;
* histórico de margens.

### Área 3: finalização do atendimento

Mostrar:

* tabulação;
* submotivo;
* observação;
* próximo contato;
* dados da negociação;
* documentos, quando fechado;
* botão "Salvar atendimento";
* botão "Salvar e próximo cliente".

### Comportamento offline / conexão instável

Se a conexão cair durante o atendimento:

1. Manter os dados preenchidos no formulário local (state do componente, não depender de chamada ao servidor para preservar o que foi digitado).
2. Exibir banner: "Conexão perdida. Seus dados estão salvos localmente."
3. Ao reconectar, exibir botão: "Tentar salvar novamente."
4. Se o timeout de reserva expirar durante a desconexão, ao reconectar informar: "Sua reserva expirou. Os dados preenchidos foram preservados — salve como rascunho ou inicie novo atendimento."

Não perder o que o vendedor digitou.

---

## INTEGRAÇÃO DATAFOUR

O CRM já possui conexão com o Datafour.

Reaproveitar a integração existente.

Não recriar a automação do zero sem antes verificar o código atual.

### Status da conexão

Criar um componente visual com os estados:

* conectado (verde);
* desconectado (vermelho);
* conectando (amarelo);
* sessão expirada (vermelho);
* erro de autenticação (vermelho);
* consulta em andamento (azul ou indicador neutro).

Quando conectado: "Datafour conectado"

Quando desconectado: "Datafour desconectado"

Botão: "Reconectar Datafour"

Ao clicar, mostrar etapas:

1. "Conectando ao Datafour..."
2. "Validando sessão..."
3. "Datafour conectado."

Em caso de erro, mostrar mensagem clara para o vendedor:

"Não foi possível conectar ao Datafour. Tente reconectar."

Detalhes técnicos ficam no log gerencial.

### Regras de consulta Datafour

Consultar os dados quando:

* o cliente não possuir dados cadastrados;
* a última atualização tiver mais de 90 dias.

Não consultar novamente quando os dados tiverem sido atualizados há menos de 90 dias.

Nesse caso, mostrar: "Dados atualizados há X dias." com a data da última atualização.

Permitir atualização forçada somente para usuário gerencial.

Ao consultar:

* preservar os dados antigos até a consulta ser concluída;
* não apagar informações caso a consulta falhe;
* registrar data, horário, usuário, resultado e origem;
* mostrar ao usuário o que foi atualizado;
* não apagar telefones adicionados manualmente;
* não apagar observações manuais;
* não substituir silenciosamente dados importantes.

Quando houver alteração, registrar:

* telefone adicionado;
* endereço atualizado;
* e-mail atualizado;
* dado mantido;
* nenhum dado novo encontrado.

---

## TELEFONES

O cadastro deve permitir múltiplos telefones.

Cada telefone deve guardar:

* número;
* tipo;
* origem;
* data de inclusão;
* usuário responsável;
* nome da pessoa relacionada, se aplicável;
* relação com o cliente, se aplicável;
* observação;
* status;
* indicação de telefone principal;
* indicação de WhatsApp.

Origens possíveis:

* Datafour;
* importação da campanha;
* informado pelo cliente;
* informado por familiar;
* adicionado manualmente;
* outra fonte.

Botão: "+ Adicionar telefone"

Campos:

* número;
* nome do contato (opcional);
* relação com o cliente (opcional);
* origem;
* observação;
* é WhatsApp;
* tornar principal.

Possíveis status:

* válido;
* inválido;
* não pertence ao cliente;
* telefone de familiar;
* não atende;
* WhatsApp indisponível.

Um telefone manual nunca deve ser removido automaticamente por uma atualização do Datafour.

Se um mesmo número já existir, evitar duplicação e atualizar apenas os metadados necessários.

---

## MARGENS

O CRM já possui automação de consulta de margem da Prefeitura de Ribeirão Preto.

Reaproveitar a integração existente.

### Campos obrigatórios

* margem bruta consignado;
* margem líquida consignado;
* margem bruta cartão;
* margem líquida cartão.

### Informações complementares

* competência;
* data da consulta;
* horário;
* origem;
* status;
* mensagem de retorno;
* histórico de margens.

Exemplo:

"Competência: julho/2026"
"Atualizada em 08/07/2026 às 09:41"
"Origem: Prefeitura de Ribeirão Preto"

Botão: "Buscar margem"

### Regra de atualização da margem

A margem normalmente é atualizada uma vez por mês.

Se já houver uma consulta válida na competência atual, não realizar automaticamente outra consulta.

Mostrar: "A margem deste cliente já foi consultada em julho/2026."

O vendedor pode visualizar a margem atual.

Somente o usuário gerencial pode forçar uma nova consulta dentro da mesma competência.

Permitir nova consulta normal quando:

* a competência mudar;
* a consulta anterior falhar;
* não houver dados;
* o resultado estiver incompleto;
* o sistema identificar que não houve consulta válida.

Mesmo que a margem seja zero, negativa ou indisponível, o cliente continua disponível para atendimento.

Não bloquear atendimento por falta de margem.

O cliente pode ter refinanciamento, portabilidade, cartão, renegociação, outro produto ou alteração futura de margem.

### Histórico de margens

Não substituir o histórico anterior.

Guardar uma linha por consulta ou competência, contendo:

* competência;
* margem bruta consignado;
* margem líquida consignado;
* margem bruta cartão;
* margem líquida cartão;
* data;
* hora;
* resultado;
* origem;
* usuário ou automação responsável.

Mostrar visualmente quando a margem aumentou, diminuiu, zerou, ficou negativa, não foi localizada ou apresentou erro.

---

## TABULAÇÕES

### Tabulações principais

* Negociando;
* Sem interesse;
* Sem contato;
* Fechado.

Manter um campo de observação livre sempre disponível.

### Negociando

Ao selecionar, mostrar campos opcionais:

* produto;
* banco;
* valor estimado;
* parcela estimada;
* prazo;
* taxa;
* data de retorno;
* horário de retorno;
* observação.

**Produtos disponíveis (lista fixa nesta fase):**

* Crédito consignado novo;
* Cartão consignado;
* Refinanciamento;
* Portabilidade;
* Saque complementar.

**Bancos disponíveis (conforme cadastrados no CRM):**

* Banco Futuro;
* BIB;
* Daycoval;
* BMG;
* Santander;
* BB;
* Outro (campo livre).

### Sem interesse

Mostrar:

* motivo;
* possibilidade de novo contato;
* data de nova abordagem;
* observação.

Não bloquear permanentemente o cliente.

### Sem contato

Submotivos:

* não atendeu;
* caixa postal;
* WhatsApp não entregue;
* telefone inválido;
* telefone de terceiro;
* pediu contato em outro horário;
* outro.

Mostrar:

* telefone utilizado;
* próximo contato;
* observação.

### Fechado

Ao selecionar "Fechado", o status inicial do atendimento é **"Fechado — Aguardando validação"**.

Mostrar:

* banco (obrigatório);
* produto (obrigatório);
* valor liberado (obrigatório);
* parcela;
* prazo;
* taxa;
* número da proposta;
* comissão estimada;
* data de fechamento;
* documentação (checklist obrigatório).

#### Fluxo de validação do Fechado

1. Vendedor marca "Fechado" e preenche os campos obrigatórios.
2. Sistema salva como `fechado_aguardando_validacao`.
3. O gerencial recebe um indicador: "X fechamentos aguardando validação."
4. O gerencial revisa os dados e documentos.
5. Se tudo correto: marca como `fechado_validado`. Entra nos indicadores de conversão e comissão.
6. Se incorreto ou incompleto: marca como `devolvido` com motivo. O atendimento volta para `negociando` e o vendedor recebe o aviso: "Fechamento devolvido pelo gerencial. Motivo: [motivo]."

Somente o status `fechado_validado` entra nos indicadores de conversão e valor total fechado.

---

## RETORNOS AGENDADOS

### Criação do retorno

Ao tabular como "Negociando" ou "Sem contato — pediu contato em outro horário", o vendedor pode agendar um retorno com:

* data;
* horário;
* observação.

O retorno fica vinculado ao vendedor que agendou, ao cliente e à campanha.

### Exibição dos retornos

Na tela inicial da aba Campanhas, antes da fila geral, exibir:

> "Você tem **X retornos agendados** para hoje."

Com botão "Ver retornos" que filtra a tabela.

Na tabela de clientes, retornos agendados para o vendedor logado são destacados com ícone de relógio.

### Retornos atrasados

Se a data/hora do retorno já passou sem que o vendedor tenha atendido:

* destacar em amarelo;
* texto: "Retorno atrasado — agendado para DD/MM às HH:MM";
* o retorno atrasado tem prioridade sobre a fila FIFO no "próximo cliente".

### Retornos de outros vendedores

Um vendedor não vê retornos agendados por outro vendedor como prioritários. Se o retorno ficar atrasado por mais de 24 horas, o gerencial recebe alerta e pode reatribuir.

---

## OBSERVAÇÕES

Campo: "Observações do atendimento"

O vendedor deve poder escrever livremente.

Exemplo: "Cliente possui contrato no Santander. Foi apresentada possibilidade de refinanciamento. Pediu retorno amanhã após as 14h."

A observação deve ficar vinculada ao atendimento, ao cliente, ao vendedor e à campanha.

Não sobrescrever observações anteriores.

---

## HISTÓRICO AUTOMÁTICO

Registrar automaticamente eventos importantes:

* atendimento iniciado;
* atendimento encerrado;
* reserva criada;
* reserva liberada;
* reserva expirada por timeout;
* heartbeat recebido;
* Datafour consultado;
* telefone adicionado;
* telefone alterado;
* margem consultada;
* margem alterada;
* tabulação alterada;
* retorno agendado;
* documento anexado;
* proposta fechada;
* fechamento validado pelo gerencial;
* fechamento devolvido pelo gerencial.

Formato visual:

"22/07/2026 14:32 — Atendimento iniciado por Maria."
"22/07/2026 14:34 — Margem consultada."
"22/07/2026 14:38 — Tabulação alterada para Negociando."
"22/07/2026 14:38 — Retorno agendado para 23/07/2026 às 14h."

### Retenção de histórico

* Histórico detalhado de atendimentos: mantido por **24 meses**.
* Histórico de margens: mantido **indefinidamente** (é dado operacional crítico).
* Logs técnicos de integração (Datafour, margem): mantidos por **90 dias**.
* Após o período de retenção, consolidar em resumo mensal (total de atendimentos, tabulações agregadas, margens inicio/fim do mês).

---

## DOCUMENTOS

A documentação será obrigatória quando o atendimento for marcado como "Fechado".

Reaproveitar o armazenamento existente, se houver.

### Checklist inicial

* documento com foto;
* holerite;
* comprovante de endereço;
* dados bancários;
* extrato ou documento adicional;
* contrato assinado.

### Estados

* ausente;
* anexado;
* aguardando validação;
* validado;
* recusado.

### Vinculação

Os documentos devem ficar vinculados ao cliente, ao atendimento, à campanha e à negociação.

### Limites de upload

* **Formatos aceitos:** PDF, JPG, JPEG, PNG.
* **Tamanho máximo por arquivo:** 10 MB.
* **Total máximo por negociação:** 50 MB.
* Nomes de arquivo sanitizados no upload (remover caracteres especiais, espaços → underscore).
* Rejeitar arquivos com extensão não permitida, mesmo que renomeados.
* Validar MIME type do arquivo, não apenas a extensão.

### Permissões

Aplicar as permissões existentes.

Não expor documentos sensíveis a usuários sem autorização.

Registrar download, visualização, upload e exclusão quando a arquitetura permitir.

---

## SALVAR E PRÓXIMO CLIENTE

O botão principal da mesa de atendimento deve ser: "Salvar e próximo cliente"

Ao clicar:

1. Validar os campos obrigatórios da tabulação.
2. Salvar o atendimento.
3. Salvar a observação.
4. Salvar a tabulação.
5. Salvar o agendamento, se houver.
6. Salvar os dados da negociação.
7. Liberar a reserva do cliente.
8. Buscar o próximo cliente disponível (seguindo a regra de ordem: retornos primeiro, depois FIFO).
9. Atualizar os indicadores da campanha.
10. Abrir o próximo atendimento sem retornar à tela inicial.

Também deve existir: "Salvar atendimento" — salva e permanece no cliente atual.

---

## RELATÓRIOS BÁSICOS

Criar indicadores por campanha, vendedor e período.

Mostrar pelo menos:

* atendimentos realizados;
* negociando;
* sem interesse;
* sem contato;
* fechados (aguardando validação);
* fechados (validados);
* retornos agendados;
* retornos atrasados;
* valor fechado (apenas validados);
* taxa de conversão (conforme definição acima);
* quantidade de consultas Datafour;
* quantidade de consultas de margem;
* erros de integração.

Não criar um módulo analítico complexo nesta fase.

---

## LOGS E ERROS

Erros técnicos não devem aparecer de forma bruta para o vendedor.

Para o vendedor, mostrar mensagens como:

* "Datafour desconectado."
* "Não foi possível consultar os dados."
* "Não foi possível consultar a margem."
* "A sessão expirou. Reconecte para continuar."
* "Cliente em atendimento por outro vendedor."
* "Conexão perdida. Seus dados estão salvos localmente."

Para o gerencial, registrar detalhes técnicos:

* endpoint;
* código;
* mensagem;
* stack, quando aplicável;
* horário;
* usuário;
* cliente;
* campanha;
* tentativa;
* integração.

Não gravar senha, token ou credencial sensível em logs.

---

## BANCO DE DADOS

Antes de criar novas tabelas, verificar as entidades existentes.

Reaproveitar o que já existir.

Caso seja necessário, criar ou adaptar estruturas equivalentes a:

* campaigns;
* campaign_clients;
* customer_contacts;
* customer_data_updates;
* margin_history;
* attendances;
* attendance_notes;
* attendance_status_history;
* customer_reservations;
* follow_ups;
* negotiations;
* customer_documents;
* integration_status;
* integration_logs.

Os nomes devem seguir o padrão atual do projeto.

Criar migrations seguras.

Não apagar dados existentes.

Não fazer alterações destrutivas.

Adicionar índices para:

* campaign_id;
* customer_id;
* vendor_id;
* CPF;
* status;
* competence;
* updated_at;
* reserved_until.

---

## SEGURANÇA

Garantir:

* autorização no backend;
* CPF mascarado conforme perfil;
* proteção de documentos;
* validação de upload (formato, tamanho, MIME type);
* limitação de tipos de arquivo (PDF, JPG, JPEG, PNG);
* limitação de tamanho (10 MB por arquivo, 50 MB por negociação);
* prevenção de acesso horizontal entre vendedores;
* proteção contra alteração de campanha por parâmetros manipulados;
* logs sem credenciais;
* consultas parametrizadas;
* validação de entrada;
* tratamento de concorrência na reserva do cliente.

A reserva do cliente deve ser atômica para impedir que dois vendedores recebam o mesmo cliente.

---

## EXPERIÊNCIA VISUAL

Manter o padrão visual existente do CRM.

Não fazer redesign completo.

A tela deve ser limpa, com:

* cards de indicadores;
* campanhas em cards;
* alerta de retornos agendados no topo;
* tabela de clientes;
* painel de atendimento;
* status das integrações;
* margens em quatro cards;
* histórico em linha do tempo;
* tabulação na lateral;
* ações principais destacadas.

Usar verde para ações positivas e conexão ativa.

Usar vermelho somente para erro, desconexão ou ação crítica.

Usar amarelo para alerta, aguardando, conectando ou retorno atrasado.

Não depender apenas de cores. Sempre mostrar texto ou ícone junto da cor.

---

## ESCOPO DA PRIMEIRA ENTREGA

Entregar funcionalmente:

1. Aba Campanhas.
2. Três campanhas visíveis.
3. Prefeitura de Ribeirão Preto ativa.
4. Governo de SP em standby.
5. Prefeitura de SP em standby.
6. Indicadores básicos.
7. Lista de clientes.
8. CPF mascarado para vendedor.
9. CPF completo para gerencial.
10. Iniciar atendimento.
11. Reserva temporária de cliente com timeout de 30 minutos.
12. Heartbeat e aviso de expiração.
13. Mesa de atendimento.
14. Dados do cliente.
15. Integração Datafour reaproveitada.
16. Status da conexão Datafour.
17. Regra de atualização de 90 dias.
18. Inclusão manual de telefone.
19. Preservação de telefones manuais.
20. Consulta de margem Ribeirão.
21. Regra de uma consulta válida por competência.
22. Histórico de margens.
23. Tabulações com produtos e bancos fixos.
24. Campo de observação.
25. Histórico automático.
26. Agendamento de retorno com alerta na tela inicial.
27. Fechado com documentos e fluxo de validação gerencial.
28. Salvar atendimento.
29. Salvar e próximo cliente (retornos primeiro, depois FIFO).
30. Relatórios básicos com taxa de conversão definida.
31. Logs de erro.
32. Comportamento de preservação offline.

---

## FORA DO ESCOPO DESTA FASE

Não implementar agora:

* disparo automático de WhatsApp;
* discador automático;
* ranking ou gamificação;
* simulação completa de todos os bancos;
* campanhas automáticas;
* distribuição baseada em inteligência artificial;
* múltiplos convênios funcionais;
* Gov SP funcional;
* Prefeitura de SP funcional;
* refatoração global do CRM;
* troca de identidade visual;
* criação de aplicativo separado.

---

## TESTES OBRIGATÓRIOS

Criar testes para os fluxos críticos:

1. Vendedor recebe CPF mascarado.
2. Gerencial recebe CPF completo.
3. API não entrega CPF completo ao vendedor.
4. Dois vendedores não recebem o mesmo cliente simultaneamente.
5. Cinco vendedores clicando "Iniciar atendimento" simultaneamente recebem cinco clientes diferentes.
6. Reserva atômica funciona sob concorrência real (teste com requests paralelos, não apenas lógica sequencial).
7. Reserva é liberada ao salvar.
8. Reserva expirada é liberada automaticamente.
9. Heartbeat mantém a reserva ativa.
10. Ausência de heartbeat por 30 minutos libera a reserva.
11. Datafour não consulta dados atualizados há menos de 90 dias.
12. Datafour consulta quando não existem dados.
13. Datafour consulta quando os dados têm mais de 90 dias.
14. Falha no Datafour não apaga dados anteriores.
15. Telefone manual não é apagado pelo Datafour.
16. Telefone duplicado não é criado.
17. Margem não é consultada novamente na mesma competência.
18. Gerencial consegue forçar consulta.
19. Vendedor não consegue forçar consulta.
20. Margem zero não bloqueia atendimento.
21. Tabulação salva corretamente.
22. Observações anteriores não são sobrescritas.
23. Fechado exige os campos definidos como obrigatórios.
24. Fechado inicia como "Aguardando validação".
25. Gerencial pode validar fechamento.
26. Gerencial pode devolver fechamento com motivo.
27. Somente fechados validados entram na taxa de conversão.
28. Campanhas em standby não permitem iniciar atendimento.
29. Salvar e próximo cliente libera o atual e reserva o próximo.
30. Próximo cliente prioriza retornos agendados antes da fila FIFO.
31. Retorno atrasado aparece destacado.
32. Permissões de documentos são respeitadas.
33. Upload acima de 10 MB é rejeitado.
34. Upload com formato não permitido é rejeitado.
35. Máquina de estados não permite transições inválidas.

---

## DOCUMENTAÇÃO

Ao finalizar, criar ou atualizar uma documentação contendo:

* arquitetura implementada;
* tabelas ou migrations;
* rotas de API;
* componentes principais;
* permissões;
* regras do Datafour;
* regras de margem;
* regra de reserva e timeout;
* regra de heartbeat;
* regra de mascaramento do CPF;
* máquina de estados do atendimento;
* fluxo de validação do fechamento;
* definição da taxa de conversão;
* regra de distribuição (retornos + FIFO);
* lista fixa de produtos e bancos;
* limites de upload;
* retenção de histórico;
* como ativar Gov SP futuramente;
* como ativar Prefeitura de SP futuramente;
* como testar localmente;
* como fazer deploy;
* variáveis de ambiente necessárias.

---

## FORMA DE EXECUÇÃO

Trabalhe em etapas pequenas.

Após a auditoria:

1. implemente banco e migrations;
2. implemente regras de backend e máquina de estados;
3. implemente permissões;
4. implemente integração com os serviços existentes;
5. implemente a tela inicial com alerta de retornos;
6. implemente a mesa de atendimento com preservação offline;
7. implemente tabulações, histórico e fluxo de validação;
8. implemente documentos com limites de upload;
9. implemente relatórios com taxa de conversão definida;
10. execute testes incluindo concorrência;
11. corrija os erros encontrados;
12. documente.

Não declare que algo foi concluído apenas por ter criado a interface.

Cada função deve estar conectada ao backend e persistir no banco.

Não use dados fictícios em produção.

Mocks podem ser usados apenas nos testes.

Ao final, apresente:

* resumo do que foi implementado;
* arquivos alterados;
* migrations criadas;
* rotas criadas ou alteradas;
* testes executados;
* resultados dos testes;
* riscos ou limitações restantes;
* próximos passos recomendados;
* commit sugerido.
