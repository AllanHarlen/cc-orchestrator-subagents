#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { artifactTreePath } from "./lib/artifact-layout.mjs";
import { boolArg, executeJsonCli, parseArgs, required } from "./lib/cli-utils.mjs";
import { addValidatedFact, renderProjectMemory } from "./lib/project-knowledge.mjs";
import {
  collectInputFiles,
  findJsonCodeBlocks,
  intelligenceResult,
  persistIntelligenceEvidence,
  readTextBounded,
} from "./lib/intelligence.mjs";

const REQUIRED_SECTIONS = [
  "Contract Metadata",
  "Endpoint",
  "Metodo HTTP|Método HTTP",
  "Wire Format",
  "Request",
  "Response",
  "Estados de UI",
  "Permissoes|Permissões",
  "Validacoes Back-end|Validações Back-end",
  "Validacoes Front-end|Validações Front-end",
  "Checklist de Fechamento do Contrato",
];

function inspect(path, relativePath) {
  const content = readTextBounded(path);
  const missingSections = REQUIRED_SECTIONS.filter((section) =>
    !new RegExp(`^#{1,6}\\s+(?:${section})\\s*$`, "im").test(content),
  );
  const placeholders = [...content.matchAll(/<[^>\n]{1,120}>|\[(?:TODO|TBD)[^\]]*\]/gi)]
    .map((match) => match[0])
    .slice(0, 30);
  const jsonBlocks = findJsonCodeBlocks(content);
  const invalidJsonBlocks = jsonBlocks
    .map((block, index) => ({ ...block, index }))
    .filter((block) => !block.valid)
    .map((block) => ({ index: block.index, error: block.error }));
  const checklist = [...content.matchAll(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/gm)]
    .map((match) => ({ checked: match[1].toLowerCase() === "x", item: match[2].trim() }));
  const unchecked = checklist.filter((item) => !item.checked).map((item) => item.item);
  const casing = /(?:request|response):\s*`?(?:camelCase|PascalCase|snake_case)/i.test(content);
  const typescriptConfirmed = /status:\s*`?confirmado/i.test(content);
  const endpointConcrete = /^##\s+Endpoint\s*$[\s\S]{0,300}?`\/(?!api\/exemplo|<)[^`]+`/im.test(content);
  const endpoint = content.match(/^##\s+Endpoint\s*$[\s\S]{0,300}?`(\/[^`]+)`/im)?.[1] ?? null;
  const method = content.match(/^##\s+[^\n]*HTTP\s*$[\s\S]{0,120}?`(GET|POST|PUT|PATCH|DELETE)`/im)?.[1] ?? null;
  const wireFormats = [...content.matchAll(/(?:Request|Response)\s*:\s*`?(camelCase|PascalCase|snake_case)/gi)]
    .map((match) => match[1]);
  const methodConcrete = /^##\s+(?:Metodo|Método) HTTP\s*$[\s\S]{0,120}?`(?:GET|POST|PUT|PATCH|DELETE)`/im.test(content);
  const issues = [
    ...missingSections.map((section) => ({ code: "MISSING_SECTION", section })),
    ...placeholders.map((placeholder) => ({ code: "PLACEHOLDER", placeholder })),
    ...invalidJsonBlocks.map((block) => ({ code: "INVALID_JSON_EXAMPLE", ...block })),
    ...unchecked.map((item) => ({ code: "UNCHECKED_CONTRACT_GATE", item })),
  ];
  if (!casing) issues.push({ code: "CASING_NOT_DECLARED" });
  if (!typescriptConfirmed) issues.push({ code: "TYPESCRIPT_NOT_CONFIRMED" });
  if (!endpointConcrete) issues.push({ code: "ENDPOINT_NOT_CONCRETE" });
  if (!methodConcrete) issues.push({ code: "METHOD_NOT_CONCRETE" });
  return {
    path: relativePath,
    contentSha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    valid: issues.length === 0,
    jsonExamples: jsonBlocks.length,
    checklistItems: checklist.length,
    endpoint,
    method,
    wireFormats: [...new Set(wireFormats)],
    issues,
  };
}

function main(argv) {
  const args = parseArgs(argv);
  const root = resolve(args.root ?? process.cwd());
  const defaultContracts = args.dir ? artifactTreePath(args.dir, "contracts").path : null;
  const inputs = args.path ?? args._[0] ?? (defaultContracts && existsSync(defaultContracts) ? defaultContracts : null);
  if (!inputs) required(args, "path");
  const files = collectInputFiles(root, inputs, { extensions: [".md", ".json"] });
  const contracts = files.map((file) => inspect(file.absolute, file.relative));
  const summary = {
    contractsChecked: contracts.length,
    valid: contracts.filter((contract) => contract.valid).length,
    invalid: contracts.filter((contract) => !contract.valid).length,
    issueCount: contracts.reduce((count, contract) => count + contract.issues.length, 0),
  };
  const result = intelligenceResult("inspect-contract", summary, { contracts });
  const knowledge = boolArg(args["persist-knowledge"], false)
    ? {
        facts: contracts.filter((contract) => contract.valid).map((contract) =>
          addValidatedFact(root, {
            section: "Contracts",
            key: contract.path,
            value: {
              endpoint: contract.endpoint,
              method: contract.method,
              wireFormats: contract.wireFormats,
              status: "validated",
            },
            sourceType: "CONTRACT",
            sourceRef: contract.path,
          }),
        ),
        memory: renderProjectMemory(root),
      }
    : null;
  return {
    result,
    knowledge,
    persistence: persistIntelligenceEvidence(result, {
      artifactDir: args.dir,
      taskId: args.task,
      projectRoot: root,
    }),
  };
}

executeJsonCli(main);
