# Automacao de Margem — Prefeitura de Sorriso MT

Automacao preservada para consulta de margem no portal DigitalConsig.

## Uso operacional

- Convenio: Prefeitura de Sorriso MT
- Portal: DigitalConsig
- URL: https://sistema.digitalconsig.com.br/Login.aspx
- Identificador principal do robo: matricula
- CPF tambem pode existir na base, mas o portal retorna/permite o caminho operacional por matricula.

## Entradas esperadas

Arquivo XLSX com a coluna de matricula conforme a base operacional da prefeitura.

## Variaveis de ambiente

Configure apenas no ambiente seguro da VPS/local. Nao commitar valores reais.

```bash
export DIGITALCONSIG_LOGIN="[REDACTED_SECRET]"
export DIGITALCONSIG_PASSWORD="[REDACTED_SECRET]"
```

## Comando

```bash
python3 sorriso_digitalconsig_lote.py \
  --input /caminho/base-sorriso.xlsx \
  --output-xlsx /caminho/resultado-sorriso.xlsx \
  --output-csv /caminho/resultado-sorriso.csv \
  --checkpoint /caminho/checkpoint-sorriso.json
```

## Campos coletados

- Nome retornado no portal
- CPF retornado no portal
- Categoria
- Secretaria
- Datas retornadas pelo portal
- Margem Emprestimo bruta e disponivel
- Margem Cartao bruta e disponivel
- Servicos retornados pelo portal

## Seguranca

Nao commitar outputs, checkpoints, HTML de portal, CPF, credenciais ou bases reais. A pasta acima ignora esses arquivos por padrao.
