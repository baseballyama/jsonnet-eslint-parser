import type { Program } from "./ast.ts";

/**
 * Build a visitor-keys map for the program. Each entry is `type → child
 * field names` and is consumed by ESLint's traversal so rule visitors fire
 * in source order regardless of the field layout in {@link JsonnetNode}.
 *
 * We compute the keys dynamically (rather than hard-coding them) for two
 * reasons:
 *
 *   1. New node types added in future go-jsonnet versions are picked up
 *      without a code change here.
 *   2. Optional fields (e.g. `else` on `Conditional`) are unioned across
 *      every node of the same type so the first instance does not need to
 *      contain every possible child.
 */

const SKIP_KEYS = new Set(["type", "range", "loc", "parent"]);

// Base keys for non-Jsonnet nodes that the rest of the parser introduces.
// Keeping them as a constant means traversal of these nodes is correct
// even when a program contains no Jsonnet body to learn keys from.
const BASE_VISITOR_KEYS: Record<string, string[]> = {
  Program: ["body", "tokens", "comments"],
  JsonnetParseError: [],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNode = (value: unknown): value is { type: string } =>
  isObject(value) && typeof value["type"] === "string";

export const buildVisitorKeys = (ast: Program): Record<string, string[]> => {
  const visitorKeys: Record<string, string[]> = {};
  const visited = new WeakSet<object>();

  const traverse = (node: unknown): void => {
    if (!isObject(node) || visited.has(node)) return;
    visited.add(node);

    if (isNode(node)) {
      const childKeys = visitorKeys[node.type] ?? [];
      if (!(node.type in visitorKeys)) visitorKeys[node.type] = childKeys;

      for (const [key, value] of Object.entries(node)) {
        if (SKIP_KEYS.has(key)) continue;
        const containsChild =
          isNode(value) || (Array.isArray(value) && value.some(isNode));
        if (containsChild && !childKeys.includes(key)) {
          childKeys.push(key);
        }
        if (Array.isArray(value)) {
          for (const item of value) traverse(item);
        } else {
          traverse(value);
        }
      }
      return;
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) traverse(item);
      } else {
        traverse(value);
      }
    }
  };

  // Walk only `body`: tokens and comments carry their own `type` strings
  // (e.g. "Identifier", "Line") that overlap with — but are not — AST node
  // types. Including them in visitorKeys would make ESLint try to traverse
  // them as AST nodes.
  for (const node of ast.body) traverse(node);

  return { ...visitorKeys, ...BASE_VISITOR_KEYS };
};
