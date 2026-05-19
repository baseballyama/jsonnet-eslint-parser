import { defineConfig } from "rolldown";

export default defineConfig({
  input: {
    index: "src/index.ts",
  },
  output: {
    dir: "dist",
    format: "esm",
    entryFileNames: "[name].js",
    sourcemap: true,
  },
  platform: "node",
  // The wasm and Go runtime loader are read at runtime via fs.readFileSync;
  // they should ship to `dist/wasm/` as plain files rather than be inlined
  // into the JS bundle.
  external: ["node:fs", "node:path", "node:url"],
});
