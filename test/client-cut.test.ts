import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createLiveClient } from "../src/client.js";
import type { LiveClient, LiveClientOptions, SeedRow } from "../src/client.js";
import { createMemoryCache } from "../src/state-cache.js";
import type { CachedState, LiveCache } from "../src/state-cache.js";
import { FrameServer, StreamScript, cursor, feedPage, frameData } from "./helpers/frameServer.js";
import type { SeenRequest } from "./helpers/frameServer.js";

// The D2 shape on the kit (batch L14c): a total network cut destroys record reads in flight and for a while after; no record
// may be lost. The real transport and the local frame server, a fake `read` that fails with `fetch failed` on demand.
// Real timers; the back-offs are small, and each test has a bounded wait.

const TYPE = "https://vault.example/t/Value";
const HEAD = cursor("H1");
const T0 = Date.UTC(2026, 10, 19, 10, 0, 0);
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const ent = (name: string): string => `https://vault.example/e/${name}`;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const cur = (i: number): string => cursor(String(i).padStart(4, "0"));

async function until(predicate: () => boolean, ms = 3000, what = "the condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await wait(10);
  }
}

interface Rec { entity: string; v: string }

/** What the test can change while the client runs. */
interface Control {
  /** Every read fails while this is true. */
  failing: boolean;
  /** Every read that ENDS before this time (epoch ms) fails, including one already in flight. */
  cutUntil: number;
  /** Entities whose read answers 403. */
  refused: Set<string>;
  /** What a successful read returns for an entity (default "v1"). */
  content: Map<string, string>;
  /** The n-th read of one entity waits for the gate before it answers. */
  hold: { entity: string; nth: number; gate: Promise<void> } | null;
}

interface Rig {
  server: FrameServer;
  client: LiveClient<Rec>;
  ctl: Control;
  attempts: Map<string, number>;
  streams: StreamScript[];
  /** The total number of reads started. */
  reads(): number;
  stop(): Promise<void>;
}

const open: Rig[] = [];
afterEach(async () => {
  for (const r of open.splice(0)) await r.stop();
});

/** A frame for the i-th change: an entity named by `name` (default r<i>), a time that rises with i. */
const frame = (i: number, name = `r${i}`): { id: string; data: unknown } => ({ id: cur(i), data: frameData(ent(name), at(i)) });

/**
 * Builds a server, a client on the kit's own transport and the controls. `streams` are given to successive stream requests in
 * turn (the last one repeats). Small back-off by default: 50 ms base, 400 ms cap.
 */
async function rigFor(streams: StreamScript[], over: Partial<LiveClientOptions<Rec>> = {}, start = true): Promise<Rig> {
  const server = new FrameServer();
  await server.start();
  server.handler = (r: SeenRequest) => {
    if (r.kind === "stream") return streams[Math.min(server.of("stream").length - 1, streams.length - 1)] as StreamScript;
    if (r.kind === "head-live") return { status: 200, json: feedPage([], HEAD, true) };
    return { status: 200, json: feedPage([], r.query.get("since"), true) };
  };
  const ctl: Control = { failing: false, cutUntil: 0, refused: new Set(), content: new Map(), hold: null };
  const attempts = new Map<string, number>();
  let total = 0;
  const client = createLiveClient<Rec>({
    origin: server.origin,
    vaultId: "vault-1",
    types: ["Value"],
    auth: () => ({ authorization: "Bearer tok" }),
    read: async (n) => {
      total++;
      const a = (attempts.get(n.entity) ?? 0) + 1;
      attempts.set(n.entity, a);
      if (ctl.hold && ctl.hold.entity === n.entity && ctl.hold.nth === a) await ctl.hold.gate;
      // The answer takes a moment, so a cut that starts meanwhile destroys a read that is already in flight.
      await wait(5);
      if (ctl.refused.has(n.entity)) throw Object.assign(new Error("forbidden"), { status: 403 });
      if (ctl.failing || Date.now() < ctl.cutUntil) throw new TypeError("fetch failed");
      const v = ctl.content.get(n.entity) ?? "v1";
      return { record: { entity: n.entity, v }, etag: v };
    },
    resync: async () => [],
    keyOf: (r) => r.entity,
    holdMs: 0,
    coalesceMs: 0,
    owedBackoff: { baseMs: 50, capMs: 400 },
    ...over,
  });
  const rig: Rig = {
    server, client, ctl, attempts, streams,
    reads: () => total,
    stop: async () => {
      await client.stop();
      await server.close();
    },
  };
  open.push(rig);
  if (start) {
    await client.start();
    await until(() => server.of("stream").length >= 1, 3000, "the stream open");
  }
  return rig;
}

const sum = (m: Map<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);

// --- CU1 and CU2: one run of the 200-record cut, two sets of claims ---
/** True when the condition holds before the time is up; false (never a throw) otherwise, so the tests can say what is missing. */
async function settles(predicate: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) return false;
    await wait(10);
  }
  return true;
}

describe("a total cut with 200 records", () => {
  interface Sample { owed: number; dotOwed: number; showLive: boolean; screen: number | null; cursor: string | null }
  let samples: Sample[] = [];
  let reachedAll = false;
  let liveBack = false;
  let finalDot = { showLive: false, owed: -1 };
  let applied = -1;
  let size = -1;
  let owedEnd = -1;
  let entities: string[] = [];

  beforeAll(async () => {
    const s = new StreamScript();
    // The budget (200, 400, 800, 1600, 1600, 1600 ms, at least half of each) is longer than the 2.5 s cut, so nothing is parked.
    const rig = await rigFor([s], { owedBackoff: { baseMs: 200, capMs: 1600 }, maxReadAttempts: 6 });
    const owedOf = (): number => (rig.client as { owed?: () => number }).owed?.() ?? 0;
    const sampler = setInterval(() => {
      const d = rig.client.dot();
      samples.push({ owed: owedOf(), dotOwed: (d as { owed?: number }).owed ?? 0, showLive: d.showLive, screen: rig.client.screenConfirmedAt(), cursor: rig.client.store.lastCursor() });
    }, 5);
    try {
      for (let i = 1; i <= 200; i++) {
        // The cut starts at the 80th change: reads in flight now, and every read for 2.5 s, fail.
        if (i === 80) rig.ctl.cutUntil = Date.now() + 2500;
        s.frame(frame(i));
        if (i % 10 === 0) await wait(30);
      }
      reachedAll = await settles(() => rig.client.store.size() === 200 && owedOf() === 0, 25_000);
      s.heartbeat();
      liveBack = await settles(() => rig.client.dot().showLive, 5000);
      finalDot = { showLive: rig.client.dot().showLive, owed: (rig.client.dot() as { owed?: number }).owed ?? 0 };
      applied = rig.client.store.stats().applied;
      size = rig.client.store.size();
      owedEnd = owedOf();
      entities = rig.client.store.all().map((r) => r.entity);
    } finally {
      clearInterval(sampler);
    }
  }, 60_000);

  // Spec: Kit.Client, Honesty: a failed read is never lost (LiveWire step, check 7 Delivery.Completeness)
  test("CU1 the cut: all 200 records arrive exactly once, nothing is owed, the cursor only moves forward", () => {
    // On the old code a cut loses records for good, and this is where it shows: fewer than 200 are held, even long after.
    expect(size).toBe(200);
    expect(reachedAll).toBe(true);
    expect(new Set(entities).size).toBe(200);
    for (let i = 1; i <= 200; i++) expect(entities).toContain(ent(`r${i}`));
    expect(owedEnd).toBe(0);
    expect(applied).toBe(200);
    const cursors = samples.map((s) => s.cursor).filter((c): c is string => c !== null);
    expect(cursors.length).toBeGreaterThan(10);
    for (let i = 1; i < cursors.length; i++) expect((cursors[i] as string) >= (cursors[i - 1] as string)).toBe(true);
    expect(cursors.at(-1)).toBe(cur(200));
  });

  // Spec: Kit.Client, Honesty: the dot never says Live while a record is owed (LiveWire step, check 8 Honesty.LiveState)
  test("CU2 the dot: never Live while owed, the count matches, the screen time stands still, Live returns after the last read", () => {
    const owedSamples = samples.filter((s) => s.owed > 0);
    // Not vacuous: the cut was long and sampled often.
    expect(owedSamples.length).toBeGreaterThan(50);
    for (const s of owedSamples) {
      expect(s.showLive).toBe(false);
      expect(s.dotOwed).toBe(s.owed);
    }
    // The screen time, within one unbroken run of owed samples, never takes a second value.
    let runScreens = new Set<number | null>();
    for (const s of samples) {
      if (s.owed > 0) runScreens.add(s.screen);
      else runScreens = new Set();
      expect(runScreens.size).toBeLessThanOrEqual(1);
    }
    expect(liveBack).toBe(true);
    expect(finalDot.showLive).toBe(true);
    expect(finalDot.owed).toBe(0);
  });

  afterAll(() => { samples = []; });
});

describe("a long cut, access removal, a refused record, a newer change", () => {
  // Spec: Kit.Client, Honesty: a record parked after its tries is retried on the next reconnect and nothing is lost (check 7 Delivery.Completeness)
  test("CU3 a long cut: records are parked, the stream is cut and restored, retryOwed brings them all in", async () => {
    const s1 = new StreamScript();
    const s2 = new StreamScript();
    const rig = await rigFor([s1, s2], { maxReadAttempts: 2, owedBackoff: { baseMs: 30, capMs: 60 } });
    rig.ctl.failing = true;
    for (let i = 1; i <= 10; i++) s1.frame(frame(i));
    await until(() => rig.client.store.stats().owedParked === 10, 8000, "all ten records parked");
    expect(rig.client.owed()).toBe(10);
    expect([...rig.attempts.values()]).toEqual(Array(10).fill(3));
    // The reads work again, but nothing asks: parked means quiet.
    rig.ctl.failing = false;
    await wait(300);
    expect(rig.client.owed()).toBe(10);
    expect(rig.client.store.size()).toBe(0);
    expect(sum(rig.attempts)).toBe(30);
    // The stream is cut and the transport reconnects; the reconnect asks the store to retry what is owed.
    s1.cut();
    await until(() => rig.client.store.size() === 10 && rig.client.owed() === 0, 10_000, "the records after the reconnect");
    expect(rig.server.of("stream").length).toBeGreaterThanOrEqual(2);
    expect(rig.server.of("stream")[1]?.query.get("since")).toBe(cur(10));
    expect(rig.client.store.stats().owedParked).toBe(0);
  }, 30_000);

  // Spec: Kit.Client, Honesty: when access is removed the owed list is dropped and nothing more is read (LiveWire step, check 11 Security.RevokeStops)
  test("CU4 access removed: the dot is stopped (access_removed), the owed list is empty, no further read is attempted", async () => {
    const s1 = new StreamScript();
    const rig = await rigFor([s1], { maxReadAttempts: 50, owedBackoff: { baseMs: 40, capMs: 80 } });
    rig.ctl.failing = true;
    for (let i = 1; i <= 5; i++) s1.frame(frame(i));
    await until(() => rig.client.owed() === 5, 5000, "five owed records");
    s1.closedFrame("revoked").end();
    await until(() => rig.client.dot().kind === "stopped", 5000, "the dot to stop");
    expect(rig.client.dot().cause).toBe("access_removed");
    await until(() => rig.client.owed() === 0, 1000, "the owed list to be dropped");
    expect(rig.client.dot().owed).toBe(0);
    expect(rig.client.dot().showLive).toBe(false);
    const readsThen = rig.reads();
    await wait(600);
    expect(rig.reads()).toBe(readsThen);
    expect(rig.client.owed()).toBe(0);
    expect(rig.server.of("stream").length).toBe(1);
  }, 20_000);

  // Spec: Kit.Client, Honesty: a refused record leaves the store, the others still complete, nothing retries the refused one (check 7 Delivery.Completeness)
  test("CU5 a refused record: it leaves the store, the others complete, the refused one is not retried", async () => {
    const s1 = new StreamScript();
    const rig = await rigFor([s1], { maxReadAttempts: 50, owedBackoff: { baseMs: 40, capMs: 80 } });
    rig.ctl.failing = true;
    for (let i = 1; i <= 5; i++) s1.frame(frame(i));
    await until(() => rig.client.owed() === 5, 5000, "five owed records");
    const before = rig.attempts.get(ent("r3")) ?? 0;
    rig.ctl.refused.add(ent("r3"));
    rig.ctl.failing = false;
    await until(() => rig.client.store.size() === 4 && rig.client.owed() === 0, 5000, "the four readable records");
    expect(rig.client.store.get(ent("r3"))).toBeUndefined();
    expect(rig.client.store.stats().readGone).toBe(1);
    // At most one more try (the one that was refused), and then none: a retry already in flight at the flip is that try.
    const settled = rig.attempts.get(ent("r3")) ?? 0;
    expect(settled).toBeLessThanOrEqual(before + 1);
    expect(settled).toBeGreaterThanOrEqual(before);
    await wait(500);
    expect(rig.attempts.get(ent("r3"))).toBe(settled);
    expect(rig.client.owed()).toBe(0);
    expect(rig.client.store.size()).toBe(4);
  }, 20_000);

  // Spec: Kit.Client, Honesty: a newer change replaces an owed record; the newer content arrives once (check 7 Delivery.Order)
  test("CU6 a newer change: the owed entry is replaced, the old retry never runs, the store holds the newer content once", async () => {
    const s1 = new StreamScript();
    // A slow back-off (300 to 600 ms for the first retry), so the old entry's retry would fall after the newer read starts.
    const rig = await rigFor([s1], { maxReadAttempts: 50, owedBackoff: { baseMs: 600, capMs: 600 } });
    rig.ctl.failing = true;
    rig.ctl.content.set(ent("r1"), "old");
    s1.frame({ id: cur(1), data: frameData(ent("r1"), at(1)) });
    await until(() => rig.client.owed() === 1, 3000, "r1 owed");
    // The newer change arrives during the cut; its read hangs (the second read of r1), the cut goes on.
    let open!: () => void;
    rig.ctl.hold = { entity: ent("r1"), nth: 2, gate: new Promise<void>((r) => { open = r; }) };
    rig.ctl.content.set(ent("r1"), "new");
    s1.frame({ id: cur(2), data: frameData(ent("r1"), at(2)) });
    await until(() => (rig.attempts.get(ent("r1")) ?? 0) === 2, 3000, "the newer read to start");
    // The newer notification covers the owed one: nothing is owed and the old entry's retry does not run.
    expect(rig.client.owed()).toBe(0);
    await wait(900);
    expect(rig.attempts.get(ent("r1"))).toBe(2);
    rig.ctl.failing = false;
    open();
    await until(() => rig.client.store.size() === 1, 3000, "the newer record");
    expect(rig.client.store.get(ent("r1"))?.record.v).toBe("new");
    await wait(300);
    expect(rig.client.store.stats().applied).toBe(1);
    expect(rig.attempts.get(ent("r1"))).toBe(2);
    expect(rig.client.owed()).toBe(0);
  }, 20_000);

  // Spec: Kit.Client, Honesty: a cut is not hammered: the tries per record stay within the limit plus the reconnects (check 7 Delivery.Completeness)
  test("CU7 the hammer check: tries per owed record stay within the limit, then within one more set per reconnect", async () => {
    const s1 = new StreamScript();
    const s2 = new StreamScript();
    const max = 3;
    const rig = await rigFor([s1, s2], { maxReadAttempts: max, owedBackoff: { baseMs: 50, capMs: 100 } });
    rig.ctl.failing = true;
    for (let i = 1; i <= 10; i++) s1.frame(frame(i));
    await wait(1500);
    // No reconnect yet: the original read plus the limit, no more.
    for (const [entity, count] of rig.attempts) expect(count, entity).toBeLessThanOrEqual(max + 1);
    expect(rig.attempts.size).toBe(10);
    s1.cut();
    await until(() => rig.server.of("stream").length >= 2, 8000, "the reconnect");
    await wait(1000);
    const reconnects = rig.server.of("stream").length - 1;
    expect(reconnects).toBe(1);
    // Each reconnect gives every parked record a new full set of tries (retryOwed resets the count), and no more.
    for (const [entity, count] of rig.attempts) {
      expect(count, entity).toBeLessThanOrEqual((reconnects + 1) * max + 1);
      expect(count, entity).toBeGreaterThan(max + 1);
    }
    expect(rig.client.owed()).toBe(10);
  }, 30_000);

  // Spec: Kit.Client, Honesty: the saved copy never skips an owed record (LiveWire step, check 7 Delivery.Completeness)
  test("CU8 the saved copy: no save holds a cursor while records are owed; the next save after recovery has one", async () => {
    const s1 = new StreamScript();
    const saves: Array<CachedState<Rec>> = [];
    const inner = createMemoryCache<Rec>();
    const cache: LiveCache<Rec> = {
      load: () => inner.load(),
      save: (s) => { saves.push(JSON.parse(JSON.stringify(s)) as CachedState<Rec>); return inner.save(s); },
      remove: () => inner.remove?.(),
    };
    const seedRow: SeedRow<Rec> = { entity: ent("seed"), typeUri: TYPE, etag: "s", updatedAt: at(0), record: { entity: ent("seed"), v: "s" } };
    const rig = await rigFor([s1], { cache, cacheScope: "person-1:vault-1", resync: async () => [seedRow], owedBackoff: { baseMs: 50, capMs: 200 } });
    rig.ctl.failing = true;
    for (let i = 1; i <= 3; i++) s1.frame(frame(i));
    await until(() => rig.client.owed() === 3, 5000, "three owed records");
    // Past the cache's own debounce (2 s): the timed save must wait while records are owed.
    await wait(2600);
    expect(rig.client.owed()).toBe(3);
    expect(saves).toHaveLength(0);
    await rig.client.flushCache();
    expect(saves).toHaveLength(1);
    expect(saves[0]?.cursor).toBeNull();
    expect(saves[0]?.rows.map((r) => r.entity)).toEqual([ent("seed")]);
    // Recovery: the records are read, and the next save has the cursor and every row.
    rig.ctl.failing = false;
    rig.client.store.retryOwed();
    await until(() => rig.client.store.size() === 4 && rig.client.owed() === 0, 5000, "recovery");
    await rig.client.flushCache();
    const last = saves.at(-1) as CachedState<Rec>;
    expect(last.cursor).toBe(cur(3));
    expect(last.rows).toHaveLength(4);
    for (const s of saves.slice(0, 1)) expect(s.cursor).toBeNull();
  }, 30_000);
});

describe("the tick option", () => {
  async function ticksFor(over: Partial<LiveClientOptions<Rec>>): Promise<number> {
    const s = new StreamScript();
    const rig = await rigFor([s], over, false);
    const ticks: number[] = [];
    rig.client.subscribeTick((t) => ticks.push(t));
    await rig.client.start();
    await until(() => rig.server.of("stream").length >= 1, 3000, "the stream open");
    for (let i = 0; i < 15; i++) {
      s.heartbeat();
      await wait(100);
    }
    return ticks.length;
  }

  // Spec: Kit.Client, Honesty: tickMinIntervalMs limits the screen-time tick; 0 gives one per confirmation (LiveWire step, check B9)
  test("T-tick tickMinIntervalMs 0 ticks for every heartbeat; the default ticks at most once a second", async () => {
    const every = await ticksFor({ tickMinIntervalMs: 0 });
    expect(every).toBeGreaterThanOrEqual(12);
    const throttled = await ticksFor({});
    expect(throttled).toBeGreaterThanOrEqual(1);
    expect(throttled).toBeLessThanOrEqual(3);
  }, 20_000);
});
