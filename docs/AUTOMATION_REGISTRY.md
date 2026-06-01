# Automation Registry

O `automation-registry` e a memoria operacional persistente dos caminhos de consulta de margem do CRM.

Antes de executar um robo, o backend consulta o registry. Se existir fluxo com `status: "validado"`, o CRM reutiliza URL, etapas e seletores documentados em vez de iniciar uma nova investigacao.

## Onde fica

No projeto:

```text
automation-registry/
  convenios/
  runs/logs/
  runs/screenshots/
  runs/html-dumps/
  CHANGELOG.md
```

Em producao, o Docker Compose define:

```text
AUTOMATION_REGISTRY_PATH=/app/automation-registry
```

e monta o diretorio do projeto:

```text
./automation-registry:/app/automation-registry
```

Assim, os JSONs versionados chegam pela atualizacao do Git e os artefatos de execucao continuam persistidos no disco da VPS. Se a VPS usar outro caminho, configure `AUTOMATION_REGISTRY_PATH`. O backend ainda aceita `AUTOMATION_REGISTRY_ROOT` por compatibilidade, mas o nome recomendado e `AUTOMATION_REGISTRY_PATH`.

## Tipos de arquivo

1. Registry versionado: JSONs e READMEs em `automation-registry/convenios/`. Devem ir para o Git e para o deploy.
2. Logs de execucao: arquivos em `automation-registry/runs/logs/`. Sao gerados automaticamente e ficam fora do Git.
3. Screenshots: arquivos em `automation-registry/runs/screenshots/`. Sao evidencias de falha e ficam fora do Git.
4. HTML dumps: arquivos em `automation-registry/runs/html-dumps/`. Sao evidencias de falha e ficam fora do Git.
5. Versoes candidatas: arquivos `*.candidate.json` criados ao lado do fluxo base quando uma falha exige investigacao. Ficam fora do Git por padrao, devem ser revisados e so entram no versionamento se forem promovidos ou se a equipe decidir auditar a candidata.

## Como o CRM usa

1. A API recebe a consulta ou inicio de sessao do portal.
2. O backend normaliza o convenio (`prefeitura_ribeirao_preto`, `governo_sp`, etc.).
3. O helper carrega o JSON validado do registry.
4. O robo recebe `portal_url`, `consulta_url`, `automation_registry_flow` e `automation_registry_version`.
5. Se o fluxo falhar, a versao validada permanece intacta e a falha e registrada em `runs/`.

## Revalidar caminho

Use o painel tecnico em **Consulta de Margem**. O botao **Revalidar caminho** chama a API de revalidacao tecnica e registra a intencao de revalidacao no log do registry.

A revalidacao nao promove automaticamente uma versao candidata. Depois de confirmar o novo caminho, crie um arquivo novo, por exemplo:

```text
automation-registry/convenios/governo-sp/portal-consignado.v1.1.0-candidate.json
```

Quando aprovado, atualize o arquivo ativo, incremente `fluxo_versao` e registre no `automation-registry/CHANGELOG.md`.

## Adicionar novo convenio

1. Crie uma pasta em `automation-registry/convenios/<convenio>/`.
2. Crie um JSON com `convenio_id`, `portal`, `status`, `ultima_validacao`, `login_url`, `etapas_fluxo`, `seletores_usados`, `falhas_conhecidas`, `regras_fallback`, `evidencias_validacao`, `fluxo_versao` e `observacoes_tecnicas`.
3. Comece com `status: "candidato"` ate validar em ambiente real.
4. Registre a inclusao no changelog.
5. Integre o `convenio_id` ao robo correspondente.

## Regras de seguranca

- Nao gravar senha, token, chave CapSolver ou dados pessoais no registry.
- Logs de falha devem conter CPF mascarado quando houver CPF.
- Nunca apagar versoes antigas sem confirmacao explicita.
- Nunca sobrescrever fluxo validado sem versionamento.
