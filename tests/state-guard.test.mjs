/**
 * Tests for the PreToolUse guard on the durable run state (lib/state-guard.mjs, guard-state.mjs).
 * What must be blocked (hand-writes to state.json / events.jsonl / .state.lock inside a run root)
 * and, as important, what must stay allowed (reads, the state CLI, unrelated files).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateToolCall, isProtectedStatePath, RUN_ROOTS } from '../skills/orchestrator-multi-agent-development/scripts/lib/state-guard.mjs';

const ROOT = RUN_ROOTS[0];
const HOOK = fileURLToPath(new URL('../scripts/guard-state.mjs', import.meta.url));
const dir = `C:\\proj\\${ROOT}\\feat\\run`;
const call = (tool_name, tool_input) => ({ tool_name, tool_input });

test('blocks Edit/Write/MultiEdit on state.json, events.jsonl and .state.lock in a run root', () => {
  for (const name of ['state.json', 'events.jsonl', '.state.lock']) {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) {
      const verdict = evaluateToolCall(call(tool, { file_path: `${dir}\\${name}`, old_string: 'a', new_string: 'b', content: '{}' }));
      assert.equal(verdict.allow, false, `${tool} ${name}`);
      assert.match(verdict.reason, /orchestration-state.mjs/);
    }
  }
});

test('handles POSIX and Windows separators', () => {
  assert.equal(isProtectedStatePath(`/home/u/proj/${ROOT}/feat/state.json`), true);
  assert.equal(isProtectedStatePath(`C:\\proj\\${ROOT}\\feat\\events.jsonl`), true);
});

test('allows the same file names outside a run root, and other files inside one', () => {
  assert.equal(evaluateToolCall(call('Write', { file_path: 'C:\\proj\\src\\state.json', content: '{}' })).allow, true);
  assert.equal(evaluateToolCall(call('Write', { file_path: `${dir}\\handoff.json`, content: '{}' })).allow, true);
  assert.equal(evaluateToolCall(call('Edit', { file_path: `${dir}\\implementation-report.md`, old_string: 'a', new_string: 'b' })).allow, true);
});

test('blocks shell writes to run state, allows reads and the state CLI', () => {
  const sh = (command, tool = 'Bash') => evaluateToolCall(call(tool, { command }));
  assert.equal(sh(`sed -i 's/RUNNING/DONE/' ${ROOT}/feat/state.json`).allow, false);
  assert.equal(sh(`echo '{}' > ${ROOT}/feat/state.json`).allow, false);
  assert.equal(sh(`echo x >> ${ROOT}/feat/events.jsonl`).allow, false);
  assert.equal(sh(`node -e "require('fs').writeFileSync('${ROOT}/feat/state.json','{}')"`).allow, false);
  assert.equal(sh(`(Get-Content ${ROOT}\\feat\\state.json) -replace 'RUNNING','DONE' | Set-Content ${ROOT}\\feat\\state.json`, 'PowerShell').allow, false);
  assert.equal(sh(`rm ${ROOT}/feat/events.jsonl`).allow, false);

  assert.equal(sh(`cat ${ROOT}/feat/state.json`).allow, true);
  assert.equal(sh(`grep -c . ${ROOT}/feat/events.jsonl | head`).allow, true);
  assert.equal(sh(`node scripts/orchestration-state.mjs status --dir ${ROOT}/feat`).allow, true);
  assert.equal(sh('sed -i s/a/b/ README.md').allow, true);
  assert.equal(sh('echo x > state.json').allow, true); // no run root named: a project file, not run state
});

test('hook process: exit 2 with the reason when blocking, exit 0 otherwise and on garbage', () => {
  const run = (input) => spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8' });
  const blocked = run(JSON.stringify(call('Write', { file_path: `${dir}\\state.json`, content: '{}' })));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /orchestration-state.mjs/);
  assert.equal(run(JSON.stringify(call('Bash', { command: 'ls' }))).status, 0);
  assert.equal(run('not json state.json').status, 0);
});

test('hooks/hooks.json registers the guard as a PreToolUse hook', () => {
  const hooks = JSON.parse(readFileSync(fileURLToPath(new URL('../hooks/hooks.json', import.meta.url)), 'utf8'));
  const entry = hooks.hooks.PreToolUse[0];
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'Bash', 'PowerShell']) assert.ok(entry.matcher.split('|').includes(tool), tool);
  assert.match(entry.hooks[0].command, /guard-state\.mjs/);
});
