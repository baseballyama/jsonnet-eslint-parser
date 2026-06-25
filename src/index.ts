import pkg from "../package.json";

import * as Ast from "./ast.ts";
import { parse, parseForESLint } from "./parse.ts";
import { warmup } from "./wasm-loader.ts";

/**
 * ESLint flat config expects a parser to expose `meta.name` / `meta.version`
 * so it can report which parser produced a result and key its cache on the
 * version. `version` is read from package.json (inlined by the bundler at
 * build time), so it always matches the published release and never drifts —
 * changesets only has to bump package.json.
 */
export const meta = {
  name: "jsonnet-eslint-parser",
  version: pkg.version,
};

export default {
  meta,
  parse,
  parseForESLint,
  warmup,
  Ast,
};

export * as Ast from "./ast.ts";
export { parse, parseForESLint } from "./parse.ts";
export { warmup } from "./wasm-loader.ts";
export type {
  ESLintComment,
  ESLintCommentType,
  ESLintPosition,
  ESLintSourceLocation,
  ESLintToken,
  ParseResult,
  Range,
} from "./types.ts";
