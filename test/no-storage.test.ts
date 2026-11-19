import { describe, expect, test } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const srcFiles = (): string[] => readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
const text = (f: string): string => readFileSync(join(root, "src", f), "utf8");

describe("the kit opens no storage and names no browser global", () => {
  // Spec: Kit.Client, Contract: the kit opens no storage; the app owns it (check Package.Independent)
  test("NS1 no source file names a storage or browser global", () => {
    const files = srcFiles();
    for (const must of ["store.ts", "coalescer.ts", "confirm.ts", "state-cache.ts", "session.ts"]) expect(files, must).toContain(must);
    const banned = ["indexedDB", "localStorage", "sessionStorage", "caches.", "window", "document", "navigator", "IDBDatabase", "EventSource"];
    for (const f of files) {
      const body = text(f);
      for (const word of banned) expect(body.includes(word), `${f} contains ${word}`).toBe(false);
    }
  });

  // Spec: Kit.Client, Contract: the new modules import only their neighbours in src (check Package.Independent)
  test("NS2 the new modules import nothing outside packages/live/src", () => {
    for (const f of ["coalescer.ts", "confirm.ts", "state-cache.ts", "session.ts"]) {
      const body = text(f);
      const specs = [...body.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1] as string);
      for (const s of specs) {
        expect(/^\.\/[a-z-]+\.js$/.test(s), `${f} imports ${s}`).toBe(true);
        expect(srcFiles(), `${f} imports ${s}`).toContain(s.slice(2).replace(/\.js$/, ".ts"));
      }
      expect(body.includes("require("), f).toBe(false);
    }
    // The session is structural: it must not import the transport.
    expect(text("session.ts").includes("transport.js")).toBe(false);
  });
});
