# Automacao de Margem — Prefeitura de Guarulhos

Automacao preservada para consulta de margem no portal ProConsig.

## Uso operacional

- Convenio: Prefeitura de Guarulhos
- Portal: ProConsig
- URL: https://proconsig.com.br/consulta_margem
- Identificador principal do robo: matricula
- CPF tambem pode existir na base, mas o portal retorna/permite o caminho operacional por matricula.

## Entradas esperadas

Arquivo XLSX com, no minimo:

- `NOME`
- `COD_FUNC`

`COD_FUNC` e a matricula usada na consulta.

## Variaveis de ambiente

Configure apenas no ambiente seguro da VPS/local. Nao commitar valores reais.

```bash
export PROCONSIG_CPF="[REDACTED_SECRET]"
export PROCONSIG_PASSWORD="[REDACTED_SECRET]"
```

## Comando

```bash
python3 guarulhos_proconsig_lote.py \
  --input /caminho/base-guarulhos.xlsx \
  --output /caminho/resultado-guarulhos.xlsx \
  --checkpoint /caminho/checkpoint-guarulhos.json
```

## Campos coletados

- Nome retornado no portal
- CPF retornado no portal
- Regime
- Cargo
- Orgao
- Lotacao
- Ultima folha
- Margem Cartao de Beneficios/Saque bruta e liquida
- Margem Emprestimo/Planos de Saude bruta e liquida
- Margem Cartao de Credito Consignado bruta e liquida

## Seguranca

Nao commitar outputs, checkpoints, HTML de portal, CPF, credenciais ou bases reais. A pasta acima ignora esses arquivos por padrao.
