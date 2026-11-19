import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLiveStore } from "../src/store.js";
import type { LiveChange, LiveStore, RowChange } from "../src/types.js";
import { at, ent, n, nameOf } from "./helpers/liveKit.js";
import type { Rec } from "./helpers/liveKit.js";

let store: LiveStore<Rec> | undefined;
const tick = async (ms = 0): Promise<void> => { await vi.advanceTimersByTimeAsync(ms); };
const db = new Map<string, { v: string; etag: string } | null>();
const set = (nm: string, v: string | null): void => { db.set(nm, v === null ? null : { v, etag: v }); };

function make(): LiveStore<Rec> {
  store?.close();
  db.clear();
  const s = createLiveStore<Rec>({
    holdMs: 100,
    now: () => 777,
    read: async ({ entity }) => {
      const r = db.get(nameOf(entity));
      return r ? { record: { entityUri: entity, v: r.v }, etag: r.etag } : null;
    },
  });
  store = s;
  return s;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { store?.close(); store = undefined; vi.useRealTimers(); vi.restoreAllMocks(); });

describe("subscribeRows", () => {
  // Spec: Kit.Client, Store: the row feed carries the same batches as the record feed (LiveWire step, check 7 Delivery.Order)
  test("RW1 emits the same batches as subscribe, at the same moments, with rows[i].record === records[i]", async () => {
    const s = make();
    const log: Array<["plain" | "rows", number]> = [];
    const plain: LiveChange<Rec>[] = [];
    const rows: RowChange<Rec>[] = [];
    s.subscribe((c) => { log.push(["plain", plain.length]); plain.push(c); });
    s.subscribeRows((c) => { log.push(["rows", rows.length]); rows.push(c); });
    // Both kinds of listener must have run by the end of the same synchronous emit, not a moment later.
    const lag: number[] = [];
    s.subscribe(() => { queueMicrotask(() => lag.push(rows.length - plain.length)); });

    set("A", "a1"); set("B", "b1"); set("C", "c1");
    s.push(n("C", 3, "c1")); s.push(n("A", 1, "a1")); s.push(n("B", 2, "b1"));
    await tick(300);
    set("A", "a2"); set("B", null);
    s.push(n("A", 10, "a2")); s.push(n("B", 11, null, "ended"));
    await tick(300);
    set("B", "b3");
    s.push(n("B", 20, "b3"));
    await tick(300);

    expect(plain.length).toBe(3);
    expect(rows).toHaveLength(plain.length);
    expect(lag).toEqual([0, 0, 0]);
    for (const [i, c] of plain.entries()) {
      const r = at(rows, i);
      expect(r.full).toBe(c.full);
      expect(r.ended).toEqual(c.ended);
      expect(r.at).toBe(c.at);
      expect(r.rows).toHaveLength(c.records.length);
      for (const [j, rec] of c.records.entries()) expect(at(r.rows, j).record).toBe(rec);
    }
    // The two kinds of listener hear each change together: plain, then rows, change by change.
    expect(log).toEqual([["plain", 0], ["rows", 0], ["plain", 1], ["rows", 1], ["plain", 2], ["rows", 2]]);
    expect(at(rows, 1).ended).toEqual([ent("B")]);
    // The rows are the held rows themselves.
    const held = s.get(ent("A"));
    expect(at(rows, 1).rows[0]).toBe(held);
  });

  // Spec: Kit.Client, Store: seed is announced as a full row change
  test("RW2 seed emits a full RowChange with all rows in order", () => {
    const s = make();
    const got: RowChange<Rec>[] = [];
    s.subscribeRows((c) => got.push(c));
    s.seed([
      { entity: ent("B"), typeUri: "t/B", etag: "b", updatedAt: "2026-11-19T10:00:00.000Z", record: { entityUri: ent("B"), v: "b" } },
      { entity: ent("A"), typeUri: "t/A", etag: null, record: { entityUri: ent("A"), v: "a" } },
    ]);
    expect(got).toHaveLength(1);
    const c = at(got, 0);
    expect(c.full).toBe(true);
    expect(c.ended).toEqual([]);
    expect(c.at).toBe(777);
    expect(c.rows.map((r) => r.entity)).toEqual([ent("B"), ent("A")]);
    expect(at(c.rows, 0)).toMatchObject({ typeUri: "t/B", etag: "b", updatedAt: "2026-11-19T10:00:00.000Z" });
    expect(at(c.rows, 1)).toMatchObject({ etag: null, updatedAt: null });
    expect(c.rows).toEqual(s.all());
  });

  // Spec: Kit.Client, Store: a broken listener harms no other listener
  test("RW3 a throwing row listener does not stop the others; unsubscribe works; close drops them", async () => {
    const s = make();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const a: number[] = [];
    const b: number[] = [];
    const c: number[] = [];
    s.subscribeRows(() => { throw new Error("row listener broke"); });
    const offB = s.subscribeRows(() => b.push(1));
    s.subscribeRows(() => c.push(1));
    s.subscribe(() => a.push(1));
    set("A", "secret-value");
    s.push(n("A", 1, "e1"));
    await tick(300);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(c).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(at(spy.mock.calls, 0)[0]);
    expect(line).toContain("row listener broke");
    expect(line).not.toContain("secret-value");

    offB();
    set("A", "v2");
    s.push(n("A", 2, "e2"));
    await tick(300);
    expect(b).toHaveLength(1);
    expect(c).toHaveLength(2);

    s.close();
    const after: number[] = [];
    s.subscribeRows(() => after.push(1));
    s.seed([]);
    s.push(n("A", 3, "e3"));
    await tick(300);
    expect(c).toHaveLength(2);
    expect(after).toHaveLength(0);
  });

  // Spec: Kit.Client, Store: a row that was handed out never changes afterwards
  test("RW4 row objects are not mutated after they were emitted", async () => {
    const s = make();
    const got: RowChange<Rec>[] = [];
    s.subscribeRows((c) => got.push(c));
    set("A", "a1"); set("B", "b1");
    s.push(n("A", 1, "a1")); s.push(n("B", 2, "b1"));
    await tick(300);
    const first = at(got, 0).rows.map((r) => r);
    const snapshot = JSON.parse(JSON.stringify(first)) as unknown;

    set("A", "a2");
    s.push(n("A", 10, "a2"));
    await tick(300);
    s.push(n("B", 20, null, "ended"));
    await tick(300);
    set("B", "b3");
    s.push(n("B", 30, "b3"));
    await tick(300);
    s.seed([{ entity: ent("A"), typeUri: "t", etag: "z", record: { entityUri: ent("A"), v: "z" } }]);

    expect(JSON.parse(JSON.stringify(first))).toEqual(snapshot);
    expect(at(first, 0).etag).toBe("a1");
    expect(at(got, 1).rows[0]).not.toBe(at(first, 0));
  });
});
