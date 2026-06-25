# jsonnet-eslint-parser

## 0.2.0

### Minor Changes

- [#9](https://github.com/baseballyama/jsonnet-eslint-parser/pull/9) [`46f66bb`](https://github.com/baseballyama/jsonnet-eslint-parser/commit/46f66bbb704ee70561e8c6b4595d68d61e9e0275) Thanks [@baseballyama](https://github.com/baseballyama)! - Make the AST fully traversable by ESLint.

  go-jsonnet models several child-bearing structures as plain records rather
  than nodes: an object's `fields`, a `local`'s `binds`, an array's
  `elements`, a function's `parameters`, an apply's `arguments` (with its
  `positional` / `named` lists) and a comprehension's `spec` (with its
  `conditions`). Previously these reached the ESLint shape without a `type`,
  so ESLint's traverser bailed at them and never descended into their
  children. In practice that meant a rule's visitors only fired on top-level
  nodes — anything nested inside `local x = {...}` or `[ {...} ]` (i.e. the
  bulk of a real Jsonnet file) was unreachable.

  These wrappers are now promoted to proper nodes with a `type`
  (`ObjectField`, `LocalBind`, `ArrayElement`, `Parameter`, `ApplyArguments`,
  `PositionalArgument`, `NamedArgument`, `ForSpec`, `IfSpec`) and a
  `range`/`loc` spanning their child nodes, and they are included in
  `visitorKeys`. The original metadata (`kind`, `hide`, `id`, fodder, …) is
  preserved.

  The parser also now exposes `meta` (`name` / `version`) for ESLint flat
  config; `version` is read from package.json so it never drifts.

## 0.1.0

### Minor Changes

- [`6846bab`](https://github.com/baseballyama/jsonnet-eslint-parser/commit/6846babe586f5a50f7487a7a1dfeb0720966e56d) Thanks [@baseballyama](https://github.com/baseballyama)! - Initial public release.

  ESLint custom parser for [Jsonnet](https://jsonnet.org/), powered by
  [`google/go-jsonnet`](https://github.com/google/go-jsonnet) compiled to
  WebAssembly. The prebuilt `jsonnet.wasm` plus Go's `wasm_exec.js` ship
  inside the package, so there is no Go toolchain dependency at install or
  run time.

  Highlights:

  - `parse(code)` / `parseForESLint(code)` return a raw (un-desugared)
    Jsonnet AST in the ESLint shape: `type`, `range` (UTF-16 char offsets),
    `loc` (1-indexed line, 0-indexed UTF-16 column), and stitched `parent`
    links.
  - Tokens are classified into ESLint-style `Keyword` / `Identifier` /
    `Numeric` / `String` / `Punctuator` / `Operator`.
  - Comments are surfaced as `Line` (`//`), `Hash` (`#`), and `Block`
    (`/* ... */`) nodes — so `eslint-disable` directives work in any
    Jsonnet comment form.
  - Broken input yields a `JsonnetParseError` node rather than throwing,
    so linting continues on partially-valid files.
  - `warmup()` lets a host pre-instantiate the wasm before the first
    `parseForESLint` call.

  Bundled go-jsonnet: `v0.22.0`. A weekly GitHub Actions workflow
  (`track-upstream.yml`) watches for new upstream releases and opens a
  bump PR automatically.
