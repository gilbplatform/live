import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMemoryCache } from "../src/state-cache.js";
import { fakePage, json, makeSourceRig, startTime, stopAll } from "./helpers/clientRig.js";
import type { Recorded } from "./helpers/clientRig.js";
import { TYPE, cur, ent } from "./helpers/liveKit.js";
import type { LiveChange } from "../src/types.js";
import type { Rec } from "./helpers/liveKit.js";

beforeEach(startTime);
afterEach(async () => {
  await stopAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const of = (log: Recorded[], t: Recorded["t"]): Recorded[] => log.filter((x) => x.t === t);
const statuses = (log: Recorded[]): Array<{ status: string; cause?: string }> => of(log, "status").map((x) => x.v as { status: string; cause?: string });
const keys = (o: unknown): string[] => Object.keys(o as object).sort();

describe("the GilbApp-shaped source", () => {
  // Spec: Kit.Source, NeedsAType: an empty type list throws before any request (check LS1)
  test("LS1 subscribe with an empty list throws before any call to the factory or fetch", () => {
    const rig = makeSourceRig();
    expect(() => rig.source.subscribe("vault-1", [], {} as never)).toThrow("a live subscription needs at least one type name");
    expect(rig.factory.created).toHaveLength(0);
    expect(rig.fetchCalls).toHaveLength(0);
    expect(rig.resyncCalls).toHaveLength(0);
    expect(rig.events).toEqual([]);
  });

  // Spec: Kit.Source, Shapes: the handlers get exactly the app's shapes, in the order data, status, tick (check LS2)
  test("LS2 handler order and shapes", async () => {
    const rig = makeSourceRig();
    const log: Recorded[] = [];
    rig.subscribe("vault-1", ["Value"], log);
    // The first status is given at once, before any data.
    expect(log).toHaveLength(1);
    expect(log[0]!.t).toBe("status");
    expect(log[0]!.v).toMatchObject({ status: "connecting" });
    await rig.advance(0);
    const changes = of(log, "change").map((x) => x.v as LiveChange<Rec>);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ full: true });
    // A delivery calls onChange first; the screen time it causes follows.
    expect(log.map((x) => x.t)).toEqual(["status", "change", "tick"]);
    rig.ctx().onState({ state: "live", mode: "stream" });
    // Time must pass first: a screen time that did not move gives no tick.
    await rig.advance(1500);
    rig.change("C", "v1");
    await rig.advance(1500);
    const all = of(log, "change").map((x) => x.v as LiveChange<Rec>);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ full: false });
    for (const c of all) expect(keys(c)).toEqual(["at", "ended", "full", "records"]);
    // For every delivery, the change comes before the screen time that the delivery moved.
    const order = log.map((x) => x.t);
    const lastChange = order.lastIndexOf("change");
    expect(order.indexOf("tick", lastChange)).toBeGreaterThan(lastChange);
    for (const s of statuses(log)) {
      const expected = s.status === "offline" || s.status === "stopped" ? ["at", "cause", "status"] : ["at", "status"];
      expect(keys(s)).toEqual(expected);
    }
    rig.ctx().onState({ state: "reconnecting", cause: "cut", retryInMs: 1000 });
    rig.ctx().onState({ state: "stopped", cause: "revoked" });
    for (const s of statuses(log)) {
      const expected = s.status === "offline" || s.status === "stopped" ? ["at", "cause", "status"] : ["at", "status"];
      expect(keys(s)).toEqual(expected);
    }
    expect(statuses(log).map((s) => s.status)).toEqual(["connecting", "live", "offline", "stopped"]);
  });

  // Spec: Kit.Source, Tick: a quiet confirmation ticks the screen time, at most once a second (check LS3)
  test("LS3 onTick fires for a heartbeat confirmation with nothing else changing and is throttled to once a second", async () => {
    const rig = makeSourceRig();
    const log: Recorded[] = [];
    const sub = rig.subscribe("vault-1", ["Value"], log);
    await rig.advance(0);
    rig.ctx().onState({ state: "live", mode: "stream" });
    const ticks = (): number[] => of(log, "tick").map((x) => x.v as number);
    const t0 = ticks().length;
    const changes0 = of(log, "change").length;
    await rig.advance(1500);
    const a = Date.now();
    rig.ctx().onConfirm(a);
    expect(ticks()).toHaveLength(t0 + 1);
    expect(ticks().at(-1)).toBe(a);
    await rig.advance(100);
    const b = Date.now();
    rig.ctx().onConfirm(b);
    // Too soon for a second tick, but the time itself already moved.
    expect(ticks()).toHaveLength(t0 + 1);
    await rig.advance(100);
    const c = Date.now();
    rig.ctx().onConfirm(c);
    expect(ticks()).toHaveLength(t0 + 1);
    await rig.advance(900);
    expect(ticks()).toHaveLength(t0 + 2);
    expect(ticks().at(-1)).toBe(c);
    expect(of(log, "change")).toHaveLength(changes0);
    sub.stop();
  });

  // Spec: Kit.Source, TruthfulStatus: reconnecting is offline, a quiet renewal is not, a revoke is stopped, hidden is offline (check LS4)
  test("LS4 status mapping: reconnecting is offline, a quiet renewal changes nothing, revoke stops, hidden is offline then live again", async () => {
    const page = fakePage();
    const rig = makeSourceRig({ pageFor: page, heartbeatWindowMs: 600_000 });
    const log: Recorded[] = [];
    rig.subscribe("vault-1", ["Value"], log);
    await rig.advance(0);
    const ctx = rig.ctx();
    ctx.onState({ state: "live", mode: "stream" });
    expect(statuses(log).at(-1)).toMatchObject({ status: "live" });
    // A quiet renewal with a fresh confirmation changes nothing.
    const n0 = statuses(log).length;
    ctx.onConfirm(Date.now());
    ctx.onState({ state: "reconnecting", cause: "max_age", quiet: true, retryInMs: 0 });
    ctx.onState({ state: "live", mode: "stream" });
    expect(statuses(log)).toHaveLength(n0);
    expect(statuses(log).some((s) => s.status === "offline")).toBe(false);
    // A real reconnect is offline, with a cause.
    ctx.onState({ state: "reconnecting", cause: "cut", retryInMs: 5000 });
    expect(statuses(log).at(-1)).toMatchObject({ status: "offline", cause: "cut" });
    ctx.onState({ state: "live", mode: "stream" });
    expect(statuses(log).at(-1)).toMatchObject({ status: "live" });
    // Hidden for 60 s: the connection is closed and the status says why.
    page.set("hidden");
    await rig.advance(60_000);
    expect(statuses(log).at(-1)).toMatchObject({ status: "offline", cause: "hidden" });
    page.set("visible");
    await rig.advance(0);
    expect(rig.factory.created).toHaveLength(2);
    expect(statuses(log).at(-1)).toMatchObject({ status: "connecting" });
    rig.ctx(1).onState({ state: "live", mode: "stream" });
    expect(statuses(log).at(-1)).toMatchObject({ status: "live" });
    // Access withdrawn: stopped, with the cause word.
    rig.ctx(1).onState({ state: "stopped", cause: "revoked" });
    expect(statuses(log).at(-1)).toMatchObject({ status: "stopped", cause: "access_removed" });
  });

  // Spec: Kit.Source, Silence: stop is idempotent and silences every handler; a failed start is a status, not a throw (check LS5)
  test("LS5 stop() is idempotent and silences all handlers; a start failure is offline/start_failed and stop still works", async () => {
    const rig = makeSourceRig();
    const log: Recorded[] = [];
    const sub = rig.subscribe("vault-1", ["Value"], log);
    await rig.advance(0);
    rig.ctx().onState({ state: "live", mode: "stream" });
    sub.stop();
    sub.stop();
    await rig.advance(0);
    const count = log.length;
    const ctx = rig.ctx();
    ctx.onState({ state: "reconnecting", cause: "cut", retryInMs: 1000 });
    ctx.onConfirm(Date.now() + 5000);
    await ctx.resync("bad_cursor");
    rig.change("C", "v1");
    await rig.advance(5000);
    expect(log).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);

    // A failed start.
    const bad = makeSourceRig();
    bad.state.respond = () => json(500, {});
    const log2: Recorded[] = [];
    const sub2 = bad.subscribe("vault-1", ["Value"], log2);
    await bad.advance(0);
    expect(statuses(log2).at(-1)).toEqual({ status: "offline", at: Date.now(), cause: "start_failed" });
    expect(bad.factory.created).toHaveLength(0);
    sub2.stop();
    expect(vi.getTimerCount()).toBe(0);

    // A start that fails because stop() cut it short says nothing.
    const cut = makeSourceRig();
    cut.state.respond = () => new Promise<Response>(() => {});
    const log3: Recorded[] = [];
    const sub3 = cut.subscribe("vault-1", ["Value"], log3);
    await cut.advance(0);
    const before = log3.length;
    sub3.stop();
    await cut.advance(0);
    expect(log3).toHaveLength(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Spec: Kit.Source, Independent: two subscriptions are two clients (check LS6)
  test("LS6 two subscriptions to different vaults are independent", async () => {
    const rig = makeSourceRig({ originOf: (v) => `https://${v}.example` });
    const a: Recorded[] = [];
    const b: Recorded[] = [];
    const subA = rig.subscribe("va", ["Value"], a);
    const subB = rig.subscribe("vb", ["Value", "Other"], b);
    await rig.advance(0);
    expect(rig.factory.created).toHaveLength(2);
    expect(rig.fetchCalls.map((c) => c.url).sort()).toEqual([
      "https://va.example/lws/vault/va/records?since=head&type=Value",
      "https://vb.example/lws/vault/vb/records?since=head&type=Value&type=Other",
    ]);
    expect(rig.resyncCalls.map((c) => c.vaultId).sort()).toEqual(["va", "vb"]);
    const ctxA = rig.factory.created.find((t) => t.ctx.vaultId === "va")!.ctx;
    const ctxB = rig.factory.created.find((t) => t.ctx.vaultId === "vb")!.ctx;
    expect(ctxA.store).not.toBe(ctxB.store);
    expect(ctxA.origin).toBe("https://va.example");
    expect(ctxB.types).toEqual(["Value", "Other"]);
    const changesA = of(a, "change").length;
    const changesB = of(b, "change").length;
    ctxB.onState({ state: "stopped", cause: "revoked" });
    expect(statuses(b).at(-1)).toMatchObject({ status: "stopped" });
    expect(statuses(a).some((s) => s.status === "stopped")).toBe(false);
    subB.stop();
    rig.versions.set("https://vault.example/e/Q", "v1");
    ctxA.store.push({ kind: "change", entity: "https://vault.example/e/Q", typeUri: "t", etag: "v1", updatedAt: null, receivedAt: new Date().toISOString(), cursor: cur(5) });
    await rig.advance(1500);
    expect(of(a, "change").length).toBe(changesA + 1);
    expect(of(b, "change").length).toBe(changesB);
    subA.stop();
  });

  // Spec: Kit.Source, Cache: cacheFor gives each subscription its own saved state, and a saved cursor skips the head fetch (check LS7)
  test("LS7 a cache from cacheFor is used per subscription; its cursor is the stream's start", async () => {
    const seenFor: Array<[string, readonly string[]]> = [];
    const inner = createMemoryCache<Rec>();
    await inner.save({
      version: 1, scope: "s1", savedAt: Date.now(), cursor: cur(500),
      rows: [{ entity: ent("A"), typeUri: TYPE, etag: "v0", updatedAt: null, record: { entityUri: ent("A"), v: "v0" } }],
    });
    const rig = makeSourceRig({ cacheFor: (v, t) => { seenFor.push([v, t]); return { cache: inner, scope: "s1" }; } });
    const log: Recorded[] = [];
    rig.subscribe("vault-1", ["Value"], log);
    await rig.advance(0);
    expect(seenFor).toEqual([["vault-1", ["Value"]]]);
    expect(rig.fetchCalls).toHaveLength(0);
    expect(rig.ctx().from).toBe(cur(500));
    expect((of(log, "change")[0]!.v as LiveChange<Rec>).records.map((r) => r.v)).toEqual(["v0"]);
  });
});
