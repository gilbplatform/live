import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLiveStore } from "../src/store.js";
import { createLiveTransport } from "../src/transport.js";
import type { LiveTransport, TransportOptions, TransportState } from "../src/transport-types.js";
import type { LiveStore } from "../src/types.js";
import { FrameServer, StreamScript, cursor, feedPage, frameData } from "./helpers/frameServer.js";
import type { SeenRequest } from "./helpers/frameServer.js";

// The transport asks the store to retry every owed read on each good moment (batch L14c). Real timers, the local frame server.

const TYPE = "https://vault.example/t/Value";
const T0 = Date.UTC(2026, 10, 19, 10, 0, 0);
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const ent = (name: string): string => `https://vault.example/e/${name}`;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean, ms = 3000, what = "the condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await wait(10);
  }
}

let server: FrameServer;
const transports: LiveTransport[] = [];

beforeEach(async () => {
  server = new FrameServer();
  await server.start();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(transports.splice(0).map((t) => t.stop()));
  await server.close();
});

interface Rig {
  store: LiveStore<unknown>;
  t: LiveTransport;
  /** Everything that happened, in order: "retry" for each call of retryOwed, plus what the test adds. */
  log: string[];
  states: TransportState[];
}

/** A transport on a real store whose `retryOwed` is replaced by a counting wrapper BEFORE the transport starts. */
function build(over: Partial<TransportOptions> & { throwing?: boolean; startNow?: boolean } = {}): Rig {
  const { throwing, startNow, ...opts } = over;
  const store = createLiveStore<unknown>({ holdMs: 0, read: async (n) => ({ record: { entity: n.entity }, etag: `e-${n.entity}` }) });
  const log: string[] = [];
  const states: TransportState[] = [];
  const real = store.retryOwed.bind(store);
  store.retryOwed = () => {
    log.push("retry");
    if (throwing) throw new Error("boom");
    real();
  };
  const t = createLiveTransport({
    store,
    origin: server.origin,
    vaultId: "vault-1",
    auth: () => ({ authorization: "Bearer tok" }),
    resync: async () => { log.push("resync"); store.seed([]); },
    pollMs: 40,
    heartbeatTimeoutMs: 5000,
    stableMs: 250,
    streamProbeMs: 300,
    failuresBeforePoll: 50,
    backoff: { baseMs: 20, capMs: 80 },
    onState: (s) => states.push(s),
    ...opts,
  });
  transports.push(t);
  if (startNow !== false) t.start();
  return { store, t, log, states };
}

const retries = (r: Rig): number => r.log.filter((x) => x === "retry").length;
const stream = (): StreamScript => new StreamScript();
const feeds = (r: SeenRequest): { status: number; json: unknown } | null => {
  if (r.kind === "head-live") return { status: 200, json: feedPage([], cursor("HL1"), true) };
  if (r.kind === "head-ended") return { status: 200, json: feedPage([], cursor("HE1"), true) };
  if (r.kind === "feed-live" || r.kind === "feed-ended") return { status: 200, json: feedPage([], r.query.get("since"), true) };
  return null;
};

describe("transport: owed reads are retried at the good moments", () => {
  // Spec: Kit.Client, Honesty: every reconnect asks the store to retry what is owed (LiveWire step, check 7 Delivery.Completeness)
  test("TO1 retryOwed is called once when the stream reaches live", async () => {
    server.handler = () => stream();
    const rig = build();
    await until(() => rig.states.some((s) => s.state === "live"), 3000, "live");
    await wait(150);
    expect(retries(rig)).toBe(1);
    expect(rig.log).toEqual(["retry"]);
  });

  // Spec: Kit.Client, Honesty: every good poll tick asks the store to retry what is owed (check 7 Delivery.Completeness)
  test("TO2 retryOwed is called after each successful poll tick", async () => {
    const rig = build({ startNow: false });
    // The feed requests go in the same log as the asks, so the order can be read.
    server.handler = (r) => {
      if (r.kind === "stream") return { status: 501, json: { error: "live_not_available_here", message: "x" } };
      if (r.kind === "feed-live") rig.log.push("L");
      if (r.kind === "feed-ended") rig.log.push("E");
      return feeds(r) as { status: number; json: unknown };
    };
    rig.t.start();
    await until(() => server.of("feed-ended").length >= 5, 5000, "five ticks");
    await rig.t.stop();
    // The resync that starts poll mode asks once; then every whole tick (live page, ended page) is followed by one ask.
    // A tick cut off by the stop at the end has no ask, so a trailing incomplete tick is left out.
    const text = rig.log.join(",").replace(/(,L(,E)?)$/, "");
    expect(text).toMatch(/^resync,retry(,L,E,retry)+$/);
    expect(text.split(",E,").length).toBeGreaterThanOrEqual(4);
  });

  // Spec: Kit.Client, Honesty: a completed resync asks the store to retry what is owed (check 7 Delivery.Completeness)
  test("TO3 retryOwed is called after a resync completes, and again when the stream goes live", async () => {
    server.handler = (r) => {
      if (r.kind === "head-live") return { status: 200, json: feedPage([], cursor("HEAD"), true) };
      rig.log.push("S");
      return server.of("stream").length === 1 ? { status: 400, json: { error: "since_cursor_invalid", message: "x" } } : stream();
    };
    const rig = build({ startNow: false });
    // The store needs a position, so that the first stream open carries one the server can refuse.
    rig.store.push({ kind: "change", entity: ent("old"), typeUri: TYPE, etag: null, updatedAt: at(1), receivedAt: at(0), cursor: cursor("C0") });
    rig.t.start();
    await until(() => rig.log.length >= 5, 3000, "the log");
    await wait(150);
    // The refused open is not a good moment; the resync is; the second open goes live.
    expect(rig.log).toEqual(["S", "resync", "retry", "S", "retry"]);
  });

  // Spec: Kit.Client, Honesty: nothing is retried through a failed connection or a stopped transport (check 7 Delivery.Completeness)
  test("TO4 not on a failed connection, not after stop()", async () => {
    server.handler = () => ({ status: 500, json: { error: "x" } });
    const failing = build();
    await until(() => server.of("stream").length >= 3, 3000, "three failed opens");
    expect(retries(failing)).toBe(0);
    await failing.t.stop();
    await wait(100);
    expect(retries(failing)).toBe(0);

    // A stop while the open is still being answered: the late answer must not ask anything.
    server.handler = async () => { await wait(150); return stream(); };
    const opens = server.of("stream").length;
    const slow = build();
    await until(() => server.of("stream").length > opens, 3000, "the open");
    await wait(30);
    await slow.t.stop();
    await wait(300);
    expect(retries(slow)).toBe(0);

    // A live stream, then a stop: the count stays at the one ask from going live.
    server.handler = () => stream();
    const live = build();
    await until(() => retries(live) === 1, 3000, "the ask");
    await live.t.stop();
    await wait(150);
    expect(retries(live)).toBe(1);
  });

  // Spec: Kit.Client, Honesty: a store that throws cannot break the connection (check 7 Delivery.Completeness)
  test("TO5 a throwing retryOwed does not break the transport", async () => {
    server.handler = () => stream().frame({ id: cursor("A1"), data: frameData(ent("a"), at(1)) });
    const rig = build({ throwing: true });
    await until(() => retries(rig) >= 1, 3000, "the ask");
    await until(() => rig.store.size() === 1, 3000, "the record");
    expect(rig.states.at(-1)?.state).toBe("live");
    expect(rig.t.state().state).toBe("live");
  });
});
