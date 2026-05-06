# Consulta Cadastral Nova Vida

O modulo **Consulta de Telefones** tambem salva dados cadastrais enriquecidos retornados pelo Nova Vida.

## O que a consulta traz

Quando o Nova Vida retorna dados na tela de cadastro, o CRM tenta capturar:

- nome completo;
- CPF;
- data de nascimento;
- idade;
- sexo;
- nome da mae;
- nome do pai;
- e-mails;
- telefones;
- enderecos;
- dados extras visiveis, como situacao cadastral, RG, persona, signo e score, quando aparecerem.

Campos ausentes ficam vazios. O sistema nao inventa dados.

## Onde os dados ficam

Telefones continuam na tabela:

```text
client_phones
```

Dados cadastrais ficam na tabela:

```text
client_enrichment_data
```

O retorno tecnico completo fica em:

```text
client_enrichment_data.raw_data
```

## Regras de atualizacao

- Telefones novos sao adicionados como alternativos.
- Telefone principal existente nao e substituido automaticamente.
- Nome e e-mail do cadastro principal so sao preenchidos quando estiverem vazios.
- Endereco e demais dados cadastrais ficam no registro de enriquecimento Nova Vida.
- Toda consulta atualiza `nova_vida_last_lookup_at` e `nova_vida_lookup_status`.

## Busca individual

Na aba **Consulta de Telefones**:

1. Selecione o cliente ou digite CPF.
2. Clique em **Buscar no Nova Vida**.
3. A tela mostra Dados principais, Telefones, Enderecos, E-mails e detalhes tecnicos.
4. Se o cliente estiver selecionado, os dados sao salvos no CRM.

## Busca em lote

A fila de busca de telefone usa o mesmo provider. Para cada cliente elegivel, o worker:

1. consulta CPF no Nova Vida;
2. salva telefones;
3. salva dados cadastrais;
4. atualiza o status do enriquecimento.

## Exportacao

A exportacao de clientes inclui:

- data_nascimento;
- idade;
- sexo;
- nome_mae;
- nome_pai;
- email_nova_vida;
- endereco_completo;
- rua;
- numero;
- complemento;
- bairro;
- cidade;
- uf;
- cep;
- telefone_principal;
- telefones_encontrados;
- origem_dados;
- data_consulta_nova_vida.

## Segurança

- Credenciais ficam no `.env`.
- Senha nao deve ser gravada no codigo.
- Logs tecnicos continuam com CPF mascarado.
- A plataforma operacional mostra CPF completo conforme base autorizada da empresa.
- Dados brutos ficam protegidos no banco para auditoria tecnica.
