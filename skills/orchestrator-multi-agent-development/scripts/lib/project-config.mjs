import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { renameWithRetry } from "./fs-retry.mjs";

/**
 * Fonte da verdade da Project_Config: papeis, executores permitidos, formato do
 * Project_Config_File e derivacoes.
 *
 * Modulo puro. Nenhuma I/O de rede, nenhum relogio implicito no caminho
 * canonico: `renderProjectConfig` recebe `now` injetavel, o que torna o
 * round-trip e a idempotencia testaveis.
 *
 * Gramatica canonica do arquivo `.orchestrator/project-config.md`:
 *
 *   # ORCHESTRATOR PROJECT CONFIG
 *
 *   > <linha de contexto>
 *
 *   - **schemaVersion**: 1
 *   - **updatedAt**: 2026-02-14T18:05:31Z
 *   - **backendExecutor**: codex
 *   - **frontendExecutor**: agy
 *   - **backendReviewer**: codex
 *   - **frontendReviewer**: agy
 *
 *   ## Notas
 *
 *   - frontendReviewer: default-aplicado
 *
 * Os seis campos aparecem exatamente uma vez cada, na ordem acima, em linha de
 * lista com o nome do campo em negrito. A secao `## Notas` so existe quando
 * algum papel teve default aplicado. Nenhuma outra chave e gravada: nao existe
 * campo para chave de API, token ou cabecalho de autenticacao.
 *
 * A leitura e tolerante (espacamento variavel, ordem arbitraria das linhas de
 * campo, BOM UTF-8, CRLF, valor entre backticks ou aspas) e estrita no
 * conteudo: campo ausente, valor fora do conjunto permitido, arquivo sem
 * nenhuma linha de campo reconhecivel e `schemaVersion` acima do suportado
 * viram `ProjectConfigError` com codigo dedicado.
 *
 * Alem do schema, do renderer e do parser, o modulo expoe:
 *
 * - `readProjectConfig(projectRoot)`: le o arquivo quando existe (propagando
 *   `ProjectConfigError` se ele for invalido) e devolve a configuracao padrao
 *   com `source: "default"` quando ele esta ausente. Nunca inventa
 *   configuracao a partir de arquivo defeituoso.
 * - `writeProjectConfig(projectRoot, config, { now })`: cria `.orchestrator/`
 *   e grava por arquivo temporario mais rename, de modo que uma falha de I/O
 *   vira `PROJECT_CONFIG_WRITE_FAILED` sem destruir o arquivo anterior.
 * - `applyProjectConfigDefaults(answers)`: aplica o valor padrao de cada papel
 *   sem resposta e registra esses papeis em `defaultsApplied`, que o renderer
 *   grava como `default-aplicado` na secao `## Notas` e o parser rele.
 * - `PROJECT_CONFIG_QUESTIONS`: catalogo das quatro perguntas de
 *   `AskUserQuestion` — opcoes permitidas por papel, opcao padrao, descricao do
 *   papel e, por opcao, a CLI que aquela escolha exige.
 * - `deriveRequiredCliSet(config)`: unica regra que decide se `codex` e `agy`
 *   sao CLIs obrigatorias, derivada de `EXECUTOR_REQUIRED_CLI` — a mesma tabela
 *   que o catalogo de perguntas usa.
 * - `resolveExecutorForCategory(category, config)`: Executor por categoria de
 *   task, com o par `{ backend, frontend }` para `FULLSTACK`.
 * - `diffProjectConfig(left, right)`: papeis divergentes entre duas
 *   configuracoes, vazio quando nenhum papel mudou.
 */

export const PROJECT_CONFIG_SCHEMA_VERSION = 1;

export const EXECUTORS = Object.freeze(["codex", "agy", "claude-code"]);

export const ROLES = Object.freeze([
  "backendExecutor",
  "frontendExecutor",
  "backendReviewer",
  "frontendReviewer",
]);

export const DEFAULT_PROJECT_CONFIG = Object.freeze({
  backendExecutor: "codex",
  frontendExecutor: "agy",
  backendReviewer: "codex",
  frontendReviewer: "agy",
});

/**
 * Campo opt-in (nao um papel de executor): controla se cota esgotada num
 * Executor avanca automaticamente pela cadeia de fallback
 * `claude-code -> codex -> agy` (ver `scripts/lib/quota-fallback.mjs` e
 * `Politica de quota` no SKILL.md). Diferente dos quatro papeis, e
 * **retrocompativel**: um Project_Config_File gravado antes desta feature nao
 * tem a linha e o parser resolve `disabled` sem lancar `PROJECT_CONFIG_FIELD_MISSING`.
 */
export const QUOTA_FALLBACK_FIELD = "quotaFallbackChain";
export const QUOTA_FALLBACK_VALUES = Object.freeze(["disabled", "enabled"]);
export const DEFAULT_QUOTA_FALLBACK_CHAIN = "disabled";

/** Papeis e campos rastreados por `defaultsApplied`/`default-aplicado`. */
export const DEFAULT_APPLIED_TRACKED_FIELDS = Object.freeze([...ROLES, QUOTA_FALLBACK_FIELD]);

/** Ordem canonica das linhas de campo do Project_Config_File. */
export const PROJECT_CONFIG_FIELDS = Object.freeze([
  "schemaVersion",
  "updatedAt",
  ...ROLES,
  QUOTA_FALLBACK_FIELD,
]);

export const PROJECT_CONFIG_DIRECTORY = ".orchestrator";
export const PROJECT_CONFIG_FILENAME = "project-config.md";
export const PROJECT_CONFIG_RELATIVE_PATH = `${PROJECT_CONFIG_DIRECTORY}/${PROJECT_CONFIG_FILENAME}`;
export const PROJECT_CONFIG_DEFAULT_APPLIED_MARK = "default-aplicado";

const PROJECT_CONFIG_TITLE = "# ORCHESTRATOR PROJECT CONFIG";
const PROJECT_CONFIG_LEAD =
  "> Configuracao de stack de agentes deste projeto. Gerada e lida por /orchestrator project-config.";
const PROJECT_CONFIG_NOTES_HEADING = "## Notas";

const UPDATED_AT_FORMAT = "YYYY-MM-DDTHH:MM:SSZ";
const UPDATED_AT_CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const UPDATED_AT_ACCEPTED = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

// Linha de campo: exige o nome em negrito, o que a separa sem ambiguidade das
// linhas da secao `## Notas` (`- frontendReviewer: default-aplicado`).
const FIELD_LINE = /^[\t ]*[-*+][\t ]*\*\*[\t ]*([A-Za-z][A-Za-z0-9_-]*)[\t ]*\*\*[\t ]*:[\t ]*(.*)$/;
const NOTE_LINE = /^[\t ]*[-*+][\t ]*([A-Za-z][A-Za-z0-9_-]*)[\t ]*:[\t ]*(.*)$/;

const FIELD_BY_LOWERCASE = new Map(PROJECT_CONFIG_FIELDS.map((field) => [field.toLowerCase(), field]));
const ROLE_BY_LOWERCASE = new Map(ROLES.map((role) => [role.toLowerCase(), role]));
const TRACKED_FIELD_BY_LOWERCASE = new Map(
  DEFAULT_APPLIED_TRACKED_FIELDS.map((field) => [field.toLowerCase(), field]),
);

export class ProjectConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ProjectConfigError";
    this.code = code;
    this.details = details;
  }
}

/** Caminho canonico do Project_Config_File a partir da raiz do projeto. */
export function projectConfigPath(projectRoot = process.cwd()) {
  return join(resolve(projectRoot ?? "."), PROJECT_CONFIG_DIRECTORY, PROJECT_CONFIG_FILENAME);
}

function fieldMissing(field, path) {
  return new ProjectConfigError(
    "PROJECT_CONFIG_FIELD_MISSING",
    `Project config field "${field}" is missing in ${path}`,
    { field, path },
  );
}

function invalidValue(field, received, path, accepted) {
  const acceptedList = Array.isArray(accepted) ? accepted : [accepted];
  return new ProjectConfigError(
    "PROJECT_CONFIG_INVALID_VALUE",
    `Project config field "${field}" in ${path} has invalid value ${JSON.stringify(String(received))}; `
      + `accepted: ${acceptedList.join(", ")}`,
    { field, path, received, accepted: acceptedList },
  );
}

function unparseable(path, reason) {
  return new ProjectConfigError(
    "PROJECT_CONFIG_UNPARSEABLE",
    `Project config file ${path} is unparseable: ${reason}`,
    { path, reason },
  );
}

function schemaUnsupported(received, path) {
  return new ProjectConfigError(
    "PROJECT_CONFIG_SCHEMA_UNSUPPORTED",
    `Project config file ${path} declares schemaVersion ${received}, but this plugin supports `
      + `up to ${PROJECT_CONFIG_SCHEMA_VERSION}`,
    { field: "schemaVersion", path, received, accepted: [PROJECT_CONFIG_SCHEMA_VERSION] },
  );
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function cleanValue(raw) {
  return String(raw ?? "")
    .trim()
    .replace(/^[`"']+/, "")
    .replace(/[`"']+$/, "")
    .trim();
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!UPDATED_AT_ACCEPTED.test(text)) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Serializa um instante como UTC ISO 8601 com precisao de segundos. */
function formatInstant(value, field, path) {
  const date = toDate(value);
  if (!date) throw invalidValue(field, value, path, [UPDATED_AT_FORMAT]);
  const formatted = `${date.toISOString().slice(0, 19)}Z`;
  if (!UPDATED_AT_CANONICAL.test(formatted)) throw invalidValue(field, value, path, [UPDATED_AT_FORMAT]);
  return formatted;
}

function normalizeSchemaVersion(value, path) {
  if (value === undefined || value === null || value === "") return PROJECT_CONFIG_SCHEMA_VERSION;
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw invalidValue("schemaVersion", value, path, [String(PROJECT_CONFIG_SCHEMA_VERSION)]);
  }
  if (parsed > PROJECT_CONFIG_SCHEMA_VERSION) throw schemaUnsupported(parsed, path);
  return parsed;
}

function normalizeRoleValue(role, value, path) {
  if (value === undefined || value === null || String(value).trim() === "") throw fieldMissing(role, path);
  const normalized = String(value).trim().toLowerCase();
  if (!EXECUTORS.includes(normalized)) throw invalidValue(role, String(value).trim(), path, EXECUTORS);
  return normalized;
}

/**
 * Normaliza `quotaFallbackChain`. Diferente dos quatro papeis, ausencia
 * (`undefined`/`null`/vazio) nao e erro: resolve para `DEFAULT_QUOTA_FALLBACK_CHAIN`,
 * o que mantem retrocompatibilidade com Project_Config_File gravados antes desta
 * feature. Presente, o valor precisa pertencer a `QUOTA_FALLBACK_VALUES`.
 */
function normalizeQuotaFallbackChainValue(value, path) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return DEFAULT_QUOTA_FALLBACK_CHAIN;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!QUOTA_FALLBACK_VALUES.includes(normalized)) {
    throw invalidValue(QUOTA_FALLBACK_FIELD, String(value).trim(), path, QUOTA_FALLBACK_VALUES);
  }
  return normalized;
}

function normalizeDefaultsApplied(value, path) {
  if (value === undefined || value === null || value === "") return [];
  const entries = Array.isArray(value) ? value : String(value).split(",");
  const selected = new Set();
  for (const entry of entries) {
    const normalized = String(entry ?? "").trim().toLowerCase();
    if (normalized === "") continue;
    const field = TRACKED_FIELD_BY_LOWERCASE.get(normalized);
    if (!field) throw invalidValue("defaultsApplied", String(entry).trim(), path, DEFAULT_APPLIED_TRACKED_FIELDS);
    selected.add(field);
  }
  return DEFAULT_APPLIED_TRACKED_FIELDS.filter((field) => selected.has(field));
}

/**
 * Normaliza uma Project_Config em memoria: seis campos canonicos mais
 * `defaultsApplied`. `now` tem precedencia sobre `config.updatedAt`; quando
 * nenhum dos dois existe, usa o instante atual.
 */
function normalizeProjectConfig(config, { now, path } = {}) {
  const target = path ?? PROJECT_CONFIG_RELATIVE_PATH;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw invalidValue("config", config === null ? "null" : typeof config, target, ["object"]);
  }
  const instant = now ?? config.updatedAt ?? new Date();
  const normalized = {
    schemaVersion: normalizeSchemaVersion(config.schemaVersion, target),
    updatedAt: formatInstant(instant, "updatedAt", target),
  };
  for (const role of ROLES) normalized[role] = normalizeRoleValue(role, config[role], target);
  normalized[QUOTA_FALLBACK_FIELD] = normalizeQuotaFallbackChainValue(config[QUOTA_FALLBACK_FIELD], target);
  normalized.defaultsApplied = normalizeDefaultsApplied(config.defaultsApplied, target);
  return normalized;
}

/**
 * Serializa uma Project_Config no formato canonico do Project_Config_File.
 *
 * Deterministico dado `config` + `options.now`: a mesma entrada produz byte a
 * byte o mesmo conteudo, com os campos sempre na ordem canonica e os valores de
 * executor e reviewer sempre em minusculas.
 */
export function renderProjectConfig(config, options = {}) {
  const normalized = normalizeProjectConfig(config, { now: options.now, path: options.path });
  const lines = [
    PROJECT_CONFIG_TITLE,
    "",
    PROJECT_CONFIG_LEAD,
    "",
    `- **schemaVersion**: ${normalized.schemaVersion}`,
    `- **updatedAt**: ${normalized.updatedAt}`,
    ...ROLES.map((role) => `- **${role}**: ${normalized[role]}`),
    `- **${QUOTA_FALLBACK_FIELD}**: ${normalized[QUOTA_FALLBACK_FIELD]}`,
  ];
  if (normalized.defaultsApplied.length > 0) {
    lines.push(
      "",
      PROJECT_CONFIG_NOTES_HEADING,
      "",
      ...normalized.defaultsApplied.map((role) => `- ${role}: ${PROJECT_CONFIG_DEFAULT_APPLIED_MARK}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Le o conteudo de um Project_Config_File e devolve a Project_Config.
 *
 * Tolera espacamento variavel, ordem arbitraria das linhas de campo, BOM UTF-8,
 * CRLF, valores entre backticks ou aspas e chaves desconhecidas em negrito
 * (ignoradas). Lanca `ProjectConfigError` para arquivo sem linha de campo
 * reconhecivel, campo obrigatorio ausente, valor fora do conjunto permitido e
 * `schemaVersion` acima do suportado.
 */
export function parseProjectConfig(content, options = {}) {
  const path = options.path ?? PROJECT_CONFIG_RELATIVE_PATH;
  const text = stripBom(String(content ?? "")).replace(/\r\n?/g, "\n");

  const fields = new Map();
  const notes = new Set();

  for (const rawLine of text.split("\n")) {
    const fieldMatch = rawLine.match(FIELD_LINE);
    if (fieldMatch) {
      const field = FIELD_BY_LOWERCASE.get(fieldMatch[1].toLowerCase());
      if (!field) continue;
      const value = cleanValue(fieldMatch[2]);
      const previous = fields.get(field);
      if (previous !== undefined && previous.toLowerCase() !== value.toLowerCase()) {
        throw invalidValue(
          field,
          `${previous} | ${value}`,
          path,
          field === "schemaVersion" || field === "updatedAt"
            ? ["single occurrence"]
            : field === QUOTA_FALLBACK_FIELD
              ? QUOTA_FALLBACK_VALUES
              : EXECUTORS,
        );
      }
      fields.set(field, value);
      continue;
    }
    // Linha de nota nao usa negrito e exige o valor exato da marca, entao nao
    // colide com linha de campo nem com valor de executor.
    const noteMatch = rawLine.match(NOTE_LINE);
    if (noteMatch && cleanValue(noteMatch[2]).toLowerCase() === PROJECT_CONFIG_DEFAULT_APPLIED_MARK) {
      const field = TRACKED_FIELD_BY_LOWERCASE.get(noteMatch[1].toLowerCase());
      if (field) notes.add(field);
    }
  }

  if (fields.size === 0) {
    throw unparseable(path, 'no recognizable "- **field**: value" line was found');
  }

  const rawSchemaVersion = fields.get("schemaVersion");
  if (rawSchemaVersion === undefined || rawSchemaVersion === "") throw fieldMissing("schemaVersion", path);
  const schemaVersion = normalizeSchemaVersion(rawSchemaVersion, path);

  const rawUpdatedAt = fields.get("updatedAt");
  if (rawUpdatedAt === undefined || rawUpdatedAt === "") throw fieldMissing("updatedAt", path);

  const parsed = {
    schemaVersion,
    updatedAt: formatInstant(rawUpdatedAt, "updatedAt", path),
  };
  for (const role of ROLES) parsed[role] = normalizeRoleValue(role, fields.get(role), path);
  // `quotaFallbackChain` e retrocompativel: linha ausente resolve para o
  // default sem lancar `PROJECT_CONFIG_FIELD_MISSING`.
  parsed[QUOTA_FALLBACK_FIELD] = normalizeQuotaFallbackChainValue(fields.get(QUOTA_FALLBACK_FIELD), path);
  parsed.defaultsApplied = DEFAULT_APPLIED_TRACKED_FIELDS.filter((field) => notes.has(field));
  return parsed;
}

function readFailed(path, error) {
  return new ProjectConfigError(
    "PROJECT_CONFIG_READ_FAILED",
    `Project config file ${path} could not be read: ${error?.message ?? String(error)}`,
    { path, reason: error?.message ?? String(error), cause: error?.code ?? null },
  );
}

function writeFailed(path, error) {
  return new ProjectConfigError(
    "PROJECT_CONFIG_WRITE_FAILED",
    `Project config file ${path} could not be written: ${error?.message ?? String(error)}`,
    { path, reason: error?.message ?? String(error), cause: error?.code ?? null },
  );
}

/**
 * Project_Config padrao em memoria: papeis de `DEFAULT_PROJECT_CONFIG`,
 * `updatedAt` nulo (nada foi gravado ainda) e `defaultsApplied` vazio.
 *
 * `updatedAt: null` e deliberado: a configuracao padrao nao tem instante de
 * gravacao, e o renderer resolve o instante no momento em que o arquivo e
 * criado.
 */
export function defaultProjectConfig() {
  return {
    schemaVersion: PROJECT_CONFIG_SCHEMA_VERSION,
    updatedAt: null,
    ...DEFAULT_PROJECT_CONFIG,
    [QUOTA_FALLBACK_FIELD]: DEFAULT_QUOTA_FALLBACK_CHAIN,
    defaultsApplied: [],
  };
}

/**
 * Le o Project_Config_File da raiz do projeto.
 *
 * - Arquivo ausente: `{ exists: false, source: "default", path, config }` com a
 *   configuracao padrao.
 * - Arquivo presente e valido: `{ exists: true, source: "file", path, config }`.
 * - Arquivo presente e invalido: propaga o `ProjectConfigError` do parser, o que
 *   permite ao Preflight bloquear e ao Config_Command oferecer regravacao. A
 *   leitura nunca altera o arquivo.
 */
export function readProjectConfig(projectRoot = process.cwd()) {
  const path = projectConfigPath(projectRoot);
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, source: "default", path, config: defaultProjectConfig() };
    }
    throw readFailed(path, error);
  }
  return { exists: true, source: "file", path, config: parseProjectConfig(content, { path }) };
}

/**
 * Grava o Project_Config_File em `<projectRoot>/.orchestrator/project-config.md`.
 *
 * Cria `.orchestrator/` quando necessario e grava por arquivo temporario no
 * mesmo diretorio mais `rename`, entao uma falha de I/O nunca deixa o arquivo
 * anterior truncado ou meio gravado: o erro vira `PROJECT_CONFIG_WRITE_FAILED`
 * e o conteudo previo permanece byte a byte intacto.
 *
 * Validacao vem antes de qualquer I/O: valor de papel fora do conjunto
 * permitido falha com `PROJECT_CONFIG_INVALID_VALUE` sem tocar o filesystem.
 *
 * `options.now` tem precedencia sobre `config.updatedAt`; sem nenhum dos dois, o
 * renderer usa o instante atual. Quem grava para "atualizar" o arquivo (o
 * Config_Command) passa `now` explicitamente.
 *
 * @returns {{ path: string, content: string, config: object }}
 */
export function writeProjectConfig(projectRoot, config, options = {}) {
  const path = projectConfigPath(projectRoot);
  const content = renderProjectConfig(config, { now: options.now, path });
  // Reparse do conteudo canonico: garante que a Project_Config devolvida e
  // exatamente a que sera relida do arquivo (Req 3.5).
  const persisted = parseProjectConfig(content, { path });

  const directory = dirname(path);
  let temporary = null;
  try {
    mkdirSync(directory, { recursive: true });
    temporary = join(directory, `.${PROJECT_CONFIG_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, content, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameWithRetry(temporary, path);
    temporary = null;
  } catch (error) {
    if (temporary !== null) {
      try {
        unlinkSync(temporary);
      } catch {
        // Temporario orfao nao invalida o arquivo anterior; o erro relevante e o
        // da gravacao.
      }
    }
    throw writeFailed(path, error);
  }

  return { path, content, config: persisted };
}

/**
 * Resolve as respostas da coleta em uma Project_Config completa.
 *
 * Papel sem resposta — chave ausente, `null`, `undefined` ou string vazia —
 * recebe o valor padrao de `DEFAULT_PROJECT_CONFIG` e entra em
 * `defaultsApplied`, que o renderer grava como `default-aplicado` e o parser
 * rele (Req 2.8). Papel respondido e validado contra `EXECUTORS`.
 *
 * `answers.defaultsApplied` declarado explicitamente e unido ao conjunto
 * derivado, para o caso de o chamador ja saber que uma resposta veio de default.
 */
export function applyProjectConfigDefaults(answers = {}, options = {}) {
  const path = options.path ?? PROJECT_CONFIG_RELATIVE_PATH;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    throw invalidValue("answers", answers === null ? "null" : typeof answers, path, ["object"]);
  }

  const resolved = {};
  const applied = new Set(normalizeDefaultsApplied(answers.defaultsApplied, path));
  for (const role of ROLES) {
    const answer = answers[role];
    if (answer === undefined || answer === null || String(answer).trim() === "") {
      resolved[role] = DEFAULT_PROJECT_CONFIG[role];
      applied.add(role);
      continue;
    }
    resolved[role] = normalizeRoleValue(role, answer, path);
  }

  const quotaAnswer = answers[QUOTA_FALLBACK_FIELD];
  if (quotaAnswer === undefined || quotaAnswer === null || String(quotaAnswer).trim() === "") {
    resolved[QUOTA_FALLBACK_FIELD] = DEFAULT_QUOTA_FALLBACK_CHAIN;
    applied.add(QUOTA_FALLBACK_FIELD);
  } else {
    resolved[QUOTA_FALLBACK_FIELD] = normalizeQuotaFallbackChainValue(quotaAnswer, path);
  }

  const instant = options.now ?? answers.updatedAt ?? null;
  return {
    schemaVersion: normalizeSchemaVersion(answers.schemaVersion, path),
    updatedAt: instant === null ? null : formatInstant(instant, "updatedAt", path),
    ...resolved,
    defaultsApplied: DEFAULT_APPLIED_TRACKED_FIELDS.filter((field) => applied.has(field)),
  };
}

/** CLI exigida por cada executor. `claude-code` nao exige CLI externa. */
export const EXECUTOR_REQUIRED_CLI = Object.freeze({
  codex: "codex",
  agy: "agy",
  "claude-code": null,
});

/** Rotulo de agente usado nas descricoes das opcoes. */
const EXECUTOR_LABELS = Object.freeze({
  codex: "Codex",
  agy: "Antigravity (AGY)",
  "claude-code": "Claude Code",
});

/** Ordem em que as quatro perguntas sao apresentadas na coleta. */
export const PROJECT_CONFIG_QUESTION_ORDER = Object.freeze([
  "backendExecutor",
  "frontendExecutor",
  "frontendReviewer",
  "backendReviewer",
]);

const QUESTION_SPECS = Object.freeze([
  {
    role: "backendExecutor",
    title: "Qual agente implementa as tasks de back-end?",
    roleDescription:
      "Executor das tasks BACKEND_ONLY e DATABASE_ONLY e da fatia back-end das tasks FULLSTACK.",
    duty: "implementa as tasks de back-end e de banco de dados",
    options: ["codex", "claude-code"],
  },
  {
    role: "frontendExecutor",
    title: "Qual agente implementa as tasks de front-end?",
    roleDescription: "Executor das tasks FRONTEND_ONLY e da fatia front-end das tasks FULLSTACK.",
    duty: "implementa as tasks de front-end",
    options: ["agy", "claude-code"],
  },
  {
    role: "frontendReviewer",
    title: "Qual agente faz o review de front-end?",
    roleDescription: "Revisor do resultado front-end, registrado em review/review-frontend.md.",
    duty: "revisa o resultado front-end",
    options: ["agy", "codex", "claude-code"],
    notes: {
      codex:
        "Sobrepoe a politica padrao de review front-end pelo AGY; a sobreposicao e informada ao "
        + "usuario e registrada em report/workflow-log.md.",
    },
  },
  {
    role: "backendReviewer",
    title: "Qual agente faz o review de back-end?",
    roleDescription: "Revisor do resultado back-end, registrado em review/review-final.md.",
    duty: "revisa o resultado back-end",
    options: ["codex", "agy", "claude-code"],
  },
]);

function buildQuestionOption(spec, value) {
  const requiresCli = EXECUTOR_REQUIRED_CLI[value] ?? null;
  const cliSentence = requiresCli
    ? `Exige a CLI \`${requiresCli}\` instalada e autenticada.`
    : "Nao exige CLI externa: a execucao vai para um subagente do proprio Claude Code.";
  const note = spec.notes?.[value];
  const description = [`${EXECUTOR_LABELS[value]} ${spec.duty}.`, cliSentence, note]
    .filter(Boolean)
    .join(" ");
  return Object.freeze({
    value,
    label: EXECUTOR_LABELS[value],
    isDefault: DEFAULT_PROJECT_CONFIG[spec.role] === value,
    requiresCli,
    description,
    note: note ?? null,
  });
}

/**
 * Catalogo das quatro perguntas da coleta da Project_Config (Req 2.2 a 2.6).
 *
 * Objeto indexado por papel, com as chaves na ordem de apresentacao. Cada
 * entrada traz:
 *
 * - `role`, `order`, `title` e `roleDescription`: o papel e o que ele decide.
 * - `defaultOption`: o valor padrao daquele papel.
 * - `options`: as opcoes permitidas, cada uma com `value`, `isDefault`,
 *   `requiresCli` (a CLI que aquela escolha torna obrigatoria, `null` para
 *   `claude-code`) e `description` — que anuncia o papel do agente e a CLI
 *   exigida, como pede o Req 2.6.
 *
 * `requiresCli` e a mesma informacao que a derivacao de CLIs obrigatorias usa:
 * escolher `codex` num papel exige a CLI `codex`, escolher `agy` exige `agy`, e
 * escolher `claude-code` nao exige CLI externa.
 */
export const PROJECT_CONFIG_QUESTIONS = Object.freeze(
  Object.fromEntries(
    PROJECT_CONFIG_QUESTION_ORDER.map((role, index) => {
      const spec = QUESTION_SPECS.find((candidate) => candidate.role === role);
      return [
        role,
        Object.freeze({
          role,
          order: index + 1,
          title: spec.title,
          roleDescription: spec.roleDescription,
          defaultOption: DEFAULT_PROJECT_CONFIG[role],
          options: Object.freeze(spec.options.map((value) => buildQuestionOption(spec, value))),
        }),
      ];
    }),
  ),
);

/**
 * 5a pergunta da coleta: nao decide um Executor, e o toggle opt-in do fallback
 * de cota `claude-code -> codex -> agy` (Politica de quota, SKILL.md).
 * Apresentada por ultimo, depois das quatro perguntas de papel.
 */
export const QUOTA_FALLBACK_QUESTION = Object.freeze({
  role: QUOTA_FALLBACK_FIELD,
  order: PROJECT_CONFIG_QUESTION_ORDER.length + 1,
  title:
    "Em caso de cota esgotada em um Executor, avancar automaticamente pela cadeia "
    + "claude-code -> codex -> agy?",
  roleDescription:
    "Controla se, ao detectar QUOTA_EXHAUSTED/QUOTA_EXAUSTED no Executor original de uma task, o "
    + "Orquestrador tenta automaticamente o proximo elo disponivel da cadeia fixa "
    + "claude-code -> codex -> agy, registrando um contrato de repasse monitorado.",
  defaultOption: DEFAULT_QUOTA_FALLBACK_CHAIN,
  options: Object.freeze([
    Object.freeze({
      value: "disabled",
      label: "Desabilitado (comportamento atual)",
      isDefault: true,
      requiresCli: null,
      description:
        "Comportamento atual: cota esgotada em Codex/AGY vira bloqueio ou pede decisao do usuario; "
        + "Claude nunca e usado como fallback (preserva a cota da sessao principal).",
      note: null,
    }),
    Object.freeze({
      value: "enabled",
      label: "Habilitado",
      isDefault: false,
      requiresCli: null,
      description:
        "Ao detectar QUOTA_EXHAUSTED/QUOTA_EXAUSTED no Executor original de uma task, tenta "
        + "automaticamente o proximo elo disponivel da cadeia fixa claude-code -> codex -> agy "
        + "(pulando o elo que falhou e qualquer elo tambem com cota esgotada), registrando cada "
        + "troca num contrato de repasse monitorado pelo Orquestrador.",
      note: null,
    }),
  ]),
});

/** Lista das quatro perguntas de papel na ordem de apresentacao. */
export function projectConfigQuestions() {
  return PROJECT_CONFIG_QUESTION_ORDER.map((role) => PROJECT_CONFIG_QUESTIONS[role]);
}

/**
 * Lista das cinco perguntas da coleta (as quatro de papel mais
 * `quotaFallbackChain`), na ordem de apresentacao da Fase 0.5.
 */
export function projectConfigAllQuestions() {
  return [...projectConfigQuestions(), QUOTA_FALLBACK_QUESTION];
}
/**
 * CLIs externas conhecidas, na ordem canonica em que aparecem em `clis` e nos
 * relatorios. Derivada de `EXECUTOR_REQUIRED_CLI`, entao a lista nunca divergir
 * do catalogo de perguntas: adicionar um executor novo com CLI nova basta em um
 * lugar.
 */
export const REQUIRED_CLI_ORDER = Object.freeze(
  EXECUTORS.map((executor) => EXECUTOR_REQUIRED_CLI[executor]).filter((cli) => cli !== null),
);

/** Categorias de task reconhecidas pelo roteamento (mesma lista do validador). */
export const TASK_CATEGORIES = Object.freeze([
  "BACKEND_ONLY",
  "FRONTEND_ONLY",
  "FULLSTACK",
  "DATABASE_ONLY",
  "REVIEW_ONLY",
  "DOCS_ONLY",
]);

/**
 * Papel da Project_Config que decide o Executor de cada categoria.
 *
 * `FULLSTACK` e o unico caso com dois papeis (uma fatia back-end e uma fatia
 * front-end), por isso mapeia para `null` aqui e e tratado a parte.
 *
 * `REVIEW_ONLY` usa `backendReviewer`: e a categoria do review final de
 * back-end, gravado em `review/review-final.md`. `DOCS_ONLY` acompanha o
 * `backendExecutor`, que e quem hoje recebe documentacao e task sem fatia de
 * interface.
 */
export const CATEGORY_ROLE = Object.freeze({
  BACKEND_ONLY: "backendExecutor",
  DATABASE_ONLY: "backendExecutor",
  FRONTEND_ONLY: "frontendExecutor",
  REVIEW_ONLY: "backendReviewer",
  DOCS_ONLY: "backendExecutor",
  FULLSTACK: null,
});

/** Origem da decisao de roteamento gravada nos artefatos e na telemetria. */
export const EXECUTOR_SOURCE_PROJECT_CONFIG = "project-config";

const CATEGORY_BY_UPPERCASE = new Map(TASK_CATEGORIES.map((category) => [category, category]));

function unknownCategory(received) {
  return new ProjectConfigError(
    "PROJECT_CONFIG_UNKNOWN_CATEGORY",
    `Unknown task category ${JSON.stringify(String(received))}; accepted: ${TASK_CATEGORIES.join(", ")}`,
    { field: "category", received, accepted: [...TASK_CATEGORIES] },
  );
}

/** Extrai os quatro papeis validados de uma Project_Config. */
function requireRoles(config, { path } = {}) {
  const target = path ?? PROJECT_CONFIG_RELATIVE_PATH;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw invalidValue("config", config === null ? "null" : typeof config, target, ["object"]);
  }
  const roles = {};
  for (const role of ROLES) roles[role] = normalizeRoleValue(role, config[role], target);
  return roles;
}

/**
 * Deriva o Required_CLI_Set a partir dos quatro papeis da Project_Config.
 *
 * Esta e a **unica** regra que decide se `codex` e `agy` sao obrigatorios: o
 * Preflight, o Config_Command, o Dependency_Installer e o validador de
 * roteamento consomem este resultado em vez de reimplementar a condicao
 * (Req 5.1 a 5.5). Uma CLI e obrigatoria se e somente se ao menos um dos quatro
 * papeis usa o executor que a exige, conforme `EXECUTOR_REQUIRED_CLI` — a mesma
 * tabela que o catalogo de perguntas usa para anunciar a CLI de cada opcao.
 *
 * `claude-code` nao exige CLI externa, entao a configuracao com os quatro
 * papeis em `claude-code` produz `clis: []` (Req 5.7).
 *
 * @param {object} config Project_Config com os quatro papeis preenchidos.
 * @returns {{
 *   clis: string[],
 *   codex: boolean,
 *   agy: boolean,
 *   roles: Record<string, string>,
 *   rolesByCli: Record<string, string[]>,
 * }} `clis` em ordem canonica (`codex` antes de `agy`), `codex`/`agy` como
 *   atalhos booleanos, `roles` com os papeis efetivos e `rolesByCli` com os
 *   papeis que exigem cada CLI — insumo do `affectedRoles` do plano de
 *   dependencias.
 */
export function deriveRequiredCliSet(config, options = {}) {
  const roles = requireRoles(config, { path: options.path });

  const rolesByCli = {};
  for (const cli of REQUIRED_CLI_ORDER) rolesByCli[cli] = [];
  for (const role of ROLES) {
    const cli = EXECUTOR_REQUIRED_CLI[roles[role]] ?? null;
    if (cli !== null) rolesByCli[cli].push(role);
  }

  const clis = REQUIRED_CLI_ORDER.filter((cli) => rolesByCli[cli].length > 0);
  for (const cli of REQUIRED_CLI_ORDER) Object.freeze(rolesByCli[cli]);

  return Object.freeze({
    clis: Object.freeze(clis),
    codex: rolesByCli.codex.length > 0,
    agy: rolesByCli.agy.length > 0,
    roles: Object.freeze(roles),
    rolesByCli: Object.freeze(rolesByCli),
  });
}

/**
 * Deriva o Executor de uma categoria de task a partir da Project_Config
 * (Req 7.1 a 7.4).
 *
 * - `BACKEND_ONLY`, `DATABASE_ONLY` e `DOCS_ONLY` -> `backendExecutor`.
 * - `FRONTEND_ONLY` -> `frontendExecutor`.
 * - `REVIEW_ONLY` -> `backendReviewer`.
 * - `FULLSTACK` -> par `{ backend, frontend }`, com `backendExecutor` na fatia
 *   back-end e `frontendExecutor` na fatia front-end.
 *
 * A categoria e normalizada (trim e maiusculas); categoria fora da lista vira
 * `PROJECT_CONFIG_UNKNOWN_CATEGORY`. O executor devolvido pertence sempre ao
 * conjunto `codex`/`agy`/`claude-code`, porque vem de papel ja validado.
 *
 * @param {string} category Categoria da task.
 * @param {object} config Project_Config com os quatro papeis preenchidos.
 * @returns {{ category: string, role: string, executor: string, executorSource: string }
 *   | { category: string, backend: string, frontend: string, executorSource: string }}
 */
export function resolveExecutorForCategory(category, config, options = {}) {
  const normalized = CATEGORY_BY_UPPERCASE.get(String(category ?? "").trim().toUpperCase());
  if (!normalized) throw unknownCategory(category);
  const roles = requireRoles(config, { path: options.path });

  if (normalized === "FULLSTACK") {
    return Object.freeze({
      category: normalized,
      backend: roles.backendExecutor,
      frontend: roles.frontendExecutor,
      executorSource: EXECUTOR_SOURCE_PROJECT_CONFIG,
    });
  }

  const role = CATEGORY_ROLE[normalized];
  return Object.freeze({
    category: normalized,
    role,
    executor: roles[role],
    executorSource: EXECUTOR_SOURCE_PROJECT_CONFIG,
  });
}

/** Valor de papel para diff: `null` quando ausente, executor validado quando presente. */
function diffRoleValue(config, role, side, path) {
  if (config === undefined || config === null) return null;
  const value = config[role];
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (!EXECUTORS.includes(normalized)) {
    throw invalidValue(`${side}.${role}`, String(value).trim(), path, EXECUTORS);
  }
  return normalized;
}

/**
 * Compara duas Project_Config e devolve os papeis que mudaram (Req 6.7, 10.2,
 * 10.3).
 *
 * O resultado sai na ordem canonica de `ROLES` e contem apenas os papeis
 * divergentes: lista vazia significa que nenhum papel mudou, que e como o
 * Config_Command decide informar "nenhum papel mudou" e o `resume` decide se ha
 * drift a apresentar ao usuario. `updatedAt`, `schemaVersion` e
 * `defaultsApplied` nao entram na comparacao: eles nao alteram roteamento nem
 * Required_CLI_Set.
 *
 * `null` ou `undefined` de um lado representa ausencia de configuracao (Run
 * antiga sem snapshot, projeto sem arquivo): cada papel aparece com `from` ou
 * `to` igual a `null`.
 *
 * @param {object|null|undefined} left Configuracao anterior.
 * @param {object|null|undefined} right Configuracao nova.
 * @returns {Array<{ role: string, from: string|null, to: string|null }>}
 */
export function diffProjectConfig(left, right, options = {}) {
  const path = options.path ?? PROJECT_CONFIG_RELATIVE_PATH;
  for (const [side, value] of [["left", left], ["right", right]]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "object" || Array.isArray(value)) {
      throw invalidValue(side, typeof value, path, ["object"]);
    }
  }

  const differences = [];
  for (const role of ROLES) {
    const from = diffRoleValue(left, role, "left", path);
    const to = diffRoleValue(right, role, "right", path);
    if (from !== to) differences.push(Object.freeze({ role, from, to }));
  }
  return differences;
}

/** Valor de `quotaFallbackChain` para diff: `null` quando ausente. */
function diffQuotaFallbackValue(config, side, path) {
  if (config === undefined || config === null) return null;
  const value = config[QUOTA_FALLBACK_FIELD];
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const normalized = String(value).trim().toLowerCase();
  if (!QUOTA_FALLBACK_VALUES.includes(normalized)) {
    throw invalidValue(`${side}.${QUOTA_FALLBACK_FIELD}`, String(value).trim(), path, QUOTA_FALLBACK_VALUES);
  }
  return normalized;
}

/**
 * Compara `quotaFallbackChain` entre duas Project_Config, no mesmo formato de
 * `diffProjectConfig` mas para o campo opt-in do fallback de cota (fora de
 * `ROLES` porque nao decide um Executor). Congelado no mesmo snapshot dos
 * quatro papeis (Estabilidade durante a Run, `project-config.md`), passa pelo
 * mesmo fluxo de drift/`AskUserQuestion` de adocao.
 *
 * @returns {Array<{ role: "quotaFallbackChain", from: string|null, to: string|null }>}
 */
export function diffQuotaFallbackChain(left, right, options = {}) {
  const path = options.path ?? PROJECT_CONFIG_RELATIVE_PATH;
  const from = diffQuotaFallbackValue(left, "left", path);
  const to = diffQuotaFallbackValue(right, "right", path);
  return from === to ? [] : [Object.freeze({ role: QUOTA_FALLBACK_FIELD, from, to })];
}
