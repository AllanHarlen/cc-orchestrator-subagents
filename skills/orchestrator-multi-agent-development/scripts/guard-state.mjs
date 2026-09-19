#!/usr/bin/env node
/**
 * PreToolUse hook (registered in hooks/hooks.json): refuses hand-writes to the durable run
 * state of cc-orchestrador-subagents (`state.json`, `events.jsonl`, `.state.lock` under .orchestration, .orchestrator).
 * Decision logic lives in lib/state-guard.mjs. Exit 2 + stderr = block and tell the model why;
 * exit 0 = allow. Any unexpected error allows the call — a broken guard must never take a
 * session down.
 */
import { readFileSync } from 'node:fs';
import { evaluateToolCall } from './lib/state-guard.mjs';

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}
// Fast path: almost every tool call in every session has nothing to do with run state.
if (!/state\.json|events\.jsonl|\.state\.lock/.test(raw)) process.exit(0);

try {
  const verdict = evaluateToolCall(JSON.parse(raw));
  if (!verdict.allow) {
    process.stderr.write(`${verdict.reason}\n`);
    process.exit(2);
  }
} catch {
  /* fail open */
}
process.exit(0);
