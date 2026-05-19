import type { Program } from "./ast.ts";
import { normalizeParseResult } from "./normalize.ts";
import type { ParseResult, RawParseResult } from "./types.ts";
import { buildVisitorKeys } from "./visitorKeys.ts";
import { callWasmParse } from "./wasm-loader.ts";

/**
 * ESLint custom-parser entry point.
 *
 * @param code      Source text of the file being linted.
 * @param _options  ESLint parser options. Currently ignored; reserved for
 *                  forward-compatibility with options like `loc: false`.
 */
export const parseForESLint = (
  code: string,
  _options?: Record<string, unknown>,
): ParseResult => {
  const raw = JSON.parse(
    callWasmParse("input.jsonnet", code),
  ) as RawParseResult;
  const ast = normalizeParseResult(code, raw);
  return {
    ast,
    visitorKeys: buildVisitorKeys(ast),
    scopeManager: null,
    services: { isJsonnetParser: true },
  };
};

/**
 * Convenience wrapper that returns only the AST.
 *
 * Use {@link parseForESLint} when integrating with ESLint so the visitor
 * keys and services are wired up.
 */
export const parse = (
  code: string,
  options?: Record<string, unknown>,
): Program => parseForESLint(code, options).ast;
