/**
 * Jsonnet ESLint parser AST definitions.
 *
 * The node types map one-to-one with go-jsonnet's `ast` package. We surface
 * them as TypeScript so consumers can write ESLint rules that pattern-match
 * on `node.type` and traverse children typed correctly.
 *
 * The shape mirrors go-jsonnet but with two adjustments:
 *
 *   - `loc` follows the ESLint convention (1-indexed lines, 0-indexed UTF-16
 *     columns) and is paired with a `range` of UTF-16 character offsets.
 *   - Children that are themselves nodes are typed as the union
 *     {@link JsonnetNode} so a traversal walks through them uniformly.
 *
 * @see https://github.com/google/go-jsonnet/blob/master/ast/ast.go
 */

import type {
  ESLintComment,
  ESLintToken,
  ESLintSourceLocation,
  Range,
} from "./types.ts";

export interface BaseNode {
  type: string;
  range: Range;
  loc: ESLintSourceLocation;
  parent?: JsonnetNode | Program;
}

// ---------------------------------------------------------------------------
// Top-level program
// ---------------------------------------------------------------------------

export interface Program {
  type: "Program";
  range: Range;
  loc: ESLintSourceLocation;
  body: JsonnetNode[];
  tokens: ESLintToken[];
  comments: ESLintComment[];
}

// ---------------------------------------------------------------------------
// Identifier
// ---------------------------------------------------------------------------

/**
 * A Jsonnet identifier as carried inside other nodes. Identifiers are plain
 * strings in go-jsonnet (`type Identifier string`) and do not appear as
 * standalone AST nodes in the source; we expose the string directly.
 */
export type IdentifierName = string;

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

export interface LiteralNull extends BaseNode {
  type: "LiteralNull";
}

export interface LiteralBoolean extends BaseNode {
  type: "LiteralBoolean";
  value: boolean;
}

export interface LiteralNumber extends BaseNode {
  type: "LiteralNumber";
  /** Source-preserving textual form, e.g. `"1e3"` or `"3.14"`. */
  originalString: string;
}

/**
 * Jsonnet has four lexical string kinds; `kind` encodes which one was used
 * in the source so a formatter or rule can round-trip the syntax.
 *
 * | kind | source form          |
 * |------|----------------------|
 * | 0    | `"double"`           |
 * | 1    | `'single'`           |
 * | 2    | `\|\|\| block \|\|\|` |
 * | 3    | `@"verbatim double"` |
 * | 4    | `@'verbatim single'` |
 */
export interface LiteralString extends BaseNode {
  type: "LiteralString";
  value: string;
  kind: number;
  blockIndent: string;
  blockTermIndent: string;
}

// ---------------------------------------------------------------------------
// Variables, self, super, dollar
// ---------------------------------------------------------------------------

export interface Var extends BaseNode {
  type: "Var";
  id: IdentifierName;
}

export interface Self extends BaseNode {
  type: "Self";
}

export interface Dollar extends BaseNode {
  type: "Dollar";
}

export interface SuperIndex extends BaseNode {
  type: "SuperIndex";
  index?: JsonnetNode | null;
  id?: IdentifierName | null;
}

export interface InSuper extends BaseNode {
  type: "InSuper";
  index: JsonnetNode;
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

export interface Unary extends BaseNode {
  type: "Unary";
  op: number;
  expr: JsonnetNode;
}

export interface Binary extends BaseNode {
  type: "Binary";
  op: number;
  left: JsonnetNode;
  right: JsonnetNode;
}

export interface Conditional extends BaseNode {
  type: "Conditional";
  cond: JsonnetNode;
  branchTrue: JsonnetNode;
  branchFalse?: JsonnetNode | null;
}

export interface Assert extends BaseNode {
  type: "Assert";
  cond: JsonnetNode;
  message?: JsonnetNode | null;
  rest: JsonnetNode;
}

export interface Error extends BaseNode {
  type: "Error";
  expr: JsonnetNode;
}

// ---------------------------------------------------------------------------
// Indexing and slicing
// ---------------------------------------------------------------------------

export interface Index extends BaseNode {
  type: "Index";
  target: JsonnetNode;
  index?: JsonnetNode | null;
  id?: IdentifierName | null;
}

export interface Slice extends BaseNode {
  type: "Slice";
  target: JsonnetNode;
  beginIndex?: JsonnetNode | null;
  endIndex?: JsonnetNode | null;
  step?: JsonnetNode | null;
}

// ---------------------------------------------------------------------------
// Functions, apply
// ---------------------------------------------------------------------------

export interface Parameter {
  type: "Parameter";
  name: IdentifierName;
  defaultArg?: JsonnetNode | null;
  loc?: ESLintSourceLocation;
}

export interface Function extends BaseNode {
  type: "Function";
  parameters: Parameter[];
  body: JsonnetNode;
  trailingComma: boolean;
}

export interface NamedArgument {
  name: IdentifierName;
  arg: JsonnetNode;
}

export interface Apply extends BaseNode {
  type: "Apply";
  target: JsonnetNode;
  arguments: {
    positional: { expr: JsonnetNode }[];
    named: NamedArgument[];
  };
  trailingComma: boolean;
  tailStrict: boolean;
}

export interface ApplyBrace extends BaseNode {
  type: "ApplyBrace";
  left: JsonnetNode;
  right: JsonnetNode;
}

// ---------------------------------------------------------------------------
// Local bindings
// ---------------------------------------------------------------------------

export interface LocalBind {
  variable: IdentifierName;
  body: JsonnetNode;
  fun?: Function | null;
}

export interface Local extends BaseNode {
  type: "Local";
  binds: LocalBind[];
  body: JsonnetNode;
}

// ---------------------------------------------------------------------------
// Arrays, objects, comprehensions
// ---------------------------------------------------------------------------

export interface ArrayElement {
  expr: JsonnetNode;
}

export interface Array extends BaseNode {
  type: "Array";
  elements: ArrayElement[];
  trailingComma: boolean;
}

export interface ArrayComp extends BaseNode {
  type: "ArrayComp";
  body: JsonnetNode;
  spec: ForSpec;
  trailingComma: boolean;
}

export interface ForSpec {
  varName: IdentifierName;
  expr: JsonnetNode;
  conditions: IfSpec[];
  outer?: ForSpec | null;
}

export interface IfSpec {
  expr: JsonnetNode;
}

export interface ObjectField {
  /**
   * Numeric tag from go-jsonnet's ObjectFieldKind enum:
   *
   * | kind | meaning                               |
   * |------|---------------------------------------|
   * | 0    | `assert`                              |
   * | 1    | `name:` (identifier name)             |
   * | 2    | `"name":` (string-literal name)       |
   * | 3    | `[expr]:` (computed key)              |
   * | 4    | `local x = expr`                      |
   * | 5    | `name(args)::` method                 |
   * | 6    | `"name"(args)::` string-named method  |
   * | 7    | `[expr](args)::` computed-key method  |
   */
  kind: number;
  hide: number;
  superSugar: boolean;
  id?: IdentifierName | null;
  expr1?: JsonnetNode | null;
  expr2?: JsonnetNode | null;
  expr3?: JsonnetNode | null;
  method?: Function | null;
}

export interface Object extends BaseNode {
  type: "Object";
  fields: ObjectField[];
  trailingComma: boolean;
}

export interface ObjectComp extends BaseNode {
  type: "ObjectComp";
  fields: ObjectField[];
  spec: ForSpec;
  trailingComma: boolean;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

export interface Import extends BaseNode {
  type: "Import";
  file: LiteralString;
}

export interface ImportStr extends BaseNode {
  type: "ImportStr";
  file: LiteralString;
}

export interface ImportBin extends BaseNode {
  type: "ImportBin";
  file: LiteralString;
}

// ---------------------------------------------------------------------------
// Parens
// ---------------------------------------------------------------------------

export interface Parens extends BaseNode {
  type: "Parens";
  inner: JsonnetNode;
}

// ---------------------------------------------------------------------------
// Parse error sentinel
// ---------------------------------------------------------------------------

/**
 * Inserted when go-jsonnet refuses the source. Linting can continue on a
 * file with broken syntax; rules that only look at this node type can
 * surface the parse failure as a diagnostic.
 */
export interface JsonnetParseError extends BaseNode {
  type: "JsonnetParseError";
  error: string;
  raw: string;
}

// ---------------------------------------------------------------------------
// Catch-all
// ---------------------------------------------------------------------------

/**
 * Used when go-jsonnet adds a new node type that the TypeScript surface
 * has not been updated for. Preserves the raw payload so consumers can
 * still see the contents instead of dropping the node entirely.
 */
export interface UnknownNode extends BaseNode {
  type: string;
  [key: string]: unknown;
}

export type JsonnetNode =
  | LiteralNull
  | LiteralBoolean
  | LiteralNumber
  | LiteralString
  | Var
  | Self
  | Dollar
  | SuperIndex
  | InSuper
  | Unary
  | Binary
  | Conditional
  | Assert
  | Error
  | Index
  | Slice
  | Function
  | Apply
  | ApplyBrace
  | Local
  | Array
  | ArrayComp
  | Object
  | ObjectComp
  | Import
  | ImportStr
  | ImportBin
  | Parens
  | JsonnetParseError
  | UnknownNode;
