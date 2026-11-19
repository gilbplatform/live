import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createLiveStore } from "../src/store.js";
import { createLiveTransport } from "../src/transport.js";
import type { LiveTransport, TransportOptions, TransportState } from "../src/transport-types.js";
import type { LiveNotification, LiveStore } from "../src/types.js";
import { FrameServer, StreamScript, cursor, feedPage, frameData } from "./helpers/frameServer.js";
import type { SeenRequest } from "./helpers/frameServer.js";

// Real timers with small values: the transport is a thing of sockets and clocks, and a fake clock would prove little.

const SECRET = "SECRET-TOKEN-123";
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

type Resync = (reason: "bad_cursor" | "poll_start") => Promise<void>;

interface Rig {
  server: FrameServer;
  store: LiveStore<unknown>;
  t: LiveTransport;
  states: TransportState[];
  authCalls: Array<{ url: string; refresh: boolean }>;
  resyncs: Array<{ reason: string; at: number; requestsSeen: number }>;
  confirms: number[];
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

/** Builds a transport on a real store. Small timings by default; `failuresBeforePoll` is high so only the tests that want polling get it. */
function build(over: Partial<TransportOptions> & { resyncImpl?: Resync; tokens?: boolean; startNow?: boolean } = {}): Rig {
  const { resyncImpl, tokens, startNow, ...opts } = over;
  let k = 0;
  const store = createLiveStore<unknown>({
    holdMs: 0,
    read: async (n) => ({ record: { entity: n.entity }, etag: `e${++k}` }),
  });
  const states: TransportState[] = [];
  const authCalls: Rig["authCalls"] = [];
  const resyncs: Rig["resyncs"] = [];
  const confirms: number[] = [];
  let version = 1;
  const rig = { server, store, states, authCalls, resyncs, confirms } as Rig;
  const t = createLiveTransport({
    store,
    origin: server.origin,
    vaultId: "vault-1",
    auth: (req, ctx) => {
      authCalls.push({ url: req.url, refresh: ctx.refresh });
      if (ctx.refresh) version++;
      return { authorization: tokens ? `Bearer tok-${version}` : `Bearer ${SECRET}` };
    },
    resync: async (reason) => {
      resyncs.push({ reason, at: Date.now(), requestsSeen: server.requests.length });
      if (resyncImpl) await resyncImpl(reason);
      else store.seed([]);
    },
    pollMs: 40,
    heartbeatTimeoutMs: 150,
    stableMs: 250,
    streamProbeMs: 300,
    failuresBeforePoll: 50,
    backoff: { baseMs: 20, capMs: 80 },
    onState: (s) => states.push(s),
    onConfirm: (ms) => confirms.push(ms),
    ...opts,
  });
  transports.push(t);
  rig.t = t;
  if (startNow !== false) t.start();
  return rig;
}

/**
 * After stop() has resolved the transport must make no request. Its own counters are exact; the server's count is read
 * after a short drain, because a request sent just before the stop may still be on its way to the server's loop.
 */
async function quietAfterStop(r: Rig): Promise<void> {
  const before = r.t.stats();
  await wait(50);
  const seen = server.requests.length;
  await wait(3 * 40);
  const after = r.t.stats();
  expect(after.streamRequests).toBe(before.streamRequests);
  expect(after.feedRequests).toBe(before.feedRequests);
  expect(server.requests.length).toBe(seen);
}

const names = (r: Rig): string[] => r.states.map((s) => s.state);
const has = (r: Rig, state: string, cause?: string): boolean =>
  r.states.some((s) => s.state === state && (cause === undefined || ("cause" in s && s.cause === cause) || ("reason" in s && s.reason === cause)));
const lastState = (r: Rig): TransportState => r.states[r.states.length - 1] as TransportState;
const stream = (): StreamScript => new StreamScript();
const change = (name: string, ms: number, id: string): { id: string; data: unknown } => ({ id, data: frameData(ent(name), at(ms)) });

/** A server for poll mode: heads and empty pages, with the heads named so a test can tell them apart. */
function feeds(over: { live?: (r: SeenRequest) => unknown; ended?: (r: SeenRequest) => unknown } = {}): (r: SeenRequest) => { status: number; json: unknown } | null {
  return (r) => {
    if (r.kind === "head-live") return { status: 200, json: feedPage([], cursor("HL1"), true) };
    if (r.kind === "head-ended") return { status: 200, json: feedPage([], cursor("HE1"), true) };
    if (r.kind === "feed-live") return { status: 200, json: over.live ? over.live(r) : feedPage([], r.query.get("since"), true) };
    if (r.kind === "feed-ended") return { status: 200, json: over.ended ? over.ended(r) : feedPage([], r.query.get("since"), true) };
    return null;
  };
}

/** A handler that sends every stream request to 501 "not available here" and every feed request to `feed`. */
const pollOnly = (feed = feeds()) => (r: SeenRequest) =>
  r.kind === "stream" ? { status: 501, json: { error: "live_not_available_here", message: "x" } } : (feed(r) as { status: number; json: unknown });

describe("transport: the stream", () => {
  // Spec: Kit.Client, Transport: a bare open asks for no position, sends credentials only in headers, and asks the provider for every request (LiveWire step, check 4 Latency.LiveChange)
  test("T1 happy path", async () => {
    const first = stream();
    const second = stream();
    server.handler = (r) => {
      if (r.n === 0) return first.frame(change("a", 1, cursor("A1"))).frame(change("b", 2, cursor("A2"))).cut();
      return second;
    };
    const rig = build({ tokens: false });
    await until(() => rig.store.size() === 2, 3000, "two records");
    const req = server.requests[0] as SeenRequest;
    expect(req.kind).toBe("stream");
    expect(req.query.has("since")).toBe(false);
    expect(req.headers["last-event-id"]).toBeUndefined();
    expect(req.headers.accept).toBe("text/event-stream");
    expect(req.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(req.headers.cookie).toBeUndefined();
    expect(req.url).not.toMatch(/token|authorization|dpop|bearer/i);
    expect(rig.authCalls[0]).toEqual({ url: `${server.origin}${req.url}`, refresh: false });
    expect(names(rig).slice(0, 2)).toEqual(["connecting", "live"]);
    // After the cut there is a reconnect; the provider was asked once per request seen by the server.
    await until(() => server.requests.length >= 2, 3000, "the reconnect");
    await wait(30);
    expect(rig.authCalls.length).toBe(server.requests.length);
    expect(server.requests.every((x) => x.headers["last-event-id"] === undefined)).toBe(true);
  });

  // Spec: Kit.Client, Transport: the types filter goes in the query in the given order (LiveWire step)
  test("T2 types", async () => {
    server.handler = () => stream();
    build({ types: ["Value", "Scale"] });
    await until(() => server.requests.length === 1);
    expect((server.requests[0] as SeenRequest).url).toMatch(/\/live\?type=Value&type=Scale$/);
  });

  // Spec: Kit.Client, Transport: a cut in the middle of a frame never applies the half frame and resumes from the last whole one (check 4 Latency.LiveChange)
  test("T3 a cut in the middle of a frame", async () => {
    const s0 = stream();
    const s1 = stream();
    let sizeAtSecond = -1;
    server.handler = (r) => {
      if (r.n === 0) return s0.frame(change("a", 1, cursor("F1"))).frame(change("b", 2, cursor("F2"))).raw(`id: ${cursor("F3")}\nevent: change\ndata: ${JSON.stringify(frameData(ent("c"), at(3)))}\n`).cut();
      sizeAtSecond = rigRef.store.size();
      return s1.frame(change("c", 3, cursor("F3")));
    };
    const rigRef = build();
    await until(() => rigRef.store.size() === 3, 3000, "three records");
    expect(sizeAtSecond).toBe(2);
    expect((server.requests[1] as SeenRequest).query.get("since")).toBe(cursor("F2"));
    expect(server.requests.every((x) => x.headers["last-event-id"] === undefined)).toBe(true);
    expect(rigRef.t.stats().framesPushed).toBe(3);
    expect(rigRef.store.stats().pushed).toBe(3);
  });

  // Spec: Kit.Client, Transport: reconnect delays double with a cap, and the delay is reported (check 4 Latency.LiveChange)
  test("T4 back-off grows and is capped", async () => {
    const seen: number[] = [];
    server.handler = (r) => {
      seen.push(performance.now());
      return r.n < 5 ? stream().cut() : stream();
    };
    const rig = build({ random: () => 1 });
    await until(() => server.requests.length >= 6, 4000, "six requests");
    const delays = rig.states.filter((s) => s.state === "reconnecting").map((s) => (s as { retryInMs: number }).retryInMs);
    expect(delays.slice(0, 5)).toEqual([20, 40, 80, 80, 80]);
    const gaps = seen.slice(1).map((x, i) => x - (seen[i] as number));
    // A timer may fire a hair before the clock says (about 1 ms); the delays above are the exact values.
    [20, 40, 80, 80].forEach((d, i) => {
      expect(gaps[i] as number).toBeGreaterThanOrEqual(d - 2);
      expect(gaps[i] as number).toBeLessThan(d + 80);
    });
  });

  // Spec: Kit.Client, Transport: the random half of the delay is really used (check 4 Latency.LiveChange)
  test("T4b with no random part the first delay is half", async () => {
    server.handler = (r) => (r.n < 1 ? stream().cut() : stream());
    const rig = build({ random: () => 0 });
    await until(() => server.requests.length >= 2);
    const d = rig.states.find((s) => s.state === "reconnecting") as { retryInMs: number };
    expect(d.retryInMs).toBe(10);
  });

  // Spec: Kit.Client, Transport: a stable session resets the back-off (check 4 Latency.LiveChange)
  test("T5 reset after a stable session", async () => {
    server.handler = (r) => {
      if (r.n < 3) return stream().cut();
      if (r.n === 3) {
        // Heartbeats keep the watchdog quiet; the stream lives past stableMs and then ends.
        const s = stream();
        const hb = setInterval(() => s.heartbeat(), 50);
        setTimeout(() => {
          clearInterval(hb);
          s.end();
        }, 320);
        return s;
      }
      return stream();
    };
    const rig = build({ random: () => 1 });
    await until(() => server.requests.length >= 5, 4000, "five requests");
    const delays = rig.states.filter((s) => s.state === "reconnecting").map((s) => (s as { retryInMs: number }).retryInMs);
    expect(delays.slice(0, 4)).toEqual([20, 40, 80, 20]);
  });

  // Spec: Kit.Client, Transport: a stream that goes silent is cut and asked again; heartbeats keep it (check 4 Latency.LiveChange)
  test("T6 watchdog", async () => {
    const quiet = stream().silent();
    server.handler = (r) => (r.n === 0 ? quiet : stream());
    const start = Date.now();
    build();
    await until(() => server.requests.length >= 2, 3000, "a second request");
    expect(Date.now() - start).toBeLessThan(150 + 150 + 100);
    expect(Date.now() - start).toBeGreaterThanOrEqual(140);
    expect((server.requests[0] as SeenRequest).closedAt).not.toBeNull();
  });

  // Spec: Kit.Client, Transport: heartbeat comments keep a stream open (check 4 Latency.LiveChange)
  test("T6b heartbeats keep the stream", async () => {
    const s = stream();
    server.handler = () => s;
    build();
    await until(() => server.requests.length === 1);
    const timer = setInterval(() => s.heartbeat(), 50);
    await wait(550);
    clearInterval(timer);
    expect(server.requests.length).toBe(1);
  });

  // Spec: Kit.Client, Transport: one refresh after a 401, then the same request again (check Security.NoSilentUnauthorised)
  test("T7 401 refresh once", async () => {
    server.handler = (r) => (r.n === 0 ? { status: 401, json: { error: "unauthorized" } } : stream().frame(change("a", 1, cursor("A1"))));
    const rig = build({ tokens: true });
    await until(() => rig.store.size() === 1);
    expect(rig.authCalls.map((c) => c.refresh)).toEqual([false, true]);
    expect((server.requests[0] as SeenRequest).headers.authorization).toBe("Bearer tok-1");
    expect((server.requests[1] as SeenRequest).headers.authorization).toBe("Bearer tok-2");
    expect(rig.t.stats().authRefreshes).toBe(1);
  });

  // Spec: Kit.Client, Transport: a second 401 in a row is final (check Security.NoSilentUnauthorised)
  test("T7b a second 401 is terminal", async () => {
    server.handler = () => ({ status: 401, json: { error: "unauthorized" } });
    const rig = build({ tokens: true });
    await until(() => lastState(rig).state === "stopped");
    expect(lastState(rig)).toEqual({ state: "stopped", cause: "unauthorized" });
    const seen = server.requests.length;
    await wait(300);
    expect(server.requests.length).toBe(seen);
    expect(rig.authCalls.length).toBe(2);
  });

  // Spec: Kit.Client, Transport: a 403 on the stream is a final refusal and is never retried (check Security.NoSilentUnauthorised). A 404 is tried once against the poll feed: see T40 to T49.
  test.each([403])("T8 refused %i", async (status) => {
    server.handler = () => ({ status, json: { error: "not_found" } });
    const rig = build();
    await until(() => lastState(rig).state === "stopped");
    expect(lastState(rig)).toEqual({ state: "stopped", cause: "refused" });
    await wait(200);
    expect(server.requests.length).toBe(1);
  });

  // Spec: Kit.Client, Transport: a revoke ends the transport and tells the app (check Security.RevokeStops)
  test("T9 revoke", async () => {
    server.handler = () => stream().frame(change("a", 1, cursor("A1"))).closedFrame("revoked").end();
    const rig = build();
    await until(() => lastState(rig).state === "stopped");
    expect(lastState(rig)).toEqual({ state: "stopped", cause: "revoked" });
    expect(rig.store.size()).toBe(1);
    await wait(500);
    expect(server.requests.length).toBe(1);
  });

  // Spec: Kit.Client, Transport: the routine renewal is quiet and cheap (check 4 Latency.LiveChange)
  test("T10 max_age is quiet", async () => {
    server.handler = (r) => (r.n < 3 ? stream().frame(change("a", r.n + 1, cursor(`M${r.n}`))).closedFrame("max_age").end() : stream());
    const rig = build({ failuresBeforePoll: 2 });
    await until(() => server.requests.length >= 4, 3000, "four requests");
    for (let i = 1; i <= 3; i++) {
      const q = (server.requests[i] as SeenRequest).query.get("since");
      expect(q).toBe(cursor(`M${i - 1}`));
      expect((server.requests[i] as SeenRequest).at - (server.requests[i - 1] as SeenRequest).at).toBeLessThan(400);
    }
    const re = rig.states.filter((s) => s.state === "reconnecting") as Array<{ quiet: boolean; retryInMs: number }>;
    expect(re.length).toBe(3);
    expect(re.every((s) => s.quiet && s.retryInMs < 300)).toBe(true);
    expect(has(rig, "polling")).toBe(false);
  });
});

describe("transport: capacity, polling and the hand-over", () => {
  // Spec: Kit.Client, Transport: a 429 means poll, and the stream waits for the server's retry-after (check 4 Latency.LiveChange)
  test("T11 capacity", async () => {
    const f = feeds();
    let t429 = 0;
    server.handler = (r) => {
      if (r.kind !== "stream") return f(r) as { status: number; json: unknown };
      if (server.of("stream").length === 1) {
        t429 = Date.now();
        return { status: 429, headers: { "retry-after": "1" }, json: { error: "live_capacity", scope: "identity", message: "x" } };
      }
      return stream();
    };
    const rig = build();
    await until(() => has(rig, "polling", "capacity"), 3000, "polling");
    expect(rig.resyncs.length).toBe(1);
    expect(rig.t.mode()).toBe("poll");
    await until(() => server.of("stream").length === 2, 3000, "the second stream request");
    expect((server.of("stream")[1] as SeenRequest).at - t429).toBeGreaterThanOrEqual(1000);
    await until(() => rig.t.mode() === "stream");
    expect(server.violations).toEqual([]);
  });

  // Spec: Kit.Client, Transport: an anonymous-scope 429 is handled like any other 429 (check 4 Latency.LiveChange)
  test("T11b anonymous 429 behaves like any 429", async () => {
    const f = feeds();
    let t429 = 0;
    server.handler = (r) => {
      if (r.kind !== "stream") return f(r) as { status: number; json: unknown };
      if (server.of("stream").length === 1) {
        t429 = Date.now();
        return { status: 429, headers: { "retry-after": "1" }, json: { error: "live_capacity", scope: "anonymous", message: "x" } };
      }
      return stream();
    };
    const rig = build();
    await until(() => has(rig, "polling", "capacity"));
    await until(() => server.of("stream").length === 2, 3000, "the second stream request");
    expect((server.of("stream")[1] as SeenRequest).at - t429).toBeGreaterThanOrEqual(1000);
  });

  // Spec: Kit.Client, Transport: "not available here" means poll for good (check 4 Latency.LiveChange)
  test("T12 not available here", async () => {
    server.handler = pollOnly();
    const rig = build();
    await until(() => has(rig, "polling", "no_stream"));
    await wait(600);
    expect(server.of("stream").length).toBe(1);
    expect(has(rig, "reconnecting")).toBe(false);
    expect(lastState(rig).state).toBe("polling");
    expect(rig.t.mode()).toBe("poll");
    expect(server.of("feed-live").length).toBeGreaterThan(3);
  });

  // Spec: Kit.Client, Transport: the poll reads the live feed and the ended feed with their own cursors (check 4 Latency.LiveChange)
  test("T13 poll content", async () => {
    const f = feeds({
      live: (r) => (r.query.get("since") === cursor("HL1") ? feedPage([{ entity: ent("a"), updatedAt: at(1) }, { entity: ent("b"), updatedAt: at(2) }], cursor("P1"), true) : feedPage([], cursor("P1"), true)),
      ended: (r) => (r.query.get("since") === cursor("HE1") ? feedPage([{ entity: ent("gone"), updatedAt: at(3) }], cursor("EN2"), true) : feedPage([], r.query.get("since"), true)),
    });
    server.handler = pollOnly(f);
    const rig = build({
      resyncImpl: async () => rig.store.seed([{ entity: ent("gone"), typeUri: TYPE, etag: "x", record: { entity: ent("gone") } }]),
    });
    await until(() => rig.store.size() === 2 && rig.store.get(ent("gone")) === undefined, 3000, "the two records and the removal");
    await until(() => server.of("feed-live").some((r) => r.query.get("since") === cursor("P1")));
    await until(() => server.of("feed-ended").some((r) => r.query.get("since") === cursor("EN2")));
    for (const r of server.of("feed-ended")) expect(r.query.get("since")).not.toBe(cursor("P1"));
    for (const r of server.of("feed-live")) expect(r.query.get("since")).not.toBe(cursor("EN2"));
    // The store learns only the live cursor; the ended feed's cursor never reaches it.
    expect(rig.store.lastCursor()).toBe(cursor("P1"));
    expect(server.violations).toEqual([]);
    expect(server.maxConcurrent).toBe(1);
  });

  // Spec: Kit.Client, Transport: a page that is not complete is followed at once, inside the same tick (check 4 Latency.LiveChange)
  test("T13b pagination", async () => {
    const f = feeds({
      live: (r) => {
        const since = r.query.get("since");
        if (since === cursor("HL1")) return feedPage([{ entity: ent("a"), updatedAt: at(1) }], cursor("Q1"), false);
        if (since === cursor("Q1")) return feedPage([{ entity: ent("b"), updatedAt: at(2) }], cursor("Q2"), true);
        return feedPage([], since, true);
      },
    });
    server.handler = pollOnly(f);
    const rig = build();
    await until(() => rig.store.size() === 2);
    const order = server.requests.map((r) => `${r.kind}:${r.query.get("since")}`);
    const i = order.indexOf(`feed-live:${cursor("HL1")}`);
    expect(order[i + 1]).toBe(`feed-live:${cursor("Q1")}`);
    expect(order[i + 2]).toBe(`feed-ended:${cursor("HE1")}`);
    await until(() => server.of("feed-live").some((r) => r.query.get("since") === cursor("Q2")));
    expect(server.maxConcurrent).toBe(1);
  });

  // Spec: Kit.Client, Transport: a poll that fails halfway reads the same changes again (check 4 Latency.LiveChange)
  test("T13c a failed tick does not move the cursors", async () => {
    let failed = false;
    const f = feeds({
      live: (r) => {
        const since = r.query.get("since");
        if (since === cursor("HL1")) return feedPage([{ entity: ent("a"), updatedAt: at(1) }], cursor("Q1"), false);
        if (since === cursor("Q1")) return failed ? feedPage([{ entity: ent("b"), updatedAt: at(2) }], cursor("Q2"), true) : "fail";
        return feedPage([], since, true);
      },
    });
    server.handler = pollOnly((r) => {
      const a = f(r) as { status: number; json: unknown };
      if (a.json === "fail") {
        failed = true;
        return { status: 500, json: { error: "x" } };
      }
      return a;
    });
    const rig = build();
    await until(() => rig.store.size() === 2, 3000, "both records");
    const sinces = server.of("feed-live").map((r) => r.query.get("since"));
    // The head cursor is asked again after the failure, not Q1 straight away.
    expect(sinces.slice(0, 4)).toEqual([cursor("HL1"), cursor("Q1"), cursor("HL1"), cursor("Q1")]);
  });

  // Spec: Kit.Client, Transport: poll ticks never overlap, even when the server is slower than the poll interval (check 4 Latency.LiveChange)
  test("T13d slow feed, no overlapping ticks", async () => {
    const f = feeds();
    server.handler = async (r) => {
      if (r.kind === "stream") return { status: 501, json: { error: "live_not_available_here", message: "x" } };
      if (r.kind === "feed-live" || r.kind === "feed-ended") await wait(120);
      return f(r) as { status: number; json: unknown };
    };
    build();
    await until(() => server.of("feed-ended").length >= 3, 4000, "three ticks");
    expect(server.maxConcurrent).toBe(1);
    expect(server.violations).toEqual([]);
  });

  // Spec: Kit.Client, Transport: entering poll mode takes the head cursors first, then the app's read, then polls from the heads (check 4 Latency.LiveChange)
  test("T14 poll start order", async () => {
    let served = false;
    const f = feeds({
      live: (r) => {
        if (r.query.get("since") === cursor("HL1") && !served) {
          served = true;
          return feedPage([{ entity: ent("x"), updatedAt: at(1) }], cursor("P1"), true);
        }
        return feedPage([], r.query.get("since"), true);
      },
    });
    server.handler = pollOnly(f);
    const rig = build();
    await until(() => rig.store.size() === 1);
    expect(server.requests.slice(0, 4).map((r) => r.kind)).toEqual(["stream", "head-live", "head-ended", "feed-live"]);
    expect(rig.resyncs.length).toBe(1);
    expect(rig.resyncs[0]?.reason).toBe("poll_start");
    expect(rig.resyncs[0]?.requestsSeen).toBe(3);
    expect(server.requests[3]?.query.get("since")).toBe(cursor("HL1"));
    expect(rig.store.stats().applied).toBe(1);
    expect(rig.store.stats().reads).toBe(1);
  });

  // Spec: Kit.Client, Transport: the stream and the poll never feed the store together (the central rule; check 4 Latency.LiveChange)
  test("T15 never two sources", async () => {
    const f = feeds();
    const scripts: StreamScript[] = [];
    server.handler = (r) => {
      if (r.kind !== "stream") return f(r) as { status: number; json: unknown };
      const k = server.of("stream").length - 1;
      if (k === 0) {
        // The server says "closed" but keeps the connection open: only the client's abort can end it.
        const s = stream().frame(change("a", 1, cursor("S1"))).closedFrame("recheck_failed");
        scripts.push(s);
        return s;
      }
      if (k === 1) return { status: 429, headers: { "retry-after": "1" }, json: { error: "live_capacity", scope: "identity", message: "x" } };
      if (k === 2) return stream().frame(change("b", 2, cursor("S2"))).cut();
      // The server says "closed" but keeps this one open too, so only the client's abort can end it before the poll starts.
      if (k === 3) {
        const s = stream().closedFrame("recheck_failed");
        scripts.push(s);
        return s;
      }
      return stream().frame(change("c", 3, cursor("S3")));
    };
    const rig = build({ failuresBeforePoll: 2 });
    await until(() => server.of("stream").length >= 5 && rig.t.mode() === "stream", 6000, "five stream requests");
    expect(server.violations).toEqual([]);
    expect(server.maxConcurrent).toBe(1);
    expect(scripts.length).toBe(2);
    expect(scripts.every((x) => x.closed)).toBe(true);
    // At every switch, the one source has fully closed before the other opens.
    const all = server.requests;
    let switches = 0;
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1] as SeenRequest;
      const next = all[i] as SeenRequest;
      if ((prev.kind === "stream") !== (next.kind === "stream")) {
        switches++;
        expect(prev.closedAt, `request ${prev.n} closed`).not.toBeNull();
        expect(prev.closedAt as number).toBeLessThan(next.openedAt);
      }
    }
    expect(switches).toBe(4);
  });

  // Spec: Kit.Client, Transport: events in flight at a switch: whole frames stay, the half frame is dropped, the feed supplies the rest (check 4 Latency.LiveChange)
  test("T16 events in flight at the switch", async () => {
    const f = feeds({ live: (r) => (r.query.get("since") === cursor("HL1") ? feedPage([{ entity: ent("c"), updatedAt: at(3) }], cursor("P1"), true) : feedPage([], r.query.get("since"), true)) });
    server.handler = (r) => {
      if (r.kind !== "stream") return f(r) as { status: number; json: unknown };
      if (server.of("stream").length === 1) {
        return stream().frame(change("a", 1, cursor("F1"))).frame(change("b", 2, cursor("F2"))).raw(`id: ${cursor("F3")}\nevent: change\ndata: ${JSON.stringify(frameData(ent("c"), at(3)))}\n`).cut();
      }
      return { status: 503, json: { error: "x" } };
    };
    const rig = build({
      failuresBeforePoll: 3,
      resyncImpl: async () => rig.store.seed(rig.store.all().map((row) => ({ entity: row.entity, typeUri: row.typeUri, etag: row.etag, record: row.record }))),
    });
    await until(() => rig.store.size() === 3, 4000, "three records");
    await wait(150);
    expect(rig.store.size()).toBe(3);
    const st = rig.store.stats();
    expect(st.applied).toBe(3);
    expect(st.reads).toBe(3);
    expect(st.duplicate).toBe(0);
    expect(has(rig, "polling", "failures")).toBe(true);
  });
});

describe("transport: bad cursor, other refusals, secrets, stop", () => {
  const C = cursor("OLD");
  const old = (): LiveNotification => ({ kind: "change", entity: ent("seed"), typeUri: TYPE, etag: null, updatedAt: at(0), receivedAt: at(0), cursor: C });

  // Spec: Kit.Client, Transport: a refused position is replaced once from the head, never looped (check 4 Latency.LiveChange)
  test("T17 bad cursor, no loop", async () => {
    server.handler = (r) => {
      if (r.kind === "head-live") return { status: 200, json: feedPage([], cursor("HEAD"), true) };
      const k = server.of("stream").length;
      if (k === 1) return { status: 400, json: { error: "since_cursor_invalid", message: "x" } };
      if (k === 2) return stream().frame(change("a", 1, cursor("N1"))).cut();
      return stream();
    };
    const rig = build({ startNow: false });
    rig.store.push(old());
    rig.t.start();
    await until(() => server.of("stream").length >= 3, 3000, "three stream requests");
    expect((server.of("stream")[0] as SeenRequest).query.get("since")).toBe(C);
    expect(has(rig, "resyncing", "bad_cursor")).toBe(true);
    expect(server.of("head-live").length).toBe(1);
    expect(rig.resyncs.map((x) => x.reason)).toEqual(["bad_cursor"]);
    expect((server.of("stream")[1] as SeenRequest).query.get("since")).toBe(cursor("HEAD"));
    // The override was cleared by the frame with a cursor, so the next open uses the store's cursor.
    expect((server.of("stream")[2] as SeenRequest).query.get("since")).toBe(cursor("N1"));
  });

  // Spec: Kit.Client, Transport: two refusals of the position stop the transport after one reseed (check 4 Latency.LiveChange)
  test("T17b both refused", async () => {
    server.handler = (r) => (r.kind === "head-live" ? { status: 200, json: feedPage([], cursor("HEAD"), true) } : { status: 400, json: { error: "since_cursor_invalid", message: "x" } });
    const rig = build({ startNow: false });
    rig.store.push(old());
    rig.t.start();
    await until(() => lastState(rig).state === "stopped");
    expect(lastState(rig)).toEqual({ state: "stopped", cause: "bad_request" });
    await wait(300);
    expect(server.of("stream").length).toBe(2);
    expect(server.of("head-live").length).toBe(1);
    expect(rig.resyncs.length).toBe(1);
    expect(server.requests.length).toBe(3);
  });

  // Spec: Kit.Client, Transport: any other 400 is final (check 4 Latency.LiveChange)
  test("T18 other 400", async () => {
    server.handler = () => ({ status: 400, json: { error: "something_else" } });
    const rig = build();
    await until(() => lastState(rig).state === "stopped");
    expect(lastState(rig)).toEqual({ state: "stopped", cause: "bad_request" });
    await wait(200);
    expect(server.requests.length).toBe(1);
  });

  // Spec: Kit.Client, Transport: a token appears only in the authorization header (check Security.NoTokenLeak)
  test("T19 no token anywhere", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const f = feeds();
    const rigs: Rig[] = [];
    const reported: unknown[] = [];
    // 1 happy path
    server.handler = () => stream().frame(change("a", 1, cursor("A1"))).closedFrame("revoked").end();
    rigs.push(build());
    await until(() => lastState(rigs[0] as Rig).state === "stopped");
    // 2 a 401 refresh
    let n401 = 0;
    server.handler = (r) => (n401++ === 0 ? { status: 401, json: { error: "u" } } : stream().frame(change("b", 1, cursor("B1"))));
    rigs.push(build());
    await until(() => (rigs[1] as Rig).store.size() === 1);
    // 3 a 429
    server.handler = (r) => (r.kind === "stream" ? { status: 429, headers: { "retry-after": "1" }, json: { error: "live_capacity", scope: "identity", message: "x" } } : (f(r) as { status: number; json: unknown }));
    rigs.push(build());
    await until(() => has(rigs[2] as Rig, "polling"));
    // 4 a revoke is case 1; 5 a provider that throws with the token in its message
    server.handler = () => stream();
    const r5 = build({
      startNow: false,
      auth: () => {
        throw new Error(`boom ${SECRET}`);
      },
    });
    r5.t.start();
    rigs.push(r5);
    await until(() => has(r5, "reconnecting", undefined) && r5.t.stats().reconnects >= 1);
    await Promise.all(rigs.map((r) => r.t.stop()));
    for (const r of rigs) reported.push(r.states, r.t.stats(), r.t.state());
    const calls = spies.flatMap((s) => s.mock.calls);
    expect(JSON.stringify(calls)).not.toContain(SECRET);
    expect(JSON.stringify(reported)).not.toContain(SECRET);
    expect(JSON.stringify(server.requests.map((r) => r.url))).not.toContain(SECRET);
    expect(JSON.stringify(server.requests.map((r) => r.url))).not.toMatch(/token|access_token|authorization|dpop/i);
    expect(server.requests.some((r) => r.headers.authorization === `Bearer ${SECRET}`)).toBe(true);
    expect(JSON.stringify(r5.states)).toContain("auth_provider_failed");
  });

  // Spec: Kit.Client, Transport: stop closes the stream, ends every timer and is safe to call twice (check Package.Independent)
  test("T20 stop during the stream", async () => {
    const s = stream();
    server.handler = () => s;
    const rig = build();
    await until(() => rig.t.mode() === "stream");
    // The stream is silent, so without an abort from stop() it would stay open until the watchdog (150 ms) cut it.
    const began = Date.now();
    await rig.t.stop();
    expect(Date.now() - began).toBeLessThan(100);
    const first = server.requests[0] as SeenRequest;
    // The server notices the closed socket a moment after the client has let go of it.
    await until(() => first.closedAt !== null, 500, "the server to see the socket close");
    await rig.t.stop();
    rig.t.start();
    await quietAfterStop(rig);
    expect(lastState(rig)).toEqual({ state: "stopped", cause: "stopped_by_app" });
    expect(rig.t.mode()).toBeNull();
  });

  // Spec: Kit.Client, Transport: stop during poll mode (check Package.Independent)
  test("T20b stop during poll mode", async () => {
    server.handler = pollOnly();
    const rig = build();
    await until(() => server.of("feed-live").length >= 2);
    await rig.t.stop();
    await quietAfterStop(rig);
    expect(lastState(rig)).toEqual({ state: "stopped", cause: "stopped_by_app" });
  });

  // Spec: Kit.Client, Transport: stop during a back-off wait does not wait for the delay (check Package.Independent)
  test("T20c stop during a back-off wait", async () => {
    server.handler = () => stream().cut();
    const rig = build({ backoff: { baseMs: 5000, capMs: 5000 }, random: () => 1 });
    await until(() => has(rig, "reconnecting"));
    const started = Date.now();
    await rig.t.stop();
    expect(Date.now() - started).toBeLessThan(500);
    await wait(150);
    expect(server.requests.length).toBe(1);
  });

  // Spec: Kit.Client, Transport: a frame over the size limit drops the connection (check Package.Independent)
  test("T21 too large", async () => {
    server.handler = (r) => (r.n === 0 ? stream().raw(`id: ${cursor("BIG")}\nevent: change\ndata: ${"x".repeat(1_100_000)}\n\n`) : stream());
    const rig = build();
    await until(() => server.requests.length >= 2, 4000, "a reconnect");
    expect(rig.store.size()).toBe(0);
    expect(rig.states.some((s) => s.state === "reconnecting" && s.cause === "event_too_large")).toBe(true);
  });

  // Spec: Kit.Client, Transport: bad JSON, a bad shape and an unknown event are ignored and never cut the stream (check 4 Latency.LiveChange)
  test("T22 ignored things", async () => {
    server.handler = () =>
      stream()
        .frame({ id: cursor("I1"), data: "{not json" })
        .frame({ id: cursor("I2"), event: "mystery", data: { a: 1 } })
        .frame({ id: cursor("I3"), data: { kind: "change" } })
        .frame(change("good", 1, cursor("I4")));
    const rig = build();
    await until(() => rig.store.size() === 1);
    expect(rig.t.stats().framesIgnored).toBe(3);
    expect(rig.t.stats().framesPushed).toBe(1);
    expect(server.requests.length).toBe(1);
  });

  // Spec: Kit.Client, Transport: a page that is not an event stream is never parsed (check 4 Latency.LiveChange)
  test("T23 wrong content type", async () => {
    server.handler = (r) =>
      r.n === 0
        ? { status: 200, headers: { "content-type": "text/html" }, body: `id: ${cursor("H1")}\nevent: change\ndata: ${JSON.stringify(frameData(ent("a"), at(1)))}\n\n` }
        : stream();
    const rig = build();
    await until(() => server.requests.length >= 2);
    expect(rig.store.size()).toBe(0);
    expect(rig.states.some((s) => s.state === "reconnecting" && s.cause === "bad_content_type")).toBe(true);
  });

  // Spec: Kit.Client, Transport: a resync that fails waits a back-off delay and tries again, then gives up (check 4 Latency.LiveChange)
  test("T24 resync failure", async () => {
    server.handler = pollOnly();
    let tries = 0;
    const rig = build({
      random: () => 0,
      resyncImpl: async () => {
        if (++tries <= 2) throw new Error("app read failed");
        rig.store.seed([]);
      },
    });
    await until(() => has(rig, "polling"), 3000, "polling");
    expect(rig.resyncs.length).toBe(3);
    const gap1 = (rig.resyncs[1] as { at: number }).at - (rig.resyncs[0] as { at: number }).at;
    const gap2 = (rig.resyncs[2] as { at: number }).at - (rig.resyncs[1] as { at: number }).at;
    expect(gap1).toBeGreaterThanOrEqual(10);
    expect(gap2).toBeGreaterThanOrEqual(20);
  });

  // Spec: Kit.Client, Transport: five resync failures in a row end the transport (check 4 Latency.LiveChange)
  test("T24b five failures", async () => {
    server.handler = pollOnly();
    const rig = build({
      random: () => 0,
      resyncImpl: async () => {
        throw new Error("app read failed");
      },
    });
    await until(() => lastState(rig).state === "stopped", 3000, "stopped");
    expect(lastState(rig)).toEqual({ state: "stopped", cause: "resync_failed" });
    expect(rig.resyncs.length).toBe(5);
    await wait(150);
    expect(rig.resyncs.length).toBe(5);
  });

  // Spec: Kit.Client, Contract: the package uses only fetch and streams, no Node module and no global the browser lacks (check Package.Independent)
  test("T25 source scan", async () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    // The files under src/react belong to another layer and have their own scan; this one covers every other source file.
    const files = readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !/^react[\\/]/.test(f));
    expect(files).toContain("transport.ts");
    for (const f of files) {
      const body = readFileSync(join(root, "src", f), "utf8");
      for (const banned of ["EventSource", "require(", 'from "node:', "process.", "Buffer", "localStorage", "document"]) {
        expect(body.includes(banned), `${f} contains ${banned}`).toBe(false);
      }
    }
    const body = readFileSync(join(root, "src", "transport.ts"), "utf8");
    expect(body.split("globalThis.fetch").length - 1).toBe(1);
    expect(body).toContain("options.fetch ?? globalThis.fetch");
    for (const other of ["window.fetch", "self.fetch", "global.fetch"]) expect(body.includes(other)).toBe(false);
    // The injected fetch is the one used.
    let calls = 0;
    server.handler = () => stream();
    const rig = build({
      fetch: (...a: Parameters<typeof fetch>) => {
        calls++;
        return fetch(...a);
      },
    });
    await until(() => server.requests.length === 1);
    expect(calls).toBe(1);
    expect(rig.t.stats().streamRequests).toBe(1);
  });

  // Spec: Kit.Client, Transport: the counters match what the server saw (check 4 Latency.LiveChange)
  test("T26 stats", async () => {
    const f = feeds();
    let first = true;
    server.handler = (r) => {
      if (r.kind !== "stream") return f(r) as { status: number; json: unknown };
      const k = server.of("stream").length;
      if (k === 1) return { status: 401, json: { error: "u" } };
      if (k === 2) return stream().frame(change("a", 1, cursor("A1"))).frame({ id: cursor("A2"), data: "{bad" }).cut();
      if (first) {
        first = false;
        return { status: 429, headers: { "retry-after": "1" }, json: { error: "live_capacity", scope: "identity", message: "x" } };
      }
      return stream();
    };
    // A long poll interval, so that nothing is in flight when the counters are read.
    const rig = build({ tokens: true, pollMs: 5000 });
    await until(() => has(rig, "polling", "capacity"), 4000, "polling");
    await until(() => server.of("feed-ended").length >= 1, 3000, "the first tick");
    await wait(100);
    const s = rig.t.stats();
    expect(s.streamRequests).toBe(server.of("stream").length);
    expect(s.feedRequests).toBe(server.of("feed-live", "feed-ended", "head-live", "head-ended").length);
    expect(s.authRefreshes).toBe(1);
    expect(s.framesPushed).toBe(1);
    expect(s.framesIgnored).toBe(1);
    expect(s.reconnects).toBe(1);
    expect(s.resyncs).toBe(1);
    expect(rig.authCalls.length).toBe(server.requests.length);
  });
});

describe("transport: the server answers added by the hardening batch, and the confirmation clock", () => {
  // Spec: Kit.Client, Transport: a token_expired close is a quiet reconnect whose first request asks for a refresh (check Security.NoSilentUnauthorised)
  test("T27 token_expired reconnects quietly with a refresh", async () => {
    server.handler = (r) => (r.n === 0 ? stream().frame(change("a", 1, cursor("A1"))).closedFrame("token_expired").end() : stream());
    const rig = build({ tokens: true, failuresBeforePoll: 1 });
    await until(() => server.requests.length >= 2);
    await until(() => rig.authCalls.length >= 2);
    expect(rig.authCalls.map((c) => c.refresh)).toEqual([false, true]);
    expect((server.requests[1] as SeenRequest).headers.authorization).toBe("Bearer tok-2");
    const re = rig.states.filter((s) => s.state === "reconnecting") as Array<{ quiet: boolean; cause: string }>;
    expect(re.length).toBe(1);
    expect(re[0]?.quiet).toBe(true);
    // It was not counted as a failure: with failuresBeforePoll 1 a counted failure would have meant polling.
    expect(has(rig, "polling")).toBe(false);
  });

  // Spec: Kit.Client, Transport: a refresh that is refused after token_expired is final (check Security.NoSilentUnauthorised)
  test("T27b token_expired then 401 is unauthorized", async () => {
    server.handler = (r) => (r.n === 0 ? stream().closedFrame("token_expired").end() : { status: 401, json: { error: "u" } });
    const rig = build({ tokens: true });
    await until(() => lastState(rig).state === "stopped");
    expect(lastState(rig)).toEqual({ state: "stopped", cause: "unauthorized" });
    expect(rig.authCalls.map((c) => c.refresh)).toEqual([false, true]);
    await wait(200);
    expect(server.requests.length).toBe(2);
  });

  // Spec: Kit.Client, Transport: three slow_consumer closes in a row mean polling (check 4 Latency.LiveChange)
  test("T28 slow_consumer", async () => {
    const f = feeds();
    server.handler = (r) => (r.kind === "stream" ? stream().closedFrame("slow_consumer").end() : (f(r) as { status: number; json: unknown }));
    const rig = build({ streamProbeMs: 10_000 });
    await until(() => has(rig, "polling", "failures"), 3000, "polling");
    expect(server.of("stream").length).toBe(3);
    const re = rig.states.filter((s) => s.state === "reconnecting") as Array<{ cause: string; quiet: boolean }>;
    expect(re.map((s) => s.cause)).toEqual(["closed_slow_consumer", "closed_slow_consumer"]);
    expect(re.every((s) => !s.quiet)).toBe(true);
  });

  // Spec: Kit.Client, Transport: two slow_consumer closes and then a good session do not count as three in a row (check 4 Latency.LiveChange)
  test("T28b slow_consumer streak is broken by another close", async () => {
    server.handler = (r) => {
      if (r.n === 2) return stream().closedFrame("recheck_failed").end();
      return r.n < 4 ? stream().closedFrame("slow_consumer").end() : stream();
    };
    const rig = build();
    await until(() => server.requests.length >= 5);
    expect(has(rig, "polling")).toBe(false);
  });

  // Spec: Kit.Client, Transport: every chunk, even a heartbeat, confirms the server is there (check Latency.Honest)
  test("T29 heartbeats confirm", async () => {
    const s = stream();
    server.handler = () => s;
    const rig = build();
    await until(() => server.requests.length === 1);
    for (let i = 0; i < 5; i++) {
      s.heartbeat();
      await wait(40);
    }
    expect(rig.confirms.length).toBe(5);
  });

  // Spec: Kit.Client, Transport: a quiet poll tick confirms (check Latency.Honest)
  test("T29b a quiet poll tick confirms", async () => {
    server.handler = pollOnly();
    const rig = build();
    await until(() => rig.confirms.length >= 4, 3000, "four confirmations");
    // One came from the resync; the others from empty ticks.
    expect(server.of("feed-live").length).toBeGreaterThanOrEqual(3);
    expect(rig.store.size()).toBe(0);
  });

  // Spec: Kit.Client, Transport: a 500 and a cut do not confirm (check Latency.Honest)
  test("T29c failures do not confirm", async () => {
    server.handler = (r) => (r.n % 2 === 0 ? { status: 500, json: { error: "x" } } : stream().cut());
    const rig = build();
    await until(() => server.requests.length >= 5, 3000, "five requests");
    expect(rig.confirms.length).toBe(0);
  });

  // Spec: Kit.Client, Transport: a callback that throws does not break the stream (check Latency.Honest)
  test("T29d a throwing onConfirm does not break the stream", async () => {
    server.handler = () => stream().heartbeat().frame(change("a", 1, cursor("A1"))).heartbeat();
    const rig = build({
      onConfirm: () => {
        throw new Error("app bug");
      },
    });
    await until(() => rig.store.size() === 1);
    await wait(100);
    expect(server.requests.length).toBe(1);
    expect(rig.t.mode()).toBe("stream");
  });

  // Spec: Kit.Client, Transport: a frame that arrives after stop is never applied (the epoch check; check 4 Latency.LiveChange)
  // L13b: a chunk is now parsed BEFORE it confirms, so the stop can no longer land ahead of the chunk's first frame. It lands
  // in the middle of the chunk instead: the first frame's own confirmation stops the transport and the second is discarded.
  test("T30 no push after the epoch changed", async () => {
    let tr: LiveTransport | null = null;
    const frameText = (name: string, ms: number, id: string): string =>
      `id: ${id}\nevent: change\ndata: ${JSON.stringify(frameData(ent(name), at(ms)))}\n\n`;
    server.handler = () => stream().raw(frameText("a", 1, cursor("A1")) + frameText("b", 2, cursor("A2")));
    const rig = build({
      startNow: false,
      onConfirm: () => {
        // Runs when the first frame has been pushed: the stop lands in the middle of the chunk.
        if (tr) void tr.stop();
        tr = null;
      },
    });
    tr = rig.t;
    rig.t.start();
    await until(() => lastState(rig).state === "stopped");
    expect(rig.store.size()).toBe(1);
    expect(rig.store.stats().pushed).toBe(1);
    expect(rig.t.stats().framesPushed).toBe(1);
  });

  // Spec: Kit.Client, Transport: a poll page that arrives after stop is never applied (the epoch check; check 4 Latency.LiveChange)
  test("T30b a poll page after stop is discarded", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    server.handler = pollOnly(feeds({ live: (r) => (r.query.get("since") === cursor("HL1") ? feedPage([{ entity: ent("late"), updatedAt: at(1) }], cursor("P1"), true) : feedPage([], r.query.get("since"), true)) }));
    // This fetch ignores the abort signal and answers late, as a stuck proxy might.
    const rig = build({
      fetch: async (url, init) => {
        const u = String(url);
        const res = await fetch(url, { ...init, signal: undefined });
        if (u.includes("/records") && !u.includes("since=head")) {
          await gate;
        }
        return res;
      },
    });
    await until(() => server.of("feed-live").length === 1);
    const stopping = rig.t.stop();
    let resolved = false;
    void stopping.then(() => { resolved = true; });
    await wait(30);
    // stop() waits for the request in flight to settle; it does not resolve while one is still open.
    expect(resolved).toBe(false);
    (release as unknown as () => void)();
    await stopping;
    expect(rig.store.size()).toBe(0);
    expect(rig.store.stats().pushed).toBe(0);
  });
});

describe("transport: a 404 on the stream is probed against the poll feed once (L11c)", () => {
  /** Every answer is 404, as a viewer with no access would meet it on the stream and on the feed alike. */
  const everythingRefused = (status: number) => (): { status: number; json: unknown } => ({ status, json: { error: "not_found" } });
  /** The stream is 404 and the feeds are `feed`. */
  const noRoute = (feed: (r: SeenRequest) => { status: number; json: unknown } | null = feeds()) => (r: SeenRequest) =>
    r.kind === "stream" ? { status: 404, json: { error: "not_found" } } : (feed(r) as { status: number; json: unknown });

  // Spec: Kit.Client, Transport: an app on a platform without the /live route still polls (a 404 on the stream is probed once against the feed)
  test("T40 stream 404, feed answers", async () => {
    server.handler = noRoute(feeds({ live: (r) => (r.query.get("since") === cursor("HL1") ? feedPage([{ entity: ent("seen"), updatedAt: at(1) }], cursor("P1"), true) : feedPage([], r.query.get("since"), true)) }));
    const rig = build();
    await until(() => has(rig, "polling", "no_stream"), 3000, "polling because there is no stream");
    // The probe is the first feed request, and it comes right after the one stream request.
    expect((server.requests[0] as SeenRequest).kind).toBe("stream");
    expect((server.requests[1] as SeenRequest).kind).toBe("head-live");
    await wait(800);
    // 800 ms is more than two stream-probe intervals (300 ms): the stream must not be asked for again.
    expect(server.of("stream").length).toBe(1);
    expect(server.of("feed-live").length).toBeGreaterThan(3);
    expect(rig.t.mode()).toBe("poll");
    await until(() => rig.store.size() === 1, 3000, "the change from the feed");
    expect(has(rig, "reconnecting")).toBe(false);
    expect(server.violations).toEqual([]);
  });

  // Spec: Kit.Client, Transport: a 404 on the stream and a 404 on the feed are one refusal: two requests, then nothing
  test("T41 stream 404, feed refuses (404)", async () => {
    server.handler = everythingRefused(404);
    const rig = build();
    await until(() => lastState(rig).state === "stopped");
    expect(lastState(rig)).toEqual({ state: "stopped", cause: "refused" });
    expect(server.of("stream").length).toBe(1);
    expect(server.requests.length - server.of("stream").length).toBe(1);
    expect((server.requests[1] as SeenRequest).kind).toBe("head-live");
    // A refused viewer never reaches the poll: no poll start, no app read.
    expect(has(rig, "resyncing")).toBe(false);
    expect(has(rig, "polling")).toBe(false);
    expect(rig.resyncs.length).toBe(0);
    await wait(300);
    expect(server.requests.length).toBe(2);
    expect(rig.t.stats()).toMatchObject({ streamRequests: 1, feedRequests: 1 });
  });

  // Spec: Kit.Client, Transport: a feed that says 403 after a stream 404 is final too
  test("T42 stream 404, feed 403", async () => {
    server.handler = (r) => (r.kind === "stream" ? { status: 404, json: { error: "not_found" } } : { status: 403, json: { error: "forbidden" } });
    const rig = build();
    await until(() => lastState(rig).state === "stopped");
    expect(lastState(rig)).toEqual({ state: "stopped", cause: "refused" });
    expect(has(rig, "resyncing")).toBe(false);
    await wait(300);
    expect(server.of("stream").length).toBe(1);
    expect(server.requests.length).toBe(2);
    expect(rig.t.stats()).toMatchObject({ streamRequests: 1, feedRequests: 1 });
  });

  // Spec: Kit.Client, Transport: an explicit 403 on the stream is final and is NOT probed
  test("T43 stream 403", async () => {
    server.handler = everythingRefused(403);
    const rig = build();
    await until(() => lastState(rig).state === "stopped");
    expect(lastState(rig)).toEqual({ state: "stopped", cause: "refused" });
    await wait(300);
    expect(server.requests.length).toBe(1);
    expect(server.of("stream").length).toBe(1);
    expect(rig.t.stats()).toMatchObject({ streamRequests: 1, feedRequests: 0 });
  });

  // Spec: Kit.Client, Transport: the probe has the usual single refresh after a 401
  test("T44 stream 404, feed 401 then 200", async () => {
    const f = noRoute();
    let headCalls = 0;
    server.handler = (r) => {
      if (r.kind === "head-live" && ++headCalls === 1) return { status: 401, json: { error: "unauthorized" } };
      return f(r) as { status: number; json: unknown };
    };
    const rig = build({ tokens: true });
    await until(() => has(rig, "polling", "no_stream"), 3000, "polling");
    // The first two feed requests are the probe and its one retry; the provider is asked for each, the second time with refresh.
    const feedAuth = rig.authCalls.filter((c) => c.url.includes("/records"));
    expect(feedAuth.slice(0, 2).map((c) => c.refresh)).toEqual([false, true]);
    expect((server.requests[1] as SeenRequest).headers.authorization).toBe("Bearer tok-1");
    expect((server.requests[2] as SeenRequest).headers.authorization).toBe("Bearer tok-2");
    expect(server.of("head-live").length).toBeGreaterThanOrEqual(2);
    expect(rig.t.stats().authRefreshes).toBe(1);
    expect(server.of("stream").length).toBe(1);
  });

  // Spec: Kit.Client, Transport: a 5xx on the probe says nothing about access: back off, ask again, and poll when the feed answers
  test("T45 stream 404, feed 500, then 200", async () => {
    const f = noRoute();
    let headCalls = 0;
    server.handler = (r) => {
      if (r.kind === "head-live" && ++headCalls === 1) return { status: 500, json: { error: "boom" } };
      return f(r) as { status: number; json: unknown };
    };
    // random 1 makes the first back-off delay exactly baseMs (20 ms).
    const rig = build({ random: () => 1 });
    await until(() => has(rig, "polling", "no_stream"), 3000, "polling");
    expect(has(rig, "reconnecting", "http_5xx")).toBe(true);
    const heads = server.of("head-live");
    expect(heads.length).toBeGreaterThanOrEqual(2);
    // A timer may fire a hair early (about 1 ms): the exact delay is in the state.
    const delay = (rig.states.find((s) => s.state === "reconnecting") as { retryInMs: number }).retryInMs;
    expect(delay).toBe(20);
    expect((heads[1] as SeenRequest).at - (heads[0] as SeenRequest).at).toBeGreaterThanOrEqual(delay - 2);
    // The stream was asked again after the wait, met the 404 again, and the second probe answered.
    expect(server.of("stream").length).toBe(2);
    expect(names(rig)).not.toContain("stopped");
  });

  // Spec: Kit.Client, Transport: the periodic stream try made from poll mode follows the same 404 rule
  test("T46 poll-mode stream probe meets 404", async () => {
    const f = feeds();
    server.handler = (r) => {
      if (r.kind !== "stream") return f(r) as { status: number; json: unknown };
      if (server.of("stream").length === 1) return { status: 429, headers: { "retry-after": "1" }, json: { error: "live_capacity", scope: "identity", message: "x" } };
      return { status: 404, json: { error: "not_found" } };
    };
    const rig = build();
    await until(() => has(rig, "polling", "capacity"), 3000, "polling for capacity");
    await until(() => server.of("stream").length === 2, 4000, "the probe stream try");
    // After the 404 the probe asks the feed, which answers: the transport keeps polling and the stream is gone for good.
    await wait(1000);
    expect(server.of("stream").length).toBe(2);
    expect(rig.t.mode()).toBe("poll");
    expect(lastState(rig).state).toBe("polling");
    const before = server.of("feed-live").length;
    await wait(200);
    expect(server.of("feed-live").length).toBeGreaterThan(before);
    expect(server.violations).toEqual([]);
  });

  // Spec: Kit.Client, Transport: a probe from poll mode that the feed refuses ends the transport as refused
  test("T47 a refused probe in poll mode", async () => {
    const f = feeds();
    server.handler = (r) => {
      if (r.kind === "stream") {
        if (server.of("stream").length === 1) return { status: 429, headers: { "retry-after": "1" }, json: { error: "live_capacity", scope: "identity", message: "x" } };
        return { status: 404, json: { error: "not_found" } };
      }
      // The feed answers until the second stream request has been seen; from then on it refuses.
      return server.of("stream").length >= 2 ? { status: 404, json: { error: "not_found" } } : (f(r) as { status: number; json: unknown });
    };
    const rig = build();
    await until(() => lastState(rig).state === "stopped", 5000, "the end");
    expect(lastState(rig)).toEqual({ state: "stopped", cause: "refused" });
    const secondStream = (server.of("stream")[1] as SeenRequest).n;
    // Exactly one request followed the second stream try: the probe.
    expect(server.requests.length - 1 - secondStream).toBe(1);
    expect((server.requests[secondStream + 1] as SeenRequest).kind).toBe("head-live");
    const seen = server.requests.length;
    await wait(300);
    expect(server.requests.length).toBe(seen);
  });

  // Spec: Kit.Client, Transport: non-disclosure. A viewer with no access sees the old behaviour plus one feed request, and learns nothing
  test("T48 non-disclosure", async () => {
    server.handler = everythingRefused(404);
    const rig = build({ tokens: true });
    await until(() => lastState(rig).state === "stopped");
    await wait(300);
    expect(server.requests.length).toBe(2);
    expect(server.requests.map((x) => x.kind)).toEqual(["stream", "head-live"]);
    // What the app sees is exactly what the old rule gave it: connecting, then stopped as refused. Nothing in between.
    expect(rig.states).toEqual([{ state: "connecting" }, { state: "stopped", cause: "refused" }]);
    expect(rig.resyncs.length).toBe(0);
    expect(rig.store.size()).toBe(0);
    expect(JSON.stringify(rig.states)).not.toMatch(/not_found|tok-/);
    // The probe carries no position and no more than the poll's own head request would.
    expect((server.requests[1] as SeenRequest).query.get("since")).toBe("head");
  });

  // Spec: Kit.Client, Transport: the tests for revoke (T9), not available here (T12) and the bad cursor (T17, T17b) are kept as they were
  test("T49 the old tests keep passing", () => {
    const body = readFileSync(fileURLToPath(import.meta.url), "utf8");
    for (const title of ['test("T9 revoke"', 'test("T12 not available here"', 'test("T17 bad cursor, no loop"', 'test("T17b both refused"']) {
      expect(body.includes(title), title).toBe(true);
    }
    // They are run by this same file: T8 is the only one changed, and only to drop the 404 row.
    expect(body).toContain('test.each([403])("T8 refused %i"');
    expect(body).not.toContain("test.each([403, 404])" + '("T8');
  });
});
