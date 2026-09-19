# Stack de agentes

> **A stack e configuravel, nao fixa.** As tabelas abaixo descrevem o comportamento sob os defaults da Project_Config (`backendExecutor: codex`, `frontendExecutor: agy`, `backendReviewer: codex`, `frontendReviewer: agy`). Qual agente de fato implementa/revisa cada categoria vem de `.orchestrator/project-config.md`, resolvido na Fase 0.5 e derivado por `scripts/lib/project-config.mjs` — ver `references/project-config.md`. Quando um papel e `claude-code`, o Executor e um subagente do proprio Claude Code delegado pela ferramenta `Agent` (implementacao) ou em modo read-only gravando em `review/review-final.md`/`review/review-frontend.md` (review); nesse papel nenhuma CLI externa e exigida no preflight. `codex`/`agy` continuam a rota quando configurados, exatamente como descrito abaixo.

## Visao geral

| Papel | Modelo | Subagent type | Effort | Observacoes |
|---|---|---|---|---|
| Orquestrador | Claude Sonnet 4.6 | voce mesmo | Medium | coordena e consolida |
| Back-end | `gpt-5.6-terra` (papel implement) | `codex:codex-rescue` | derivado da task | implementacao |
| Front-end | AGY por override, piso heuristico ou escalada adaptativa comprovada | `cc-antigravity-plugin:antigravity-coder` | - | `--mode accept-edits --format stream-json --model <agyModel>`; `adaptive` exige evidence; edita arquivos |
| Review back-end pos-implementacao | `gpt-5.6-sol` (papel review) | `codex:codex-rescue` | High | read-only, apenas back-end |
| Review front-end pos-implementacao | AGY `pro-high` | `cc-antigravity-plugin:antigravity-agent` | - | `--read-only --format json --effort high`, apenas front-end — **nunca usar para implementar** |
| Correcao pos-9.5/review reprovado | `gpt-5.6-luna` (papel fix) | `codex:codex-rescue` | derivado da task | correcao originada de achado, nao de plano novo |

## Invariante de roteamento

A categoria da task decide o agente. Nao use "parece setup", "parece infra" ou "Codex consegue fazer" como criterio para trocar agente.

| Categoria | Agente primario |
|---|---|
| `FRONTEND_ONLY` | Antigravity/AGY |
| `BACKEND_ONLY` | Codex |
| `DATABASE_ONLY` | Codex |
| `REVIEW_ONLY` | Codex |
| `FULLSTACK` | Codex para back-end + Antigravity/AGY para front-end |

Exemplos que continuam sendo `FRONTEND_ONLY` e devem ir para AGY:

- criar projeto Vite/React/TypeScript;
- configurar React Router;
- criar tipos TypeScript de contrato;
- criar servicos `fetch`/client API;
- criar layout, paginas, componentes, hooks, estado e UX.

Codex so assume front-end como fallback operacional depois de `QUOTA_EXAUSTED`, `AUTH_REQUIRED`, `AGY_MISSING`, `TIMEOUT`, falha de ferramenta/escrita do AGY ou decisao explicita do usuario. Registre o motivo e o handoff nos artefatos de monitoramento.

## Regra para Codex

Passe sempre `--model <papel>` — Codex tem **tres papeis fixos de modelo**, nunca o default da conta:

- `gpt-5.6-sol` — **somente review** (Fases 8/9 e task `REVIEW_ONLY`);
- `gpt-5.6-terra` — implementacao geral (`BACKEND_ONLY`, `DATABASE_ONLY`, `DOCS_ONLY`, fatia back-end de `FULLSTACK`);
- `gpt-5.6-luna` — correcao originada da Fase 9.5 (browser-e2e) ou de review `REPROVADO`.

`--effort <low|medium|high>` e sempre derivado da complexidade/risco da task na classificacao — utilize `low` ou `medium` para CRUDs, migrations simples, seeds e tarefas pontuais/isoladas, reservando `high` estritamente para arquitetura central, refatoracoes criticas e reviews (Fase 8 e 9). Nunca fixe `--effort high` arbitrariamente para tasks simples e nunca omita `--model`: sem ele o Codex cai no default de conta do usuario, que pode ser o modelo de review fazendo implementacao.

Codex revisa apenas back-end. O review de front-end e sempre do AGY com `--read-only --format json --model pro-high --effort high`.

## Regra para contratos front-back

Se houver troca de dados entre front-end e back-end, o contrato e obrigatorio. Isso vale mesmo que a classificacao esteja separada em `BACKEND_ONLY` e `FRONTEND_ONLY`.

O prompt de qualquer agente envolvido precisa receber:

- o contrato correspondente;
- a regra de wire format;
- a obrigacao de checar casing JSON;
- a orientacao para validar serializacao real contra TypeScript.

## Heuristica de uso

### Antigravity/AGY

Use `cc-antigravity-plugin:antigravity-coder` para qualquer task `FRONTEND_ONLY` e para a fatia front-end de `FULLSTACK` — e o unico subagente AGY com permissao de escrita (cria, edita, move e formata arquivos via o bridge nativo). Passe `--model <agyModel>` para o bridge do plugin, com escolha por override do usuario, piso heuristico ou escalada adaptativa comprovada por amostra comparavel. Nunca reduza o piso; `adaptive` exige `agyModelEvidence`. `cc-antigravity-plugin:antigravity-agent` e **somente leitura** (analise, planejamento, review); jamais delegue implementacao a ele.

Quando a task listar **dois ou mais entregaveis independentes** (ex.: dois relatorios HTML, tres componentes React sem dependencia mutua), passe tambem `--parallel` para ativar o fan-out nativo de subagentes Gemini. O AGY decide a contagem, executa concorrentemente e agrega os resultados. Ao final, reporte os Conversation IDs de cada subagente em `report/subagents-context.md`.

Quando o usuario passar `--subagent-model <modelo>` (alias legado: `--agy-subagent-model`), repasse como `--subagent-model <modelo>` ao bridge (implica `--parallel`). Por padrao (`agySubagentModel: inherit`), omita `--subagent-model`; os subagentes usam o mesmo modelo da sessao AGY principal.

Entregaveis dependentes ou que compartilham estado/arquivo central NAO devem usar `--parallel`; mantenha o subagente unico.

### Codex `gpt-5.6-terra` (papel implement)

Use para:

- endpoints REST/GraphQL;
- services, handlers e repositorios;
- DTOs, mappers e validacoes;
- migrations simples;
- ajustes pontuais;
- handoffs apos falha operacional.

**Nao delegar criacao de projeto/suite de testes automatizados.** Nem o orquestrador nem o Pensador geram projetos de teste (`*.Tests`, `__tests__/`, suites xUnit/Jest/Vitest dedicadas) como entregavel — isso e decisao do time do produto, fora deste fluxo. A validacao de cada requisito (`RF`/`CA` do PRD/spec) acontece **no review de codigo** (Fase 8 back-end, Fase 9 front-end): o revisor confere, por inspecao, se o comportamento exigido pelo criterio de aceite esta implementado corretamente — nao depende de uma suite de testes existir.

Bloqueie e escale ao usuario quando o Codex depender de rede externa indisponivel para pacotes/restore, de pacote ausente do cache local, ou quando nao puder escrever fora do working directory permitido. Exemplos: NuGet `NU1301` em `https://api.nuget.org/v3/index.json` e `UnauthorizedAccessException`. A excecao e uma falha TLS/SSL de `dotnet restore` depois que o registry ja esteve acessivel: o Orquestrador faz uma tentativa unica e restrita do mesmo restore no workspace da task, registra um handoff e reabre o Codex; nao muda certificados, proxy, VPN ou configuracao de fontes.

### Codex `gpt-5.6-sol` (papel review)

Use para:

- review back-end pos-implementacao;
- leitura critica de risco arquitetural no back-end;
- analise de regressao e seguranca no back-end.

Sempre com `--effort high`.

### Codex `gpt-5.6-luna` (papel fix)


### Codex `gpt-5.6-sol` (papel review)

Use para:

- review back-end pos-implementacao;
- leitura critica de risco arquitetural no back-end;
- analise de regressao e seguranca no back-end.

Sempre com `--effort high`.

### Codex `gpt-5.6-luna` (papel fix)

Use exclusivamente para correcao originada de um achado — Fase 9.5 (browser-e2e) ou review `REPROVADO` — nunca para uma task de implementacao vinda do plano original. `--effort` derivado da severidade do achado.

### AGY `pro-high` (review front-end)

Use para o review front-end pos-implementacao (Fase 9), em modo read-only. O AGY revisa consumo de contrato, estados de UI, tipagem, build/typecheck/lint e regressao visual. Codex nunca revisa front-end.

## Politica de quota

**Fallback de cota opt-in (`quotaFallbackChain`).** Quando `projectConfig.quotaFallbackChain === "enabled"` (5a pergunta da Project_Config, default `disabled`) e um Executor reporta `QUOTA_EXHAUSTED`/`QUOTA_EXAUSTED`, calcule a cadeia de fallback com `resolveFallbackChain` (`scripts/lib/quota-fallback.mjs`): ordem fixa `claude-code, codex, agy`, excluindo o Executor original e qualquer elo ja sinalizado como tambem esgotado nesta Run; tente o primeiro elo restante. Fallback para `claude-code` segue a "Regra central do Executor `claude-code`" do `SKILL.md` (implementacao via `Agent`, review read-only); fallback para `codex`/`agy` segue o mesmo caminho ja existente de troca de Executor abaixo. Cada fallback bem-sucedido grava uma entrada no contrato de repasse (`recordQuotaHandoff`, `state.json.quotaHandoffs[]`) e e reportado em `run/monitoring.md`/`report/workflow-log.md`. Com `quotaFallbackChain` `disabled` (ou ausente/legado), o comportamento **nao muda**: seguem as regras abaixo, linha a linha.

- `QUOTA_EXHAUSTED` em implementacao Codex (Back-End):
  - O fallback de implementacao de back-end delega exclusivamente para o AGY (`cc-antigravity-plugin:antigravity-coder`) com modelos Gemini nativos:
    - `gemini-3.8-flash-medium` para tarefas pontuais/CRUDs, migrations simples, seeds e ajustes isolados;
    - `gemini-3.8-flash-high` para tarefas de arquitetura, seguranca ou refatoracao complexa.
  - **NUNCA** fazer fallback para modelos Claude ou subagentes `claude-code`, preservando estritamente a cota da sessao principal e evitando sobrecarga/custo no orquestrador.
  - Registre o motivo do fallback e os identificadores em `run/monitoring.md` e `report/workflow-log.md`.
- `QUOTA_EXHAUSTED` em review back-end Codex: fazer fallback de review interno read-only do orquestrador e salvar em `review/review-final.md`.
- `QUOTA_EXAUSTED`/`AUTH_REQUIRED`/`AGY_MISSING`/`TIMEOUT` no review front-end AGY: fazer fallback de review interno read-only do orquestrador e salvar em `review/review-frontend.md`.
- `QUOTA_EXHAUSTED` em implementacao Antigravity/AGY: seguir a politica de fallback descrita em `workflow.md`.
- `AUTH_REQUIRED`, `AGY_MISSING` e `TIMEOUT` em Antigravity/AGY: tratar como bloqueios operacionais e registrar evidencia.

## Politica de sandbox

- Rede externa bloqueada no Codex para NuGet/npm/pip/outros registries: registrar evidencia e marcar `BLOCKED`.
- TLS/SSL em `dotnet restore` apos o registry estar acessivel: use o relay automatico Codex -> Orquestrador -> Codex uma unica vez; se o restore do host falhar, registre `HOST_DEPENDENCY_RESTORE_FAILED` e mantenha `BLOCKED`.
- Pacote necessario nao existe no cache local do ambiente Codex: registrar dependencia ausente e marcar `BLOCKED`.
- Escrita fora do working directory permitido retorna erro de permissao: registrar caminho alvo, working directory efetivo e marcar `BLOCKED`.
- Para tasks `FRONTEND_ONLY` sem necessidade de instalar dependencias externas, AGY continua sendo a rota preferida.

## Skills e Context7

Antes de delegar, cite apenas skills que realmente existem no ambiente.

Se `checks.optional.mcp.context7.ok=true`, instrua Codex e Antigravity/AGY a consultar Context7 antes de mexer em bibliotecas, frameworks, SDKs, APIs, CLIs ou cloud services.
