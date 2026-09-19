/**
 * Decides whether a tool call may hand-write the durable run state of cc-orchestrador-subagents.
 *
 * The run state is event-sourced by `orchestration-state.mjs` (`state.json` snapshot + `events.jsonl`
 * log + `.state.lock`). A run that edits those files by hand skips every gate the state
 * module enforces — the failure mode a real Pensador run showed (checkpoint hand-moved from
 * INIT to DONE, six stages never visited). This is the pure decision used by the PreToolUse
 * hook `scripts/guard-state.mjs`:
 *
 *   - Edit / Write / MultiEdit on `state.json`, `events.jsonl` or `.state.lock` inside a run
 *     directory (`.orchestration, .orchestrator`) is denied.
 *   - Bash / PowerShell is denied when the command both names one of those files under a run
 *     root and looks like a write (redirect, sed -i, tee, Set-Content, writeFile, mv, rm, ...).
 *     Reads (cat, grep, jq) pass. `orchestration-state.mjs` itself never needs an exemption: its command
 *     line names the run directory, not the files.
 *
 * Heuristic by nature for shell commands; the state module's own replay verification
 * (`verify`, SNAPSHOT_DIVERGED) remains the backstop for anything that slips through.
 */

export const RUN_ROOTS = Object.freeze(['.orchestration', '.orchestrator']);
export const PROTECTED_NAMES = Object.freeze(['state.json', 'events.jsonl', '.state.lock']);

const STATE_CLI = 'orchestration-state.mjs';

const HOW_TO =
  `The run state is written only by ${STATE_CLI} (init, phase, task, gate, run --status ...). ` +
  `Use its subcommands; run "node <plugin>/scripts/${STATE_CLI} --help" if unsure. Verify integrity with its "verify" subcommand.`;

const SHELL_WRITE = [
  /\bsed\b[^|;&]*\s-[a-zA-Z]*i/,
  />>?\s*["']?[^\s|;&"']*(state\.json|events\.jsonl|\.state\.lock)/,
  /\btee\b/,
  /\b(Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Rename-Item|New-Item)\b/i,
  /\bwrite(File|FileSync)?\b|\bopen\([^)]*['"]w/i,
  /\b(mv|rm|del|ren)\b/,
  /-replace\b/i,
];

const segments = (path) => String(path).split(/[\\/]+/).filter(Boolean);

/** True for `<...>/<runRoot>/**\/state.json|events.jsonl|.state.lock`. */
export function isProtectedStatePath(path) {
  if (typeof path !== 'string') return false;
  const parts = segments(path);
  const name = parts.at(-1);
  return PROTECTED_NAMES.includes(name) && parts.slice(0, -1).some((part) => RUN_ROOTS.includes(part));
}

/**
 * @param {{ tool_name: string, tool_input: object }} call
 * @returns {{ allow: boolean, reason?: string }}
 */
export function evaluateToolCall(call) {
  const { tool_name: tool, tool_input: input = {} } = call ?? {};

  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(input.command ?? '');
    const namesState = PROTECTED_NAMES.some((name) => command.includes(name));
    const namesRoot = RUN_ROOTS.some((root) => command.includes(root));
    if (namesState && namesRoot && SHELL_WRITE.some((re) => re.test(command))) {
      return { allow: false, reason: `Blocked: this command writes run state by hand. ${HOW_TO}` };
    }
    return { allow: true };
  }

  if (['Edit', 'Write', 'MultiEdit'].includes(tool) && isProtectedStatePath(input.file_path)) {
    return { allow: false, reason: `Blocked: ${segments(input.file_path).at(-1)} is durable run state. ${HOW_TO}` };
  }
  return { allow: true };
}
