import { describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// @ts-expect-error: a plain .mjs script with JSDoc, no declaration file
import { badMaps, missingFromDist } from "../scripts/check-dist.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) => f.split("\\").join("/"));
const srcTs = walk(join(root, "src")).filter((f) => f.endsWith(".ts"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, string | { types?: string; default?: string }> };

/** The files a complete dist holds: the entries, every export target, and a .js and a .d.ts for each source file. */
function completeList(): string[] {
  const out = new Set<string>(["dist/index.js", "dist/index.d.ts", "dist/react/index.js", "dist/react/index.d.ts"]);
  for (const v of Object.values(pkg.exports)) {
    for (const t of typeof v === "string" ? [v] : Object.values(v)) if (t.startsWith("./dist/")) out.add(t.slice(2));
  }
  for (const f of srcTs) {
    const base = f.slice(0, -3);
    out.add(`dist/${base}.js`);
    out.add(`dist/${base}.d.ts`);
  }
  return [...out].sort();
}

/** A throwaway folder inside the package (git-ignored, removed by each test) for map fixtures. */
function scratch(): string {
  return mkdtempSync(join(root, ".pack-test-"));
}
function writeMap(dir: string, name: string, map: unknown): void {
  const f = join(dir, name);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(map));
}

describe("pack", () => {
  // Spec: Kit.Client, Package: the built folder holds every file the package promises
  test("P1 missingFromDist names each missing file", () => {
    const full = completeList();
    expect(full.length).toBeGreaterThan(10);
    expect(missingFromDist(full)).toEqual([]);
    for (const gone of ["dist/index.js", "dist/index.d.ts", "dist/react/index.js", "dist/react/index.d.ts", ...full.filter((f) => f.endsWith("/store.js") || f.endsWith("/store.d.ts"))]) {
      expect(missingFromDist(full.filter((f) => f !== gone)), gone).toEqual([gone]);
    }
    // Every target of the exports map is checked, whatever the name.
    const withExtra = full.filter((f) => f !== "dist/react/index.d.ts");
    expect(missingFromDist(withExtra)).toContain("dist/react/index.d.ts");
  });

  // Spec: Kit.Client, Package: a source map carries its own source and no machine path
  test("P2 badMaps names a bad map", () => {
    const good = scratch();
    try {
      writeMap(good, "a.js.map", { version: 3, sources: ["../src/a.ts"], sourcesContent: ["export const a = 1;\n"] });
      writeMap(good, "react/b.js.map", { version: 3, sources: ["../../src/react/b.ts"], sourcesContent: ["x"] });
      expect(badMaps(good)).toEqual([]);
      const bads: Record<string, unknown> = {
        "none.js.map": { version: 3, sources: ["../src/n.ts"] },
        "short.js.map": { version: 3, sources: ["../src/a.ts", "../src/b.ts"], sourcesContent: ["only one"] },
        "nul.js.map": { version: 3, sources: ["../src/n.ts"], sourcesContent: [null] },
        "abs.js.map": { version: 3, sources: ["/var/x/src/n.ts"], sourcesContent: ["x"] },
        "users.js.map": { version: 3, sources: ["../src/n.ts", "file:///Us" + "ers/someone/n.ts"], sourcesContent: ["x", "y"] },
      };
      for (const [name, map] of Object.entries(bads)) {
        const d = scratch();
        try {
          writeMap(d, "ok.js.map", { version: 3, sources: ["../src/ok.ts"], sourcesContent: ["ok"] });
          writeMap(d, name, map);
          const r = badMaps(d) as string[];
          expect(r.length, name).toBe(1);
          expect(r[0], name).toContain(name);
        } finally {
          rmSync(d, { recursive: true, force: true });
        }
      }
    } finally {
      rmSync(good, { recursive: true, force: true });
    }
    const dist = join(root, "dist");
    if (existsSync(dist)) expect(badMaps(dist)).toEqual([]);
    else console.log("P2: no dist folder here, the built maps were not checked");
  });

  // Spec: Kit.Client, Package: the old name is gone from the shipped text
  test("P3 the old name appears nowhere", () => {
    const old = "@gilb" + "/live";
    const files = ["package.json", "README.md", "CHANGELOG.md", ...srcTs.map((f) => `src/${f}`)];
    for (const f of files) expect(readFileSync(join(root, f), "utf8").includes(old), f).toBe(false);
  });
});
