import { afterEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import type { ReactElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { TracedValue } from "../../src/react/trace.js";
import type { TraceTarget, TracedValueProps } from "../../src/react/trace.js";
import { NO_DATA_TEXT, readTraceAttrs, scanTrace } from "../../src/trace-attrs.js";
import * as mirror from "../helpers/gilbTraceMirror.js";

const guards: Array<() => void> = [];

afterEach(() => {
  cleanup();
  while (guards.length) guards.pop()!();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

const REF = { entityUri: "https://host.example/base/e/ABC123", field: "tolerable", recordId: "ABC123", raw: "50" };

/** Renders one figure and returns the element it produced. */
function show(props: Partial<TracedValueProps>) {
  const view = render(createElement(TracedValue, { source: REF, shown: "62 %", ...props } as TracedValueProps));
  return { view, el: view.container.firstElementChild as HTMLElement };
}

/** Names of the trace attributes on an element (there must be none on a figure that is not traced). */
const traceAttrNames = (el: Element): string[] => Array.from(el.attributes).map((a) => a.name).filter((n) => n.startsWith("data-live"));

/**
 * Stops the page leaving during a click and records, for each click, whether the default action had been prevented by the
 * time the click reached the page body (that is, by the figure's own handlers).
 */
function guardNavigation(): boolean[] {
  const seen: boolean[] = [];
  const listener = (e: Event): void => { seen.push(e.defaultPrevented); e.preventDefault(); };
  document.body.addEventListener("click", listener);
  guards.push(() => document.body.removeEventListener("click", listener));
  return seen;
}

describe("TracedValue: the contract in the page", () => {
  // Spec: Parts.Trace, Contract: entity is the full address, field the bare slug, value the displayed text (LiveWire step, check 9 Trace.SourceField)
  test("TV1 a traced figure carries the three attributes; special characters survive the round trip", () => {
    const { el } = show({});
    expect(el.getAttribute("data-live-entity")).toBe("https://host.example/base/e/ABC123");
    expect(el.getAttribute("data-live-field")).toBe("tolerable");
    expect(el.getAttribute("data-live-value")).toBe("62 %");
    expect(el.textContent).toBe("62 %");
    expect(el.getAttribute("data-live-value")).not.toBe("50");

    const nasty = "say \"hi\" <b>x</b> & 'q'\nline2  ";
    const { el: el2 } = show({ shown: nasty, source: { entityUri: "https://h.example/e?a=1&b=\"2\"", field: "f<1>" } });
    expect(el2.textContent).toBe(nasty);
    expect(readTraceAttrs(el2)).toEqual({ entity: "https://h.example/e?a=1&b=\"2\"", field: "f<1>", value: nasty });
    // The text is not trimmed.
    const { el: el3 } = show({ shown: "  7  " });
    expect(el3.textContent).toBe("  7  ");
    expect(el3.getAttribute("data-live-value")).toBe("  7  ");
  });

  // Spec: Parts.Trace, The loop: what the part writes, the page reader and the application's reader read back identically (LiveWire step, check 9 Trace.SourceField)
  test("TV2 twenty figures: the kit's scan, the application's scan and its fact reader agree", () => {
    const figures: ReactElement[] = [];
    for (let i = 0; i < 20; i++) {
      figures.push(createElement(TracedValue, {
        key: i,
        as: i % 5 === 0 ? "strong" : "span",
        source: { entityUri: `https://host.example/base/e/REC${i}`, field: `field${i % 4}` },
        shown: `${i * 3.5} % "q" <${i}>`,
      }));
    }
    const view = render(createElement("div", null, ...figures));
    const root = view.container;

    const mine = scanTrace(root);
    const theirs = mirror.scanTrace(root);
    expect(mine.traced).toHaveLength(20);
    expect(mine.incomplete).toHaveLength(0);
    expect(theirs.traced).toHaveLength(20);
    expect(theirs.incomplete).toHaveLength(0);
    mine.traced.forEach((t, i) => {
      expect(t.el === theirs.traced[i]!.el).toBe(true);
      expect(t.source).toEqual(theirs.traced[i]!.source);
    });

    const facts = mirror.factsFromDom(root);
    expect(facts).toHaveLength(20);
    facts.forEach((fact, i) => {
      const el = mine.traced[i]!.el;
      expect(fact.ref).toEqual({
        recordId: `REC${i}`,
        entityUri: `https://host.example/base/e/REC${i}`,
        field: `field${i % 4}`,
        raw: fact.shown,
      });
      expect(fact.shown).toBe(el.textContent);
    });
  });

  // Spec: Parts.Trace, Half-traced figures are reported, not skipped: a page with figures and partly traced elements splits as the application's scan does (LiveWire step, check 9 Trace.SourceField)
  test("TV2b partly traced elements land in incomplete, in page order, as in the application's scan", () => {
    const view = render(createElement("div", null,
      createElement(TracedValue, { key: "a", source: REF, shown: "1" }),
      createElement("span", { key: "b", "data-live-value": "5" }),
      createElement(TracedValue, { key: "c", source: REF, shown: "2" }),
      createElement("b", { key: "d", "data-live-entity": "e", "data-live-field": " ", "data-live-value": "1" }),
      createElement("i", { key: "e", "data-live-entity": "e" }),
      createElement(TracedValue, { key: "f", source: REF, shown: "3" }),
    ));
    const mine = scanTrace(view.container);
    const theirs = mirror.scanTrace(view.container);
    expect(mine.traced.map((t) => t.source.value)).toEqual(["1", "2", "3"]);
    expect(mine.incomplete.map((e) => e.tagName)).toEqual(["SPAN", "B", "I"]);
    expect(mine.traced.every((t, i) => t.el === theirs.traced[i]!.el)).toBe(true);
    expect(mine.incomplete.every((e, i) => e === theirs.incomplete[i])).toBe(true);
    expect(theirs.incomplete).toHaveLength(3);
  });
});

describe("TracedValue: no data, no source, failed", () => {
  // Spec: Parts.Trace, Empty source is no data: never a zero, a guess or an old number, and never attributes (LiveWire step)
  test("TV3 empty shown reads no data with no attributes, even with a source", () => {
    for (const shown of [null, undefined, "", "   ", "\n\t "]) {
      const { el, view } = show({ shown: shown as string, link: () => "/x", onOpen: () => {} });
      expect(el.textContent, JSON.stringify(shown)).toBe("no data");
      expect(el.textContent).toBe(NO_DATA_TEXT);
      expect(el.getAttribute("data-trace-state")).toBe("no-data");
      expect(el.className).toContain("gilb-traced");
      expect(el.className).toContain("gilb-traced--no-data");
      expect(traceAttrNames(el)).toEqual([]);
      expect(el.tagName).toBe("SPAN");
      expect(view.container.querySelector("a,button")).toBeNull();
      expect(scanTrace(view.container)).toEqual({ traced: [], incomplete: [] });
      expect(el.textContent).not.toMatch(/0/);
      view.unmount();
    }
    const { el } = show({ shown: "", noDataText: "n/a" });
    expect(el.textContent).toBe("n/a");
    expect(el.getAttribute("data-trace-state")).toBe("no-data");
    // The words are first: an empty figure that also failed or lacks a source is still no data.
    expect(show({ shown: "", failed: true }).el.getAttribute("data-trace-state")).toBe("no-data");
    expect(show({ shown: "", source: null }).el.getAttribute("data-trace-state")).toBe("no-data");
    expect(show({ shown: "", source: null, requireSource: false }).el.getAttribute("data-trace-state")).toBe("no-data");
  });

  // Spec: Parts.Trace, No source no figure: a figure with no source is not shown (LiveWire step)
  test("TV4 no source reads no data with no attributes; requireSource false shows untraced words", () => {
    const missing: Array<TracedValueProps["source"]> = [
      null, undefined,
      { entityUri: "", field: "f" },
      { entityUri: "e", field: "" },
      { entityUri: "   ", field: "f" },
      { entityUri: "e", field: " \n" },
    ];
    for (const source of missing) {
      const { el, view } = show({ source, shown: "62 %" });
      expect(el.textContent, JSON.stringify(source)).toBe("no data");
      expect(el.textContent).not.toContain("62");
      expect(el.getAttribute("data-trace-state")).toBe("no-source");
      expect(traceAttrNames(el)).toEqual([]);
      expect(scanTrace(view.container)).toEqual({ traced: [], incomplete: [] });
      view.unmount();
    }
    expect(show({ source: null, noDataText: "unknown" }).el.textContent).toBe("unknown");

    for (const source of [null, undefined, { entityUri: "", field: "" }] as Array<TracedValueProps["source"]>) {
      const { el, view } = show({ source, shown: "Status words", requireSource: false });
      expect(el.textContent).toBe("Status words");
      expect(el.getAttribute("data-trace-state")).toBe("untraced");
      expect(traceAttrNames(el)).toEqual([]);
      expect(scanTrace(view.container)).toEqual({ traced: [], incomplete: [] });
      view.unmount();
    }
    // With requireSource false and a good source the figure is still traced.
    const traced = show({ requireSource: false });
    expect(traced.el.getAttribute("data-live-entity")).toBe(REF.entityUri);
    expect(traced.el.getAttribute("data-trace-state")).toBeNull();
  });

  // Spec: Parts.Trace, Failed: a figure the check rejected shows its text but claims no source and opens nothing (LiveWire step)
  test("TV5 failed shows the text with data-check failed, no attributes, no link", () => {
    const link = vi.fn(() => "/x");
    const onOpen = vi.fn();
    const { el, view } = show({ failed: true, shown: "check failed", link, onOpen });
    expect(el.textContent).toBe("check failed");
    expect(el.getAttribute("data-check")).toBe("failed");
    expect(traceAttrNames(el)).toEqual([]);
    expect(el.tagName).toBe("SPAN");
    expect(el.hasAttribute("href")).toBe(false);
    expect(view.container.querySelector("a,button")).toBeNull();
    guardNavigation();
    fireEvent.click(el);
    expect(onOpen).not.toHaveBeenCalled();
    expect(scanTrace(view.container)).toEqual({ traced: [], incomplete: [] });
    // Failed comes before the source rule: a failed figure with no source is the failed text, not no data.
    const noSource = show({ failed: true, source: null, shown: "62 %" });
    expect(noSource.el.textContent).toBe("62 %");
    expect(noSource.el.getAttribute("data-check")).toBe("failed");
    expect(traceAttrNames(noSource.el)).toEqual([]);
    // A figure that did not fail carries no failed mark.
    expect(show({}).el.hasAttribute("data-check")).toBe(false);
  });
});

describe("TracedValue: opening the source", () => {
  // Spec: Parts.Trace, Click on every number: what opens is exactly what the attributes say (LiveWire step)
  test("TV6 clicking every traced figure passes the exact entity, field and shown text", () => {
    const builderCalls: TraceTarget[][] = [];
    const openCalls: TraceTarget[][] = [];
    const figures: ReactElement[] = [];
    for (let i = 0; i < 12; i++) {
      builderCalls.push([]);
      openCalls.push([]);
      const source = { entityUri: `https://host.example/base/e/R${i}`, field: `f${i}`, ...(i % 2 === 0 ? { recordId: `R${i}` } : {}) };
      const props: TracedValueProps = { source, shown: `${i * 7} %` };
      if (i < 3) {
        props.link = (t) => { builderCalls[i]!.push(t); return `/open?e=${encodeURIComponent(t.entity)}&f=${t.field}`; };
        props.onOpen = (t) => { openCalls[i]!.push(t); };
      } else if (i < 6) {
        props.onOpen = (t) => { openCalls[i]!.push(t); };
      }
      figures.push(createElement(TracedValue, { key: i, ...props }));
    }
    const view = render(createElement("div", null, ...figures));
    guardNavigation();

    const scan = scanTrace(view.container);
    expect(scan.traced).toHaveLength(12);
    expect(scan.incomplete).toHaveLength(0);
    scan.traced.forEach(({ el, source }, i) => {
      const entity = el.getAttribute("data-live-entity");
      const field = el.getAttribute("data-live-field");
      const shown = el.getAttribute("data-live-value");
      expect(source).toEqual({ entity, field, value: shown });
      fireEvent.click(el);

      if (i < 3) {
        expect(el.tagName, `figure ${i}`).toBe("A");
        expect(el.getAttribute("href")).toBe(`/open?e=${encodeURIComponent(entity!)}&f=${field}`);
        expect(builderCalls[i]!.length).toBeGreaterThan(0);
        for (const t of builderCalls[i]!) expect(t).toStrictEqual({ entity, field, recordId: i % 2 === 0 ? `R${i}` : null, shown });
      } else if (i < 6) {
        expect(el.tagName, `figure ${i}`).toBe("BUTTON");
        expect(el.getAttribute("type")).toBe("button");
        expect(el.hasAttribute("href")).toBe(false);
      }
      if (i < 6) {
        expect(openCalls[i]!, `figure ${i}`).toHaveLength(1);
        expect(openCalls[i]![0]).toStrictEqual({ entity, field, recordId: i % 2 === 0 ? `R${i}` : null, shown });
      } else {
        // A plain figure is not interactive: no handler, no role, no tab stop, no link.
        expect(el.tagName, `figure ${i}`).toBe("SPAN");
        expect((el as HTMLElement).onclick).toBeNull();
        expect(el.hasAttribute("role")).toBe(false);
        expect(el.hasAttribute("tabindex")).toBe(false);
        expect(el.hasAttribute("href")).toBe(false);
        expect(openCalls[i]!).toHaveLength(0);
      }
    });
    expect(view.container.querySelectorAll("a")).toHaveLength(3);
    expect(view.container.querySelectorAll("button")).toHaveLength(3);
  });

  // Spec: Parts.Trace, onOpen decides: calling preventDefault stops the browser; not calling lets it through (LiveWire step)
  test("TV7 onOpen can stop the browser, and not calling it lets the browser follow", () => {
    const seen = guardNavigation();
    const order: string[] = [];

    const stopper = show({ link: () => "/x", onOpen: (_t, e) => { order.push("open"); e.preventDefault(); } });
    fireEvent.click(stopper.el);
    expect(order).toEqual(["open"]);
    expect(seen).toEqual([true]);
    stopper.view.unmount();

    const letter = show({ link: () => "/x", onOpen: () => { order.push("open2"); } });
    fireEvent.click(letter.el);
    expect(order).toEqual(["open", "open2"]);
    expect(seen).toEqual([true, false]);
    letter.view.unmount();

    // A link with no onOpen is left entirely to the browser.
    const bare = show({ link: () => "/x" });
    fireEvent.click(bare.el);
    expect(seen).toEqual([true, false, false]);
    bare.view.unmount();

    // A button: onOpen is called, and its preventDefault is honoured too.
    const button = show({ onOpen: (_t, e) => { e.preventDefault(); } });
    fireEvent.click(button.el);
    expect(seen).toEqual([true, false, false, true]);

    // onOpen is called before the browser acts: when it runs, the default has not been prevented yet.
    const states: boolean[] = [];
    const probe = show({ link: () => "/x", onOpen: (_t, e) => { states.push((e as unknown as Event).defaultPrevented); } });
    fireEvent.click(probe.el);
    expect(states).toEqual([false]);
  });

  // Spec: Parts.Trace, Address safety: only a string that starts like an address becomes a link; a builder's mistake is never a script link (LiveWire step)
  test("TV8 unsafe or wrong addresses are dropped; safe ones are accepted; a throwing builder is harmless", () => {
    const bad: unknown[] = ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.example", "/\\evil.example", "/\t/evil.example",
      "/\n/evil.example", "", " /ok", "\u0000/ok", "ftp://a.example", "mailto:a@b.c", "x/y", 42, {}, true, ["/x"], null, undefined];
    for (const address of bad) {
      const { el, view } = show({ link: () => address as string });
      expect(el.tagName, JSON.stringify(address)).toBe("SPAN");
      expect(el.hasAttribute("href")).toBe(false);
      expect(view.container.querySelector("a")).toBeNull();
      // The figure itself is still shown and traced.
      expect(el.textContent).toBe("62 %");
      expect(el.getAttribute("data-live-entity")).toBe(REF.entityUri);
      view.unmount();
    }
    // With a bad address and an onOpen the figure falls back to a button, never an address.
    const fallback = show({ link: () => "javascript:alert(1)", onOpen: () => {} });
    expect(fallback.el.tagName).toBe("BUTTON");
    expect(fallback.el.hasAttribute("href")).toBe(false);
    fallback.view.unmount();

    for (const address of ["/x", "?a=1", "#f", "https://a.example/x", "http://a.example", "/a/b?c=d#e"]) {
      const { el, view } = show({ link: () => address });
      expect(el.tagName, address).toBe("A");
      expect(el.getAttribute("href")).toBe(address);
      expect(el.getAttribute("data-live-entity")).toBe(REF.entityUri);
      view.unmount();
    }

    const thrower = show({ link: () => { throw new Error("builder broke"); } });
    expect(thrower.el.tagName).toBe("SPAN");
    expect(thrower.el.hasAttribute("href")).toBe(false);
    expect(thrower.el.textContent).toBe("62 %");
    expect(thrower.el.getAttribute("data-live-value")).toBe("62 %");
    thrower.view.unmount();
    // A throwing builder with an onOpen still gives the button.
    const thrower2 = show({ link: () => { throw new Error("builder broke"); }, onOpen: () => {} });
    expect(thrower2.el.tagName).toBe("BUTTON");
  });

  // Spec: Parts.Trace, No address of its own: the kit knows no application address format; the application supplies the builder (LiveWire step)
  test("TV9 the builder gets the target and nothing else; the page address is never read", () => {
    window.history.replaceState(null, "", "/?pf=Z&fld=Q&rec=ABC123&peek=1");
    const link = vi.fn((_t: TraceTarget) => "/custom/path?x=1&y=%20z");
    const { el } = show({ link });
    expect(link).toHaveBeenCalled();
    for (const call of link.mock.calls) {
      expect(call).toHaveLength(1);
      expect(call[0]).toStrictEqual({ entity: REF.entityUri, field: "tolerable", recordId: "ABC123", shown: "62 %" });
    }
    expect(el.getAttribute("href")).toBe("/custom/path?x=1&y=%20z");

    // With no builder there is no link at all, whatever the page address says.
    const plain = show({});
    expect(plain.el.hasAttribute("href")).toBe(false);
    expect(plain.el.tagName).toBe("SPAN");
    expect(plain.view.container.innerHTML).not.toContain("pf=");
    expect(plain.view.container.innerHTML).not.toContain("peek");
  });
});

describe("TracedValue: words, labels and element types", () => {
  const HIDDEN = (el: Element | null): boolean => {
    const s = (el as HTMLElement | null)?.style;
    return !!s && s.position === "absolute" && s.width === "1px" && s.height === "1px" && s.overflow === "hidden";
  };

  // Spec: Parts.Trace, Screen readers: a hidden suffix names the figure; the attribute stays the displayed number only
  test("TV10 srLabel, title and openLabel", () => {
    const { el, view } = show({ srLabel: "(Status)" });
    const spans = el.querySelectorAll("span");
    expect(spans).toHaveLength(1);
    expect(HIDDEN(spans[0]!)).toBe(true);
    expect(spans[0]!.textContent).toContain("(Status)");
    expect(el.firstChild!.textContent).toBe("62 %");
    expect(el.textContent).toBe("62 % (Status)");
    expect(el.getAttribute("data-live-value")).toBe("62 %");
    expect(scanTrace(view.container).traced[0]!.source.value).toBe("62 %");
    // Nothing but the displayed text is visible: no title on a plain figure.
    expect(el.hasAttribute("title")).toBe(false);
    view.unmount();

    // A link gets a title (default the open words), a hidden open label, and a name that contains the figure.
    const link = show({ link: () => "/x", srLabel: "(Status)" });
    expect(link.el.getAttribute("title")).toBe("Open the source of this figure");
    const hidden = Array.from(link.el.querySelectorAll("span")).filter((s) => HIDDEN(s));
    expect(hidden).toHaveLength(2);
    expect(hidden[1]!.textContent).toContain("Open the source of this figure");
    expect(link.el.getAttribute("data-live-value")).toBe("62 %");
    expect(link.view.getByRole("link", { name: /62 %/ })).toBe(link.el);
    link.view.unmount();

    const custom = show({ onOpen: () => {}, title: "Go to record", openLabel: "Open record" });
    expect(custom.el.tagName).toBe("BUTTON");
    expect(custom.el.getAttribute("title")).toBe("Go to record");
    expect(custom.el.textContent).toContain("Open record");
    expect(custom.el.textContent!.startsWith("62 %")).toBe(true);
    expect(custom.view.getByRole("button", { name: /62 %/ })).toBe(custom.el);
    custom.view.unmount();

    const onlyLabel = show({ onOpen: () => {}, openLabel: "See where this comes from" });
    expect(onlyLabel.el.getAttribute("title")).toBe("See where this comes from");
    onlyLabel.view.unmount();

    // A title given to a plain figure is passed on; the className is kept.
    const plain = show({ title: "Tolerable level", className: "mine" });
    expect(plain.el.getAttribute("title")).toBe("Tolerable level");
    expect(plain.el.className).toContain("mine");
    expect(plain.el.className).toContain("gilb-traced");
  });

  // Spec: Parts.Trace, Robust: wrong inputs never throw
  test("TV11 junk props never throw", () => {
    expect(() => show({ source: { entityUri: "e", field: undefined } as unknown as TracedValueProps["source"] })).not.toThrow();
    expect(show({ source: { entityUri: "e", field: undefined } as unknown as TracedValueProps["source"] }).el.getAttribute("data-trace-state")).toBe("no-source");
    expect(show({ source: { entityUri: 5, field: {} } as unknown as TracedValueProps["source"] }).el.getAttribute("data-trace-state")).toBe("no-source");
    expect(show({ source: "abc" as unknown as TracedValueProps["source"] }).el.getAttribute("data-trace-state")).toBe("no-source");

    const num = show({ shown: 123 as unknown as string });
    expect(num.el.textContent).toBe("123");
    expect(num.el.getAttribute("data-live-value")).toBe("123");
    const zero = show({ shown: 0 as unknown as string });
    expect(zero.el.textContent).toBe("0");
    expect(zero.el.getAttribute("data-live-value")).toBe("0");

    expect(() => render(createElement(TracedValue, {} as unknown as TracedValueProps))).not.toThrow();
    expect(show({ link: "nope" as unknown as TracedValueProps["link"] }).el.tagName).toBe("SPAN");
    expect(show({ onOpen: "nope" as unknown as TracedValueProps["onOpen"] }).el.tagName).toBe("SPAN");
    expect(show({ noDataText: 5 as unknown as string, shown: "" }).el.textContent).toBe("no data");
  });

  // Spec: Parts.Trace, Element types: the five named kinds render that tag; anything else is a span
  test("TV12 the as element types", () => {
    const wrap: Record<string, (child: ReactElement) => ReactElement> = {
      td: (c) => createElement("table", null, createElement("tbody", null, createElement("tr", null, c))),
      dd: (c) => createElement("dl", null, c),
    };
    for (const as of ["span", "td", "dd", "strong", "output"] as const) {
      const child = createElement(TracedValue, { source: REF, shown: "62 %", as });
      const view = render(wrap[as] ? wrap[as]!(child) : child);
      const el = view.container.querySelector("[data-live-entity]")!;
      expect(el.tagName.toLowerCase(), as).toBe(as);
      view.unmount();
    }
    for (const as of ["div", "script", "a", "button", "marquee", 5, null, ""]) {
      const { el } = show({ as: as as unknown as "span" });
      expect(el.tagName, String(as)).toBe("SPAN");
    }
    // The element type also applies to the no-data words.
    const view = render(createElement("dl", null, createElement(TracedValue, { source: null, shown: "", as: "dd" })));
    expect(view.container.querySelector("dd")!.textContent).toBe("no data");
  });
});
