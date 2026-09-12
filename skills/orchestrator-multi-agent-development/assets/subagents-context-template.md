# Contexto Consolidado dos Subagentes - <NOME DA EXECUÇÃO>

> Entregável obrigatório. Salve na raiz de execução do agente.
> Use este arquivo para preservar o resumo operacional de todos os subagentes Codex/Antigravity executados. Não registre subagentes Claude Code, porque o orquestrador não os executa neste fluxo.

## Resumo Geral

- **Mudança:** `<nome>`
- **Status final:** `<concluída | concluída com pendências | bloqueada | pausada | cancelada>`
- **Ondas executadas:** `<N>`
- **Subagentes executados:** `<N total>`
- **Subagentes por tipo:**
  - `codex-companion.mjs` (Codex, direto): `<N>`
  - `cc-antigravity-plugin:antigravity-coder` (implementacao front-end): `<N>`
  - `cc-antigravity-plugin:antigravity-agent` (review front-end, somente leitura): `<N>`
- **Fallbacks/handoffs realizados:** `<nenhum | resumo>`
- **Gate do usuário:** `<ok | pausado | cancelado>`
- **Pendências globais:** `<nenhuma | lista curta>`

## Linha do Tempo

| Timestamp | Onda | Task | Subagent type | Execucao | Evento | Status |
|---|---|---|---|---|---|---|
| `<ts>` | `<wave>` | `<task>` | `<codex/antigravity>` | `<--effort medium/high | AGY --mode accept-edits --format stream-json --model <agyModel> [--effort <agyEffort>] [--timeout <agyTimeout>] [--parallel] [--subagent-model <model>] | AGY review --read-only --format json --model pro-high --effort high [--timeout <agyTimeout>]>` | `<delegado/DONE/BLOCKED/...>` | `<status>` |

## Contexto por Subagente

### <AGENTE ID OU DESCRIÇÃO> - <TASK ID>

- **Onda:** `<wave>`
- **Task:** `<ID e título>`
- **Subagent type:** `<codex-companion.mjs direto (fallback: codex:codex-rescue) | cc-antigravity-plugin:antigravity-coder (implementacao) | cc-antigravity-plugin:antigravity-agent (review, somente leitura)>`
- **Execucao:** `<--effort medium/high [--write] | AGY --mode accept-edits --format stream-json --model <agyModel> [--effort <agyEffort>] [--timeout <agyTimeout>] [--parallel] [--subagent-model <model>] | AGY review --read-only --format json --model pro-high --effort high [--timeout <agyTimeout>]>`
- **Prompt enviado:** `<run/prompts/<taskId>.md | run/prompts/<taskId>-review.md | run/prompts/<taskId>.agy.txt>` / `<N chars>` / `<sha256 curto>`
- **Contexto degradado:** `<nao | sim: N arquivos inline descartados (prompt-overflow-windows)>`
- **Arquivos descartados pelo corte:** `<nenhum | lista com motivo (max-files-exceeded | prompt-overflow-windows | ignored-path | ...)>`
- **Modelo solicitado / resolvido / source / evidence:** `<agyModel>` / `<resolvedModel|N/A>` / `<user|heuristic|adaptive>` / `<agyModelEvidence|N/A>`
- **Conversa / retry / usage / duração / turnos:** `<conversationId|N/A>` / `<--conversation id|--continue|N/A>` / `<usage|N/A>` / `<durationSeconds|N/A>` / `<numTurns|N/A>`
- **Fan-out Gemini:** `<agyParallel: yes|no>`
- **Subagentes Gemini nativos:** `<N | N/A>`
- **Conversation IDs dos subagentes:** `<lista | N/A>`
- **Status canônico final:** `<DONE | BLOCKED | FAILED | STALLED | UNKNOWN | CANCELLED>`
- **reasonCode operacional:** `<N/A | QUOTA_EXHAUSTED | QUOTA_EXAUSTED | AUTH_REQUIRED | AGY_MISSING | TIMEOUT | NEEDS_SYNC>`
- **Attempt / Session ID / Conversation ID:** `<N>` / `<id | N/A>` / `<id | N/A>`
- **Attempt history:** `<status/reason/model/duration por attempt>`
- **Lease:** `<owner / acquiredAt / expiresAt / releasedAt | N/A>`
- **Workspace:** `<shared|isolated>` / `<path>` / `<branch>` / base `<sha>` / head `<sha>` / integration `<status>`
- **commitBefore / commitAfter:** `<sha | N/A>` / `<sha | N/A>`
- **startedAt / lastActivityAt:** `<ts | N/A>` / `<ts | N/A>`
- **apiCalls / toolCalls / currentTool:** `<N>` / `<N>` / `<tool | N/A>`
- **Tokens usados:**
  - Input: `<N ou N/A>`
  - Output: `<N ou N/A>`
  - Cache read: `<N ou N/A>`
  - Total: `<N ou N/A>`
- **Resumo entregue:** `<2-5 linhas>`
- **Arquivos criados/alterados:**
  - `<caminho>`
- **Decisões relevantes:**
  - `<decisão técnica ou UI/UX>`
- **Testes/validações reportados:**
  - `<comando ou validação>: <resultado>`
- **Evidence IDs / executor-results:** `<lista>` / `<paths persistidos antes do consumo>`
- **Pendências reportadas:** `<nenhuma | lista>`
- **Riscos reportados:** `<nenhum | lista>`
- **Assets materializados:** `<N/A | lista: id, origem, destino, seedBindings, exibido em rota/slot?>`
- **Evidência operacional:** `<mensagem curta quando houve falha/cota/bloqueio>`
- **Limites de sandbox Codex:** `<N/A | nenhum | rede externa bloqueada | pacote ausente no cache | escrita fora do working directory>`
- **Ação do orquestrador:** `<integrado | redelegado | contrato ajustado | decisão do usuário | pendente>`

## Uso de Tokens por Agente

> Agregado dos campos **Tokens usados** dos blocos acima, uma linha por agente/papel. A mesma consolidação vai para `report/implementation-report.md` seção 11a; os dois precisam fechar no mesmo total.

| Agente | Papel | Tasks | input | output | cache_read | total |
|---|---|---|---|---|---|---|
| `codex-companion.mjs` (Codex, direto) | implementacao back-end (`--effort medium`) | `<IDs>` | `<N>` | `<N>` | `<N>` | `<N>` |
| `cc-antigravity-plugin:antigravity-coder` | implementacao front-end (`--mode accept-edits --format stream-json --model <agyModel>`) | `<IDs>` | `<N>` | `<N>` | `<N>` | `<N>` |
| `codex-companion.mjs` (Codex, direto) | review back-end (`--effort high`) | `<N rodadas>` | `<N>` | `<N>` | `<N>` | `<N>` |
| `cc-antigravity-plugin:antigravity-agent` | review front-end (`--read-only --format json --model pro-high --effort high`) | `<N rodadas>` | `<N>` | `<N>` | `<N>` | `<N>` |
| orquestrador | coordenacao, integracao e Fase 9.5 | `<N/A>` | `<N>` | `<N>` | `<N>` | `<N>` |
| **Consolidado** | | | `<N>` | `<N>` | `<N>` | `<N>` |

- `N/A` para dado nao reportado pelo agente ou nao exposto pela plataforma; nunca `0` no lugar de ausente.
- Com `agyParallel: yes`, o total do AGY e o agregado da sessao (inclui os subagentes Gemini nativos); registre o numero de subagentes na coluna Tasks em vez de somar por fora.
- Rodadas de review repetidas por `REPROVADO` somam na mesma linha; registre quantas foram.

## Decisões Cruzadas Entre Subagentes

> Use quando back-end/front-end divergirem ou quando um handoff mudar a execução.

- **Contexto:** `<task/contrato/arquivo>`
- **Divergência ou descoberta:** `<descrição>`
- **Decisão do orquestrador:** `<decisão>`
- **Motivo:** `<por que essa decisão preserva o contrato/negócio>`
- **Subagentes impactados:** `<lista>`

## Riscos e Pendências Consolidados

| Item | Origem | Impacto | Próxima ação | Owner |
|---|---|---|---|---|
| `<risco/pendência>` | `<task/agente>` | `<baixo/medio/alto>` | `<ação>` | `<owner>` |

## Contexto para Retomada

<Explique em 5-10 linhas o estado atual da mudança para alguém retomar sem reler todos os retornos dos subagentes. Inclua o que já foi integrado, o que foi validado, o que ainda exige decisão e quais arquivos/contratos são fonte da verdade.>

- **Run ID / revisão:** `<runId>` / `<revision>`
- **resumeFromPhase / currentWave:** `<fase>` / `<wave>`
- **Tasks UNKNOWN/STALLED:** `<lista | nenhuma>`
- **Probes externos pendentes:** `<sessionId/conversationId + executor | nenhum>`
- **Recomendação por task:** `<VERIFY_BEFORE_REEXECUTE | MONITOR | REEXECUTE | ...>`

## Cancelamento ou Pausa pelo Usuário

> Preencha apenas quando o gate de interrupção disparar.

- **Status:** `<PAUSED | CANCELLED>`
- **Motivo informado pelo usuário:** `<texto curto>`
- **Fase interrompida:** `<fase>`
- **Subagentes em execução no momento:** `<lista | nenhum>`
- **Subagentes concluídos antes da interrupção:** `<lista | nenhum>`
- **Artefatos preservados:** `<proposal/design/tasks/contracts/monitoring/etc.>`
- **Condição para retomada:** `<nova aprovação do plano | contrato revisto | nova instrução explícita | outra>`
