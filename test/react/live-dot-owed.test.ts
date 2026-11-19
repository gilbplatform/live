import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { LiveDot } from "../../src/react/live-dot.js";
import type { LiveDotProps } from "../../src/react/live-dot.js";
import { useLive } from "../../src/react/use-live.js";
import type { UseLiveOptions, UseLiveResult } from "../../src/react/use-live.js";
import type { DotKind, DotState } from "../../src/state.js";
import { ORIGIN, TYPES, VAULT, fakeTransportFactory } from "../helpers/clientRig.js";
import { T0, cur, ent, n, row } from "../helpers/liveKit.js";
import type { Rec } from "../helpers/liveKit.js";

// The dot with owed reads, and the hook that reports the count (batch L14c).

afterEach(() => {
  cleanup();
  delete (globalThis as { matchMedia?: unknown }).matchMedia;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const dot = (kind: DotKind, over: Partial<DotState> = {}): DotState => ({
  kind, showLive: false, asOf: null, ageMs: null, retryAt: null, waiting: 0, cause: null, link: "ok", mode: null, quiet: false, owed: 0, at: 0, ...over,
});

function show(props: LiveDotProps) {
  const view = render(createElement(LiveDot, props));
  const root = view.container.firstElementChild as HTMLElement;
  return {
    view,
    root,
    text: root.querySelector(".gilb-live-dot__text") as HTMLElement,
  };
}

describe("LiveDot with owed reads", () => {
  // Spec: Kit.React, Honesty: an owed dot says what is missing, with no claim of Live (LiveWire step, check 8 Honesty.LiveState)
  test("LO1 a live dot with owed 3 says the changes could not be loaded, is still, and has no 'live' in its words", () => {
    for (const kind of ["live", "polling"] as const) {
      const { root, text, view } = show({ state: dot(kind, { owed: 3, cause: "owed", mode: kind === "live" ? "stream" : "poll" }), reducedMotion: false });
      expect(text.textContent, kind).toBe("3 changes could not be loaded yet");
      expect(root.getAttribute("data-owed"), kind).toBe("3");
      expect(root.getAttribute("data-motion"), kind).toBe("still");
      expect(root.getAttribute("data-live"), kind).toBe("false");
      expect(/live/i.test(text.textContent ?? ""), kind).toBe(false);
      view.unmount();
    }
  });

  test("LO1b even a state that wrongly carries showLive true does not get the live words while owed", () => {
    const { root, text } = show({ state: dot("live", { showLive: true, owed: 2 }), reducedMotion: false });
    expect(/live/i.test(text.textContent ?? "")).toBe(false);
    expect(root.getAttribute("data-motion")).toBe("still");
  });

  test("LO2 with owed 1 the words are singular", () => {
    const { text } = show({ state: dot("live", { owed: 1, cause: "owed" }) });
    expect(text.textContent).toBe("1 change could not be loaded yet");
  });

  test("LO3 labels.owed overrides the words, as a string and as a function of the state", () => {
    const a = show({ state: dot("live", { owed: 3 }), labels: { owed: "Catching up" } });
    expect(a.text.textContent).toBe("Catching up");
    a.view.unmount();
    const b = show({ state: dot("polling", { owed: 4 }), labels: { owed: (s) => `${s.owed} missing` } });
    expect(b.text.textContent).toBe("4 missing");
    b.view.unmount();
    // A function that throws falls back to the default words.
    const c = show({ state: dot("live", { owed: 2 }), labels: { owed: () => { throw new Error("bad label"); } } });
    expect(c.text.textContent).toBe("2 changes could not be loaded yet");
  });

  test("LO4 a dot with showLive true and owed 0 is unchanged", () => {
    const { root, text } = show({ state: dot("live", { showLive: true }), reducedMotion: false });
    expect(text.textContent).toBe("Live");
    expect(root.getAttribute("data-live")).toBe("true");
    expect(root.getAttribute("data-motion")).toBe("pulse");
    expect(root.hasAttribute("data-owed")).toBe(false);
  });

  test("LO4b other kinds keep their own words when records are owed", () => {
    const { text, root } = show({ state: dot("offline", { owed: 5 }) });
    expect(text.textContent).toBe("Offline");
    expect(root.hasAttribute("data-owed")).toBe(false);
  });
});

describe("useLive reports the owed count", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const advance = (ms: number): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  // Spec: Kit.React, Honesty: the hook returns the owed count and keeps it current (check 7 Delivery.Completeness)
  test("LO5 useLive returns owed and updates it", async () => {
    const events: string[] = [];
    const factory = fakeTransportFactory(events);
    let failing = false;
    const opts: UseLiveOptions<Rec> = {
      origin: ORIGIN,
      vaultId: VAULT,
      types: TYPES,
      auth: () => ({ authorization: "Bearer t" }),
      read: async ({ entity }) => {
        if (failing) throw new TypeError("fetch failed");
        return { record: { entityUri: entity, v: "v2" }, etag: "v2" };
      },
      resync: async () => [row("A", "v1")],
      createTransport: factory.create,
      fetch: (async () => new Response(JSON.stringify({ records: [], complete: true, nextCursor: cur(777) }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
      holdMs: 0,
      // Delivered at once: the retry's delay is random (50 to 100 ms), and a 250 ms delivery window on top would make the
      // test's fixed clock steps decide the outcome.
      coalesceMs: 0,
      owedBackoff: { baseMs: 100, capMs: 100 },
      maxReadAttempts: 50,
      keyOf: (r) => r.entityUri,
    };
    const results: Array<UseLiveResult<Rec>> = [];
    function Probe() {
      const r = useLive(opts);
      results.push(r);
      return createElement("span", null, String(r.owed));
    }
    render(createElement(Probe));
    await advance(10);
    const last = (): UseLiveResult<Rec> => results.at(-1) as UseLiveResult<Rec>;
    expect(last().ready).toBe(true);
    expect(last().owed).toBe(0);
    expect(last().dot.owed).toBe(0);

    failing = true;
    (factory.created[0] as { ctx: { store: { push(x: unknown): void } } }).ctx.store.push(n("A", 5000, "v2", "change", cur(5)));
    await advance(10);
    expect(last().owed).toBe(1);
    expect(last().dot.owed).toBe(1);
    expect(last().dot.showLive).toBe(false);
    // More failed retries do not change the count and do not need a new result.
    await advance(300);
    expect(last().owed).toBe(1);

    failing = false;
    await advance(300);
    expect(last().owed).toBe(0);
    expect(last().dot.owed).toBe(0);
    expect(last().records.find((r) => r.entityUri === ent("A"))?.v).toBe("v2");
  });
});
