import fc from "fast-check";

import {
  DEFAULT_PROJECT_CONFIG,
  DEFAULT_QUOTA_FALLBACK_CHAIN,
  EXECUTORS,
  PROJECT_CONFIG_DEFAULT_APPLIED_MARK,
  PROJECT_CONFIG_FIELDS,
  PROJECT_CONFIG_SCHEMA_VERSION,
  QUOTA_FALLBACK_FIELD,
  QUOTA_FALLBACK_VALUES,
  ROLES,
  renderProjectConfig,
} from "../../skills/orchestrator-multi-agent-development/scripts/lib/project-config.mjs";

/**
 * Geradores compartilhados da feature orchestrator-mcp-agent-config.
 *
 * Este arquivo NAO e um teste: o runner roda `node --test tests/*.test.mjs`, e o
 * helper fica em `tests/helpers/` justamente para ficar fora desse glob. Os
 * testes de propriedade de configuracao, roteamento e estado da Run importam
 * daqui para nao reimplementar o mesmo espaco de entrada.
 */

/** Campos comparados no round-trip: os sete campos canonicos da Project_Config. */
export const PROJECT_CONFIG_ROUND_TRIP_FIELDS = Object.freeze([
  "schemaVersion",
  "updatedAt",
  ...ROLES,
  QUOTA_FALLBACK_FIELD,
]);

/** Um executor do conjunto permitido. */
export function arbExecutor() {
  return fc.constantFrom(...EXECUTORS);
}

/** Os quatro papeis, cada um sobre os tres executores permitidos. */
export function arbRoles() {
  return fc.record(Object.fromEntries(ROLES.map((role) => [role, arbExecutor()])));
}

/** Um valor permitido do campo opt-in `quotaFallbackChain` (`disabled`/`enabled`). */
export function arbQuotaFallbackChain() {
  return fc.constantFrom(...QUOTA_FALLBACK_VALUES);
}

/**
 * Instante UTC com precisao de segundos, no formato canonico do campo
 * `updatedAt` (`YYYY-MM-DDTHH:MM:SSZ`). A janela cobre datas realistas de
 * projeto sem depender do relogio da maquina.
 */
export function arbInstant() {
  return fc
    .date({
      min: new Date("1990-01-01T00:00:00Z"),
      max: new Date("2099-12-31T23:59:59Z"),
      noInvalidDate: true,
    })
    .map((date) => `${new Date(Math.floor(date.getTime() / 1000) * 1000).toISOString().slice(0, 19)}Z`);
}

/**
 * Avanco em segundos inteiros que garante mudanca do instante canonico: no
 * minimo um segundo, no maximo um ano.
 */
export function arbInstantAdvanceSeconds() {
  return fc.integer({ min: 1, max: 365 * 24 * 60 * 60 });
}

/** Subconjunto arbitrario dos quatro papeis, em ordem canonica. */
export function arbRoleSubset() {
  return fc
    .subarray([...ROLES])
    .map((subset) => ROLES.filter((role) => subset.includes(role)));
}

/**
 * Project_Config valida: os quatro papeis, `schemaVersion` suportado e
 * `updatedAt` canonico.
 *
 * `options.defaultsApplied` liga o campo `defaultsApplied` (usado pelas
 * propriedades de default aplicado); por omissao a configuracao gerada nao
 * carrega papeis com default aplicado.
 */
export function arbProjectConfig(options = {}) {
  const { defaultsApplied = false } = options;
  return arbRoles().chain((roles) =>
    fc.record({
      schemaVersion: fc.constant(PROJECT_CONFIG_SCHEMA_VERSION),
      updatedAt: arbInstant(),
      ...Object.fromEntries(ROLES.map((role) => [role, fc.constant(roles[role])])),
      [QUOTA_FALLBACK_FIELD]: arbQuotaFallbackChain(),
      ...(defaultsApplied ? { defaultsApplied: arbRoleSubset() } : {}),
    }),
  );
}

/** Projeta apenas os seis campos canonicos de uma Project_Config. */
export function pickRoundTripFields(config) {
  const picked = {};
  for (const field of PROJECT_CONFIG_ROUND_TRIP_FIELDS) picked[field] = config[field];
  return picked;
}

/* -------------------------------------------------------------------------- */
/* Ruido de Project_Config_File                                                */
/* -------------------------------------------------------------------------- */

const EOL_BY_KEY = Object.freeze({ lf: "\n", crlf: "\r\n", cr: "\r" });

const NOISY_TITLE = "# ORCHESTRATOR PROJECT CONFIG";
const NOISY_LEAD =
  "> Configuracao de stack de agentes deste projeto. Gerada e lida por /orchestrator project-config.";
const NOISY_NOTES_HEADING = "## Notas";

function applyCase(text, mode) {
  if (mode === "lower") return text.toLowerCase();
  if (mode === "upper") return text.toUpperCase();
  return text;
}

/** Espacamento e marcador de uma linha de lista, dentro do que o parser tolera. */
function arbLineNoise(extra = {}) {
  return fc.record({
    indent: fc.constantFrom("", " ", "  ", "\t"),
    marker: fc.constantFrom("-", "*", "+"),
    afterMarker: fc.constantFrom("", " ", "  ", "\t"),
    beforeColon: fc.constantFrom("", " ", "\t"),
    afterColon: fc.constantFrom("", " ", "  ", "\t"),
    trailing: fc.constantFrom("", " ", "   ", "\t"),
    blankBefore: fc.nat({ max: 2 }),
    ...extra,
  });
}

function arbFieldLineNoise() {
  return arbLineNoise({
    insideBoldLeft: fc.constantFrom("", " "),
    insideBoldRight: fc.constantFrom("", " "),
    nameCase: fc.constantFrom("as-is", "as-is", "lower", "upper"),
    valueCase: fc.constantFrom("as-is", "as-is", "lower", "upper"),
    quote: fc.constantFrom("", "", "`", '"', "'"),
  });
}

function arbNoteLineNoise() {
  return arbLineNoise({ markCase: fc.constantFrom("as-is", "as-is", "upper") });
}

/**
 * Representacao aceita de um instante: canonica (`...Z`), com fracao de
 * segundo, ou com deslocamento de fuso. Todas reduzem ao mesmo `updatedAt`
 * canonico depois do parse.
 */
function arbTimestampNoise() {
  return fc.record({
    fractionMs: fc.option(fc.integer({ min: 1, max: 999 }), { nil: null }),
    offsetMinutes: fc.constantFrom(0, 0, 60, -60, 180, -330, 540, -480),
    compactOffset: fc.boolean(),
  });
}

function renderInstant(canonical, noise) {
  const fraction = noise.fractionMs === null ? "" : `.${String(noise.fractionMs).padStart(3, "0")}`;
  if (noise.offsetMinutes === 0) return `${canonical.slice(0, 19)}${fraction}Z`;
  const shifted = new Date(Date.parse(canonical) + noise.offsetMinutes * 60_000)
    .toISOString()
    .slice(0, 19);
  const sign = noise.offsetMinutes > 0 ? "+" : "-";
  const absolute = Math.abs(noise.offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  const separator = noise.compactOffset ? "" : ":";
  return `${shifted}${fraction}${sign}${hours}${separator}${minutes}`;
}

/**
 * Um instante e suas representacoes equivalentes: a forma canonica
 * (`YYYY-MM-DDTHH:MM:SSZ`) mais as formas que designam o mesmo segundo UTC —
 * com fracao de segundo, com deslocamento de fuso (com e sem dois-pontos),
 * `Date` e epoch em milissegundos.
 *
 * Devolve `{ canonical, variants }`, em que toda entrada de `variants` deve
 * normalizar para `canonical` no campo `updatedAt`.
 */
export function arbEquivalentInstants() {
  return fc
    .record({
      canonical: arbInstant(),
      timestamp: arbTimestampNoise(),
      subSecondMs: fc.integer({ min: 0, max: 999 }),
    })
    .map(({ canonical, timestamp, subSecondMs }) => {
      const epochMs = Date.parse(canonical);
      return {
        canonical,
        variants: [
          canonical,
          renderInstant(canonical, timestamp),
          renderInstant(canonical, { ...timestamp, compactOffset: !timestamp.compactOffset }),
          new Date(epochMs + subSecondMs),
          epochMs + subSecondMs,
        ],
      };
    });
}

function renderFieldLine(field, value, noise) {
  const name = applyCase(field, noise.nameCase);
  return (
    `${noise.indent}${noise.marker}${noise.afterMarker}`
    + `**${noise.insideBoldLeft}${name}${noise.insideBoldRight}**`
    + `${noise.beforeColon}:${noise.afterColon}${noise.quote}${value}${noise.quote}${noise.trailing}`
  );
}

function renderNoteLine(role, noise) {
  const mark = applyCase(PROJECT_CONFIG_DEFAULT_APPLIED_MARK, noise.markCase);
  return (
    `${noise.indent}${noise.marker}${noise.afterMarker}${role}`
    + `${noise.beforeColon}:${noise.afterColon}${mark}${noise.trailing}`
  );
}

/** Monta o conteudo do arquivo aplicando o ruido gerado. */
function renderNoisyProjectConfigFile(config, noise) {
  const eol = EOL_BY_KEY[noise.eol];
  const lines = [];
  const pushBlank = (count) => {
    for (let index = 0; index < count; index += 1) lines.push(noise.blankLine);
  };

  if (noise.includeTitle) {
    lines.push(NOISY_TITLE);
    pushBlank(1);
  }
  if (noise.includeLead) {
    lines.push(NOISY_LEAD);
    pushBlank(1);
  }

  const values = {
    schemaVersion: String(config.schemaVersion),
    updatedAt: renderInstant(config.updatedAt, noise.timestamp),
  };
  for (const role of ROLES) values[role] = config[role];
  values[QUOTA_FALLBACK_FIELD] = config[QUOTA_FALLBACK_FIELD];

  noise.fieldOrder.forEach((field, index) => {
    const lineNoise = noise.fieldLines[index % noise.fieldLines.length];
    // Case do valor so varia em papel/campo opt-in: `updatedAt` exige `T` e `Z` maiusculos.
    const value = ROLES.includes(field) || field === QUOTA_FALLBACK_FIELD
      ? applyCase(values[field], lineNoise.valueCase)
      : values[field];
    pushBlank(lineNoise.blankBefore);
    lines.push(renderFieldLine(field, value, lineNoise));
  });

  const defaultsApplied = config.defaultsApplied ?? [];
  if (defaultsApplied.length > 0) {
    pushBlank(1);
    if (noise.includeNotesHeading) {
      lines.push(NOISY_NOTES_HEADING);
      pushBlank(1);
    }
    defaultsApplied.forEach((role, index) => {
      const lineNoise = noise.noteLines[index % noise.noteLines.length];
      lines.push(renderNoteLine(role, lineNoise));
    });
  }

  const body = lines.join(eol);
  return `${noise.bom ? "\ufeff" : ""}${body}${noise.trailingNewline ? eol : ""}`;
}

/** Projeta a Project_Config que o parser deve devolver para o conteudo gerado. */
function expectedProjectConfig(config) {
  const expected = {
    schemaVersion: config.schemaVersion,
    updatedAt: config.updatedAt,
  };
  for (const role of ROLES) expected[role] = config[role];
  expected[QUOTA_FALLBACK_FIELD] = config[QUOTA_FALLBACK_FIELD];
  expected.defaultsApplied = config.defaultsApplied ?? [];
  return expected;
}

/**
 * Project_Config_File valido porem ruidoso: BOM UTF-8 opcional, terminador
 * `\n`/`\r\n`/`\r`, espacamento e marcador de lista variaveis, ordem arbitraria
 * das seis linhas de campo, cabecalho e secao `## Notas` opcionais, valor entre
 * backticks ou aspas, e representacao alternativa do instante.
 *
 * Devolve `{ content, config, noise }`, em que `config` e a Project_Config que o
 * Config_Parser deve produzir para aquele conteudo.
 */
export function arbConfigFileNoise(options = {}) {
  const { defaultsApplied = true } = options;
  return arbProjectConfig({ defaultsApplied }).chain((config) =>
    fc
      .record({
        bom: fc.boolean(),
        eol: fc.constantFrom("lf", "lf", "crlf", "cr"),
        blankLine: fc.constantFrom("", "", " ", "\t"),
        trailingNewline: fc.boolean(),
        includeTitle: fc.boolean(),
        includeLead: fc.boolean(),
        includeNotesHeading: fc.boolean(),
        timestamp: arbTimestampNoise(),
        fieldOrder: fc.shuffledSubarray([...PROJECT_CONFIG_FIELDS], {
          minLength: PROJECT_CONFIG_FIELDS.length,
          maxLength: PROJECT_CONFIG_FIELDS.length,
        }),
        fieldLines: fc.array(arbFieldLineNoise(), {
          minLength: PROJECT_CONFIG_FIELDS.length,
          maxLength: PROJECT_CONFIG_FIELDS.length,
        }),
        noteLines: fc.array(arbNoteLineNoise(), {
          minLength: ROLES.length,
          maxLength: ROLES.length,
        }),
      })
      .map((noise) => ({
        content: renderNoisyProjectConfigFile(config, noise),
        config: expectedProjectConfig(config),
        noise,
      })),
  );
}

/* -------------------------------------------------------------------------- */
/* Entrada com ruido de case e campos extras                                   */
/* -------------------------------------------------------------------------- */

/**
 * Chaves extras plausiveis que um chamador poderia carregar no objeto de
 * configuracao — incluindo material sensivel que jamais deve chegar ao arquivo.
 * Nenhuma delas colide com os seis campos canonicos nem com `defaultsApplied`.
 */
const EXTRA_FIELD_KEYS = Object.freeze([
  "apiKey",
  "token",
  "authorization",
  "Authorization",
  "context7ApiKey",
  "secretHeader",
  "extraField",
  "backendExecutorReason",
  "schemaVersionNotes",
  "orchestratorSessionId",
]);

const HEX_DIGITS = Object.freeze("0123456789ABCDEF".split(""));

/** Valor marcador, facil de procurar no conteudo gravado. */
function arbExtraValue() {
  return fc
    .array(fc.constantFrom(...HEX_DIGITS), { minLength: 8, maxLength: 16 })
    .map((digits) => `ZZMARKER-${digits.join("")}-ZZ`);
}

/** Dicionario de campos extras arbitrarios, possivelmente vazio. */
export function arbExtraFields(options = {}) {
  const { maxKeys = 4 } = options;
  return fc.dictionary(fc.constantFrom(...EXTRA_FIELD_KEYS), arbExtraValue(), {
    minKeys: 0,
    maxKeys,
  });
}

function applyValueCase(value, mode) {
  if (mode === "upper") return value.toUpperCase();
  if (mode === "title") return value.charAt(0).toUpperCase() + value.slice(1);
  return value;
}

/**
 * Objeto de entrada do renderer com ruido que a normalizacao deve absorver:
 * valores de papel em caixa alta ou capitalizada, com espacos ao redor, mais
 * campos extras arbitrarios que nao pertencem a gramatica do arquivo.
 *
 * Devolve `{ input, config, extras }`, em que `config` e a Project_Config
 * canonica esperada (papeis em minusculas) e `extras` sao os campos que nao
 * devem aparecer no conteudo gravado.
 */
export function arbProjectConfigWithExtras(options = {}) {
  const { defaultsApplied = true } = options;
  return arbProjectConfig({ defaultsApplied }).chain((config) =>
    fc
      .record({
        extras: arbExtraFields(),
        valueNoise: fc.array(
          fc.record({
            case: fc.constantFrom("as-is", "as-is", "upper", "title"),
            pad: fc.constantFrom("", "", " ", "  ", "\t"),
          }),
          { minLength: ROLES.length, maxLength: ROLES.length },
        ),
      })
      .map(({ extras, valueNoise }) => {
        const input = { ...config };
        ROLES.forEach((role, index) => {
          const noise = valueNoise[index];
          input[role] = `${noise.pad}${applyValueCase(config[role], noise.case)}${noise.pad}`;
        });
        return { input: { ...input, ...extras }, config, extras };
      }),
  );
}

/* -------------------------------------------------------------------------- */
/* Project_Config_File defeituoso                                              */
/* -------------------------------------------------------------------------- */

/** Codigos de erro do Config_Parser exercitados pelo gerador de defeitos. */
export const PROJECT_CONFIG_DEFECT_CODES = Object.freeze([
  "PROJECT_CONFIG_FIELD_MISSING",
  "PROJECT_CONFIG_INVALID_VALUE",
  "PROJECT_CONFIG_UNPARSEABLE",
  "PROJECT_CONFIG_SCHEMA_UNSUPPORTED",
]);

/**
 * Valores de executor/reviewer fora do conjunto permitido. Nenhum reduz a
 * `codex`/`agy`/`claude-code` depois do trim e do lowercase do parser, e nenhum
 * carrega aspas, backtick ou barra invertida — o que mantem o valor recebido
 * comparavel com o que a mensagem de erro imprime.
 */
const INVALID_EXECUTOR_TOKENS = Object.freeze([
  "gpt-5",
  "claude",
  "codex-cli",
  "agy2",
  "claude code",
  "cursor",
  "gemini",
  "openai-codex",
  "CLAUDECODE",
]);

/** Representacoes que nao designam um instante UTC aceito pelo parser. */
const INVALID_UPDATED_AT_TOKENS = Object.freeze([
  "not-a-date",
  "14/02/2026",
  "2026-02-14",
  "2026-02-14T18:05Z",
  "2026-02-14 18:05:31Z",
  "2026-02-14T18:05:31",
  "2026-02-14T25:61:61Z",
  "ontem",
  "1739556331",
]);

/** `schemaVersion` que nao e inteiro maior ou igual a 1. */
const INVALID_SCHEMA_VERSION_TOKENS = Object.freeze([
  "0",
  "-1",
  "1.5",
  "abc",
  "v1",
  "um",
  "0001x",
]);

/** Conteudos sem nenhuma linha `- **campo**: valor` reconhecivel. */
const UNPARSEABLE_CONTENTS = Object.freeze([
  "",
  "   \n",
  "\n\n\n",
  `${NOISY_TITLE}\n\n${NOISY_LEAD}\n`,
  '{ "backendExecutor": "codex", "frontendExecutor": "agy" }\n',
  "- schemaVersion: 1\n- backendExecutor: codex\n- frontendExecutor: agy\n",
  "schemaVersion=1\nbackendExecutor=codex\n",
  `${NOISY_NOTES_HEADING}\n\n- frontendReviewer: ${PROJECT_CONFIG_DEFAULT_APPLIED_MARK}\n`,
  "<!-- arquivo em branco apos um merge malfeito -->\n",
]);

/** Valores que o parser reduz a vazio, ou seja, a campo obrigatorio ausente. */
const EMPTY_VALUE_TOKENS = Object.freeze(["", " ", "  ", "\t", '""', "``", "''"]);

/**
 * Campos obrigatorios do Project_Config_File: todo `PROJECT_CONFIG_FIELDS`
 * exceto `quotaFallbackChain`, que e retrocompativel (ausencia resolve para o
 * default em vez de `PROJECT_CONFIG_FIELD_MISSING`).
 */
const REQUIRED_PROJECT_CONFIG_FIELDS = Object.freeze(
  PROJECT_CONFIG_FIELDS.filter((field) => field !== QUOTA_FALLBACK_FIELD),
);

/** Localiza a linha canonica de um campo no conteudo gravado. */
function fieldLineIndex(lines, field) {
  const index = lines.findIndex((line) => line.startsWith(`- **${field}**:`));
  if (index === -1) throw new Error(`linha canonica do campo ${field} nao encontrada`);
  return index;
}

function removeFieldLine(content, field) {
  const lines = content.split("\n");
  lines.splice(fieldLineIndex(lines, field), 1);
  return lines.join("\n");
}

function replaceFieldValue(content, field, value) {
  const lines = content.split("\n");
  const index = fieldLineIndex(lines, field);
  lines[index] = `- **${field}**:${value === "" ? "" : ` ${value}`}`;
  return lines.join("\n");
}

/** Conteudo canonico de uma Project_Config valida, ponto de partida do defeito. */
function arbCanonicalContent() {
  return arbProjectConfig({ defaultsApplied: true }).map((config) => ({
    config,
    content: renderProjectConfig(config, { now: config.updatedAt }),
  }));
}

function defect(kind, code, extra = {}) {
  return { kind, code, field: null, received: null, accepted: null, ...extra };
}

/** Linha de campo removida do arquivo. */
function arbMissingFieldLine() {
  return fc
    .tuple(arbCanonicalContent(), fc.constantFrom(...REQUIRED_PROJECT_CONFIG_FIELDS))
    .map(([base, field]) => ({
      content: removeFieldLine(base.content, field),
      defect: defect("field-line-removed", "PROJECT_CONFIG_FIELD_MISSING", { field }),
    }));
}

/** Linha de campo presente, porem sem valor. */
function arbEmptyFieldValue() {
  return fc
    .tuple(
      arbCanonicalContent(),
      fc.constantFrom(...REQUIRED_PROJECT_CONFIG_FIELDS),
      fc.constantFrom(...EMPTY_VALUE_TOKENS),
    )
    .map(([base, field, token]) => ({
      content: replaceFieldValue(base.content, field, token),
      defect: defect("field-value-empty", "PROJECT_CONFIG_FIELD_MISSING", { field }),
    }));
}

/** Valor de executor/reviewer fora do conjunto permitido. */
function arbInvalidRoleValue() {
  return fc
    .tuple(
      arbCanonicalContent(),
      fc.constantFrom(...ROLES),
      fc.oneof(
        fc.constantFrom(...INVALID_EXECUTOR_TOKENS),
        fc
          .array(fc.constantFrom(..."0123456789ABCDEF".split("")), { minLength: 4, maxLength: 10 })
          .map((digits) => `ZZBAD-${digits.join("")}`),
      ),
    )
    .map(([base, role, token]) => ({
      content: replaceFieldValue(base.content, role, token),
      defect: defect("role-value-invalid", "PROJECT_CONFIG_INVALID_VALUE", {
        field: role,
        received: token,
        accepted: [...EXECUTORS],
      }),
    }));
}

/** `updatedAt` que nao designa um instante UTC aceito. */
function arbInvalidUpdatedAt() {
  return fc
    .tuple(arbCanonicalContent(), fc.constantFrom(...INVALID_UPDATED_AT_TOKENS))
    .map(([base, token]) => ({
      content: replaceFieldValue(base.content, "updatedAt", token),
      defect: defect("updated-at-invalid", "PROJECT_CONFIG_INVALID_VALUE", {
        field: "updatedAt",
        received: token,
      }),
    }));
}

/** `schemaVersion` acima do suportado por este plugin. */
function arbUnsupportedSchemaVersion() {
  return fc
    .tuple(arbCanonicalContent(), fc.integer({ min: PROJECT_CONFIG_SCHEMA_VERSION + 1, max: 99 }))
    .map(([base, version]) => ({
      content: replaceFieldValue(base.content, "schemaVersion", String(version)),
      defect: defect("schema-version-unsupported", "PROJECT_CONFIG_SCHEMA_UNSUPPORTED", {
        field: "schemaVersion",
        received: version,
        accepted: [PROJECT_CONFIG_SCHEMA_VERSION],
      }),
    }));
}

/** `schemaVersion` que nao e inteiro maior ou igual a 1. */
function arbInvalidSchemaVersion() {
  return fc
    .tuple(arbCanonicalContent(), fc.constantFrom(...INVALID_SCHEMA_VERSION_TOKENS))
    .map(([base, token]) => ({
      content: replaceFieldValue(base.content, "schemaVersion", token),
      defect: defect("schema-version-invalid", "PROJECT_CONFIG_INVALID_VALUE", {
        field: "schemaVersion",
        received: token,
        accepted: [String(PROJECT_CONFIG_SCHEMA_VERSION)],
      }),
    }));
}

/** Arquivo sem nenhuma linha de campo reconhecivel. */
function arbUnparseableContent() {
  return fc.constantFrom(...UNPARSEABLE_CONTENTS).map((content) => ({
    content,
    defect: defect("unparseable", "PROJECT_CONFIG_UNPARSEABLE"),
  }));
}

/**
 * Project_Config_File defeituoso, com **um** defeito por conteudo gerado para
 * que o erro esperado seja deterministico.
 *
 * Cobre os quatro codigos do Config_Parser: campo obrigatorio ausente (linha
 * removida ou valor vazio), valor de executor/reviewer fora do conjunto
 * permitido, `updatedAt` e `schemaVersion` invalidos, `schemaVersion` acima do
 * suportado, e arquivo sem nenhuma linha de campo reconhecivel.
 *
 * Devolve `{ content, defect }`, em que `defect` traz `kind`, `code`, `field`, o
 * valor `received` e o conjunto `accepted` que a mensagem de erro deve nomear.
 * `received` e `accepted` sao `null` quando o codigo nao os define (campo
 * ausente, arquivo ilegivel) ou quando o conjunto aceito e um formato interno
 * que o teste checa de forma estrutural.
 */
export function arbDefectiveProjectConfigFile() {
  return fc.oneof(
    arbMissingFieldLine(),
    arbEmptyFieldValue(),
    arbInvalidRoleValue(),
    arbInvalidUpdatedAt(),
    arbUnsupportedSchemaVersion(),
    arbInvalidSchemaVersion(),
    arbUnparseableContent(),
  );
}

/* -------------------------------------------------------------------------- */
/* Respostas parciais da coleta (defaults aplicados)                           */
/* -------------------------------------------------------------------------- */

/**
 * Formas de "papel sem resposta" que a coleta pode produzir: chave ausente no
 * objeto de respostas, `null`, `undefined` explicito, string vazia ou string
 * composta so de espaco em branco.
 */
const UNANSWERED_SHAPES = Object.freeze([
  "absent",
  "absent",
  "null",
  "undefined",
  "empty",
  "space",
  "spaces",
  "tab",
]);

const UNANSWERED_VALUE_BY_SHAPE = Object.freeze({
  null: null,
  undefined: undefined,
  empty: "",
  space: " ",
  spaces: "  ",
  tab: "\t",
});

/** Ruido de caixa e espacamento que a normalizacao de papel deve absorver. */
function arbAnswerNoise() {
  return fc.record({
    case: fc.constantFrom("as-is", "as-is", "upper", "title"),
    pad: fc.constantFrom("", "", " ", "  ", "\t"),
  });
}

/**
 * Respostas parciais da coleta da Project_Config: um subconjunto arbitrario dos
 * quatro papeis fica sem resposta, e os papeis respondidos trazem um executor
 * permitido, possivelmente com ruido de caixa e espacamento.
 *
 * Devolve `{ answers, unanswered, expectedRoles, updatedAt }`, em que
 * `unanswered` e o subconjunto sem resposta em ordem canonica (o
 * `defaultsApplied` esperado), `expectedRoles` traz o valor normalizado que cada
 * papel deve assumir — default nos papeis sem resposta — e `updatedAt` e o
 * instante canonico a injetar na resolucao.
 */
export function arbPartialProjectConfigAnswers() {
  return fc
    .record({
      unanswered: arbRoleSubset(),
      answered: arbRoles(),
      answerNoise: fc.array(arbAnswerNoise(), { minLength: ROLES.length, maxLength: ROLES.length }),
      shapes: fc.array(fc.constantFrom(...UNANSWERED_SHAPES), {
        minLength: ROLES.length,
        maxLength: ROLES.length,
      }),
      // Sempre respondido nesta propriedade: o escopo de "papel sem resposta"
      // aqui e so os quatro papeis de executor (Req 2.8). `quotaFallbackChain`
      // tem propriedade dedicada de default-aplicado.
      quotaFallbackChain: arbQuotaFallbackChain(),
      updatedAt: arbInstant(),
    })
    .map(({ unanswered, answered, answerNoise, shapes, quotaFallbackChain, updatedAt }) => {
      const answers = { [QUOTA_FALLBACK_FIELD]: quotaFallbackChain };
      const expectedRoles = {};
      ROLES.forEach((role, index) => {
        if (unanswered.includes(role)) {
          const shape = shapes[index];
          if (shape !== "absent") answers[role] = UNANSWERED_VALUE_BY_SHAPE[shape];
          expectedRoles[role] = DEFAULT_PROJECT_CONFIG[role];
          return;
        }
        const noise = answerNoise[index];
        answers[role] = `${noise.pad}${applyValueCase(answered[role], noise.case)}${noise.pad}`;
        expectedRoles[role] = answered[role];
      });
      return { answers, unanswered, expectedRoles, updatedAt };
    });
}
