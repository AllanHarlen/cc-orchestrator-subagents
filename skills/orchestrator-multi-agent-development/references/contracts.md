# Contratos API/UI

Contrato e obrigatorio sempre que houver troca de dados entre front-end e back-end, mesmo que as tasks estejam separadas como `BACKEND_ONLY` e `FRONTEND_ONLY`.

## Onde salvar

```text
.orchestrator/runs/<nome>/contracts/<task-id-ou-par>.md
```

Use um arquivo por task `FULLSTACK` ou por par dependente front-back quando a classificacao estiver separada.

## Quando `contractRequired` deve ser `yes`

Marque `contractRequired: yes` em `plan/tasks-classification.md` (Fase 2) quando houver qualquer um destes casos:

- endpoint novo ou alterado;
- resposta JSON consumida por tela, hook, store, form ou componente;
- request enviado pelo front-end para API;
- ajuste de validacao compartilhada;
- mudanca de status code, payload de erro, paginacao, filtros ou serializacao.

Marque `contractRequired: no` apenas quando nao existir troca de dados front-back naquela task.

## Conteudo minimo obrigatorio

Use `assets/contract-template.md` e preencha:

1. endpoint e metodo HTTP;
2. wire format:
   - casing JSON esperado;
   - nomes exatos dos campos;
   - tipos JSON reais;
   - exemplos completos de request e response;
3. status codes;
4. estados de UI;
5. permissoes;
6. validacoes back-end e front-end;
7. estrategia de serializacao real.

## Regra de wire format

Todo contrato deve ter uma secao explicita de **wire format** com:

- convencao de casing na API (`camelCase`, `PascalCase`, `snake_case`);
- observacoes sobre DTOs internos versus JSON exposto;
- exemplos completos do payload real na rede;
- confirmacao de como validar a serializacao no codigo TypeScript consumidor.

Exemplo de risco que o contrato deve neutralizar:

- DTO C# com propriedades `PascalCase`;
- payload esperado pelo TypeScript em `camelCase`;
- serializer configurado com `JsonNamingPolicy.CamelCase` ou atributos como `JsonPropertyName`.

Se houver stack .NET/C#, deixe explicito no contrato:

- se a API depende de configuracao global de serializacao;
- se algum campo exige atributo de serializacao;
- se o TypeScript foi validado contra o payload real, nao apenas contra o nome da interface.

## Validacao cruzada obrigatoria

Antes de delegar em paralelo, confirme:

- [ ] endpoint definido;
- [ ] metodo HTTP definido;
- [ ] request fechado;
- [ ] response fechada;
- [ ] wire format documentado;
- [ ] casing JSON documentado;
- [ ] exemplos completos incluidos;
- [ ] validacao de serializacao real contra TypeScript registrada;
- [ ] status codes mapeados;
- [ ] permissoes definidas;
- [ ] estados de UI cobertos.

## Quando o contrato muda

Se algum subagente descobrir necessidade de mudanca:

1. nao deixe o agente mudar unilateralmente;
2. marque `NEEDS_SYNC` em `run/monitoring.md`;
3. atualize o contrato;
4. preserve a versao anterior em `<arquivo>.previous.md` quando a mudanca for relevante;
5. notifique todos os agentes dependentes.

## Regra pratica

Se existe payload cruzando a fronteira front-back, existe contrato.
