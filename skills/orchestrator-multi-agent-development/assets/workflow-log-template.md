# Log de Workflow do Orquestrador - <NOME DA EXECUÇÃO>

> Entregável final obrigatório. Salve na raiz de execução do agente.
> Este arquivo registra a execução completa do orquestrador por fase. Use `run/monitoring.md` como fonte viva de eventos de ondas/subagentes e consolide aqui a linha do tempo auditável.

## 1. Metadados da Execução

- **Execução:** `<nome>`
- **Especificação fonte (PRD/spec):** `<caminho do arquivo ingerido>`
- **Modo de execução:** `<orchestrator | goal>`
- **Comando usado:** `<escreva /orchestrator ou /goal>`
- **Status final:** `<DONE | DONE_WITH_PENDING_ITEMS | BLOCKED | PAUSED | CANCELLED | FAILED | STALLED | UNKNOWN>`
- **Run ID / revisão final:** `<runId>` / `<revision>`
- **Última fase segura / wave atual:** `<lastSafePhase>` / `<currentWave>`
- **Início:** `<timestamp ou N/A>`
- **Fim:** `<timestamp ou N/A>`
- **Orquestrador:** `Claude Sonnet 4.6 medium`
- **Tokens consolidados da execução:** `<total | N/A>` (detalhe por agente em `report/implementation-report.md` seção 11a e `report/subagents-context.md`)
- **Artefatos principais:**
  - `.orchestrator/runs/<nome>/plan/tasks-classification.md`
  - `.orchestrator/runs/<nome>/plan/waves.md`
  - `.orchestrator/runs/<nome>/contracts/`
  - `.orchestrator/runs/<nome>/run/monitoring.md`
  - `.orchestrator/runs/<nome>/review/review-final.md` (review back-end)
  - `.orchestrator/runs/<nome>/review/review-frontend.md` (review front-end)
  - `.orchestrator/runs/<nome>/report/workflow-log.md`
  - `.orchestrator/runs/<nome>/report/subagents-context.md`
  - `.orchestrator/runs/<nome>/report/implementation-report.md`
  - `.orchestrator/runs/<nome>/state.json` + `events.jsonl`
  - `.orchestrator/runs/<nome>/learning/learning-report.md`
  - `.orchestrator/runs/<nome>/evidence/`

## 2. Resumo Executivo do Workflow

<Explique em 3-6 linhas como a execução evoluiu: preflight, planejamento, review, ondas de subagentes, validações, falhas relevantes e status final. Se o workflow foi interrompido, indique a fase e a condição de retomada.>

## 3. Linha do Tempo por Fase

| Fase | Status | Início/Fim | O que aconteceu | Artefatos atualizados | Falhas/observações |
|---|---|---|---|---|---|
| `-1 Goal autonomy` | `<N/A | DONE | BLOCKED>` | `<ts>` | `<usado ou N/A>` | `<links>` | `<observacao>` |
| `0 Preflight` | `<DONE | FAILED>` | `<ts>` | `<resultado do preflight>` | `<N/A>` | `<falhas se houver>` |
| `1 Ingestao da especificacao` | `<status>` | `<ts>` | `<PRD/spec ingerido>` | `<spec fonte>` | `<lacunas bloqueantes se houver>` |
| `2 Classificacao` | `<status>` | `<ts>` | `<tasks classificadas>` | `.orchestrator/runs/<nome>/plan/tasks-classification.md` | `<falhas se houver>` |
| `3 Ondas` | `<status>` | `<ts>` | `<ondas definidas + validate-routing>` | `.orchestrator/runs/<nome>/plan/waves.md` | `<restricoes/erros de roteamento>` |
| `4 Contratos` | `<status>` | `<ts>` | `<contratos criados>` | `.orchestrator/runs/<nome>/contracts/*.md` | `<duvidas/decisoes>` |
| `5 Delegacao paralela` | `<status>` | `<ts>` | `<subagentes lancados>` | `<run/monitoring.md>` | `<falhas se houver>` |
| `6 Monitoramento` | `<status>` | `<ts>` | `<eventos principais>` | `<run/monitoring.md>` | `<SLOW_CHECKIN/cota/tools>` |
| `7 Integracao` | `<status>` | `<ts>` | `<entregas consolidadas>` | `<report/subagents-context.md>` | `<divergencias/fallbacks>` |
| `8 Review back-end (Codex)` | `<status | N/A>` | `<ts>` | `<decisao Codex>` | `<review/review-final.md>` | `<bloqueantes se houver>` |
| `9 Review front-end (AGY read-only/json/pro-high/high)` | `<status | N/A>` | `<ts>` | `<decisao AGY>` | `<review/review-frontend.md>` | `<bloqueantes se houver>` |
| `9.5 E2E navegador` | `<status | N/A>` | `<ts>` | `<fluxos/topologia/waiver>` | `<e2e report>` | `<bloqueantes se houver>` |
| `10 Contexto e relatorios` | `<status>` | `<ts>` | `<entregaveis finais>` | `<workflow-log/subagents-context/implementation-report>` | `<pendencias>` |
| `11 Entrega duravel` | `<status>` | `<ts>` | `<mensagem preparada, ainda nao publicada>` | `<report/implementation-report.md/report/handoff.json>` | `<observacao>` |
| `12 Learning e fechamento` | `<status>` | `<ts>` | `<candidates/history/telemetry/audit/run DONE/verify>` | `<learning/learning-report.md>` | `<contradicoes/bloqueios>` |

## 4. Subagentes Acionados

> Resumo curto. O detalhe completo fica em `report/subagents-context.md`.

| Onda | Task | Subagent type | Execucao | Status final | Link/contexto |
|---|---|---|---|---|---|
| `<wave>` | `<task>` | `<codex:codex-rescue | cc-antigravity-plugin:antigravity-coder (implementacao) | cc-antigravity-plugin:antigravity-agent (review)>` | `<--effort medium/high | AGY --mode accept-edits --format stream-json --model <agyModel> | AGY review --read-only --format json --model pro-high --effort high>` | `<status>` | `report/subagents-context.md#<secao>` |

## 5. Falhas Possíveis Monitoradas

| Falha possível | Fase esperada | Como detectar | Ação padrão |
|---|---|---|---|
| Preflight failed | `0` | `status: failed` no JSON do preflight | cancelar antes de delegar e orientar remediação |
| Especificação insuficiente | `1` | lacuna bloqueante no PRD/spec | resolver via `AskUserQuestion` apenas a lacuna; não abrir discovery |
| Task bloqueada | `5-7` | subagente retorna `BLOCKED` | registrar evidência, atualizar `run/monitoring.md`, pedir decisão ou redelegar com escopo restrito |
| Divergencia de contrato | `6-7` | nomes/tipos/endpoints diferentes entre back-end e front-end | marcar `NEEDS_SYNC`, decidir fonte da verdade e redelegar ajuste |
| Falha de subagente | `5-7` | subagente retorna `FAILED` ou nao entrega artefatos | registrar causa, impacto e proxima acao antes de continuar |
| Resultado indeterminado | `5-7`/resume | sessao anterior terminou sem resultado terminal duravel | marcar `UNKNOWN`, reconciliar executor + Git + arquivos + validacoes; nunca repetir cegamente |
| Stall sem progresso | `5-7` | heartbeat congelado alem do threshold aplicavel | marcar `STALLED`, interromper, aguardar grace period e reconciliar antes de retry |
| Adapter sem status autoritativo | `5-7`/resume | payload ausente/desconhecido | manter `UNKNOWN`; usar evidencia local apenas como corroboracao |
| Conflito de worktree | `7` | integration status `CONFLICT` | persistir conflito, parar e resolver conscientemente; nunca abortar/limpar silenciosamente |
| Memoria/recipe contraditoria | `1`/`12` | `CONFLICT` ou `needsReview` | excluir da memoria ativa/aplicacao e encaminhar ao Curator |
| Cota esgotada AGY | `5-7`, `9` | `quota exceeded`, `rate limit`, `resource exhausted`, `daily limit` ou similar no bridge AGY | marcar `QUOTA_EXAUSTED` e aplicar fallback permitido (review front-end cai para review interno) |
| Cota esgotada Codex | `5-7`, `8` | `quota exceeded`, `rate limit`, `resource exhausted`, `daily limit` ou similar no Codex | marcar `QUOTA_EXHAUSTED` e aplicar fallback permitido (review back-end cai para review interno) |
| Falha de escrita/tool | `5-7` | erro de tool, terminal, escrita ou criação de arquivo | parar agente afetado, registrar parciais e handoff se seguro |
| Sandbox Codex bloqueado | `5-7` | `NU1301`, registry externo inacessivel, pacote ausente no cache local ou `UnauthorizedAccessException` fora do working directory | marcar `BLOCKED`, registrar evidencia e pedir decisao do usuario |
| Review back-end reprovado | `8` | Codex retorna `REPROVADO` | registrar achados, redelegar ajuste ao Codex pela Fase 7 e re-revisar |
| Review front-end reprovado | `9` | AGY retorna `REPROVADO` | registrar achados, redelegar ajuste ao AGY pela Fase 7 e re-revisar |
| Pausa/cancelamento | qualquer | mensagem do usuário ou gate operacional | marcar `PAUSED`/`CANCELLED`, não lançar novos agentes e preservar artefatos |

## 6. Falhas Ocorridas e Recuperação

| Timestamp | Fase | Evento | Evidência curta | Impacto | Status | Ação tomada | Próxima ação |
|---|---|---|---|---|---|---|---|
| `<ts>` | `<fase>` | `<falha ou N/A>` | `<mensagem curta>` | `<baixo/medio/alto>` | `<BLOCKED/FAILED/STALLED/UNKNOWN/etc>` | `<fallback/redelegacao/pausa>` | `<proxima acao>` |

Se nenhuma falha ocorreu, escreva: `Nenhuma falha operacional ocorreu durante esta execução.`

## 7. Decisões do Orquestrador

| Timestamp | Fase | Decisão | Motivo | Impacto |
|---|---|---|---|---|
| `<ts>` | `<fase>` | `<decisao>` | `<por que>` | `<efeito no workflow>` |

## 8. Validações e Evidências

| Validação | Status | Evidência |
|---|---|---|
| Preflight | `<DONE/FAILED>` | `<resumo>` |
| Routing (`validate-routing.mjs`) | `<PASSOU/FALHOU>` | `<resumo>` |
| Project Memory / history | `<VALIDATED/STALE/CONFLICT>` | `<audit/projection>` |
| Worktree plan/integration | `<PASSOU/FALHOU/N/A>` | `<workspaces/commits/conflitos>` |
| Programmatic intelligence | `<PASSOU/FALHOU>` | `<evidence IDs>` |
| Build/lint/typecheck | `<status>` | `<comandos e resultado>` |
| Review back-end (Codex `--effort high`) | `<APROVADO/APROVADO_COM_RESSALVAS/REPROVADO/N/A>` | `review/review-final.md` |
| Review front-end (AGY `--read-only --format json --model pro-high --effort high`) | `<APROVADO/APROVADO_COM_RESSALVAS/REPROVADO/N/A>` | `review/review-frontend.md` |
| Telemetry metadata-only | `<PROJETADA/FALHOU>` | `<eventos/relatorio>` |
| Phase 12 / completion audit / verify | `<DONE/FAILED>` | `<learning report/audit/verify>` |

## 9. Pausa, Cancelamento ou Bloqueio

> Preencha sempre. Se não ocorreu, escreva `N/A`.

- **Status:** `<N/A | PAUSED | CANCELLED | BLOCKED>`
- **Fase interrompida:** `<fase ou N/A>`
- **Motivo:** `<texto curto>`
- **Subagentes em execução no momento:** `<lista | nenhum>`
- **Artefatos preservados:** `<lista>`
- **Condição para retomada:** `<instrucao objetiva | N/A>`

## 10. Checklist Final do Log

- [ ] `report/workflow-log.md` criado na raiz de execução do agente
- [ ] Todas as fases aplicáveis registradas
- [ ] Falhas possíveis consideradas
- [ ] Falhas ocorridas registradas com evidência, impacto e ação
- [ ] Pausa/cancelamento/bloqueio registrado ou marcado como `N/A`
- [ ] Subagentes resumidos e ligados ao `report/subagents-context.md`
- [ ] Validações finais registradas
- [ ] `report/implementation-report.md` referencia este log
- [ ] Integridade `state.json`/`events.jsonl` verificada e `runId` registrado
- [ ] Nenhuma task `UNKNOWN`/`STALLED` foi reexecutada sem reconciliacao
- [ ] Project Memory auditada e history projetado sem fatos nao comprovados
- [ ] Worktrees/leases recuperadas, integradas ou explicitamente bloqueadas
- [ ] Evidence IDs dos scripts deterministas registrados
- [ ] Telemetria metadata-only projetada; nenhum conteudo do usuario persistido
- [ ] Fase 12/learning-report concluida sem promocao automatica
- [ ] `audit.complete=true`, run terminal e history/telemetry reprojetados antes da publicacao
