import { describe, expect, test } from "vitest";
import { NO_DATA_TEXT, TRACE_ATTR, readTraceAttrs, scanTrace, traceAttrs } from "../src/trace-attrs.js";
import type { TraceFact } from "../src/trace-attrs.js";
import * as mirror from "./helpers/gilbTraceMirror.js";

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

const PIECES = ["", " ", "   ", "a", "62 %", "https://host.example/base/e/ABC123", "tolerable", "say \"hi\"", "it's", "<b>&amp;</b>", "line1\nline2", "tab\there",
  "éè", "中文", "😀", "0", "-1.5", "  padded  ", "x".repeat(300), "=", "[a]"];
const pick = (rnd: () => number): string => PIECES[Math.floor(rnd() * PIECES.length)]!;
const randStr = (rnd: () => number): string => pick(rnd) + (rnd() < 0.3 ? pick(rnd) : "");

/** A fake element: only what the reader uses. */
function fakeEl(attrs: Record<string, string>, text = ""): Element {
  return { getAttribute: (n: string) => (Object.prototype.hasOwnProperty.call(attrs, n) ? attrs[n]! : null), textContent: text } as unknown as Element;
}

describe("trace writer", () => {
  // Spec: Parts.Trace, Writer parity: the kit's writer equals the application's own writer for any fact (LiveWire step, check 9 Trace.SourceField)
  test("W1 writer parity with the application's writer, 500 seeded facts", () => {
    const rnd = seeded(20261119);
    for (let i = 0; i < 500; i++) {
      const fact: TraceFact = rnd() < 0.1
        ? { ref: null, shown: randStr(rnd) }
        : { ref: { entityUri: randStr(rnd), field: randStr(rnd), ...(rnd() < 0.5 ? { recordId: randStr(rnd), raw: randStr(rnd) } : {}) }, shown: randStr(rnd) };
      expect(traceAttrs(fact), `fact ${i}`).toEqual(mirror.traceAttrsStub(fact));
    }
  });

  // Spec: Parts.Trace, Contract: entity is the full address, field the bare slug, value the displayed text (LiveWire step, check 9 Trace.SourceField)
  test("W2 contract: full address, bare slug, displayed text", () => {
    const attrs = traceAttrs({
      ref: { entityUri: "https://host.example/base/e/ABC123", field: "tolerable", recordId: "ABC123", raw: "50" },
      shown: "62 %",
    });
    expect(attrs).toStrictEqual({
      "data-live-entity": "https://host.example/base/e/ABC123",
      "data-live-field": "tolerable",
      "data-live-value": "62 %",
    });
    expect(attrs!["data-live-entity"]).not.toBe("ABC123");
    expect(attrs!["data-live-field"]).not.toContain("/");
    expect(attrs!["data-live-value"]).not.toBe("50");
    // Exactly three keys: nothing else is written onto the element.
    expect(Object.keys(attrs!)).toHaveLength(3);
  });

  // Spec: Parts.Trace, Names: the attribute names are fixed and spelled in one constant
  test("W3 attribute names and the no-data words", () => {
    expect(TRACE_ATTR).toStrictEqual({ entity: "data-live-entity", field: "data-live-field", value: "data-live-value" });
    expect(Object.values(TRACE_ATTR).sort()).toEqual(["data-live-entity", "data-live-field", "data-live-value"]);
    const attrs = traceAttrs({ ref: { entityUri: "e", field: "f" }, shown: "v" })!;
    expect(Object.keys(attrs).sort()).toEqual(Object.values(TRACE_ATTR).sort());
    expect(NO_DATA_TEXT).toBe("no data");
  });

  // Spec: Parts.Trace, No source no trace: a fact with no source gets no attributes; bad strings are written as is so the reader reports them
  test("W4 null or undefined ref gives null; empty entity or field is written as is", () => {
    expect(traceAttrs({ ref: null, shown: "5" })).toBeNull();
    expect(traceAttrs({ ref: undefined, shown: "5" } as unknown as TraceFact)).toBeNull();
    expect(traceAttrs(undefined as unknown as TraceFact)).toBeNull();
    expect(traceAttrs(null as unknown as TraceFact)).toBeNull();
    const empty = traceAttrs({ ref: { entityUri: "", field: "" }, shown: "5" });
    expect(empty).toStrictEqual({ "data-live-entity": "", "data-live-field": "", "data-live-value": "5" });
    // The reader then reports it: a loud failure.
    expect(readTraceAttrs(fakeEl(empty!))).toBeNull();
  });

  // Spec: Parts.Trace, Displayed text: the value is the text exactly, never trimmed, cut or changed
  test("W5 the value is the shown text exactly", () => {
    for (const shown of ["  62 %  ", "a\nb", "x".repeat(5000), " ", ""]) {
      expect(traceAttrs({ ref: { entityUri: "e", field: "f", raw: "RAW" }, shown })!["data-live-value"]).toBe(shown);
    }
  });
});

describe("trace reader", () => {
  const NAMES = [TRACE_ATTR.entity, TRACE_ATTR.field, TRACE_ATTR.value];

  function randomAttrs(rnd: () => number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const n of NAMES) if (rnd() < 0.75) out[n] = randStr(rnd);
    return out;
  }

  // Spec: Parts.Trace, Reader parity: the kit's reader equals the application's reader (LiveWire step, check 9 Trace.SourceField)
  test("R1 reader parity, 500 seeded fake elements; the rules for empty and blank", () => {
    const rnd = seeded(77);
    for (let i = 0; i < 500; i++) {
      const el = fakeEl(randomAttrs(rnd));
      expect(readTraceAttrs(el), `element ${i}`).toEqual(mirror.readTraceAttrs(el));
    }
    // The stated rules, one by one.
    expect(readTraceAttrs(fakeEl({ "data-live-entity": "e", "data-live-field": "f", "data-live-value": "" }))).toEqual({ entity: "e", field: "f", value: "" });
    expect(readTraceAttrs(fakeEl({ "data-live-entity": "", "data-live-field": "f", "data-live-value": "v" }))).toBeNull();
    expect(readTraceAttrs(fakeEl({ "data-live-entity": "   ", "data-live-field": "f", "data-live-value": "v" }))).toBeNull();
    expect(readTraceAttrs(fakeEl({ "data-live-entity": "e", "data-live-field": "", "data-live-value": "v" }))).toBeNull();
    expect(readTraceAttrs(fakeEl({ "data-live-entity": "e", "data-live-field": " \n ", "data-live-value": "v" }))).toBeNull();
    expect(readTraceAttrs(fakeEl({ "data-live-entity": "e", "data-live-field": "f" }))).toBeNull();
    // Values are returned untrimmed.
    expect(readTraceAttrs(fakeEl({ "data-live-entity": " e ", "data-live-field": " f ", "data-live-value": " v " }))).toEqual({ entity: " e ", field: " f ", value: " v " });
    // A throwing getAttribute gives null, not an error.
    const bad = { getAttribute: () => { throw new Error("boom"); } } as unknown as Element;
    expect(readTraceAttrs(bad)).toBeNull();
  });

  // Spec: Parts.Trace, Scan parity: every element with any attribute is sorted traced or incomplete, in document order, as in the application
  test("R2 scan parity on a mixed fake root, in document order", () => {
    const rnd = seeded(5);
    const els: Element[] = [];
    for (let i = 0; i < 60; i++) els.push(fakeEl(randomAttrs(rnd), `t${i}`));
    // Make sure both kinds exist, in a known interleaving.
    els.splice(3, 0, fakeEl({ "data-live-entity": "e1", "data-live-field": "f1", "data-live-value": "v1" }, "A"));
    els.splice(4, 0, fakeEl({ "data-live-value": "only value" }, "B"));
    els.splice(5, 0, fakeEl({ "data-live-entity": "e2", "data-live-field": "f2", "data-live-value": "v2" }, "C"));
    const selectors: string[] = [];
    const root = { querySelectorAll: (s: string) => { selectors.push(s); return els; } } as unknown as ParentNode;

    const mine = scanTrace(root);
    const theirs = mirror.scanTrace(root);
    expect(mine.traced.map((t) => t.el)).toEqual(theirs.traced.map((t) => t.el));
    expect(mine.traced.map((t) => t.source)).toEqual(theirs.traced.map((t) => t.source));
    expect(mine.incomplete).toEqual(theirs.incomplete);
    expect(mine.traced.length).toBeGreaterThan(0);
    expect(mine.incomplete.length).toBeGreaterThan(0);
    // Document order: each list is the input list filtered, never reordered. Identity (not deep equality) is checked,
    // because the fake elements can look alike.
    const tracedExpected = els.filter((e) => readTraceAttrs(e) !== null);
    const incompleteExpected = els.filter((e) => readTraceAttrs(e) === null);
    expect(mine.traced.length).toBe(tracedExpected.length);
    mine.traced.forEach((t, i) => expect(t.el === tracedExpected[i], `traced ${i}`).toBe(true));
    expect(mine.incomplete.length).toBe(incompleteExpected.length);
    mine.incomplete.forEach((e, i) => expect(e === incompleteExpected[i], `incomplete ${i}`).toBe(true));
    // Every element is in exactly one list.
    expect(mine.traced.length + mine.incomplete.length).toBe(els.length);
    // The query names all three attributes, so an element with only one of them is still found.
    expect(selectors).toHaveLength(2); // one query by the kit, one by the application's copy
    for (const sel of selectors) for (const n of NAMES) expect(sel).toContain(`[${n}]`);
    expect(selectors[0]).toBe(selectors[1]);
  });

  // Spec: Parts.Trace, Scan: an empty root gives two empty lists, never an error
  test("R3 an empty root scans to nothing", () => {
    const root = { querySelectorAll: () => [] } as unknown as ParentNode;
    expect(scanTrace(root)).toEqual({ traced: [], incomplete: [] });
  });
});
