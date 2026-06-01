# Automation Registry

Registro persistente de caminhos validados de consulta de margem.

O backend consulta este diretorio antes de executar automacoes. Fluxos com `status: "validado"` sao reutilizados e nao devem ser sobrescritos sem nova versao.

Em Docker/VPS, o caminho recomendado e configurado por:

```text
AUTOMATION_REGISTRY_PATH=/app/automation-registry
```

O `docker-compose.yml` monta `./automation-registry:/app/automation-registry`, preservando os artefatos de execucao no disco da VPS.

Estrutura principal:

- `convenios/`: arquivos JSON por convenio/portal.
- `runs/logs/`: falhas tecnicas persistentes, fora do Git.
- `runs/screenshots/`: screenshots ou placeholders tecnicos da falha, fora do Git.
- `runs/html-dumps/`: HTML capturado no ponto de falha, fora do Git.
- `CHANGELOG.md`: historico de alteracoes do registry.
