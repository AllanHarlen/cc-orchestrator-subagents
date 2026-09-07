# Programmatic intelligence

Regra operacional:

```text
>= 3 Greps/Reads, loop de arquivos ou comparação mecânica
  -> script determinístico
  -> JSON compacto + evidenceId
```

Scripts disponíveis:

| Script | Função |
|---|---|
| `inspect-project.mjs` | manifests, frameworks e comandos de validação |
| `inspect-contract.mjs` | seções, placeholders, JSON, casing e gates do contrato |
| `inspect-api-ui.mjs` | DTO C# × tipos TypeScript, inclusive casing |
| `inspect-diff.mjs` | estatísticas e riscos mecânicos do diff |
| `validate-wire-format.mjs` | payload × JSON Schema/exemplo de contrato |
| `validate-task-scope.mjs` | arquivos alterados × allowed paths/shared scope |
| `collect-test-results.mjs` | JUnit/TRX/JSON/texto em resumo único |
| `reconcile-run.mjs` | resume/reconcile + integridade condensada |
| `check-prompt-budget.mjs` | tamanho do prompt persistido contra o limite de 28.000 chars antes de delegar — duro para `--agent agy`, indicativo para `--agent codex` |

Todos:

- recebem caminhos explícitos e recusam traversal fora do projeto;
- limitam arquivos/bytes/output;
- não modificam código produtivo;
- emitem `{schemaVersion, kind, summary, details, evidenceId, generatedAt}`;
- podem persistir em `.orchestrator/runs/<slug>/evidence/` e anexar o ID à task.

Exemplo:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/inspect-api-ui.mjs" \
  --root . --backend src/Api --frontend src/Web \
  --dir .orchestrator/runs/<slug> --task FE-01
```

O schema público é `assets/intelligence-result.schema.json`. O LLM interpreta exceções e decisões novas; comparações repetíveis ficam no código.
