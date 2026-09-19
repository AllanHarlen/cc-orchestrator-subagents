![cc-orchestrador-subagents](banner.png)

# cc-orchestrador-subagents

Claude Code plugin to conduct a multi-agent development workflow from an existing PRD/spec, with Codex, Antigravity/AGY and audit artifacts.

> **Legacy `ui-prototype` role blocked (4.24.0):** handoffs that still declare the removed role are blocked with `LEGACY_UI_PROTOTYPE_ROLE`; regenerate them with Pensador >= 2.32.
>
> **Mechanical design gates (4.23.0):** the wave gate now lints changed front-end files for literal hex colors, px spacing/radius and inline `style={{}}` (and undefined `var(--x)`), materialization recomputes `contractSha256` and reads the real `design-audit.json` instead of trusting the handoff's `validation.status`, and the design flags of the final UI gate need mechanical evidence files (`designEvidence.tokenLint`/`previewDiff`), not booleans.
>
> **Design handoff (4.22.0):** the visual contract in `references/handoff-contract.md` (section 6, byte-identical across the four workflow plugins) now makes `design-systems/<id>/resolved/` the only normative package; `source/` holds engine provenance. The handoff entry carries `contractSha256`, `themes` and `designBriefPath`; a new token only enters through a new Pensador version (`DESIGN_CHANGE_REQUEST`).

**[Leia em Português](README.pt-BR.md)** — Portuguese version available.

## Overview

The `cc-orchestrador-subagents` organizes development as a **persistent multi-agent engineering system** for Claude CLI/Claude Code. Claude is the Main Orchestrator over durable state, verified memory, searchable history, worktrees, deterministic validation, telemetry, and curated learning. It does not do demand discovery or planning — it works exclusively on projects that already have a **PRD or pre-established specs**.

The user provides the specification via file mention (`@docs/prd.md`) or by sending the PRD/spec file. That document is the **source of truth**: the orchestrator ingests it, classifies tasks, builds waves, generates contracts, delegates, monitors, integrates and reviews.

Codex and Antigravity/AGY enter as specialized sub-agents:

| Role | Executor | Responsibility |
|---|---|---|
| Harness Orchestrator | Claude CLI / Claude Code | Ingests the PRD/spec and coordinates workflow, contracts, waves, validations, logs and user decisions. |
| Back-end implementation, database, tests and adjustments | Codex (direct `codex-companion.mjs` dispatch; fallback `codex:codex-rescue`) | Executes non-front-end tasks with `--model <gpt-5.6-terra|gpt-5.6-sol|gpt-5.6-luna> --effort <low|medium|high> --write`, both derived from the task (role: implement/review/fix — never a fixed default). |
| Front-end implementation and UX | Antigravity/AGY (`cc-antigravity-plugin:antigravity-coder`) | Executes `FRONTEND_ONLY` tasks and front-end slices of `FULLSTACK`, consuming design tokens, generated design-system previews (`preview/`), and real brand assets (`assets/`). |
| Back-end post-implementation review | Codex (direct `codex-companion.mjs` dispatch, no `--write`; fallback `codex:codex-rescue`) | Reviews **back-end only** with `--effort high` or falls back to orchestrator's internal read-only review when quota is exhausted. |
| Front-end post-implementation review | Antigravity/AGY (`cc-antigravity-plugin:antigravity-agent`, `--read-only --format json --model pro-high --effort high`) | Reviews **front-end only** read-only (with design system and visual fidelity gates against `preview/`) or falls back to orchestrator's internal review when AGY is unavailable. |

### Configurable Agent Stack

The table above describes the **default** stack. Which agent actually implements/reviews each role is a per-project choice, persisted in `.orchestrator/project-config.md` and resolved on first run (or any time via `/orchestrator project-config`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/orchestrator-multi-agent-development/scripts/project-config.mjs" show --root "."
```

Four roles — `backendExecutor`, `frontendExecutor`, `backendReviewer`, `frontendReviewer` — each accept `codex`, `agy`, or `claude-code`. Setting a role to `claude-code` routes that role to a Claude Code sub-agent (via the `Agent` tool) instead of an external CLI, with review running read-only into `review/review-final.md`/`review/review-frontend.md`. **Setting all four roles to `claude-code` runs the entire workflow without Codex or AGY installed** — no external CLI is required by preflight in that case. Preflight only requires the `codex`/`agy` CLI and plugin when at least one role is configured to use it.

Preflight also detects two optional MCP servers — the Codebase Memory MCP (`codebase-memory-mcp`, code graph queries used for architecture/impact analysis) and Context7 (up-to-date library docs in sub-agent prompts). Either one missing is a `warnings` entry, never a blocker; see `skills/orchestrator-multi-agent-development/references/mcp-context.md`.

That aggregate check only proves a server is registered *somewhere* on the machine — not that Codex or AGY specifically have it. Run `node scripts/preflight.mjs --check-agent-mcp` to also query `codex mcp list --json`/`agy mcp list` live and get `checks.optional.mcpPerAgent.<agent>.<server>`, with an `install` field carrying the exact `mcp add` command to register it for that agent. Nothing installs automatically: the orchestrator only runs it after the user approves via `AskUserQuestion`, same pattern as the Open Design installer.

### Complete Workflow

- **Phase 0 - Preflight, project configuration and assisted install:** validates dependencies, Node.js 22.13+, `node:sqlite`/FTS5, `Bash(node:*)`, resolves the Project_Config (roles above), detects the two optional MCPs, and offers to install any missing dependency actually required by the resolved roles.
- **Phase 1 - Memory + specification:** audits `.orchestrator/project-memory.md`, projects FTS5 history, and reads the PRD/spec as the source of truth; ingests visual handoff artifacts from Pensador (`tokens.css`, `preview/`, `assets/`); only proven facts supplement context.
- **Phase 2 - Task classification:** records category, dependencies, complexity, contracts, `expectedFiles`/`validationPlan`, `allowedPaths`, executor, and routing features.
- **Phase 3 - Waves, routing, and isolation:** applies heuristic floors, consults comparable history when sufficient, validates routing, and separates isolated worktrees from scope-overlap serialization.
- **Phase 4 - API/UI contracts and visual materialization:** creates and deterministically validates contracts, wire format, casing, examples, states, and permissions for every front-back exchange, materializes authoritative design packages (`design-materialization.json`), and generates strongly typed contract interfaces and DTOs via `generate-contract-types.mjs`.
- **Phase 5 - Parallel delegation:** creates eligible worktrees, acquires leases, and dispatches tasks; both Codex and AGY receive an explainable selected model, with AGY receiving the generated design-system previews as an authoritative visual spec.
- **Phase 6 - Lifecycle Manager:** polls adapters, persists results before consuming them, renews heartbeat/lease on observable activity, and handles stall/grace/interrupt/retry/cancel without assuming outcomes.
- **Phase 7 - Integration:** performs Early Stack Boot smoke testing (`smoke-test-infra.mjs`) on Wave 1, runs deterministic Wave Quality Gates (`run-wave-gate.mjs`) without LLM tokens, and serially integrates worktrees using deterministic scripts for diff, scope, API/UI, wire format, and validation results before category-specific corrections.
- **Phase 8 - Back-end post-implementation review:** delegates final read-only review to Codex with `--effort high`, **back-end only**, and saves `review/review-final.md`. If Codex runs out of quota, the Orchestrator itself does internal review. Skipped when there is no back-end.
- **Phase 9 - Front-end post-implementation review:** delegates final read-only review to AGY with `--read-only --format json --model pro-high --effort high`, **front-end only**, validating acceptance criteria, design system rules and visual fidelity against `preview/`, and saves `review/review-frontend.md`. If AGY is unavailable, the Orchestrator does internal review. **Skipped when there is no front-end task.**
- **Phase 9.5 - Browser E2E:** required whenever the run has front-end. Drives critical flows in a real browser and verifies CORS, tenant/host resolution, response casing, UI state and the final user-visible effect. A same-origin topology waives the gate explicitly, with a recorded reason — never by silent derivation.
- **Phase 10 - Final reports:** creates `report/workflow-log.md`, `report/subagents-context.md` and `report/implementation-report.md`, generating the Section 13 traceability matrix deterministically via `build-traceability-matrix.mjs`, consolidating timeline, contracts, validations, sub-agents, AGY Conversation IDs and delivery status.
- **Phase 11 - Durable delivery:** prepares and persists the summary/instructions without announcing success before final gates.
- **Phase 12 - Learning and closure:** creates `learning/learning-report.md` and candidate lessons without automatic promotion, projects history/telemetry, requires `audit.complete`, closes/verifies the run, and only then publishes delivery.

Coordination artifacts and final reports live under `.orchestrator/runs/<name>/` (runs created before this version stay at `.orchestration/<name>/`, still read but never migrated).

### Main Operational Rules

- **Usage premise:** the orchestrator only works with a ready PRD/spec. It does not do discovery, planning, or reinterpret the demand.
- **Codex reviews back-end only;** AGY (`pro-high`) reviews front-end only.
- **AGY Fan-out:** `--parallel` and `--subagent-model` activate native Gemini sub-agents within the AGY task. Requires `cc-antigravity-plugin >= 4.0.0`.
- **AGY Model:** the user override and heuristic floor are authoritative; comparable history may only escalate with a minimum sample and `agyModelEvidence`. Review always uses `pro-high`.
- **Verified memory:** only `FILE`, `CONTRACT`, passing `TEST`, durable `RUN_EVENT`, and explicit `USER` sources enter Project Memory; conflicts and stale facts are excluded.
- **Code for mechanics:** three or more reads/greps, loops, and repeated comparisons use `scripts/intelligence`, producing bounded JSON and an evidence ID.
- **Physical isolation:** non-overlapping scopes can use one worktree per task; overlap or unknown scope serializes the wave.
- **Privacy-first telemetry:** only allowlisted metadata is persisted/exported; prompts, content, diffs, source, raw output, and secrets are rejected.
- **Controlled learning:** Phase 12 creates candidates; independent validation precedes Recipes, and Curator supports pin/archive/backup/rollback without auto-delete.
- **Codex Prompts & Effort:** `--effort` is derived from task complexity/risk (`low`/`medium` for CRUDs/isolated tasks; `high` reserved for core architecture and reviews).
- **Mandatory Local Self-Verification:** sub-agents must execute build/typecheck/tests locally in their workspace/worktree (`<BUILD_CMD>` and `<TEST_CMD>`) and achieve exit code 0 before returning `Status: DONE`.
- **Mandatory contracts:** any front-back exchange requires contract before parallelizing.
- **Wire format:** every contract must explicitly state JSON casing, field names, complete examples and real serialization validation.
- **Routing by category:** `FRONTEND_ONLY` goes to Antigravity/AGY, including front-end setup; Codex only assumes front-end as a registered operational fallback.
- **Codex Quota & Back-end Fallback:** when Codex runs out of quota (`QUOTA_EXHAUSTED`), back-end implementation falls back exclusively to AGY with Gemini models (`gemini-3.8-flash-medium` for CRUDs/isolated tasks and `gemini-3.8-flash-high` for architecture/security), strictly prohibiting Claude models; lack of quota on back-end review triggers orchestrator's internal read-only review.
- **Codex Sandbox:** external network blocked for packages/restore, missing package in local cache or write outside allowed working directory becomes `BLOCKED` with evidence.
- **AGY Limit on Windows:** AGY prompts above 28,000 chars are divided into subtasks by deliverables before delegation to avoid `ENAMETOOLONG`.

> **Guard rails (4.21.0):** the run state (`state.json`, `events.jsonl`) is written only by `orchestration-state.mjs` — a `PreToolUse` hook blocks hand-edits; `run --status DONE` refuses a `handoff.json` that fails `validateHandoff()`; the run is conducted in the main session (never delegated to a fork/background agent) and the final recap must disclose skipped, waived or degraded work.

## Installation

Local:

```text
/plugin marketplace add "C:\Users\allan\Desktop\Projetos Pessoais\cc-plugins-allan\cc-orchestrador-subagents"
/plugin install cc-orchestrador-subagents@cc-orchestrador-subagents
```

GitHub:

```text
/plugin marketplace add AllanHarlen/cc-orchestrador-subagents
/plugin install cc-orchestrador-subagents@cc-orchestrador-subagents
```

Validate:

```text
/orchestrator preflight
```

See "Official Dependencies" below for the optional Codex/AGY CLIs and plugins required only by the roles you configure.

## Official Dependencies

The minimum runtime is **Node.js 22.13.0**, where `node:sqlite` is available without the experimental CLI flag, plus SQLite FTS5. Preflight blocks execution without this capability **regardless of agent stack configuration**, because `knowledge.db`, `history.db`, Recipes, and adaptive routing depend on it.

The Codex and Antigravity/AGY dependencies below are only required when the corresponding Project_Config role (`backendExecutor`, `frontendExecutor`, `backendReviewer`, `frontendReviewer`) is actually set to `codex`/`agy` — see "Configurable Agent Stack" above. A project with every role set to `claude-code` needs neither.

`/orchestrator project-config` offers to install both the CLI **and** the Claude Code plugin below through the assisted Dependency_Installer — one confirmation per dependency, no manual step required. The CLI and its plugin are checked (and installed) independently: having one does not imply the other is present. The manual steps below remain valid if you prefer to install by hand.

This plugin depends on the official Codex plugin for Claude Code: https://github.com/openai/codex-plugin-cc.

```text
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/reload-plugins
/codex:setup
```

The marketplace/dependency used in manifests is `openai-codex`. The orchestrator dispatches to it directly via `codex-companion.mjs` (path resolved from `checks.plugins["openai-codex"].companionPath`, published by `scripts/preflight.mjs`); the `codex:codex-rescue` sub-agent is a documented fallback for when that path cannot be resolved.

For front-end, the orchestrator requires `cc-antigravity-plugin >= 4.0.0` and AGY `>= 1.1.8` (`1.1.16` recommended), with these files present in the installed plugin:

- `agents/antigravity-coder.md` (implementation)
- `agents/antigravity-agent.md` (read-only review)
- `commands/antigravity.md`
- `scripts/antigravity-bridge.js`

## How to provide the specification

The orchestrator does not invent the demand. Provide the PRD/spec in one of these ways:

```text
# File mention
/orchestrator @docs/prd-reservations.md

# Spec pasted directly into the argument
/orchestrator "Implement the reservations flow per: <paste the complete specification here>"

# With AGY model override
/orchestrator --model pro-low @docs/prd-reservations.md

# Portuguese alias
/orquestrador @docs/prd-reservations.md
```

If no PRD/spec is provided, the orchestrator asks for the specification before continuing.

## Persistent State and Resume

Every run has a durable state machine in `.orchestrator/runs/<name>/` (or `.orchestration/<name>/` for a run created before this version):

- `state.json` is the current materialized snapshot;
- `events.jsonl` is the append-only write-ahead history used to rebuild the snapshot after a crash.

Resume the latest active run, or select one by `runId`/slug:

```text
/orchestrator resume
/orchestrator resume reservations-20260817-001
```

On resume, any task left as `RUNNING` becomes `UNKNOWN` first. The orchestrator then reconciles executor status, Git, produced files, and validation evidence. Local changes alone never imply success, and an unknown task is never blindly re-executed.

The deterministic state CLI is also available for inspection and integrity checks:

```bash
node scripts/orchestration-state.mjs status
node scripts/orchestration-state.mjs resume <runId>
node scripts/orchestration-state.mjs verify --dir .orchestrator/runs/<name>
```

A run can become `DONE` only with a non-empty task set, evidence plans, resolved scope, completed Phase 12, required artifacts, and completion gates backed by evidence. Terminal runs are immutable. Cancellation interrupts and reconciles executors before closure.

`browserE2E` is required whenever the run has front-end — including a front-end-only run against an existing separate API, which is exactly the case Phase 9.5 exists for. It is also the only gate that accepts an applicability waiver: a same-origin topology must be recorded as an explicit `N/A` with a reason, never derived away from the mix of task categories.

## Memory, History, Intelligence, and Learning

Stable context and accumulated project experience live outside the run directory:

```text
.orchestrator/
  project-memory.md
  knowledge.db
  history.db
  telemetry.jsonl
  learned/
  backups/
```

Main commands:

```bash
node scripts/orchestrator-knowledge.mjs init
node scripts/intelligence/inspect-project.mjs --root . --persist-knowledge
node scripts/orchestrator-knowledge.mjs history-search "NU1301"
node scripts/orchestration-lifecycle.mjs help
node scripts/orchestration-worktree.mjs help
node scripts/orchestration-router.mjs report
node scripts/orchestration-telemetry.mjs report --detailed
node scripts/orchestration-learning.mjs curator-status
```

The slash command also exposes `/orchestrator knowledge status`, `knowledge search`, `knowledge pin`, `knowledge archive`, `knowledge curate`, `knowledge rollback`, `telemetry report`, and `telemetry compact`. Curator/retention operations are dry-run without `--apply`; OTLP is opt-in and metadata-only.

### Full command surface

| Sub-command | What it does |
|---|---|
| `help` | prints the synopsis, sub-commands and flags |
| `preflight` | validates dependencies and exits |
| `project-config` (alias `config`) | shows/changes the project agent stack and revalidates |
| `status [runId]` | run state, read-only (without `runId`, the most recent) |
| `resume [runId]` | resumes the run without assuming the result of an interrupted task |
| `knowledge <sub>` | `status`, `search`, `pin`, `archive`, `activate`, `curate`, `rollback`, `render`, `audit`, `backups`, `history-project` |
| `telemetry <sub>` | `report`, `compact`, `otlp-preview`, `otlp-export` |

`/orquestrador` is the Portuguese alias and accepts exactly the same surface. The previous spelling `/orchestrador` was renamed.

Flags are `--model`, `--parallel`, `--subagent-model`, `--effort` and `--timeout`. The former `--agy-` prefixed names (`--agy-model`, `--agy-parallel`, `--agy-subagent-model`, `--agy-effort`, `--agy-timeout`) remain accepted as silent legacy aliases with identical behavior.

The boundary is intentional: the LLM makes novel decisions; deterministic scripts validate mechanics; history/Recipes recover proven decisions; Project Memory supplies stable context; Codex/AGY implement.

### What to Commit

Every new run lives under `.orchestrator/runs/<name>/`, alongside `project-config.md`, `worktrees/`, `history.db` and `knowledge.db` — one hidden root for everything this plugin writes to your project. (Runs created before this version stay at `.orchestration/<name>/`, read but never migrated; older docs and scripts you may still have around can reference that path.)

**Default: gitignore all of it.** `.orchestration/` and `.orchestrator/` are excluded from the target project's Git history by default (same convention `cc-pensador` already uses for `.pensador/`):

```gitignore
.orchestration/
.orchestrator/
```

This is a deliberate reversal of the previous default, which committed `events.jsonl`, the run's Markdown/handoff artifacts, `project-memory.md`, `learned/` and `knowledge.db`. Versioning that state has a sharp edge: deleting those directories from disk does not remove them from Git — `git status` just shows them as deleted-but-tracked, and the next ordinary commit that rewrites `state.json`/`events.jsonl` at those paths (which any run does) resurrects the old content. If you want the old behavior back (cross-machine `resume`/audit trail via Git), use the narrower opt-in block below instead, and accept the risk it reintroduces — a versioned or `git clean -fdx`'d worktree breaks a running wave, and SQLite in WAL mode conflicts on every concurrent commit:

```gitignore
.orchestrator/worktrees/
.orchestrator/backups/
.orchestrator/history.db
.orchestrator/telemetry.jsonl
*.db-wal
*.db-shm
```

Flipping the default does not retroactively untrack history a project already committed — that needs a dedicated `git rm --cached -r .orchestration .orchestrator` commit; the orchestrator does not automate it. The full per-path table (for the opt-in case) is in `references/persistent-state.md`.

## Codex: Model and Effort

The workflow no longer fixes Codex models like `gpt-5.4` or `gpt-5.5`.

Use:

- direct `codex-companion.mjs` dispatch with `--effort medium --write` for implementation, handoff and adjustments;
- direct `codex-companion.mjs` dispatch with `--effort high`, **no `--write`**, for back-end post-implementation review — omitting the flag is what makes the review read-only, not a prompt instruction;
- `codex:codex-rescue` is the fallback sub-agent when `companionPath` cannot be resolved.

The model defaults to what is available in the user's account. Codex never reviews front-end.

## Codex: Sandbox Limits

When Codex is in a sandboxed environment, treat as operational blocker:

- external network failure for packages, restore or registries, like `NU1301` accessing `https://api.nuget.org/v3/index.json`;
- required package missing from local cache;
- `UnauthorizedAccessException` or equivalent error when trying to create/edit files outside allowed working directory.

In these cases the sub-agent must stop, record evidence and return `Status: BLOCKED`, without insisting on long retries or trying to bypass the sandbox. There is one narrow exception: when the registry was already reachable and only `dotnet restore` fails with TLS/SSL/security-package authentication, the Orchestrator runs the exact restore once in the task workspace, saves a handoff, and returns the result to Codex. It does not modify certificates, proxy, VPN, credentials, `NuGet.Config`, or add/install packages; a failed host restore remains `BLOCKED`.

## Front-end Routing

The agent is chosen by task category, not by work appearance. If the task is `FRONTEND_ONLY`, use `cc-antigravity-plugin:antigravity-coder` even when it is Vite/React setup, React routing, or other front-end infrastructure. `antigravity-agent` remains read-only and is reserved for the Phase 9 review — `validate-routing.mjs` fails the wave when an implementation task points at it.

Codex should only receive front-end as a registered operational fallback after `QUOTA_EXAUSTED`, `AUTH_REQUIRED`, `AGY_MISSING`, `TIMEOUT`, AGY tool/write failure or explicit decision.

## AGY: Front-end Delegation

Front-end tasks are routed to Antigravity/AGY by category. Implementation uses `--mode accept-edits --format stream-json --model <agyModel>`; the bridge resolves aliases from the runtime model catalog and never edits user settings.

Default policy (implementation):

- `flash-medium` for most tasks;
- `pro-low` for complex tasks, multi-route, multi-file, with delicate API/UI contract or high regression risk;
- `pro-high` only in critical cases;
- manual override available via `/orchestrator --model <model> <demand>`.

Without an override, this policy defines the **floor**. The adaptive router may escalate only with enough comparable type/complexity samples, using first-pass success, review failures, regressions, duration, and a Wilson interval. It never downgrades the floor, never randomly explores critical tasks, and records the decision in `agyModelEvidence`.

The **front-end review (Phase 9)** always uses `--read-only --format json --model pro-high --effort high`, regardless of the implementation `agyModel`.

## AGY: Native Gemini Sub-agent Fan-out

When a front-end task produces two or more independent deliverables (e.g., three React components, two HTML reports), the orchestrator can activate AGY's native fan-out via `DefineSubagent` inside the prompt.

The mechanism is purely intra-task: it remains 1 task = 1 AGY delegation; `run/monitoring.md`, contracts and `validate-routing.mjs` remain intact.

### New Flags

| Flag | Behavior |
|---|---|
| `--parallel` | Forces fan-out on all AGY tasks in the execution. AGY decides the count. |
| `--subagent-model <model>` | Model of Gemini sub-agents. Implies `--parallel`. Default: `inherit` (inherits `agyModel`). |
| `--effort <low|medium|high>` | Optional implementation effort override; review stays at `high`. |
| `--timeout <duration>` | Silent timeout for every AGY delegation, including review, such as `300s` or `5m`. |

### Examples

```text
# Fan-out forced by user
/orchestrator --parallel "Create three independent React components: Header, Sidebar and Footer"

# Pro Planner coordinating Flash sub-agents
/orchestrator --model pro-low --subagent-model flash-medium \
  "Generate two HTML reports: taxes on electric cars and combustion cars"

# Automatic heuristic (orchestrator decides)
/orchestrator "Create Header, Sidebar and Footer as separate components in src/components/"
```

### When Fan-out is Used by Heuristic

The orchestrator turns on `--parallel` automatically when a `FRONTEND_ONLY` task (or front-end slice of `FULLSTACK`) lists two or more independent deliverables in acceptance criteria — and the task logic is not shared between them.

Dependent deliverables or those sharing state remain in the single AGY sub-agent, without `--parallel`.

### New Fields in `plan/tasks-classification.md` and `plan/waves.md` (AGY Tasks)

- `agyParallel: yes|no`
- `agyParallelSource: user|heuristic`
- `agySubagentModel: <model>|inherit`

Stable aliases used by heuristics and adaptive routing:

| Model | Tier |
|---|---|
| `flash-low` | Flash |
| `flash-medium` | Flash |
| `flash-high` | Flash |
| `pro-low` | Pro |
| `pro-high` | Pro |
| `auto` | — |

User overrides may also pass a safe dynamic model slug. The bridge validates it against `agy models`; routing history remains grouped by the requested stable alias.

## Preflight and Auto-remediation

Run:

```bash
node scripts/preflight.mjs --check-agent-mcp   # default path (SKILL.md/workflow.md Phase 0); also queries codex/agy live for per-agent MCP status
node scripts/preflight.mjs                     # without the optional.mcpPerAgent block; only if you want to skip the subprocess cost
```

The JSON includes:

- `status`
- `checks`
- `failed`
- `remediation`
- `autoRemediation`

Preflight validates:

- version of `agy` found in PATH;
- Codex CLI in PATH;
- `cc-antigravity-plugin >= 4.0.0` and the `openai-codex` plugin;
- presence of `agents/antigravity-coder.md`, `agents/antigravity-agent.md`, `commands/antigravity.md` and `scripts/antigravity-bridge.js` in the installed AGY plugin;
- `Bash(node:*)` permission for the Codex companion.

> As of version 3.0.0, preflight no longer requires the OpenSpec CLI or `openspec-*` skills — the orchestrator does not itself drive OpenSpec. It can still ingest a handoff from Pensador with an `openspec-change` artifact role in joint mode (see `references/workflow.md` and `references/handoff-contract.md`); that ingestion never depends on the OpenSpec CLI being installed.

### Auto-remediation Scope

Auto-correction only exists for `codex-companion-bash`:

- if `.claude/settings.json` does not exist, it can be created;
- if it exists with valid JSON, `permissions.allow` receives `Bash(node:*)`;
- if it exists with invalid JSON, the file is not overwritten.

Example of minimum baseline:

```json
{
  "permissions": {
    "allow": [
      "Bash(node:*)"
    ]
  }
}
```

## AGY Prompt Budget — Indicative, Not a CLI Limitation

The AGY CLI is invoked via `child_process` by the plugin bridge. On Windows, Node.js passes an
argv-based prompt as a command-line argument with automatic quoting (each `"` becomes `\"`, each
`\` doubles), which used to break near ~29,140 real chars (`ENAMETOOLONG`).

Since cc-antigravity-plugin **4.4.0**, that ceiling no longer applies: the bridge streams the final
prompt to AGY over stdin whenever it exceeds the platform's safe argv size (8,191 chars on Windows,
100,000 elsewhere), so headless dispatch never drops inline context for size. A design system
package handed to the bridge via `--design-system <dir>` is inlined in full regardless of size,
outside this budget entirely.

`check-prompt-budget.mjs` still measures the persisted task body against a **24,000-char
indicative threshold** (`advisory: true` for every agent, never blocks). It stays useful as a
quality signal — a task body that large usually means poorly scoped work — but `ok: false` no
longer requires a split before dispatch. When the check flags a task and it genuinely benefits from
splitting:

1. Divide the task's deliverables into two independent groups (A and B).
2. Create subtasks `<ID>-a` and `<ID>-b`, each covering one group.
3. Update `plan/tasks-classification.md` and `plan/waves.md`.
4. Reassemble the two prompts and confirm each is below the threshold.
5. Record the split in `run/monitoring.md` and `report/workflow-log.md` with original size and reason.

If the task is monolithic and indivisible by deliverables, the orchestrator trims `Relevant files
and modules` to the essentials and, as a last resort, records `promptOverflow: true` as a quality
note in `plan/tasks-classification.md` — there is no user decision to request here anymore, since
dispatch is not blocked.

## Quota Policy

### Codex on Implementation, Adjustment or Handoff

If `QUOTA_EXHAUSTED`:

- delegate back-end implementation fallback exclusively to AGY (`cc-antigravity-plugin:antigravity-coder`) using Gemini models:
  - `gemini-3.8-flash-medium` for punctual tasks/CRUDs, seeds and isolated adjustments;
  - `gemini-3.8-flash-high` for architecture, security or complex refactorings;
- strictly avoid delegating fallback to Claude models or `claude-code` sub-agents, preserving the main session's quota;
- record fallback reason and evidence in `run/monitoring.md` and `report/workflow-log.md`.

### Codex on Back-end Review

If `QUOTA_EXHAUSTED`:

- the orchestrator does internal read-only review;
- saves the result in `review/review-final.md`;
- does not edit productive code.

### AGY on Front-end Review

If `QUOTA_EXAUSTED`, `AUTH_REQUIRED`, `AGY_MISSING` or `TIMEOUT`:

- the orchestrator does internal read-only review;
- saves the result in `review/review-frontend.md`;
- does not edit productive code.

### Antigravity/AGY on Implementation

Continues with controlled fallback to Codex only when safe. The plugin bridge returns raw status:

- `QUOTA_EXAUSTED`
- `AUTH_REQUIRED`
- `TIMEOUT`
- `AGY_MISSING`

The orchestrator must record these values as they come from the bridge.

## Mandatory Contracts

Contract is mandatory whenever there is data exchange between front-end and back-end.

This applies to:

- `FULLSTACK` tasks;
- dependent pairs `BACKEND_ONLY` + `FRONTEND_ONLY`.

In Phase 2, each task must register `contractRequired: yes|no`.

For `FRONTEND_ONLY` tasks and front-end slice of `FULLSTACK`, also register:

- `agyModel`
- `agyModelSource: user|heuristic|adaptive`
- `agyModelEvidence` when the source is `adaptive`

The routing validator requires these fields on AGY tasks and fails if:

- an AGY task does not register `agyModel`;
- `agyModelSource` is missing;
- `agyModelSource: adaptive` lacks auditable evidence;
- a heuristic/adaptive decision uses a dynamic slug instead of a stable capability alias, or a user slug is syntactically unsafe;
- a design-system task (`tokens.css`, `components.html`, `DESIGN.md`) uses a low-tier model;
- `FRONTEND_ONLY` points to Codex as primary agent;
- `FRONTEND_ONLY` or `FULLSTACK` delegates implementation to the read-only `antigravity-agent` instead of `antigravity-coder`.

The validator reads the same task-ID grammar as the State Engine (`T1`, `T12-A`, `BE-01`, `FE-001-B`, never a version suffix like `gemini-3.5`) and recognizes wave entries written as headings, table rows, or list items.

In Phase 4, the orchestrator creates `contracts/*.md` for every item with `contractRequired: yes`.

## Wire Format and Serialization

Every contract must document:

- expected JSON casing;
- exact field names;
- complete request and response examples;
- global serializer or serialization attributes when present;
- validation of real serialization against the TypeScript consumer.

Especially for C# + TypeScript:

- internal DTO in `PascalCase` is not enough;
- expected JSON payload in `camelCase` must be documented;
- compatibility must be validated on actual payload, not just TypeScript types.

## Main Files

- `commands/orchestrator.md`
- `skills/orchestrator-multi-agent-development/SKILL.md`
- `skills/orchestrator-multi-agent-development/references/workflow.md`
- `skills/orchestrator-multi-agent-development/references/persistent-state.md`
- `skills/orchestrator-multi-agent-development/references/project-knowledge.md`
- `skills/orchestrator-multi-agent-development/references/programmatic-intelligence.md`
- `skills/orchestrator-multi-agent-development/references/lifecycle-telemetry.md`
- `skills/orchestrator-multi-agent-development/references/learning-curator.md`
- `skills/orchestrator-multi-agent-development/references/worktrees-routing.md`
- `skills/orchestrator-multi-agent-development/references/hermes-adaptation.md`
- `skills/orchestrator-multi-agent-development/references/agent-stack.md`
- `skills/orchestrator-multi-agent-development/references/subagent-prompts.md`
- `skills/orchestrator-multi-agent-development/references/contracts.md`
- `skills/orchestrator-multi-agent-development/assets/contract-template.md`
- `skills/orchestrator-multi-agent-development/assets/monitoring-template.md`
- `skills/orchestrator-multi-agent-development/assets/implementation-report-template.md`
- `skills/orchestrator-multi-agent-development/assets/orchestration-state.schema.json`
- `skills/orchestrator-multi-agent-development/assets/orchestration-event.schema.json`
- `skills/orchestrator-multi-agent-development/scripts/orchestration-state.mjs`
- `skills/orchestrator-multi-agent-development/scripts/orchestrator-knowledge.mjs`
- `skills/orchestrator-multi-agent-development/scripts/orchestration-lifecycle.mjs`
- `skills/orchestrator-multi-agent-development/scripts/orchestration-worktree.mjs`
- `skills/orchestrator-multi-agent-development/scripts/orchestration-router.mjs`
- `skills/orchestrator-multi-agent-development/scripts/orchestration-telemetry.mjs`
- `skills/orchestrator-multi-agent-development/scripts/orchestration-learning.mjs`
- `skills/orchestrator-multi-agent-development/scripts/lib/`
- `scripts/orchestration-state.mjs`
- `scripts/intelligence/`
- `tests/*.test.mjs`

## Recommended Validation

```bash
node --check skills/orchestrator-multi-agent-development/scripts/preflight.mjs
node --check skills/orchestrator-multi-agent-development/scripts/orchestration-state.mjs
node scripts/preflight.mjs
node skills/orchestrator-multi-agent-development/scripts/validate-routing.mjs .orchestrator/runs/<name>
node --test tests/*.test.mjs
rg --line-number --fixed-strings -- 'QUOTA_EXAUSTED' README.md commands skills
rg --line-number --fixed-strings -- 'agyModelSource' README.md commands skills
rg --line-number --fixed-strings -- 'agyParallel' README.md commands skills
rg --line-number --fixed-strings -- 'pro-high' README.md commands skills
```
