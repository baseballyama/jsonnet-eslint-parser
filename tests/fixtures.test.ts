import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseForESLint } from "../src/parse.ts";
import type { JsonnetNode, Program } from "../src/ast.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(here, "fixtures");

/**
 * Strip ESLint `parent` back-references before snapshotting. Otherwise the
 * snapshot would be cyclic and JSON.stringify would refuse to serialise it.
 */
const stripParent = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripParent);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === "parent") continue;
      out[key] = stripParent(val);
    }
    return out;
  }
  return value;
};

/** Sanity-check the ESLint shape every fixture is expected to satisfy. */
const assertProgramShape = (program: Program, code: string): void => {
  expect(program.type).toBe("Program");
  expect(program.range).toEqual([0, code.length]);
  expect(Array.isArray(program.body)).toBe(true);
  expect(Array.isArray(program.tokens)).toBe(true);
  expect(Array.isArray(program.comments)).toBe(true);

  for (const node of program.body as JsonnetNode[]) {
    expect(node.range[0]).toBeGreaterThanOrEqual(0);
    expect(node.range[1]).toBeLessThanOrEqual(code.length);
    expect(node.range[0]).toBeLessThanOrEqual(node.range[1]);
    expect(node.parent).toBe(program);
  }

  // Each token range slice must equal the token's textual value.
  for (const token of program.tokens) {
    expect(code.slice(token.range[0], token.range[1])).toBe(token.value);
  }

  // Comment ranges must also slice to their reported `value` (after the
  // delimiters, which the bridge already strips).
  for (const comment of program.comments) {
    const raw = code.slice(comment.range[0], comment.range[1]);
    if (comment.type === "Line") expect(raw.startsWith("//")).toBe(true);
    if (comment.type === "Hash") expect(raw.startsWith("#")).toBe(true);
    if (comment.type === "Block") {
      expect(raw.startsWith("/*")).toBe(true);
      // Allow unterminated block comments (we keep them around so a
      // half-written file still parses).
      if (raw.length >= 4) expect(raw.endsWith("*/")).toBe(true);
    }
  }
};

const fixtureDirs = readdirSync(FIXTURES_DIR).filter((name) => {
  const full = join(FIXTURES_DIR, name);
  return statSync(full).isDirectory();
});

const UPDATE = process.env["UPDATE_FIXTURES"] === "true";

describe("fixtures", () => {
  if (fixtureDirs.length === 0) {
    it.skip("no fixtures discovered", () => {});
    return;
  }

  for (const fixture of fixtureDirs) {
    it(`parses ${fixture}`, () => {
      const inputPath = join(FIXTURES_DIR, fixture, "input.jsonnet");
      const expectedPath = join(FIXTURES_DIR, fixture, "expected.json");
      const code = readFileSync(inputPath, "utf8");
      const { ast } = parseForESLint(code);

      assertProgramShape(ast, code);

      const serialised = JSON.stringify(stripParent(ast), null, 2) + "\n";

      if (UPDATE) {
        writeFileSync(expectedPath, serialised, "utf8");
        return;
      }
      const expected = readFileSync(expectedPath, "utf8");
      expect(serialised).toBe(expected);
    });
  }
});
