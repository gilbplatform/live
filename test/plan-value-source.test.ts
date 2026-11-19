import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const FILES = ["src/plan-value-model.ts", "src/react/plan-value.ts"];
const text = (rel: string): string => readFileSync(join(root, rel), "utf8");

// Comments removed, so that what is left is code and string literals only.
const withoutComments = (body: string): string => body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
// The path in an import line is never shown to anyone (the dot's file name is fixed), so import lines are left out.
const withoutImports = (body: string): string => body.replace(/^\s*import\s[^;]*;/gm, "");
const literals = (body: string): string[] => [...withoutImports(withoutComments(body)).matchAll(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g)].map((m) => m[0]);
const specs = (body: string): string[] => [...body.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string);

describe("the plan value source files", () => {
  // Spec: Parts.PlanValues, Boundary: no app name, no browser global, no storage, no dynamic code in the new files (check SC1)
  test("SC1 neither file holds a forbidden string, comments included", () => {
    const banned = [
      "GilbApp", "BaseRecord", "data-live-", "gilbplatformcode", "a7cb8cff", "/Users/", "EventSource", "indexedDB", "localStorage",
      "sessionStorage", "window", "document", "navigator", "dangerouslySetInnerHTML", "eval",
    ];
    for (const f of FILES) {
      const body = text(f);
      expect(body.length, f).toBeGreaterThan(200);
      for (const word of banned) expect(body.includes(word), `${f} contains ${word}`).toBe(false);
    }
  });

  // Spec: Parts.PlanValues, Words: no string a person could receive holds the word live (check SC2)
  test("SC2 no string literal matches live in either file", () => {
    for (const f of FILES) {
      const lits = literals(text(f));
      expect(lits.length, f).toBeGreaterThan(5);
      for (const l of lits) expect(/live/i.test(l), `${f}: ${l}`).toBe(false);
    }
  });

  // Spec: Parts.PlanValues, Boundary: the model imports nothing; the React file imports three things only (check SC3)
  test("SC3 the model imports nothing and the React file imports react, the model and the dot", () => {
    const model = text("src/plan-value-model.ts");
    expect(specs(model)).toEqual([]);
    expect(/^\s*(import|export)\s[^;]*\sfrom\s/m.test(model)).toBe(false);
    expect(/\brequire\s*\(|\bimport\s*\(/.test(model)).toBe(false);
    const got = [...new Set(specs(text("src/react/plan-value.ts")))].sort();
    expect(got).toEqual(["../plan-value-model.js", "./live-dot.js", "react"]);
  });

  // Spec: Parts.PlanValues, Boundary: the core model is free of React (check SC4)
  test("SC4 the model holds neither react nor createElement", () => {
    const model = text("src/plan-value-model.ts");
    expect(model.includes("react")).toBe(false);
    expect(model.includes("createElement")).toBe(false);
  });
});
