# Contrato API/UI - <TASK ID OU PAR> - <TITULO>

> Salve em `.orchestrator/runs/<nome>/contracts/<task-id-ou-par>.md`.

## Contract Metadata

- `contractRequired: yes`
- `tasks:` `<T1 | T2 | T1+T4>`
- `consumers:` `<tela/hook/store/componente>`
- `producers:` `<endpoint/handler/controller>`

## Endpoint

`<URL relativa - ex.: /api/reservas/{id}>`

## Metodo HTTP

`<GET | POST | PUT | PATCH | DELETE>`

## Wire Format

### Casing JSON esperado

- request: `<camelCase | PascalCase | snake_case>`
- response: `<camelCase | PascalCase | snake_case>`
- erro: `<camelCase | PascalCase | snake_case>`

### Regras de serializacao

- serializer/config global: `<ex.: JsonNamingPolicy.CamelCase | N/A>`
- atributos por campo: `<ex.: [JsonPropertyName("checkInDate")] | N/A>`
- observacao sobre DTO interno vs payload publico: `<texto>`

### Validacao contra TypeScript

- arquivo/interface TypeScript validada: `<path>`
- estrategia de validacao: `<payload real, fixture, teste, mapper>`
- status: `<confirmado | pendente>`

## Request

### Headers

- `Authorization: Bearer <jwt>`
- `Content-Type: application/json`
- `<outros, se houver>`

### Path params

| Nome | Tipo | Descricao |
|---|---|---|
| `<nome>` | `<tipo>` | `<descricao>` |

### Query params

| Nome | Tipo | Obrigatorio | Descricao |
|---|---|---|---|
| `<nome>` | `<tipo>` | `sim|nao` | `<descricao>` |

### Body

```json
{
  "<campo1>": "<valor exemplo>",
  "<campo2>": "<valor exemplo>"
}
```

## Response

### 200 OK

```json
{
  "<campo1>": "<valor exemplo>",
  "<campo2>": "<valor exemplo>"
}
```

### 201 Created

```json
{
  "<campo1>": "<valor exemplo>"
}
```

### 204 No Content

`<quando aplicavel>`

### Erros 4xx

| Status | Quando | Wire format |
|---|---|---|
| `400 Bad Request` | `<quando>` | `<schema resumido>` |
| `401 Unauthorized` | `<quando>` | `<schema resumido>` |
| `403 Forbidden` | `<quando>` | `<schema resumido>` |
| `404 Not Found` | `<quando>` | `<schema resumido>` |
| `409 Conflict` | `<quando>` | `<schema resumido>` |
| `422 Unprocessable Entity` | `<quando>` | `<schema resumido>` |

Schema de erro padrao:

```json
{
  "errors": [
    {
      "field": "<campo>",
      "code": "<CODE>",
      "message": "<mensagem amigavel>"
    }
  ]
}
```

### Erros 5xx

- `500 Internal Server Error` - nao vaza stack trace; UI mostra mensagem generica.

## Estados de UI

### Loading

- `<spinner inline | skeleton | progress bar | N/A>`

### Erro

- `<toast | banner | mensagem inline | N/A>`

### Empty

- `<card com CTA | mensagem | N/A>`

### Sucesso

- `<toast | redirect | refresh local | N/A>`

## Permissoes

- claim/role/policy: `<valor>`
- regras adicionais: `<texto>`

## Validacoes Back-end

- `<campo>`: `<regra>`
- `<campo>`: `<regra>`

## Validacoes Front-end

- `<campo>`: `<regra espelhada do back-end>`
- `<campo>`: `<regra>`

## Campos Obrigatorios

- `<campo>`
- `<campo>`

## Campos Opcionais

- `<campo>` (default: `<valor>`)
- `<campo>`

## Exemplos Completos

### Request HTTP

```http
POST /api/exemplo HTTP/1.1
Authorization: Bearer eyJ...
Content-Type: application/json

{
  "campoA": "valor",
  "campoB": 2
}
```

### Response HTTP

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "id": "abc-123",
  "campoA": "valor",
  "campoB": 2
}
```

## Checklist de Fechamento do Contrato

- [ ] wire format definido
- [ ] casing JSON definido
- [ ] serializacao documentada
- [ ] TypeScript validado contra payload real
- [ ] exemplos completos incluidos
- [ ] front-end e back-end alinhados

## Decisoes Pendentes

- `<nenhuma>` ou `<decisao>`

## Historico de Alteracoes

| Data | Quem | O que mudou | Motivo |
|---|---|---|---|
| `<data>` | `<orquestrador>` | `<mudanca>` | `<motivo>` |
