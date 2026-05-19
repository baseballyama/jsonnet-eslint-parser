import * as Ast from "./ast.ts";
import { parse, parseForESLint } from "./parse.ts";
import { warmup } from "./wasm-loader.ts";

export default {
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
