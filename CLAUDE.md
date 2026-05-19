# CLAUDE.md

Project notes for AI agents and human contributors working on
`jsonnet-eslint-parser`.

## Project overview

`jsonnet-eslint-parser` is an ESLint custom parser for the [Jsonnet](https://jsonnet.org/)
configuration language. It is a thin ESM TypeScript wrapper around
[`google/go-jsonnet`](https://github.com/google/go-jsonnet) compiled to
WebAssembly.

The compiled wasm binary plus Go's `wasm_exec.js` runtime are shipped inside
the npm package, so consumers do not need a Go toolchain at install or run
time. The parser surface (`parse`, `parseForESLint`) is **synchronous** — the
wasm module is instantiated on first use via `new WebAssembly.Module` +
`new WebAssembly.Instance` so the call returns on the same tick, which ESLint
requires from its parser entrypoints.

## Tech stack

| Layer         | Choice                           |
| ------------- | -------------------------------- |
| Language (JS) | TypeScript, ESM, Node `>= 22`    |
| Bundler       | rolldown                         |
| Types         | `tsc` with `emitDeclarationOnly` |
| Tests         | vitest (+ fixture round-trips)   |
| Lint          | oxlint                           |
| Format        | prettier                         |
| Release       | changesets                       |
| Parser core   | go-jsonnet `v0.22.0`, `js/wasm`  |

## Repository layout

```
.
├── src/
│   ├── ast.ts            # Jsonnet node type catalogue (TypeScript)
│   ├── index.ts          # Public entry point
│   ├── normalize.ts      # wasm JSON → ESLint shape
│   ├── parse.ts          # parse / parseForESLint
│   ├── types.ts          # Token / Comment / Program / Raw* types
│   ├── visitorKeys.ts    # Dynamic visitor-keys builder
│   ├── wasm-loader.ts    # Synchronous wasm instantiation
│   └── wasm/             # Prebuilt jsonnet.wasm + wasm_exec.js (committed)
├── wasm/
│   ├── main.go           # Source of the wasm bridge (canonical copy)
│   └── build.sh          # Clones go-jsonnet, builds wasm
├── tests/
│   ├── fixtures.test.ts  # Snapshot round-trips for representative inputs
│   └── fixtures/         # input.jsonnet + expected.json pairs
└── (configs: package.json, tsconfig*.json, rolldown.config.js, …)
```

## go-jsonnet integration

`go-jsonnet` keeps both the raw parser (`SnippetToRawAST`) and the lexer
(`Lex`) inside its `internal/` directory. To call them legally, the build
script:

1. Clones go-jsonnet at the pinned version into `wasm/.cache/`.
2. Copies our `wasm/main.go` into a fresh `wasm-bridge/` subdirectory of
   the clone — this path is "inside" the upstream module so importing
   `github.com/google/go-jsonnet/internal/parser` is allowed.
3. Drops a small `external_accessor.go` file into `internal/parser` so the
   bridge can read unexported token fields (`kind`, `data`, `loc`).
4. Builds `js/wasm` and copies the resulting binary into `src/wasm/`.

If you need to bump the go-jsonnet version, update `JSONNET_GO_VERSION` in
`wasm/build.sh`, rebuild, and check the fixture snapshots for behaviour
changes.

### Automated upstream sync

`.github/workflows/track-upstream.yml` runs every Monday morning. It reads
`JSONNET_GO_VERSION` out of `wasm/build.sh`, asks the GitHub API for the
latest `google/go-jsonnet` release, and — if they differ — rebuilds the
wasm, regenerates fixtures, runs `pnpm test:all`, and opens (or refreshes)
a pull request. If the rebuild or tests fail (e.g. an upstream API change
broke `wasm/main.go`), it opens a tracking issue instead.

For the workflow to be able to open pull requests, the repository setting
**Settings → Actions → General → Workflow permissions → Allow GitHub
Actions to create and approve pull requests** must be enabled. Without it
the bump job will fail at the "Open or refresh pull request" step.

## Public API contract

> One way to do one thing.

| Capability              | Canonical path                |
| ----------------------- | ----------------------------- |
| Parse for ESLint        | `parser.parseForESLint(code)` |
| Parse to AST only       | `parser.parse(code)`          |
| Warm up the wasm module | `parser.warmup()`             |
| Access AST type defs    | `import { Ast } from ...`     |

These are the only entries documented in the README. Adding a new export
means a new commitment in the SemVer surface — only do it if the capability
is not reachable today and is in scope for this project (Jsonnet → ESLint).

## "Raw" AST policy

The parser exposes the **raw** Jsonnet AST (`SnippetToRawAST`), not the
post-desugar form. That means:

- Object literals stay as `Object`, not `DesugaredObject`.
- `local` bindings stay as `Local` + `LocalBind`, not lambda+apply rewrites.
- `[a]: b` computed-key fields stay where the user wrote them.

This is non-negotiable for an ESLint parser: rules must see what the user
typed. If you find yourself reaching for `SnippetToAST` because it is more
convenient, push back — the desugarer changes the shape of the AST in ways
that break source-fidelity lint rules.

## Position model

- `range: [number, number]` is **UTF-16 character offsets**, matching what
  ESLint and JavaScript string indexing use.
- `loc.start` / `loc.end` are `{line, column}` with 1-indexed lines and
  0-indexed UTF-16 columns.
- The conversion from go-jsonnet's UTF-8 byte coordinates happens entirely
  on the Go side. The JS normaliser does not touch positions.

When debugging position issues:

1. First check the bridge's output — `console.log(callWasmParse(...))`.
2. The Go `positions` table caches both byte and char offsets per line;
   if a column is off by one, look there first.

## Tests

- `pnpm test` runs both the unit tests in `src/*.test.ts` and the fixture
  round-trips in `tests/fixtures.test.ts`.
- Fixtures live in `tests/fixtures/<name>/input.jsonnet` + `expected.json`.
- Regenerate fixture expectations with `pnpm update-fixtures` (uses the
  `UPDATE_FIXTURES=true` env switch).

When adding a new language feature test, prefer adding a fixture: that
captures the entire AST shape so regressions in any field show up.

## Operating principles

This project inherits the engineering principles from the OSS starter
template:

- **Defensive at boundaries; trusting internally.** The wasm bridge is the
  one boundary that needs validation (parse errors → `JsonnetParseError`
  node). Inside the JS pipeline we trust the upstream shape.
- **No premature abstraction.** The normaliser is a single recursive walk;
  do not split it into a Visitor framework until there are at least two
  separate consumers.
- **Comments explain why.** The Go bridge has comments where the design is
  non-obvious (synchronous wasm init, fodder vs hand-rolled comment scan).
  Do not annotate the obvious.
- **Public API is a contract.** Every export listed above is something
  callers depend on. Renames and removals are breaking changes.

## AI-slop guardrails

Issues and PRs that strip out the templates are auto-closed by
`.github/workflows/template-compliance.yml`. If you (or the LLM helping you)
generate a PR description, re-read it and confirm it would survive a
maintainer's review before submitting.
