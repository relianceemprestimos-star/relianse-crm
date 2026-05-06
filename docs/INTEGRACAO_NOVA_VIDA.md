# Integração Nova Vida

Este módulo prepara o Relianse CRM para buscar telefones no sistema autorizado Nova Vida dentro do fluxo comercial.

## Regras de uso

- A busca automática só considera clientes com margem disponível.
- Clientes sem margem não entram automaticamente na fila.
- Clientes que já possuem telefone ativo não são consultados novamente, salvo ação manual de atualização.
- Clientes com status `sem_interesse`, `bloqueado`, `nao_abordar` ou equivalente não entram na busca automática.
- A origem dos telefones salvos é registrada como `Nova Vida`.
- Senhas não ficam em código nem em logs.
- CAPTCHA, 2FA ou bloqueio do portal retornam `requires_manual_login`.

## Variáveis de ambiente

Configure no `.env` da VPS:

```env
PHONE_LOOKUP_ENABLED=true
PHONE_LOOKUP_MAX_PER_RUN=50
PHONE_LOOKUP_DELAY_SECONDS=5
PHONE_LOOKUP_SOURCE=nova_vida
NOVA_VIDA_URL=https://congonhas.novavidati.com.br
NOVA_VIDA_USERNAME=
NOVA_VIDA_USER=
NOVA_VIDA_PASSWORD=
```

`NOVA_VIDA_USERNAME` e `NOVA_VIDA_USER` permitem separar e-mail/usuário quando o portal pedir dois campos.

## Busca individual

Na tela de Atendimento, use:

`Buscar telefone no Nova Vida`

Isso cria um job para o cliente atual, executa a busca e salva os telefones retornados.

## Busca em lote

Na Fila de Clientes, use:

`Buscar telefones com margem`

O CRM cria jobs apenas para clientes elegíveis:

- CPF válido;
- margem maior que zero;
- sem telefone ativo;
- fora de status de recusa/bloqueio.

## Logs

Arquivo:

```text
logs/phone_lookup.log
```

O log registra CPF mascarado, status, quantidade de telefones e duração. Não registra senha.

## Estado atual do provider

O backend já possui:

- tabelas `client_phones` e `phone_lookup_jobs`;
- normalizador de telefone para formato `+55`;
- fila de busca;
- rotas de busca individual e em lote;
- tela de telefones no atendimento;
- indicadores na fila.

O provider Nova Vida está preparado para operar com credenciais no `.env`, mas o fluxo visual real do portal ainda precisa ser mapeado com seletores/API autorizados. Enquanto isso, se não houver mapeamento completo, retorna `requires_manual_login` em vez de consultar de forma insegura.

## Teste controlado com fixture

Para testar sem consultar o portal real, crie um JSON fora do Git e configure:

```env
NOVA_VIDA_FIXTURE_PATH=/app/data/nova_vida_fixture.json
```

Formato:

```json
{
  "00000000000": {
    "phones": [
      {
        "number": "(16) 99999-9999",
        "quality": "bom",
        "type": "celular",
        "raw_label": "celular / qualidade boa"
      }
    ]
  }
}
```

## Próxima etapa técnica

Mapear o HTML real do Nova Vida:

- campos de login;
- campos de pesquisa;
- tabela/lista de telefones;
- mensagens de sessão expirada, bloqueio ou CAPTCHA.

Após esse mapeamento, o arquivo `novaVidaProvider.js` deve executar a consulta real com Playwright/API autorizada.
