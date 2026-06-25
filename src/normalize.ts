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

/**
 * go-jsonnet carries several child-bearing structures that are *not*
 * themselves AST nodes: an object's `fields`, a `local`'s `binds`, an
 * array's `elements`, a function's `parameters`, an apply's `arguments`
 * (with its `positional` / `named` lists), and a comprehension's `spec`
 * (with its `conditions`). In the raw tree these arrive as plain objects
 * with no `nodeType`, so {@link cleanNode} leaves them without a `type`.
 *
 * ESLint's traverser bails out the moment it reaches a value without a
 * string `type` — it never descends into such a node's own children. That
 * means a container nested inside `local x = {...}` (under `binds[i].body`)
 * or `[ {...} ]` (under `elements[i].expr`) would be unreachable, so rule
 * visitors would silently never fire on the bulk of a real Jsonnet file.
 *
 * To make the tree fully traversable we promote each wrapper to a proper
 * node: we give it a `type` derived from the key it sits under and a
 * `range`/`loc` spanning its descendant nodes. The original metadata
 * (`kind`, `hide`, `id`, fodder, …) is preserved untouched.
 */
const WRAPPER_TYPE_BY_KEY: Record<string, string> = {
  fields: "ObjectField",
  binds: "LocalBind",
  elements: "ArrayElement",
  parameters: "Parameter",
  arguments: "ApplyArguments",
  positional: "PositionalArgument",
  named: "NamedArgument",
  spec: "ForSpec",
  outer: "ForSpec",
  conditions: "IfSpec",
};

/**
 * Collect the `range` of every descendant that already carries one,
 * stopping at the first ranged node on each branch (its range already
 * covers its own subtree). Used to compute a span for a promoted wrapper.
 */
const collectDescendantRanges = (value: unknown, acc: number[]): void => {
  if (Array.isArray(value)) {
    for (const item of value) collectDescendantRanges(item, acc);
    return;
  }
  if (!isObject(value)) return;
  const range = value["range"];
  if (
    Array.isArray(range) &&
    typeof range[0] === "number" &&
    typeof range[1] === "number"
  ) {
    acc.push(range[0], range[1]);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "parent" || key === "loc") continue;
    collectDescendantRanges(child, acc);
  }
};

const promoteWrappers = (
  code: string,
  value: unknown,
  parentKey: string | null,
): void => {
  if (Array.isArray(value)) {
    for (const item of value) promoteWrappers(code, item, parentKey);
    return;
  }
  if (!isObject(value)) return;

  // Post-order: promote nested wrappers first so their `range` is set
  // before we span the current one from its children.
  for (const [key, child] of Object.entries(value)) {
    if (key === "parent") continue;
    promoteWrappers(code, child, key);
  }

  if (typeof value["type"] === "string" || parentKey === null) return;
  const wrapperType = WRAPPER_TYPE_BY_KEY[parentKey];
  if (wrapperType === undefined) return;

  value["type"] = wrapperType;
  if (!Array.isArray(value["range"])) {
    const ranges: number[] = [];
    collectDescendantRanges(value, ranges);
    if (ranges.length > 0) {
      const start = Math.min(...ranges);
      const end = Math.max(...ranges);
      value["range"] = [start, end];
      value["loc"] = {
        start: positionFromOffset(code, start),
        end: positionFromOffset(code, end),
      };
    }
  }
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
    if (cleaned) {
      // Promote non-node wrapper structures (object fields, local binds,
      // array elements, …) to proper nodes so ESLint can traverse the whole
      // tree. Must run before `attachParents` so the stitched parent chain
      // includes the wrappers.
      promoteWrappers(code, cleaned, null);
      body.push(cleaned as JsonnetNode);
    }
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
