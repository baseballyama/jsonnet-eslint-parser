import { describe, expect, it } from "vitest";
import { parse, parseForESLint } from "./parse.ts";
import type { JsonnetNode } from "./ast.ts";

/**
 * Walk an AST and return the first node of the given type, or null if
 * none is found. The walker skips ESLint `parent` back-references so
 * traversal does not get stuck in a cycle.
 */
const findFirst = (
  root: unknown,
  type: string,
): Record<string, unknown> | null => {
  const visit = (node: unknown): Record<string, unknown> | null => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (obj["type"] === type) return obj;
      for (const [key, value] of Object.entries(obj)) {
        if (key === "parent" || key === "loc" || key === "range") continue;
        const found = visit(value);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(root);
};

const requireFirst = (root: unknown, type: string): Record<string, unknown> => {
  const node = findFirst(root, type);
  if (!node) throw new Error(`Could not find a ${type} node`);
  return node;
};

describe("parse / parseForESLint - smoke", () => {
  it("parses an empty object literal", () => {
    const { ast } = parseForESLint("{}");
    expect(ast.type).toBe("Program");
    expect(ast.body).toHaveLength(1);
    expect(ast.body[0]?.type).toBe("Object");
  });

  it("parse() returns just the AST", () => {
    const program = parse("null");
    expect(program.type).toBe("Program");
    expect(program.body[0]?.type).toBe("LiteralNull");
  });

  it("attaches parent links from each top-level node to the Program", () => {
    const { ast } = parseForESLint("{a: 1}");
    const first = ast.body[0];
    expect(first).toBeDefined();
    expect((first as JsonnetNode).parent).toBe(ast);
  });

  it("attaches parent links across nested nodes", () => {
    const { ast } = parseForESLint("{a: {b: 1}}");
    const outer = requireFirst(ast.body, "Object");
    const inner = findFirst(outer["fields"], "Object");
    expect(inner).toBeTruthy();
    expect(inner?.["parent"]).toBeTruthy();
  });

  it("supplies a Jsonnet-only services flag", () => {
    const { services } = parseForESLint("1");
    expect(services).toEqual({ isJsonnetParser: true });
  });
});

describe("parseForESLint - location accuracy", () => {
  it("reports 1-indexed lines and 0-indexed columns", () => {
    const { ast } = parseForESLint("\n  42");
    const num = requireFirst(ast.body, "LiteralNumber");
    expect(num["loc"]).toEqual({
      start: { line: 2, column: 2 },
      end: { line: 2, column: 4 },
    });
    expect(num["range"]).toEqual([3, 5]);
  });

  it("does not push locations onto wrong lines after multi-byte comments", () => {
    const code = ["// これはコメントです", "// もうひとつ", "42"].join("\n");
    const { ast } = parseForESLint(code);
    const num = requireFirst(ast.body, "LiteralNumber");
    expect((num["loc"] as { start: { line: number } }).start.line).toBe(3);
  });

  it("handles surrogate pairs (emoji) in source positions", () => {
    const code = "// 😀\n1";
    const { ast } = parseForESLint(code);
    const num = requireFirst(ast.body, "LiteralNumber");
    // '😀' is two UTF-16 code units. The comment is 5 UTF-16 code units +
    // the leading "// " makes 6; line 2 begins after the newline. The
    // literal `1` lives at column 0 on line 2.
    expect(
      (num["loc"] as { start: { line: number; column: number } }).start,
    ).toEqual({ line: 2, column: 0 });
  });
});

describe("parseForESLint - token classification", () => {
  const tokenValuesByType = (code: string): Record<string, string[]> => {
    const { ast } = parseForESLint(code);
    const grouped: Record<string, string[]> = {};
    for (const token of ast.tokens) {
      (grouped[token.type] ??= []).push(token.value);
    }
    return grouped;
  };

  it("classifies keywords, identifiers, numerics, and punctuators", () => {
    const tokens = tokenValuesByType("local x = 1; x");
    expect(tokens["Keyword"]).toEqual(["local"]);
    expect(tokens["Identifier"]).toEqual(["x", "x"]);
    expect(tokens["Numeric"]).toEqual(["1"]);
    expect(tokens["Punctuator"]).toContain(";");
  });

  it("classifies single- and double-quoted strings as String", () => {
    const tokens = tokenValuesByType(`["a", 'b']`);
    expect(tokens["String"]).toEqual([`"a"`, `'b'`]);
  });

  it("classifies block (triple-pipe) strings as String", () => {
    const code = "local x = |||\n  hello\n|||; x";
    const tokens = tokenValuesByType(code);
    expect(tokens["String"]).toHaveLength(1);
    expect(tokens["String"]?.[0]).toContain("hello");
  });
});

describe("parseForESLint - comment extraction", () => {
  it("captures line, hash, and block comments with correct types", () => {
    const code = ["// line", "# hash", "/* block */", "1"].join("\n");
    const { ast } = parseForESLint(code);
    const byType = Object.fromEntries(
      ast.comments.map((c) => [c.type, c.value]),
    );
    expect(byType["Line"]).toBe(" line");
    expect(byType["Hash"]).toBe(" hash");
    expect(byType["Block"]).toBe(" block ");
  });

  it("ignores `//` inside string literals", () => {
    const { ast } = parseForESLint(`"// not a comment"`);
    expect(ast.comments).toEqual([]);
  });

  it("ignores `#` inside string literals", () => {
    const { ast } = parseForESLint(`"# not a comment"`);
    expect(ast.comments).toEqual([]);
  });

  it("computes comment ranges in absolute character offsets", () => {
    const code = "// hi\n1";
    const { ast } = parseForESLint(code);
    expect(ast.comments[0]?.range).toEqual([0, 5]);
  });
});

describe("parseForESLint - syntax errors", () => {
  it("returns a JsonnetParseError node for broken input rather than throwing", () => {
    const { ast } = parseForESLint("{a:");
    expect(ast.body).toHaveLength(1);
    expect(ast.body[0]?.type).toBe("JsonnetParseError");
  });

  it("preserves tokens and comments even when the parser fails", () => {
    const { ast } = parseForESLint("// pre-comment\n{a:");
    expect(ast.tokens.length).toBeGreaterThan(0);
    expect(ast.comments).toHaveLength(1);
    expect(ast.comments[0]?.value).toBe(" pre-comment");
  });
});

describe("parseForESLint - visitor keys", () => {
  it("includes the canonical Program → body/tokens/comments mapping", () => {
    const { visitorKeys } = parseForESLint("1");
    expect(visitorKeys["Program"]).toEqual(["body", "tokens", "comments"]);
  });

  it("includes JsonnetParseError so ESLint can walk it without warnings", () => {
    const { visitorKeys } = parseForESLint("{");
    expect(visitorKeys["JsonnetParseError"]).toEqual([]);
  });

  it("does not surface token kinds (e.g. Identifier) as AST node types", () => {
    const { visitorKeys } = parseForESLint("local x = 1; x");
    expect(visitorKeys["Identifier"]).toBeUndefined();
    expect(visitorKeys["Keyword"]).toBeUndefined();
    expect(visitorKeys["Local"]).toBeDefined();
  });

  it("discovers child fields dynamically from the AST", () => {
    const { visitorKeys } = parseForESLint("if true then 1 else 2");
    expect(visitorKeys["Conditional"]).toContain("cond");
    expect(visitorKeys["Conditional"]).toContain("branchTrue");
    expect(visitorKeys["Conditional"]).toContain("branchFalse");
  });
});

describe("parseForESLint - raw AST shape", () => {
  it("keeps `Object` (not desugared) as the node type for object literals", () => {
    const { ast } = parseForESLint("{a: 1}");
    const obj = ast.body[0];
    expect(obj?.type).toBe("Object");
    // The desugarer would have rewritten this to DesugaredObject. We
    // intentionally use the raw parser so source-faithful linting works.
    expect(obj?.type).not.toBe("DesugaredObject");
  });

  it("preserves Local bindings as Local + LocalBind, not desugared", () => {
    const { ast } = parseForESLint("local x = 1; x");
    expect(ast.body[0]?.type).toBe("Local");
    const local = ast.body[0] as { binds?: { variable?: string }[] };
    expect(local.binds?.[0]?.variable).toBe("x");
  });

  it("preserves Conditional with optional `branchFalse` only when present", () => {
    const { ast } = parseForESLint("if true then 1 else 2");
    const cond = ast.body[0] as { branchFalse?: unknown };
    expect(cond.branchFalse).toBeTruthy();
  });
});
