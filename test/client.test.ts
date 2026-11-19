import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createLiveClient } from "../src/client.js";
import type { LiveClientOptions } from "../src/client.js";
import { applyChange } from "./helpers/applyChange.js";
import { HEAD, ORIGIN, TOKEN, VAULT, deferred, headBody, json, makeRig, startTime, stopAll } from "./helpers/clientRig.js";
import { TYPE, cur, ent, row } from "./helpers/liveKit.js";
import type { Rec } from "./helpers/liveKit.js";

beforeEach(startTime);
afterEach(async () => {
  await stopAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const isDeliver = (e: string): boolean => e.startsWith("deliver");

describe("the headless client: start order", () => {
  // Spec: Kit.Client, StartOrder: restore, head cursor, full read, seed, then the session, from the head cursor (check CL1)
  test("CL1 start() runs restore, head fetch, resync(initial), seed, session start, with the head cursor as from", async () => {
    const rig = makeRig({ cacheScope: "s1" });
    await rig.startAndSettle();
    expect(rig.events).toEqual(["cache.load", "head", "resync:initial", "seed", "deliver:full", "transport.create", "transport.start"]);
    expect(rig.fetchCalls).toHaveLength(1);
    const call = rig.fetchCalls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url).toBe(`${ORIGIN}/lws/vault/${VAULT}/records?since=head&type=Value`);
    expect(call.url).not.toContain(TOKEN);
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(rig.authCalls).toEqual([{ url: call.url, refresh: false }]);
    const ctx = rig.ctx();
    expect(ctx.from).toBe(HEAD);
    expect(ctx.resumeCursor).toBeNull();
    expect(ctx).toMatchObject({ origin: ORIGIN, vaultId: VAULT, types: ["Value"] });
    // Starting twice is the same start.
    expect(rig.client.start()).toBe(rig.client.start());
    expect(rig.factory.created).toHaveLength(1);
  });

  // Spec: Kit.Client, Delivery: the initial list is one full change, then bursts arrive one change per period (check CL2)
  test("CL2 the initial list is one full change; a burst of 20 changes is one change per period", async () => {
    const rig = makeRig();
    await rig.startAndSettle();
    expect(rig.changes).toHaveLength(1);
    expect(rig.changes[0]).toMatchObject({ full: true, ended: [] });
    expect(rig.changes[0]!.records).toHaveLength(2);
    rig.ctx().onState({ state: "live", mode: "stream" });
    for (let i = 0; i < 20; i++) rig.change(`N${i}`, "v1");
    await rig.advance(300);
    expect(rig.changes).toHaveLength(2);
    expect(rig.changes[1]).toMatchObject({ full: false, ended: [] });
    expect(rig.changes[1]!.records).toHaveLength(20);
    for (let i = 0; i < 20; i++) rig.change(`N${i}`, "v2");
    await rig.advance(300);
    expect(rig.changes).toHaveLength(3);
    expect(rig.changes[2]!.records).toHaveLength(20);
  });

  // Spec: Kit.Client, NoGap: the head is taken before the read, and nothing streams until the seed (check CL3)
  test("CL3 a change between the head and the end of the initial read is not lost", async () => {
    const rig = makeRig();
    const head = deferred<Response>();
    const gate = deferred();
    rig.state.respond = () => head.promise;
    rig.state.resyncGate = gate;
    const p = rig.client.start();
    await rig.advance(0);
    // The read must not begin before the head answer: a change made in between would then be in neither.
    expect(rig.events.filter((e) => !isDeliver(e))).toEqual(["head"]);
    head.resolve(json(200, headBody()));
    await rig.advance(0);
    expect(rig.events.filter((e) => !isDeliver(e))).toEqual(["head", "resync:initial"]);
    // And no stream runs while the read is open: the seed would wipe what it delivered.
    expect(rig.factory.created).toHaveLength(0);
    gate.resolve();
    await p;
    expect(rig.factory.created).toHaveLength(1);
    expect(rig.ctx().from).toBe(HEAD);
    // The stream starts at the head, so a change dated after the head arrives after the seed and is kept.
    rig.change("A", "v2");
    await rig.advance(300);
    expect(rig.client.store.get(ent("A"))?.record.v).toBe("v2");
    expect(rig.client.records().find((r) => r.entityUri === ent("A"))?.v).toBe("v2");
    expect(rig.changes.at(-1)!.records.map((r) => r.v)).toEqual(["v2"]);
  });

  // Spec: Kit.Client, PlainFailure: a failed head request is a plain error and starts nothing (check CL4)
  test("CL4 a head fetch failure rejects start() with a plain message, starts no session and leaks no timer", async () => {
    const cases: Array<[string, () => Response | Promise<Response>]> = [
      ["server error", () => json(500, { secret: ORIGIN })],
      ["network error", () => { throw new Error(`connect failed ${ORIGIN} ${TOKEN}`); }],
      ["wrong shape", () => json(200, { nope: true })],
      ["no cursor", () => json(200, headBody(null))],
      ["not json", () => new Response("<html>", { status: 200 })],
    ];
    for (const [label, respond] of cases) {
      const rig = makeRig();
      rig.state.respond = respond;
      const timersBefore = vi.getTimerCount();
      const err = await rig.client.start().then(() => null, (e: unknown) => e);
      expect(err, label).toBeInstanceOf(Error);
      expect((err as Error).message, label).toBe("could not read the starting position");
      expect(rig.factory.created, label).toHaveLength(0);
      expect(rig.resyncCalls, label).toEqual([]);
      expect(vi.getTimerCount(), label).toBe(timersBefore);
      await rig.client.stop();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  // Spec: Kit.Client, AuthRetry: one retry with a fresh token on a 401, then failure (check CL5)
  test("CL5 a 401 on the head request retries once with refresh: true, then fails", async () => {
    const ok = makeRig();
    ok.state.respond = (i) => (i === 0 ? json(401, {}) : json(200, headBody()));
    await ok.startAndSettle();
    expect(ok.authCalls.map((c) => c.refresh)).toEqual([false, true]);
    expect(ok.fetchCalls).toHaveLength(2);
    expect(ok.fetchCalls[1]!.headers.authorization).toBe(`Bearer ${TOKEN}-refreshed`);
    expect(ok.ctx().from).toBe(HEAD);

    const bad = makeRig();
    // A fetch that never stops answering 401 must still end after one retry.
    bad.state.respond = (i) => (i > 8 ? json(500, {}) : json(401, {}));
    const err = await bad.client.start().then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe("could not read the starting position");
    expect(bad.fetchCalls).toHaveLength(2);
    expect(bad.authCalls.map((c) => c.refresh)).toEqual([false, true]);
    expect(bad.factory.created).toHaveLength(0);
  });

  // Spec: Kit.Client, StopMidStart: stop() during start aborts the head request and nothing starts (check CL16)
  test("CL16 stop() while the head request is open aborts it and starts nothing", async () => {
    const rig = makeRig();
    rig.state.respond = () => new Promise<Response>(() => {});
    const settled = rig.client.start().then(() => "resolved", (e: unknown) => (e as Error).message);
    await rig.advance(0);
    await rig.client.stop();
    expect(await settled).toBe("could not read the starting position");
    expect(rig.factory.created).toHaveLength(0);
    expect(rig.resyncCalls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the headless client: state and control", () => {
  // Spec: Kit.Client, Dot: transport reports reach the dot and the confirmation clock (check CL6)
  test("CL6 transport state reports reach the dot; onConfirm moves lastConfirmedAt", async () => {
    const rig = makeRig();
    await rig.startAndSettle();
    const kinds: string[] = [];
    // The dot also wakes for a new "as of" time with the same kind; this test follows the kind only.
    rig.client.subscribeDot((d) => { if (kinds.at(-1) !== d.kind) kinds.push(d.kind); });
    expect(rig.client.dot().kind).toBe("connecting");
    const ctx = rig.ctx();
    ctx.onState({ state: "live", mode: "stream" });
    expect(rig.client.dot()).toMatchObject({ kind: "live", showLive: true });
    const at = Date.now() + 1000;
    ctx.onConfirm(at);
    expect(rig.client.lastConfirmedAt()).toBe(at);
    ctx.onState({ state: "reconnecting", cause: "cut", retryInMs: 5000 });
    expect(rig.client.dot()).toMatchObject({ kind: "reconnecting", showLive: false });
    ctx.onState({ state: "live", mode: "stream" });
    expect(rig.client.dot().kind).toBe("live");
    ctx.onState({ state: "stopped", cause: "revoked" });
    expect(rig.client.dot()).toMatchObject({ kind: "stopped", cause: "access_removed" });
    expect(kinds).toEqual(["live", "reconnecting", "live", "stopped"]);
  });

  // Spec: Kit.Client, Pause: pause holds the screen, counts what waits, and resume delivers one merged change (check CL7)
  test("CL7 pause stops delivery, waiting counts, the dot says paused, resume delivers one merged change", async () => {
    const rig = makeRig();
    await rig.startAndSettle();
    rig.ctx().onState({ state: "live", mode: "stream" });
    const waits: number[] = [];
    rig.client.subscribeWaiting((w) => waits.push(w));
    rig.client.pause();
    expect(rig.client.paused()).toBe(true);
    expect(rig.client.dot().kind).toBe("paused");
    rig.change("C", "v1");
    rig.change("D", "v1");
    rig.change("E", "v1");
    await rig.advance(1000);
    expect(rig.changes).toHaveLength(1);
    expect(rig.client.waiting()).toBe(3);
    expect(waits.at(-1)).toBe(3);
    expect(rig.client.dot()).toMatchObject({ kind: "paused", waiting: 3 });
    expect(rig.client.records()).toHaveLength(2);
    rig.client.resume();
    expect(rig.changes).toHaveLength(2);
    expect(rig.changes[1]).toMatchObject({ full: false });
    expect(rig.changes[1]!.records).toHaveLength(3);
    expect(rig.client.paused()).toBe(false);
    expect(rig.client.waiting()).toBe(0);
    expect(waits.at(-1)).toBe(0);
    expect(rig.client.dot().kind).toBe("live");
  });

  // Spec: Kit.Client, DataFirst: at a delivery the change listeners run before the dot listeners see the emptied queue (check CL17)
  test("CL17 at a delivery the change comes first; the dot that shows nothing waiting follows it", async () => {
    const rig = makeRig();
    await rig.startAndSettle();
    rig.ctx().onState({ state: "live", mode: "stream" });
    await rig.advance(1500);
    const log: string[] = [];
    rig.client.subscribe(() => log.push("change"));
    rig.client.subscribeDot((d) => log.push(`dot:${d.waiting}`));
    rig.client.subscribeTick(() => log.push("tick"));
    rig.change("C", "v1");
    await rig.advance(1500);
    const at = log.indexOf("change");
    expect(at).toBeGreaterThan(-1);
    // While the change waited the dot said so; the dot that says "nothing waits" may only follow the change.
    expect(log.slice(0, at)).toContain("dot:1");
    expect(log.slice(0, at)).not.toContain("dot:0");
    expect(log.slice(at)).toContain("dot:0");
    expect(log.indexOf("tick")).toBeGreaterThan(at);
  });

  // Spec: Kit.Client, Resync: the transport's resync reads the list, seeds the store and delivers a full change (check CL8)
  test("CL8 resync(bad_cursor) and resync(poll_start) reach the app, seed the store and flush a full change", async () => {
    const rig = makeRig();
    await rig.startAndSettle();
    for (const [i, reason] of (["bad_cursor", "poll_start"] as const).entries()) {
      rig.state.seedRows = [row(`Z${i}`, "v1")];
      await rig.ctx().resync(reason);
      // Delivered at once, with no timer: the transport is waiting to go on from the new list.
      expect(rig.changes).toHaveLength(2 + i);
      expect(rig.changes.at(-1)).toMatchObject({ full: true });
      expect(rig.changes.at(-1)!.records.map((r) => r.entityUri)).toEqual([ent(`Z${i}`)]);
      expect(rig.client.store.size()).toBe(1);
    }
    expect(rig.resyncCalls).toEqual(["initial", "bad_cursor", "poll_start"]);
  });

  // Spec: Kit.Client, Hidden: a long-hidden page closes the transport and the next one starts only after the old stop settled, from the newest cursor (check CL9)
  test("CL9 hidden 60 s closes the transport; shown makes a new one after the old stop, from the store's cursor of that moment", async () => {
    const rig = makeRig();
    await rig.startAndSettle();
    rig.ctx().onState({ state: "live", mode: "stream" });
    rig.change("A", "v2");
    await rig.advance(300);
    const first = rig.factory.created[0]!;
    rig.client.setVisible(false);
    rig.factory.holdStops = true;
    await rig.advance(59_999);
    expect(first.stops).toBe(0);
    await rig.advance(1);
    expect(first.stops).toBe(1);
    // A notification arrives while the old stop is still settling: the new transport must start from it.
    rig.change("B", "v1");
    rig.client.setVisible(true);
    await rig.advance(0);
    expect(rig.factory.created).toHaveLength(1);
    first.settleStop();
    await rig.advance(0);
    expect(rig.factory.created).toHaveLength(2);
    const second = rig.factory.created[1]!;
    expect(second.ctx.resumeCursor).toBe(cur(2));
    expect(second.ctx.from).toBe(cur(2));
    expect(second.started).toBe(1);
    expect(rig.factory.maxLive).toBe(1);
    const log = rig.events;
    expect(log.indexOf("transport.stopped")).toBeGreaterThan(-1);
    expect(log.indexOf("transport.stopped")).toBeLessThan(log.lastIndexOf("transport.create"));
  });
});

describe("the headless client: cache", () => {
  const saved = (cursor: string | null) => ({
    version: 1 as const,
    scope: "s1",
    savedAt: Date.now(),
    cursor,
    rows: [{ entity: ent("A"), typeUri: TYPE, etag: "v0", updatedAt: null, record: { entityUri: ent("A"), v: "v0" } }],
  });

  // Spec: Kit.Client, Restore: a restored cursor skips the head and the full read; the state stays stale until confirmed (check CL10)
  test("CL10a a restore with a cursor skips the head fetch and the read, passes the cursor, and stays stale until a full change", async () => {
    const rig = makeRig({ cacheScope: "s1" });
    await rig.lc!.inner.save(saved(cur(500)));
    await rig.startAndSettle();
    expect(rig.events).toEqual(["cache.load", "seed", "deliver:full", "transport.create", "transport.start"]);
    expect(rig.fetchCalls).toHaveLength(0);
    expect(rig.resyncCalls).toEqual([]);
    expect(rig.ctx().from).toBe(cur(500));
    expect(rig.changes[0]).toMatchObject({ full: true });
    expect(rig.changes[0]!.records.map((r) => r.v)).toEqual(["v0"]);
    expect(rig.client.stale()).toBe(true);
    await rig.ctx().resync("bad_cursor");
    expect(rig.client.stale()).toBe(false);
  });

  test("CL10b a restore that needs a resync does the head fetch and the read, keeps the old rows shown as stale meanwhile", async () => {
    const rig = makeRig({ cacheScope: "s1" });
    await rig.lc!.inner.save(saved(null));
    const gate = deferred();
    rig.state.resyncGate = gate;
    const p = rig.client.start();
    await rig.advance(0);
    expect(rig.events.filter((e) => !isDeliver(e) && e !== "seed")).toEqual(["cache.load", "head", "resync:initial"]);
    expect(rig.changes).toHaveLength(1);
    expect(rig.changes[0]!.records.map((r) => r.v)).toEqual(["v0"]);
    expect(rig.client.stale()).toBe(true);
    gate.resolve();
    await p;
    expect(rig.client.stale()).toBe(false);
    expect(rig.changes).toHaveLength(2);
    expect(rig.changes[1]).toMatchObject({ full: true });
    expect(rig.changes[1]!.records).toHaveLength(2);
    expect(rig.ctx().from).toBe(HEAD);
  });

  test("CL10c the cache is saved after changes", async () => {
    const rig = makeRig({ cacheScope: "s1" });
    await rig.startAndSettle();
    expect(rig.client.stale()).toBe(false);
    await rig.advance(2100);
    expect(rig.lc!.saves()).toBe(1);
    const first = (await rig.lc!.inner.load()) as { rows: unknown[]; cursor: string | null };
    expect(first.rows).toHaveLength(2);
    rig.change("C", "v1");
    await rig.advance(2500);
    const second = (await rig.lc!.inner.load()) as { rows: Array<{ entity: string }>; cursor: string | null };
    expect(second.rows.map((r) => r.entity)).toContain(ent("C"));
    expect(second.cursor).toBe(cur(1));
  });
});

describe("the headless client: stop, records, options, listeners", () => {
  // Spec: Kit.Client, TerminalStop: stop ends the client for good, saves the cache, waits for the transport, leaves no timer (check CL11)
  test("CL11 stop() is terminal and idempotent, flushes the cache, awaits the transport stop and clears every timer", async () => {
    const rig = makeRig({ cacheScope: "s1" });
    await rig.startAndSettle();
    rig.ctx().onState({ state: "live", mode: "stream" });
    // A change is on its way to the screen: the delivery period is open, so a timer is pending when stop() is called.
    rig.change("R", "v1");
    await rig.advance(0);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    const seen: string[] = [];
    rig.client.subscribe(() => seen.push("change"));
    rig.client.subscribeDot(() => seen.push("dot"));
    rig.client.subscribeTick(() => seen.push("tick"));
    rig.client.subscribeWaiting(() => seen.push("waiting"));
    expect(rig.lc!.saves()).toBe(0);
    rig.factory.holdStops = true;
    const p = rig.client.stop();
    let done = false;
    void p.then(() => { done = true; });
    await rig.advance(0);
    expect(rig.factory.created[0]!.stops).toBe(1);
    expect(done).toBe(false);
    rig.factory.created[0]!.settleStop();
    await p;
    expect(done).toBe(true);
    expect(rig.lc!.saves()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(rig.client.stop()).toBe(p);
    // Later calls and listeners do nothing.
    const before = { changes: rig.changes.length, resync: rig.resyncCalls.length, created: rig.factory.created.length };
    const ctx = rig.ctx();
    ctx.onState({ state: "live", mode: "stream" });
    ctx.onConfirm(Date.now());
    await ctx.resync("bad_cursor");
    rig.change("Q", "v1");
    rig.client.pause();
    rig.client.resume();
    rig.client.setVisible(false);
    rig.client.setVisible(true);
    rig.client.setKeepLive(true);
    const off = rig.client.subscribe(() => seen.push("late"));
    off();
    await rig.advance(5000);
    expect(seen).toEqual([]);
    expect({ changes: rig.changes.length, resync: rig.resyncCalls.length, created: rig.factory.created.length }).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Spec: Kit.Client, Mirror: records() is the delivered list, kept by key as the app's own list would be (check CL12)
  test("CL12 records() equals the list built by the applyChange mirror; without keyOf it throws a plain message", async () => {
    const rig = makeRig();
    let held: Rec[] = [];
    rig.client.subscribe((c) => { held = applyChange(held, c); });
    await rig.startAndSettle();
    rig.ctx().onState({ state: "live", mode: "stream" });
    expect(rig.client.records()).toEqual(held);
    expect(rig.client.records()).toHaveLength(2);
    const stable = rig.client.records();
    expect(rig.client.records()).toBe(stable);
    const steps: Array<[string, () => void]> = [
      ["create", () => rig.change("D", "v1")],
      ["change", () => rig.change("B", "v2")],
      ["end", () => rig.end("A")],
      ["revive", () => rig.change("A", "v3")],
    ];
    let previous = stable;
    for (const [label, act] of steps) {
      act();
      await rig.advance(300);
      expect(rig.client.records(), label).toEqual(held);
      expect(rig.client.records(), label).not.toBe(previous);
      expect(rig.client.records(), label).toBe(rig.client.records());
      previous = rig.client.records();
    }
    expect(rig.client.records().map((r) => `${r.entityUri.slice(-1)}:${r.v}`).sort()).toEqual(["A:v3", "B:v2", "D:v1"]);

    const plain = makeRig({ keyOf: false });
    await plain.startAndSettle();
    expect(() => plain.client.records()).toThrow("records() needs a keyOf function");
  });

  // Spec: Kit.Client, Validation: bad options fail at creation with plain messages (check CL13)
  test("CL13 invalid options throw plain messages", () => {
    const base = (): LiveClientOptions<Rec> => ({
      origin: ORIGIN, vaultId: VAULT, types: ["Value"], auth: () => ({}), read: async () => null,
      resync: async () => [], createTransport: () => ({ start() {}, stop: async () => {}, state: () => ({ state: "x" }) }),
    });
    const bad: Array<[string, Partial<LiveClientOptions<Rec>>, RegExp]> = [
      ["empty types", { types: [] }, /at least one type/],
      ["bad type name", { types: ["bad name"] }, /bare name/],
      ["path type", { types: ["a/b"] }, /bare name/],
      ["origin with a path", { origin: `${ORIGIN}/path` }, /origin must be/],
      ["cache without scope", { cache: { load: () => null, save: () => {} } }, /cache and cacheScope/],
      ["scope without cache", { cacheScope: "s" }, /cache and cacheScope/],
      ["no factory", { createTransport: "not a function" as never }, /createTransport/],
      ["no reader", { read: undefined }, /read or readBatch/],
      ["empty vault", { vaultId: "" }, /vaultId/],
    ];
    for (const [label, change, message] of bad) {
      let caught: unknown = null;
      try { createLiveClient<Rec>({ ...base(), ...change }); } catch (e) { caught = e; }
      expect(caught, label).toBeInstanceOf(Error);
      expect((caught as Error).message, label).toMatch(message);
      expect((caught as Error).message, label).not.toContain("https://");
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  // Spec: Kit.Client, IsolatedListeners: a throwing listener never stops the client, and its log line has the message only (check CL14)
  test("CL14 a throwing listener never stops the client and the log has the message only", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const rig = makeRig();
    const boom = (what: string) => (): never => { throw Object.assign(new Error(`boom-${what}`), { secret: "S3CRET-DATA" }); };
    rig.client.subscribe(boom("change"));
    rig.client.subscribeTick(boom("tick"));
    rig.client.subscribeDot(boom("dot"));
    rig.client.subscribeWaiting(boom("waiting"));
    const good = { change: 0, tick: 0, dot: 0, waiting: 0 };
    rig.client.subscribe(() => { good.change++; });
    rig.client.subscribeTick(() => { good.tick++; });
    rig.client.subscribeDot(() => { good.dot++; });
    rig.client.subscribeWaiting(() => { good.waiting++; });
    await rig.startAndSettle();
    rig.ctx().onState({ state: "live", mode: "stream" });
    rig.change("C", "v1");
    await rig.advance(300);
    rig.ctx().onState({ state: "reconnecting", cause: "cut", retryInMs: 1000 });
    expect(good.change).toBe(2);
    expect(good.tick).toBeGreaterThan(0);
    expect(good.dot).toBeGreaterThan(0);
    expect(good.waiting).toBeGreaterThan(0);
    expect(rig.client.records()).toHaveLength(3);
    const lines = err.mock.calls.map((c) => c.map(String).join(" "));
    for (const what of ["change", "tick", "dot", "waiting"]) expect(lines.some((l) => l.includes(`boom-${what}`)), what).toBe(true);
    for (const call of err.mock.calls) expect(call).toHaveLength(1);
    for (const l of lines) {
      expect(l).not.toContain("S3CRET-DATA");
      expect(l).not.toContain("entityUri");
    }
  });

  // Spec: Kit.Client, Neutral: the client names no browser global and no app (check CL15)
  test("CL15 the sources contain none of the forbidden strings", () => {
    const banned = [
      "GilbApp", "BaseRecord", "data-live-", "gilbplatformcode", "a7cb8cff", "/Users/", "EventSource", "indexedDB", "localStorage",
      "sessionStorage", "window", "document", "navigator", "caches.",
    ];
    for (const f of ["client.ts", "live-source.ts"]) {
      const body = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
      for (const word of banned) expect(body.includes(word), `${f} contains ${word}`).toBe(false);
      for (const m of body.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) expect(/^\.\/[a-z-]+\.js$/.test(m[1]!), `${f} imports ${m[1]}`).toBe(true);
    }
  });
});
