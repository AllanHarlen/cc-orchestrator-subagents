# Lifecycle Manager e telemetria

## Adapters de executor

Status Codex/AGY são normalizados por adapters conservadores. Payload desconhecido é `UNKNOWN`, nunca sucesso. O lifecycle aceita snapshots (`--codex-file`, `--agy-file`) ou um adapter de controle executável sem shell:

```json
{
  "codex": {
    "probe": { "command": "codex-control", "args": ["status", "{sessionId}"] },
    "interrupt": { "command": "codex-control", "args": ["stop", "{sessionId}"] },
    "dispatch": { "command": "codex-control", "args": ["retry", "{taskId}"] }
  }
}
```

Placeholders disponíveis em `args` e `cwd`: `taskId`, `executor`, `sessionId`, `conversationId`, `attempt`, `projectRoot`, `artifactDir`, `reason`. `command` é fixo, nunca interpolado; a execução usa `shell: false`; `cwd` deve permanecer dentro do projeto. Timeout, buffer e o resultado estruturado devolvido ao contexto têm limites explícitos (o último, 128 KiB). stdout JSON é preferido; stderr/output são limitados e secrets conhecidos são redigidos. O schema está em `assets/executor-control-config.schema.json`.

O lifecycle persiste a resposta em `run/executor-results/` antes de heartbeat/reconcile. `interrupt` e `retry` exigem adapter ou confirmação explícita de uma ação externa já realizada.

## Scheduler

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-lifecycle.mjs" tick --dir <run> --adapter-config <json>
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-lifecycle.mjs" watch --dir <run> --interval-seconds 30 --max-ticks 100
```

Progresso renova heartbeat e lease; silêncio produz `STALLED`, grace e depois `INTERRUPT_THEN_RECONCILE`. Retry é proibido antes de reconciliar e confirmar que a sessão antiga não está viva.

### Monitoramento do contrato de repasse de cota

Quando `quotaFallbackChain` está `enabled` (ver `Política de quota` no SKILL.md), cada troca de Executor por cota grava uma entrada em `state.json.quotaHandoffs[]`:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/quota-fallback.mjs" record --dir <run> --task <id> \
  --from <executor> --to <executor> --reason-code QUOTA_EXHAUSTED --chain-position <n>
node "${CLAUDE_SKILL_DIR}/scripts/quota-fallback.mjs" list --dir <run>
node "${CLAUDE_SKILL_DIR}/scripts/quota-fallback.mjs" mark-recovery-checked --dir <run> --task <id> --status RESTORED
```

No mesmo ciclo de heartbeat/sweep, percorra a saída de `list` filtrando `quotaRecoveryCheck: "PENDING"` e reaproveite o mesmo probe estruturado de `adaptExecutorProbe` (`executor-adapters.mjs`) para sondar se o Executor original (`fromExecutor`) voltou a ter cota disponível; atualize para `RESTORED` com `mark-recovery-checked`, ou mantenha `PENDING`. Isso é só informativo/telemetria — **nunca** reabre nem reexecuta uma task já `DONE` com o Executor de fallback (`toExecutor`).

## Telemetria privacy-first

`.orchestrator/telemetry.jsonl` registra apenas metadados allowlisted: IDs, categorias, modelo, tentativa, timestamps, duração, resultado, reason code/fingerprint, review, regressões e contadores. Os objetos `metadata` e `validationSummary` também são fechados por chave; prompt, conteúdo, diff, source code, secrets, credentials, raw output e qualquer campo arbitrário são recusados inclusive quando aninhados.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-telemetry.mjs" project --dir <run>
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-telemetry.mjs" report --detailed
node "${CLAUDE_SKILL_DIR}/scripts/orchestration-telemetry.mjs" compact --retention-days 365
```

Compactação é dry-run por padrão e cria backup antes de aplicar. O schema é `assets/telemetry-event.schema.json`.

## OTLP

`otlp-preview` gera OTLP/HTTP JSON de logs sem conteúdo do usuário. `otlp-export --endpoint` faz envio somente quando explicitamente invocado. HTTPS é obrigatório fora de localhost, salvo `--allow-insecure` consciente.
# Contrato de tentativa e consumo

Cada attempt registra executor, modelo, sessionId/conversationId, timestamps proprios, `activeDurationMs`, `queueDurationMs`, `userWaitDurationMs` e `usage` (`inputTokens`, `outputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `totalProcessedTokens`). Quando o executor nao expuser usage, grave `usage:null` e identifique-o em `usageMissingExecutor`; nao publique um total global como conhecido.

Nao aplique timestamps terminais em lote. Antes de retry, feche o attempt anterior; o state engine converte um attempt RUNNING superado em `UNKNOWN/RETRY_SUPERSEDED_ATTEMPT`. Um mesmo attempt gera no maximo um outcome terminal. Nao repita chamada quando o hash dos inputs nao mudou. Gates de correcao permitem no maximo duas rodadas; depois disso, `BLOCKED` com findings consolidados.
