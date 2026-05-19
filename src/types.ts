import type { Program } from "./ast.ts";

export interface ESLintPosition {
  line: number;
  column: number;
}

export interface ESLintSourceLocation {
  start: ESLintPosition;
  end: ESLintPosition;
}

export type Range = [number, number];

export interface ESLintToken {
  type: string;
  value: string;
  range: Range;
  loc: ESLintSourceLocation;
}

export type ESLintCommentType = "Line" | "Hash" | "Block";

export interface ESLintComment {
  type: ESLintCommentType;
  value: string;
  range: Range;
  loc: ESLintSourceLocation;
}

export interface ParseResult {
  ast: Program;
  visitorKeys: Record<string, string[]>;
  scopeManager: null;
  services: { isJsonnetParser: true };
}

/**
 * Shape of the JSON payload produced by `wasm/main.go`. Tokens and comments
 * come back already in the public ESLint shape; only the recursive AST tree
 * needs normalisation, so it is left as `unknown` here and refined into
 * {@link Program} during {@link import("./normalize.ts").normalizeParseResult}.
 */
export interface RawParseResult {
  ast?: unknown;
  tokens?: ESLintToken[];
  comments?: ESLintComment[];
  error?: string;
  lexError?: string;
}

export interface RawNodeShape {
  nodeType: string;
  range?: Range;
  loc?: ESLintSourceLocation;
  [key: string]: unknown;
}
