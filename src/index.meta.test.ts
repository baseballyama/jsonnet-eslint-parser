import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import parser, { meta } from "./index.ts";

describe("parser meta", () => {
  it("exposes meta.name and meta.version on both the default and named export", () => {
    expect(meta.name).toBe("jsonnet-eslint-parser");
    expect(parser.meta).toBe(meta);
    expect(typeof meta.version).toBe("string");
  });

  it("keeps meta.version in sync with package.json", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version: string;
    };
    expect(meta.version).toBe(pkg.version);
  });
});
