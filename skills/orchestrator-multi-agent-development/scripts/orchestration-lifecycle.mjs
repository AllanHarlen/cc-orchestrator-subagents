#!/usr/bin/env node

import { resolve } from "node:path";

import { boolArg, executeJsonCli, numberArg, parseArgs, required } from "./lib/cli-utils.mjs";
import {
  interruptTaskLifecycle,
  cancelRunLifecycle,
  retryTaskLifecycle,
  tickLifecycle,
  watchLifecycle,
} from "./lib/lifecycle-manager.mjs";

function options(args) {
  return {
    projectRoot: resolve(args.root ?? process.cwd()),
    probeFile: args["probe-file"],
    codexFile: args["codex-file"],
    agyFile: args["agy-file"],
    adapterConfig: args["adapter-config"],
    staleIdleSeconds: numberArg(args["stale-idle-seconds"]),
    staleInToolSeconds: numberArg(args["stale-in-tool-seconds"]),
    stallGraceSeconds: numberArg(args["stall-grace-seconds"]),
    intervalSeconds: numberArg(args["interval-seconds"]),
    maxTicks: numberArg(args["max-ticks"]),
    autoStop: boolArg(args["auto-stop"], true),
    includeAll: boolArg(args["include-all"], false),
    now: args.now,
    leaseTtlSeconds: numberArg(args["lease-ttl-seconds"]),
  };
}

// `watch` is meant to run unattended in the background — a single JSON blob
// printed only after the whole loop resolves is useless to inspect mid-run
// (e.g. `tail -f` on a backgrounded process's log). Print one NDJSON line per
// tick as it happens; executeJsonCli still prints the final summary on top.
function onTick(tick) {
  console.log(JSON.stringify({ type: "tick", ...tick }));
}

function help() {
  return {
    name: "orchestration-lifecycle",
    commands: {
      tick: "tick --dir <run> [--resume] [--probe-file|--codex-file|--agy-file <json>] [--adapter-config <json>]",
      watch: "watch --dir <run> [--interval-seconds 30] [--max-ticks N] [--auto-stop=false] — prints one NDJSON {type:\"tick\",...} line per tick; stops early (stoppedReason: NO_ACTIVE_TASKS|RUN_TERMINAL) unless --auto-stop=false",
      interrupt: "interrupt --dir <run> --task <id> (--adapter-config <json>|--external-confirmed) [--reason <text>]",
      retry: "retry --dir <run> --task <id> [--confirmed-gone] (--adapter-config <json>|--external-confirmed)",
      cancel: "cancel --dir <run> --reason <text> [--adapter-config <json>] [--finalize]",
    },
  };
}

async function main(argv) {
  const [command = "help", ...rest] = argv;
  const args = parseArgs(rest);
  const artifactDir = args.dir ? resolve(args.dir) : null;
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      return help();
    case "tick":
      return tickLifecycle(required(args, "dir"), {
        ...options(args),
        resume: boolArg(args.resume, false),
      });
    case "watch":
      return watchLifecycle(required(args, "dir"), { ...options(args), onTick });
    case "interrupt":
      return interruptTaskLifecycle(artifactDir, required(args, "task"), {
        ...options(args),
        reason: args.reason,
        evidence: args.evidence,
        externalConfirmed: boolArg(args["external-confirmed"], false),
      });
    case "retry":
      return retryTaskLifecycle(artifactDir, required(args, "task"), {
        ...options(args),
        confirmedGone: boolArg(args["confirmed-gone"], false),
        executor: args.executor,
        sessionId: args["session-id"],
        conversationId: args["conversation-id"],
        reason: args.reason,
        evidence: args.evidence,
        adapterConfig: args["adapter-config"],
        externalConfirmed: boolArg(args["external-confirmed"], false),
      });
    case "cancel":
      return cancelRunLifecycle(artifactDir, {
        ...options(args),
        reason: required(args, "reason"),
        externalConfirmed: boolArg(args["external-confirmed"], false),
        finalize: boolArg(args.finalize, false),
      });
    default: {
      const error = new Error(`Unknown command: ${command}`);
      error.code = "UNKNOWN_COMMAND";
      throw error;
    }
  }
}

executeJsonCli(main);
