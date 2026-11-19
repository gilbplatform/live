import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCoalescer, DEFAULT_COALESCE_MS, MAX_COALESCE_MS } from "../src/coalescer.js";
import type { Coalescer, CoalescerOptions } from "../src/coalescer.js";
import { createConfirmationClock } from "../src/confirm.js";
import { createLiveStore } from "../src/store.js";
import type { LiveChange, LiveStore, RowChange } from "../src/types.js";
import { applyChange } from "./helpers/applyChange.js";
import { at, cur, ent, fakeReader, mulberry32, n, nameOf, rc, row, TYPE } from "./helpers/liveKit.js";
import type { Rec } from "./helpers/liveKit.js";

const tick = async (ms = 0): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };

/** A source the test drives by hand: it hands whole batches to whoever subscribed. */
function fakeSource() {
  const listeners = new Set<(c: RowChange<Rec>) => void>();
  return {
    subscribeRows(l: (c: RowChange<Rec>) => void): () => void {
      listeners.add(l);
      return () => { listeners.delete(l); };
    },
    emit(c: RowChange<Rec>): void { for (const l of [...listeners]) l(c); },
    count: (): number => listeners.size,
  };
}

const open: Array<{ close(): void }> = [];
let applies: LiveChange<Rec>[] = [];
function mk(src: { subscribeRows(l: (c: RowChange<Rec>) => void): () => void }, opts: Partial<CoalescerOptions<Rec>> = {}): Coalescer<Rec> {
  applies = [];
  const co = createCoalescer<Rec>(src, { onApply: (c) => applies.push(c), ...opts });
  open.push(co);
  return co;
}
const uris = (c: LiveChange<Rec>): string[] => c.records.map((r) => nameOf(r.entityUri));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const o of open.splice(0)) o.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("coalescer: one apply per burst", () => {
  // Spec: Kit.Client, Coalescer: a burst of 20 changes is one apply (LiveWire step, check 12 Smoothness.Motion)
  test("CO1 20 changes inside one store period give one apply with 20 records", async () => {
    const db = new Map<string, string>();
    const store = createLiveStore<Rec>({
      read: async ({ entity }) => ({ record: { entityUri: entity, v: db.get(nameOf(entity)) ?? "?" }, etag: db.get(nameOf(entity)) ?? null }),
    });
    const co = mk(store);
    for (let i = 0; i < 20; i++) {
      db.set(`E${i}`, `v${i}`);
      store.push(n(`E${i}`, i, `v${i}`));
    }
    await tick(2000);
    expect(applies).toHaveLength(1);
    expect(at(applies, 0).records).toHaveLength(20);
    expect(co.stats().applies).toBe(1);
    store.close();
  });

  // Spec: Kit.Client, Coalescer: a steady stream still reaches the screen at least once per period (check 12 Smoothness.Motion)
  test("CO2 20 changes over 2 s give a few applies, at most one per period, and all 20 arrive", async () => {
    const db = new Map<string, string>();
    const store = createLiveStore<Rec>({
      holdMs: 250,
      read: async ({ entity }) => ({ record: { entityUri: entity, v: db.get(nameOf(entity)) ?? "?" }, etag: db.get(nameOf(entity)) ?? null }),
    });
    const stamps: number[] = [];
    const start = Date.now();
    const co = mk(store, { intervalMs: 1000, onApply: (c) => { applies.push(c); stamps.push(Date.now() - start); } });
    for (let i = 0; i < 20; i++) {
      db.set(`E${i}`, `v${i}`);
      store.push(n(`E${i}`, i, `v${i}`));
      await tick(100);
    }
    await tick(4000);
    expect(applies.length).toBeGreaterThanOrEqual(2);
    expect(applies.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < stamps.length; i++) expect((stamps[i] as number) - (stamps[i - 1] as number)).toBeGreaterThanOrEqual(1000);
    // The window is fixed: the first apply comes one period after the first batch, not after the stream ends.
    expect(at(stamps, 0)).toBeLessThanOrEqual(1300);
    expect(new Set(applies.flatMap(uris)).size).toBe(20);
    expect(co.stats().batchesSeen).toBeGreaterThan(co.stats().applies);
    store.close();
  });

  // Spec: Kit.Client, Coalescer: what the coalesced changes build always equals the store, in records and in order (check 7 Delivery.Order)
  test("CO3 parity (random): 200 scripted sequences end equal to the store, and equal to the store's own changes at every apply", async () => {
    let sawFull = 0;
    let sawEnded = 0;
    let deliveries = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const rng = mulberry32(seed);
      const pick = <X,>(a: readonly X[]): X => a[Math.floor(rng() * a.length)] as X;
      const db = new Map<string, { v: string; etag: string } | null>();
      const store = createLiveStore<Rec>({
        holdMs: pick([0, 40, 200]),
        maxParallelReads: pick([1, 4]),
        read: ({ entity }) =>
          new Promise((resolve) => {
            setTimeout(() => {
              const r = db.get(nameOf(entity));
              resolve(r ? { record: { entityUri: entity, v: r.v }, etag: r.etag } : null);
            }, Math.floor(rng() * 30));
          }),
      });
      // The reference hears the store first, so at each apply it holds the same batches as the coalescer's mirror.
      let ref: Rec[] = [];
      store.subscribe((c) => { ref = applyChange(ref, c); });
      let list: Rec[] = [];
      const problems: string[] = [];
      const co = createCoalescer<Rec>(store, {
        intervalMs: pick([0, 100, 400]),
        onApply: (c) => {
          deliveries++;
          if (c.full) sawFull++;
          if (c.ended.length > 0) sawEnded++;
          if (!c.full) for (const r of c.records) if (list.includes(r)) problems.push(`unchanged record delivered ${r.entityUri}`);
          list = applyChange(list, c);
          const a = list.map((r) => `${r.entityUri}=${r.v}`).join(",");
          const b = ref.map((r) => `${r.entityUri}=${r.v}`).join(",");
          if (a !== b) problems.push(`apply differs from the store's own changes: ${a} vs ${b}`);
        },
      });
      const names = ["A", "B", "C", "D", "E", "F"];
      let k = 0;
      let ts = 0;
      const steps = 25 + Math.floor(rng() * 30);
      for (let i = 0; i < steps; i++) {
        const r = rng();
        if (r < 0.5) {
          const nm = pick(names);
          k++;
          db.set(nm, { v: `v${k}`, etag: `e${k}` });
          store.push(n(nm, ++ts, `e${k}`, "change", cur(k)));
        } else if (r < 0.7) {
          const nm = pick(names);
          db.set(nm, null);
          store.push(n(nm, ++ts, null, "ended", cur(++k)));
        } else if (r < 0.75) {
          const keep = names.filter(() => rng() < 0.5);
          store.seed(keep.map((nm) => {
            k++;
            db.set(nm, { v: `v${k}`, etag: `e${k}` });
            return { entity: ent(nm), typeUri: TYPE, etag: `e${k}`, record: { entityUri: ent(nm), v: `v${k}` } };
          }));
        } else {
          await tick(Math.floor(rng() * 300));
        }
      }
      await tick(5000);
      co.flushNow();
      const finalStore = store.all().map((r) => `${r.entity}=${r.record.v}`).join(",");
      const finalList = list.map((r) => `${r.entityUri}=${r.v}`).join(",");
      if (finalStore !== finalList) problems.push(`final list ${finalList} differs from the store ${finalStore}`);
      expect(problems, `seed ${seed}`).toEqual([]);
      co.close();
      store.close();
    }
    // The run must have used the interesting paths, or it proves little.
    expect(deliveries).toBeGreaterThan(1000);
    expect(sawFull).toBeGreaterThan(20);
    expect(sawEnded).toBeGreaterThan(20);
  });

  // Spec: Kit.Client, Coalescer: a record that ends and comes back moves to the end, and a delta cannot say so (check 7 Delivery.Order)
  test("CO3b an entity that ends and comes back inside one period gives a full change", () => {
    const src = fakeSource();
    const co = mk(src, { intervalMs: 1000 });
    src.emit(rc([row("A", "1"), row("B", "1"), row("C", "1")], [], true));
    co.flushNow();
    expect(applies).toHaveLength(1);
    src.emit(rc([], [ent("A")]));
    src.emit(rc([row("A", "2")]));
    co.flushNow();
    expect(applies).toHaveLength(2);
    const c = at(applies, 1);
    expect(c.full).toBe(true);
    expect(uris(c)).toEqual(["B", "C", "A"]);
    expect(c.ended).toEqual([]);
    expect(co.stats().fullApplies).toBe(2);
  });

  // Spec: Kit.Client, Coalescer: a new record that lands between two old ones cannot be placed by a delta (check 7 Delivery.Order)
  test("CO3c a new record between two kept records forces a full change", () => {
    const src = fakeSource();
    const co = mk(src, { intervalMs: 1000 });
    src.emit(rc([row("A", "1"), row("B", "1")], [], true));
    co.flushNow();
    // C is new and sits after B; then B ends and returns: the order is A, C, B although A and B keep their relative order.
    src.emit(rc([row("C", "1")]));
    src.emit(rc([], [ent("B")]));
    src.emit(rc([row("B", "2")]));
    co.flushNow();
    const c = at(applies, 1);
    expect(c.full).toBe(true);
    expect(uris(c)).toEqual(["A", "C", "B"]);
    // And a plain change of one record stays a small change.
    src.emit(rc([row("C", "2")]));
    co.flushNow();
    const d = at(applies, 2);
    expect(d.full).toBe(false);
    expect(uris(d)).toEqual(["C"]);
  });

  // Spec: Kit.Client, Coalescer: a batch that is still settling in the store is never shown in part (check 7 Delivery.Completeness)
  test("CO4 whole batches: a batch with two of three reads settled causes no apply", async () => {
    const fr = fakeReader();
    const store: LiveStore<Rec> = createLiveStore<Rec>({ read: fr.read });
    const co = mk(store, { intervalMs: 0 });
    store.push(n("A", 1, "a"));
    store.push(n("B", 2, "b"));
    store.push(n("C", 3, "c"));
    await tick(300);
    expect(fr.calls).toHaveLength(3);
    at(fr.calls, 0).resolve({ record: { entityUri: at(fr.calls, 0).entity, v: "a" }, etag: "a" });
    at(fr.calls, 1).resolve({ record: { entityUri: at(fr.calls, 1).entity, v: "b" }, etag: "b" });
    await tick(50);
    expect(store.size()).toBe(2);
    expect(applies).toHaveLength(0);
    expect(co.stats().batchesSeen).toBe(0);
    expect(co.waiting()).toBe(0);
    at(fr.calls, 2).resolve({ record: { entityUri: at(fr.calls, 2).entity, v: "c" }, etag: "c" });
    await tick(50);
    expect(applies).toHaveLength(1);
    expect(uris(at(applies, 0))).toEqual(["A", "B", "C"]);
    store.close();
  });

  // Spec: Kit.Client, Coalescer: rows of a later batch that the store already holds are not in an earlier batch (check 7 Delivery.Completeness)
  test("CO4b a row that the store holds from a batch not yet announced is not delivered early", async () => {
    const fr = fakeReader();
    const store: LiveStore<Rec> = createLiveStore<Rec>({ read: fr.read });
    mk(store, { intervalMs: 0 });
    store.push(n("A", 1, "a"));
    await tick(300);
    store.push(n("B", 2, "b"));
    store.push(n("C", 3, "c"));
    await tick(300);
    expect(fr.calls.map((c) => nameOf(c.entity))).toEqual(["A", "B", "C"]);
    // B has settled, so the store holds it, but its batch (B and C) is not whole yet.
    at(fr.calls, 1).resolve({ record: { entityUri: at(fr.calls, 1).entity, v: "b" }, etag: "b" });
    await tick(10);
    at(fr.calls, 0).resolve({ record: { entityUri: at(fr.calls, 0).entity, v: "a" }, etag: "a" });
    await tick(10);
    expect(store.size()).toBe(2);
    expect(applies).toHaveLength(1);
    expect(uris(at(applies, 0))).toEqual(["A"]);
    at(fr.calls, 2).resolve({ record: { entityUri: at(fr.calls, 2).entity, v: "c" }, etag: "c" });
    await tick(10);
    expect(applies).toHaveLength(2);
    expect(uris(at(applies, 1))).toEqual(["B", "C"]);
    store.close();
  });

  // Spec: Kit.Client, Coalescer: a period of 0 shows every batch at once
  test("CO5 intervalMs 0 delivers synchronously for each batch", () => {
    const src = fakeSource();
    mk(src, { intervalMs: 0 });
    src.emit(rc([row("A", "1")]));
    expect(applies).toHaveLength(1);
    src.emit(rc([row("B", "1")]));
    expect(applies).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("CO5b the period is clamped: default, maximum, and bad values use the default", async () => {
    expect(DEFAULT_COALESCE_MS).toBe(250);
    expect(MAX_COALESCE_MS).toBe(1000);
    const delay = async (intervalMs: unknown): Promise<number> => {
      const src = fakeSource();
      const start = Date.now();
      let firedAt = -1;
      const co = mk(src, { intervalMs: intervalMs as number, onApply: () => { firedAt = Date.now() - start; } });
      src.emit(rc([row("A", "1")]));
      await tick(1500);
      co.close();
      return firedAt;
    };
    expect(await delay(undefined)).toBe(250);
    expect(await delay(Number.NaN)).toBe(250);
    expect(await delay(-5)).toBe(250);
    expect(await delay("x")).toBe(250);
    expect(await delay(5000)).toBe(1000);
    expect(await delay(100)).toBe(100);
  });

  // Spec: Kit.Client, Coalescer: an app can drive the delivery from its own frame loop
  test("CO6 an injected schedule replaces the timer; its cancel runs on pause and on close", () => {
    const src = fakeSource();
    const cancels: Array<ReturnType<typeof vi.fn>> = [];
    const runs: Array<() => void> = [];
    const schedule = vi.fn((run: () => void) => {
      runs.push(run);
      const cancel = vi.fn();
      cancels.push(cancel);
      return cancel;
    });
    const co = mk(src, { schedule });
    src.emit(rc([row("A", "1")]));
    src.emit(rc([row("B", "1")]));
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(applies).toHaveLength(0);
    at(runs, 0)();
    expect(applies).toHaveLength(1);
    expect(uris(at(applies, 0))).toEqual(["A", "B"]);

    src.emit(rc([row("C", "1")]));
    expect(schedule).toHaveBeenCalledTimes(2);
    co.pause();
    expect(at(cancels, 1)).toHaveBeenCalledTimes(1);

    co.resume();
    expect(applies).toHaveLength(2);
    src.emit(rc([row("D", "1")]));
    expect(schedule).toHaveBeenCalledTimes(3);
    co.close();
    expect(at(cancels, 2)).toHaveBeenCalledTimes(1);
  });

  // Spec: Kit.Client, Coalescer: a pause keeps the count of what waits and shows nothing (check 12 Smoothness.Motion)
  test("CO7 pause: no applies, waiting counts distinct entities, resume is one apply", () => {
    const src = fakeSource();
    const counts: number[] = [];
    const co = mk(src, { onWaiting: (k) => counts.push(k) });
    co.pause();
    expect(co.paused()).toBe(true);
    src.emit(rc([row("A", "1")]));
    expect(co.waiting()).toBe(1);
    src.emit(rc([row("A", "2")]));
    expect(co.waiting()).toBe(1);
    src.emit(rc([row("B", "1")]));
    expect(co.waiting()).toBe(2);
    src.emit(rc([], [ent("C")]));
    expect(co.waiting()).toBe(3);
    src.emit(rc([row("D", "1")]));
    src.emit(rc([], [ent("D")]));
    expect(co.waiting()).toBe(4);
    expect(counts).toEqual([1, 2, 3, 4]);
    vi.advanceTimersByTime(5000);
    expect(applies).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    co.resume();
    expect(applies).toHaveLength(1);
    expect(uris(at(applies, 0))).toEqual(["A", "B"]);
    expect(at(applies, 0).records[0]?.v).toBe("2");
    expect(co.waiting()).toBe(0);
    expect(counts).toEqual([1, 2, 3, 4, 0]);
    vi.advanceTimersByTime(5000);
    expect(applies).toHaveLength(1);

    // Pause and resume twice are the same as once.
    co.pause();
    co.pause();
    src.emit(rc([row("E", "1")]));
    co.resume();
    co.resume();
    expect(applies).toHaveLength(2);
    expect(co.paused()).toBe(false);
  });

  test("CO7b a pause cancels a pending period; an unpaused burst reports waiting and then zero", () => {
    const src = fakeSource();
    const counts: number[] = [];
    const co = mk(src, { intervalMs: 500, onWaiting: (k) => counts.push(k) });
    src.emit(rc([row("A", "1")]));
    src.emit(rc([row("B", "1")]));
    expect(vi.getTimerCount()).toBe(1);
    co.pause();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(2000);
    expect(applies).toHaveLength(0);
    co.resume();
    expect(applies).toHaveLength(1);
    expect(counts).toEqual([1, 2, 0]);
    src.emit(rc([row("C", "1")]));
    vi.advanceTimersByTime(500);
    expect(counts).toEqual([1, 2, 0, 1, 0]);
  });

  test("CO7c after a seed the waiting count is the whole list", () => {
    const src = fakeSource();
    const co = mk(src);
    co.pause();
    src.emit(rc([row("A", "1"), row("B", "1"), row("C", "1")], [], true));
    src.emit(rc([row("A", "2")]));
    expect(co.waiting()).toBe(3);
    co.resume();
    expect(at(applies, 0).full).toBe(true);
    expect(applies).toHaveLength(1);
  });

  // Spec: Kit.Client, Coalescer: resuming with nothing waiting shows nothing
  test("CO8 resume with nothing waiting makes no apply", () => {
    const src = fakeSource();
    const co = mk(src, { intervalMs: 0 });
    src.emit(rc([row("A", "1")]));
    expect(applies).toHaveLength(1);
    co.pause();
    co.resume();
    expect(applies).toHaveLength(1);
    const co2 = mk(src);
    co2.resume();
    expect(applies).toHaveLength(0);
  });

  test("CO9 flushNow delivers at once and does nothing while paused", () => {
    const src = fakeSource();
    const co = mk(src, { intervalMs: 1000 });
    src.emit(rc([row("A", "1")]));
    expect(applies).toHaveLength(0);
    co.flushNow();
    expect(applies).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    co.flushNow();
    expect(applies).toHaveLength(1);
    co.pause();
    src.emit(rc([row("B", "1")]));
    co.flushNow();
    expect(applies).toHaveLength(1);
    expect(co.waiting()).toBe(1);
  });

  test("CO10 close clears every timer and stops deliveries", () => {
    const src = fakeSource();
    const clock = createConfirmationClock();
    const co = mk(src, { intervalMs: 1000, clock, onTick: () => {}, tickMinIntervalMs: 5000 });
    clock.confirm();
    vi.advanceTimersByTime(10);
    clock.confirm();
    src.emit(rc([row("A", "1")]));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    co.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(src.count()).toBe(0);
    src.emit(rc([row("B", "1")]));
    clock.confirm();
    co.pause();
    co.resume();
    co.flushNow();
    co.close();
    vi.advanceTimersByTime(10000);
    expect(applies).toHaveLength(0);
  });

  // Spec: Kit.Client, Coalescer: a broken apply callback never stops the next delivery
  test("CO11 an onApply that throws does not stop the next delivery and logs only a message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const src = fakeSource();
    let calls = 0;
    mk(src, {
      intervalMs: 0,
      onApply: () => {
        calls++;
        if (calls === 1) throw new Error("apply broke");
      },
    });
    src.emit(rc([row("A", "secret-record")]));
    src.emit(rc([row("B", "1")]));
    expect(calls).toBe(2);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(at(spy.mock.calls, 0)[0]);
    expect(line).toContain("apply broke");
    expect(line).not.toContain("secret-record");
  });

  test("CO12 at comes from now()", () => {
    const src = fakeSource();
    let clockNow = 12345;
    mk(src, { intervalMs: 0, now: () => clockNow });
    src.emit(rc([row("A", "1")], [], false, 1));
    expect(at(applies, 0).at).toBe(12345);
    clockNow = 99999;
    src.emit(rc([row("B", "1")], [], false, 1));
    expect(at(applies, 1).at).toBe(99999);
  });

  // Spec: Kit.Client, Coalescer: the screen is current as of T only when nothing waits (check 13 Honesty.Freshness)
  test("CO13 screen confirmation follows the clock when nothing waits, stands still while changes wait, jumps after the apply", async () => {
    vi.setSystemTime(10_000);
    const src = fakeSource();
    const clock = createConfirmationClock();
    const ticks: number[] = [];
    const co = mk(src, { clock, intervalMs: 250, onTick: (a) => ticks.push(a), tickMinIntervalMs: 1000 });
    expect(co.screenConfirmedAt()).toBeNull();

    // Nothing waits: the screen time follows the clock, but the callback is throttled.
    clock.confirm();
    expect(co.screenConfirmedAt()).toBe(10_000);
    expect(ticks).toEqual([10_000]);
    await tick(100);
    clock.confirm();
    expect(co.screenConfirmedAt()).toBe(10_100);
    expect(ticks).toEqual([10_000]);
    await tick(500);
    clock.confirm();
    expect(co.screenConfirmedAt()).toBe(10_600);
    expect(ticks).toEqual([10_000]);
    await tick(400);
    expect(Date.now()).toBe(11_000);
    expect(ticks).toEqual([10_000, 10_600]);

    // A batch arrives: it waits, so the screen time stands still although the server keeps confirming.
    src.emit(rc([row("A", "1")]));
    expect(co.screenConfirmedAt()).toBe(10_600);
    await tick(100);
    clock.confirm();
    expect(clock.lastConfirmedAt()).toBe(11_100);
    expect(co.screenConfirmedAt()).toBe(10_600);
    await tick(150);
    expect(applies).toHaveLength(1);
    // The apply left nothing waiting, so the screen jumps to the latest confirmation.
    expect(co.screenConfirmedAt()).toBe(11_100);
    await tick(1000);
    expect(ticks).toEqual([10_000, 10_600, 11_100]);
    expect(co.stats().ticks).toBe(3);

    // Paused with changes waiting: still.
    src.emit(rc([row("B", "1")]));
    co.pause();
    await tick(300);
    clock.confirm();
    expect(co.screenConfirmedAt()).toBe(11_100);
    expect(co.waiting()).toBe(1);
    co.resume();
    expect(co.screenConfirmedAt()).toBe(Date.now());
    expect(applies).toHaveLength(2);
  });

  test("CO13b a pause with nothing waiting does not freeze the screen time; no clock gives null", () => {
    vi.setSystemTime(50_000);
    const src = fakeSource();
    const clock = createConfirmationClock();
    const co = mk(src, { clock });
    co.pause();
    clock.confirm();
    expect(co.screenConfirmedAt()).toBe(50_000);
    const plain = mk(src);
    src.emit(rc([row("A", "1")]));
    plain.flushNow();
    expect(plain.screenConfirmedAt()).toBeNull();
  });

  test("CO13c every received batch confirms the clock", () => {
    vi.setSystemTime(70_000);
    const src = fakeSource();
    const clock = createConfirmationClock();
    mk(src, { clock });
    expect(clock.lastConfirmedAt()).toBeNull();
    src.emit(rc([row("A", "1")]));
    expect(clock.lastConfirmedAt()).toBe(70_000);
  });

  // Spec: Kit.Client, Coalescer: the change the app receives has exactly the four keys and only what changed (check 7 Delivery.Order)
  test("CO14 a delivered change has exactly full, records, ended and at, and only changed records", () => {
    const src = fakeSource();
    const co = mk(src, { intervalMs: 1000 });
    src.emit(rc([row("A", "1"), row("B", "1"), row("C", "1")], [], true));
    co.flushNow();
    for (const c of applies) expect(Object.keys(c).sort()).toEqual(["at", "ended", "full", "records"]);
    src.emit(rc([row("B", "2")]));
    src.emit(rc([], [ent("C")]));
    co.flushNow();
    expect(applies).toHaveLength(2);
    const d = at(applies, 1);
    expect(Object.keys(d).sort()).toEqual(["at", "ended", "full", "records"]);
    expect(d.full).toBe(false);
    expect(uris(d)).toEqual(["B"]);
    expect(d.ended).toEqual([ent("C")]);
    // The same etag is not a change, even from another row object.
    src.emit(rc([row("B", "2")]));
    co.flushNow();
    expect(applies).toHaveLength(2);
  });
});
