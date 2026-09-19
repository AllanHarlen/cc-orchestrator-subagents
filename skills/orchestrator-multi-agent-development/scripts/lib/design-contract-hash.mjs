/**
 * Contract hash shared with cc-pensador (scripts/lib/token-mapper.mjs): sha256 of the canonical JSON
 * (keys sorted recursively, 2-space indent, trailing newline) of the contract WITHOUT its own `sha256`.
 * Keep the serialization identical, or every hash check against a real Pensador package will fail.
 */
import { createHash } from "node:crypto";

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function contractSha256(contract) {
  const { sha256: _ignored, ...rest } = contract;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}
