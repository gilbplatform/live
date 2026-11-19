import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLiveStore, DEFAULT_READ_BATCH_SIZE, MAX_READ_BATCH_SIZE } from "../src/store.js";
import type { LiveChange, LiveStore, LiveStoreOptions } from "../src/types.js";
import { at, cur, ent, fakeBatchReader, fakeReader, n, nameOf, rd } from "./helpers/liveKit.js";
import type { BatchAnswer, Rec } from "./helpers/liveKit.js";

let store: LiveStore<Rec> | undefined;
let changes: LiveChange<Rec>[] = [];
const tick = async (ms = 0): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };

function make(opts: Partial<LiveStoreOptions<Rec>>): LiveStore<Rec> {
  store?.close();
  changes = [];
  const s = createLiveStore<Rec>({ ...opts });
  s.subscribe((c) => changes.push(c));
  store = s;
  return s;
}
const names = (items: Array<{ entity: string }>): string[] => items.map((i) => nameOf(i.entity));
const E = (i: number): string => `E${String(i).padStart(3, "0")}`;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { store?.close(); store = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

describe("readBatch", () => {
  // Spec: Kit.Client, Store: a burst is read with one request per chunk (LiveWire step, check 12 Smoothness.Motion)
  test("BR1 20 changes make one readBatch call; 120 make calls of 50, 50 and 20", async () => {
    const fb = fakeBatchReader();
    const s = make({ readBatch: fb.readBatch });
    // Pushed against the time order, so the release order differs from the arrival order.
    for (let i = 19; i >= 0; i--) s.push(n(E(i), i, `${E(i)}-1`));
    await tick(300);
    expect(fb.calls).toHaveLength(1);
    expect(names(at(fb.calls, 0).items)).toEqual(Array.from({ length: 20 }, (_, i) => E(i)));
    fb.answerAll(at(fb.calls, 0));
    await tick();
    expect(changes).toHaveLength(1);
    expect(at(changes, 0).records).toHaveLength(20);

    const fb2 = fakeBatchReader();
    const s2 = make({ readBatch: fb2.readBatch });
    for (let i = 0; i < 120; i++) s2.push(n(E(i), i, `${E(i)}-1`));
    await tick(300);
    expect(fb2.calls.map((c) => c.items.length)).toEqual([50, 50, 20]);
    expect(names(at(fb2.calls, 1).items)[0]).toBe(E(50));
  });

  // Spec: Kit.Client, Store: null means gone, an absent key means the read failed (check Delivery.Completeness)
  test("BR2 null is gone, an absent key is a failed read, a value is applied", async () => {
    const fb = fakeBatchReader();
    const errors: Array<[string, unknown]> = [];
    const s = make({ readBatch: fb.readBatch, onReadError: (e, err) => errors.push([e, err]) });
    for (const [i, nm] of ["A", "B", "C"].entries()) s.push(n(nm, i, `${nm}-1`));
    await tick(300);
    fb.answerAll(at(fb.calls, 0));
    await tick();
    expect(s.size()).toBe(3);

    s.push(n("A", 10, "A-2"));
    s.push(n("B", 11, "B-2"));
    s.push(n("C", 12, "C-2"));
    await tick(300);
    const answer: BatchAnswer = new Map();
    answer.set(ent("A"), rd("A", "A-2"));
    answer.set(ent("B"), null);
    // C has no key at all.
    at(fb.calls, 1).resolve(answer);
    await tick();

    expect(s.get(ent("A"))?.etag).toBe("A-2");
    expect(s.get(ent("B"))).toBeUndefined();
    expect(s.get(ent("C"))?.etag).toBe("C-1");
    const last = at(changes, 1);
    expect(last.ended).toEqual([ent("B")]);
    expect(last.records.map((r) => r.v)).toEqual(["A-2"]);
    expect(s.stats().readFailed).toBe(1);
    expect(s.stats().batchMissing).toBe(1);
    expect(errors).toHaveLength(1);
    expect(at(errors, 0)[0]).toBe(ent("C"));
    expect((at(errors, 0)[1] as Error).message).toBe("not returned by readBatch");
  });

  // Spec: Kit.Client, Store: a failed batch call falls back to single reads (check Delivery.Completeness)
  test("BR3 a rejecting readBatch falls back to read for that chunk; without read it counts failures", async () => {
    const fb = fakeBatchReader();
    const fr = fakeReader();
    const s = make({ readBatch: fb.readBatch, read: fr.read, readBatchSize: 2 });
    for (let i = 0; i < 3; i++) s.push(n(E(i), i, `${E(i)}-1`));
    await tick(300);
    expect(fb.calls).toHaveLength(2);
    at(fb.calls, 0).reject(new Error("boom"));
    await tick();
    // Only the first chunk (two jobs) is re-read one by one.
    expect(names(fr.calls)).toEqual([E(0), E(1)]);
    expect(s.stats().batchFallbacks).toBe(1);
    fb.answerAll(at(fb.calls, 1));
    for (const c of fr.calls) c.resolve(rd(nameOf(c.entity), `${nameOf(c.entity)}-1`));
    await tick();
    expect(s.size()).toBe(3);
    expect(changes).toHaveLength(1);
    expect(at(changes, 0).records.map((r) => nameOf(r.entityUri))).toEqual([E(0), E(1), E(2)]);

    // A call that throws at once is the same as one that rejects.
    const fb2 = { readBatch: (() => { throw new Error("sync boom"); }) as NonNullable<LiveStoreOptions<Rec>["readBatch"]> };
    const fr2 = fakeReader();
    const s2 = make({ readBatch: fb2.readBatch, read: fr2.read });
    s2.push(n("A", 1, "A-1"));
    await tick(300);
    expect(fr2.calls).toHaveLength(1);
    expect(s2.stats().batchFallbacks).toBe(1);

    // Without read, each job of the chunk is a failed read.
    const fb3 = fakeBatchReader();
    const errors: string[] = [];
    const s3 = make({ readBatch: fb3.readBatch, onReadError: (e) => errors.push(nameOf(e)) });
    s3.push(n("A", 1, "A-1"));
    s3.push(n("B", 2, "B-1"));
    await tick(300);
    at(fb3.calls, 0).reject(new Error("down"));
    await tick();
    expect(s3.stats().batchFallbacks).toBe(1);
    expect(s3.stats().readFailed).toBe(2);
    expect(errors).toEqual(["A", "B"]);
    expect(s3.size()).toBe(0);
  });

  // Spec: Kit.Client, Store: a store without any reader is refused at creation
  test("BR4 neither read nor readBatch throws at creation", () => {
    expect(() => createLiveStore<Rec>({})).toThrow("a live store needs read or readBatch");
  });

  // Spec: Kit.Client, Store: the hint is the cursor held before the earliest-arrived notification of the chunk
  test("BR5 the hint is the cursor before the earliest-arrived notification of the chunk", async () => {
    const fb = fakeBatchReader();
    const s = make({ readBatch: fb.readBatch });
    // Arrival order X1 X2 X3; source times make the release order X2 X3 X1.
    s.push(n("X1", 5, "x1", "change", cur(1)));
    s.push(n("X2", 1, "x2", "change", cur(2)));
    s.push(n("X3", 3, "x3", "change", cur(3)));
    await tick(300);
    expect(names(at(fb.calls, 0).items)).toEqual(["X2", "X3", "X1"]);
    expect(at(fb.calls, 0).hint.sinceCursor).toBeNull();
    fb.answerAll(at(fb.calls, 0));
    await tick();

    s.push(n("Y1", 20, "y1", "change", cur(4)));
    s.push(n("Y2", 21, "y2", "change", cur(5)));
    await tick(300);
    expect(at(fb.calls, 1).hint.sinceCursor).toBe(cur(3));
    fb.answerAll(at(fb.calls, 1));
    await tick();

    // Chunks of two: each chunk looks only at its own jobs.
    const fb2 = fakeBatchReader();
    const s2 = make({ readBatch: fb2.readBatch, readBatchSize: 2 });
    s2.push(n("P", 10, "p", "change", cur(6)));
    s2.push(n("Q", 1, "q", "change", cur(7)));
    s2.push(n("R", 2, "r", "change", cur(8)));
    await tick(300);
    expect(names(at(fb2.calls, 0).items)).toEqual(["Q", "R"]);
    expect(at(fb2.calls, 0).hint.sinceCursor).toBe(cur(6));
    expect(names(at(fb2.calls, 1).items)).toEqual(["P"]);
    expect(at(fb2.calls, 1).hint.sinceCursor).toBeNull();
  });

  // Spec: Kit.Client, Store: an older answer never overwrites a newer one, also inside a batch (check Delivery.Order)
  test("BR6 a superseded item's answer inside a batch is dropped", async () => {
    const fb = fakeBatchReader();
    const s = make({ readBatch: fb.readBatch });
    s.push(n("A", 1, "a1"));
    await tick(300);
    s.push(n("A", 2, "a2"));
    await tick(300);
    expect(fb.calls).toHaveLength(2);
    // The newer answer comes first, the older one late.
    at(fb.calls, 1).resolve(new Map([[ent("A"), rd("A", "a2")]]));
    await tick();
    at(fb.calls, 0).resolve(new Map([[ent("A"), rd("A", "a1")]]));
    await tick();
    expect(s.get(ent("A"))?.etag).toBe("a2");
    expect(s.stats().superseded).toBe(1);
    // The superseded batch announces nothing; the newer one announces the record once.
    expect(changes).toHaveLength(1);
    expect(at(changes, 0).records.map((r) => r.v)).toEqual(["a2"]);
  });

  // Spec: Kit.Client, Store: close aborts the signal and ignores late answers
  test("BR7 close aborts the signal given to readBatch and a late answer is ignored", async () => {
    const fb = fakeBatchReader();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = make({ readBatch: fb.readBatch });
    s.push(n("A", 1, "a1"));
    await tick(300);
    const call = at(fb.calls, 0);
    expect(call.signal.aborted).toBe(false);
    s.close();
    expect(call.signal.aborted).toBe(true);
    fb.answerAll(call);
    await tick();
    expect(changes).toHaveLength(0);
    expect(s.size()).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    // A late rejection is ignored too, with no fallback.
    const fb2 = fakeBatchReader();
    const fr = fakeReader();
    const s2 = make({ readBatch: fb2.readBatch, read: fr.read });
    s2.push(n("A", 1, "a1"));
    await tick(300);
    s2.close();
    at(fb2.calls, 0).reject(new Error("late"));
    await tick();
    expect(fr.calls).toHaveLength(0);
    expect(s2.stats().batchFallbacks).toBe(0);
  });

  // Spec: Kit.Client, Store: one change per release, in release order, whatever order the answer map has
  test("BR8 one change per release, records in release order, even with the Map in another order", async () => {
    const fb = fakeBatchReader();
    const s = make({ readBatch: fb.readBatch });
    for (let i = 0; i < 5; i++) s.push(n(E(i), i, `${E(i)}-1`));
    await tick(300);
    const m: BatchAnswer = new Map();
    for (const i of [...at(fb.calls, 0).items].reverse()) m.set(i.entity, rd(nameOf(i.entity), `${nameOf(i.entity)}-1`));
    at(fb.calls, 0).resolve(m);
    await tick();
    expect(changes).toHaveLength(1);
    expect(at(changes, 0).records.map((r) => nameOf(r.entityUri))).toEqual([E(0), E(1), E(2), E(3), E(4)]);
    expect(s.all().map((r) => nameOf(r.entity))).toEqual([E(0), E(1), E(2), E(3), E(4)]);
  });

  // Spec: Kit.Client, Store: readBatchSize is clamped; zero and NaN use the default
  test("BR9 readBatchSize clamps", async () => {
    expect(DEFAULT_READ_BATCH_SIZE).toBe(50);
    expect(MAX_READ_BATCH_SIZE).toBe(200);
    const sizes = async (readBatchSize: number | undefined, count: number): Promise<number[]> => {
      const fb = fakeBatchReader();
      const s = make({ readBatch: fb.readBatch, readBatchSize, maxParallelReads: 10 });
      for (let i = 0; i < count; i++) s.push(n(E(i), i, `${E(i)}-1`));
      await tick(300);
      const out = fb.calls.map((c) => c.items.length);
      s.close();
      return out;
    };
    expect(await sizes(0, 60)).toEqual([50, 10]);
    expect(await sizes(Number.NaN, 60)).toEqual([50, 10]);
    expect(await sizes(undefined, 60)).toEqual([50, 10]);
    expect(await sizes(9999, 250)).toEqual([200, 50]);
    expect(await sizes(1, 3)).toEqual([1, 1, 1]);
    expect(await sizes(7, 15)).toEqual([7, 7, 1]);
  });

  // Spec: Kit.Client, Store: reading by batch gives the same rows and the same changes as reading one by one (check Delivery.Order)
  test("BR10 parity: the same scenario with read and with readBatch ends equal", async () => {
    const run = async (mode: "single" | "batch"): Promise<{ rows: unknown; changes: LiveChange<Rec>[] }> => {
      const db = new Map<string, { v: string; etag: string } | null>();
      const answer = (entity: string) => {
        const r = db.get(nameOf(entity));
        return r ? { record: { entityUri: entity, v: r.v }, etag: r.etag } : null;
      };
      const delays: Record<string, number> = { A: 30, B: 5, C: 17, D: 1, E: 22 };
      const s = createLiveStore<Rec>({
        now: () => 0,
        holdMs: 100,
        ...(mode === "single"
          ? { read: ({ entity }) => new Promise((r) => setTimeout(() => r(answer(entity)), delays[nameOf(entity)] ?? 0)) }
          : { readBatch: (items) => new Promise((r) => setTimeout(() => r(new Map(items.map((i) => [i.entity, answer(i.entity)] as const))), 12)) }),
      });
      const out: LiveChange<Rec>[] = [];
      s.subscribe((c) => out.push(c));
      const put = (nm: string, v: string | null, ms: number): void => {
        db.set(nm, v === null ? null : { v, etag: v });
        s.push(n(nm, ms, v, v === null ? "ended" : "change"));
      };
      put("A", "a1", 1); put("B", "b1", 2); put("C", "c1", 3);
      await tick(150);
      put("B", "b2", 10); put("D", "d1", 11); put("A", null, 12);
      await tick(150);
      put("A", "a3", 20); put("E", "e1", 21);
      db.set("C", null);
      s.push(n("C", 22, "c2"));
      await tick(150);
      put("D", "d2", 30);
      await tick(500);
      const result = { rows: s.all().map((r) => [r.entity, r.etag, r.record.v]), changes: out };
      s.close();
      return result;
    };
    const single = await run("single");
    const batch = await run("batch");
    expect(batch.rows).toEqual(single.rows);
    expect(batch.changes).toEqual(single.changes);
    expect(single.changes.length).toBeGreaterThanOrEqual(4);
  });

  // Spec: Kit.Client, Store: maxParallelReads limits concurrent batch calls (check Resource.Bounded)
  test("BR11 maxParallelReads 1 keeps one batch call open at a time", async () => {
    const fb = fakeBatchReader();
    const s = make({ readBatch: fb.readBatch, readBatchSize: 10, maxParallelReads: 1 });
    for (let i = 0; i < 30; i++) s.push(n(E(i), i, `${E(i)}-1`));
    await tick(300);
    expect(fb.calls).toHaveLength(1);
    // The counter of jobs in flight still counts jobs, not calls.
    expect(s.stats().inFlight).toBe(10);
    expect(s.stats().batchReads).toBe(1);
    fb.answerAll(at(fb.calls, 0));
    await tick();
    expect(fb.calls).toHaveLength(2);
    fb.answerAll(at(fb.calls, 1));
    await tick();
    fb.answerAll(at(fb.calls, 2));
    await tick();
    expect(fb.maxOpen()).toBe(1);
    expect(s.size()).toBe(30);
    expect(changes).toHaveLength(1);
    expect(s.stats().inFlight).toBe(0);
    await s.idle();
  });
});
