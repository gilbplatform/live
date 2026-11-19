import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, "..", rel), "utf8");

const CORE = "src/trace-attrs.ts";
const PART = "src/react/trace.ts";

// The words that name an application, a page, storage or an address format. None may appear in the kit's trace files,
// comments included: the kit holds no knowledge of any application.
const FORBIDDEN = ["GilbApp", "BaseRecord", "gilbplatformcode", "a7cb8cff", "/Users/", "EventSource", "indexedDB", "localStorage",
  "sessionStorage", "window", "document", "navigator", "dangerouslySetInnerHTML", "eval", "peek", "fld", "rec=", "?pf"];
const NAMES = ["data-live-entity", "data-live-field", "data-live-value"];

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("trace source files", () => {
  // Spec: Parts.Trace, Application-free: no application, storage or address-format words in the new files
  test("SC1 neither file contains a forbidden word", () => {
    for (const file of [CORE, PART]) {
      const text = read(file);
      for (const word of FORBIDDEN) expect(text.includes(word), `${file} contains "${word}"`).toBe(false);
    }
  });

  // Spec: Parts.Trace, No address of its own: the React part reads no location and builds no query string
  test("SC1b the React part reads no location and builds no query string", () => {
    const text = read(PART);
    for (const word of ["location", "URLSearchParams", "globalThis", "query", "querystring", "href=", ".search"]) {
      expect(text.includes(word), `${PART} contains "${word}"`).toBe(false);
    }
  });

  // Spec: Parts.Trace, One place: the three attribute names are spelled once, in the constant, and nowhere in the React part
  test("SC2 the attribute names appear once in the core and never in the React part", () => {
    const core = read(CORE);
    const part = read(PART);
    for (const name of NAMES) {
      // Counted with the quotes, so a longer name that merely starts with one of these is not mistaken for it.
      expect(count(core, `"${name}"`), `${CORE} ${name}`).toBe(1);
      expect(count(core, name), `${CORE} ${name} anywhere`).toBe(1);
      expect(count(part, name), `${PART} ${name}`).toBe(0);
    }
    // The shared prefix is not spelled in the React part either (no second constant under a similar name).
    expect(part.includes("data-live")).toBe(false);
    // The one place is the constant.
    expect(core).toMatch(/TRACE_ATTR\s*=\s*\{[^}]*data-live-entity[^}]*data-live-field[^}]*data-live-value[^}]*\}\s*as const/s);
  });

  // Spec: Parts.Trace, Layering: the core is pure; the React part imports only react and the core
  test("SC3 core imports nothing and names no React; the React part imports only react and ../trace-attrs.js", () => {
    const core = read(CORE);
    expect(core).not.toMatch(/\bimport\b/);
    expect(core).not.toMatch(/\brequire\s*\(/);
    expect(core.toLowerCase().includes("react")).toBe(false);
    expect(core.includes("createElement")).toBe(false);

    const part = read(PART);
    const specs = [...part.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]);
    const bare = [...part.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect([...new Set([...specs, ...bare])].sort()).toEqual(["../trace-attrs.js", "react"]);
    expect(part).not.toMatch(/\brequire\s*\(/);
    expect(part).not.toMatch(/\bimport\s*\(/);
    // The part builds elements with createElement only; there is no JSX in a .ts file.
    expect(part.includes("createElement")).toBe(true);
  });
});
