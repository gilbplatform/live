import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createConfirmationClock } from "../src/confirm.js";
import { createMemoryCache, createStateCache, DEFAULT_STATE_MAX_AGE_MS, DEFAULT_STATE_MAX_ROWS, STATE_CACHE_VERSION } from "../src/state-cache.js";
import type { CachedState, LiveCache, StateCache } from "../src/state-cache.js";
import { createLiveStore } from "../src/store.js";
import type { LiveChange, LiveStore } from "../src/types.js";
import { at, cur, ent, fakeReader, n, nameOf, T0, t, TYPE } from "./helpers/liveKit.js";
import type { Rec } from "./helpers/liveKit.js";

const SCOPE = "person-1:vault-1";
const tick = async (ms = 0): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };

const db = new Map<string, string>();
let store: LiveStore<Rec>;
let changes: LiveChange<Rec>[] = [];
const caches: StateCache<Rec>[] = [];

function mkStore(): LiveStore<Rec> {
  store?.close();
  changes = [];
  const s = createLiveStore<Rec>({
    holdMs: 0,
    read: async ({ entity }) => ({ record: { entityUri: entity, v: db.get(nameOf(entity)) ?? "?" }, etag: db.get(nameOf(entity)) ?? null }),
  });
  s.subscribe((c) => changes.push(c));
  store = s;
  return s;
}
let counter = 0;
function put(nm: string, v: string): void {
  db.set(nm, v);
  store.push(n(nm, ++counter, v, "change", cur(counter)));
}

/** A cache over one slot that counts what happens to it. */
function slotCache(initial?: unknown) {
  const o = {
    slot: initial as unknown,
    loads: 0,
    removed: 0,
    saved: [] as Array<CachedState<Rec>>,
    cache: undefined as unknown as LiveCache<Rec>,
  };
  o.cache = {
    load: () => { o.loads++; return o.slot ?? null; },
    save: (s) => { o.saved.push(JSON.parse(JSON.stringify(s)) as CachedState<Rec>); o.slot = s; },
    remove: () => { o.removed++; o.slot = undefined; },
  };
  return o;
}
const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  scope: SCOPE,
  savedAt: Date.now() - 1000,
  cursor: cur(7),
  rows: [
    { entity: ent("A"), typeUri: TYPE, etag: "a1", updatedAt: t(5), record: { entityUri: ent("A"), v: "a1" } },
    { entity: ent("B"), typeUri: TYPE, etag: "b1", updatedAt: t(9), record: { entityUri: ent("B"), v: "b1" } },
  ],
  ...over,
});
function mkCache(o: ReturnType<typeof slotCache>, opts: Partial<Parameters<typeof createStateCache<Rec>>[0]> = {}): StateCache<Rec> {
  const c = createStateCache<Rec>({ store, cache: o.cache, scope: SCOPE, ...opts });
  caches.push(c);
  return c;
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); db.clear(); counter = 0; mkStore(); });
afterEach(() => { for (const c of caches.splice(0)) c.close(); store.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("state cache: restore", () => {
  test("constants", () => {
    expect(STATE_CACHE_VERSION).toBe(1);
    expect(DEFAULT_STATE_MAX_AGE_MS).toBe(7 * 24 * 3600 * 1000);
    expect(DEFAULT_STATE_MAX_ROWS).toBe(5000);
  });

  // Spec: Kit.Client, Cache: the last known state is shown at once and is marked as old (LiveWire step, check 13 Honesty.Freshness)
  test("SC1 restore seeds the store with one full change and gives asOf, cursor and rows", async () => {
    const o = slotCache(good());
    const sc = mkCache(o);
    const r = await sc.restore();
    expect(r).toEqual({ restored: true, reason: "ok", savedAt: T0 - 1000, asOf: t(9), cursor: cur(7), rows: 2, needsResync: false });
    expect(store.all().map((x) => x.entity)).toEqual([ent("A"), ent("B")]);
    expect(store.get(ent("A"))).toMatchObject({ etag: "a1", updatedAt: t(5), typeUri: TYPE });
    expect(changes).toHaveLength(1);
    expect(at(changes, 0).full).toBe(true);
    expect(store.lastCursor()).toBeNull();
    expect(store.stats().pushed).toBe(0);
    expect(sc.isStale()).toBe(true);
    expect(sc.stats().loads).toBe(1);
  });

  // Spec: Kit.Client, Cache: one person's numbers never appear for the next person (check Confidentiality.Scope)
  test("SC2 a different scope is ignored and the store is untouched", async () => {
    const o = slotCache(good({ scope: "person-2:vault-1" }));
    const sc = mkCache(o);
    const r = await sc.restore();
    expect(r.restored).toBe(false);
    expect(r.reason).toBe("scope");
    expect(r.rows).toBe(0);
    expect(store.size()).toBe(0);
    expect(changes).toHaveLength(0);
    expect(sc.isStale()).toBe(false);
  });

  // Spec: Kit.Client, Cache: half a state is worse than none (check Delivery.Completeness)
  test("SC3 each kind of bad state is ignored whole with the right reason, and never throws", async () => {
    const bad = (rows: unknown[]) => good({ rows });
    const okRow = { entity: ent("A"), typeUri: TYPE, etag: "a1", updatedAt: null, record: { entityUri: ent("A"), v: "a1" } };
    const cases: Array<[string, unknown, string, Record<string, unknown>?]> = [
      ["version mismatch", good({ version: 2 }), "version"],
      ["no version", {}, "version"],
      ["text", "garbage", "shape"],
      ["number", 42, "shape"],
      ["array", [], "shape"],
      ["scope not a string", good({ scope: 5 }), "shape"],
      ["savedAt not a number", good({ savedAt: "yesterday" }), "shape"],
      ["savedAt infinite", good({ savedAt: Infinity }), "shape"],
      ["rows not an array", good({ rows: {} }), "shape"],
      ["row missing entity", bad([okRow, { typeUri: TYPE, etag: null, updatedAt: null, record: {} }]), "shape"],
      ["row with empty entity", bad([okRow, { ...okRow, entity: "" }]), "shape"],
      ["row missing typeUri", bad([okRow, { ...okRow, typeUri: undefined }]), "shape"],
      ["row etag a number", bad([okRow, { ...okRow, entity: ent("B"), etag: 5 }]), "shape"],
      ["row updatedAt missing", bad([okRow, { entity: ent("B"), typeUri: TYPE, etag: null, record: {} }]), "shape"],
      ["row without record", bad([okRow, { entity: ent("B"), typeUri: TYPE, etag: null, updatedAt: null }]), "shape"],
      ["row not an object", bad([okRow, 7]), "shape"],
      ["bad cursor", good({ cursor: "short" }), "shape"],
      ["cursor a number", good({ cursor: 12 }), "shape"],
      ["cursor with a bad character", good({ cursor: "c".repeat(42) + "!" }), "shape"],
      ["too old", good({ savedAt: T0 - DEFAULT_STATE_MAX_AGE_MS - 1 }), "too_old"],
      ["saved in the future", good({ savedAt: T0 + 3_600_000 }), "shape"],
      ["too many rows", bad([okRow, { ...okRow, entity: ent("B") }, { ...okRow, entity: ent("C") }]), "too_many", { maxRows: 2 }],
    ];
    for (const [label, state, reason, extra] of cases) {
      mkStore();
      const o = slotCache(state);
      const sc = mkCache(o, extra ?? {});
      const r = await sc.restore();
      expect(r.restored, label).toBe(false);
      expect(r.reason, label).toBe(reason);
      expect(store.size(), label).toBe(0);
      expect(changes, label).toHaveLength(0);
      expect(sc.isStale(), label).toBe(false);
    }
    // A null cursor and a missing store state are fine.
    mkStore();
    const o2 = slotCache(good({ cursor: null }));
    expect((await mkCache(o2).restore()).cursor).toBeNull();
    mkStore();
    expect((await mkCache(slotCache()).restore()).reason).toBe("empty");
  });

  test("SC4 a rejecting or throwing load is swallowed", async () => {
    const reject = createStateCache<Rec>({ store, scope: SCOPE, cache: { load: () => Promise.reject(new Error("disk")), save: () => {} } });
    caches.push(reject);
    const r = await reject.restore();
    expect(r).toMatchObject({ restored: false, reason: "load_failed", rows: 0 });
    expect(reject.stats().loadFailed).toBe(1);
    const sync = createStateCache<Rec>({ store, scope: SCOPE, cache: { load: () => { throw new Error("locked"); }, save: () => {} } });
    caches.push(sync);
    expect((await sync.restore()).reason).toBe("load_failed");
    expect(sync.stats().loadFailed).toBe(1);
    expect(store.size()).toBe(0);
  });

  // Spec: Kit.Client, Cache: a restored state is old until the server confirms it (check 13 Honesty.Freshness)
  test("SC5 stale after restore; fresh by a full change, by markFresh, or by a clock confirmation only when idle and late enough", async () => {
    // (a) a full change after the restore
    let o = slotCache(good());
    let flips: boolean[] = [];
    let sc = mkCache(o, { onStaleChange: (s) => flips.push(s) });
    await sc.restore();
    expect(sc.isStale()).toBe(true);
    expect(flips).toEqual([true]);
    store.seed([{ entity: ent("Z"), typeUri: TYPE, etag: "z", record: { entityUri: ent("Z"), v: "z" } }]);
    expect(sc.isStale()).toBe(false);
    expect(flips).toEqual([true, false]);

    // (b) markFresh, once per change
    mkStore();
    o = slotCache(good());
    flips = [];
    sc = mkCache(o, { onStaleChange: (s) => flips.push(s) });
    await sc.restore();
    sc.markFresh();
    sc.markFresh();
    expect(sc.isStale()).toBe(false);
    expect(flips).toEqual([true, false]);

    // (c) a clock confirmation: not at once, not while busy, only when idle and freshAfterMs have passed
    mkStore();
    const fr = fakeReader();
    store.close();
    store = createLiveStore<Rec>({ holdMs: 0, read: fr.read });
    const clock = createConfirmationClock();
    o = slotCache(good());
    flips = [];
    sc = mkCache(o, { clock, freshAfterMs: 3000, onStaleChange: (s) => flips.push(s) });
    await sc.restore();
    clock.confirm();
    expect(sc.isStale()).toBe(true);
    await tick(2900);
    clock.confirm();
    expect(sc.isStale()).toBe(true);
    // Late enough, but a read is still in flight.
    store.push(n("A", 50, "a2", "change", cur(50)));
    await tick(200);
    expect(store.stats().inFlight).toBe(1);
    clock.confirm();
    expect(sc.isStale()).toBe(true);
    at(fr.calls, 0).resolve({ record: { entityUri: ent("A"), v: "a2" }, etag: "a2" });
    await tick(10);
    clock.confirm();
    expect(sc.isStale()).toBe(false);
    expect(flips).toEqual([true, false]);

    // Never restored: a confirmation changes nothing.
    mkStore();
    const clock2 = createConfirmationClock();
    const flips2: boolean[] = [];
    const idle = mkCache(slotCache(), { clock: clock2, onStaleChange: (s) => flips2.push(s) });
    await idle.restore();
    await tick(10_000);
    clock2.confirm();
    expect(flips2).toEqual([]);
    expect(idle.isStale()).toBe(false);
  });

  // Spec: Kit.Client, Cache: restore never overwrites what the store already holds
  test("SC10 a restore when the store already has rows does nothing", async () => {
    put("X", "x1");
    await tick(10);
    const o = slotCache(good());
    const sc = mkCache(o);
    const r = await sc.restore();
    expect(r).toMatchObject({ restored: false, reason: "store_not_empty" });
    expect(o.loads).toBe(0);
    expect(store.all().map((x) => nameOf(x.entity))).toEqual(["X"]);
    expect(sc.isStale()).toBe(false);

    // Rows that arrive while the load is under way are not overwritten either.
    mkStore();
    let release: (v: unknown) => void = () => {};
    const slow: LiveCache<Rec> = { load: () => new Promise((res) => { release = res; }), save: () => {} };
    const sc2 = createStateCache<Rec>({ store, cache: slow, scope: SCOPE });
    caches.push(sc2);
    const pending = sc2.restore();
    put("Y", "y1");
    await tick(10);
    release(good());
    expect(await pending).toMatchObject({ restored: false, reason: "store_not_empty" });
    expect(store.all().map((x) => nameOf(x.entity))).toEqual(["Y"]);
  });

  // Spec: Kit.Client, Cache: two people on one device never see each other's state (check Confidentiality.Scope)
  test("SC11 two caches with different scopes over one slot never restore each other's state", async () => {
    const o = slotCache();
    put("A", "a1");
    await tick(10);
    const p1 = mkCache(o, { scope: "person-1:vault-1" });
    await p1.flush();
    expect(o.saved).toHaveLength(1);
    mkStore();
    const p2 = mkCache(o, { scope: "person-2:vault-1" });
    const r = await p2.restore();
    expect(r.reason).toBe("scope");
    expect(store.size()).toBe(0);
    const p1again = mkCache(o, { scope: "person-1:vault-1" });
    expect((await p1again.restore()).reason).toBe("ok");
    expect(store.size()).toBe(1);
  });
});

describe("state cache: saving", () => {
  // Spec: Kit.Client, Cache: saving is debounced and equals the store (check Resource.Bounded)
  test("SC6 ten changes in one second give one save equal to the store; flush saves at once", async () => {
    const o = slotCache();
    const sc = mkCache(o);
    sc.attach();
    for (let i = 0; i < 10; i++) {
      put(`E${i}`, `v${i}`);
      await tick(100);
    }
    expect(o.saved).toHaveLength(0);
    await tick(1100);
    expect(o.saved).toHaveLength(1);
    const s = at(o.saved, 0);
    expect(s.version).toBe(1);
    expect(s.scope).toBe(SCOPE);
    expect(s.savedAt).toBe(T0 + 2000);
    expect(s.cursor).toBe(store.lastCursor());
    expect(s.cursor).toBe(cur(10));
    expect(s.rows).toEqual(JSON.parse(JSON.stringify(store.all())));
    await tick(10_000);
    expect(o.saved).toHaveLength(1);
    expect(sc.stats().saves).toBe(1);

    put("LAST", "l1");
    await tick(10);
    await sc.flush();
    expect(o.saved).toHaveLength(2);
    expect(at(o.saved, 1).rows).toHaveLength(11);
    // The flush took the pending save with it: no second one follows.
    await tick(10_000);
    expect(o.saved).toHaveLength(2);
  });

  test("SC7 a rejecting or throwing save is swallowed and counted", async () => {
    let mode: "reject" | "throw" | "ok" = "reject";
    const saved: number[] = [];
    const cache: LiveCache<Rec> = {
      load: () => null,
      save: () => {
        if (mode === "reject") return Promise.reject(new Error("quota"));
        if (mode === "throw") throw new Error("denied");
        saved.push(1);
        return undefined;
      },
    };
    const sc = createStateCache<Rec>({ store, cache, scope: SCOPE });
    caches.push(sc);
    put("A", "a1");
    await tick(10);
    await sc.flush();
    mode = "throw";
    await sc.flush();
    expect(sc.stats().saveFailed).toBe(2);
    expect(sc.stats().saves).toBe(0);
    mode = "ok";
    await sc.flush();
    expect(saved).toHaveLength(1);
    expect(sc.stats().saves).toBe(1);
  });

  // Spec: Kit.Client, Cache: an old state is never saved as if it were new (check 13 Honesty.Freshness)
  test("SC8 no save while stale and unconfirmed; no save of an empty store unless saveEmpty", async () => {
    const o = slotCache(good());
    const sc = mkCache(o);
    await sc.restore();
    sc.attach();
    put("C", "c1");
    await tick(10_000);
    await sc.flush();
    expect(o.saved).toHaveLength(0);
    sc.markFresh();
    await tick(2100);
    expect(o.saved).toHaveLength(1);
    expect(at(o.saved, 0).rows).toHaveLength(3);

    mkStore();
    const empty = slotCache();
    const e1 = mkCache(empty);
    e1.attach();
    await e1.flush();
    await tick(10_000);
    expect(empty.saved).toHaveLength(0);
    const empty2 = slotCache();
    const e2 = mkCache(empty2, { saveEmpty: true });
    await e2.flush();
    expect(empty2.saved).toHaveLength(1);
    expect(at(empty2.saved, 0).rows).toEqual([]);
    expect(at(empty2.saved, 0).cursor).toBeNull();
  });

  test("SC8b a store above maxRows is not saved at all", async () => {
    const o = slotCache();
    const sc = mkCache(o, { maxRows: 2 });
    for (const nm of ["A", "B", "C"]) put(nm, `${nm}1`);
    await tick(10);
    await sc.flush();
    expect(o.saved).toHaveLength(0);
  });

  test("SC8c the cursor is never saved ahead of the rows", async () => {
    const fr = fakeReader();
    store.close();
    store = createLiveStore<Rec>({ holdMs: 0, read: fr.read });
    const o = slotCache();
    const sc = mkCache(o);
    sc.attach();
    store.push(n("A", 1, "a1", "change", cur(1)));
    await tick(1);
    at(fr.calls, 0).resolve({ record: { entityUri: ent("A"), v: "a1" }, etag: "a1" });
    await tick(1);
    // B is announced by the stream (cursor 2) but its read has not settled.
    store.push(n("B", 2, "b1", "change", cur(2)));
    await tick(2100);
    expect(o.saved).toHaveLength(0);
    at(fr.calls, 1).resolve({ record: { entityUri: ent("B"), v: "b1" }, etag: "b1" });
    await tick(2100);
    expect(o.saved).toHaveLength(1);
    expect(at(o.saved, 0).cursor).toBe(cur(2));
    expect(at(o.saved, 0).rows).toHaveLength(2);
    // A forced save while busy keeps the rows but gives no resume point.
    store.push(n("C", 3, "c1", "change", cur(3)));
    await tick(1);
    await sc.flush();
    expect(o.saved).toHaveLength(2);
    expect(at(o.saved, 1).cursor).toBeNull();
    expect(at(o.saved, 1).rows).toHaveLength(2);
  });

  test("SC9 clear calls remove", async () => {
    const o = slotCache(good());
    const sc = mkCache(o);
    await sc.clear();
    expect(o.removed).toBe(1);
    const bare = createStateCache<Rec>({ store, scope: SCOPE, cache: { load: () => null, save: () => {} } });
    caches.push(bare);
    await expect(bare.clear()).resolves.toBeUndefined();
  });

  test("close cancels the save timer and drops the subscriptions", async () => {
    const o = slotCache();
    const sc = mkCache(o);
    sc.attach();
    put("A", "a1");
    await tick(10);
    expect(vi.getTimerCount()).toBe(1);
    sc.close();
    expect(vi.getTimerCount()).toBe(0);
    put("B", "b1");
    await tick(10_000);
    expect(o.saved).toHaveLength(0);
    await sc.flush();
    expect(o.saved).toHaveLength(0);
  });

  // Spec: Kit.Client, Cache: the memory cache is a faithful copy
  test("SC12 the memory cache round trip", async () => {
    const mem = createMemoryCache<Rec>();
    expect(await mem.load()).toBeNull();
    const state: CachedState<Rec> = {
      version: 1,
      scope: SCOPE,
      savedAt: 1,
      cursor: null,
      rows: [{ entity: ent("A"), typeUri: TYPE, etag: null, updatedAt: null, record: { entityUri: ent("A"), v: "a" } }],
    };
    await mem.save(state);
    state.rows[0]!.record.v = "changed after save";
    const first = (await mem.load()) as CachedState<Rec>;
    expect(first.rows[0]?.record.v).toBe("a");
    first.rows[0]!.record.v = "changed after load";
    const second = (await mem.load()) as CachedState<Rec>;
    expect(second.rows[0]?.record.v).toBe("a");
    expect(second).not.toBe(first);
    await mem.remove?.();
    expect(await mem.load()).toBeNull();

    // And it works end to end with a state cache.
    put("A", "a1");
    await tick(10);
    const sc = mkCache({ cache: mem } as unknown as ReturnType<typeof slotCache>);
    await sc.flush();
    mkStore();
    const sc2 = mkCache({ cache: mem } as unknown as ReturnType<typeof slotCache>);
    const r = await sc2.restore();
    expect(r.reason).toBe("ok");
    expect(store.get(ent("A"))?.record.v).toBe("a1");
  });
});

describe("state cache: a state without a cursor", () => {
  // Spec: Kit.Client, Cache: rows saved with no resume point are never called current by a quiet stream (check 13 Honesty.Freshness)
  test("SC13 a cursor-less state needs a resync and turns fresh only by a full change or markFresh", async () => {
    // Save while a read is pending: the forced flush keeps the rows but gives no cursor.
    const fr = fakeReader();
    store.close();
    store = createLiveStore<Rec>({ holdMs: 0, read: fr.read });
    const o = slotCache();
    const saver = mkCache(o);
    store.seed([{ entity: ent("A"), typeUri: TYPE, etag: "a1", record: { entityUri: ent("A"), v: "a1" } }]);
    store.push(n("B", 2, "b1", "change", cur(2)));
    await tick(1);
    await saver.flush();
    expect(at(o.saved, 0).cursor).toBeNull();

    for (const how of ["clock", "full", "markFresh"] as const) {
      store.close();
      store = createLiveStore<Rec>({ holdMs: 0, read: fakeReader().read });
      const clock = createConfirmationClock();
      const flips: boolean[] = [];
      const sc = mkCache(o, { clock, freshAfterMs: 3000, onStaleChange: (x) => flips.push(x) });
      const r = await sc.restore();
      expect(r).toMatchObject({ restored: true, cursor: null, needsResync: true });
      await tick(60_000);
      clock.confirm();
      expect(sc.isStale()).toBe(true);
      if (how === "full") store.seed([{ entity: ent("Z"), typeUri: TYPE, etag: "z", record: { entityUri: ent("Z"), v: "z" } }]);
      if (how === "markFresh") sc.markFresh();
      expect(sc.isStale()).toBe(how === "clock");
      expect(flips).toEqual(how === "clock" ? [true] : [true, false]);
    }
  });

  // Spec: Kit.Client, Cache: a state with a cursor can be caught up from the stream (check 13 Honesty.Freshness)
  test("SC14 a state with a cursor does not need a resync and rule (c) works", async () => {
    const clock = createConfirmationClock();
    const sc = mkCache(slotCache(good()), { clock, freshAfterMs: 3000 });
    const r = await sc.restore();
    expect(r).toMatchObject({ restored: true, cursor: cur(7), needsResync: false });
    await tick(3000);
    clock.confirm();
    expect(sc.isStale()).toBe(false);
  });
});
