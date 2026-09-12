#!/usr/bin/env node
import { bootstrapOrchestrator } from "../skills/orchestrator-multi-agent-development/scripts/orchestrator-bootstrap.mjs";
import { parseArgs } from "../skills/orchestrator-multi-agent-development/scripts/lib/cli-utils.mjs";

const args = parseArgs(process.argv.slice(2));
const result = bootstrapOrchestrator({
  projectRoot: args.root === true ? process.cwd() : args.root,
  slug: args.slug === true ? undefined : args.slug,
  hasSpecification: args["has-specification"] === true || String(args["has-specification"] ?? "").toLowerCase() === "true",
  timeoutMs: args["timeout-ms"] ? Number(args["timeout-ms"]) : undefined,
});
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.status === "BLOCKED_DEPENDENCY" ? 1 : 0;
