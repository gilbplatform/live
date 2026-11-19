import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createConfirmationClock } from "../src/confirm.js";
import { createStateCache } from "../src/state-cache.js";
import type { CachedState, LiveCache, StateCache } from "../src/state-cache.js";
import { createLiveStore } from "../src/store.js";
import type { LiveStore } from "../src/types.js";
import { cur, ent, n, T0 } from "./helpers/liveKit.js";
import type { Rec } from "./helpers/liveKit.js";

// The saved copy never skips an owed record (batch L14c): while records are owed no cursor is saved.

const SCOPE = "person-1:vault-1";
const tick = async (ms = 0): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };

let failReads = false;
let store: LiveStore<Rec>;
let seq = 0;
const caches: StateCache<Rec>[] = [];

function mkStore(): LiveStore<Rec> {
  store?.close();
  const s = createLiveStore<Rec>({
    holdMs: 0,
    random: () => 1,
    owedBackoff: { baseMs: 100, capMs: 100 },
    // Enough retries that the test's failing window never parks the entry.
    maxReadAttempts: 50,
    read: async ({ entity }) => {
      if (failReads) throw new TypeError("fetch failed");
      return { record: { entityUri: entity, v: "v" }, etag: `e-${entity}` };
    },
  });
  store = s;
  return s;
}
function put(name: string): void {
  seq++;
  store.push(n(name, seq, null, "change", cur(seq)));
}

function slotCache(initial?: unknown) {
  const o = { slot: initial as unknown, saved: [] as Array<CachedState<Rec>>, cache: undefined as unknown as LiveCache<Rec> };
  o.cache = {
    load: () => o.slot ?? null,
    save: (s) => { o.saved.push(JSON.parse(JSON.stringify(s)) as CachedState<Rec>); o.slot = s; },
  };
  return o;
}

function mkCache(c: LiveCache<Rec>, extra: Record<string, unknown> = {}): StateCache<Rec> {
  const sc = createStateCache<Rec>({ store, cache: c, scope: SCOPE, saveDebounceMs: 100, ...extra });
  caches.push(sc);
  return sc;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  failReads = false;
  seq = 0;
  mkStore();
});
afterEach(() => {
  for (const c of caches.splice(0)) c.close();
  store?.close();
  vi.useRealTimers();
});

describe("state cache with owed reads", () => {
  // Spec: Kit.Client, Honesty: a saved cursor past an owed record would lose it across a reload (LiveWire step, check 7 Delivery.Completeness)
  test("SC-O1 a debounced save is postponed while records are owed and happens after they clear", async () => {
    const slot = slotCache();
    const sc = mkCache(slot.cache);
    sc.attach();
    put("A");
    await tick(0);
    // A change armed the save timer; now a second record fails to read and becomes owed before the timer fires.
    failReads = true;
    put("B");
    await tick(0);
    expect(store.owed()).toBe(1);
    await tick(100);
    expect(slot.saved).toHaveLength(0);
    await tick(1000);
    expect(slot.saved).toHaveLength(0);
    // Recovery: the retry reads B; the next debounced save holds both rows and a cursor.
    failReads = false;
    await tick(1000);
    expect(store.owed()).toBe(0);
    expect(store.size()).toBe(2);
    await tick(500);
    expect(slot.saved.length).toBeGreaterThan(0);
    const last = slot.saved.at(-1) as CachedState<Rec>;
    expect(last.rows).toHaveLength(2);
    expect(last.cursor).toBe(cur(2));
    for (const s of slot.saved) expect(s.cursor === null || s.rows.length === 2).toBe(true);
  });

  // Spec: Kit.Client, Honesty: a forced save while records are owed keeps the rows and gives no resume point (check 7 Delivery.Completeness)
  test("SC-O2 a forced flush while records are owed saves the rows with cursor null", async () => {
    const slot = slotCache();
    const sc = mkCache(slot.cache);
    sc.attach();
    put("A");
    await tick(0);
    failReads = true;
    put("B");
    await tick(0);
    expect(store.owed()).toBe(1);
    expect(store.lastCursor()).toBe(cur(2));
    await sc.flush();
    expect(slot.saved).toHaveLength(1);
    const saved = slot.saved[0] as CachedState<Rec>;
    expect(saved.cursor).toBeNull();
    expect(saved.rows.map((r) => r.entity)).toEqual([ent("A")]);
  });

  // Spec: Kit.Client, Honesty: a restore of such a state asks for a full read and stays stale until one arrives (check 7 Delivery.Completeness)
  test("SC-O3 a restore of that state reports needsResync and stays stale until a full change", async () => {
    const slot = slotCache();
    const sc = mkCache(slot.cache);
    sc.attach();
    put("A");
    await tick(0);
    failReads = true;
    put("B");
    await tick(0);
    await sc.flush();
    sc.close();
    store.close();

    // A new page: a new store, a new clock, the saved state.
    failReads = false;
    mkStore();
    const clock = createConfirmationClock();
    const fresh = mkCache(slot.cache, { clock });
    fresh.attach();
    const r = await fresh.restore();
    expect(r.restored).toBe(true);
    expect(r.needsResync).toBe(true);
    expect(r.cursor).toBeNull();
    expect(store.size()).toBe(1);
    expect(fresh.isStale()).toBe(true);
    // Confirmations alone do not make a state without a cursor fresh.
    clock.confirm();
    await tick(10_000);
    clock.confirm();
    expect(fresh.isStale()).toBe(true);
    // The app's full read does.
    store.seed([
      { entity: ent("A"), typeUri: "https://vault.example/t/Value", etag: "x", record: { entityUri: ent("A"), v: "v" } },
      { entity: ent("B"), typeUri: "https://vault.example/t/Value", etag: "x", record: { entityUri: ent("B"), v: "v" } },
    ]);
    expect(fresh.isStale()).toBe(false);
  });

  // Spec: Kit.Client, Honesty: with nothing owed the saved copy is exactly as before (check 7 Delivery.Completeness)
  test("SC-O4 with nothing owed a forced flush and a debounced save both carry the cursor", async () => {
    const slot = slotCache();
    const sc = mkCache(slot.cache);
    sc.attach();
    put("A");
    await tick(0);
    await tick(100);
    expect(slot.saved).toHaveLength(1);
    expect((slot.saved[0] as CachedState<Rec>).cursor).toBe(cur(1));
    put("B");
    await tick(0);
    await sc.flush();
    const last = slot.saved.at(-1) as CachedState<Rec>;
    expect(last.cursor).toBe(cur(2));
    expect(last.rows).toHaveLength(2);
  });
});
