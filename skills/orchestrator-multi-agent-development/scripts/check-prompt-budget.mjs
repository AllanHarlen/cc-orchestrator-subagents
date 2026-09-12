#!/usr/bin/env node

/**
 * Mede um prompt de delegacao contra o orcamento de 24.000 caracteres, com
 * semantica diferente por agente:
 *
 * - `--agent agy`: limite duro. O gargalo real e a chamada `agy --print <prompt>`
 *   dentro do bridge (cc-antigravity-plugin/scripts/antigravity-bridge.js), que
 *   sempre vai por argv mesmo quando o chamador usa `--task-file`. Passar do
 *   limite quebra com `ENAMETOOLONG` no Windows — falha dura, exit 1.
 * - `--agent codex`: com `--prompt-file` (codex-companion.mjs) nao ha limite de
 *   argv, entao o mesmo threshold vira apenas indicativo de qualidade de
 *   contexto (`advisory: true`), nunca falha — exit 0 mesmo acima do limite.
 *
 * Uso:
 *   node check-prompt-budget.mjs --agent agy --file <path>
 *   node check-prompt-budget.mjs --agent codex --stdin < prompt.txt
 *   echo "$PROMPT" | node check-prompt-budget.mjs --agent agy --stdin
 *
 * Saida: `{ chars, limit, overBy, ok, advisory, suggestedSplits }`. Exit 1
 * quando `--agent agy` e `ok: false` (chamador propaga a falha em vez de
 * precisar checar o JSON); `--agent codex` nunca falha por esta checagem.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { executeJsonCli, numberArg, parseArgs, required } from "./lib/cli-utils.mjs";

export const PROMPT_CHAR_LIMIT = 24_000;
const HARD_LIMIT_AGENTS = new Set(["agy"]);
const ADVISORY_LIMIT_AGENTS = new Set(["codex"]);

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function suggestSplits(chars, limit) {
  if (chars <= limit) return 1;
  return Math.ceil(chars / limit);
}

function main(argv) {
  const args = parseArgs(argv);
  const agent = String(required(args, "agent")).toLowerCase();
  if (!HARD_LIMIT_AGENTS.has(agent) && !ADVISORY_LIMIT_AGENTS.has(agent)) {
    const error = new Error(
      `Unsupported --agent "${agent}". Expected one of: ${[
        ...HARD_LIMIT_AGENTS,
        ...ADVISORY_LIMIT_AGENTS,
      ].join(", ")}`,
    );
    error.code = "UNSUPPORTED_AGENT";
    throw error;
  }
  const limit = numberArg(args.limit, PROMPT_CHAR_LIMIT);
  const advisory = ADVISORY_LIMIT_AGENTS.has(agent);

  const text = args.stdin ? readStdin() : readFileSync(resolve(String(required(args, "file"))), "utf8");

  const chars = text.length;
  const ok = chars <= limit;
  const overBy = ok ? 0 : chars - limit;

  if (!ok && !advisory) {
    const error = new Error(
      `Prompt has ${chars} chars, ${overBy} over the ${limit}-char AGY limit. `
      + "Split the task into independent-deliverable subtasks (see references/workflow.md "
      + "\"Regra de limite de prompt AGY\") before delegating.",
    );
    error.code = "PROMPT_OVER_LIMIT";
    error.details = { agent, chars, limit, overBy, suggestedSplits: suggestSplits(chars, limit) };
    throw error;
  }

  return {
    agent,
    chars,
    limit,
    overBy,
    ok,
    advisory,
    suggestedSplits: ok ? 1 : suggestSplits(chars, limit),
  };
}

executeJsonCli(main);
