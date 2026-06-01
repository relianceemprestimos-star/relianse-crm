# Changelog

## 2026-06-01

- Criado `automation-registry` persistente para caminhos validados de consulta de margem.
- Configurado `AUTOMATION_REGISTRY_PATH=/app/automation-registry` e volume Docker `./automation-registry:/app/automation-registry`.
- Integrado helper de registry ao backend antes da execucao dos robos de margem.
- Adicionado registro tecnico de falhas com log, screenshot, HTML e versao candidata sem sobrescrever fluxo validado.

## 2026-05-26

- Backend: adicionada base de protecao de dados sensiveis, rate limit e bloqueio basico de comunicacao sem consentimento.
- Iniciada correcao critica LGPD/seguranca em PRs menores.
- Documentada classificacao USO INTERNO.
- Registradas pendencias: opt-in, rate limit, protecao de dados, testes e vulnerabilidades herdadas qs/xlsx.
- Dependencias: corrigida vulnerabilidade transitiva de `qs` via `npm audit fix`.
- Dependencias: documentada vulnerabilidade remanescente de `xlsx`, sem correcao segura disponivel no pacote npm oficial nesta data.
- Dependencias: registrada mitigacao operacional para uso de planilhas somente em area autenticada e com limite de upload.
