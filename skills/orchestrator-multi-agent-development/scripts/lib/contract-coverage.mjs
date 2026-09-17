/**
 * Contract coverage — cross-checks the ui-data-map's screen operations
 * against the machine-readable API contract, so a screen with no backing
 * operation is caught at FINAL, not three review cycles later in a real
 * run: `openapi.yaml` had 21 operations for 41 RFs (OficinaAI,
 * 2026-09-16) — no list endpoint for Ordens de Servico, Clientes, Vendas or
 * Leads — and nothing checked that until a browser E2E on the finished
 * build, after the front-end had already filled those screens from
 * client-side localStorage.
 *
 * Format-agnostic by construction: this module reads only the CONTRACT text
 * (openapi.yaml/json — a spec format, not a programming language) and the
 * ui-data-map.json (role `ui-data-map`, ingested from the Pensador handoff
 * in joint mode, or authored directly by the Orchestrador in independent
 * mode — see references/workflow.md Fase 4). It never reads generated
 * client/server source, so it carries no coupling to any backend/frontend
 * language or framework.
 *
 * Canonical copy: cc-pensador/scripts/lib/contract-coverage.mjs. Kept
 * duplicated (no shared package across these repos) — keep the two files in
 * sync when either changes; a test in each repo pins the parsing behavior
 * against the same real-world OficinaAI fixture.
 *
 * REST/OpenAPI 3.x gets a real parser — the format every run in this
 * workspace has used (resolveContractFormat('rest') is the default). GraphQL
 * SDL, gRPC/protobuf and AsyncAPI degrade to `applicable: false` with a
 * named reason instead of a false pass — same degradation contract
 * validate-requirements-coverage.mjs already uses when no requirements-index
 * exists: an unsupported format is a known, disclosed gap, never a silent
 * green light.
 */

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);

/**
 * Extracts `{ method, path }` pairs from an already-parsed OpenAPI `paths`
 * object (JSON input path). Pure and total.
 *
 * @param {unknown} pathsObject
 * @returns {Array<{method:string, path:string}>}
 */
function extractOperationsFromPathsObject(pathsObject) {
  const operations = [];
  if (typeof pathsObject !== 'object' || pathsObject === null) return operations;
  for (const [path, item] of Object.entries(pathsObject)) {
    if (typeof item !== 'object' || item === null) continue;
    for (const key of Object.keys(item)) {
      if (HTTP_METHODS.has(key.toLowerCase())) operations.push({ method: key.toUpperCase(), path });
    }
  }
  return operations;
}

/**
 * Parses an OpenAPI 3.x document's `paths:` block into a flat operation
 * list, without a YAML dependency (this codebase ships none — Node built-ins
 * only in production code). JSON input is parsed directly; YAML input is
 * read with a line-indentation scan scoped to ONLY the `paths:` block,
 * robust to indentation width because it infers each level from the first
 * line observed at that level rather than assuming a fixed step:
 *
 *   - the `paths:` block itself starts at column 0 and ends at the next
 *     column-0 key (or EOF);
 *   - the first `/segment:` line found inside it fixes the "path key"
 *     indent — every subsequent line at that SAME indent is a new path key;
 *     a shallower indent means the paths: block ended;
 *   - within a path's own chunk (up to the next path key or block end), the
 *     shallowest indent present is the "method key" indent — this is what
 *     makes the scan robust to schema bodies of unpredictable depth
 *     (parameters/requestBody/responses are always nested strictly deeper
 *     than the method key that owns them, never shallower).
 *
 * Never throws — malformed/empty input yields an empty operation list.
 *
 * @param {string} contractText
 * @returns {Array<{method:string, path:string}>}
 */
export function parseOpenApiOperations(contractText) {
  const text = String(contractText ?? '');
  const trimmedStart = text.trimStart();
  if (trimmedStart.startsWith('{')) {
    try {
      const doc = JSON.parse(text);
      return extractOperationsFromPathsObject(doc?.paths ?? {});
    } catch {
      return [];
    }
  }

  const lines = text.split(/\r?\n/);
  let blockStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^paths:\s*$/.test(lines[i])) {
      blockStart = i + 1;
      break;
    }
  }
  if (blockStart === -1) return [];

  let blockEnd = lines.length;
  for (let i = blockStart; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) {
      blockEnd = i;
      break;
    }
  }
  const block = lines.slice(blockStart, blockEnd);

  const indentOf = (line) => line.match(/^(\s*)/)[1].length;
  const isPathKeyLine = (line) => /^\s*\/[^\s:]*:\s*(#.*)?$/.test(line);
  const nonEmpty = (line) => line.trim() !== '' && !/^\s*#/.test(line);

  let pathKeyIndent = null;
  const pathKeyIndices = [];
  for (let i = 0; i < block.length; i += 1) {
    if (!nonEmpty(block[i]) || !isPathKeyLine(block[i])) continue;
    const indent = indentOf(block[i]);
    if (pathKeyIndent === null) pathKeyIndent = indent;
    if (indent === pathKeyIndent) pathKeyIndices.push(i);
  }
  if (pathKeyIndent === null) return [];

  const operations = [];
  for (let index = 0; index < pathKeyIndices.length; index += 1) {
    const start = pathKeyIndices[index];
    const end = pathKeyIndices[index + 1] ?? block.length;
    const pathMatch = block[start].trim().match(/^(\/[^\s:]*):\s*(#.*)?$/);
    if (!pathMatch) continue;
    const path = pathMatch[1];

    const chunk = block.slice(start + 1, end).filter(nonEmpty);
    if (chunk.length === 0) continue;
    const methodIndent = Math.min(...chunk.map(indentOf));
    for (const line of chunk) {
      if (indentOf(line) !== methodIndent) continue;
      const methodMatch = line.trim().match(/^([A-Za-z]+):\s*(#.*)?$/);
      if (methodMatch && HTTP_METHODS.has(methodMatch[1].toLowerCase())) {
        operations.push({ method: methodMatch[1].toUpperCase(), path });
      }
    }
  }
  return operations;
}

/**
 * Normalizes a method+path pair into a comparison key: path params are
 * generalized to `{}` regardless of the name used (`{id}` vs `{orcamentoId}`
 * should match — a ui-data-map author and the contract author are not
 * guaranteed to pick the same param name), and a trailing slash is stripped.
 * Pure and total.
 *
 * @param {string} method
 * @param {string} path
 * @returns {string}
 */
export function normalizeOperationKey(method, path) {
  const normalizedPath = String(path ?? '').trim()
    .replace(/\{[^}/]+\}/g, '{}')
    .replace(/\/+$/, '') || '/';
  return `${String(method ?? '').trim().toUpperCase()} ${normalizedPath}`;
}

/**
 * Parses a ui-data-map operation ref ("GET /ordens-servico/{id}") into
 * `{ method, path }`. Returns null when the ref does not match that shape
 * (e.g. still `"TBD"` — the scaffold placeholder). Pure and total.
 *
 * @param {string|null|undefined} ref
 * @returns {{method:string, path:string}|null}
 */
export function parseOperationRef(ref) {
  const match = String(ref ?? '').trim().match(/^([A-Za-z]+)\s+(\/\S*)$/);
  if (!match) return null;
  return { method: match[1].toUpperCase(), path: match[2] };
}

/**
 * Cross-checks every screen's `reads`/`writes` operation ref in a ui-data-map
 * against the operations actually declared in the contract text. Applicable
 * only to REST/OpenAPI today (`format: 'rest'`, the default and the format
 * every run so far has used) — any other format degrades to
 * `applicable: false` with a named reason, never a silent pass.
 *
 * Pure and total: same input -> same output, no I/O, never throws.
 *
 * @param {{screens?:Array}} uiDataMap
 * @param {string} contractText
 * @param {{format?: 'rest'|'graphql'|'grpc'|'events'}} [options]
 * @returns {{
 *   applicable: boolean,
 *   reason?: string,
 *   format: string,
 *   ok?: boolean,
 *   screensChecked?: number,
 *   operationsChecked?: number,
 *   contractOperationCount?: number,
 *   gaps?: Array<{screenId: string, operation: string, reason: string}>,
 * }}
 */
export function validateContractCoverage(uiDataMap, contractText, options = {}) {
  const format = options.format ?? 'rest';
  if (format !== 'rest') {
    return {
      applicable: false,
      format,
      reason: `CONTRACT_FORMAT_NOT_PARSEABLE: coverage checking currently only parses rest/openapi (got ${JSON.stringify(format)}) — this is a disclosed gap, not a silent pass. Cross-check this format's screens manually before status DONE.`,
    };
  }

  const contractOperations = new Set(
    parseOpenApiOperations(contractText).map((op) => normalizeOperationKey(op.method, op.path)),
  );

  const screens = Array.isArray(uiDataMap?.screens) ? uiDataMap.screens : [];
  const gaps = [];
  let operationsChecked = 0;
  for (const screen of screens) {
    const refs = [
      ...(Array.isArray(screen?.reads) ? screen.reads : []),
      ...(Array.isArray(screen?.writes) ? screen.writes : []),
    ];
    for (const ref of refs) {
      operationsChecked += 1;
      const parsed = parseOperationRef(ref?.operation);
      if (!parsed) {
        gaps.push({ screenId: screen?.id ?? '(sem id)', operation: String(ref?.operation ?? ''), reason: 'UNPARSEABLE_OPERATION_REF' });
        continue;
      }
      const key = normalizeOperationKey(parsed.method, parsed.path);
      if (!contractOperations.has(key)) {
        gaps.push({ screenId: screen?.id ?? '(sem id)', operation: `${parsed.method} ${parsed.path}`, reason: 'NO_MATCHING_CONTRACT_OPERATION' });
      }
    }
  }

  return {
    applicable: true,
    format,
    ok: gaps.length === 0,
    screensChecked: screens.length,
    operationsChecked,
    contractOperationCount: contractOperations.size,
    gaps,
  };
}
