import { afterEach, describe, expect, test } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { PlanValueBar, PlanValueBullet, PlanValueList, PlanValueStyle, PLAN_VALUE_CSS } from "../../src/react/plan-value.js";
import type { PlanValueBarProps, PlanValueBulletProps, PlanValueListProps } from "../../src/react/plan-value.js";
import { buildPlanValueRow, planValueSentence, CHECK_FAILED_TEXT, LIMITS_ORDER_TEXT } from "../../src/plan-value-model.js";
import type { PlanFieldRef, PlanLevelInput, PlanValueInput, PlanValueRowLike } from "../../src/plan-value-model.js";

afterEach(() => {
  cleanup();
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
});

const level = (text: string | null, value: number | null, extra: Partial<PlanLevelInput> = {}): PlanLevelInput => ({ text, value, ...extra });
const REF: PlanFieldRef = { entityUri: "urn:e", field: "f", recordId: "r" };
const input = (over: Partial<PlanValueInput> = {}): PlanValueInput => ({
  id: "v1", name: "Cost", entityUri: "urn:v1",
  scale: { unit: "euro", direction: "higher", ref: REF },
  status: level("62", 62, { ref: REF }), tolerable: level("50", 50, { ref: REF }), goal: level("90", 90, { ref: REF }), ...over,
});
const row = (over: Partial<PlanValueInput> = {}): PlanValueRowLike => buildPlanValueRow(input(over));
const clone = (over: Partial<PlanValueInput> = {}): PlanValueRowLike => JSON.parse(JSON.stringify(row(over))) as PlanValueRowLike;

function bar(r: PlanValueRowLike, extra: Partial<PlanValueBarProps> = {}) {
  const view = render(createElement(PlanValueBar, { row: r, ...extra }));
  const root = view.container.firstElementChild as HTMLElement;
  return { view, root, svg: root.querySelector("svg"), words: root.querySelector(".gilb-plan-value-bar__words") as HTMLElement | null };
}
function bullet(r: PlanValueRowLike, extra: Partial<PlanValueBulletProps> = {}) {
  const view = render(createElement(PlanValueBullet, { row: r, ...extra }));
  const root = view.container.firstElementChild as HTMLElement;
  return { view, root };
}
const markOf = (root: HTMLElement, term: string) => root.querySelector(`.gilb-plan-value__mark[data-term="${term}"]`) as HTMLElement;

describe("PlanValueBar: the picture", () => {
  // Spec: Parts.PlanValues, Honesty: a drawable row draws one labelled picture whose marks differ by more than colour (check PV1)
  test("PV1 one svg with a text alternative, and the three marks differ by dash and weight", () => {
    const r = row();
    const { root, svg } = bar(r);
    expect(root.querySelectorAll("svg").length).toBe(1);
    expect(svg!.getAttribute("role")).toBe("img");
    expect(svg!.getAttribute("aria-label")).toBe(planValueSentence(r));
    expect((svg!.getAttribute("aria-label") ?? "").length).toBeGreaterThan(0);
    expect(svg!.getAttribute("focusable")).toBe("false");
    expect(root.getAttribute("data-drawable")).toBe("true");
    const now = svg!.querySelector('[data-mark="now"]')!;
    const min = svg!.querySelector('[data-mark="minimum-ok"]')!;
    const tgt = svg!.querySelector('[data-mark="target"]')!;
    expect(now.tagName.toLowerCase()).toBe("rect");
    expect(min.tagName.toLowerCase()).toBe("line");
    expect(tgt.tagName.toLowerCase()).toBe("line");
    expect(min.getAttribute("stroke-dasharray")).toBe("2 1.5");
    expect(tgt.getAttribute("stroke-dasharray")).toBeNull();
    expect(tgt.getAttribute("stroke-width")).toBe("2.6");
    expect(min.getAttribute("stroke-width")).not.toBe(tgt.getAttribute("stroke-width"));
    // 62 sits at (62-50)/(90-50) = 0.3 of the way: the bar is 30 wide
    expect(Number(now.getAttribute("width"))).toBeCloseTo(30, 6);
    expect(Number(min.getAttribute("x1"))).toBeCloseTo(0, 6);
    expect(Number(tgt.getAttribute("x1"))).toBeCloseTo(100, 6);
    expect(svg!.querySelectorAll("rect[data-band]").length).toBe(3);
  });
});

describe("PlanValueBar: the text alternative", () => {
  // Spec: Parts.PlanValues, Honesty: the picture's words are the shown texts, never a recomputed number (check PV1)
  test("PV1b the aria-label carries the shown text and not the number behind it", () => {
    const { svg } = bar(row({ status: level("about sixty", 62), tolerable: level("fifty", 50), goal: level("ninety", 90) }));
    const label = svg!.getAttribute("aria-label")!;
    expect(label).toContain("about sixty");
    expect(label).toContain("fifty");
    expect(label).toContain("ninety");
    expect(label).not.toMatch(/62|90/);
  });
});

describe("PlanValueBar: honesty", () => {
  const noBar = (r: PlanValueRowLike, kind: string, text: string, label: string) => {
    const { root, svg, words } = bar(r);
    expect(svg, label).toBeNull();
    expect(root.querySelector("svg"), label).toBeNull();
    expect(root.getAttribute("data-drawable"), label).toBe("false");
    expect(words!.getAttribute("data-words"), label).toBe(kind);
    expect(words!.textContent, label).toBe(text);
  };

  // Spec: Parts.PlanValues, Honesty: a missing limit never becomes a bar (LiveWire step, check 10 Meaning.PlanValues) (check PV2)
  test("PV2a a missing limit shows words and draws nothing", () => {
    noBar(row({ tolerable: null }), "no_limits", "no limits set", "tolerable absent");
    noBar(row({ goal: null }), "no_limits", "no limits set", "goal absent");
    noBar(row({ tolerable: null, goal: null }), "no_limits", "no limits set", "both absent");
    noBar(row({ tolerable: level(null, null) }), "no_limits", "no limits set", "tolerable text null");
    noBar(row({ status: null }), "no_status", "no current value", "status absent");
  });

  // Spec: Parts.PlanValues, Honesty: a figure that failed its check never becomes a bar (check PV2)
  test("PV2b a check failed text shows the words and draws nothing", () => {
    for (const slot of ["now", "minimumOk", "target"] as const) {
      const r = clone();
      r[slot].text = CHECK_FAILED_TEXT;
      noBar(r, "check_failed", "check failed", slot);
      cleanup();
    }
    const b = bullet((() => { const r = clone(); r.minimumOk.text = CHECK_FAILED_TEXT; return r; })());
    expect(b.root.querySelector("svg")).toBeNull();
    expect(markOf(b.root, "Tolerable").getAttribute("data-check")).toBe("failed");
    expect(markOf(b.root, "Tolerable").textContent).toContain("check failed");
  });

  // Spec: Parts.PlanValues, Honesty: a position that is not usable is never drawn (check PV2)
  test("PV2c drawable true but pos missing, NaN or out of range draws nothing", () => {
    const bads: Array<[string, number | null | undefined]> = [["null", null], ["undefined", undefined], ["NaN", NaN], ["-0.1", -0.1], ["1.1", 1.1], ["Infinity", Infinity]];
    for (const [name, bad] of bads) {
      for (const slot of ["now", "minimumOk", "target"] as const) {
        const r = clone();
        r.drawable = true;
        (r[slot] as { pos: number | null | undefined }).pos = bad;
        noBar(r, "cannot_draw", "cannot be drawn", `${slot} ${name}`);
        cleanup();
      }
    }
  });

  // Spec: Parts.PlanValues, Honesty: the part does not trust the row's own drawable flag (check PV2)
  test("PV2d a row that is not drawable but carries pos values draws nothing", () => {
    const r = clone();
    r.drawable = false;
    noBar(r, "cannot_draw", "cannot be drawn", "drawable false");
    // and a row whose drawable flag is true while a limit is absent
    const lying = clone();
    lying.minimumOk.present = false;
    lying.minimumOk.text = "not set";
    noBar(lying, "no_limits", "no limits set", "lying drawable");
    cleanup();
    const lying2 = clone();
    lying2.target.present = false;
    noBar(lying2, "no_limits", "no limits set", "lying drawable target");
    cleanup();
    const lying3 = clone();
    lying3.now.value = null;
    noBar(lying3, "cannot_draw", "cannot be drawn", "lying drawable value");
  });

  // Spec: Parts.PlanValues, Words: the picture is drawn and the problem is still said (check PV3)
  test("PV3 an out of order row draws the bar and shows the note", () => {
    const r = row({ tolerable: level("50", 50), goal: level("40", 40) });
    expect(r.note).toBe(LIMITS_ORDER_TEXT);
    const { root, svg } = bar(r);
    expect(svg).not.toBeNull();
    expect(root.querySelector(".gilb-plan-value-bar__note")!.textContent).toBe("limits out of order");
    // no note when there is nothing to say
    expect(bar(row()).root.querySelector(".gilb-plan-value-bar__note")).toBeNull();
  });

  // Spec: Parts.PlanValues, Words: the words the part adds can be replaced (check PV2)
  test("PV2e labels replace the words the part adds", () => {
    const { words } = bar(row({ status: null }), { labels: { noStatus: "kein Wert" } });
    expect(words!.textContent).toBe("kein Wert");
    cleanup();
    const r = clone(); r.drawable = false;
    expect(bar(r, { labels: { cannotDraw: "nicht zeichenbar" } }).words!.textContent).toBe("nicht zeichenbar");
  });
});

describe("PlanValueBullet", () => {
  // Spec: Parts.PlanValues, Honesty: every figure is the shown text, with its term word for a screen reader (check PV4)
  test("PV4 name, unit, each mark label and text, title and hidden term word", () => {
    const { root } = bullet(row({ status: level("about sixty", 62), tolerable: level("fifty", 50), goal: level("ninety", 90) }));
    expect(root.getAttribute("role")).toBe("group");
    expect(root.getAttribute("aria-label")).toBe("Cost");
    expect(root.getAttribute("data-row")).toBe("v1");
    expect(root.textContent).toContain("Cost");
    expect(root.querySelector(".gilb-plan-value__unit")!.textContent).toBe("euro");
    const expected: Array<[string, string, string, string]> = [
      ["Status", "Now", "about sixty", " (Status)"],
      ["Tolerable", "Minimum OK", "fifty", " (Tolerable)"],
      ["Goal", "Target", "ninety", " (Goal)"],
    ];
    for (const [term, label, text, hidden] of expected) {
      const m = markOf(root, term);
      expect(m.getAttribute("title"), term).toBe(term);
      expect(m.textContent, term).toContain(label);
      expect(m.querySelector(".gilb-plan-value__figure")!.textContent, term).toBe(text);
      const h = m.querySelector(".gilb-plan-value__hidden") as HTMLElement;
      expect(h.textContent, term).toBe(hidden);
      expect(h.style.position, term).toBe("absolute");
      expect(h.style.overflow, term).toBe("hidden");
    }
    // the value 62 was not given as text, so it must not appear
    expect(root.textContent).not.toContain("62");
    // the sentence is not repeated in the text list
    expect(root.textContent).not.toContain("Now about sixty euro");

    const noUnit = bullet(row({ scale: { unit: "", direction: "higher" } })).root;
    expect(noUnit.querySelector(".gilb-plan-value__unit")!.textContent).toBe("not set");
    expect(bullet(row({ scale: null })).root.querySelector(".gilb-plan-value__unit")!.textContent).toBe("not set");
  });

  // Spec: Parts.PlanValues, Honesty: an absent figure reads not set, never zero or blank (check PV4)
  test("PV4b an absent mark shows not set and no zero", () => {
    for (const slot of ["status", "tolerable", "goal"] as const) {
      const term = slot === "status" ? "Status" : slot === "tolerable" ? "Tolerable" : "Goal";
      const { root } = bullet(row({ [slot]: null, ...(slot === "status" ? { tolerable: level("10", 10), goal: level("20", 20) } : {}) }));
      const m = markOf(root, term);
      expect(m.querySelector(".gilb-plan-value__figure")!.textContent, slot).toBe("not set");
      expect(m.textContent, slot).not.toMatch(/(^|\D)0(\D|$)/);
      cleanup();
    }
    // the words are said once, by the bar's words, and the paragraph does not repeat them (see PV13)
    const noLimit = bullet(row({ tolerable: null, goal: null })).root;
    expect(noLimit.querySelector(".gilb-plan-value-bar__words")!.textContent).toBe("no limits set");
    expect(noLimit.querySelector("svg")).toBeNull();
    const noStatus = bullet(row({ status: null })).root;
    expect(noStatus.querySelector(".gilb-plan-value-bar__words")!.textContent).toBe("no current value");
    // the note is absent when there is nothing to say
    expect(bullet(row()).root.querySelector(".gilb-plan-value__note")).toBeNull();
    // out of order: said once, by the bar's own note
    expect(bullet(row({ tolerable: level("50", 50), goal: level("40", 40) })).root.querySelector(".gilb-plan-value-bar__note")!.textContent).toBe("limits out of order");
  });

  // Spec: Parts.PlanValues, Words: the words the part adds can be replaced (check PV4)
  test("PV4c labels replace the unit and term words", () => {
    const { root } = bullet(row({ scale: { unit: "" } }), { labels: { unitNotSet: "ohne Einheit", termStatus: "Zustand" } });
    expect(root.querySelector(".gilb-plan-value__unit")!.textContent).toBe("ohne Einheit");
    expect(markOf(root, "Status").querySelector(".gilb-plan-value__hidden")!.textContent).toBe(" (Zustand)");
    expect(markOf(root, "Status").getAttribute("title")).toBe("Zustand");
  });
});

describe("PlanValueBullet: words read once", () => {
  // Spec: Parts.PlanValues, Accessible: no word string is read twice inside a bullet (check PV13)
  test("PV13 each word string appears at most once in the bullet's text", () => {
    const failedAt = (slot: "now" | "minimumOk" | "target") => { const r = clone(); r[slot].text = CHECK_FAILED_TEXT; return r; };
    const noPos = clone(); noPos.now.pos = NaN;
    const notDrawable = clone(); notDrawable.drawable = false;
    const cases: Array<[string, PlanValueRowLike]> = [
      ["tolerable absent", row({ tolerable: null })], ["goal absent", row({ goal: null })], ["both absent", row({ tolerable: null, goal: null })],
      ["status absent", row({ status: null })], ["failed now", failedAt("now")], ["failed min", failedAt("minimumOk")],
      ["failed target", failedAt("target")], ["pos NaN", noPos], ["not drawable", notDrawable],
      ["out of order", row({ tolerable: level("50", 50), goal: level("40", 40) })],
      ["out of order lower", row({ scale: { unit: "ms", direction: "lower" }, tolerable: level("40", 40), goal: level("50", 50) })],
    ];
    const words = ["no limits set", "check failed", "no current value", "cannot be drawn", "limits out of order"];
    for (const [name, r] of cases) {
      const text = bullet(r).root.textContent ?? "";
      for (const w of words) expect(text.split(w).length - 1, `${name}: ${w}`).toBeLessThanOrEqual(1);
      cleanup();
    }
    // and the words are still there once
    expect(bullet(row({ tolerable: null })).root.textContent).toContain("no limits set");
    cleanup();
    expect(bullet(row({ tolerable: level("50", 50), goal: level("40", 40) })).root.textContent).toContain("limits out of order");
  });
});

describe("the trace prop", () => {
  const spy = () => {
    const calls: Array<{ ref: PlanFieldRef | null; shown: string }> = [];
    const trace = (fact: { ref: PlanFieldRef | null; shown: string }) => { calls.push(fact); return { "data-t": fact.shown, "data-t-field": fact.ref?.field ?? "none" }; };
    return { calls, trace };
  };
  const traced = (root: HTMLElement) => Array.from(root.querySelectorAll("[data-t]")).map((e) => e.getAttribute("data-t"));

  // Spec: Parts.PlanValues, Trace: a shown figure with a source carries what the app's writer gives (check PV5)
  test("PV5a attributes reach the unit and each present mark", () => {
    const { calls, trace } = spy();
    const { root } = bullet(row({ status: level("sixty", 62, { ref: REF }) }), { trace });
    expect(root.querySelector(".gilb-plan-value__unit")!.getAttribute("data-t")).toBe("euro");
    expect(markOf(root, "Status").querySelector(".gilb-plan-value__figure")!.getAttribute("data-t")).toBe("sixty");
    expect(markOf(root, "Tolerable").querySelector(".gilb-plan-value__figure")!.getAttribute("data-t")).toBe("50");
    expect(markOf(root, "Goal").querySelector(".gilb-plan-value__figure")!.getAttribute("data-t")).toBe("90");
    expect(markOf(root, "Goal").querySelector(".gilb-plan-value__figure")!.getAttribute("data-t-field")).toBe("f");
    expect(calls.some((c) => c.ref === REF || c.ref?.field === "f")).toBe(true);
  });

  // Spec: Parts.PlanValues, Trace: an absent, empty or failed figure is never traced (check PV5)
  test("PV5b not called and not present for an absent mark, an empty text or a check failed text", () => {
    const { calls, trace } = spy();
    const r = clone({ status: null });
    r.minimumOk.text = "";
    r.target.text = CHECK_FAILED_TEXT;
    const { root } = bullet(r, { trace });
    expect(traced(root)).toEqual(["euro"]);
    expect(calls.map((c) => c.shown)).toEqual(["euro"]);
    expect(calls.some((c) => c.shown === "" || c.shown === CHECK_FAILED_TEXT || c.shown === "not set")).toBe(false);
    expect(markOf(root, "Goal").getAttribute("data-check")).toBe("failed");
    expect(root.querySelector("[data-t=\"check failed\"]")).toBeNull();
    // a unit that failed its check is not traced either
    cleanup();
    const u = clone();
    u.unit = CHECK_FAILED_TEXT;
    const s = spy();
    const view = bullet(u, { trace: s.trace });
    expect(s.calls.some((c) => c.shown === CHECK_FAILED_TEXT)).toBe(false);
    expect(view.root.querySelector(".gilb-plan-value__unit")!.getAttribute("data-check")).toBe("failed");
    expect(view.root.querySelector(".gilb-plan-value__unit")!.hasAttribute("data-t")).toBe(false);
    // an empty unit shows not set and is not traced
    cleanup();
    const e = spy();
    bullet(row({ scale: { unit: "" } }), { trace: e.trace });
    expect(e.calls.some((c) => c.shown === "" || c.shown === "not set")).toBe(false);
  });

  // Spec: Parts.PlanValues, Robust: a writer that throws or returns nothing does not break the part (check PV5)
  test("PV5c a throwing or empty writer is swallowed", () => {
    const { root } = bullet(row(), { trace: () => { throw new Error("boom"); } });
    expect(root.querySelector(".gilb-plan-value__unit")!.textContent).toBe("euro");
    expect(root.querySelector("svg")).not.toBeNull();
    cleanup();
    const nil = bullet(row(), { trace: () => null });
    expect(nil.root.querySelector("svg")).not.toBeNull();
  });

  // Spec: Parts.PlanValues, Trace: the part adds no attribute of its own when no writer is passed (check PV5)
  test("PV5d with no trace prop there are no data-live attributes at all", () => {
    const view = render(createElement(PlanValueList, { rows: [row(), row({ id: "v2", tolerable: null }), clone({ id: "v3" })] }));
    for (const el of Array.from(view.container.querySelectorAll("*"))) {
      for (const a of el.getAttributeNames()) {
        expect(a.startsWith("data-live"), a).toBe(false);
        expect(a === "data-t" || a === "data-t-field", a).toBe(false);
      }
    }
  });
});

describe("motion", () => {
  const motionOf = (r: PlanValueRowLike, extra: Partial<PlanValueBarProps> = {}) => {
    const b = bar(r, extra);
    const out = { motion: b.root.getAttribute("data-motion"), now: b.svg?.querySelector('[data-mark="now"]') ?? null, root: b.root };
    return out;
  };

  // Spec: Parts.PlanValues, Motion: grow only when drawable and nothing asked for stillness (check PV6)
  test("PV6a data-motion is grow only for a drawable row with no request for stillness", () => {
    const g = motionOf(row());
    expect(g.motion).toBe("grow");
    expect((g.now as unknown as Element).getAttribute("style") ?? "").toContain("transition");
    cleanup();
    for (const extra of [{ still: true }, { reducedMotion: true }] as Partial<PlanValueBarProps>[]) {
      const s = motionOf(row(), extra);
      expect(s.motion, JSON.stringify(extra)).toBe("still");
      expect((s.now as unknown as Element).getAttribute("style"), JSON.stringify(extra)).toBeNull();
      expect(s.root.innerHTML).not.toContain("transition");
      cleanup();
    }
    const nd = motionOf(row({ tolerable: null }));
    expect(nd.motion).toBe("still");
    expect(nd.root.innerHTML).not.toContain("transition");
    cleanup();
    expect(motionOf(row(), { reducedMotion: false }).motion).toBe("grow");
  });

  // Spec: Parts.PlanValues, Motion: the reader's setting is followed (check PV6)
  test("PV6b the style sheet carries the reduced motion rule", () => {
    expect(PLAN_VALUE_CSS).toContain("@media (prefers-reduced-motion: reduce)");
    expect(PLAN_VALUE_CSS).toMatch(/\.gilb-plan-value-bar \[data-mark="now"\]\s*\{\s*transition:\s*none\s*!important/);
    expect(PLAN_VALUE_CSS).toContain('[data-motion="grow"] [data-mark="now"]');
    expect(PLAN_VALUE_CSS).toContain("transition: width 240ms");
  });

  // Spec: Parts.PlanValues, Motion: a fake reader setting yields still (check PV6)
  test("PV6c a matchMedia that matches reduced motion yields still, and the prop wins over it", () => {
    (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({
      matches: q.includes("prefers-reduced-motion: reduce"),
      addEventListener: () => {}, removeEventListener: () => {},
    });
    expect(motionOf(row()).motion).toBe("still");
    cleanup();
    expect(motionOf(row(), { reducedMotion: false }).motion).toBe("grow");
    cleanup();
    (globalThis as { matchMedia?: unknown }).matchMedia = (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} });
    expect(motionOf(row()).motion).toBe("grow");
  });
});

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

describe("the word live", () => {
  // Spec: Parts.PlanValues, Words: the word live never reaches a person or a screen reader from this part (check PV7)
  test("PV7 300 seeded rows give no live in text, title or aria-label", () => {
    const rnd = seeded(77);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const texts: (string | null)[] = ["62", "50", "90", "", null, CHECK_FAILED_TEXT, "about ten", "3.5 %"];
    const values: (number | null)[] = [62, 50, 90, 0, null, NaN, Infinity, 5, 5];
    const mk = (): PlanLevelInput | null => (rnd() < 0.2 ? null : { text: pick(texts), value: pick(values) });
    const view = render(createElement("div"));
    for (let i = 0; i < 300; i++) {
      const dir = pick(["lower", "higher", "target"] as const);
      const r = buildPlanValueRow({
        id: `row ${i}`, name: pick(["Cost", "", "Quality", "  ", null]),
        scale: rnd() < 0.1 ? null : { unit: pick(["euro", "", "%"]), direction: dir },
        status: mk(), tolerable: mk(), goal: mk(),
      });
      const j = rnd();
      if (j < 0.1) r.now.pos = NaN;
      const part = j < 0.5
        ? createElement(PlanValueBullet, { row: r })
        : j < 0.8 ? createElement(PlanValueBar, { row: r }) : createElement(PlanValueList, { rows: [r, { ...r, id: `${r.id} again` }] });
      const { container, unmount } = render(part);
      const all: string[] = [container.textContent ?? ""];
      for (const el of Array.from(container.querySelectorAll("*"))) {
        for (const a of ["title", "aria-label", "alt"]) {
          const v = el.getAttribute(a);
          if (v !== null) all.push(v);
        }
      }
      for (const s of all) expect(s, `row ${i}`).not.toMatch(/live/i);
      unmount();
    }
    view.unmount();
    const empty = render(createElement(PlanValueList, { rows: [] }));
    expect(empty.container.textContent).not.toMatch(/live/i);
  });
});

describe("PlanValueList", () => {
  // Spec: Parts.PlanValues, Order: rows in the given order, one style for the list, and words for no rows (check PV8)
  test("PV8 one style, one li per row in the given order, stable keys, empty words", () => {
    const rows = [row({ id: "z" }), row({ id: "a", tolerable: null }), row({ id: "m" }), row({ id: "b" })];
    const view = render(createElement(PlanValueList, { rows }));
    expect(view.container.querySelectorAll("style").length).toBe(1);
    const ul = view.container.querySelector("ul.gilb-plan-value-list")!;
    expect(ul.getAttribute("role")).toBe("list");
    const lis = Array.from(ul.querySelectorAll(":scope > li"));
    expect(lis.map((li) => li.querySelector("[data-row]")!.getAttribute("data-row"))).toEqual(["z", "a", "m", "b"]);
    expect(view.container.querySelectorAll("li svg").length).toBe(3);
    // the same rows again, reversed, keep the given order (never sorted)
    view.rerender(createElement(PlanValueList, { rows: [...rows].reverse() }));
    expect(Array.from(view.container.querySelectorAll("ul > li > [data-row]")).map((e) => e.getAttribute("data-row"))).toEqual(["b", "m", "a", "z"]);
    expect(view.container.querySelectorAll("style").length).toBe(1);
    cleanup();
    const empty = render(createElement(PlanValueList, { rows: [] }));
    expect(empty.container.querySelector("ul")).toBeNull();
    expect(empty.container.querySelector("p")!.textContent).toBe("No Values in this plan yet.");
    cleanup();
    const custom = render(createElement(PlanValueList, { rows: [], labels: { empty: "Keine Werte." } } satisfies PlanValueListProps));
    expect(custom.container.querySelector("p")!.textContent).toBe("Keine Werte.");
    cleanup();
    // the single parts do not render a style
    expect(bar(row()).root.querySelector("style")).toBeNull();
    expect(bullet(row()).root.querySelector("style")).toBeNull();
  });
});

describe("the app's row type", () => {
  // Spec: Parts.PlanValues, Swap: a row built as the app's strip row type is accepted as it is (check PV9)
  test("PV9 an app-shaped literal with extra fields is accepted by the component", () => {
    type AppMark = {
      label: "Now" | "Minimum OK" | "Target"; term: "Status" | "Tolerable" | "Goal"; present: boolean; text: string;
      value: number | null; qualified: boolean; ref: { entityUri: string; field: string; recordId?: string; raw?: string } | null; pos: number | null;
    };
    type AppRow = {
      id: string; entityUri: string; name: string; unit: string; unitRef: PlanFieldRef | null;
      direction: "lower" | "higher" | "target"; flipped: boolean; now: AppMark; minimumOk: AppMark; target: AppMark; drawable: boolean; note: string;
    };
    const m = (label: AppMark["label"], term: AppMark["term"], text: string, value: number, pos: number): AppMark =>
      ({ label, term, present: true, text, value, qualified: false, ref: null, pos });
    const appRow: AppRow = {
      id: "app1", entityUri: "urn:app", name: "Speed", unit: "ms", unitRef: null, direction: "lower", flipped: true,
      now: m("Now", "Status", "40", 40, 0.5), minimumOk: m("Minimum OK", "Tolerable", "60", 60, 0), target: m("Target", "Goal", "20", 20, 1),
      drawable: true, note: "",
    };
    const asLike: PlanValueRowLike = appRow;
    const bulletProps: PlanValueBulletProps = { row: appRow };
    const view = render(createElement(PlanValueBullet, bulletProps));
    expect(view.container.querySelector("svg")).not.toBeNull();
    const barView = render(createElement(PlanValueBar, { row: asLike }));
    expect(barView.container.querySelector("svg")).not.toBeNull();
    render(createElement(PlanValueList, { rows: [appRow] }));
  });
});

describe("ids and junk", () => {
  const ids = (container: HTMLElement) => Array.from(container.querySelectorAll("pattern")).map((p) => p.getAttribute("id")!);

  // Spec: Parts.PlanValues, Page: two bars on a page never share a pattern id (check PV10)
  test("PV10 pattern ids are unique per row id, safe in characters, and referenced", () => {
    const a = bar(row({ id: "a" }));
    const b = bar(row({ id: "b" }));
    const ia = ids(a.root);
    const ib = ids(b.root);
    expect(ia.length).toBeGreaterThanOrEqual(2);
    expect(ia.filter((x) => ib.includes(x))).toEqual([]);
    cleanup();
    // two ids that look alike once made safe still differ
    const c = bar(row({ id: "a b" }));
    const d = bar(row({ id: "a_b" }));
    const e = bar(row({ id: "a<b>\"'/" }));
    const all = [...ids(c.root), ...ids(d.root), ...ids(e.root)];
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    // every pattern is used by a band
    const used = Array.from(c.root.querySelectorAll("rect[data-band]")).map((r) => r.getAttribute("fill") ?? "");
    for (const id of ids(c.root)) expect(used.some((f) => f === `url(#${id})`)).toBe(true);
    cleanup();
    // the same row twice does not break rendering
    const view = render(createElement("div", null, createElement(PlanValueBar, { row: row() }), createElement(PlanValueBar, { row: row() })));
    expect(view.container.querySelectorAll("svg").length).toBe(2);
    // an empty id still gives a safe id
    const empty = bar(row({ id: "" }));
    for (const id of ids(empty.root)) expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  // Spec: Parts.PlanValues, Robust: junk props never throw (check PV11)
  test("PV11 null marks, a missing mark and an undefined unit never throw", () => {
    const junkRows: unknown[] = [
      { id: "j1", name: "x", unit: undefined, direction: "higher", flipped: false, now: null, minimumOk: null, target: null, drawable: true, note: "" },
      { id: "j2" },
      { id: "j3", name: "n", unit: "u", drawable: true, now: { present: true, text: "1", value: 1, pos: 0.5 } },
      {},
      { id: 4, name: 5, now: 7 },
    ];
    for (const j of junkRows) {
      const r = j as PlanValueRowLike;
      expect(() => render(createElement(PlanValueBar, { row: r })), JSON.stringify(j)).not.toThrow();
      cleanup();
      expect(() => render(createElement(PlanValueBullet, { row: r })), JSON.stringify(j)).not.toThrow();
      cleanup();
      expect(() => render(createElement(PlanValueList, { rows: [r] })), JSON.stringify(j)).not.toThrow();
      cleanup();
    }
    expect(() => render(createElement(PlanValueBar, { row: null as unknown as PlanValueRowLike }))).not.toThrow();
    cleanup();
    expect(() => render(createElement(PlanValueList, { rows: null as unknown as PlanValueRowLike[] }))).not.toThrow();
    cleanup();
    const j1 = bullet(junkRows[0] as PlanValueRowLike).root;
    expect(j1.querySelector("svg")).toBeNull();
    expect(j1.querySelector(".gilb-plan-value__unit")!.textContent).toBe("not set");
  });

  // Spec: Parts.PlanValues, Safe: nothing inline-executable, and the style holds no input (check PV12)
  test("PV12 no on* attribute, no href, no raw html, the style text is the constant", () => {
    const hostile = row({ id: "<img src=x onerror=alert(1)>", name: "<script>alert(1)</script>", scale: { unit: "\"><b>x</b>", direction: "higher" } });
    const view = render(createElement(PlanValueList, { rows: [hostile, row()], trace: undefined }));
    for (const el of Array.from(view.container.querySelectorAll("*"))) {
      for (const a of el.getAttributeNames()) {
        expect(a.startsWith("on"), a).toBe(false);
        expect(a, a).not.toBe("href");
        expect(a, a).not.toBe("xlink:href");
      }
    }
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("b")).toBeNull();
    expect(view.container.querySelector("style")!.textContent).toBe(PLAN_VALUE_CSS);
    cleanup();
    const s = render(createElement(PlanValueStyle, null));
    expect(s.container.querySelector("style")!.textContent).toBe(PLAN_VALUE_CSS);
    // a hostile name changes nothing in the style
    const other = render(createElement(PlanValueList, { rows: [hostile] }));
    expect(other.container.querySelector("style")!.textContent).toBe(PLAN_VALUE_CSS);
  });
});
