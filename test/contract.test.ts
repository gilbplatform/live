import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createLiveStore } from "../src/index.js";
import type { LiveChange, LiveNotification, LiveStore } from "../src/index.js";
import { applyChange } from "./helpers/applyChange.js";

interface Rec {
  entityUri: string;
  v: string;
}

const CURSOR = "c".repeat(43);
const ent = (name: string): string => `https://vault.example/e/${name}`;
const T0 = Date.UTC(2026, 10, 19, 10, 0, 0);
const t = (ms: number): string => new Date(T0 + ms).toISOString();
const n = (name: string, ms: number, etag: string | null, kind: "change" | "ended" = "change"): LiveNotification => ({
  kind,
  entity: ent(name),
  typeUri: "https://vault.example/t/Value",
  etag,
  updatedAt: t(ms),
  receivedAt: t(ms),
  cursor: CURSOR,
});

// The vault the reader answers from, with a per-entity answer delay so that answers settle out of order.
let db = new Map<string, { v: string; etag: string } | null>();
const delay: Record<string, number> = { A: 30, B: 20, C: 10, D: 40, E: 5 };
let store: LiveStore<Rec> | undefined;
let changes: LiveChange<Rec>[] = [];
let mirror: Rec[] = [];

function make(now?: () => number): LiveStore<Rec> {
  db = new Map();
  changes = [];
  mirror = [];
  const s = createLiveStore<Rec>({
    holdMs: 250,
    now,
    read: ({ entity }) =>
      new Promise((resolve) => {
        const name = entity.slice(ent("").length);
        setTimeout(() => {
          const row = db.get(name);
          resolve(row ? { record: { entityUri: entity, v: row.v }, etag: row.etag } : null);
        }, delay[name] ?? 0);
      }),
  });
  s.subscribe((c) => {
    changes.push(c);
    mirror = applyChange(mirror, c);
  });
  store = s;
  return s;
}
const set = (name: string, v: string): void => { db.set(name, { v, etag: v }); };
const parity = (label: string): void => {
  expect(mirror.map((r) => r.entityUri), label).toEqual(store?.all().map((r) => r.entity));
  expect(mirror, label).toEqual(store?.all().map((r) => r.record));
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { store?.close(); store = undefined; vi.useRealTimers(); });

describe("contract with the dashboard adapter", () => {
  // Spec: Kit.Client, Contract: every change has exactly the adapter's four keys (LiveWire step, check Delivery.Shape)
  test("C1 every emitted change has exactly full, records, ended, at", async () => {
    const s = make(() => 12345);
    set("A", "a1");
    s.seed([]);
    s.push(n("A", 1, "a1"));
    await vi.advanceTimersByTimeAsync(300);
    s.push(n("A", 2, null, "ended"));
    await vi.advanceTimersByTimeAsync(300);
    expect(changes.length).toBeGreaterThanOrEqual(3);
    for (const c of changes) {
      expect(Object.keys(c).sort()).toEqual(["at", "ended", "full", "records"]);
      expect(typeof c.at).toBe("number");
      expect(c.at).toBe(12345);
    }
  });

  // Spec: Kit.Client, Contract: the held order is the adapter's order (check Delivery.Order)
  test("C2 order parity with the mirror applyChange after every step", async () => {
    const s = make();
    const go = async (label: string, act: () => void): Promise<void> => {
      act();
      await vi.advanceTimersByTimeAsync(400);
      parity(label);
    };
    set("A", "a1"); set("B", "b1"); set("C", "c1");
    await go("burst of three, answers settle in reverse", () => {
      s.push(n("A", 1, "a1")); s.push(n("B", 2, "b1")); s.push(n("C", 3, "c1"));
    });
    expect(mirror.map((r) => r.v)).toEqual(["a1", "b1", "c1"]);
    set("B", "b2");
    await go("change in place", () => s.push(n("B", 4, "b2")));
    await go("ended", () => s.push(n("C", 5, null, "ended")));
    set("D", "d1"); set("E", "e1");
    await go("two new, slow then fast", () => { s.push(n("D", 6, "d1")); s.push(n("E", 7, "e1")); });
    expect(mirror.map((r) => r.v)).toEqual(["a1", "b2", "d1", "e1"]);
    s.seed([
      { entity: ent("X"), typeUri: "t", etag: "x1", record: { entityUri: ent("X"), v: "x1" } },
      { entity: ent("Y"), typeUri: "t", etag: "y1", record: { entityUri: ent("Y"), v: "y1" } },
    ]);
    parity("seed");
    await go("ended X", () => s.push(n("X", 10, null, "ended")));
    set("X", "x2");
    await go("revive X goes to the end", () => s.push(n("X", 11, "x2")));
    expect(mirror.map((r) => r.v)).toEqual(["y1", "x2"]);
    db.set("Y", null);
    await go("vanished Y", () => s.push(n("Y", 12, "y2")));
    expect(mirror.map((r) => r.v)).toEqual(["x2"]);
  });

  // Spec: Kit.Client, Contract: addresses are the full IRIs the notification carried (check Delivery.Shape)
  test("C3 the entity is the full IRI and ended holds the same strings", async () => {
    const s = make();
    set("A", "a1");
    s.push(n("A", 1, "a1"));
    await vi.advanceTimersByTimeAsync(300);
    expect(s.all().map((r) => r.entity)).toEqual(["https://vault.example/e/A"]);
    s.push(n("A", 2, null, "ended"));
    await vi.advanceTimersByTimeAsync(300);
    expect(changes.flatMap((c) => c.ended)).toEqual(["https://vault.example/e/A"]);
  });

  const root = fileURLToPath(new URL("../", import.meta.url));
  // Every source text with its file name, and the one exemption: from L16 on, the trace contract lives in a single constant in
  // src/trace-attrs.ts, so the attribute names may appear there and nowhere else. The constant is cut out before the check,
  // so a second spelling in the same file is still refused.
  const TRACE_CONSTANT = /export const TRACE_ATTR = \{[^}]*\} as const;/;
  const srcChecked = (): Array<{ file: string; text: string }> =>
    readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts"))
      .map((f) => ({ file: f, text: readFileSync(join(root, "src", f), "utf8") }))
      .concat([{ file: "README.md", text: readFileSync(join(root, "README.md"), "utf8") }])
      .map(({ file, text }) => ({ file, text: file === "trace-attrs.ts" ? text.replace(TRACE_CONSTANT, "") : text }));

  // Spec: Kit.Client, Contract: the package knows nothing of any one app (check Package.Independent)
  test("C4 no app code in the package", () => {
    for (const { file, text } of srcChecked()) {
      for (const word of ["GilbApp", "BaseRecord", "data-live-", "gilbplatformcode", "a7cb8cff", "/Users/", "EventSource"]) {
        expect(text.includes(word), `${file}: ${word}`).toBe(false);
      }
    }
  });

  // Spec: Kit.Client, Contract: the trace attribute names are in one constant in src/trace-attrs.ts and nowhere else (check Package.Independent)
  test("C5 the trace attributes are only in the one constant", () => {
    const files = readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const raw = readFileSync(join(root, "src", f), "utf8");
      const text = f === "trace-attrs.ts" ? raw.replace(TRACE_CONSTANT, "") : raw;
      for (const word of ["data-live-entity", "data-live-field", "data-live-value"]) expect(text.includes(word), `${f}: ${word}`).toBe(false);
    }
  });
});
