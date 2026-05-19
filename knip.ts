import type { KnipConfig } from "knip/dist";

const config = {
  workspaces: {
    ".": {
      project: ["src/**/*.{js,ts}", "tests/**/*.{js,ts}"],
      oxlint: {},
      vitest: {},
      ignore: ["src/wasm/wasm_exec.js"],
    },
  },
} as const satisfies KnipConfig;

export default config;
