# jsonnet-eslint-parser

A Jsonnet parser for ESLint, powered by [`google/go-jsonnet`](https://github.com/google/go-jsonnet) compiled to WebAssembly.

It exposes an ESTree-style AST so that ESLint can lint `.jsonnet` and `.libsonnet` files, including `eslint-disable` directives written as Jsonnet comments. The Go side does the heavy lifting (parsing, tokenisation, UTF-16 column conversion) so the JS surface is a thin synchronous adapter that ESLint can load via `languageOptions.parser`.

## Requirements

- Node.js `>= 22`
- ESM-only package (`"type": "module"`)

## Installation

```bash
npm install jsonnet-eslint-parser
# or
pnpm add jsonnet-eslint-parser
# or
yarn add jsonnet-eslint-parser
```

The package ships the prebuilt `jsonnet.wasm` binary and Go's runtime loader, so there is **no Go toolchain dependency at install or run time**.

## Usage

```javascript
import parser from "jsonnet-eslint-parser";

// Parse Jsonnet source
const program = parser.parse("{ a: 1 }");

// Parse for ESLint (includes visitor keys)
const { ast, visitorKeys, scopeManager } = parser.parseForESLint(
  "local x = 1; { value: x }",
);
```

Named exports are also available:

```javascript
import { parse, parseForESLint, Ast, warmup } from "jsonnet-eslint-parser";

const program = parse("{ a: 1 }");
// `Ast` is a namespace re-export of every AST type definition (useful
// when writing custom ESLint rules in TypeScript).
// `warmup()` synchronously initialises the wasm module — call it once
// during linter start-up to avoid paying the cold-start cost on the
// first file.
```

## ESLint integration

### Flat config (`eslint.config.js`)

```javascript
import jsonnetParser from "jsonnet-eslint-parser";

export default [
  {
    files: ["**/*.jsonnet", "**/*.libsonnet"],
    languageOptions: {
      parser: jsonnetParser,
    },
    rules: {
      // Jsonnet-specific rules here.
    },
  },
];
```

### ESLint directives in Jsonnet comments

`eslint-disable` style directives written as Jsonnet comments are honoured. The parser populates the AST `comments` array from every Jsonnet comment form:

```jsonnet
// eslint-disable-next-line no-magic-numbers
local answer = 42;

/* eslint-disable some-rule */
local x = 1;
/* eslint-enable some-rule */

# eslint-disable-next-line some-rule
local y = 2;
```

| Jsonnet comment | ESLint comment node                                          |
| --------------- | ------------------------------------------------------------ |
| `// ...`        | `{ type: "Line",  value: "..." }` (without the leading `//`) |
| `# ...`         | `{ type: "Hash",  value: "..." }` (without the leading `#`)  |
| `/* ... */`     | `{ type: "Block", value: "..." }` (without the `/*` / `*/`)  |

Note that the `Hash` comment type is parser-specific because Jsonnet supports `#` comments natively. Rules that walk `comments` should treat it equivalently to `Line`.

## Token classification

The parser emits ESLint-shaped tokens with these `type` values:

| `type`       | Examples                                                  |
| ------------ | --------------------------------------------------------- |
| `Keyword`    | `local`, `if`, `then`, `else`, `import`                   |
| `Identifier` | `foo`, `_bar`, `x1`                                       |
| `Numeric`    | `1`, `3.14`, `1e3`                                        |
| `String`     | `"abc"`, `'abc'`, `\|\|\|...\|\|\|`                       |
| `Punctuator` | `{`, `}`, `[`, `]`, `(`, `)`, `,`, `;`, `.`               |
| `Operator`   | `+`, `-`, `*`, `/`, `==`, `!=`, `&&`, `\|\|`, `::`, `:::` |

Each token carries a UTF-16 `range` and an ESLint-style `loc` (`{line, column}` with 1-indexed lines and 0-indexed columns).

## AST

The AST mirrors `google/go-jsonnet`'s `ast` package. Each node has:

- `type` — the Go type name (`Object`, `Local`, `Conditional`, …).
- `range: [number, number]` — UTF-16 character offsets.
- `loc: { start, end }` — `{line, column}` with 1-indexed lines and 0-indexed UTF-16 columns.
- `parent` — back-reference to the enclosing node, attached by the parser.

The full type catalogue lives in [`src/ast.ts`](./src/ast.ts) and is re-exported as the `Ast` namespace from the entry point.

### Raw vs desugared

The parser surfaces the **raw** AST, not the post-desugar form. That means object literals stay as `Object` (not `DesugaredObject`), `local` bindings stay as `Local` + `LocalBind`, and so on. Source-faithful linting is the design goal — rule authors should see what the user wrote.

### Wrapper nodes

go-jsonnet models several child-bearing structures as plain records rather than nodes. To keep the tree fully traversable by ESLint (whose traverser stops at any value without a string `type`), the parser promotes each of them to a real node with a `type`, a `range`/`loc` spanning its children, and an entry in `visitorKeys`:

| Wrapper node         | Sits under                                             | Carries                                         |
| -------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| `ObjectField`        | `Object.fields` / `ObjectComp.fields`                  | `kind`, `hide`, `id`, `expr1`–`expr3`, `method` |
| `LocalBind`          | `Local.binds`                                          | `variable`, `body`, `fun`                       |
| `ArrayElement`       | `Array.elements`                                       | `expr`                                          |
| `Parameter`          | `Function.parameters`                                  | `name`, `defaultArg`                            |
| `ApplyArguments`     | `Apply.arguments`                                      | `positional`, `named`                           |
| `PositionalArgument` | `ApplyArguments.positional`                            | `expr`                                          |
| `NamedArgument`      | `ApplyArguments.named`                                 | `name`, `arg`                                   |
| `ForSpec`            | `ArrayComp.spec` / `ObjectComp.spec` / `ForSpec.outer` | `varName`, `expr`, `conditions`, `outer`        |
| `IfSpec`             | `ForSpec.conditions`                                   | `expr`                                          |

The original metadata is preserved untouched — promotion only adds `type`/`range`/`loc`. A `Parameter` without a default argument and an `ApplyArguments` with no arguments span no child node, so their `range`/`loc` are absent.

### Parse errors

When go-jsonnet refuses the source, the parser still returns a `Program` with a single `JsonnetParseError` node in `body`. Tokens and comments scanned before the failure are preserved, so ESLint rules that work off the token stream still run on broken files. The `error` field carries the diagnostic.

## How it works

The package wraps [`google/go-jsonnet`](https://github.com/google/go-jsonnet) at version v0.22.0. The build script (`wasm/build.sh`) clones go-jsonnet, drops a bridge `main.go` into the upstream module so it can reach the `internal/parser` package, and compiles the result to `js/wasm`. The compiled binary plus Go's `wasm_exec.js` ship in the published package.

At parse time the JS side reads the wasm binary, instantiates it synchronously, and calls a single registered function:

```
jsonnet_parse(filename: string, code: string) -> string  // JSON
```

The Go side handles parsing, tokenisation, comment extraction, UTF-8/UTF-16 byte-to-character conversion, and ESLint-style location resolution. The JS side normalises the JSON tree (renames `nodeType` to `type`, stitches `parent` links, computes visitor keys) and returns the result.

## Building from source

If you want to rebuild the wasm binary yourself, you need Go (1.24+).

```bash
pnpm build:wasm   # clones go-jsonnet, builds wasm/jsonnet.wasm
pnpm build        # JS + TS declarations + copy wasm into dist/
```

`pnpm test` does **not** rebuild the wasm — it uses whatever is checked in under `src/wasm/`.

## License

[MIT](./LICENSE)
