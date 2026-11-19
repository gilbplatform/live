import { describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const files = (dir: string): string[] =>
  readdirSync(join(root, dir), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f));
const text = (rel: string): string => readFileSync(join(root, rel), "utf8");
const specs = (body: string): string[] => [...body.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string);

describe("the React layer's boundary", () => {
  // Spec: Kit.React, Boundary: no browser global, no raw markup, no dynamic code in src/react (check BN1)
  test("BN1 src/react names no browser global, no raw markup and no dynamic code", () => {
    const react = files("src/react");
    expect(react.length).toBeGreaterThanOrEqual(4);
    const banned = ["window", "document", "navigator", "localStorage", "indexedDB", "sessionStorage", "EventSource", "dangerouslySetInnerHTML", "eval"];
    for (const f of react) {
      const body = text(f);
      for (const word of banned) expect(body.includes(word), `${f} contains ${word}`).toBe(false);
    }
  });

  // Spec: Kit.React, Boundary: the React files import react and the core only (check BN2)
  test("BN2 src/react imports only react and relative core files", () => {
    for (const f of files("src/react")) {
      for (const s of specs(text(f))) {
        const ok = s === "react" || /^\.\/[a-z-]+\.js$/.test(s) || /^\.\.\/[a-z-]+\.js$/.test(s);
        expect(ok, `${f} imports ${s}`).toBe(true);
        if (s.startsWith("../")) expect(existsSync(join(root, "src", s.slice(3).replace(/\.js$/, ".ts"))), `${f} imports ${s}`).toBe(true);
        if (s.startsWith("./")) expect(existsSync(join(root, "src/react", s.slice(2).replace(/\.js$/, ".ts"))), `${f} imports ${s}`).toBe(true);
      }
    }
  });

  // Spec: Kit.React, Boundary: the zero-dependency core never reaches into the React files (check BN3)
  test("BN3 the core files do not import ./react", () => {
    const core = files("src").filter((f) => !f.startsWith(join("src", "react")));
    expect(core.length).toBeGreaterThan(10);
    for (const f of core) {
      for (const s of specs(text(f))) {
        expect(s.includes("react"), `${f} imports ${s}`).toBe(false);
      }
    }
  });
});
