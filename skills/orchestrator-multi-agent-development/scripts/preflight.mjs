#!/usr/bin/env node
/**
 * Preflight check for cc-orchestrador-subagents.
 *
 * Validates that every dependency the orchestrator needs is present, with the
 * Required_CLI_Set derived from the Project_Config of the target project:
 *  - The Project_Config itself (`.orchestrator/project-config.md`), when present
 *  - CLIs on PATH: agy, codex (required only when some role uses them)
 *  - Claude Code plugins: cc-antigravity-plugin, openai-codex (same condition)
 *  - A compatible Bash permission for the Codex companion runtime
 *  - A summary of the broader agent permission profile when available
 *  - Claude Code hook settings compatible with /goal
 *  - Optional MCP servers: codebase-memory and context7 (reported, never blocking).
 *    `checks.optional.mcp` is a file-based aggregate (any config location, any
 *    agent); pass `--check-agent-mcp` to also probe `codex mcp list --json`
 *    and `agy mcp list` directly and get `checks.optional.mcpPerAgent`, live
 *    per-agent ground truth (see `lib/mcp-agent-cli.mjs`).
 *
 * Report contract:
 *  - `projectConfig` carries the four effective roles, the file path, `updatedAt`,
 *    the derived `requiredCliSet` and `source` ("file" or "default").
 *  - Every check under `runtime`, `cli`, `plugins`, `permissions` and `config`
 *    carries `required: true|false`.
 *  - `failed` holds only failing **required** checks; failing optional checks and
 *    missing MCPs go to `warnings` with a `reason`
 *    (`NOT_DETECTED`, `TIMEOUT` or `NOT_REQUIRED_BY_PROJECT_CONFIG`).
 *  - Exit code is 0 if and only if `status === "ok"`. A warning never changes it.
 *
 * Outputs a JSON report to stdout.
 *
 * Usage:
 *   node "${CLAUDE_SKILL_DIR}/scripts/preflight.mjs" [--json] [--silent] [--check-agent-mcp]
 *   node scripts/preflight.mjs [--json] [--silent] [--check-agent-mcp] # compatibility wrapper
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { detectMcpServers, detectMcpServersPerAgent } from "./lib/mcp-detect.mjs";
import {
  DEFAULT_PROJECT_CONFIG,
  PROJECT_CONFIG_RELATIVE_PATH,
  ProjectConfigError,
  ROLES,
  deriveRequiredCliSet,
  readProjectConfig,
} from "./lib/project-config.mjs";

const HOME = homedir();
const PROJECT_ROOT = process.cwd();
const PLUGINS_CACHE = join(HOME, ".claude", "plugins", "cache");
const PROJECT_CLAUDE_DIR = join(process.cwd(), ".claude");
const PROJECT_SETTINGS_FILE = join(PROJECT_CLAUDE_DIR, "settings.json");
const MIN_ANTIGRAVITY_PLUGIN_VERSION = "4.0.0";
const MIN_AGY_VERSION = "1.1.8";
const RECOMMENDED_AGY_VERSION = "1.1.16";
const MIN_SQLITE_NODE_VERSION = "22.13.0";

/**
 * Opt-in: probes each installed agent's own `mcp list` subcommand for live,
 * per-agent ground truth (see `lib/mcp-agent-cli.mjs`), instead of just the
 * file-based aggregate `checks.optional.mcp`. Off by default because it shells
 * out (real wall-clock cost, up to `AGENT_CLI_TIMEOUT_MS` per agent per
 * server) and depends on `codex`/`agy` being reachable on PATH — neither of
 * which the rest of this script requires. Pass `--check-agent-mcp` to include
 * `checks.optional.mcpPerAgent` in the report.
 */
const CHECK_AGENT_MCP = process.argv.includes("--check-agent-mcp");

function checkNodeSqlite() {
  const current = process.versions.node;
  const versionOk = compareSemver(current, MIN_SQLITE_NODE_VERSION) >= 0;
  if (!versionOk) {
    return {
      ok: false,
      version: current,
      minVersion: MIN_SQLITE_NODE_VERSION,
      error: `Node.js ${MIN_SQLITE_NODE_VERSION}+ is required for node:sqlite without the experimental CLI flag`,
    };
  }
  try {
    const output = execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(':memory:'); db.exec(\"CREATE VIRTUAL TABLE docs USING fts5(body); INSERT INTO docs(body) VALUES ('ok')\"); const row=db.prepare('SELECT count(*) AS n FROM docs WHERE docs MATCH ?').get('ok'); db.close(); console.log(JSON.stringify({fts5:Number(row.n)===1,sqlite:process.versions.sqlite??null}))",
    ], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      windowsHide: true,
    });
    const capability = JSON.parse(output.trim());
    return {
      ok: capability.fts5 === true,
      version: current,
      sqliteVersion: capability.sqlite,
      fts5: capability.fts5,
      error: capability.fts5 ? null : "SQLite FTS5 is unavailable",
    };
  } catch (error) {
    return {
      ok: false,
      version: current,
      minVersion: MIN_SQLITE_NODE_VERSION,
      error: error.stderr?.toString().trim() || error.message,
    };
  }
}

function checkCli(cli, options = {}) {
  try {
    const out = execSync(`${cli} --version`, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    })
      .toString()
      .trim();
    const versionLine = out.split(/\r?\n/)[0];
    const version = versionLine.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/)?.[0] ?? null;
    if (options.minVersion && (!version || compareSemver(version, options.minVersion) < 0)) {
      return {
        ok: false,
        version: version ?? versionLine,
        minVersion: options.minVersion,
        error: `${cli} ${options.minVersion}+ is required (found ${version ?? versionLine})`,
      };
    }
    return {
      ok: true,
      version: version ?? versionLine,
      minVersion: options.minVersion ?? null,
      recommendedVersion: options.recommendedVersion ?? null,
      recommended: options.recommendedVersion && version
        ? compareSemver(version, options.recommendedVersion) >= 0
        : null,
    };
  } catch (err) {
    return { ok: false, error: err.message?.split(/\r?\n/)[0] ?? "not found" };
  }
}

function parseSemver(version) {
  const match = String(version ?? "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    core: match.slice(1, 4).map((part) => Number(part)),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;

  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    if (a.prerelease[i] == null) return -1;
    if (b.prerelease[i] == null) return 1;
    if (a.prerelease[i] === b.prerelease[i]) continue;
    const aNumber = /^\d+$/.test(a.prerelease[i]);
    const bNumber = /^\d+$/.test(b.prerelease[i]);
    if (aNumber && bNumber) return Number(a.prerelease[i]) - Number(b.prerelease[i]);
    if (aNumber !== bNumber) return aNumber ? -1 : 1;
    return a.prerelease[i].localeCompare(b.prerelease[i]);
  }
  return 0;
}

function checkPlugin(marketplace, pluginName, options = {}) {
  const dir = join(PLUGINS_CACHE, marketplace, pluginName);
  if (!existsSync(dir)) {
    return { ok: false, error: `missing ${dir}` };
  }

  let versions = [];
  try {
    versions = readdirSync(dir);
  } catch {
    return { ok: false, error: `cannot read ${dir}` };
  }

  if (versions.length === 0) {
    return { ok: false, error: `no versions installed in ${dir}` };
  }

  versions.sort((left, right) => {
    const semverComparison = compareSemver(left, right);
    if (semverComparison != null) return semverComparison;
    return left.localeCompare(right);
  });

  const version = versions[versions.length - 1];
  const versionDir = join(dir, version);
  const requiredFiles = options.requiredFiles ?? [];
  const missingFiles = requiredFiles.filter((file) => !existsSync(join(versionDir, file)));

  if (options.minVersion) {
    const semverComparison = compareSemver(version, options.minVersion);
    if (semverComparison == null) {
      return {
        ok: false,
        error: `latest installed version ${version} is not a valid semver for ${pluginName}`,
        version,
        path: versionDir,
      };
    }
    if (semverComparison < 0) {
      return {
        ok: false,
        error: `installed version ${version} is older than required ${options.minVersion}`,
        version,
        minVersion: options.minVersion,
        path: versionDir,
      };
    }
  }

  if (missingFiles.length > 0) {
    return {
      ok: false,
      error: `plugin ${pluginName} ${version} is missing required files: ${missingFiles.join(", ")}`,
      version,
      path: versionDir,
      missingFiles,
    };
  }

  return { ok: true, version, path: versionDir };
}

function checkCodexCompanionBashPermission() {
  const candidates = [
    PROJECT_SETTINGS_FILE,
    join(PROJECT_CLAUDE_DIR, "settings.local.json"),
    join(HOME, ".claude", "settings.json"),
    join(HOME, ".claude", "settings.local.json"),
  ];

  const inspected = [];
  const parseErrors = [];

  for (const file of candidates) {
    if (!existsSync(file)) continue;

    try {
      const settings = JSON.parse(readFileSync(file, "utf8"));
      const allow = Array.isArray(settings?.permissions?.allow)
        ? settings.permissions.allow
        : [];
      const deny = Array.isArray(settings?.permissions?.deny)
        ? settings.permissions.deny
        : [];
      const ask = Array.isArray(settings?.permissions?.ask)
        ? settings.permissions.ask
        : [];
      const matches = allow.filter(isCodexCompanionBashRule);
      const profile = summarizePermissionProfile(settings);

      inspected.push({
        path: file,
        allow: allow.filter((rule) => typeof rule === "string" && rule.startsWith("Bash")),
        deny,
        ask,
        defaultMode: settings?.permissions?.defaultMode ?? null,
      });

      if (matches.length > 0) {
        return {
          ok: true,
          path: file,
          rules: matches,
          profile,
        };
      }
    } catch (err) {
      parseErrors.push({
        path: file,
        error: err.message?.split(/\r?\n/)[0] ?? "cannot parse settings file",
      });
    }
  }

  return {
    ok: false,
    error:
      "Missing Claude Code permission to run the Codex companion via Bash. The orchestrator's direct codex-companion.mjs dispatch (checks.plugins['openai-codex'].companionPath), and the codex:codex-rescue fallback subagent, both need a compatible Bash rule such as Bash(node:*) so they can invoke codex-companion.mjs without an approval prompt.",
    expected: 'permissions.allow includes a compatible rule such as "Bash(node:*)"',
    inspected,
    parseErrors,
  };
}

function autoRemediateCodexCompanionBashPermission(initialCheck) {
  const fileExistedBefore = existsSync(PROJECT_SETTINGS_FILE);
  const result = {
    attempted: false,
    changed: false,
    target: PROJECT_SETTINGS_FILE,
    action: "none",
    revalidated: false,
    ok: initialCheck.ok,
  };

  if (initialCheck.ok) {
    return result;
  }

  const projectParseError = initialCheck.parseErrors?.find(
    (entry) => entry.path === PROJECT_SETTINGS_FILE,
  );

  if (projectParseError) {
    return {
      ...result,
      attempted: true,
      action: "blocked-invalid-json",
      error:
        "Auto-remediation skipped because .claude/settings.json exists but contains invalid JSON. Fix the file manually and rerun preflight.",
      ok: false,
    };
  }

  let settings = {};
  if (fileExistedBefore) {
    try {
      settings = JSON.parse(readFileSync(PROJECT_SETTINGS_FILE, "utf8"));
    } catch (err) {
      return {
        ...result,
        attempted: true,
        action: "blocked-invalid-json",
        error:
          err.message?.split(/\r?\n/)[0] ??
          "Auto-remediation skipped because .claude/settings.json could not be parsed.",
        ok: false,
      };
    }
  }

  if (!isPlainObject(settings)) {
    return {
      ...result,
      attempted: true,
      action: "blocked-non-object-root",
      error:
        "Auto-remediation skipped because .claude/settings.json must contain a JSON object at the root.",
      ok: false,
    };
  }

  const permissions = settings.permissions;
  if (permissions != null && !isPlainObject(permissions)) {
    return {
      ...result,
      attempted: true,
      action: "blocked-invalid-permissions-shape",
      error:
        "Auto-remediation skipped because .claude/settings.json has a non-object permissions field.",
      ok: false,
    };
  }

  const allow = permissions?.allow;
  if (allow != null && !Array.isArray(allow)) {
    return {
      ...result,
      attempted: true,
      action: "blocked-invalid-allow-shape",
      error:
        "Auto-remediation skipped because .claude/settings.json has permissions.allow in a non-array format.",
      ok: false,
    };
  }

  const nextSettings = {
    ...settings,
    permissions: {
      ...(permissions ?? {}),
      allow: [...(allow ?? []), "Bash(node:*)"],
    },
  };

  mkdirSync(PROJECT_CLAUDE_DIR, { recursive: true });
  writeFileSync(PROJECT_SETTINGS_FILE, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");

  const revalidated = checkCodexCompanionBashPermission();
  return {
    attempted: true,
    changed: true,
    target: PROJECT_SETTINGS_FILE,
    action: fileExistedBefore ? "updated-settings-json" : "created-settings-json",
    revalidated: revalidated.ok,
    ok: revalidated.ok,
    rules: revalidated.rules ?? [],
    path: revalidated.path ?? PROJECT_SETTINGS_FILE,
    error: revalidated.ok ? null : revalidated.error,
  };
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function checkGoalHookSettings() {
  const candidates = [
    join(PROJECT_CLAUDE_DIR, "settings.json"),
    join(PROJECT_CLAUDE_DIR, "settings.local.json"),
    join(HOME, ".claude", "settings.json"),
    join(HOME, ".claude", "settings.local.json"),
    join(HOME, ".claude", "managed-settings.json"),
  ];

  const inspected = [];
  const parseErrors = [];

  for (const file of candidates) {
    if (!existsSync(file)) continue;

    try {
      const settings = JSON.parse(readFileSync(file, "utf8"));
      inspected.push({
        path: file,
        disableAllHooks: settings?.disableAllHooks,
        allowManagedHooksOnly: settings?.allowManagedHooksOnly,
      });

      if (settings?.disableAllHooks === true) {
        return {
          ok: false,
          path: file,
          error:
            "/goal is unavailable because disableAllHooks is true. /goal depends on Claude Code Stop hooks.",
          inspected,
        };
      }

      if (settings?.allowManagedHooksOnly === true) {
        return {
          ok: false,
          path: file,
          error:
            "/goal may be unavailable because allowManagedHooksOnly is true. /goal depends on a session-scoped prompt Stop hook.",
          inspected,
        };
      }
    } catch (err) {
      parseErrors.push({
        path: file,
        error: err.message?.split(/\r?\n/)[0] ?? "cannot parse settings file",
      });
    }
  }

  return {
    ok: true,
    inspected,
    parseErrors,
    note:
      "No local/project setting was found disabling hooks. The workspace still needs to be trusted in Claude Code before /goal can run.",
  };
}

function isCodexCompanionBashRule(rule) {
  if (typeof rule !== "string") return false;
  const normalized = rule.replace(/\s+/g, " ").trim();

  return (
    normalized === "Bash" ||
    normalized === "Bash(*)" ||
    normalized === "Bash(node:*)" ||
    /^Bash\(node:.*codex-companion\.mjs.*\)$/.test(normalized) ||
    /^Bash\(node .*codex-companion\.mjs.*\)$/.test(normalized)
  );
}

function summarizePermissionProfile(settings) {
  const permissions = settings?.permissions ?? {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
  const deny = Array.isArray(permissions.deny) ? permissions.deny : [];
  const ask = Array.isArray(permissions.ask) ? permissions.ask : [];

  return {
    defaultMode: permissions.defaultMode ?? null,
    allowCount: allow.length,
    denyCount: deny.length,
    askCount: ask.length,
    hasBroadBashAccess:
      allow.includes("Bash") ||
      allow.includes("Bash(*)") ||
      allow.some((rule) => typeof rule === "string" && /^Bash\([^)]+:\*\)$/.test(rule)),
    hasWebSearch: allow.includes("WebSearch"),
    hasPlaywrightMcp: allow.some(
      (rule) => typeof rule === "string" && rule.startsWith("mcp__playwright__"),
    ),
    sampleAllow: allow.slice(0, 10),
    sampleDeny: deny.slice(0, 10),
    sampleAsk: ask.slice(0, 10),
  };
}

/**
 * Resolves the Project_Config of the target project before any other check.
 *
 * The Project_Config decides which CLIs (and their plugins) are required, so it
 * has to be resolved first (Req 5.1). Three outcomes:
 *
 *  - File present and valid: roles come from the file, `source: "file"`.
 *  - File absent: roles come from the default stack `codex`/`agy`/`codex`/`agy`,
 *    `source: "default"` (Req 5.6).
 *  - File present and invalid: the parser error becomes a failing **required**
 *    check (`checks.config.project-config`), which makes `status` be `failed`,
 *    and the Required_CLI_Set falls back to the default only so the report stays
 *    complete (Req 3.10). The file is never rewritten: reading it does not touch
 *    the filesystem.
 */
function resolveProjectConfigState(projectRoot) {
  try {
    const resolved = readProjectConfig(projectRoot);
    const requiredCliSet = deriveRequiredCliSet(resolved.config);
    const roles = {};
    for (const role of ROLES) roles[role] = resolved.config[role];

    return {
      requiredCliSet,
      block: {
        source: resolved.source,
        path: PROJECT_CONFIG_RELATIVE_PATH,
        updatedAt: resolved.config.updatedAt ?? null,
        roles,
        requiredCliSet: [...requiredCliSet.clis],
      },
      check: {
        ok: true,
        required: true,
        exists: resolved.exists,
        source: resolved.source,
        path: PROJECT_CONFIG_RELATIVE_PATH,
      },
    };
  } catch (error) {
    if (!(error instanceof ProjectConfigError)) throw error;

    // Fallback apenas para manter o relatorio completo: o status ja e `failed`,
    // entao nenhuma decisao de workflow e tomada a partir destes papeis.
    const requiredCliSet = deriveRequiredCliSet(DEFAULT_PROJECT_CONFIG);
    const path = error.details?.path ?? PROJECT_CONFIG_RELATIVE_PATH;

    return {
      requiredCliSet,
      block: {
        source: "default",
        path: PROJECT_CONFIG_RELATIVE_PATH,
        updatedAt: null,
        roles: { ...DEFAULT_PROJECT_CONFIG },
        requiredCliSet: [...requiredCliSet.clis],
      },
      check: {
        ok: false,
        required: true,
        exists: true,
        source: "invalid",
        path,
        code: error.code,
        error: error.message,
        field: error.details?.field ?? null,
        received: error.details?.received ?? null,
        accepted: error.details?.accepted ?? null,
        expected: "um Project_Config_File valido ou nenhum arquivo",
      },
    };
  }
}

// A Project_Config e resolvida antes de qualquer outro check: e ela que decide
// quais CLIs e plugins sao obrigatorios (Req 5.1).
const projectConfigState = resolveProjectConfigState(PROJECT_ROOT);
const requiredCliSet = projectConfigState.requiredCliSet;

const initialCodexCompanionBash = checkCodexCompanionBashPermission();
const autoRemediation = autoRemediateCodexCompanionBashPermission(initialCodexCompanionBash);
const finalCodexCompanionBash = checkCodexCompanionBashPermission();

// Resolvido uma vez aqui para que `checks.plugins["openai-codex"].companionPath`
// seja o unico lugar do workflow que sabe o path versionado do companion —
// references/workflow.md e subagent-prompts.md despacham direto para
// `node "<companionPath>" task ...` sem nunca hardcodar a versao instalada
// (cc-plugins-allan/CLAUDE.md: plugins de terceiro sao sobrescritos a cada
// update, entao nada fora deste script pode fixar "1.0.4" ou similar).
const openaiCodexPlugin = checkPlugin("openai-codex", "codex", {
  requiredFiles: ["scripts/codex-companion.mjs"],
});
const codexCompanionPath = openaiCodexPlugin.path
  ? join(openaiCodexPlugin.path, "scripts", "codex-companion.mjs")
  : undefined;

const checks = {
  config: {
    "project-config": projectConfigState.check,
  },
  runtime: {
    "node-sqlite-fts5": checkNodeSqlite(),
    // Git nunca e obrigatorio (fica fora de REQUIRED_BY_CHECK.runtime abaixo):
    // sem ele, o planejamento de worktree so degrada para execucao serializada
    // (worktree-manager.mjs::planTaskWorktrees, reason "GIT_UNAVAILABLE").
    // Ainda assim precisa ficar visivel no relatorio, entao vira aviso
    // explicito no loop de MCP logo abaixo.
    git: checkCli("git"),
  },
  cli: {
    agy: checkCli("agy", {
      minVersion: MIN_AGY_VERSION,
      recommendedVersion: RECOMMENDED_AGY_VERSION,
    }),
    codex: checkCli("codex"),
  },
  plugins: {
    "cc-antigravity-plugin": checkPlugin("cc-antigravity-plugin", "cc-antigravity-plugin", {
      minVersion: MIN_ANTIGRAVITY_PLUGIN_VERSION,
      requiredFiles: [
        "agents/antigravity-coder.md",
        "agents/antigravity-agent.md",
        "commands/antigravity.md",
        "scripts/antigravity-bridge.js",
      ],
    }),
    "openai-codex": { ...openaiCodexPlugin, companionPath: codexCompanionPath },
  },
  permissions: {
    "codex-companion-bash": finalCodexCompanionBash,
    "goal-hooks-enabled": checkGoalHookSettings(),
  },
  optional: {
    mcp: detectMcpServers({ projectRoot: PROJECT_ROOT, home: HOME, platform: process.platform }),
    ...(CHECK_AGENT_MCP ? { mcpPerAgent: detectMcpServersPerAgent() } : {}),
  },
};

/**
 * Obrigatoriedade por check.
 *
 * `cli.codex`/`plugins.openai-codex` sao obrigatorios se e somente se algum
 * papel da Project_Config usa `codex`; `cli.agy`/`plugins.cc-antigravity-plugin`
 * seguem a mesma regra para `agy` (Req 5.2 a 5.5). A decisao vem inteira de
 * `deriveRequiredCliSet`: este script nao reimplementa a condicao.
 *
 * `config.project-config`, `runtime.node-sqlite-fts5` e os itens de
 * `permissions` sao obrigatorios em qualquer configuracao (Req 5.8, D7).
 */
const REQUIRED_BY_CHECK = {
  config: { "project-config": true },
  runtime: { "node-sqlite-fts5": true },
  cli: { agy: requiredCliSet.agy, codex: requiredCliSet.codex },
  plugins: {
    "cc-antigravity-plugin": requiredCliSet.agy,
    "openai-codex": requiredCliSet.codex,
  },
  permissions: { "codex-companion-bash": true, "goal-hooks-enabled": true },
};

/** Categoria usada em `failed` e em `warnings` por grupo de checks. */
const CATEGORY_LABEL = {
  config: "config",
  runtime: "runtime",
  cli: "cli",
  plugins: "plugin",
  permissions: "permission",
};

/** Motivo de aviso para check reprovado que a Project_Config nao exige. */
const NOT_REQUIRED_BY_PROJECT_CONFIG = "NOT_REQUIRED_BY_PROJECT_CONFIG";

const failed = [];
const warnings = [];

// MCP ausente e sempre aviso, nunca bloqueio (Req 1.7): entra primeiro porque
// contexto de codigo e documentacao valem para qualquer executor.
for (const [name, result] of Object.entries(checks.optional.mcp)) {
  if (result.ok) continue;
  warnings.push({
    category: "mcp",
    name,
    required: false,
    reason: result.reason ?? "NOT_DETECTED",
  });
}

// Git ausente e sempre aviso, nunca bloqueio: worktree-manager.mjs degrada
// silenciosamente para execucao serializada quando `inspectGit` reporta
// indisponibilidade (mesmo padrao do loop de MCP acima).
if (!checks.runtime.git.ok) {
  warnings.push({
    category: "runtime",
    name: "git",
    required: false,
    reason: "NOT_INSTALLED",
  });
}

for (const [group, results] of Object.entries(REQUIRED_BY_CHECK)) {
  for (const [name, required] of Object.entries(results)) {
    const result = checks[group][name];
    result.required = required;
    if (result.ok) continue;
    if (required) {
      failed.push({ category: CATEGORY_LABEL[group], name, ...result });
      continue;
    }
    warnings.push({
      category: CATEGORY_LABEL[group],
      name,
      required: false,
      reason: NOT_REQUIRED_BY_PROJECT_CONFIG,
    });
  }
}

if (checks.cli.agy.ok && checks.cli.agy.recommended === false) {
  warnings.push({
    category: "cli",
    name: "agy",
    required: requiredCliSet.agy,
    reason: "BELOW_RECOMMENDED_VERSION",
    version: checks.cli.agy.version,
    recommendedVersion: RECOMMENDED_AGY_VERSION,
  });
}

const status = failed.length === 0 ? "ok" : "failed";

const report = {
  status,
  generatedAt: new Date().toISOString(),
  projectConfig: projectConfigState.block,
  checks,
  autoRemediation,
  warnings,
  failed,
  remediation: failed.length === 0 ? null : buildRemediation(failed),
};

console.log(JSON.stringify(report, null, 2));

process.exit(status === "ok" ? 0 : 1);

function buildRemediation(failures) {
  return failures.map((failure) => remediationFor(failure));
}

function remediationFor(f) {
  const key = `${f.category}:${f.name}`;
  switch (key) {
    case "config:project-config":
      return {
        target: `Project config file: ${PROJECT_CONFIG_RELATIVE_PATH}`,
        steps: [
          `Corrija ${PROJECT_CONFIG_RELATIVE_PATH} conforme o erro do parser: ${f.error}`,
          "Cada um dos seis campos ocupa uma linha de lista: - **<campo>**: <valor>.",
          "Valores de executor e reviewer sao codex, agy ou claude-code, em minusculas.",
          `Ou remova ${PROJECT_CONFIG_RELATIVE_PATH} para voltar a stack padrao codex/agy/codex/agy.`,
          "Ou rode /orchestrator project-config para regravar o arquivo a partir de novas respostas.",
          "Depois rode o preflight novamente.",
        ],
        docs: null,
      };
    case "runtime:node-sqlite-fts5":
      return {
        target: "Node.js runtime with node:sqlite and FTS5",
        steps: [
          `Install or select Node.js >= ${MIN_SQLITE_NODE_VERSION}.`,
          "Confirm that `node:sqlite` loads without an experimental flag and SQLite includes FTS5.",
          "Rerun /orchestrator preflight before using project memory/history.",
        ],
        docs: "https://nodejs.org/api/sqlite.html",
      };
    case "cli:agy":
      return {
        target: "Antigravity CLI (agy)",
        steps: [
          "Instalar Antigravity CLI:",
          "  Windows: irm https://antigravity.google/cli/install.ps1 | iex",
          "  macOS/Linux: curl -fsSL https://antigravity.google/cli/install.sh | bash",
          "Abrir `agy` uma vez para concluir a autenticacao interativa.",
          "Garantir que o binario 'agy' esta no PATH global.",
          `Confirmar AGY >= ${MIN_AGY_VERSION}; a versao ${RECOMMENDED_AGY_VERSION} e recomendada e validada com o bridge 4.0.`,
        ],
        docs: "https://antigravity.google/cli",
      };
    case "cli:codex":
      return {
        target: "codex-cli",
        steps: [
          "Instalar Codex CLI globalmente:",
          "  npm install -g @openai/codex",
          "Autenticar:",
          "  codex login",
          "Garantir que o binario 'codex' esta no PATH global.",
        ],
        docs: "https://github.com/openai/codex",
      };
    case "plugin:cc-antigravity-plugin":
      return {
        target: "Claude Code plugin: cc-antigravity-plugin",
        steps: [
          "Dentro do Claude Code:",
          "  claude plugin install AllanHarlen/cc-antigravity-plugin",
          `Confirme que a versao instalada seja >= ${MIN_ANTIGRAVITY_PLUGIN_VERSION} (requerida para modelos nativos, JSON/stream-json, read-only forte e retomada estruturada).`,
          "Valide que o plugin instalado contenha agents/antigravity-coder.md (implementacao), agents/antigravity-agent.md (review, somente leitura), commands/antigravity.md e scripts/antigravity-bridge.js.",
        ],
        docs: "https://github.com/AllanHarlen/cc-antigravity-plugin",
      };
    case "plugin:openai-codex":
      return {
        target: "Claude Code plugin: codex-plugin-cc",
        steps: [
          "Dentro do Claude Code:",
          "  /plugin marketplace add openai/codex-plugin-cc",
          "  /plugin install codex@openai-codex",
        ],
        docs: "https://github.com/openai/codex-plugin-cc",
      };
    case "permission:codex-companion-bash":
      return {
        target: "Claude Code permission: codex-companion via Bash",
        steps: [
          "No projeto alvo, crie ou atualize .claude/settings.json com:",
          '  { "permissions": { "allow": ["Bash(node:*)"] } }',
          "Ou use um perfil mais amplo, desde que ele inclua uma regra compativel para execucao do node/codex-companion.",
          "Reinicie ou recarregue a sessao do Claude Code antes de rodar /orchestrator novamente.",
          "Isso permite que codex:codex-rescue invoque node \"${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs\" task ... sem pedir aprovacao em background.",
        ],
        docs: "https://docs.anthropic.com/en/docs/claude-code/settings",
      };
    case "permission:goal-hooks-enabled":
      return {
        target: "Claude Code /goal hooks",
        steps: [
          "Remova ou altere a configuracao que desabilita hooks no escopo do projeto/usuario/managed settings.",
          "Garanta que disableAllHooks nao esteja true.",
          "Garanta que allowManagedHooksOnly nao bloqueie hooks de sessao.",
          "Abra o projeto no Claude Code e aceite o trust dialog do workspace.",
          "Depois rode /goal com uma condicao mensuravel, ou use /orchestrator novamente.",
        ],
        docs: "https://code.claude.com/docs/en/goal",
      };
    default:
      return {
        target: f.name,
        steps: ["Verifique manualmente a dependencia."],
        docs: null,
      };
  }
}
