# Fix Criticos LGPD/Seguranca - 2026-05-26

## Resultado da investigacao

A investigacao concluiu que o CRM Reliance pode continuar em uso interno controlado, desde que os riscos criticos de LGPD e seguranca sejam reduzidos. O projeto nao esta recomendado para SaaS nesta fase.

## Historico operacional

Tentativas locais anteriores aplicaram um pacote maior de correcoes e rodaram validacao com sucesso:

- `npm run build`: passou, com aviso nao bloqueante de bundle Vite acima de 500 kB.
- `npm test`: passou com 4/4 testes.

O PR grande falhou por limite operacional de publicacao do commit completo no GitHub. O plano atual e quebrar as correcoes em PRs menores e revisaveis.

## Este PR

Este PR registra somente documentacao Yntelli e nao altera backend, frontend, `package.json` ou `package-lock.json`.

Tambem registra decisoes operacionais preservadas:

- Nova Vida permanece como busca interna autorizada e nao deve ser bloqueado por regra generica de opt-in.
- Opt-in e opt-out valem para comunicacao ativa por WhatsApp, email ou SMS.
- CPF completo pode ficar disponivel em atendimento individual; listas, filas e dashboards devem usar mascara.
- Variaveis Santana/CapSolver e Nova Vida devem permanecer documentadas sem valores reais.

## Plano em PRs menores

1. Documentacao LGPD e uso interno.
2. Backend seguranca: protecao de dados, rate limit, opt-in e audit log.
3. Frontend: avisos de consentimento e reducao de exposicao de dados sensiveis.
4. Testes minimos de seguranca.
5. Tratamento separado das vulnerabilidades herdadas `qs` e `xlsx`.

## Pendencias

- Implementar consentimento/opt-in no backend.
- Bloquear comunicacao sem consentimento ativo.
- Implementar rate limit em rotas sensiveis.
- Criar utilitario central de mascaramento/hash/criptografia.
- Criar audit log sanitizado.
- Ampliar testes.
- Tratar `qs` moderada e `xlsx` alta em PR separado.
