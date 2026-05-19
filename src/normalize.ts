import type { JsonnetNode, Program } from "./ast.ts";
import type { RawNodeShape, RawParseResult, Range } from "./types.ts";

/**
 * Convert the JSON tree produced by the wasm bridge into the ESLint shape.
 *
 * The bridge emits each AST node with `nodeType` (the Go type name) and a
 * `loc`/`range` already in ESLint coordinates. We need to:
 *
 *   1. Rename `nodeType` → `type` so it matches the rest of the ESLint
 *      ecosystem.
 *   2. Drop the `locRange` field embedded by go-jsonnet on some nodes —
 *      the canonical position is the `loc`/`range` already attached.
 *   3. Stitch each child node's `parent` link.
 *
 * The traversal is iterative-by-recursion (the trees are small relative to
 * stack limits — Jsonnet files rarely nest beyond a few dozen levels) and
 * runs once per parse.
 */

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isRawNode = (value: unknown): value is RawNodeShape =>
  isObject(value) && typeof value["nodeType"] === "string";

/**
 * Field names whose values are pseudo-locations carried by go-jsonnet but
 * not useful in an ESLint AST. We drop them so consumers do not have to
 * navigate two parallel position trees.
 */
const REDUNDANT_FIELDS = new Set(["locRange"]);

const cleanNode = (node: RawNodeShape): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    type: node["nodeType"],
  };
  for (const [key, value] of Object.entries(node)) {
    if (key === "nodeType") continue;
    if (REDUNDANT_FIELDS.has(key)) continue;
    out[key] = walk(value);
  }
  return out;
};

const walk = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(walk);
  }
  if (isRawNode(value)) {
    return cleanNode(value);
  }
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (REDUNDANT_FIELDS.has(key)) continue;
      out[key] = walk(val);
    }
    return out;
  }
  return value;
};

const attachParents = (
  node: unknown,
  parent: JsonnetNode | Program | null,
): void => {
  if (Array.isArray(node)) {
    for (const item of node) attachParents(item, parent);
    return;
  }
  if (!isObject(node)) return;
  if (typeof node["type"] === "string" && parent) {
    (node as { parent?: JsonnetNode | Program }).parent = parent;
  }
  const nextParent =
    typeof node["type"] === "string"
      ? (node as unknown as JsonnetNode | Program)
      : parent;
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    attachParents(value, nextParent);
  }
};

const computeProgramRange = (code: string): Range => [0, code.length];

const positionFromOffset = (
  code: string,
  offset: number,
): { line: number; column: number } => {
  // Match the column-by-UTF-16-code-units convention used by ESLint and
  // the wasm bridge.
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < code.length; i++) {
    if (code.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: Math.max(0, offset - lineStart) };
};

export const normalizeParseResult = (
  code: string,
  raw: RawParseResult,
): Program => {
  const tokens = raw.tokens ?? [];
  const comments = raw.comments ?? [];

  const body: JsonnetNode[] = [];
  if (raw.ast) {
    const cleaned = walk(raw.ast);
    if (cleaned) body.push(cleaned as JsonnetNode);
  } else if (raw.error) {
    const message = raw.error;
    const start = 0;
    const end = code.length;
    body.push({
      type: "JsonnetParseError",
      range: [start, end],
      loc: {
        start: positionFromOffset(code, start),
        end: positionFromOffset(code, end),
      },
      error: message,
      raw: code,
    });
  }

  const range = computeProgramRange(code);
  const program: Program = {
    type: "Program",
    range,
    loc: {
      start: positionFromOffset(code, range[0]),
      end: positionFromOffset(code, range[1]),
    },
    body,
    tokens,
    comments,
  };

  for (const node of body) {
    attachParents(node, program);
  }

  return program;
};
