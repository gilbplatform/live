import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLiveStore } from "../src/store.js";
import { createLiveTransport } from "../src/transport.js";
import type { LiveTransport, TransportOptions, TransportState } from "../src/transport-types.js";
import type { LiveStore } from "../src/types.js";
import { FrameServer, StreamScript, cursor, feedPage, frameData } from "./helpers/frameServer.js";
import type { SeenRequest } from "./helpers/frameServer.js";

// An opening line is not proof (batch L13b, fix 2). Real sockets and real timers, small windows. The opening line the
// real route writes is `retry: 3000`; here it is `retry: 250`, the smallest hint the transport accepts, because the
// transport waits at least its hint before it reconnects and a 3 s wait would only slow these tests down.

const T0 = Date.UTC(2026, 10, 19, 10, 0, 0);
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const ent = (name: string): string => `https://vault.example/e/${name}`;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean, ms = 3000, what = "the condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await wait(5);
  }
}

interface Rig {
  store: LiveStore<unknown>;
  t: LiveTransport;
  states: TransportState[];
  confirms: number[];
}

let server: FrameServer;
const transports: LiveTransport[] = [];
const timers: Array<ReturnType<typeof setTimeout>> = [];

beforeEach(async () => {
  server = new FrameServer();
  await server.start();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const t of timers.splice(0)) clearTimeout(t);
  await Promise.all(transports.splice(0).map((t) => t.stop()));
  await server.close();
});

/** A scheduled server action; cleared after the test so it cannot leak into the next. */
function later(ms: number, fn: () => void): void {
  timers.push(setTimeout(fn, ms));
}

/** Builds a transport on a real store with small windows. Poll mode is off unless a test asks for it. */
function build(over: Partial<TransportOptions> = {}): Rig {
  let k = 0;
  const store = createLiveStore<unknown>({ holdMs: 0, read: async (n) => ({ record: { entity: n.entity }, etag: `e${++k}` }) });
  const states: TransportState[] = [];
  const confirms: number[] = [];
  const t = createLiveTransport({
    store,
    origin: server.origin,
    vaultId: "vault-1",
    auth: () => ({ authorization: "Bearer SECRET-TOKEN-123" }),
    resync: async () => { store.seed([]); },
    pollMs: 40,
    heartbeatTimeoutMs: 200,
    stableMs: 250,
    streamProbeMs: 300,
    failuresBeforePoll: 50,
    backoff: { baseMs: 20, capMs: 60 },
    random: () => 0,
    onState: (s) => states.push(s),
    onConfirm: (ms) => confirms.push(ms),
    ...over,
  });
  transports.push(t);
  t.start();
  return { store, t, states, confirms };
}

const stream = (): StreamScript => new StreamScript();
/** What the real route writes the moment a subscription succeeds. */
const opening = (s: StreamScript = stream()): StreamScript => s.retry(250);
const change = (name: string, ms: number, id: string): { id: string; data: unknown } => ({ id, data: frameData(ent(name), at(ms)) });

/** Stream request number `n` (the n-th stream request the server saw), by position among stream requests only. */
const nth = (r: SeenRequest): number => server.of("stream").indexOf(r);

/** Feeds for poll mode: heads and empty pages. */
function feedAnswer(r: SeenRequest): { status: number; json: unknown } | null {
  if (r.kind === "head-live") return { status: 200, json: feedPage([], cursor("HL1"), true) };
  if (r.kind === "head-ended") return { status: 200, json: feedPage([], cursor("HE1"), true) };
  if (r.kind === "feed-live" || r.kind === "feed-ended") return { status: 200, json: feedPage([], r.query.get("since"), true) };
  return null;
}

describe("transport: an opening line is not proof", () => {
  // Spec: Kit.Client, Transport: the first connection's opening line confirms at once (LiveWire step, check 8 Honesty.LiveState)
  test("T50 the first connection's opening line confirms", async () => {
    server.handler = (r) => (nth(r) === 0 ? opening() : stream());
    const rig = build();
    await until(() => server.requests.length === 1, 3000, "the first request");
    await until(() => rig.confirms.length === 1, 150, "the opening line to confirm");
    expect(rig.confirms.length).toBe(1);
  });

  // Spec: Kit.Client, Transport: after a silent connection a new opening line must be followed by a heartbeat before it confirms (LiveWire step, check 8 Honesty.LiveState)
  test("T51 silence, then a new connection: the opening line does not confirm, a heartbeat does, then a healthy cut confirms at once", async () => {
    let atHeartbeat = -1;
    let before3 = -1;
    const s2 = opening();
    server.handler = (r) => {
      const n = nth(r);
      if (n === 0) return opening();
      if (n === 1) {
        // The watchdog (200 ms) would cut this stream, so the heartbeat comes well inside it.
        later(100, () => {
          atHeartbeat = rigRef.confirms.length;
          s2.heartbeat().cut();
        });
        return s2;
      }
      if (n === 2) {
        before3 = rigRef.confirms.length;
        return opening();
      }
      return stream();
    };
    const rigRef = build();
    await until(() => rigRef.confirms.length === 1, 1000, "the first confirmation");
    await until(() => atHeartbeat >= 0, 3000, "stream 2 to reach its heartbeat");
    // Stream 2's opening line arrived about 100 ms earlier and confirmed nothing.
    expect(atHeartbeat).toBe(1);
    await until(() => rigRef.confirms.length === 2, 1000, "the heartbeat to confirm");
    // Stream 2 was cut after a heartbeat, so stream 3's opening line is trusted.
    await until(() => before3 >= 0 && rigRef.confirms.length > before3, 2000, "stream 3's opening line to confirm");
    expect(before3).toBe(2);
    expect(rigRef.confirms.length).toBe(3);
  });

  // Spec: Kit.Client, Transport: a connection that spoke and then went silent cannot vouch for the next one (LiveWire step, check 8 Honesty.LiveState)
  test("T51b a connection cut by the watchdog after a heartbeat still leaves the doubt", async () => {
    let atHeartbeat = -1;
    const s1 = opening();
    const s2 = opening();
    server.handler = (r) => {
      const n = nth(r);
      if (n === 0) {
        later(50, () => { s1.heartbeat(); });
        return s1;
      }
      if (n === 1) {
        later(100, () => {
          atHeartbeat = rig.confirms.length;
          s2.heartbeat();
        });
        return s2;
      }
      return stream();
    };
    const rig = build();
    // Stream 1: opening line (1), heartbeat (2), then silence until the watchdog cuts it.
    await until(() => atHeartbeat >= 0, 3000, "stream 2 to reach its heartbeat");
    // Stream 2's opening line, 100 ms earlier, confirmed nothing.
    expect(atHeartbeat).toBe(2);
    await until(() => rig.confirms.length === 3, 1000, "the heartbeat to confirm");
  });

  // Spec: Kit.Client, Transport: an event after the opening line clears the doubt and the event still reaches the store (LiveWire step, check 8 Honesty.LiveState)
  test("T52 an event clears the doubt", async () => {
    let atEvent = -1;
    let before3 = -1;
    const s2 = opening();
    server.handler = (r) => {
      const n = nth(r);
      if (n === 0) return opening();
      if (n === 1) {
        later(100, () => {
          atEvent = rig.confirms.length;
          s2.frame(change("a", 1, cursor("A1"))).cut();
        });
        return s2;
      }
      if (n === 2) {
        before3 = rig.confirms.length;
        return opening();
      }
      return stream();
    };
    const rig = build();
    await until(() => atEvent >= 0, 3000, "stream 2 to reach its event");
    expect(atEvent).toBe(1);
    await until(() => rig.store.size() === 1, 1000, "the event to reach the store");
    expect(rig.confirms.length).toBeGreaterThan(1);
    await until(() => before3 >= 0 && rig.confirms.length > before3, 2000, "stream 3's opening line to confirm");
  });

  // Spec: Kit.Client, Transport: a reconnect after a healthy connection confirms on the opening line at once (LiveWire step, check 8 Honesty.LiveState)
  test("T53 a healthy connection: the next opening line confirms at once", async () => {
    let before2 = -1;
    server.handler = (r) => {
      const n = nth(r);
      if (n === 0) return stream().heartbeat().cut();
      if (n === 1) {
        before2 = rig.confirms.length;
        return opening();
      }
      return stream();
    };
    const rig = build();
    await until(() => rig.confirms.length === 1, 1000, "the heartbeat to confirm");
    await until(() => before2 >= 0 && rig.confirms.length > before2, 2000, "stream 2's opening line to confirm");
    expect(before2).toBe(1);
    expect(rig.confirms.length).toBe(2);
  });

  // Spec: Kit.Client, Transport: a connection that ended with no content leaves the doubt in place (LiveWire step, check 8 Honesty.LiveState)
  test("T54 an empty connection: the opening line does not confirm, a heartbeat does", async () => {
    let atHeartbeat = -1;
    const s2 = opening();
    server.handler = (r) => {
      const n = nth(r);
      if (n === 0) return opening().end();
      if (n === 1) {
        later(100, () => {
          atHeartbeat = rig.confirms.length;
          s2.heartbeat();
        });
        return s2;
      }
      return stream();
    };
    const rig = build();
    await until(() => rig.confirms.length === 1, 1000, "the first confirmation");
    await until(() => atHeartbeat >= 0, 3000, "stream 2 to reach its heartbeat");
    expect(atHeartbeat).toBe(1);
    await until(() => rig.confirms.length === 2, 1000, "the heartbeat to confirm");
  });

  // Spec: Kit.Client, Transport: a closed frame is the server speaking, so it counts as content (LiveWire step, check 8 Honesty.LiveState)
  test("T55 a closed frame is content: the quiet renewal's opening line confirms", async () => {
    let before2 = -1;
    server.handler = (r) => {
      const n = nth(r);
      // No heartbeat and no event: the closed frame alone has to be what makes the next connection trusted.
      if (n === 0) return opening().closedFrame("max_age").end();
      if (n === 1) {
        before2 = rig.confirms.length;
        return opening();
      }
      return stream();
    };
    const rig = build();
    await until(() => before2 >= 0 && rig.confirms.length > before2, 1500, "stream 2's opening line to confirm");
    expect(server.of("stream").length).toBeGreaterThanOrEqual(2);
  });

  // Spec: Kit.Client, Transport: a successful poll tick clears the doubt, so a later stream try's opening line confirms (LiveWire step, check 8 Honesty.LiveState)
  test("T56 a poll tick clears the doubt", async () => {
    let before3 = -1;
    server.handler = (r) => {
      if (r.kind !== "stream") return feedAnswer(r) as { status: number; json: unknown };
      const n = nth(r);
      if (n === 0) return opening();
      if (n === 1) return { status: 429, headers: { "retry-after": "1" }, json: { error: "live_capacity", message: "x" } };
      if (n === 2) {
        before3 = rig.confirms.length;
        return opening();
      }
      return stream();
    };
    const rig = build();
    await until(() => rig.states.some((s) => s.state === "polling"), 3000, "polling");
    // The stream try comes after the retry-after of one second; poll ticks confirm in the meantime.
    await until(() => before3 >= 0, 4000, "the stream try");
    expect(before3).toBeGreaterThan(1);
    await until(() => rig.confirms.length > before3, 1000, "the stream try's opening line to confirm");
  });

  // Spec: Kit.Client, Transport: a distrusted connection that stays silent is still cut by the watchdog (LiveWire step, check 8 Honesty.LiveState)
  test("T57 a distrusted connection is still cut", async () => {
    server.handler = (r) => (nth(r) <= 1 ? opening() : stream());
    const rig = build();
    await until(() => server.of("stream").length >= 3, 3000, "a third stream request");
    const [, second, third] = server.of("stream");
    // The watchdog is 200 ms and the hint 250 ms, so the gap cannot be shorter than the watchdog.
    expect((third as SeenRequest).at - (second as SeenRequest).at).toBeGreaterThanOrEqual(190);
    // Stream 2's opening line was the whole of its news, and it confirmed nothing.
    expect(rig.confirms.length).toBe(1);
  });

  // Spec: Kit.Client, Transport: the opening chunk re-arms the watchdog, it never disarms it (LiveWire step, check 8 Honesty.LiveState)
  test("T57b the opening chunk re-arms the watchdog", async () => {
    const DELAY = 120;
    server.handler = (r) => {
      const n = nth(r);
      if (n === 0) return opening();
      if (n === 1) {
        // The opening line arrives DELAY ms after the request, so a watchdog armed only at the start would fire earlier.
        const s = stream();
        later(DELAY, () => { opening(s); });
        return s;
      }
      return stream();
    };
    build();
    await until(() => server.of("stream").length >= 3, 3000, "a third stream request");
    const [, second, third] = server.of("stream");
    // Re-armed at the opening line: cut no sooner than DELAY + 200 ms after the request, plus the 250 ms hint.
    expect((third as SeenRequest).at - (second as SeenRequest).at).toBeGreaterThanOrEqual(DELAY + 200 + 250 - 30);
  });

  // Spec: Kit.Client, Transport: an opening line and a heartbeat in one chunk confirm, because the chunk holds content (LiveWire step, check 8 Honesty.LiveState)
  test("T58 one chunk with an opening line and a heartbeat confirms", async () => {
    let before2 = -1;
    server.handler = (r) => {
      const n = nth(r);
      if (n === 0) return opening();
      if (n === 1) {
        before2 = rig.confirms.length;
        return stream().raw("retry: 250\n\n: heartbeat\n\n");
      }
      return stream();
    };
    const rig = build();
    await until(() => before2 >= 0 && rig.confirms.length > before2, 2000, "the chunk to confirm");
    expect(before2).toBe(1);
  });

  // Spec: Kit.Client, Transport: an opening line split across two chunks does not confirm on a distrusted connection (LiveWire step, check 8 Honesty.LiveState)
  test("T58b an opening line split across two chunks does not confirm", async () => {
    let atEnd = -1;
    const s2 = stream();
    server.handler = (r) => {
      const n = nth(r);
      if (n === 0) return opening();
      if (n === 1) {
        s2.raw("retry: 2");
        later(40, () => { s2.raw("50\n\n"); });
        later(110, () => {
          atEnd = rig.confirms.length;
          s2.heartbeat();
        });
        return s2;
      }
      return stream();
    };
    const rig = build();
    await until(() => atEnd >= 0, 3000, "stream 2 to reach its heartbeat");
    expect(atEnd).toBe(1);
    await until(() => rig.confirms.length === 2, 1000, "the heartbeat to confirm");
  });

  // Spec: Kit.Client, Transport: any comment line is content, so a later statement from the hub will count (LiveWire step, check 8 Honesty.LiveState)
  test("T59 any comment line is content", async () => {
    let atComment = -1;
    const s2 = opening();
    server.handler = (r) => {
      const n = nth(r);
      if (n === 0) return opening();
      if (n === 1) {
        later(100, () => {
          atComment = rig.confirms.length;
          s2.raw(": caught-up 2026-11-20T10:00:00.000Z\n\n");
        });
        return s2;
      }
      return stream();
    };
    const rig = build();
    await until(() => atComment >= 0, 3000, "stream 2 to reach its comment");
    expect(atComment).toBe(1);
    await until(() => rig.confirms.length === 2, 1000, "the comment to confirm");
  });

  // Spec: Kit.Client, Transport: the existing rules stand: events confirm, failures do not (LiveWire step, check 8 Honesty.LiveState)
  test("T60 a pushed event confirms and a failure does not", async () => {
    const s = stream();
    server.handler = (r) => (nth(r) === 0 ? s : { status: 500, json: { error: "x" } });
    const rig = build();
    await until(() => server.requests.length === 1, 3000, "the request");
    for (let i = 1; i <= 3; i++) {
      const before = rig.confirms.length;
      s.frame(change(`e${i}`, i, cursor(`E${i}`)));
      await until(() => rig.confirms.length > before, 500, `event ${i} to confirm`);
    }
    await until(() => rig.store.size() === 3, 1000, "three records");
    const total = rig.confirms.length;
    s.cut();
    // The stream is cut, then every reconnect meets a 500: nothing confirms.
    await until(() => server.requests.length >= 4, 3000, "failing reconnects");
    expect(rig.confirms.length).toBe(total);
  });

  // Spec: Kit.Client, Transport: the app's own stop leaves no doubt behind; a new transport starts trusting (LiveWire step, check 8 Honesty.LiveState)
  test("T61 a new transport after the app's own stop confirms on its first opening line", async () => {
    server.handler = (r) => (nth(r) <= 1 ? opening() : stream());
    const first = build();
    await until(() => first.confirms.length === 1, 1000, "the first confirmation");
    // Stopped while its only news was an opening line, which would be a doubt for a transport that lived on.
    await first.t.stop();
    const second = build();
    await until(() => second.confirms.length === 1, 1000, "the second transport's opening line to confirm");
    expect(second.confirms.length).toBe(1);
  });
});
