# jsonnet-eslint-parser

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
