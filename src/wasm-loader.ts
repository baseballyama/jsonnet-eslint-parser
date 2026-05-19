import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Initialise the go-jsonnet WebAssembly bridge.
 *
 * The Go binary registers a global `jsonnet_parse(filename, code)` function
 * while its `main` goroutine runs. We instantiate the module synchronously
 * (so the returned parse function is usable on the same tick) by:
 *
 *   1. Reading both `jsonnet.wasm` and `wasm_exec.js` off disk.
 *   2. Evaluating `wasm_exec.js` in a private global context so it does not
 *      pollute the caller's environment.
 *   3. Constructing a `WebAssembly.Module` + `WebAssembly.Instance` from
 *      the buffer — both calls are synchronous.
 *   4. Calling `go.run(instance)`. The internal body runs synchronously up
 *      to the first `await`; by the time that happens our Go `main` has
 *      already registered `jsonnet_parse` on the host object.
 *
 * The returned function passes through to that registered global. We keep
 * a strong reference to `go` so the runtime is not garbage-collected
 * between calls.
 */

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run: (instance: WebAssembly.Instance) => Promise<void>;
}

interface WasmHost {
  Go: new () => GoRuntime;
  jsonnet_parse?: (filename: string, code: string) => string;
}

const here = dirname(fileURLToPath(import.meta.url));

// In production these live next to the bundled JS in `dist/wasm/`. During
// development (`src/index.ts` → `src/wasm/*`) the same relative path works
// because both layouts keep `wasm/` as a sibling of the consuming module.
const WASM_DIR = join(here, "wasm");
const WASM_PATH = join(WASM_DIR, "jsonnet.wasm");
const WASM_EXEC_PATH = join(WASM_DIR, "wasm_exec.js");

let cachedParse: ((filename: string, code: string) => string) | null = null;
// Hold strong references so the GC does not reclaim the Go runtime or the
// wasm instance between parser invocations. The variable is intentionally
// read once at initialisation only — keeping it alive is the entire point.
const cachedRuntimeRef: {
  go: GoRuntime | null;
  instance: WebAssembly.Instance | null;
} = { go: null, instance: null };

const evaluateWasmExec = (): WasmHost => {
  // wasm_exec.js is shipped by the Go toolchain as a classic script that
  // expects to run against the host globalThis: it reads `crypto`,
  // `performance`, `TextEncoder`, etc., and writes `Go` back onto it.
  // Running it in a proxy global trips Node's `this` checks on getters
  // like `crypto`, so we evaluate it on the real globalThis. Running it
  // multiple times is idempotent — subsequent calls only re-assign `Go`.
  const host = globalThis as unknown as WasmHost;
  if (typeof host.Go !== "function") {
    const source = readFileSync(WASM_EXEC_PATH, "utf8");
    const exec = new Function(source);
    exec();
  }
  if (typeof host.Go !== "function") {
    throw new Error(
      "jsonnet-eslint-parser: wasm_exec.js did not define globalThis.Go",
    );
  }
  return host;
};

const ensureInitialised = (): ((filename: string, code: string) => string) => {
  if (cachedParse) return cachedParse;

  const host = evaluateWasmExec();
  const go = new host.Go();
  const buffer = readFileSync(WASM_PATH);
  // `new WebAssembly.Module` is synchronous; `WebAssembly.instantiate` is
  // not. We need the synchronous path because ESLint loads parsers
  // synchronously and `parseForESLint` must return on the same tick.
  const wasmModule = new WebAssembly.Module(buffer);
  const instance = new WebAssembly.Instance(wasmModule, go.importObject);

  // `go.run` is async; its body runs synchronously until the first internal
  // `await`. The Go `main` registers `jsonnet_parse` before reaching that
  // point. We ignore the returned promise on purpose — it resolves when the
  // Go program exits, which it never does in our bridge.
  void go.run(instance);

  const fn = host.jsonnet_parse;
  if (typeof fn !== "function") {
    throw new Error(
      "jsonnet-eslint-parser: jsonnet_parse was not registered by the wasm module",
    );
  }
  cachedParse = fn;
  cachedRuntimeRef.go = go;
  cachedRuntimeRef.instance = instance;
  return fn;
};

/**
 * Call the wasm bridge. The returned string is a JSON-encoded
 * {@link import("./types.ts").RawParseResult}.
 */
export const callWasmParse = (filename: string, code: string): string => {
  const fn = ensureInitialised();
  return fn(filename, code);
};

/** Force initialisation — useful for warming up before linting starts. */
export const warmup = (): void => {
  ensureInitialised();
};
