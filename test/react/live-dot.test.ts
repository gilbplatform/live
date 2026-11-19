import { afterEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { LIVE_DOT_CSS, LiveDot, useReducedMotion } from "../../src/react/live-dot.js";
import type { LiveDotProps } from "../../src/react/live-dot.js";
import { defaultLabels } from "../../src/react/labels.js";
import type { DotKind, DotState } from "../../src/state.js";

afterEach(() => {
  cleanup();
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
  vi.restoreAllMocks();
});

const KINDS: DotKind[] = ["connecting", "live", "polling", "reconnecting", "offline", "paused", "hidden", "stopped"];

const dot = (kind: DotKind, over: Partial<DotState> = {}): DotState => ({
  kind, showLive: false, asOf: null, ageMs: null, retryAt: null, waiting: 0, owed: 0, cause: null, link: "ok", mode: null, quiet: false, at: 0, ...over,
});

function show(props: LiveDotProps) {
  const view = render(createElement(LiveDot, props));
  const root = view.container.firstElementChild as HTMLElement;
  return {
    view,
    root,
    mark: root.querySelector(".gilb-live-dot__mark") as HTMLElement,
    text: root.querySelector(".gilb-live-dot__text") as HTMLElement,
    style: root.querySelector("style") as HTMLElement,
  };
}

describe("LiveDot: accessibility", () => {
  // Spec: Kit.React, Accessible: a status region, the mark hidden from readers, the words always present (check LD1)
  test("LD1 role status, polite, the mark hidden from screen readers, the text present for every kind without showText", () => {
    for (const kind of KINDS) {
      const { root, mark, text, view } = show({ state: dot(kind, { showLive: kind === "live" }) });
      expect(root.getAttribute("role"), kind).toBe("status");
      expect(root.getAttribute("aria-live"), kind).toBe("polite");
      expect(mark.getAttribute("aria-hidden"), kind).toBe("true");
      expect(text.textContent?.length, kind).toBeGreaterThan(0);
      // The words are not shown to the eye (hidden by the standard clip) but are in the page for a reader.
      expect(text.style.position, kind).toBe("absolute");
      expect(text.style.overflow, kind).toBe("hidden");
      expect(text.style.width, kind).toBe("1px");
      view.unmount();
    }
    const shown = show({ state: dot("offline"), showText: true });
    expect(shown.text.style.position).toBe("");
    expect(shown.text.textContent).toBe("Offline");
  });

  // Spec: Kit.React, Shapes: colour is never the only signal (check LD3)
  test("LD3 data-shape differs for all eight kinds", () => {
    const shapes = new Set<string>();
    for (const kind of KINDS) {
      const { root, view } = show({ state: dot(kind, { showLive: true }) });
      shapes.add(root.getAttribute("data-shape")!);
      view.unmount();
    }
    expect(shapes.size).toBe(8);
    const cross = show({ state: dot("stopped") });
    expect(cross.mark.textContent).toBe("×");
  });

  // Spec: Kit.React, Sheet: the style element holds exactly the constant text (check LD13)
  test("LD13 the style element contains only the constant text", () => {
    const { root, style } = show({ state: dot("live", { showLive: true }) });
    expect(style.textContent).toBe(LIVE_DOT_CSS);
    expect(root.querySelectorAll("style")).toHaveLength(1);
    expect(style.children).toHaveLength(0);
  });

  // Spec: Kit.React, Sheet: the stylesheet has the keyframes and the reduced-motion rule (check LD11)
  test("LD11 the stylesheet has the keyframes and the reduced-motion rule", () => {
    expect(LIVE_DOT_CSS).toContain("@keyframes");
    expect(LIVE_DOT_CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.gilb-live-dot__mark\s*\{\s*animation:\s*none\s*!important/);
  });
});

describe("LiveDot: the word Live", () => {
  // Spec: Kit.React, NeverLive: the word live appears only with a recent confirmation (check LD2)
  test("LD2 the default text says live only when showLive is true", () => {
    for (const kind of KINDS) {
      for (const showLive of [true, false]) {
        const { text, root, view } = show({ state: dot(kind, { showLive, cause: kind === "stopped" ? "access_removed" : null }) });
        const says = /live/i.test(text.textContent ?? "");
        const mayClaim = (kind === "live" || kind === "polling") && showLive;
        expect(says, `${kind} showLive=${showLive}: ${text.textContent}`).toBe(mayClaim);
        expect(root.getAttribute("data-live")).toBe(String(mayClaim));
        view.unmount();
      }
    }
    expect(show({ state: dot("live", { showLive: false }) }).text.textContent).toBe("Checking");
    expect(show({ state: dot("polling", { showLive: false }) }).text.textContent).toBe("Checking");
    expect(show({ state: dot("live", { showLive: true }) }).text.textContent).toBe("Live");
  });

  // Spec: Kit.React, NeverLive: an app's own label cannot claim live without a confirmation (check LD10)
  test("LD10 labels override, but a custom live label is never used when showLive is false", () => {
    const labels = { live: "ALIVE-CUSTOM", polling: () => "ALIVE-POLL", offline: (s: DotState) => `custom offline ${s.waiting}`, connecting: "Starting" };
    expect(show({ state: dot("live", { showLive: true }), labels }).text.textContent).toBe("ALIVE-CUSTOM");
    expect(show({ state: dot("polling", { showLive: true }), labels }).text.textContent).toBe("ALIVE-POLL");
    expect(show({ state: dot("live", { showLive: false }), labels }).text.textContent).toBe("Checking");
    expect(show({ state: dot("polling", { showLive: false }), labels }).text.textContent).toBe("Checking");
    expect(show({ state: dot("offline", { waiting: 3 }), labels }).text.textContent).toBe("custom offline 3");
    expect(show({ state: dot("connecting"), labels }).text.textContent).toBe("Starting");
    expect(show({ state: dot("live", { showLive: false }), labels: { checking: "Hold on" } }).text.textContent).toBe("Hold on");
  });

  // Spec: Kit.React, Robust: an unknown kind does not throw and reads as connecting (check LD12)
  test("LD12 an unknown kind does not throw and shows the connecting label", () => {
    const { root, text } = show({ state: dot("bogus" as DotKind, { showLive: true }) });
    expect(text.textContent).toBe("Connecting");
    expect(root.getAttribute("data-state")).toBe("connecting");
    expect(root.getAttribute("data-shape")).toBe("hollow");
    expect(root.getAttribute("data-motion")).toBe("still");
    const thrower = show({ state: dot("offline"), labels: { offline: () => { throw new Error("boom"); } } });
    expect(thrower.text.textContent).toBe("Offline");
  });
});

describe("LiveDot: motion", () => {
  // Spec: Kit.React, Motion: pulse only with confirmation and no reduced-motion request (check LD4)
  test("LD4 pulse only for showLive with reduced motion off; still otherwise, with no animation class", () => {
    const on = show({ state: dot("live", { showLive: true }), reducedMotion: false });
    expect(on.root.getAttribute("data-motion")).toBe("pulse");
    expect(on.root.className).toContain("gilb-live-dot--pulse");
    const poll = show({ state: dot("polling", { showLive: true }), reducedMotion: false });
    expect(poll.root.getAttribute("data-motion")).toBe("pulse");
    for (const kind of ["paused", "reconnecting", "offline", "hidden", "stopped", "connecting"] as DotKind[]) {
      // Even a state that wrongly claims a confirmation does not pulse for these kinds.
      for (const showLive of [false, true]) {
        const s = show({ state: dot(kind, { showLive }), reducedMotion: false });
        expect(s.root.getAttribute("data-motion"), `${kind} ${showLive}`).toBe("still");
        expect(s.root.className, kind).not.toContain("pulse");
        expect(s.mark.style.animation, kind).toBe("");
        s.view.unmount();
      }
    }
    const unconfirmed = show({ state: dot("live", { showLive: false }), reducedMotion: false });
    expect(unconfirmed.root.getAttribute("data-motion")).toBe("still");
    const reduced = show({ state: dot("live", { showLive: true }), reducedMotion: true });
    expect(reduced.root.getAttribute("data-motion")).toBe("still");
    expect(reduced.root.className).not.toContain("pulse");
    expect(reduced.mark.style.animation).toBe("");
  });

  // Spec: Kit.React, Motion: the reader's setting is read, followed, and released (check LD5)
  test("LD5 useReducedMotion reads matchMedia, follows its change event, and removes the listener on unmount", () => {
    const listeners = new Set<() => void>();
    const mq = {
      matches: true,
      addEventListener: vi.fn((_t: string, fn: () => void) => { listeners.add(fn); }),
      removeEventListener: vi.fn((_t: string, fn: () => void) => { listeners.delete(fn); }),
    };
    (globalThis as { matchMedia?: unknown }).matchMedia = vi.fn(() => mq);
    const seen: boolean[] = [];
    function Probe() {
      const r = useReducedMotion();
      seen.push(r);
      return null;
    }
    const view = render(createElement(Probe));
    expect(seen.at(-1)).toBe(true);
    expect(listeners.size).toBe(1);
    act(() => { mq.matches = false; for (const fn of [...listeners]) fn(); });
    expect(seen.at(-1)).toBe(false);
    act(() => { mq.matches = true; for (const fn of [...listeners]) fn(); });
    expect(seen.at(-1)).toBe(true);
    // The dot follows the setting when no prop is given.
    const d = show({ state: dot("live", { showLive: true }) });
    expect(d.root.getAttribute("data-motion")).toBe("still");
    d.view.unmount();
    expect(listeners.size).toBe(1);
    view.unmount();
    expect(listeners.size).toBe(0);
    expect(mq.removeEventListener).toHaveBeenCalled();

    delete (globalThis as { matchMedia?: unknown }).matchMedia;
    const seen2: boolean[] = [];
    function Probe2() { seen2.push(useReducedMotion()); return null; }
    render(createElement(Probe2));
    expect(seen2.at(-1)).toBe(false);
    expect(show({ state: dot("live", { showLive: true }) }).root.getAttribute("data-motion")).toBe("pulse");
  });
});

describe("LiveDot: the words", () => {
  // Spec: Kit.React, Words: the reconnect countdown (check LD6)
  test("LD6 reconnecting text counts seconds from retryAt and now, at least 1, plain with no retryAt", () => {
    const now = () => 1_000_000;
    expect(show({ state: dot("reconnecting", { retryAt: 1_008_000 }), now }).text.textContent).toBe("Reconnecting in 8 seconds");
    expect(show({ state: dot("reconnecting", { retryAt: 1_007_100 }), now }).text.textContent).toBe("Reconnecting in 8 seconds");
    expect(show({ state: dot("reconnecting", { retryAt: 1_000_200 }), now }).text.textContent).toBe("Reconnecting in 1 second");
    expect(show({ state: dot("reconnecting", { retryAt: 900_000 }), now }).text.textContent).toBe("Reconnecting in 1 second");
    expect(show({ state: dot("reconnecting", { retryAt: null }), now }).text.textContent).toBe("Reconnecting");
  });

  // Spec: Kit.React, Words: the offline text carries the as-of time (check LD7)
  test("LD7 offline text uses formatTime(asOf) and falls back to Offline when asOf is null", () => {
    const formatTime = vi.fn((ms: number) => `T${ms}`);
    expect(show({ state: dot("offline", { asOf: 5000 }), formatTime }).text.textContent).toBe("Offline, showing data as of T5000");
    expect(formatTime).toHaveBeenCalledWith(5000);
    expect(show({ state: dot("offline", { asOf: null }), formatTime }).text.textContent).toBe("Offline");
    expect(show({ state: dot("offline", { asOf: Date.UTC(2026, 10, 19, 14, 2) }) }).text.textContent).toMatch(/^Offline, showing data as of \d/);
  });

  // Spec: Kit.React, Words: the paused text counts what waits (check LD8)
  test("LD8 paused text pluralises", () => {
    expect(show({ state: dot("paused", { waiting: 1 }) }).text.textContent).toBe("Paused, 1 change waiting");
    expect(show({ state: dot("paused", { waiting: 7 }) }).text.textContent).toBe("Paused, 7 changes waiting");
    expect(show({ state: dot("paused", { waiting: 0 }) }).text.textContent).toBe("Paused");
    expect(show({ state: dot("hidden") }).text.textContent).toBe("Paused, tab hidden");
  });

  // Spec: Kit.React, Words: a stop says why (check LD9)
  test("LD9 stopped text uses the cause phrase for each cause", () => {
    const phrases: Array<[DotState["cause"], string]> = [
      ["access_removed", "your access was removed"],
      ["no_access", "no access to this vault"],
      ["signed_out", "you are signed out"],
      ["rejected", "the request was refused"],
      ["could_not_load", "the data could not be loaded"],
      ["stopped_by_app", "stopped"],
      ["unknown", "stopped"],
    ];
    for (const [cause, phrase] of phrases) {
      expect(show({ state: dot("stopped", { cause }) }).text.textContent, String(cause)).toBe(`Stopped: ${phrase}`);
    }
    expect(show({ state: dot("stopped", { cause: null }) }).text.textContent).toBe("Stopped: stopped");
    expect(defaultLabels.connecting).toBe("Connecting");
  });
});
