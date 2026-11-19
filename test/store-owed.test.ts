import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLiveStore } from "../src/store.js";
import type { LiveChange, LiveStore, LiveStoreOptions } from "../src/types.js";
import { at, ent, fakeBatchReader, fakeReader, n, nameOf, rd, t, TYPE } from "./helpers/liveKit.js";
import type { Rec } from "./helpers/liveKit.js";

// Owed reads: a failed read is kept, retried with back-off, parked after the limit, and never lost (batch L14c).
// Fake timers; the reader is settled by hand; `random: () => 1` makes the back-off exact (100, 200, 400, 800, 800 ms).

let store: LiveStore<Rec> | undefined;
let fr = fakeReader();
let changes: LiveChange<Rec>[] = [];
let errs: Array<[string, unknown]> = [];
const tick = async (ms = 0): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };
const fetchFailed = (): Error => new TypeError("fetch failed");
const withStatus = (status: number): Error => Object.assign(new Error(`status ${status}`), { status });

function make(opts: Partial<LiveStoreOptions<Rec>> = {}): LiveStore<Rec> {
  store?.close();
  fr = fakeReader();
  changes = [];
  errs = [];
  const s = createLiveStore<Rec>({
    read: fr.read,
    holdMs: 0,
    random: () => 1,
    owedBackoff: { baseMs: 100, capMs: 800 },
    onReadError: (entity, error) => { errs.push([entity, error]); },
    ...opts,
  });
  s.subscribe((c) => changes.push(c));
  store = s;
  return s;
}

/** Moves the fake clock in small steps until the reader has been called `count` times; returns the time that took. */
async function untilCalls(count: number, limitMs = 5000): Promise<number> {
  const start = Date.now();
  while (fr.calls.length < count) {
    if (Date.now() - start > limitMs) throw new Error(`reader called ${fr.calls.length} times, wanted ${count}`);
    await tick(1);
  }
  return Date.now() - start;
}

const seedRow = (name: string, v: string, updatedAt: string | null) => ({ entity: ent(name), typeUri: TYPE, etag: v, updatedAt, record: { entityUri: ent(name), v } });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 10, 19, 10, 0, 0)); });
afterEach(() => { store?.close(); store = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

describe("owed reads: keep, retry, apply", () => {
  // Spec: Kit.Client, Honesty: a failed read is never lost (LiveWire step, check 7 Delivery.Completeness)
  test("O1 a rejected read keeps the record owed; the retry applies it with one change", async () => {
    const s = make();
    s.seed([seedRow("A", "a0", t(1))]);
    changes.length = 0;
    s.push(n("A", 5, "a1"));
    await tick(0);
    expect(fr.calls).toHaveLength(1);
    at(fr.calls, 0).reject(fetchFailed());
    await tick(0);
    expect(s.owed()).toBe(1);
    expect(s.get(ent("A"))?.etag).toBe("a0");
    expect(errs).toHaveLength(1);
    expect(changes).toHaveLength(0);
    await tick(99);
    expect(fr.calls).toHaveLength(1);
    await tick(1);
    expect(fr.calls).toHaveLength(2);
    // While the retry is in flight the record still counts as owed.
    expect(s.owed()).toBe(1);
    at(fr.calls, 1).resolve(rd("A", "a1"));
    await tick(0);
    expect(changes).toHaveLength(1);
    expect(at(changes, 0).records).toEqual([{ entityUri: ent("A"), v: "a1" }]);
    expect(s.owed()).toBe(0);
    expect(s.get(ent("A"))?.etag).toBe("a1");
    expect(vi.getTimerCount()).toBe(0);
  });

  /** Fails every call and measures the wait before the next call; returns the waits. */
  async function delaysFor(random: () => number): Promise<number[]> {
    const s = make({ random, maxReadAttempts: 8 });
    s.push(n("A", 1, "a1"));
    const out: number[] = [];
    for (let i = 0; i < 5; i++) {
      at(fr.calls, i).reject(fetchFailed());
      await tick(0);
      out.push(await untilCalls(i + 2));
    }
    return out;
  }

  // Spec: Kit.Client, Honesty: retries back off and are capped, so a cut is not hammered (LiveWire step, check 7 Delivery.Completeness)
  test("O2 the back-off is exactly 100, 200, 400, 800, 800 ms with random 1, and half of it with random 0", async () => {
    expect(await delaysFor(() => 1)).toEqual([100, 200, 400, 800, 800]);
    expect(await delaysFor(() => 0)).toEqual([50, 100, 200, 400, 400]);
  });

  // Spec: Kit.Client, Honesty: after the limit the record is parked: visible, not hammered, and retried on demand (LiveWire step, check 7 Delivery.Completeness)
  test("O3 after maxReadAttempts the entry is parked with no timer; retryOwed starts a new full set of attempts", async () => {
    const s = make({ maxReadAttempts: 3 });
    s.push(n("A", 1, "a1"));
    for (let i = 0; i < 4; i++) {
      at(fr.calls, i).reject(fetchFailed());
      await tick(0);
      if (i < 3) await untilCalls(i + 2);
    }
    // The original read and three retries.
    expect(fr.calls).toHaveLength(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(s.owed()).toBe(1);
    expect(s.stats().owedParked).toBe(1);
    await tick(100_000);
    expect(fr.calls).toHaveLength(4);

    // A success after retryOwed clears it.
    s.retryOwed();
    expect(s.stats().owedParked).toBe(0);
    await tick(0);
    expect(fr.calls).toHaveLength(5);
    at(fr.calls, 4).resolve(rd("A", "a1"));
    await tick(0);
    expect(s.owed()).toBe(0);
    expect(s.stats().owedParked).toBe(0);
    expect(s.get(ent("A"))?.etag).toBe("a1");
  });

  test("O3b a still-failing retry after retryOwed parks again after another full set of attempts", async () => {
    const s = make({ maxReadAttempts: 3 });
    s.push(n("A", 1, "a1"));
    for (let i = 0; i < 4; i++) {
      at(fr.calls, i).reject(fetchFailed());
      await tick(0);
      if (i < 3) await untilCalls(i + 2);
    }
    expect(s.stats().owedParked).toBe(1);
    s.retryOwed();
    await tick(0);
    // Three more retries, the first at once, then parked again.
    for (let i = 4; i < 7; i++) {
      expect(fr.calls).toHaveLength(i + 1);
      at(fr.calls, i).reject(fetchFailed());
      await tick(0);
      if (i < 6) await untilCalls(i + 2);
    }
    expect(fr.calls).toHaveLength(7);
    expect(vi.getTimerCount()).toBe(0);
    expect(s.owed()).toBe(1);
    expect(s.stats().owedParked).toBe(1);
    await tick(100_000);
    expect(fr.calls).toHaveLength(7);
  });

  test("O18 the default budget is six retries over 31.5 s with random 1, then parked", async () => {
    const s = make({ owedBackoff: undefined, maxReadAttempts: undefined });
    s.push(n("A", 1, "a1"));
    const start = Date.now();
    at(fr.calls, 0).reject(fetchFailed());
    await tick(0);
    for (let i = 1; i <= 6; i++) {
      // The only timer is the owed timer, so the next timer is the next retry.
      await vi.advanceTimersToNextTimerAsync();
      expect(fr.calls).toHaveLength(i + 1);
      at(fr.calls, i).reject(fetchFailed());
      await tick(0);
    }
    expect(Date.now() - start).toBe(500 + 1000 + 2000 + 4000 + 8000 + 16000);
    expect(fr.calls).toHaveLength(7);
    expect(s.stats().owedParked).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("owed reads: newer news, ends and gone", () => {
  // Spec: Kit.Client, Honesty: last write wins; an old retry never overwrites newer news (LiveWire step, check 7 Delivery.Order)
  test("O4 a newer notification replaces the owed entry; the old retry never runs", async () => {
    const s = make();
    s.push(n("A", 5, "e1"));
    at(fr.calls, 0).reject(fetchFailed());
    await tick(0);
    expect(s.owed()).toBe(1);
    await tick(50);
    s.push(n("A", 10, "e2"));
    // Released at once: the new read covers the owed one.
    expect(s.owed()).toBe(0);
    expect(fr.calls).toHaveLength(2);
    await tick(1000);
    // The old retry's time has passed and nothing was read for it.
    expect(fr.calls).toHaveLength(2);
    at(fr.calls, 1).resolve(rd("A", "e2"));
    await tick(0);
    expect(changes).toHaveLength(1);
    expect(s.get(ent("A"))?.etag).toBe("e2");
    expect(s.stats().applied).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  test("O4b a retry in flight when a newer notification is released is superseded and never applies", async () => {
    const s = make();
    s.push(n("A", 5, "e1"));
    at(fr.calls, 0).reject(fetchFailed());
    await tick(100);
    expect(fr.calls).toHaveLength(2);
    // The retry (call 1) is in flight.
    s.push(n("A", 10, "e2"));
    expect(fr.calls).toHaveLength(3);
    at(fr.calls, 2).resolve(rd("A", "e2"));
    await tick(0);
    expect(s.get(ent("A"))?.etag).toBe("e2");
    // The old retry answers last, with the old content.
    at(fr.calls, 1).resolve(rd("A", "e1"));
    await tick(0);
    expect(s.get(ent("A"))?.etag).toBe("e2");
    expect(s.stats().superseded).toBe(1);
    expect(s.owed()).toBe(0);
    expect(changes).toHaveLength(1);
  });

  // Spec: Kit.Client, Honesty: an ended record never comes back through an old retry (LiveWire step, check 7 Delivery.Order)
  test("O5 an ended notification removes the owed entry; no retry runs and the record does not return", async () => {
    const s = make();
    s.push(n("A", 5, "e1"));
    at(fr.calls, 0).reject(fetchFailed());
    await tick(0);
    expect(s.owed()).toBe(1);
    s.push(n("A", 10, null, "ended"));
    expect(s.owed()).toBe(0);
    await tick(5000);
    expect(fr.calls).toHaveLength(1);
    expect(s.get(ent("A"))).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("O5b a retry in flight when the end arrives is dropped and does not bring the record back", async () => {
    const s = make();
    s.seed([seedRow("A", "e0", t(1))]);
    changes.length = 0;
    s.push(n("A", 5, "e1"));
    at(fr.calls, 0).reject(fetchFailed());
    await tick(100);
    expect(fr.calls).toHaveLength(2);
    s.push(n("A", 10, null, "ended"));
    expect(s.get(ent("A"))).toBeUndefined();
    at(fr.calls, 1).resolve(rd("A", "e1"));
    await tick(0);
    expect(s.get(ent("A"))).toBeUndefined();
    expect(s.owed()).toBe(0);
    expect(at(changes, 0).ended).toEqual([ent("A")]);
    expect(changes.every((c) => c.records.length === 0)).toBe(true);
  });

  test("O5c an end with no readable time still stops a retry in flight (the generation, not the stamp, is what protects)", async () => {
    const s = make();
    s.push(n("A", 5, "e1"));
    at(fr.calls, 0).reject(fetchFailed());
    await tick(100);
    expect(fr.calls).toHaveLength(2);
    s.push(n("A", null, null, "ended"));
    expect(s.owed()).toBe(0);
    at(fr.calls, 1).resolve(rd("A", "e1"));
    await tick(0);
    expect(s.get(ent("A"))).toBeUndefined();
    expect(s.stats().superseded).toBe(1);
  });

  // Spec: Kit.Client, Honesty: a read that finds nothing means the record is gone, not owed
  test("O6 a read that returns null is gone: not owed, not retried", async () => {
    const s = make();
    s.seed([seedRow("A", "e0", t(1))]);
    changes.length = 0;
    s.push(n("A", 5, "e1"));
    at(fr.calls, 0).resolve(null);
    await tick(0);
    expect(s.owed()).toBe(0);
    expect(s.get(ent("A"))).toBeUndefined();
    expect(at(changes, 0).ended).toEqual([ent("A")]);
    expect(vi.getTimerCount()).toBe(0);
    await tick(5000);
    expect(fr.calls).toHaveLength(1);
  });

  // Spec: Kit.Client, Honesty: a refused record (403, 404, 410) is gone for this viewer and is never retried for ever (LiveWire step, check 7 Delivery.Completeness)
  test.each([
    ["status 403", withStatus(403)],
    ["status 404", withStatus(404)],
    ["status 410", withStatus(410)],
    ["gone true", Object.assign(new Error("gone"), { gone: true })],
  ])("O7 %s is gone for this viewer: row removed, tombstone, ended, no owed entry, no timer", async (_label, error) => {
    const s = make();
    s.seed([seedRow("A", "e0", t(1))]);
    changes.length = 0;
    s.push(n("A", 5, "e1"));
    at(fr.calls, 0).reject(error);
    await tick(0);
    expect(s.owed()).toBe(0);
    expect(s.get(ent("A"))).toBeUndefined();
    expect(at(changes, 0).ended).toEqual([ent("A")]);
    expect(s.stats().readGone).toBe(1);
    expect(s.stats().ended).toBe(1);
    expect(errs).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    // The tombstone is there: an older change cannot bring the record back.
    s.push(n("A", 3, "older"));
    expect(s.stats().stale).toBe(1);
    await tick(5000);
    expect(fr.calls).toHaveLength(1);
  });

  // Spec: Kit.Client, Honesty: a network error, 401, 429 and 5xx are retryable
  test.each([
    ["TypeError fetch failed", fetchFailed()],
    ["status 401", withStatus(401)],
    ["status 429", withStatus(429)],
    ["status 500", withStatus(500)],
    ["status 503", withStatus(503)],
  ])("O8 %s creates an owed entry and a retry", async (_label, error) => {
    const s = make();
    s.push(n("A", 5, "e1"));
    at(fr.calls, 0).reject(error);
    await tick(0);
    expect(s.owed()).toBe(1);
    expect(s.stats().readFailed).toBe(1);
    expect(s.stats().readGone).toBe(0);
    expect(vi.getTimerCount()).toBe(1);
    await tick(100);
    expect(fr.calls).toHaveLength(2);
    at(fr.calls, 1).resolve(rd("A", "e1"));
    await tick(0);
    expect(s.owed()).toBe(0);
    expect(s.get(ent("A"))?.etag).toBe("e1");
  });

  test("O8b a custom isGone replaces the default", async () => {
    const s = make({ isGone: (e) => e instanceof RangeError });
    s.push(n("A", 5, "e1"));
    s.push(n("B", 6, "e1"));
    at(fr.calls, 0).reject(new RangeError("denied"));
    at(fr.calls, 1).reject(withStatus(403));
    await tick(0);
    // A is gone by the custom rule; B's 403 is not gone under it, so it is owed.
    expect(s.stats().readGone).toBe(1);
    expect(s.owed()).toBe(1);
  });
});

describe("owed reads: batch reads", () => {
  // Spec: Kit.Client, Honesty: a key that readBatch did not return is a failed read, kept as owed
  test("O9 a Map without the key is owed; it is retried through read when there is one", async () => {
    const br = fakeBatchReader();
    const s = make({ readBatch: br.readBatch });
    s.push(n("A", 5, "e1"));
    await tick(0);
    expect(br.calls).toHaveLength(1);
    at(br.calls, 0).resolve(new Map());
    await tick(0);
    expect(s.owed()).toBe(1);
    expect(s.stats().batchMissing).toBe(1);
    await tick(100);
    expect(br.calls).toHaveLength(1);
    expect(fr.calls).toHaveLength(1);
    at(fr.calls, 0).resolve(rd("A", "e1"));
    await tick(0);
    expect(s.owed()).toBe(0);
    expect(s.get(ent("A"))?.etag).toBe("e1");
  });

  test("O9b with only readBatch the retry goes through readBatch", async () => {
    const br = fakeBatchReader();
    const s = make({ read: undefined, readBatch: br.readBatch });
    s.push(n("A", 5, "e1"));
    await tick(0);
    at(br.calls, 0).resolve(new Map());
    await tick(0);
    expect(s.owed()).toBe(1);
    await tick(100);
    expect(br.calls).toHaveLength(2);
    br.answerAll(at(br.calls, 1), () => "e1");
    await tick(0);
    expect(s.owed()).toBe(0);
    expect(s.get(ent("A"))?.etag).toBe("e1");
  });

  // Spec: Kit.Client, Honesty: a failing batch call falls back to single reads, and a single read that fails is owed
  test("O10 a failing readBatch falls back to single reads; a single read that then fails is owed", async () => {
    const br = fakeBatchReader();
    const s = make({ readBatch: br.readBatch });
    s.push(n("A", 5, "e1"));
    await tick(0);
    at(br.calls, 0).reject(fetchFailed());
    await tick(0);
    expect(s.stats().batchFallbacks).toBe(1);
    expect(fr.calls).toHaveLength(1);
    expect(s.owed()).toBe(0);
    at(fr.calls, 0).reject(fetchFailed());
    await tick(0);
    expect(s.owed()).toBe(1);
    await tick(100);
    expect(fr.calls).toHaveLength(2);
  });
});

describe("owed reads: seed, close, clear, listeners", () => {
  // Spec: Kit.Client, Honesty: the seeded list is the truth, and a closed store keeps nothing running
  test("O11 seed clears the owed list and the timer", async () => {
    const s = make();
    s.push(n("A", 5, "e1"));
    at(fr.calls, 0).reject(fetchFailed());
    await tick(0);
    expect(s.owed()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    s.seed([seedRow("B", "b1", t(6))]);
    expect(s.owed()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await tick(5000);
    expect(fr.calls).toHaveLength(1);
  });

  test("O11b close clears the timer, drops the owed list and ignores a late answer", async () => {
    const s = make();
    s.push(n("A", 5, "e1"));
    s.push(n("B", 6, "e1"));
    at(fr.calls, 0).reject(fetchFailed());
    at(fr.calls, 1).reject(fetchFailed());
    await tick(100);
    // Both retries are in flight (calls 2 and 3) and one more owed entry is waiting.
    s.push(n("C", 7, "e1"));
    at(fr.calls, 4).reject(fetchFailed());
    await tick(0);
    expect(s.owed()).toBe(3);
    expect(vi.getTimerCount()).toBe(1);
    const seenErrors = errs.length;
    const seenChanges = changes.length;
    s.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(s.owed()).toBe(0);
    at(fr.calls, 2).reject(fetchFailed());
    at(fr.calls, 3).resolve(rd("B", "e1"));
    await tick(0);
    expect(errs).toHaveLength(seenErrors);
    expect(changes).toHaveLength(seenChanges);
    expect(s.get(ent("B"))).toBeUndefined();
    await tick(5000);
    expect(fr.calls).toHaveLength(5);
  });

  // Spec: Kit.Client, Honesty: the app can drop the owed list (for example when access is removed)
  test("O12 clearOwed empties the list and the timer and tells the listeners 0", async () => {
    const s = make();
    const counts: number[] = [];
    s.subscribeOwed((c) => counts.push(c));
    s.push(n("A", 5, "e1"));
    s.push(n("B", 6, "e1"));
    at(fr.calls, 0).reject(fetchFailed());
    at(fr.calls, 1).reject(fetchFailed());
    await tick(0);
    expect(counts).toEqual([1, 2]);
    s.clearOwed();
    expect(s.owed()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(counts).toEqual([1, 2, 0]);
    await tick(5000);
    expect(fr.calls).toHaveLength(2);
    // Nothing owed: a second clear tells nobody.
    s.clearOwed();
    expect(counts).toEqual([1, 2, 0]);
  });

  // Spec: Kit.Client, Honesty: listeners hear the COUNT change, once per change
  test("O13 subscribeOwed fires on each change of the count, not per attempt; a throwing listener is isolated; unsubscribe works", async () => {
    const s = make();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const counts: number[] = [];
    const later: number[] = [];
    const off = s.subscribeOwed((c) => counts.push(c));
    s.subscribeOwed(() => { throw new Error("boom"); });
    s.subscribeOwed((c) => later.push(c));
    s.push(n("A", 5, "e1"));
    at(fr.calls, 0).reject(fetchFailed());
    await tick(0);
    s.push(n("B", 6, "e1"));
    at(fr.calls, 1).reject(fetchFailed());
    await tick(0);
    expect(counts).toEqual([1, 2]);
    await tick(100);
    expect(fr.calls).toHaveLength(4);
    // A's retry fails again: the count stays 2, so nobody is told.
    at(fr.calls, 2).reject(fetchFailed());
    await tick(0);
    expect(counts).toEqual([1, 2]);
    at(fr.calls, 3).resolve(rd("B", "e1"));
    await tick(0);
    expect(counts).toEqual([1, 2, 1]);
    off();
    await untilCalls(5);
    at(fr.calls, 4).resolve(rd("A", "e1"));
    await tick(0);
    expect(counts).toEqual([1, 2, 1]);
    expect(later).toEqual([1, 2, 1, 0]);
    // The throwing listener was called for every change, and only its message was logged.
    expect(errors).toHaveBeenCalledTimes(4);
    for (const call of errors.mock.calls) {
      expect(call).toHaveLength(1);
      expect(String(call[0])).toContain("boom");
      expect(String(call[0])).not.toContain("entityUri");
    }
  });
});

describe("owed reads: order, bound, edge cases", () => {
  // Spec: Kit.Client, Honesty: retries may finish in any order; the right content wins and a stamp never goes backwards (LiveWire step, check 7 Delivery.Order)
  test("O14 retries that finish in the opposite order both apply with the right content", async () => {
    const s = make();
    s.push(n("A", 10, "a1"));
    s.push(n("B", 20, "b1"));
    at(fr.calls, 0).reject(fetchFailed());
    at(fr.calls, 1).reject(fetchFailed());
    await tick(100);
    expect(fr.calls).toHaveLength(4);
    const byEntity = (e: string) => fr.calls.slice(2).find((c) => c.entity === ent(e));
    // B answers first, then A: the opposite of the order they were announced.
    byEntity("B")?.resolve(rd("B", "b1"));
    byEntity("A")?.resolve(rd("A", "a1"));
    await tick(0);
    expect(s.get(ent("A"))?.etag).toBe("a1");
    expect(s.get(ent("B"))?.etag).toBe("b1");
    expect(s.get(ent("A"))?.updatedAt).toBe(t(10));
    expect(s.get(ent("B"))?.updatedAt).toBe(t(20));
    expect(s.owed()).toBe(0);
  });

  test("O14b a retried result never lowers a row's stamp", async () => {
    const s = make();
    s.seed([seedRow("A", "a0", t(30))]);
    // A notification with no readable time passes the stale check; the row holds t(30).
    s.push(n("A", null, "a1"));
    at(fr.calls, 0).reject(fetchFailed());
    await tick(100);
    at(fr.calls, 1).resolve(rd("A", "a1"));
    await tick(0);
    expect(s.get(ent("A"))?.etag).toBe("a1");
    expect(s.get(ent("A"))?.updatedAt).toBe(t(30));
  });

  test("O14c a retried result for an entity with a newer tombstone is dropped", async () => {
    const s = make();
    s.push(n("B", 30, null, "ended"));
    s.push(n("B", null, "b1"));
    expect(fr.calls).toHaveLength(1);
    at(fr.calls, 0).reject(fetchFailed());
    await tick(100);
    expect(fr.calls).toHaveLength(2);
    at(fr.calls, 1).resolve(rd("B", "b1"));
    await tick(0);
    expect(s.get(ent("B"))).toBeUndefined();
    expect(s.owed()).toBe(0);
  });

  // Spec: Kit.Client, Honesty: the owed list is bounded in memory
  test("O15 with maxOwed 3, four failures keep three entries and count one dropped", async () => {
    const s = make({ maxOwed: 3 });
    for (const name of ["A", "B", "C", "D"]) s.push(n(name, 5, "e1"));
    expect(fr.calls).toHaveLength(4);
    for (let i = 0; i < 4; i++) at(fr.calls, i).reject(fetchFailed());
    await tick(0);
    expect(s.owed()).toBe(3);
    expect(s.stats().owedDropped).toBe(1);
    // The oldest are kept: A, B and C are retried, D is not.
    await tick(100);
    expect(fr.calls).toHaveLength(7);
    expect(fr.calls.slice(4).map((c) => nameOf(c.entity)).sort()).toEqual(["A", "B", "C"]);
  });

  test("O16 retryOwed with nothing owed, or after close, does nothing and does not throw", async () => {
    const s = make();
    expect(() => s.retryOwed()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    s.push(n("A", 5, "e1"));
    at(fr.calls, 0).reject(fetchFailed());
    await tick(0);
    s.close();
    expect(() => s.retryOwed()).not.toThrow();
    expect(() => s.clearOwed()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    await tick(5000);
    expect(fr.calls).toHaveLength(1);
  });

  // Spec: Kit.Client, Honesty: the counters are copies and include the owed counters
  test("O17 the stats are copies and include the new counters", async () => {
    const s = make();
    const first = s.stats();
    expect(first).toMatchObject({ owed: 0, owedRetries: 0, owedParked: 0, readGone: 0, owedDropped: 0 });
    first.owed = 99;
    expect(s.stats().owed).toBe(0);
    s.push(n("A", 5, "e1"));
    at(fr.calls, 0).reject(fetchFailed());
    await tick(100);
    expect(s.stats()).toMatchObject({ owed: 1, owedRetries: 1, readFailed: 1 });
  });
});
