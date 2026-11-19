import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLiveStore, MAX_TOMBSTONES } from "../src/index.js";
import type { LiveChange, LiveNotification, LiveRead, LiveStore, LiveStoreOptions } from "../src/index.js";

interface Rec {
  entityUri: string;
  v: string;
}
interface Call {
  entity: string;
  typeUri: string;
  signal: AbortSignal;
  at: number;
  resolve(v: LiveRead<Rec> | null): void;
  reject(e: unknown): void;
}

const CURSOR = "c".repeat(43);
const ent = (name: string): string => `https://vault.example/e/${name}`;
const T0 = Date.UTC(2026, 10, 19, 10, 0, 0);
/** An ISO time `ms` milliseconds after 10:00:00Z. */
const t = (ms: number): string => new Date(T0 + ms).toISOString();
const n = (name: string, updatedAt: string | null, etag: string | null, kind: "change" | "ended" = "change", cursor: string | null = CURSOR): LiveNotification => ({
  kind,
  entity: ent(name),
  typeUri: "https://vault.example/t/Value",
  etag,
  updatedAt,
  receivedAt: t(0),
  cursor,
});
const rd = (name: string, etag: string): LiveRead<Rec> => ({ record: { entityUri: ent(name), v: etag }, etag });
const at = <X,>(a: readonly X[], i: number): X => {
  const v = a[i];
  if (v === undefined) throw new Error(`no item at ${i} (length ${a.length})`);
  return v;
};

/** A reader whose answers the test settles by hand; it records every call, the signal and the (fake) time. */
function fakeReader() {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const read: LiveStoreOptions<Rec>["read"] = (nn, signal) =>
    new Promise((resolve, reject) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push({
        entity: nn.entity,
        typeUri: nn.typeUri,
        signal,
        at: Date.now(),
        resolve: (v) => { inFlight--; resolve(v); },
        reject: (e) => { inFlight--; reject(e); },
      });
    });
  return { read, calls, maxInFlight: () => maxInFlight };
}

let store: LiveStore<Rec> | undefined;
let fr = fakeReader();
let changes: LiveChange<Rec>[] = [];
const tick = async (ms = 0): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };
function make(opts: Partial<LiveStoreOptions<Rec>> = {}): LiveStore<Rec> {
  store?.close();
  fr = fakeReader();
  changes = [];
  const s = createLiveStore<Rec>({ read: fr.read, ...opts });
  s.subscribe((c) => changes.push(c));
  store = s;
  return s;
}
const names = (calls: Call[]): string[] => calls.map((c) => c.entity.slice(ent("").length));

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { store?.close(); store = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

describe("last write wins", () => {
  // Spec: Kit.Client, Store: last write wins and a burst is one change (LiveWire step, check 7 Delivery.Order and Delivery.Completeness)
  test("S1 last write wins by etag; the same etag is a duplicate and is not read", async () => {
    const s = make();
    s.push(n("A", t(1), "e1"));
    await tick(250);
    expect(fr.calls).toHaveLength(1);
    at(fr.calls, 0).resolve(rd("A", "e1"));
    await tick(0);
    expect(changes).toHaveLength(1);
    expect(at(changes, 0).records).toEqual([{ entityUri: ent("A"), v: "e1" }]);

    s.push(n("A", t(2), "e2"));
    await tick(250);
    at(fr.calls, 1).resolve(rd("A", "e2"));
    await tick(0);
    expect(changes).toHaveLength(2);
    expect(s.get(ent("A"))?.etag).toBe("e2");

    s.push(n("A", t(3), "e2"));
    await tick(250);
    expect(fr.calls).toHaveLength(2);
    expect(s.stats().duplicate).toBe(1);
    expect(changes).toHaveLength(2);
  });

  // Spec: Kit.Client, Store: the hold reorders; release order is ascending time (check Delivery.Order)
  test("S2 the hold reorders: reads start in ascending time, then entity on a tie", async () => {
    const s = make({ holdMs: 500 });
    s.push(n("B", t(200), "b"));
    s.push(n("A", t(100), "a"));
    s.push(n("C", t(300), "c"));
    await tick(499);
    expect(fr.calls).toHaveLength(0);
    await tick(1);
    expect(names(fr.calls)).toEqual(["A", "B", "C"]);

    // A time tie: the entity address orders them, ascending (not arrival order, not descending).
    const tie = make({ holdMs: 500 });
    tie.push(n("C", t(50), "c"));
    tie.push(n("A", t(50), "a"));
    tie.push(n("B", t(50), "b"));
    await tick(500);
    expect(names(fr.calls)).toEqual(["A", "B", "C"]);
  });

  // Spec: Kit.Client, Store: the wait is bounded, not rolling (check Delivery.BoundedWait)
  test("S3 the hold is a fixed window from the first item, not a rolling one", async () => {
    const s = make({ holdMs: 500, maxParallelReads: 100 });
    const start = Date.now();
    for (let i = 0; i < 20; i++) {
      s.push(n(`E${i}`, t(i), `e${i}`));
      await tick(100);
    }
    await tick(600);
    expect(fr.calls).toHaveLength(20);
    expect(at(fr.calls, 0).at - start).toBe(500);
    const times = [...new Set(fr.calls.map((c) => c.at - start))];
    expect(times).toEqual([500, 1000, 1500, 2000]);
  });

  // Spec: Kit.Client, Store: the hold is clamped to 0..500 ms (check Delivery.BoundedWait)
  test("S4 the clamp: 5000 acts as 500; negative and NaN act as 250; 0 reads inside push", async () => {
    let s = make({ holdMs: 5000 });
    s.push(n("A", t(1), "e1"));
    await tick(499);
    expect(fr.calls).toHaveLength(0);
    await tick(1);
    expect(fr.calls).toHaveLength(1);

    for (const bad of [-1, Number.NaN]) {
      s = make({ holdMs: bad });
      s.push(n("A", t(1), "e1"));
      await tick(249);
      expect(fr.calls, String(bad)).toHaveLength(0);
      await tick(1);
      expect(fr.calls, String(bad)).toHaveLength(1);
    }

    s = make({ holdMs: 0 });
    s.push(n("A", t(1), "e1"));
    expect(fr.calls).toHaveLength(1);
  });

  // Spec: Kit.Client, Store: an older answer is dropped as stale (check Delivery.NoStale)
  test("S5 a notification older than the row is stale and makes no read", async () => {
    const s = make({ holdMs: 0 });
    s.push(n("A", t(20), "e1"));
    at(fr.calls, 0).resolve(rd("A", "e1"));
    await tick(0);
    s.push(n("A", t(10), "e2"));
    expect(s.stats().stale).toBe(1);
    expect(fr.calls).toHaveLength(1);
    s.push(n("A", t(20), "e2"));
    expect(s.stats().stale).toBe(1);
    expect(fr.calls).toHaveLength(2);
  });

  // Spec: Kit.Client, Store: an ended record is not brought back by a late older change (check Delivery.NoStale)
  test("S6 the tombstone: late older change is stale; a newer one revives to the end of all()", async () => {
    const s = make({ holdMs: 0 });
    s.push(n("A", t(1), "e1"));
    at(fr.calls, 0).resolve(rd("A", "e1"));
    await tick(0);
    s.push(n("B", t(1), "b1"));
    at(fr.calls, 1).resolve(rd("B", "b1"));
    await tick(0);
    s.push(n("A", t(20), null, "ended"));
    expect(s.get(ent("A"))).toBeUndefined();

    s.push(n("A", t(10), "e2"));
    expect(s.stats().stale).toBe(1);
    expect(fr.calls).toHaveLength(2);

    s.push(n("A", t(30), "e3"));
    expect(fr.calls).toHaveLength(3);
    at(fr.calls, 2).resolve(rd("A", "e3"));
    await tick(0);
    expect(s.all().map((r) => r.entity)).toEqual([ent("B"), ent("A")]);

    s.push(n("A", t(20), null, "ended"));
    expect(s.stats().stale).toBe(2);
    expect(s.get(ent("A"))?.etag).toBe("e3");
  });

  // Spec: Kit.Client, Store: a superseded read is dropped (check Delivery.NoStale)
  test("S7 a superseded read never overwrites a newer answer", async () => {
    const s = make({ holdMs: 0 });
    s.push(n("A", t(1), "e1"));
    s.push(n("A", t(2), "e2"));
    expect(fr.calls).toHaveLength(2);
    at(fr.calls, 1).resolve(rd("A", "e2"));
    await tick(0);
    at(fr.calls, 0).resolve(rd("A", "e1"));
    await tick(0);
    expect(s.get(ent("A"))?.record.v).toBe("e2");
    expect(s.stats().superseded).toBe(1);
    expect(changes.filter((c) => c.records.length > 0)).toHaveLength(1);
  });

  // Spec: Kit.Client, Store: the read's etag is the truth, not the notification's (check Delivery.NoStale)
  test("S8 the stored etag is the read's etag", async () => {
    const s = make({ holdMs: 0 });
    s.push(n("A", t(1), "e1"));
    at(fr.calls, 0).resolve(rd("A", "e9"));
    await tick(0);
    expect(s.get(ent("A"))?.etag).toBe("e9");
    s.push(n("A", t(2), "e9"));
    expect(s.stats().duplicate).toBe(1);
    expect(fr.calls).toHaveLength(1);
  });

  // Spec: Kit.Client, Store: one burst is one change in release order (check Delivery.Completeness)
  test("S9 one batch is one change, records in release order not settle order", async () => {
    const s = make();
    s.push(n("A", t(1), "a"));
    s.push(n("B", t(2), "b"));
    s.push(n("C", t(3), "c"));
    await tick(250);
    expect(fr.calls).toHaveLength(3);
    at(fr.calls, 2).resolve(rd("C", "c"));
    await tick(0);
    at(fr.calls, 1).resolve(rd("B", "b"));
    await tick(0);
    expect(changes).toHaveLength(0);
    at(fr.calls, 0).resolve(rd("A", "a"));
    await tick(0);
    expect(changes).toHaveLength(1);
    expect(at(changes, 0).records.map((r) => r.v)).toEqual(["a", "b", "c"]);
    expect(s.all().map((r) => r.record.v)).toEqual(["a", "b", "c"]);
  });

  // Spec: Kit.Client, Store: two releases are two changes (check Delivery.Completeness)
  test("S10 two releases make two changes", async () => {
    const s = make();
    s.push(n("A", t(1), "a"));
    await tick(250);
    s.push(n("B", t(2), "b"));
    await tick(250);
    expect(fr.calls).toHaveLength(2);
    at(fr.calls, 1).resolve(rd("B", "b"));
    at(fr.calls, 0).resolve(rd("A", "a"));
    await tick(0);
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.records.length)).toEqual([1, 1]);
    expect(s.size()).toBe(2);
  });

  // Spec: Kit.Client, Store: an ended or vanished record leaves the store and is listed as ended (check Delivery.Completeness)
  test("S11 ended removes the row; a read that returns null does too", async () => {
    const s = make({ holdMs: 0 });
    s.push(n("A", t(1), "a"));
    at(fr.calls, 0).resolve(rd("A", "a"));
    await tick(0);
    changes.length = 0;
    s.push(n("A", t(2), null, "ended"));
    expect(s.get(ent("A"))).toBeUndefined();
    expect(changes).toHaveLength(1);
    expect(at(changes, 0)).toMatchObject({ full: false, records: [], ended: [ent("A")] });

    s.push(n("B", t(1), "b"));
    at(fr.calls, 1).resolve(rd("B", "b"));
    await tick(0);
    s.push(n("B", t(5), "b2"));
    at(fr.calls, 2).resolve(null);
    await tick(0);
    expect(s.get(ent("B"))).toBeUndefined();
    expect(at(changes, changes.length - 1).ended).toEqual([ent("B")]);
    expect(s.stats().ended).toBe(2);
    s.push(n("B", t(3), "b3"));
    expect(s.stats().stale).toBe(1);
  });

  // Spec: Kit.Client, Store: a failed read changes nothing and a later good one repairs (check Delivery.Resilience)
  test("S12 a rejected read keeps the old row, is counted and reported once", async () => {
    const onReadError = vi.fn(() => { throw new Error("handler broke"); });
    const s = make({ holdMs: 0, onReadError });
    s.push(n("A", t(1), "e1"));
    at(fr.calls, 0).resolve(rd("A", "e1"));
    await tick(0);
    const before = changes.length;
    const boom = new Error("boom");
    s.push(n("A", t(2), "e2"));
    at(fr.calls, 1).reject(boom);
    await tick(0);
    expect(changes).toHaveLength(before);
    expect(s.get(ent("A"))?.record.v).toBe("e1");
    expect(s.stats().readFailed).toBe(1);
    expect(onReadError).toHaveBeenCalledTimes(1);
    expect(onReadError).toHaveBeenCalledWith(ent("A"), boom);

    s.push(n("A", t(3), "e3"));
    at(fr.calls, 2).resolve(rd("A", "e3"));
    await tick(0);
    expect(s.get(ent("A"))?.record.v).toBe("e3");
    expect(changes).toHaveLength(before + 1);
  });

  // Spec: Kit.Client, Store: re-reads run with a parallel limit (check Delivery.Load)
  test("S13 never more than maxParallelReads in flight, and all are applied", async () => {
    const s = make({ maxParallelReads: 2 });
    for (let i = 0; i < 6; i++) s.push(n(`E${i}`, t(i), `e${i}`));
    await tick(250);
    expect(fr.calls).toHaveLength(2);
    expect(s.stats().inFlight).toBe(2);
    for (let i = 0; i < 6; i++) {
      await tick(0);
      at(fr.calls, i).resolve(rd(`E${i}`, `e${i}`));
    }
    await tick(0);
    expect(fr.maxInFlight()).toBe(2);
    expect(s.stats().applied).toBe(6);
    expect(s.size()).toBe(6);
    expect(changes).toHaveLength(1);
  });

  // Spec: Kit.Client, Store: a seed replaces everything and drops what was in flight (check Delivery.Completeness)
  test("S14 seed emits one full change, drops in-flight reads, the buffer and the tombstones", async () => {
    const s = make();
    s.seed([
      { entity: ent("A"), typeUri: "t", etag: "a", record: { entityUri: ent("A"), v: "a" } },
      { entity: ent("B"), typeUri: "t", etag: "b", record: { entityUri: ent("B"), v: "b" } },
    ]);
    expect(changes).toHaveLength(1);
    expect(at(changes, 0)).toMatchObject({ full: true, ended: [] });
    expect(at(changes, 0).records).toHaveLength(2);

    s.push(n("Z", t(5), null, "ended"));
    s.push(n("C", t(1), "c"));
    await tick(250);
    expect(fr.calls).toHaveLength(1);
    s.push(n("D", t(2), "d"));
    expect(s.stats().held).toBe(1);

    s.seed([{ entity: ent("X"), typeUri: "t", etag: "x", record: { entityUri: ent("X"), v: "x" } }]);
    expect(s.stats().held).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(s.all().map((r) => r.entity)).toEqual([ent("X")]);
    const n1 = changes.length;

    at(fr.calls, 0).resolve(rd("C", "c"));
    await tick(0);
    expect(s.get(ent("C"))).toBeUndefined();
    expect(s.stats().superseded).toBe(1);
    expect(changes).toHaveLength(n1);

    s.push(n("Z", t(1), "z"));
    await tick(250);
    expect(fr.calls).toHaveLength(2);

    s.seed([]);
    expect(at(changes, changes.length - 1)).toMatchObject({ full: true, records: [], ended: [] });
    expect(s.size()).toBe(0);
  });

  // Spec: Kit.Client, Store: a listener that throws stops no one and leaks no data (check Delivery.Resilience, Delivery.NoLeak)
  test("S15 listeners: a throwing one does not stop the next; unsubscribe works; only the error text is logged", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = make();
    const seen: string[] = [];
    s.subscribe(() => { throw new Error("listener-failed"); });
    s.subscribe(() => seen.push("second"));
    const off = s.subscribe(() => seen.push("third"));
    off();
    s.seed([{ entity: ent("A"), typeUri: "t", etag: "a", record: { entityUri: ent("A"), v: "PRIVATE-DATA" } }]);
    expect(seen).toEqual(["second"]);
    expect(changes).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const logged = spy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("listener-failed");
    expect(logged).not.toContain("PRIVATE-DATA");
    expect(logged).not.toContain(ent("A"));
  });

  // Spec: Kit.Client, Store: lastCursor follows arrival order (check Delivery.Resume)
  test("S16 lastCursor is the cursor of the last arrival, even stale, duplicate or filtered", async () => {
    const c = (ch: string): string => ch.repeat(43);
    const s = make({ holdMs: 0, accept: (x) => x.entity !== ent("F") });
    expect(s.lastCursor()).toBeNull();
    s.push(n("A", t(20), "e1", "change", c("a")));
    expect(s.lastCursor()).toBe(c("a"));
    at(fr.calls, 0).resolve(rd("A", "e1"));
    await tick(0);
    s.push(n("A", t(10), "e0", "change", c("b")));
    expect(s.stats().stale).toBe(1);
    expect(s.lastCursor()).toBe(c("b"));
    s.push(n("A", t(30), "e1", "change", c("d")));
    expect(s.stats().duplicate).toBe(1);
    expect(s.lastCursor()).toBe(c("d"));
    s.push(n("F", t(30), "f", "change", c("f")));
    expect(s.lastCursor()).toBe(c("f"));
    s.push({ ...n("A", t(40), "e5", "change", "bad cursor"), cursor: "bad cursor" });
    s.push({ kind: "nope" } as unknown as LiveNotification);
    expect(s.stats().invalid).toBe(2);
    expect(s.lastCursor()).toBe(c("f"));
    s.push(n("A", t(41), "e6", "change", null));
    expect(s.lastCursor()).toBe(c("f"));
  });

  // Spec: Kit.Client, Store: the accept filter keeps foreign types out (check Delivery.Scope)
  test("S17 a notification the filter rejects is never read, never stale, and still moves lastCursor", async () => {
    const s = make({ holdMs: 0, accept: (x) => x.entity !== ent("B") });
    s.push(n("B", t(1), "b", "change", "z".repeat(43)));
    await tick(300);
    expect(fr.calls).toHaveLength(0);
    expect(s.stats().stale).toBe(0);
    expect(s.stats().held).toBe(0);
    expect(s.lastCursor()).toBe("z".repeat(43));
  });

  // Spec: Kit.Client, Store: close stops everything and later answers are ignored (check Delivery.Shutdown)
  test("S18 close: no timer, reads aborted, late answers ignored, later calls do nothing", async () => {
    const onReadError = vi.fn();
    const s = make({ onReadError });
    s.push(n("A", t(1), "a"));
    s.push(n("B", t(2), "b"));
    await tick(250);
    expect(fr.calls).toHaveLength(2);
    s.push(n("C", t(3), "c"));
    expect(vi.getTimerCount()).toBe(1);
    s.close();
    s.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(fr.calls.every((c) => c.signal.aborted)).toBe(true);
    at(fr.calls, 0).reject(new Error("aborted late"));
    at(fr.calls, 1).resolve(rd("B", "b"));
    await tick(0);
    expect(onReadError).not.toHaveBeenCalled();
    expect(changes).toHaveLength(0);
    expect(s.size()).toBe(0);
    const pushed = s.stats().pushed;
    s.push(n("D", t(4), "d"));
    s.seed([{ entity: ent("X"), typeUri: "t", etag: "x", record: { entityUri: ent("X"), v: "x" } }]);
    void s.flush();
    await tick(500);
    expect(s.stats().pushed).toBe(pushed);
    expect(changes).toHaveLength(0);
    expect(fr.calls).toHaveLength(2);
    await expect(s.idle()).resolves.toBeUndefined();
  });

  // Spec: Kit.Client, Store: flush and idle (check Delivery.Completeness)
  test("S19 flush releases before the timer and resolves after the batch; idle waits for everything", async () => {
    const s = make();
    s.push(n("A", t(1), "a"));
    let idleDone = false;
    void s.idle().then(() => { idleDone = true; });
    await tick(100);
    expect(idleDone).toBe(false);
    let flushed = false;
    const p = s.flush().then(() => { flushed = true; });
    expect(fr.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    await tick(0);
    expect(flushed).toBe(false);
    expect(idleDone).toBe(false);
    at(fr.calls, 0).resolve(rd("A", "a"));
    await tick(0);
    await p;
    expect(flushed).toBe(true);
    expect(idleDone).toBe(true);
    expect(changes).toHaveLength(1);
    await expect(s.idle()).resolves.toBeUndefined();
  });

  // Spec: Kit.Client, Store: stats are copies (check Delivery.Observability)
  test("S20 stats returns a copy", () => {
    const s = make();
    const a = s.stats();
    a.pushed = 99;
    a.applied = 99;
    expect(s.stats().pushed).toBe(0);
    expect(s.stats().applied).toBe(0);
    expect(s.stats()).not.toBe(s.stats());
  });

  // Spec: Kit.Client, Store: the tombstone map is bounded (check Delivery.Bounded)
  test("S21 tombstones are capped: the oldest is forgotten, the recent ones still guard", async () => {
    const s = make({ holdMs: 0 });
    for (let i = 0; i < MAX_TOMBSTONES + 5; i++) s.push(n(`E${i}`, t(100), null, "ended"));
    expect(s.stats().ended).toBe(MAX_TOMBSTONES + 5);
    s.push(n("E0", t(1), "x"));
    expect(fr.calls).toHaveLength(1);
    expect(s.stats().stale).toBe(0);
    s.push(n(`E${MAX_TOMBSTONES + 4}`, t(1), "y"));
    expect(fr.calls).toHaveLength(1);
    expect(s.stats().stale).toBe(1);
  });

  // Spec: Kit.Client, Store: overlapping batches never announce an older record as current (check Delivery.NoStale)
  test("S22 an older batch finishing late announces the current record, not its own", async () => {
    // Batch 1 holds A and B; A answers e1 at once while B is still being read.
    const s = make({ holdMs: 250 });
    s.push(n("A", t(1), "e1"));
    s.push(n("B", t(2), "b1"));
    await tick(250);
    at(fr.calls, 0).resolve(rd("A", "e1"));
    await tick(0);
    // A new release for A (batch 2) lands while batch 1 still waits for B.
    s.push(n("A", t(3), "e2"));
    await tick(250);
    at(fr.calls, 2).resolve(rd("A", "e2"));
    await tick(0);
    expect(at(changes, 0).records.map((r) => r.v)).toEqual(["e2"]);
    at(fr.calls, 1).resolve(rd("B", "b1"));
    await tick(0);
    const last = at(changes, changes.length - 1);
    expect(last.records.find((r) => r.entityUri === ent("A"))?.v).toBe("e2");
    expect(s.get(ent("A"))?.record.v).toBe("e2");
  });

  // Spec: Kit.Client, Store: an unreadable time sorts last and is the least key (check Delivery.Order)
  test("S23 unparseable updatedAt: last in release order, least key, never stale", async () => {
    const s = make({ holdMs: 500 });
    s.push(n("X", null, "x"));
    s.push(n("A", t(100), "a"));
    s.push(n("Y", "not a date", "y"));
    s.push(n("B", t(50), "b"));
    await tick(500);
    expect(names(fr.calls)).toEqual(["B", "A", "X", "Y"]);

    // One entity, both arrival orders: the parseable notification is the one held.
    for (const parseableFirst of [true, false]) {
      const q = make({ holdMs: 500 });
      const good = n("P", t(10), "good");
      const bad = n("P", "garbage", "bad");
      for (const x of parseableFirst ? [good, bad] : [bad, good]) q.push(x);
      expect(q.stats().held).toBe(1);
      await tick(500);
      expect(fr.calls).toHaveLength(1);
      at(fr.calls, 0).resolve(rd("P", "read"));
      await tick(0);
      expect(q.get(ent("P"))?.updatedAt, String(parseableFirst)).toBe(t(10));
    }

    // Never stale: a change with an unreadable time is read even when the row holds a time.
    const r = make({ holdMs: 0 });
    r.push(n("A", t(20), "e1"));
    at(fr.calls, 0).resolve(rd("A", "e1"));
    await tick(0);
    r.push(n("A", "garbage", "e2"));
    r.push(n("A", null, "e3"));
    expect(r.stats().stale).toBe(0);
    expect(fr.calls).toHaveLength(3);
  });

  // Spec: Kit.Client, Store: a stale end must not overtake a newer read in flight (check Delivery.NoStale)
  test("S24 an older end while a newer read is in flight is stale and supersedes nothing", async () => {
    const s = make({ holdMs: 250 });
    s.push(n("A", t(30), "e3"));
    await tick(250);
    expect(fr.calls).toHaveLength(1);
    s.push(n("A", t(20), null, "ended"));
    await tick(250);
    expect(s.stats().stale).toBe(1);
    expect(s.stats().ended).toBe(0);
    at(fr.calls, 0).resolve(rd("A", "e3"));
    await tick(0);
    expect(s.stats().superseded).toBe(0);
    expect(s.get(ent("A"))?.record.v).toBe("e3");
    s.push(n("A", t(40), null, "ended"));
    await tick(250);
    expect(s.stats().stale).toBe(1);
    expect(s.get(ent("A"))).toBeUndefined();
  });

  // Spec: Kit.Client, Store: an older change must not overtake a newer read in flight (check Delivery.NoStale)
  test("S25 an older change while a newer read is in flight is stale; the row keeps the newer time", async () => {
    const s = make({ holdMs: 250 });
    s.push(n("A", t(30), "e3"));
    await tick(250);
    s.push(n("A", t(20), "e2"));
    await tick(250);
    expect(s.stats().stale).toBe(1);
    expect(fr.calls).toHaveLength(1);
    at(fr.calls, 0).resolve(rd("A", "e3"));
    await tick(0);
    expect(s.stats().superseded).toBe(0);
    expect(s.get(ent("A"))?.updatedAt).toBe(t(30));
  });
});
