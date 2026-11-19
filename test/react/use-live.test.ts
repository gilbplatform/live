import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { StrictMode, createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { useLive } from "../../src/react/use-live.js";
import type { UseLiveOptions, UseLiveResult } from "../../src/react/use-live.js";
import { createMemoryCache } from "../../src/state-cache.js";
import { ORIGIN, TYPES, VAULT, deferred, fakeTransportFactory, headBody, json } from "../helpers/clientRig.js";
import type { Deferred } from "../helpers/clientRig.js";
import { T0, TYPE, cur, ent, n, row } from "../helpers/liveKit.js";
import type { Rec } from "../helpers/liveKit.js";

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** UL9, for every test: React printed no warning (an update outside act, or on an unmounted component). */
function noReactWarnings(): void {
  const bad = errors.mock.calls.filter((c: unknown[]) => /warning|not wrapped in act|unmounted|can't perform/i.test(String(c[0])));
  expect(bad).toEqual([]);
}

interface Setup {
  events: string[];
  factory: ReturnType<typeof fakeTransportFactory>;
  versions: Map<string, string>;
  fetchCalls: string[];
  opts: UseLiveOptions<Rec>;
  headGate: { current: Deferred<void> | null };
  resyncGate: { current: Deferred<void> | null };
  push(name: string, v: string, i?: number): void;
}

function setup(extra: Partial<UseLiveOptions<Rec>> = {}): Setup {
  const events: string[] = [];
  const factory = fakeTransportFactory(events);
  const versions = new Map<string, string>();
  const fetchCalls: string[] = [];
  const headGate: Setup["headGate"] = { current: null };
  const resyncGate: Setup["resyncGate"] = { current: null };
  let seq = 0;
  const opts: UseLiveOptions<Rec> = {
    origin: ORIGIN,
    vaultId: VAULT,
    types: TYPES,
    auth: () => ({ authorization: "Bearer t" }),
    read: async ({ entity }) => {
      const v = versions.get(entity);
      return v === undefined ? null : { record: { entityUri: entity, v }, etag: v };
    },
    resync: async () => {
      if (resyncGate.current) await resyncGate.current.promise;
      return [row("A", "v1"), row("B", "v1")];
    },
    createTransport: factory.create,
    fetch: (async (url: string | URL | Request) => {
      fetchCalls.push(String(url));
      if (headGate.current) await headGate.current.promise;
      return json(200, headBody());
    }) as typeof fetch,
    holdMs: 0,
    keyOf: (r) => r.entityUri,
    ...extra,
  };
  return {
    events, factory, versions, fetchCalls, opts, headGate, resyncGate,
    push(name, v, i = 0) {
      seq++;
      versions.set(ent(name), v);
      const tr = factory.created[i];
      if (!tr) throw new Error("no transport");
      tr.ctx.store.push(n(name, 1000 * seq, v, "change", cur(seq)));
    },
  };
}

const advance = (ms: number): Promise<void> => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

function mount(options: UseLiveOptions<Rec>, strict = false) {
  const results: Array<UseLiveResult<Rec>> = [];
  function Probe(props: { options: UseLiveOptions<Rec> }) {
    const r = useLive(props.options);
    results.push(r);
    return createElement("span", null, String(r.records.length));
  }
  const view = render(createElement(Probe, { options }), strict ? { wrapper: StrictMode } : undefined);
  return {
    results,
    last: (): UseLiveResult<Rec> => results.at(-1)!,
    rerender: (o: UseLiveOptions<Rec>) => view.rerender(createElement(Probe, { options: o })),
    unmount: () => view.unmount(),
  };
}

describe("useLive: one connection per mount", () => {
  // Spec: Kit.React, Lifecycle: mount starts exactly one client and one transport; unmount stops it and leaves no timer (check UL1)
  test("UL1 mount starts one client and one transport; unmount stops it and leaves no timer", async () => {
    const s = setup();
    const m = mount(s.opts);
    await advance(10);
    expect(s.factory.created).toHaveLength(1);
    expect(s.factory.created[0]!.started).toBe(1);
    expect(s.fetchCalls).toHaveLength(1);
    expect(m.last().records).toHaveLength(2);
    m.unmount();
    await advance(10);
    expect(s.factory.created[0]!.stops).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    noReactWarnings();
  });

  // Spec: Kit.React, StrictMode: never two live transports; the first stops before the second is made (check UL2)
  test("UL2 under StrictMode there is never more than one live transport, and the first is stopped before a second is made", async () => {
    const s = setup();
    s.factory.holdStops = true;
    const m = mount(s.opts, true);
    await advance(10);
    // Whatever was made, no second one exists while the first is still open.
    expect(s.factory.maxLive).toBeLessThanOrEqual(1);
    for (let i = 0; i < s.events.length; i++) {
      if (s.events[i] !== "transport.create" || !s.events.slice(0, i).includes("transport.create")) continue;
      expect(s.events.slice(0, i)).toContain("transport.stopped");
    }
    s.factory.created.forEach((t) => t.settleStop());
    await advance(10);
    expect(s.factory.created.length - s.factory.created.filter((t) => t.settled).length).toBeLessThanOrEqual(1);
    expect(s.factory.created.length).toBe(1);
    m.unmount();
    s.factory.created.forEach((t) => t.settleStop());
    await advance(10);
    expect(s.factory.created.every((t) => t.settled)).toBe(true);
    noReactWarnings();
  });
});

describe("useLive: renders", () => {
  // Spec: Kit.React, Delivery: a burst of changes inside one period renders the list once (check UL3)
  test("UL3 a burst of 20 changes in one period changes the list once, with 20 more records", async () => {
    const s = setup();
    const m = mount(s.opts);
    await advance(10);
    await advance(300);
    expect(m.last().records).toHaveLength(2);
    const before = m.results.length;
    const seenLists = new Set<unknown>(m.results.map((r) => r.records));
    // One change every 10 ms: each is its own act, so a render per change could not hide inside one batch.
    for (let i = 0; i < 20; i++) {
      await act(async () => { s.push(`N${i}`, "v1"); });
      await advance(10);
    }
    expect(m.last().records).toHaveLength(2);
    await advance(300);
    expect(m.last().records).toHaveLength(22);
    const newLists = new Set(m.results.slice(before).map((r) => r.records));
    // Exactly one new list reached the component, and the render that showed it showed all 20.
    expect([...newLists].filter((l) => !seenLists.has(l))).toHaveLength(1);
    expect(m.results.slice(before).filter((r) => r.records.length === 22).length).toBeGreaterThanOrEqual(1);
    expect(m.results.slice(before).some((r) => r.records.length > 2 && r.records.length < 22)).toBe(false);
    noReactWarnings();
  });

  // Spec: Kit.React, Pause: pause holds the list still, waiting counts, resume renders the merged list once (check UL4)
  test("UL4 pause holds records, waiting and paused update, resume renders once with the merged list", async () => {
    const s = setup();
    const m = mount(s.opts);
    await advance(10);
    await advance(300);
    const held = m.last().records;
    await act(async () => { m.last().pause(); });
    expect(m.last().paused).toBe(true);
    for (let i = 0; i < 3; i++) {
      await act(async () => { s.push(`P${i}`, "v1"); });
      await advance(300);
    }
    expect(m.last().records).toBe(held);
    expect(m.last().records).toHaveLength(2);
    expect(m.last().waiting).toBe(3);
    expect(m.last().paused).toBe(true);
    expect(m.last().dot.kind).toBe("paused");
    const before = m.results.length;
    await act(async () => { m.last().resume(); });
    await advance(10);
    expect(m.last().paused).toBe(false);
    expect(m.last().waiting).toBe(0);
    expect(m.last().records).toHaveLength(5);
    expect(new Set(m.results.slice(before).map((r) => r.records)).size).toBe(1);
    noReactWarnings();
  });

  // Spec: Kit.React, Identity: the control functions and the list keep their identity between unrelated renders (check UL12)
  test("UL12 pause, resume, setKeepLive and the records array keep their identity between unrelated renders", async () => {
    const s = setup();
    const m = mount(s.opts);
    await advance(10);
    await advance(300);
    const a = m.last();
    m.rerender({ ...s.opts });
    m.rerender({ ...s.opts });
    const b = m.last();
    expect(b.pause).toBe(a.pause);
    expect(b.resume).toBe(a.resume);
    expect(b.setKeepLive).toBe(a.setKeepLive);
    expect(b.records).toBe(a.records);
    expect(b).toBe(a);
    // The dot moves (not the list): the list keeps its identity.
    await act(async () => { s.factory.created[0]!.ctx.onState({ state: "live", mode: "stream" }); });
    expect(m.last().dot.kind).toBe("live");
    expect(m.last().records).toBe(a.records);
    expect(m.last().pause).toBe(a.pause);
    noReactWarnings();
  });
});

describe("useLive: state", () => {
  // Spec: Kit.React, Dot: the dot follows the transport's reports (check UL5)
  test("UL5 dot follows transport states", async () => {
    const s = setup();
    const m = mount(s.opts);
    await advance(10);
    expect(m.last().dot.kind).toBe("connecting");
    const ctx = s.factory.created[0]!.ctx;
    await act(async () => { ctx.onState({ state: "live", mode: "stream" }); });
    expect(m.last().dot).toMatchObject({ kind: "live", showLive: true });
    await act(async () => { ctx.onState({ state: "reconnecting", cause: "cut", retryInMs: 5000 }); });
    expect(m.last().dot).toMatchObject({ kind: "reconnecting", showLive: false });
    await act(async () => { ctx.onState({ state: "stopped", cause: "revoked" }); });
    expect(m.last().dot).toMatchObject({ kind: "stopped", cause: "access_removed" });
    expect(m.last().asOf).toBe(m.last().dot.asOf);
    noReactWarnings();
  });

  // Spec: Kit.React, Switch: a new vault stops the old client first and clears the old list (check UL6)
  test("UL6 changing vaultId stops the old client before starting the new one and clears the old records", async () => {
    const s = setup();
    s.factory.holdStops = true;
    const m = mount(s.opts);
    await advance(10);
    expect(m.last().records).toHaveLength(2);
    const oldClient = m.last().client;
    m.rerender({ ...s.opts, vaultId: "vault-2" });
    await advance(10);
    // The old list is gone at once, even though the old transport's stop is still pending and no new client has started.
    expect(m.last().records).toHaveLength(0);
    expect(m.last().ready).toBe(false);
    expect(s.factory.created).toHaveLength(1);
    s.factory.created[0]!.settleStop();
    await advance(10);
    expect(s.factory.created).toHaveLength(2);
    expect(s.events.indexOf("transport.stopped")).toBeLessThan(s.events.lastIndexOf("transport.create"));
    expect(s.fetchCalls[1]).toContain("vault-2");
    expect(m.last().client).not.toBe(oldClient);
    expect(m.last().records).toHaveLength(2);
    noReactWarnings();
  });

  // Spec: Kit.React, Enabled: false makes no client and no request (check UL7)
  test("UL7 enabled false creates no client and no request; switching it on starts one", async () => {
    const s = setup({ enabled: false });
    const m = mount(s.opts);
    await advance(50);
    expect(s.fetchCalls).toHaveLength(0);
    expect(s.factory.created).toHaveLength(0);
    expect(m.last().client).toBeNull();
    expect(m.last().dot.showLive).toBe(false);
    m.rerender({ ...s.opts, enabled: true });
    await advance(10);
    expect(s.fetchCalls).toHaveLength(1);
    expect(s.factory.created).toHaveLength(1);
    expect(m.last().records).toHaveLength(2);
    m.rerender({ ...s.opts, enabled: false });
    await advance(10);
    expect(s.factory.created[0]!.stops).toBe(1);
    expect(m.last().records).toHaveLength(0);
    noReactWarnings();
  });

  // Spec: Kit.React, Restore: a restored list shows at once and is stale until the first full change (check UL8)
  test("UL8 a restored cache shows stale true and the cached rows at once, then false after a full change", async () => {
    const cache = createMemoryCache<Rec>();
    await cache.save({
      version: 1, scope: "s1", savedAt: Date.now(), cursor: cur(500),
      rows: [{ entity: ent("A"), typeUri: TYPE, etag: "v0", updatedAt: null, record: { entityUri: ent("A"), v: "v0" } }],
    });
    const s = setup({ cache, cacheScope: "s1" });
    const m = mount(s.opts);
    await advance(10);
    expect(m.last().stale).toBe(true);
    expect(m.last().records.map((r) => r.v)).toEqual(["v0"]);
    expect(m.last().ready).toBe(true);
    expect(s.fetchCalls).toHaveLength(0);
    await act(async () => { await s.factory.created[0]!.ctx.resync("bad_cursor"); });
    expect(m.last().stale).toBe(false);
    expect(m.last().records).toHaveLength(2);
    noReactWarnings();
  });

  // Spec: Kit.React, Restore: a quiet confirmation (no new list) also makes a restored list fresh, and the hook hears it (check UL8)
  test("UL8b a restored list becomes fresh through a confirmation alone, and the hook follows", async () => {
    const cache = createMemoryCache<Rec>();
    await cache.save({
      version: 1, scope: "s1", savedAt: Date.now(), cursor: cur(500),
      rows: [{ entity: ent("A"), typeUri: TYPE, etag: "v0", updatedAt: null, record: { entityUri: ent("A"), v: "v0" } }],
    });
    const s = setup({ cache, cacheScope: "s1" });
    const m = mount(s.opts);
    await advance(10);
    expect(m.last().stale).toBe(true);
    await advance(3500);
    await act(async () => { s.factory.created[0]!.ctx.onConfirm(Date.now()); });
    expect(m.last().stale).toBe(false);
    expect(m.last().records.map((r) => r.v)).toEqual(["v0"]);
    noReactWarnings();
  });

  // Spec: Kit.React, Ready: ready turns true with the first full list (check UL10)
  test("UL10 ready is false before the first full change and true after", async () => {
    const s = setup();
    const gate = deferred();
    s.resyncGate.current = gate;
    const m = mount(s.opts);
    await advance(10);
    expect(m.last().ready).toBe(false);
    expect(m.last().records).toHaveLength(0);
    await act(async () => { gate.resolve(); });
    await advance(10);
    expect(m.last().ready).toBe(true);
    expect(m.last().records).toHaveLength(2);
    noReactWarnings();
  });

  // Spec: Kit.React, Honest start: a failed start is shown as offline, never as connecting for ever (check UL13)
  test("UL13 a failed start shows offline with a cause and no unhandled rejection", async () => {
    const s = setup({ fetch: (async () => { throw new Error("secret-url-detail"); }) as typeof fetch });
    const m = mount(s.opts);
    await advance(10);
    expect(m.last().dot).toMatchObject({ kind: "offline", showLive: false, cause: "could_not_load" });
    expect(s.factory.created).toHaveLength(0);
    noReactWarnings();
  });
});

describe("useLive: options and unmount", () => {
  // Spec: Kit.React, Latest options: a changed callback is used at once and does not restart the connection (check UL11)
  test("UL11 a new read function does not restart the client, and the new one is the one used", async () => {
    const s = setup();
    const m = mount(s.opts);
    await advance(10);
    const client = m.last().client;
    const readNew = vi.fn(async ({ entity }: { entity: string }) => ({ record: { entityUri: entity, v: "from-new-read" }, etag: "e9" }));
    m.rerender({ ...s.opts, read: readNew, auth: () => ({ authorization: "Bearer other" }) });
    await advance(10);
    expect(s.factory.created).toHaveLength(1);
    expect(s.fetchCalls).toHaveLength(1);
    expect(m.last().client).toBe(client);
    expect(s.factory.created[0]!.stops).toBe(0);
    await act(async () => { s.push("Z", "ignored"); });
    await advance(300);
    expect(readNew).toHaveBeenCalled();
    expect(m.last().records.find((r) => r.entityUri === ent("Z"))?.v).toBe("from-new-read");
    noReactWarnings();
  });

  // Spec: Kit.React, Warnings: no state change after unmount, none while a start is still in flight (check UL9)
  test("UL9 nothing is rendered or warned after unmount, even with a start in flight", async () => {
    const s = setup();
    const gate = deferred();
    s.headGate.current = gate;
    const m = mount(s.opts);
    await advance(10);
    expect(s.fetchCalls).toHaveLength(1);
    m.unmount();
    const renders = m.results.length;
    await act(async () => { gate.resolve(); });
    await advance(500);
    expect(s.factory.created).toHaveLength(0);
    expect(m.results.length).toBe(renders);
    expect(vi.getTimerCount()).toBe(0);
    noReactWarnings();

    // A mounted one: after unmount a late report from the transport changes nothing.
    const s2 = setup();
    const m2 = mount(s2.opts);
    await advance(10);
    const ctx = s2.factory.created[0]!.ctx;
    m2.unmount();
    await advance(10);
    expect(s2.factory.created[0]!.stops).toBe(1);
    const renders2 = m2.results.length;
    ctx.onState({ state: "live", mode: "stream" });
    ctx.onConfirm(Date.now());
    await advance(500);
    expect(m2.results.length).toBe(renders2);
    noReactWarnings();
  });
});
