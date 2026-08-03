# Changelog

## 2026-05-26

- Adicionado modulo inicial de campanhas ReWhats no CRM com coeficiente do dia, oportunidades, criacao de disparo e acompanhamento.
- Adicionado modo pre-disparo com dry-run, status PRONTA_PARA_DISPARO e trava backend contra disparo real.
- Adicionado modulo inicial de documentos com checklist por banco, webhook ReWhats e telas de acompanhamento.
- Adicionada base minima de consentimento para comunicacao por canal.
- Bloqueada abertura/envio de WhatsApp pelo CRM quando nao ha opt-in ativo.
- Adicionado opt-out interno por canal.
- Adicionado audit log para login, mudancas de status, comunicacao e consentimento.
- Adicionados utilitarios centrais de mascaramento, hash e criptografia AES-256-GCM.
- Adicionados Helmet e rate limits para rotas globais, login, comunicacao e consultas sensiveis.
- Adicionados testes minimos de seguranca/LGPD.
- Documentado que o CRM permanece apenas para uso interno controlado.
