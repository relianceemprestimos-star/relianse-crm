# Changelog do Automation Registry

## 2026-06-01

- Criada estrutura persistente `automation-registry`.
- Adicionados fluxos iniciais para Prefeitura de Ribeirao Preto / SAEC Consiglog, Governo SP / Portal do Consignado, TJSP / Daycoval e Governo do Amapa / APConsig.
- Definida regra de preservacao: fluxo validado nao deve ser sobrescrito sem versao candidata.
- Padronizado caminho de producao com `AUTOMATION_REGISTRY_PATH=/app/automation-registry` e volume Docker `./automation-registry:/app/automation-registry`.
