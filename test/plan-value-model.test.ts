import { describe, expect, test } from "vitest";
import {
  buildPlanValueRow, planValueDrawable, planValueWords, planValueSentence,
  NO_LIMITS_TEXT, LIMITS_ORDER_TEXT, NOT_SET_TEXT, UNNAMED_TEXT, CHECK_FAILED_TEXT, NO_STATUS_TEXT, CANNOT_DRAW_TEXT,
} from "../src/plan-value-model.js";
import type { PlanValueInput, PlanValueRowLike, PlanLevelInput } from "../src/plan-value-model.js";
import {
  rowOf, MIRROR_NO_LIMITS_TEXT, MIRROR_LIMITS_ORDER_TEXT, MIRROR_NOT_SET_TEXT, MIRROR_UNNAMED_TEXT,
} from "./helpers/valueStripMirror.js";
import type { MirrorLevel, MirrorReadValue, MirrorRow } from "./helpers/valueStripMirror.js";

// A small seeded generator, so a failure can be repeated exactly.
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const level = (text: string | null, value: number | null, extra: Partial<PlanLevelInput> = {}): PlanLevelInput => ({ text, value, ...extra });
const input = (over: Partial<PlanValueInput> = {}): PlanValueInput => ({
  id: "v1", name: "Cost", entityUri: "urn:v1",
  scale: { unit: "euro", direction: "higher" },
  status: level("62", 62), tolerable: level("50", 50), goal: level("90", 90), ...over,
});
const good = (over: Partial<PlanValueInput> = {}): PlanValueRowLike => buildPlanValueRow(input(over));

describe("buildPlanValueRow: parity with the app's value strip", () => {
  // Spec: Parts.PlanValues, Parity: the kit's builder gives the same rows as the app's strip, so the swap changes nothing (check M1)
  test("M1 500 seeded inputs give rows equal to the mirror of the app's strip", () => {
    const rnd = seeded(20261119);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const values = [0, 1, 5, 5, 10, 50, 62, 90, 100, -3.5, 0.1, 0.2, 1234.5678];
    const names: (string | null)[] = ["Cost", "  Padded  ", "", "   ", null, "Quality", "x".repeat(40)];
    const units = ["euro", "", "%", "ms"];
    const dirs = ["lower", "higher", "target"] as const;
    // One case in six forces one shared number on all three levels, so equal values are certain to be met.
    let shared: number | null = null;
    const makeLevel = (n: number): { a: PlanLevelInput | null; m: MirrorLevel | null } => {
      const kind = rnd();
      if (shared !== null) return { a: { text: `s${n}`, value: shared, qualified: false, ref: null }, m: { text: `s${n}`, value: shared, qualified: false, ref: null } };
      if (kind < 0.2) return { a: null, m: null };
      const hasText = rnd() > 0.15;
      const text = hasText ? `t${n}-${Math.floor(rnd() * 1000)}` : null;
      const value = rnd() < 0.15 ? null : pick(values);
      const qualified = rnd() < 0.3;
      const ref = rnd() < 0.5 ? { entityUri: `urn:e${n}`, field: "f", recordId: "r1", raw: "x" } : null;
      return { a: { text, value, qualified, ref }, m: { text, value, qualified, ref } };
    };
    for (let i = 0; i < 500; i++) {
      const tag = pick(names);
      const dir = pick(dirs);
      const unit = pick(units);
      const withScale = rnd() > 0.15;
      const unitRef = rnd() < 0.5 ? { entityUri: "urn:s", field: "unit" } : null;
      shared = i % 6 === 0 ? pick(values) : null;
      const s = makeLevel(1);
      const t = makeLevel(2);
      const g = makeLevel(3);
      const a: PlanValueInput = {
        id: `id${i}`, name: tag, entityUri: `urn:ent${i}`,
        scale: withScale ? { unit, direction: dir, ref: unitRef } : null,
        status: s.a, tolerable: t.a, goal: g.a,
      };
      const m: MirrorReadValue = {
        id: `id${i}`, entityUri: `urn:ent${i}`, tag,
        scale: withScale ? { unit, direction: dir, ref: unitRef } : null,
        status: s.m, tolerable: t.m, goal: g.m,
      };
      const round = (row: MirrorRow | ReturnType<typeof buildPlanValueRow>) => {
        const copy = JSON.parse(JSON.stringify(row, (_k, v) => (v === undefined ? null : v))) as MirrorRow;
        for (const mark of [copy.now, copy.minimumOk, copy.target]) if (mark.pos !== null) mark.pos = Number(mark.pos.toFixed(12));
        return copy;
      };
      expect(round(buildPlanValueRow(a)), `case ${i}`).toEqual(round(rowOf(m)));
    }
  });

  // Spec: Parts.PlanValues, Parity: equal values sit in the middle, a lower scale flips (check M1)
  test("M1b equal values give 0.5 and lower flips, target does not", () => {
    const eq = buildPlanValueRow(input({ status: level("5", 5), tolerable: level("5", 5), goal: level("5", 5) }));
    expect([eq.now.pos, eq.minimumOk.pos, eq.target.pos]).toEqual([0.5, 0.5, 0.5]);
    const higher = buildPlanValueRow(input({ status: level("1", 1), tolerable: level("0", 0), goal: level("2", 2) }));
    expect([higher.now.pos, higher.minimumOk.pos, higher.target.pos]).toEqual([0.5, 0, 1]);
    const lower = buildPlanValueRow(input({ scale: { unit: "ms", direction: "lower" }, status: level("1", 1), tolerable: level("2", 2), goal: level("0", 0) }));
    expect(lower.flipped).toBe(true);
    expect([lower.now.pos, lower.minimumOk.pos, lower.target.pos]).toEqual([0.5, 0, 1]);
    const target = buildPlanValueRow(input({ scale: { unit: "ms", direction: "target" }, status: level("1", 1), tolerable: level("0", 0), goal: level("2", 2) }));
    expect(target.flipped).toBe(false);
    expect([target.now.pos, target.minimumOk.pos, target.target.pos]).toEqual([0.5, 0, 1]);
  });
});

describe("buildPlanValueRow: the words", () => {
  // Spec: Parts.PlanValues, Words: the same strings as the app, and each note case (check M2)
  test("M2 the constants equal the app's strings and each note is right", () => {
    expect(NO_LIMITS_TEXT).toBe(MIRROR_NO_LIMITS_TEXT);
    expect(LIMITS_ORDER_TEXT).toBe(MIRROR_LIMITS_ORDER_TEXT);
    expect(NOT_SET_TEXT).toBe(MIRROR_NOT_SET_TEXT);
    expect(UNNAMED_TEXT).toBe(MIRROR_UNNAMED_TEXT);
    expect(NO_LIMITS_TEXT).toBe("no limits set");
    expect(LIMITS_ORDER_TEXT).toBe("limits out of order");
    expect(NOT_SET_TEXT).toBe("not set");
    expect(UNNAMED_TEXT).toBe("Unnamed value");
    expect(CHECK_FAILED_TEXT).toBe("check failed");
    expect(NO_STATUS_TEXT).toBe("no current value");
    expect(CANNOT_DRAW_TEXT).toBe("cannot be drawn");

    expect(good({ tolerable: null }).note).toBe(NO_LIMITS_TEXT);
    expect(good({ goal: null }).note).toBe(NO_LIMITS_TEXT);
    expect(good({ tolerable: null, goal: null }).note).toBe(NO_LIMITS_TEXT);
    expect(good({ tolerable: level(null, null) }).note).toBe(NO_LIMITS_TEXT);
    // higher: a Target below the Minimum OK is out of order
    expect(good({ tolerable: level("50", 50), goal: level("40", 40) }).note).toBe(LIMITS_ORDER_TEXT);
    // lower: a Target above the Minimum OK is out of order
    const lower = (tol: number, goal: number) =>
      good({ scale: { unit: "ms", direction: "lower" }, tolerable: level(String(tol), tol), goal: level(String(goal), goal) });
    expect(lower(50, 60).note).toBe(LIMITS_ORDER_TEXT);
    expect(lower(50, 40).note).toBe("");
    expect(good().note).toBe("");
    // target: never out of order
    const target = good({ scale: { unit: "ms", direction: "target" }, tolerable: level("50", 50), goal: level("40", 40) });
    expect(target.note).toBe("");
  });

  // Spec: Parts.PlanValues, Words: a name is never made up from the id (check M2)
  test("M2b an empty name is Unnamed value", () => {
    expect(good({ name: "" }).name).toBe(UNNAMED_TEXT);
    expect(good({ name: "   " }).name).toBe(UNNAMED_TEXT);
    expect(good({ name: null }).name).toBe(UNNAMED_TEXT);
    expect(good({ name: undefined, id: "secret-id" }).name).toBe(UNNAMED_TEXT);
    expect(good({ name: "  Cost " }).name).toBe("Cost");
  });
});

describe("buildPlanValueRow: hardening", () => {
  // Spec: Parts.PlanValues, Honesty: a figure that is not a finite number is absent-valued, never a NaN position (check M3)
  test("M3 NaN, Infinity and -Infinity values are not drawable and never give a NaN pos", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      for (const slot of ["status", "tolerable", "goal"] as const) {
        const row = buildPlanValueRow(input({ [slot]: level("shown", bad) }));
        expect(row.drawable, `${slot} ${bad}`).toBe(false);
        for (const m of [row.now, row.minimumOk, row.target]) {
          expect(m.pos, `${slot} ${bad}`).toBeNull();
          expect(Number.isNaN(m.pos as number)).toBe(false);
        }
        const hit = slot === "status" ? row.now : slot === "tolerable" ? row.minimumOk : row.target;
        expect(hit.value).toBeNull();
        expect(hit.present).toBe(true);
        expect(planValueDrawable(row)).toBe(false);
      }
    }
  });
});

describe("planValueDrawable", () => {
  const clone = (): PlanValueRowLike => JSON.parse(JSON.stringify(good())) as PlanValueRowLike;
  // Spec: Parts.PlanValues, Honesty: a bar only from a checked row with usable positions (check M4)
  test("M4 true for a good row and false for each way it can be untrustworthy", () => {
    expect(planValueDrawable(good())).toBe(true);

    const cases: Array<[string, (r: PlanValueRowLike) => void]> = [
      ["drawable false", (r) => { r.drawable = false; }],
      ["now check failed", (r) => { r.now.text = CHECK_FAILED_TEXT; }],
      ["min check failed", (r) => { r.minimumOk.text = CHECK_FAILED_TEXT; }],
      ["target check failed", (r) => { r.target.text = CHECK_FAILED_TEXT; }],
      ["now pos missing", (r) => { r.now.pos = null; }],
      ["min pos missing", (r) => { r.minimumOk.pos = null; }],
      ["target pos undefined", (r) => { (r.target as { pos?: number | null }).pos = undefined; }],
      ["pos NaN", (r) => { r.now.pos = NaN; }],
      ["pos -0.1", (r) => { r.minimumOk.pos = -0.1; }],
      ["pos 1.1", (r) => { r.target.pos = 1.1; }],
      ["pos Infinity", (r) => { r.target.pos = Infinity; }],
      ["now not present", (r) => { r.now.present = false; }],
      ["min not present", (r) => { r.minimumOk.present = false; }],
      ["target not present", (r) => { r.target.present = false; }],
      ["value null", (r) => { r.now.value = null; }],
      ["value NaN", (r) => { r.minimumOk.value = NaN; }],
      ["value Infinity", (r) => { r.target.value = Infinity; }],
      ["missing now", (r) => { (r as unknown as { now: unknown }).now = undefined; }],
      ["null minimumOk", (r) => { (r as unknown as { minimumOk: unknown }).minimumOk = null; }],
      ["missing target", (r) => { delete (r as unknown as { target?: unknown }).target; }],
    ];
    for (const [name, mutate] of cases) {
      const r = clone();
      mutate(r);
      expect(() => planValueDrawable(r), name).not.toThrow();
      expect(planValueDrawable(r), name).toBe(false);
    }
    // the edges are allowed
    const edge = clone();
    edge.now.pos = 0; edge.target.pos = 1;
    expect(planValueDrawable(edge)).toBe(true);
    // junk of any kind
    for (const junk of [null, undefined, 0, "x", [], {}] as unknown[]) {
      expect(() => planValueDrawable(junk as PlanValueRowLike)).not.toThrow();
      expect(planValueDrawable(junk as PlanValueRowLike)).toBe(false);
    }
  });
});

describe("planValueWords", () => {
  const clone = (): PlanValueRowLike => JSON.parse(JSON.stringify(good())) as PlanValueRowLike;
  // Spec: Parts.PlanValues, Words: the five kinds in their stated priority (check M5)
  test("M5 the five kinds, in priority order, with the exact texts", () => {
    expect(planValueWords(good())).toEqual({ kind: "bar", text: "" });
    expect(planValueWords(good({ tolerable: level("50", 50), goal: level("40", 40) }))).toEqual({ kind: "bar", text: LIMITS_ORDER_TEXT });

    const failed = clone();
    failed.now.text = CHECK_FAILED_TEXT;
    expect(planValueWords(failed)).toEqual({ kind: "check_failed", text: "check failed" });

    // check failed outranks a missing limit
    const both = good({ tolerable: null });
    both.now.text = CHECK_FAILED_TEXT;
    expect(planValueWords(both)).toEqual({ kind: "check_failed", text: "check failed" });

    expect(planValueWords(good({ tolerable: null }))).toEqual({ kind: "no_limits", text: "no limits set" });
    expect(planValueWords(good({ goal: null }))).toEqual({ kind: "no_limits", text: "no limits set" });
    // no limits outranks no status
    expect(planValueWords(good({ status: null, goal: null }))).toEqual({ kind: "no_limits", text: "no limits set" });
    expect(planValueWords(good({ status: null }))).toEqual({ kind: "no_status", text: "no current value" });

    const noPos = clone();
    noPos.now.pos = NaN;
    expect(planValueWords(noPos)).toEqual({ kind: "cannot_draw", text: "cannot be drawn" });
    const noValue = good({ status: level("shown", NaN) });
    expect(planValueWords(noValue)).toEqual({ kind: "cannot_draw", text: "cannot be drawn" });

    const missing = clone();
    (missing.minimumOk as { present?: boolean }).present = undefined;
    expect(planValueWords(missing).kind).toBe("no_limits");
    for (const junk of [null, undefined, {}, 3] as unknown[]) {
      expect(() => planValueWords(junk as PlanValueRowLike)).not.toThrow();
    }
  });
});

describe("planValueSentence", () => {
  // Spec: Parts.PlanValues, Honesty: the text alternative uses the shown text, never a recomputed number (check M6)
  test("M6 holds each shown text and the unit, mentions out of order, never says live, uses text not value", () => {
    const s = planValueSentence(good({ name: "Cost", status: level("62", 62), tolerable: level("50", 50), goal: level("90", 90) }));
    expect(s).toBe("Cost: Now 62 euro, Minimum OK 50 euro, Target 90 euro");
    expect(s).not.toMatch(/live/i);

    // the text differs from the value: the sentence must carry the text
    const odd = planValueSentence(good({ status: level("about sixty", 62), tolerable: level("fifty", 50), goal: level("ninety", 90) }));
    expect(odd).toContain("about sixty");
    expect(odd).toContain("fifty");
    expect(odd).toContain("ninety");
    expect(odd).not.toContain("62");
    expect(odd).not.toContain("90.");

    const noUnit = planValueSentence(good({ scale: { unit: "", direction: "higher" } }));
    expect(noUnit).toBe("Cost: Now 62, Minimum OK 50, Target 90");

    const order = planValueSentence(good({ tolerable: level("50", 50), goal: level("40", 40) }));
    expect(order).toMatch(/Limits out of order\.$/);
    expect(order.toLowerCase()).toContain("limits out of order");
    expect(order).not.toMatch(/live/i);

    // without text the formatter is used
    const row = good();
    row.now.text = "";
    row.now.value = 62;
    expect(planValueSentence(row, (n) => `<${n}>`)).toContain("Now <62>");
    for (const junk of [null, undefined, {}] as unknown[]) {
      expect(() => planValueSentence(junk as PlanValueRowLike)).not.toThrow();
    }
  });
});

describe("junk input", () => {
  // Spec: Parts.PlanValues, Robust: a builder that never throws (check M7)
  test("M7 null fields, a missing id and non-object input never throw", () => {
    const junk: unknown[] = [
      {}, { id: "x" }, { id: "x", status: null, tolerable: null, goal: null, scale: null, name: null },
      { status: { text: "1", value: "NaN" } }, { id: 5, name: 7 }, { scale: { unit: 5, direction: "sideways" } },
      null, undefined, "text", 12, [], { id: "x", status: { text: null, value: null } },
    ];
    for (const j of junk) {
      expect(() => buildPlanValueRow(j as PlanValueInput), JSON.stringify(j)).not.toThrow();
      const row = buildPlanValueRow(j as PlanValueInput);
      expect(row.drawable).toBe(false);
      expect(typeof row.id).toBe("string");
      expect(typeof row.name).toBe("string");
      expect(["lower", "higher", "target"]).toContain(row.direction);
      expect(() => planValueSentence(row)).not.toThrow();
      expect(() => planValueWords(row)).not.toThrow();
    }
    // The absent marks say "not set", never zero.
    const empty = buildPlanValueRow({ id: "e" });
    for (const m of [empty.now, empty.minimumOk, empty.target]) {
      expect(m).toMatchObject({ present: false, text: "not set", value: null, qualified: false, ref: null, pos: null });
    }
  });
});
