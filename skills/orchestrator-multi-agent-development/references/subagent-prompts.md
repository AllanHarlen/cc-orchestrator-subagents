# Prompts oficiais para subagentes

Sempre leia este arquivo antes de delegar para Codex ou Antigravity/AGY.

## Regras comuns

- Para Codex, passe sempre `--model <papel>` — tres papeis fixos: `gpt-5.6-sol` (review, exclusivo), `gpt-5.6-terra` (implementacao) e `gpt-5.6-luna` (correcao de achado). `--effort <low|medium|high>` e derivado da complexidade/risco da task, nunca fixo. Nunca omita `--model`.
- A categoria da task decide o agente. `FRONTEND_ONLY` sempre usa Antigravity/AGY como agente primario; Codex so pode receber front-end em fallback operacional registrado.
- Codex revisa apenas back-end. O review de front-end e sempre do AGY com `--read-only --format json --model pro-high --effort high`.
- Se aparecer cota, rate limit, billing, resource exhausted, model capacity ou daily limit no Codex, retorne `Status: QUOTA_EXHAUSTED`.
- Se aparecer cota, rate limit, billing, resource exhausted, model capacity ou daily limit no AGY, preserve o status cru `Status: QUOTA_EXAUSTED`.
- Nao tente contornar cota com retries longos ou mudanca arbitraria de modelo.
- Antes de prometer Context7 ou Codebase Memory no prompt de uma task Codex/AGY, prefira `checks.optional.mcpPerAgent.<agent>.<servidor>.ok` (verdade ao vivo por agente, so existe quando o preflight rodou com `--check-agent-mcp`) em vez do agregado `checks.optional.mcp.<servidor>.ok` — esse agregado so prova que o MCP esta registrado em algum lugar da maquina, nao necessariamente na CLI que vai executar a task (ver `references/mcp-context.md`).
- Se o sinal aplicavel indicar disponibilidade para Context7, use-o antes de decidir sobre bibliotecas, frameworks, SDKs, APIs, CLIs ou cloud services externos, aplicando Single-Concept Scoping (consulta focada em um unico conceito, sem misturar temas), versao canonica `/org/project/version` quando compativel com o projeto e limite de ate 3 consultas por tarefa. Nao use para logica de negocio interna ou refatoracao local.
- Se o sinal aplicavel indicar disponibilidade para Codebase Memory, use `search_graph`/`trace_path`/`get_code_snippet` para localizar o simbolo, quem o chama e quem ele chama, antes de varrer arquivos com Read/Glob/Grep. Grafo e pista, nao prova: confirme por leitura do arquivo antes de alterar comportamento. Se o grafo nao cobrir o arquivo, ou a consulta falhar, leia o arquivo diretamente. Fique dentro do escopo permitido mesmo que o grafo aponte para fora dele.
- Se existir contrato API/UI, siga o contrato como fonte da verdade.
- Valide casing JSON e wire format real; nao assuma que nomes de DTO internos sao iguais ao payload na rede.
- Auto-verificação local obrigatoria antes de reportar DONE: todo subagente DEVE executar o build/compilacao e a verificacao/testes locais da sua fatia no seu workspace ou worktree (`<BUILD_CMD>` e `<TEST_CMD>`). Qualquer erro de compilacao, sintaxe, tipagem ou lint DEVE ser corrigido antes de encerrar. So retorne `Status: DONE` se a verificacao concluir com exit code 0.
- Roteamento de Fallback de Back-End: Quando o Codex esgotar cota (`QUOTA_EXHAUSTED`), o fallback de implementacao de back-end delega exclusivamente para o AGY (`cc-antigravity-plugin:antigravity-coder`) com modelos Gemini (`gemini-3.8-flash-medium` para tarefas pontuais/CRUDs e `gemini-3.8-flash-high` para tarefas de arquitetura/seguranca), NUNCA para modelos Claude ou subagentes `claude-code`, preservando a cota da sessao principal.
- No Codex, trate rede externa bloqueada para pacotes/restore, pacote ausente do cache local e erro de escrita fora do working directory permitido como `Status: BLOCKED`.

## 1. Back-end - Codex

**Despacho: chamada direta ao companion, nao mais `codex:codex-rescue`.** O subagente
`codex:codex-rescue` e instruido a devolver o stdout do Codex exatamente como recebeu
(`Return the stdout of the task command exactly as-is`) e e proibido de chamar `status`/`result` —
ou seja, ele nao isola contexto nenhum: o relatorio final que ele devolve *e* o stdout do Codex, e o
prompt de entrada o orquestrador ja tinha, porque foi ele que montou. A camada custava um Sonnet
reescrevendo o prompt sem devolver isolamento em troca. Por isso o despacho e direto:

1. Persista o corpo do prompt abaixo (com os placeholders preenchidos) em
   `.orchestrator/runs/<slug>/run/prompts/<taskId>.md` — nunca em argv (ver "Prompt efetivo como
   artefato da run" mais abaixo).
2. Meca o prompt: `node "${CLAUDE_SKILL_DIR}/scripts/check-prompt-budget.mjs" --agent codex --file
   .orchestrator/runs/<slug>/run/prompts/<taskId>.md`. Para Codex isso e apenas indicativo
   (`advisory: true`, nunca falha) porque `--prompt-file` nao passa pelo limite de argv do Windows —
   mas um prompt muito grande ainda degrada qualidade de contexto, então considere dividir por
   entregaveis mesmo sem erro.
3. Resolva o path do companion em `checks.plugins["openai-codex"].companionPath`
   (`node "${CLAUDE_SKILL_DIR}/scripts/preflight.mjs" --json`) — nunca hardcode a versao instalada,
   ela e sobrescrita a cada update do plugin de terceiro.
4. Despache:

```bash
node "<companionPath>" task \
  --cwd "<workspace da task>" \
  --prompt-file ".orchestrator/runs/<slug>/run/prompts/<taskId>.md" \
  --model gpt-5.6-terra --effort medium --write --background --json
# → { jobId, status: "queued", logFile }  —  jobId e o sessionId da task no state
# resultado grande depois: node "<companionPath>" result <jobId> --json
```

`--model gpt-5.6-terra` (papel implement) para implementacao/handoff/ajuste; `--model gpt-5.6-sol`
(papel review) para review (Fase 8); `--model gpt-5.6-luna` (papel fix) para correcao vinda da Fase
9.5 ou de review `REPROVADO`. `--effort` e sempre derivado da complexidade/risco da task —
`medium` e o piso tipico de implementacao, `high` o de review — nunca um valor fixo, e nunca omita
`--model`: sem ele o Codex cai no default de conta do usuario, que pode ser o modelo de review.
**Omita `--write` no review de back-end** — isso torna o `read-only` uma garantia estrutural
(`handleTask` em `codex-companion.mjs` faz `write = Boolean(options.write)`), nao uma frase de prompt
que o executor pode ignorar.

**Fallback documentado:** se `checks.plugins["openai-codex"].companionPath` nao resolver (plugin
ausente ou corrompido), use `codex:codex-rescue` com o mesmo corpo de prompt como texto da task, e
registre o fallback em `report/workflow-log.md` com o motivo.

**Corpo do prompt** (o que vai em `run/prompts/<taskId>.md`):

```text
Voce e o subagente back-end desta task.

Antes de implementar, liste as skills disponiveis no ambiente com `/skills` ou equivalente.
Ignore skills exclusivas de planejamento/coordenacao do orquestrador.
Das skills restantes, identifique quais sao compativeis com esta task e use-as durante a implementacao.
Registre no retorno quais skills foram utilizadas.

Contexto:
- especificacao (PRD/spec): <COLAR TRECHO RELEVANTE OU CAMINHO DO ARQUIVO>
- task atual: <TASK ID - TITULO>

Descricao:
<COLAR DESCRICAO DA TASK>

Contrato tecnico:
<COLAR CONTRATO SE contractRequired=yes; senao remover>

Arquivos e modulos relevantes:
<LISTAR ARQUIVOS>

Escopo permitido:
<LISTAR DIRETORIOS E ARQUIVOS PERMITIDOS>

Fora do escopo:
<LISTAR ARQUIVOS CENTRAIS OU COMPARTILHADOS>

Stack:
<STACK>

Skills relevantes:
<LISTAR SKILLS DISPONIVEIS>

Context7 MCP:
<MANTER SOMENTE SE DISPONIVEL>
- consulte documentacao atual antes de escrever codigo que usa libs/frameworks/APIs externos;
- use resolve-library-id com o nome oficial pontuado (ex: 'Next.js');
- se houver versao compativel com o projeto em Versions, use o ID '/org/project/version';
- faca query-docs com Single-Concept Scoping (consulta escopada a um unico conceito por vez);
- limite maximo de 3 consultas por tarefa; nunca use para logica de negocio interna;
- cite docs consultadas no retorno; senao siga padroes locais;

Codebase Memory MCP:
<MANTER SOMENTE SE DISPONIVEL>

Regras:
- implemente apenas esta task;
- preserve padroes locais;
- nao altere contrato sem sinalizar;
- valide wire format real, especialmente casing JSON;
- se houver contratos tipados gerados em `contracts/` (via `generate-contract-types.mjs`), importe e siga estritamente os DTOs e assinaturas gerados;
- se houver DTO C# em PascalCase e payload esperado em camelCase, confirme serializer/atributos e registre a decisao;
- valide serializacao real contra o TypeScript consumidor quando houver fronteira front-back;
- nao crie projeto/suite de testes automatizados como entregavel desta task — a validacao de cada `RF`/`CA` acontece no review de codigo (Fase 8), nao numa suite gerada por voce;
- auto-verificacao local obrigatoria antes de reportar DONE: execute o build e testes locais da sua fatia no seu workspace/worktree (`<BUILD_CMD>` e `<TEST_CMD>`); corrija qualquer erro de compilacao, tipagem ou sintaxe antes de devolver; retorne `Status: DONE` apenas se os comandos terminarem com exit code 0;
- reporte todos os arquivos alterados;
- se houver cota, retorne `Status: QUOTA_EXHAUSTED`;
- se `dotnet restore`, `dotnet add package`, npm, pip ou outro registry falhar por rede externa bloqueada ou pacote ausente do cache local, retorne `Status: BLOCKED` com o comando, pacote e erro;
- se `dotnet restore` falhar depois de acesso ao registry por TLS/SSL/autenticacao do pacote de seguranca (por exemplo, `The SSL connection could not be established`, `Authentication failed` ou `Credenciais nao disponiveis no pacote de seguranca`), nao repita nem altere proxy, certificado, VPN, variaveis de ambiente ou `NuGet.Config`; retorne `Status: BLOCKED`, o target exato do restore e `Relay de restore TLS elegivel: sim`. O orquestrador pode executar uma unica tentativa fora do sandbox e abrir uma nova tentativa para voce com a evidencia;
- se houver `UnauthorizedAccessException` ou erro de permissao ao escrever fora do working directory permitido, retorne `Status: BLOCKED` com working directory efetivo e caminho alvo;
- se receber `SLOW_CHECKIN`, responda com progresso real, arquivos tocados, bloqueios, riscos e ETA.

Retorno:
0. Status: DONE | BLOCKED | FAILED | QUOTA_EXHAUSTED
1. Resumo do que foi implementado
2. Arquivos alterados
3. Decisoes tecnicas
4. Validacao de wire format e serializacao
5. Testes executados
6. Pendencias
7. Riscos
8. Evidencia operacional
9. Limites de sandbox: <nenhum | rede externa bloqueada | pacote ausente no cache | escrita fora do working directory | TLS restore relay elegivel | outro>
10. Relay de restore TLS: <nao aplicavel | elegivel: sim, target: ... | executado pelo orquestrador: ver caminho do handoff>
11. Skills utilizadas: <lista das skills usadas ou "nenhuma">
12. Tokens usados: input=<N> output=<N> cache_read=<N> total=<N>
    (informe N/A se a plataforma nao expor o dado)
```

## 2. Front-end - Antigravity (AGY)

**Subagent type:** `cc-antigravity-plugin:antigravity-coder` (edita arquivos via o bridge nativo; `antigravity-agent` e somente leitura e nunca deve ser usado aqui)

**Parametros:**

```text
--mode accept-edits --format stream-json --model <AGY_MODEL> [--effort <AGY_EFFORT>] [--timeout <AGY_TIMEOUT>] [--parallel] [--subagent-model <SUBAGENT_MODEL>] --dirs <DIRS> [--design-system <DESIGN_SYSTEM_DIR>] \
--task-file ".orchestrator/runs/<slug>/run/prompts/<taskId>.md" \
--dump-prompt ".orchestrator/runs/<slug>/run/prompts/<taskId>.agy.txt"
```

`--design-system <DESIGN_SYSTEM_DIR>` (repetivel, aceita lista separada por virgula): quando a task
consome um pacote Open Design materializado na Fase 4.0, aponte para o `materializeInto` real (ex.:
`packages/ui/design-systems/<id>/`) — **nao** inclua esse diretorio em `--dirs` tambem, para nao
duplicar leitura. O bridge inlina os arquivos centrais do pacote (`design-contract.json`,
`DESIGN.md`, `tokens.css`, `components.html`, `USAGE.md`, `components.manifest.json`,
`assets/manifest.json`) na integra, fora do orcamento de `--max-files`/`--max-file-bytes`, e lista o
resto do pacote (`preview/`, `system/`, `source/`) para o AGY ler sob demanda com `view_file`.
Detalhes na Secao 2a.

O bridge resolve aliases com `agy models` e encaminha `--model` nativamente, sem modificar configuracoes do usuario. `stream-json` permite acompanhar `init`, `step_update` e `result`; progresso fica separado em `stderr` e apenas a resposta final segue em `stdout`.

Passe `--parallel` quando `agyParallel: yes` para a task. Se `agySubagentModel` for diferente de `inherit`, inclua tambem `--subagent-model <SUBAGENT_MODEL>`.

**Sempre use `--task-file`, nunca argv, para o corpo do prompt abaixo:** o **orquestrador** (nao o
subagente — `antigravity-coder` nao tem ferramenta de escrita, so `Bash(node *antigravity-bridge.js*)`)
persiste o corpo em `run/prompts/<taskId>.md` antes de invocar o subagente, e a instrucao do
subagente e so passar `--task-file ".orchestrator/runs/<slug>/run/prompts/<taskId>.md"` para o bridge —
o proprio bridge le o arquivo. Desde o bridge 4.4.0, o salto seguinte (bridge→agy) tambem deixou de
ter orcamento real: o bridge faz stream do prompt final via stdin sempre que ele excede o argv
seguro da plataforma. Meca o mesmo arquivo antes de despachar, ainda assim, como sinal de qualidade:
`node "${CLAUDE_SKILL_DIR}/scripts/check-prompt-budget.mjs" --agent agy --file
.orchestrator/runs/<slug>/run/prompts/<taskId>.md` — `advisory: true`, `ok: false` nunca bloqueia,
mas segue indicando escopo mal recortado (ver "Orcamento indicativo de prompt AGY/Codex" em
`references/workflow.md`).

**`--dump-prompt` audita o contexto que de fato chegou ao AGY.** O sidecar `<path>.audit.json`
(`{ promptChars, limit, transport, degraded, droppedFiles, included, skipped, designSystems }`)
alimenta os campos "Prompt enviado" e "Contexto degradado" de `assets/subagents-context-template.md`.
`transport` diz se o prompt foi por `stdin` (o normal, sem perda) ou `argv` (so em `--interactive`).
Quando `degraded: true`, a task nao conta como executada com contexto completo — ver "Prompt efetivo
como artefato da run" em `references/workflow.md`.

**Corpo do prompt:**

```text
Voce e o subagente front-end desta task.

Esta task foi roteada para AGY porque sua categoria e `FRONTEND_ONLY` ou a fatia front-end de `FULLSTACK`. Mesmo quando o trabalho for setup de projeto, roteamento, tipos TypeScript ou servico API, trate como front-end.

Antes de implementar, liste as skills disponiveis no ambiente com `/skills` ou equivalente.
Ignore skills exclusivas de planejamento/coordenacao do orquestrador.
Das skills restantes, identifique quais sao compativeis com esta task e use-as durante a implementacao.
Registre no retorno quais skills foram utilizadas.

Contexto:
- especificacao (PRD/spec): <COLAR TRECHO RELEVANTE OU CAMINHO DO ARQUIVO>
- task atual: <TASK ID - TITULO>
- pacote visual autoritativo: <CAMINHOS design-contract.json, tokens.css, DESIGN.md e assets/manifest.json>
- prototipos de referencia (spec visual dos fluxos criticos): <CAMINHO prototypes/ (ex.: .pensador/<slug>-vN/prototypes/)>

Descricao:
<COLAR DESCRICAO DA TASK>

Contrato API/UI:
<COLAR CONTRATO SE contractRequired=yes; senao remover>

Arquivos e modulos relevantes:
<LISTAR ARQUIVOS>

Escopo permitido:
<LISTAR DIRETORIOS E ARQUIVOS PERMITIDOS>

Fora do escopo:
<LISTAR ARQUIVOS CENTRAIS OU GLOBAIS>

Stack:
<STACK FRONT-END>

Design System (Open Design) — CONSUMIR, NAO REINVENTAR:
<COLAR SOMENTE SE houver design system; senao "N/A (sem design system nesta entrega)">
- tokens (fonte de verdade): <CAMINHO tokens.css, ex.: packages/ui/design-systems/<id>/tokens.css>
- fixtures de componente: <CAMINHO components.html>
- decisoes/intencao: <CAMINHO design-system.md (modo PRD) | openspec/changes/<nome>/design.md + specs/ui-design-system/spec.md (modo Spec)>
- preview de referencia (alvo visual): <CAMINHO preview/ (diretorio — ex.: packages/ui/design-systems/<id>/preview/)>
- assets aprovados: <CAMINHO assets/manifest.json>; copie conforme `materializeInto`, aplique `seedBindings` e nao solicite/sugira/gere imagens
Regras de design (do skills-protocol do Open Design — obrigatorias):
- cole o `tokens.css` como base e use as custom properties (`var(--*)`); NAO invente hex/raio/espacamento fora dos tokens;
- use os prototipos HTML em prototypes/ como SPEC VISUAL do fluxo: replique layout, hierarquia, comportamento e textos reais aprovados pelo usuario, sem inventar telas do zero;
- implemente os componentes batendo com os seletores/estados de `components.html` (default/hover/focus/active/disabled/loading/empty/error);
- accent contido: no maximo 2x por pagina (hero + CTA) alem de links; nao floode;
- sem sombra se Depth & Elevation = minimal; nada de emoji como icone;
- quando o requisito conflitar com o system, aplique override DOCUMENTADO (nao um token solto novo);
- o resultado deve poder ser comparado visualmente com o diretorio `preview/` (abrir `colors.html`, `spacing.html` ou `typography.html` conforme o system).

Modelo AGY:
<COLAR AGYMODEL>

Origem do modelo:
<user|heuristic|adaptive>

Evidencia do routing adaptativo:
<COLAR agyModelEvidence quando adaptive | N/A>

Fan-out de subagentes:
<COLAR: "agyParallel: yes — entregaveis independentes: <lista>" | "agyParallel: no">

Modelo dos subagentes:
<COLAR SUBAGENT_MODEL ou "inherit (omitir --subagent-model)">

Context7 MCP:
<MANTER SOMENTE SE DISPONIVEL>
- consulte documentacao atual antes de escrever codigo que usa libs/frameworks/APIs externos;
- use resolve-library-id com o nome oficial pontuado (ex: 'Next.js');
- se houver versao compativel com o projeto em Versions, use o ID '/org/project/version';
- faca query-docs com Single-Concept Scoping (consulta escopada a um unico conceito por vez);
- limite maximo de 3 consultas por tarefa; nunca use para logica de negocio interna;
- cite docs consultadas no retorno; senao siga padroes locais;

Codebase Memory MCP:
<MANTER SOMENTE SE DISPONIVEL>

Skills:
<LISTAR SKILLS DISPONIVEIS>

Regras:
- implemente apenas esta task;
- preserve padroes visuais e de estado;
- trate loading, erro, empty e sucesso;
- nao altere contrato sem sinalizar;
- valide consumo do payload real;
- confira casing JSON esperado no contrato;
- se a API vier de DTO C# ou mapper compartilhado, destaque qualquer dependencia de serializacao;
- use o bridge com `--model <AGY_MODEL>`;
- quando `agyParallel: yes`, decomponha os entregaveis listados em subtarefas Gemini nativas (`DefineSubagent`/`invoke_subagent`/`ManageSubagents`), execute-as concorrentemente e agregue os resultados; entregaveis dependentes ou que compartilhem estado ficam no subagente principal sem fan-out;
- nao solicite, sugira nem gere imagens; todas as decisoes visuais ja foram fechadas pelo Pensador e estao em `assets/manifest.json`;
- Shift-Left do Design System (consumir, nunca reinventar): quando `components.html` e `tokens.css` existirem, transpile os componentes HTML/CSS diretamente para a stack do projeto (React/Vue/etc.). NUNCA invente design, hierarquia, espacamentos ou layout do zero, e NUNCA use cores hexadecimais hardcoded fora dos tokens (`var(--*)`);
- quando houver contratos tipados gerados em `contracts/` (via `generate-contract-types.mjs`), importe e consuma estritamente as interfaces TypeScript geradas;
- auto-verificacao local obrigatoria antes de reportar DONE: execute a compilacao, typecheck e lint da sua fatia no seu workspace/worktree (`<BUILD_CMD>` / `npm run build` / `npx tsc --noEmit` / `npm run lint`); corrija qualquer erro de tipagem ou compilacao antes de finalizar; so retorne `Status: DONE` com exit code 0;
- se houver cota, retorne `Status: QUOTA_EXAUSTED`;
- se houver autenticacao pendente, retorne `Status: AUTH_REQUIRED`;
- se o `agy` nao existir no PATH do ambiente, retorne `Status: AGY_MISSING`;
- se houver timeout do bridge, retorne `Status: TIMEOUT`;
- se houver falha de escrita ou tools, pare e devolva ao orquestrador;
- se receber `SLOW_CHECKIN`, responda com progresso real, arquivos tocados, bloqueios, riscos e ETA.

Retorno:
0. Status: DONE | BLOCKED | FAILED | QUOTA_EXAUSTED | AUTH_REQUIRED | AGY_MISSING | TIMEOUT
1. Resumo do que foi implementado
2. Arquivos alterados
3. Decisoes de UI/UX
4. Estados tratados
5. Validacao do contrato e do wire format
6. Testes ou validacoes feitas
7. Pendencias
8. Riscos
9. Evidencia operacional
10. Skills utilizadas: <lista das skills usadas ou "nenhuma">
11. Subagentes Gemini nativos: <N | N/A>
12. Conversation IDs dos subagentes: <lista | N/A>
13. Tokens usados: input=<N> output=<N> cache_read=<N> total=<N>
    (informe N/A se a plataforma nao expor o dado)
14. ASSET_MATERIALIZATION: <ids materializados + destinos + seedBindings aplicados | N/A>
```

### 2a. Materializacao de imagery/icones

O Orquestrador nunca abre uma rodada de decisao visual. A materializacao acontece na Fase 4 (`references/workflow.md` secao 4.0), atras do gate deterministico `visualMaterialization` — nenhuma task front-end e despachada antes desse gate fechar `DONE`:

1. `materialize-visual-handoff.mjs` roda sem `--apply` primeiro; finding alto/critico bloqueia dispatch (o gate nao fecha).
2. Roda novamente com `--apply` para copiar somente o pacote `resolved` autoritativo e os assets conforme `materializeInto`; a saida vai para `design-materialization.json` e fecha o gate.
3. Ao despachar cada task front-end, passe `--design-system "<materializeInto>"` ao bridge (a mesma
   pasta de destino que o passo 2 acabou de preencher, ex.: `packages/ui/design-systems/<id>/`) —
   nao cole `design-contract.json`/`tokens.css`/`DESIGN.md`/`assets/manifest.json` em
   `--priority-files` nem no corpo do prompt: o bridge cc-antigravity-plugin 4.4.0+ entrega esses
   arquivos na integra fora do orcamento de `--max-files`/`--max-file-bytes` e do transporte por argv
   (ver Secao 2). Confirme no sidecar `<taskId>.agy.txt.audit.json` que `designSystems` lista o
   pacote esperado e que os arquivos centrais aparecem em `included` com `truncated: false`.
4. Aplique cada `seedBindings` e registre id, destino e binding no item 14.
5. Handoff sem `variant` e `legacy-verbatim`: registre degradacao, nao gere assets e aplique gates visuais reforcados.

## 3. SLOW_CHECKIN

```text
SLOW_CHECKIN - preciso de uma atualizacao operacional curta da task <TASK ID>.

Responda sem implementar trabalho novo nesta mensagem:
1. progresso concreto concluido
2. arquivos criados/alterados
3. bloqueios ou riscos
4. ETA honesto
5. existe falha de cota?
6. existe falha de tool, terminal, escrita ou criacao de arquivos?
```

## 4. Review back-end pos-implementacao - Codex (Fase 8)

**Despacho: chamada direta ao companion (ver Secao 1). O `read-only` deste review e uma garantia
estrutural, nao uma frase de prompt: `handleTask` em `codex-companion.mjs` faz
`write = Boolean(options.write)`, entao omitir `--write` na chamada abaixo torna a escrita
impossivel, independente do que o texto do prompt disser.**

```bash
node "<companionPath>" task \
  --cwd "<workspace do review>" \
  --prompt-file ".orchestrator/runs/<slug>/run/prompts/<taskId>-review.md" \
  --model gpt-5.6-sol --effort high --background --json
# SEM --write. Fallback se companionPath nao resolver: codex:codex-rescue, mesmo corpo de prompt,
# sem pedir escrita — e registre o fallback em report/workflow-log.md.
```

Corpo do prompt (persistido em `run/prompts/<taskId>-review.md`):

```text
Nao modifique arquivos. Apenas revise. Revise SOMENTE o back-end.

Revise a implementacao back-end realizada pelos subagentes para a especificacao <nome>.

Leia:
- a especificacao (PRD/spec) ingerida
- .orchestrator/runs/<nome>/plan/tasks-classification.md
- .orchestrator/runs/<nome>/plan/waves.md
- .orchestrator/runs/<nome>/contracts/
- .orchestrator/runs/<nome>/report/implementation-report.md secao 13 (matriz de rastreabilidade RF/CA -> evidencia)
- diff git da branch atual (apenas arquivos back-end)

Verifique:
- aderencia a especificacao no escopo back-end;
- **cada criterio de aceite (`CA`) das tasks back-end validado por inspecao direta do codigo** — nao delegue essa validacao a uma suite de testes; confirme o requisito olhando a implementacao real; confira a matriz de rastreabilidade contra o codigo real, nao apenas contra o texto do relatorio;
- **`// TODO`, `NotImplementedException`, stub vazio ou placeholder no caminho de codigo de um `RF`/`CA` do escopo e achado CRITICO/bloqueante**, mesmo que o build passe;
- contratos API (lado servidor);
- wire format e casing JSON no payload emitido;
- serializacao real contra TypeScript consumidor;
- auth/autorizacao, validacoes e tratamento de erro;
- migrations, persistencia, indices e integridade referencial;
- regressao no back-end;
- seguranca;
- build back-end sem erros;
- pendencias antes do merge.

Retorne:
1. Decisao: APROVADO | APROVADO_COM_RESSALVAS | REPROVADO
2. Problemas bloqueantes
3. Problemas nao bloqueantes
4. Recomendacoes
5. Checklist final
6. Tokens usados: input=<N> output=<N> cache_read=<N> total=<N>
   (informe N/A se a plataforma nao expor o dado)
```

Salve o resultado em `review/review-final.md`.

## 5. Review front-end pos-implementacao - Antigravity (AGY) (Fase 9)

**Subagent type:** `cc-antigravity-plugin:antigravity-agent`

**Parametros:**

```text
--read-only --format json --model pro-high --effort high [--timeout <AGY_TIMEOUT>] --dirs <DIRS_FRONT_END> [--design-system <DESIGN_SYSTEM_DIR>]
```

O review front-end usa sempre `pro-high` com effort `high`, independentemente do `agyModel` de implementacao. JSON e preferido aqui porque o review e curto e nao precisa de progresso NDJSON.
Passe `--design-system <DESIGN_SYSTEM_DIR>` (mesmo `materializeInto` da Fase 4.0) quando houver
pacote de design: garante que o revisor recebe `tokens.css`/`components.html`/`DESIGN.md` inteiros
para conferir fidelidade, em vez de depender de o modelo decidir ler esses arquivos por conta
propria dentro de `--dirs`.

**Corpo do prompt:**

```text
Voce e o revisor front-end desta entrega. NAO modifique arquivos. Apenas revise.

Revise a implementacao front-end realizada pelos subagentes para a especificacao <nome>.

Leia:
- a especificacao (PRD/spec) ingerida
- prototipos de referencia em prototypes/ (quando disponiveis no handoff)
- .orchestrator/runs/<nome>/plan/tasks-classification.md
- .orchestrator/runs/<nome>/contracts/
- .orchestrator/runs/<nome>/report/implementation-report.md secao 13 (matriz de rastreabilidade RF/CA -> evidencia)
- diff/arquivos front-end alterados

Verifique:
- aderencia a especificacao no escopo front-end;
- fidelidade visual contra os prototipos em prototypes/: a tela implementada deve espelhar o layout e hierarquia aprovados no discovery;
- **cada criterio de aceite (`CA`) das tasks front-end validado por inspecao direta do codigo/comportamento** — nao delegue essa validacao a uma suite de testes; confirme o requisito olhando a implementacao real; confira a matriz de rastreabilidade contra a tela/componente real, nao apenas contra o texto do relatorio;
- **`// TODO`, placeholder de conteudo fixo (copy generico onde o requisito pede dado real) ou estado vazio nao implementado no caminho de um `RF`/`CA` do escopo e achado CRITICO/bloqueante**, mesmo que o build/typecheck/lint passem;
- consumo correto do contrato API/UI: wire format, casing JSON e serializacao real contra o TypeScript consumidor;
- estados de UI tratados (loading, erro, empty, sucesso);
- tipagem TypeScript, build, typecheck e lint;
- acessibilidade e consistencia visual quando aplicavel;
- arquivos alterados fora do escopo;
- regressao potencial em telas/fluxos existentes.

Gate de design system (quando houver design system — Open Design):
- o estilo consome `tokens.css` via custom properties (`var(--*)`); SEM hex/raio/espacamento inventado fora dos tokens;
- componentes batem com seletores/estados de `components.html` (default/hover/focus/active/disabled/loading/empty/error);
- **elementos interativos (botoes, links, cards clicaveis) tem estado `:hover`/`:focus` real, implementado como regra CSS/CSS-Modules/styled/Tailwind — NAO como `style={{}}` inline.** Inline style e estruturalmente incapaz de expressar `:hover`/`:focus`/`@keyframes`; se `components.html` especifica hover (ex.: `.btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); }`), o componente entregue precisa do equivalente real, nao so o estado default. Grep rapido de sanidade: proporcao alta de `style={{` sem nenhuma regra `:hover`/`:focus` no CSS do projeto e sinal de gate falho;
- accent usado no maximo 2x por pagina (hero + CTA) alem de links; sem flood; sem emoji como icone; sem sombra se Depth & Elevation = minimal;
- telas-chave conferidas contra o diretorio `preview/` (diferenca de layout/hierarquia/contraste; abrir `colors.html`, `spacing.html` ou `typography.html` conforme os arquivos disponiveis no system);
- no modo Spec, os requisitos da capability `ui-design-system` (specs/ui-design-system/spec.md) sao atendidos (cada cenario);
- anti-padroes da secao 9 do DESIGN.md ausentes do codigo final.
- Trate violacao de design system como problema BLOQUEANTE quando contrariar requisito explicito (override sem justificativa, token inventado, accent flood, elemento interativo sem hover/focus real).

Regras de status:
- se houver cota, retorne `Status: QUOTA_EXAUSTED`;
- se houver autenticacao pendente, retorne `Status: AUTH_REQUIRED`;
- se o `agy` nao existir no PATH, retorne `Status: AGY_MISSING`;
- se houver timeout do bridge, retorne `Status: TIMEOUT`.

Retorne:
0. Status: DONE | QUOTA_EXAUSTED | AUTH_REQUIRED | AGY_MISSING | TIMEOUT
1. Decisao: APROVADO | APROVADO_COM_RESSALVAS | REPROVADO
2. Problemas bloqueantes (severidade, arquivo/trecho, impacto, correcao esperada)
3. Problemas nao bloqueantes
4. Recomendacoes
5. Checklist final
6. Tokens usados: input=<N> output=<N> cache_read=<N> total=<N>
   (informe N/A se a plataforma nao expor o dado)
```

Salve o resultado em `review/review-frontend.md`.

> Se o AGY retornar `QUOTA_EXAUSTED`, `AUTH_REQUIRED`, `AGY_MISSING` ou `TIMEOUT`, o orquestrador faz review interno read-only do front-end e registra o fallback em `review/review-frontend.md`.

## 6. Ajustes pontuais - Codex

Use Codex para ajustes pontuais de implementacao back-end, handoff ou sincronizacao — `--model
gpt-5.6-terra` (papel implement); quando o ajuste vier de um achado da Fase 9.5 ou de review
`REPROVADO`, use `--model gpt-5.6-luna` (papel fix) em vez disso:

```text
--model gpt-5.6-terra --effort medium

Ajuste pontual na implementacao:
- arquivo: <PATH>
- problema: <DESCRICAO>
- mudanca esperada: <ESPECIFICACAO>

Nao altere nada fora do escopo informado.
Se houver cota, retorne `Status: QUOTA_EXHAUSTED`.
Se houver rede externa bloqueada, pacote ausente no cache local ou escrita fora do working directory permitido, retorne `Status: BLOCKED` com evidencia.
```

> Ajustes pontuais de front-end voltam para o AGY (`cc-antigravity-plugin:antigravity-coder`) com `--model <agyModel>`, nao para o Codex. `antigravity-agent` e somente leitura e nao pode aplicar ajustes.

## 7. Fallback operacional e de cota

- **Implementacao back-end com Codex em `QUOTA_EXHAUSTED`**: o fallback de implementacao delega exclusivamente para o AGY (`cc-antigravity-plugin:antigravity-coder`) com modelos Gemini nativos (`gemini-3.8-flash-medium` para tarefas pontuais/CRUDs/seeds e `gemini-3.8-flash-high` para arquitetura/seguranca). **NUNCA** delegar para modelos Claude ou subagentes `claude-code`, preservando a cota da sessao principal.
- **Review back-end com Codex em `QUOTA_EXHAUSTED`**: o orquestrador faz review interno read-only, salva em `review/review-final.md` e deixa claro que foi fallback do orquestrador.
- **Review front-end com AGY em `QUOTA_EXAUSTED`/`AUTH_REQUIRED`/`AGY_MISSING`/`TIMEOUT`**: o orquestrador faz review interno read-only, salva em `review/review-frontend.md` e deixa claro que foi fallback do orquestrador.
- **Implementacao front-end com AGY em `QUOTA_EXAUSTED`**: seguir a politica de fallback descrita em `workflow.md`.

Em nenhum caso o orquestrador troca modelo a esmo ou utiliza Claude para fatias de implementacao de outros agentes.
