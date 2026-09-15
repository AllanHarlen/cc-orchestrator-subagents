#!/usr/bin/env node
/**
 * Validate generated orchestrator routing artifacts.
 *
 * Usage:
 *   node "${CLAUDE_SKILL_DIR}/scripts/validate-routing.mjs" .orchestration/<name>
 *   node scripts/validate-routing.mjs .orchestration/<name>
 *   node scripts/validate-routing.mjs .orchestration/<name> --root .
 *   node scripts/validate-routing.mjs .orchestration/<name> --project-config .orchestrator/project-config.md
 *
 * O roteamento esperado nao e mais constante: ele e derivado da Project_Config
 * (`.orchestrator/project-config.md`) pela mesma funcao que o Orquestrador usa
 * para classificar a task (`resolveExecutorForCategory`). Quando o arquivo nao
 * existe, vale a configuracao padrao (`codex`/`agy`/`codex`/`agy`), que reproduz
 * exatamente o comportamento historico deste validador.
 *
 * Bloco de task que declara `executor` e validado contra a derivacao. Bloco sem
 * `executor` (artefato legado) continua sendo validado pela heuristica de
 * mencao de agente.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import {
  ARTIFACT_LAYOUT_VERSION,
  artifactRelativePath,
  resolveArtifact,
} from "./lib/artifact-layout.mjs";
import {
  CATEGORY_ROLE,
  EXECUTORS,
  EXECUTOR_SOURCE_PROJECT_CONFIG,
  ProjectConfigError,
  TASK_CATEGORIES,
  defaultProjectConfig,
  parseProjectConfig,
  readProjectConfig,
  resolveExecutorForCategory,
} from "./lib/project-config.mjs";
import {
  CODEX_EFFORT_LEVELS,
  CODEX_ROLE_BY_MODEL,
  codexRoleForTask,
  isKnownCodexModel,
} from "./lib/codex-router.mjs";

const CATEGORIES = [...TASK_CATEGORIES];

// Mesma gramatica de ID do State Engine (scripts/lib/orchestration-state.mjs, TASK_ID_SOURCE).
// Aceita T1, T12-A, BE-01, FE-001-B. Os dois parsers precisam concordar sobre o que e uma
// task: um ID valido para o State Engine que este validador nao reconhecesse tornaria o gate
// de roteamento inalcancavel para a classificacao inteira.
// O lookahead descarta versao (`gemini-3.5`): sem ele, o nome de modelo AGY que aparece em
// toda linha de roteamento seria lido como task e poderia virar o ID do bloco numa tabela.
const TASK_ID_SOURCE = "(?:[A-Z]{1,8}-\\d{1,4}(?!\\.\\d)(?:-[A-Z0-9]+)?|T\\d+(?:-[A-Z0-9]+)?)";
const TASK_RE = new RegExp(`\\b${TASK_ID_SOURCE}\\b`, "gi");
// Achado 11: mesma exclusao de `orchestration-state.mjs` — `CT-08` (id de
// contrato) casa com a gramatica de task ID e nao pode virar bloco fantasma
// aqui tampouco. Os dois parsers precisam concordar sobre o que e task.
const RESERVED_TASK_ID_PREFIXES = new Set(["CT"]);
const FRONTEND_AGENT_RE = /\b(cc-antigravity-plugin:antigravity-coder|antigravity|agy)\b/i;
// antigravity-agent e o subagente somente-leitura do plugin AGY (analise/review). Ele nunca
// pode receber task de implementacao; quem cria e edita arquivo e o antigravity-coder.
const READ_ONLY_AGY_AGENT_RE = /\b(?:cc-antigravity-plugin:)?antigravity-agent\b/i;
const CODEX_AGENT_RE = /\b(codex:codex-rescue|codex)\b/i;
const CODEX_MEDIUM_RE = /--effort\s+medium/i;
const CODEX_HIGH_RE = /--effort\s+high/i;
const AGY_MODEL_RE = /(?:^|[\s|,])(?:agyModel(?!Source)|--agy-model|--model)\b\s*[:=]?\s*`?([a-z0-9.-]+(?:-[a-z0-9.-]+)*)`?/im;
const AGY_MODEL_SOURCE_RE = /agyModelSource\s*[:=]?\s*`?(user|heuristic|adaptive)`?/i;
const AGY_ADAPTIVE_SOURCE_RE = /agyModelSource\s*[:=]?\s*`?adaptive`?/i;
const AGY_ADAPTIVE_EVIDENCE_RE = /agyModelEvidence\s*[:=]?\s*`?[^`\n]+`?/i;
const AGY_SUBAGENT_MODEL_RE = /agySubagentModel\s*[:=]?\s*`?([a-z0-9.-]+(?:-[a-z0-9.-]+)*)`?/im;
const AGY_PARALLEL_RE = /\bagyParallel\b/i;
const AGY_EFFORT_RE = /(?:agyEffort|--agy-effort|--effort)\b\s*[:=]?\s*`?([^`\s|,]+)/i;
const AGY_TIMEOUT_RE = /(?:agyTimeout|--agy-timeout|--timeout)\b\s*[:=]?\s*`?([^`\s|,]+)/i;
const AGY_FORMAT_RE = /(?:agyFormat|--format)\b\s*[:=]?\s*`?([^`\s|,]+)/i;
// Vocabulario de modelo do Codex, espelhando o vocabulario de AGY acima
// (Achado 13 da run oficina-saas-20260905-001: o Codex nao tinha onde
// expressar modelo/effort na classificacao, e 10 de 11 threads rodaram o
// modelo de review fazendo implementacao). Campo dedicado `codexModel` — nao
// `--model`, que colidiria com o vocabulario AGY no mesmo bloco FULLSTACK.
const CODEX_MODEL_RE = /(?:^|[\s|,])(?:codexModel(?!Source)|--codex-model)\b\s*[:=]?\s*`?([a-z0-9.-]+(?:-[a-z0-9.-]+)*)`?/im;
const CODEX_MODEL_SOURCE_RE = /codexModelSource\s*[:=]?\s*`?(user|heuristic|adaptive)`?/i;
const CODEX_EFFORT_FIELD_RE = /(?:codexEffort|--codex-effort)\b\s*[:=]?\s*`?([^`\s|,]+)/i;
// Identificadores de subagente externo. Task com executor `claude-code` nao pode
// invocar Codex (direto via codex-companion.mjs, ou via o fallback `codex:codex-rescue`)
// nem subagente do `cc-antigravity-plugin` (Req 7.11). Cobre os dois caminhos porque o
// orquestrador despacha para Codex chamando codex-companion.mjs diretamente
// (references/subagent-prompts.md Secao 1), e cai para codex:codex-rescue apenas quando
// companionPath nao resolve.
const CODEX_SUBAGENT_RE = /\bcodex:codex-rescue\b|\bcodex-companion\.mjs\b/i;
const AGY_PLUGIN_SUBAGENT_RE = /\bcc-antigravity-plugin:[a-z-]+/i;
// `executor` declarado no bloco. O lookahead descarta `executorSource`, que e o
// campo de origem da decisao e nunca carrega o nome do executor.
// O separador e capturado: sem `:` ou `=`, um valor fora do conjunto permitido e
// tratado como prosa ("executor derivado da configuracao"), nao como declaracao.
const EXECUTOR_DECLARATION_RE = /(?:^|[\s|,(])(?:executor(?!source)|--executor)\b[\t ]*(:|=)?[\t ]*`?([A-Za-z0-9._-]+)`?/gi;
const EXECUTOR_SOURCE_RE = /\bexecutorSource\b[\t ]*[:=]?[\t ]*`?([A-Za-z0-9._-]+)`?/i;
// Registro do review read-only feito pelo Claude Code (Req 7.10).
const READ_ONLY_REVIEW_RECORD_RE = /review\/(?:review-final|review-frontend)\.md/i;
const ROUTER_AGY_MODELS = new Set([
  "flash-low",
  "flash-medium",
  "flash-high",
  "pro-low",
  "pro-high",
  "auto",
]);
// Artifacts from runs created before 4.2 remain valid on resume. New
// heuristic/adaptive decisions use the stable aliases above.
const LEGACY_AGY_MODELS = new Set([
  "gemini-3.5-flash-low",
  "gemini-3.5-flash-medium",
  "gemini-3.5-flash-high",
  "gemini-3.1-pro-low",
  "gemini-3.1-pro-high",
]);

// Escada de capacidade (SKILL.md): flash-low < flash-medium < flash-high < pro-low < pro-high.
// Tasks que implementam um design system (Open Design) exigem julgamento visual e nunca
// podem usar os dois tiers mais baixos da escada Gemini — ver regra "Roteamento por
// fidelidade de design" no SKILL.md. Modelos fora da escada Gemini (claude-*, gpt-oss,
// auto) nao tem tier conhecido aqui; nao sao bloqueados por esta regra especifica.
const LOW_TIER_AGY_MODELS = new Set([
  "flash-low",
  "flash-medium",
  "gemini-3.5-flash-low",
  "gemini-3.5-flash-medium",
]);
const DESIGN_SYSTEM_SIGNAL_RE = /\b(tokens\.css|components\.html|design-systems?\/|DESIGN\.md|design[- ]system)\b/i;

const USAGE = [
  "Usage: node validate-routing.mjs <.orchestration/<name>> [--root <dir>] [--project-config <path>]",
  "",
  "  --root <dir>             raiz do projeto de onde a Project_Config e resolvida",
  "                           (default: raiz inferida do diretorio da run)",
  "  --project-config <path>  caminho explicito do Project_Config_File",
].join("\n");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const positionals = [];
  let projectConfigArg = null;
  let rootArg = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === "--project-config" || arg === "--root") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) fail(`Flag ${arg} exige um valor.\n\n${USAGE}`);
      if (arg === "--root") rootArg = value;
      else projectConfigArg = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--project-config=")) {
      projectConfigArg = arg.slice("--project-config=".length);
      if (projectConfigArg === "") fail(`Flag --project-config exige um valor.\n\n${USAGE}`);
      continue;
    }
    if (arg.startsWith("--root=")) {
      rootArg = arg.slice("--root=".length);
      if (rootArg === "") fail(`Flag --root exige um valor.\n\n${USAGE}`);
      continue;
    }
    if (arg.startsWith("--")) fail(`Flag desconhecida: ${arg}\n\n${USAGE}`);
    positionals.push(arg);
  }

  return { positionals, projectConfigArg, rootArg };
}

/**
 * Infere a raiz do projeto a partir do diretorio da run.
 *
 * `<root>/.orchestration/<slug>` e o layout canonico, entao o pai do segmento
 * `.orchestration` e a raiz. Fora desse layout, cai no diretorio corrente.
 */
function inferProjectRoot(runDir) {
  const parts = runDir.split(sep);
  // Achado 14: `.orchestrator/runs/<slug>` (layout atual) e
  // `.orchestration/<slug>` (legado) tem profundidades diferentes ate a
  // raiz do projeto — a raiz fica dois segmentos acima de `runs` no
  // primeiro caso, um acima de `.orchestration` no segundo.
  const runsIndex = parts.lastIndexOf("runs");
  if (runsIndex > 0 && parts[runsIndex - 1] === ".orchestrator") {
    return parts.slice(0, runsIndex - 1).join(sep) || sep;
  }
  const index = parts.lastIndexOf(".orchestration");
  if (index > 0) return parts.slice(0, index).join(sep) || sep;
  return process.cwd();
}

/**
 * Resolve a Project_Config usada como fonte da derivacao de executor.
 *
 * `--project-config` tem precedencia sobre `--root`. Arquivo ausente cai na
 * configuracao padrao (`source: "default"`); arquivo presente e invalido vira
 * `ProjectConfigError`, que o chamador transforma em falha de validacao.
 */
function loadProjectConfig({ projectConfigArg, rootArg, runDir }) {
  if (projectConfigArg !== null) {
    const path = resolve(projectConfigArg);
    if (!existsSync(path)) return { config: defaultProjectConfig(), source: "default", path };
    return { config: parseProjectConfig(readFileSync(path, "utf8"), { path }), source: "file", path };
  }
  const root = rootArg !== null ? resolve(rootArg) : inferProjectRoot(runDir);
  const result = readProjectConfig(root);
  return { config: result.config, source: result.source, path: result.path };
}

const { positionals, projectConfigArg, rootArg } = parseArgs(process.argv.slice(2));
const targetDir = resolve(positionals[0] ?? process.cwd());
// Aceita layout 1 (artefatos na raiz da run) e layout 2 (`plan/`). Quando o
// arquivo nao existe em nenhum dos dois, o erro aponta o caminho do layout atual.
const requiredFiles = ["tasks-classification.md", "waves.md"].map(
  (name) =>
    resolveArtifact(targetDir, name)?.path ??
    join(targetDir, ...artifactRelativePath(name, ARTIFACT_LAYOUT_VERSION).split("/")),
);

let projectConfig;
let projectConfigSource;
let projectConfigFile;
try {
  const resolved = loadProjectConfig({ projectConfigArg, rootArg, runDir: targetDir });
  projectConfig = resolved.config;
  projectConfigSource = resolved.source;
  projectConfigFile = resolved.path;
} catch (error) {
  if (error instanceof ProjectConfigError) {
    fail(
      `Routing validation failed:\n- Project_Config invalida (${error.code}): ${error.message}\n`
        + "  Corrija ou remova o arquivo antes de validar o roteamento.",
    );
  }
  throw error;
}

const projectConfigLabel = projectConfigSource === "file" ? projectConfigFile : "configuracao padrao";

const errors = [];
const warnings = [];

function readRequired(file) {
  if (!existsSync(file)) {
    errors.push(`Arquivo obrigatorio ausente: ${file}`);
    return "";
  }

  // Strip UTF-8 BOM if present (common on Windows editors)
  const content = readFileSync(file, "utf8");
  return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
}

function uniqueTaskIds(text) {
  const ids = [...text.matchAll(TASK_RE)].map((match) => match[0].toUpperCase());
  const filtered = ids.filter((id) => !RESERVED_TASK_ID_PREFIXES.has(id.split("-")[0]));
  return [...new Set(filtered)];
}

function findCategory(text) {
  return CATEGORIES.find((category) => new RegExp(`\\b${category}\\b`).test(text));
}

function hasFrontendAgent(text) {
  return FRONTEND_AGENT_RE.test(text);
}

function hasCodexAgent(text) {
  return CODEX_AGENT_RE.test(text) || CODEX_MEDIUM_RE.test(text) || CODEX_HIGH_RE.test(text);
}

function extractAgyModel(text) {
  const match = text.match(AGY_MODEL_RE);
  return match?.[1] ?? null;
}

function hasAgyModelSource(text) {
  return AGY_MODEL_SOURCE_RE.test(text);
}

function extractAgyModelSource(text) {
  return text.match(AGY_MODEL_SOURCE_RE)?.[1]?.toLowerCase() ?? null;
}

function extractParameter(text, pattern) {
  return text.match(pattern)?.[1] ?? null;
}

function validModelToken(value) {
  return typeof value === "string" && value.length <= 200 && /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}

function extractAgySubagentModel(text) {
  const match = text.match(AGY_SUBAGENT_MODEL_RE);
  return match?.[1] ?? null;
}

function extractCodexModel(text) {
  return text.match(CODEX_MODEL_RE)?.[1] ?? null;
}

function hasCodexModelSource(text) {
  return CODEX_MODEL_SOURCE_RE.test(text);
}

function extractCodexModelSource(text) {
  return text.match(CODEX_MODEL_SOURCE_RE)?.[1]?.toLowerCase() ?? null;
}

function extractCodexEffort(text) {
  return text.match(CODEX_EFFORT_FIELD_RE)?.[1] ?? null;
}

/**
 * Executores declarados no bloco, na ordem de aparicao e sem repeticao.
 *
 * Um bloco `FULLSTACK` pode declarar dois (uma fatia por executor), por isso a
 * extracao devolve lista em vez de valor unico.
 */
function extractExecutorDeclarations(text) {
  const declarations = [];
  for (const match of text.matchAll(EXECUTOR_DECLARATION_RE)) {
    const separator = match[1] ?? null;
    const raw = String(match[2] ?? "").trim();
    if (raw === "") continue;
    const value = raw.toLowerCase();
    // Sem `:` ou `=`, so aceita token que seja de fato um executor: evita ler
    // prosa ("executor derivado da Project_Config") como declaracao invalida.
    if (separator === null && !EXECUTORS.includes(value)) continue;
    if (declarations.some((item) => item.value === value)) continue;
    declarations.push({ value, raw });
  }
  return declarations;
}

function extractExecutorSource(text) {
  const match = text.match(EXECUTOR_SOURCE_RE);
  return match?.[1]?.trim().toLowerCase() ?? null;
}

const expectationCache = new Map();

/**
 * Executores esperados para a categoria, derivados da Project_Config vigente.
 *
 * `FULLSTACK` devolve os dois papeis (`backendExecutor` na fatia back-end e
 * `frontendExecutor` na fatia front-end); as outras categorias devolvem um.
 */
function expectationFor(category) {
  if (expectationCache.has(category)) return expectationCache.get(category);
  const resolved = resolveExecutorForCategory(category, projectConfig);
  const expectation = category === "FULLSTACK"
    ? {
      category,
      fullstack: true,
      backend: resolved.backend,
      frontend: resolved.frontend,
      values: [...new Set([resolved.backend, resolved.frontend])],
      roleLabel: "backendExecutor + frontendExecutor",
    }
    : {
      category,
      fullstack: false,
      executor: resolved.executor,
      values: [resolved.executor],
      roleLabel: CATEGORY_ROLE[category],
    };
  expectationCache.set(category, expectation);
  return expectation;
}

function formatExecutorList(values) {
  return values.map((value) => `\`${value}\``).join(" ou ");
}

function extractBlocks(content) {
  const lines = content.split(/\r?\n/);
  const blocks = [];
  let current = null;

  function pushCurrent() {
    if (current && current.lines.length > 0) {
      blocks.push({
        ids: [...current.ids],
        text: current.lines.join("\n"),
      });
    }
    current = null;
  }

  // Uma entrada de wave costuma ser um item de lista ("- FE-01 -> agente"), formato que o
  // State Engine tambem aceita. O ID precisa abrir o item para que uma mencao no meio de uma
  // frase ("depende de FE-01") nao quebre o bloco em que ela aparece.
  const taskListItemRe = new RegExp(`^\\s*[-*+]\\s*\`?${TASK_ID_SOURCE}\\b`, "i");

  for (const line of lines) {
    const ids = uniqueTaskIds(line);
    const isTaskHeading = ids.length > 0 && /^#{2,6}\s+/.test(line);
    const isTaskTableRow = ids.length > 0 && /^\s*\|/.test(line);
    const isTaskIdLine = ids.length > 0 && /^\s*[-*+]?\s*(?:\*\*\s*ID\s*(?::\s*\*\*|\*\*\s*:)|ID\s*:)/i.test(line);
    const isTaskListItem = ids.length > 0 && taskListItemRe.test(line);

    if (isTaskTableRow) {
      blocks.push({ ids: [ids[0]], text: line });
      continue;
    }

    if (isTaskHeading || isTaskIdLine || isTaskListItem) {
      pushCurrent();
      current = { ids: new Set([ids[0]]), lines: [line] };
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  pushCurrent();
  return blocks;
}

function validateBlock(source, block, categoryByTask) {
  const category = findCategory(block.text);
  const ids = block.ids.length > 0 ? block.ids : ["<sem task id>"];

  for (const id of ids) {
    const taskCategory = category ?? categoryByTask.get(id);

    if (!taskCategory) {
      errors.push(`${source}: ${id} sem categoria conhecida. Registre a task em tasks-classification.md.`);
      continue;
    }

    const expectation = expectationFor(taskCategory);
    const declarations = extractExecutorDeclarations(block.text);
    const declaresExecutor = declarations.length > 0;

    for (const declaration of declarations) {
      if (!EXECUTORS.includes(declaration.value)) {
        errors.push(`${source}: ${id} declara executor invalido (${declaration.raw}). Executores aceitos: ${EXECUTORS.join(", ")}.`);
      }
    }

    const declared = declarations
      .filter((declaration) => EXECUTORS.includes(declaration.value))
      .map((declaration) => declaration.value);

    for (const value of declared) {
      if (!expectation.values.includes(value)) {
        errors.push(`${source}: ${id} e ${taskCategory} e declara executor \`${value}\`, mas a Project_Config (${projectConfigLabel}) deriva ${formatExecutorList(expectation.values)} para essa categoria (${expectation.roleLabel}).`);
      }
    }

    if (expectation.fullstack && declared.length > 0 && expectation.values.length > 1) {
      const missing = expectation.values.filter((value) => !declared.includes(value));
      if (missing.length > 0) {
        warnings.push(`${source}: ${id} e FULLSTACK, mas o bloco so declara ${formatExecutorList(declared)}. Confirme que a fatia com ${formatExecutorList(missing)} esta registrada em outro bloco.`);
      }
    }

    if (declaresExecutor) {
      const executorSource = extractExecutorSource(block.text);
      if (executorSource === null) {
        errors.push(`${source}: ${id} declara executor, mas nao registra executorSource: ${EXECUTOR_SOURCE_PROJECT_CONFIG}. Exemplo: "- executor: \`agy\`" + "- executorSource: \`${EXECUTOR_SOURCE_PROJECT_CONFIG}\`".`);
      } else if (executorSource !== EXECUTOR_SOURCE_PROJECT_CONFIG) {
        errors.push(`${source}: ${id} registra executorSource invalido (${executorSource}). Valor aceito: ${EXECUTOR_SOURCE_PROJECT_CONFIG}.`);
      }
    }

    // Executores efetivos do bloco: o declarado quando existe, a derivacao da
    // Project_Config quando o bloco e legado.
    const effective = declared.length > 0 ? [...new Set(declared)] : expectation.values;
    const frontendMention = hasFrontendAgent(block.text);
    const codexMention = hasCodexAgent(block.text);
    // Regras de AGY valem integralmente quando o executor esperado e `agy`; no
    // bloco legado, a heuristica por mencao de agente e preservada.
    const frontend = declaresExecutor ? effective.includes("agy") : frontendMention;
    const codex = declaresExecutor ? effective.includes("codex") : codexMention;
    const claudeCode = effective.includes("claude-code");

    if (["FRONTEND_ONLY", "FULLSTACK"].includes(taskCategory) && READ_ONLY_AGY_AGENT_RE.test(block.text)) {
      errors.push(`${source}: ${id} e ${taskCategory}, mas delega implementacao a cc-antigravity-plugin:antigravity-agent, que e somente leitura. Use cc-antigravity-plugin:antigravity-coder; antigravity-agent so e valido no review de front-end da Fase 9.`);
    }

    const agyModel = extractAgyModel(block.text);
    const agyModelSource = extractAgyModelSource(block.text);
    const agyEffort = extractParameter(block.text, AGY_EFFORT_RE);
    const agyTimeout = extractParameter(block.text, AGY_TIMEOUT_RE);
    const agyFormat = extractParameter(block.text, AGY_FORMAT_RE);

    // Executor `claude-code` nao carrega parametro de AGY: o Orquestrador omite
    // agyModel, agyParallel e agySubagentModel nessas tasks (Req 7.8).
    if (claudeCode && !frontend) {
      if (agyModel) {
        errors.push(`${source}: ${id} tem executor \`claude-code\`, mas registra agyModel (${agyModel}). Omita agyModel, agyParallel e agySubagentModel em task delegada ao Claude Code.`);
      }
      if (AGY_PARALLEL_RE.test(block.text)) {
        errors.push(`${source}: ${id} tem executor \`claude-code\`, mas registra agyParallel. Omita agyModel, agyParallel e agySubagentModel em task delegada ao Claude Code.`);
      }
      if (agyEffort || agyTimeout || agyFormat) {
        errors.push(`${source}: ${id} tem executor \`claude-code\`, mas registra parametro AGY. Omita agyModel, agyParallel e agySubagentModel, alem de agyEffort, agyTimeout e agyFormat.`);
      }
      const claudeCodeSubagentModel = extractAgySubagentModel(block.text);
      if (claudeCodeSubagentModel) {
        errors.push(`${source}: ${id} tem executor \`claude-code\`, mas registra agySubagentModel (${claudeCodeSubagentModel}). Omita agyModel, agyParallel e agySubagentModel em task delegada ao Claude Code.`);
      }
    }

    // Vocabulario de modelo do Codex (Achado 13). Espelha as regras de AGY
    // acima: task apontando para Codex precisa registrar codexModel +
    // codexModelSource; executor `claude-code` nao carrega parametro de Codex.
    const codexModel = extractCodexModel(block.text);
    const codexModelSource = extractCodexModelSource(block.text);
    const codexEffort = extractCodexEffort(block.text);

    if (claudeCode && !codex) {
      if (codexModel) {
        errors.push(`${source}: ${id} tem executor \`claude-code\`, mas registra codexModel (${codexModel}). Omita codexModel e codexEffort em task delegada ao Claude Code.`);
      }
      if (codexEffort) {
        errors.push(`${source}: ${id} tem executor \`claude-code\`, mas registra codexEffort (${codexEffort}). Omita codexModel e codexEffort em task delegada ao Claude Code.`);
      }
    }

    if (codex) {
      if (!codexModel) {
        errors.push(`${source}: ${id} aponta para Codex, mas nao registra codexModel/--codex-model. Exemplo: "- codexModel: \`gpt-5.6-terra\`" + "- codexModelSource: \`heuristic\`".`);
      } else if (!validModelToken(codexModel)) {
        errors.push(`${source}: ${id} usa codexModel invalido (${codexModel}). Use um dos slugs do vocabulario Codex (gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna).`);
      }

      if (!hasCodexModelSource(block.text)) {
        errors.push(`${source}: ${id} aponta para Codex, mas nao registra codexModelSource=user|heuristic|adaptive. Exemplo: "- codexModel: \`gpt-5.6-terra\`" + "- codexModelSource: \`heuristic\`".`);
      }

      if (codexEffort && !CODEX_EFFORT_LEVELS.includes(codexEffort)) {
        errors.push(`${source}: ${id} usa codexEffort invalido (${codexEffort}). Valores aceitos: ${CODEX_EFFORT_LEVELS.join(", ")}.`);
      }

      if (codexModel && validModelToken(codexModel)) {
        const isKnown = isKnownCodexModel(codexModel);
        if (!isKnown && codexModelSource !== "user") {
          errors.push(`${source}: ${id} usa codexModel ${codexModel} com source ${codexModelSource ?? "ausente"}. Routing heuristic/adaptive deve usar um dos slugs do vocabulario Codex (gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna); slug fora do vocabulario exige source user.`);
        } else if (!isKnown && codexModelSource === "user") {
          warnings.push(`${source}: ${id} usa codexModel ${codexModel} fora do vocabulario de papeis do Codex (gpt-5.6-sol/terra/luna) com source user; confirme que a escolha e intencional.`);
        }

        if (isKnown) {
          const modelRole = CODEX_ROLE_BY_MODEL[codexModel];
          const expectedRole = codexRoleForTask({ category: taskCategory });
          if (expectedRole && modelRole !== expectedRole) {
            if (taskCategory === "REVIEW_ONLY") {
              errors.push(`${source}: ${id} e REVIEW_ONLY, mas usa codexModel ${codexModel} (papel ${modelRole}). Review usa o modelo de papel review (gpt-5.6-sol).`);
            } else {
              errors.push(`${source}: ${id} e ${taskCategory} (implementacao), mas usa codexModel ${codexModel} (papel ${modelRole}). Implementacao nunca usa o modelo de papel review; use o modelo de papel implement (gpt-5.6-terra).`);
            }
          }
        }
      }
    }

    // Stack toda `claude-code` nao invoca subagente externo (Req 7.11).
    if (effective.length > 0 && effective.every((value) => value === "claude-code")) {
      if (CODEX_SUBAGENT_RE.test(block.text)) {
        errors.push(`${source}: ${id} tem executor \`claude-code\`, mas invoca Codex (\`codex:codex-rescue\` ou \`codex-companion.mjs\` direto). Com a Project_Config (${projectConfigLabel}) essa task e implementada por subagente do Claude Code.`);
      }
      if (AGY_PLUGIN_SUBAGENT_RE.test(block.text)) {
        errors.push(`${source}: ${id} tem executor \`claude-code\`, mas invoca subagente do \`cc-antigravity-plugin\`. Com a Project_Config (${projectConfigLabel}) essa task e implementada por subagente do Claude Code.`);
      }
    }

    if (frontend && !agyModel) {
      errors.push(`${source}: ${id} aponta para AGY, mas nao registra agyModel/--model (alias legado: --agy-model). Exemplo: "- agyModel: \`flash-high\`" + "- agyModelSource: \`heuristic\`".`);
    }

    if (frontend && agyModel && !validModelToken(agyModel)) {
      errors.push(`${source}: ${id} usa agyModel invalido (${agyModel}). Use um alias ou slug aceito pelo bridge.`);
    }

    if (frontend && agyModel && agyModelSource !== "user" &&
        !ROUTER_AGY_MODELS.has(agyModel) && !LEGACY_AGY_MODELS.has(agyModel)) {
      errors.push(`${source}: ${id} usa agyModel ${agyModel} com source ${agyModelSource ?? "ausente"}. Routing heuristic/adaptive deve usar aliases flash-low|flash-medium|flash-high|pro-low|pro-high|auto; slugs dinamicos exigem source user.`);
    }

    if (frontend && agyModel && LEGACY_AGY_MODELS.has(agyModel)) {
      warnings.push(`${source}: ${id} preserva slug legado ${agyModel}; novas decisoes devem usar alias familia/tier do bridge 4.0.`);
    }

    if (frontend && agyModel && LOW_TIER_AGY_MODELS.has(agyModel) && DESIGN_SYSTEM_SIGNAL_RE.test(block.text)) {
      errors.push(`${source}: ${id} implementa design system (tokens.css/components.html/DESIGN.md) mas usa agyModel de tier baixo (${agyModel}). Fidelidade visual exige no minimo flash-high (ver "Roteamento por fidelidade de design" no SKILL.md).`);
    }

    const agySubagentModel = extractAgySubagentModel(block.text);
    if (agySubagentModel && agySubagentModel !== "inherit" && !validModelToken(agySubagentModel)) {
      errors.push(`${source}: ${id} usa agySubagentModel invalido (${agySubagentModel}). Use um alias/slug do bridge ou "inherit".`);
    }

    if (agyEffort && !["low", "medium", "high"].includes(agyEffort)) {
      errors.push(`${source}: ${id} usa agyEffort invalido (${agyEffort}). Valores aceitos: low, medium, high.`);
    }
    if (agyTimeout && !/^\d+(?:ms|s|m|h)?(?:0s)?$/.test(agyTimeout)) {
      errors.push(`${source}: ${id} usa agyTimeout invalido (${agyTimeout}). Use uma duracao como 300s ou 5m.`);
    }
    if (agyFormat && !["json", "stream-json"].includes(agyFormat)) {
      errors.push(`${source}: ${id} usa agyFormat invalido (${agyFormat}). Valores aceitos: json, stream-json.`);
    }
    if (frontend && /antigravity-coder/i.test(block.text) && agyFormat && agyFormat !== "stream-json") {
      errors.push(`${source}: ${id} delega implementacao ao antigravity-coder, mas usa agyFormat ${agyFormat}; implementacao AGY 4.0 usa stream-json.`);
    }

    if (frontend && !hasAgyModelSource(block.text)) {
      errors.push(`${source}: ${id} aponta para AGY, mas nao registra agyModelSource=user|heuristic|adaptive. Exemplo: "- agyModel: \`flash-high\`" + "- agyModelSource: \`heuristic\`".`);
    }

    if (frontend && AGY_ADAPTIVE_SOURCE_RE.test(block.text) && !AGY_ADAPTIVE_EVIDENCE_RE.test(block.text)) {
      errors.push(`${source}: ${id} usa routing adaptativo, mas nao registra agyModelEvidence auditavel.`);
    }

    // Heuristica legada por mencao de agente: vale para bloco que nao declara
    // `executor`, e so exige a mencao que a Project_Config de fato espera.
    if (!declaresExecutor) {
      if (taskCategory === "FRONTEND_ONLY" && expectation.executor === "agy") {
        if (!frontendMention) {
          errors.push(`${source}: ${id} e FRONTEND_ONLY, mas nao aponta para Antigravity/AGY.`);
        }
        if (codexMention) {
          errors.push(`${source}: ${id} e FRONTEND_ONLY, mas aponta para Codex como agente primario.`);
        }
      }

      if (taskCategory === "FULLSTACK") {
        const missingMentions = [];
        if (expectation.backend === "codex" && !codexMention) missingMentions.push("Codex");
        if (expectation.frontend === "agy" && !frontendMention) missingMentions.push("Antigravity/AGY");
        if (missingMentions.length > 0) {
          errors.push(`${source}: ${id} e FULLSTACK, mas nao declara ${missingMentions.join(" + ")}.`);
        }
      }

      if (["BACKEND_ONLY", "DATABASE_ONLY"].includes(taskCategory) && expectation.executor === "codex" && !codexMention) {
        errors.push(`${source}: ${id} e ${taskCategory}, mas nao aponta para Codex.`);
      }
    }

    if (taskCategory === "FULLSTACK" && frontend && !agyModel) {
      errors.push(`${source}: ${id} e FULLSTACK, mas a fatia front-end nao registra agyModel.`);
    }

    if (["BACKEND_ONLY", "DATABASE_ONLY"].includes(taskCategory) && frontendMention && !effective.includes("agy")) {
      warnings.push(`${source}: ${id} e ${taskCategory}, mas tambem menciona AGY. Confirme se nao houve mistura de escopo.`);
    }

    if (taskCategory === "REVIEW_ONLY") {
      const reviewer = expectation.executor;
      if (reviewer === "codex" && (!codex || !CODEX_HIGH_RE.test(block.text))) {
        errors.push(`${source}: ${id} e REVIEW_ONLY, mas nao aponta para Codex com --effort high.`);
      }
      if (reviewer === "claude-code" && !READ_ONLY_REVIEW_RECORD_RE.test(block.text)) {
        errors.push(`${source}: ${id} e REVIEW_ONLY com revisor \`claude-code\`, mas nao registra o review read-only em review/review-final.md (back-end) ou review/review-frontend.md (front-end).`);
      }
    }
  }
}

const [classificationFile, wavesFile] = requiredFiles;
const classification = readRequired(classificationFile);
const waves = readRequired(wavesFile);
const classificationBlocks = extractBlocks(classification);
const waveBlocks = extractBlocks(waves);
const categoryByTask = new Map();

for (const block of classificationBlocks) {
  const category = findCategory(block.text);
  if (!category) continue;
  for (const id of block.ids) categoryByTask.set(id, category);
}

if (classificationBlocks.length === 0) {
  errors.push(`${classificationFile}: nenhum bloco de task encontrado (IDs aceitos: T1, T12-A, BE-01, FE-001-B).`);
}

if (waveBlocks.length === 0) {
  errors.push(`${wavesFile}: nenhum bloco de task encontrado (IDs aceitos: T1, T12-A, BE-01, FE-001-B).`);
}

for (const block of classificationBlocks) {
  validateBlock(basename(classificationFile), block, categoryByTask);
}

for (const block of waveBlocks) {
  validateBlock(basename(wavesFile), block, categoryByTask);
}

if (errors.length > 0) {
  console.error("Routing validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  if (warnings.length > 0) {
    console.error("\nWarnings:");
    for (const warning of warnings) console.error(`- ${warning}`);
  }
  process.exit(1);
}

if (warnings.length > 0) {
  console.warn("Routing validation warnings:");
  for (const warning of warnings) console.warn(`- ${warning}`);
}

console.log(`Routing validation passed for ${categoryByTask.size} task(s) in ${targetDir}.`);
console.log(
  `Project_Config (${projectConfigSource === "file" ? projectConfigFile : "default"}): `
    + `backendExecutor=${projectConfig.backendExecutor}, frontendExecutor=${projectConfig.frontendExecutor}, `
    + `backendReviewer=${projectConfig.backendReviewer}, frontendReviewer=${projectConfig.frontendReviewer}.`,
);
