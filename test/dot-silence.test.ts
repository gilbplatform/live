import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createConfirmationClock } from "../src/confirm.js";
import type { ConfirmationClock } from "../src/confirm.js";
import { createLiveStore } from "../src/store.js";
import { createDotMachine } from "../src/state.js";
import type { DotKind, DotMachine } from "../src/state.js";
import { createLiveTransport } from "../src/transport.js";
import type { LiveTransport } from "../src/transport-types.js";
import { FrameServer, StreamScript } from "./helpers/frameServer.js";
import type { SeenRequest } from "./helpers/frameServer.js";

// The whole path: a real transport on a real socket, a real confirmation clock and a real dot machine (batch L13b).
// A server that answers every new connection with an opening line and nothing else must not make the dot say Live.
// The opening line is `retry: 250` here (the real route writes `retry: 3000`): the transport waits at least its hint
// before it reconnects, and 250 ms is the smallest hint it accepts.

const WINDOW_MS = 400;
const OFFLINE_MS = 1500;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean, ms = 3000, what = "the condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await wait(5);
  }
}

interface Sample {
  /** performance.now() when the sample was taken */
  t: number;
  kind: DotKind;
  showLive: boolean;
  /** the dot's own evaluation time and the clock's latest confirmation, both epoch ms */
  at: number;
  lastConfirmedAt: number | null;
}

interface Rig {
  m: DotMachine;
  clock: ConfirmationClock;
  t: LiveTransport;
  samples: Sample[];
  confirmTimes: number[];
}

let server: FrameServer;
let rigs: Rig[] = [];
let sampler: ReturnType<typeof setInterval> | undefined;
const timers: Array<ReturnType<typeof setTimeout>> = [];

beforeEach(async () => {
  server = new FrameServer();
  await server.start();
});

afterEach(async () => {
  clearInterval(sampler);
  sampler = undefined;
  for (const t of timers.splice(0)) clearTimeout(t);
  for (const r of rigs) r.m.close();
  await Promise.all(rigs.map((r) => r.t.stop()));
  rigs = [];
  await server.close();
});

function later(ms: number, fn: () => void): void {
  timers.push(setTimeout(fn, ms));
}

/** A real transport feeding a real machine, with a timeline of every emission and a sample every 15 ms. */
function build(): Rig {
  const clock = createConfirmationClock();
  const m = createDotMachine({ clock, heartbeatWindowMs: WINDOW_MS, offlineAfterMs: OFFLINE_MS });
  const samples: Sample[] = [];
  const confirmTimes: number[] = [];
  const take = (): void => {
    const d = m.state();
    samples.push({ t: performance.now(), kind: d.kind, showLive: d.showLive, at: d.at, lastConfirmedAt: clock.lastConfirmedAt() });
  };
  m.subscribe(take);
  // refresh() first, so a sample is the answer for this moment and not the one from the last timer.
  sampler = setInterval(() => { m.refresh(); take(); }, 15);
  const store = createLiveStore<unknown>({ holdMs: 0, read: async (n) => ({ record: { entity: n.entity }, etag: "e1" }) });
  const t = createLiveTransport({
    store,
    origin: server.origin,
    vaultId: "vault-1",
    auth: () => ({ authorization: "Bearer SECRET-TOKEN-123" }),
    resync: async () => { store.seed([]); },
    heartbeatTimeoutMs: WINDOW_MS,
    stableMs: 250,
    failuresBeforePoll: 50,
    backoff: { baseMs: 20, capMs: 60 },
    random: () => 0,
    onState: (s) => m.feedTransport(s),
    onConfirm: (ms) => { confirmTimes.push(ms); clock.confirm(ms); },
  });
  const rig = { m, clock, t, samples, confirmTimes };
  rigs.push(rig);
  t.start();
  return rig;
}

const stream = (): StreamScript => new StreamScript();
const opening = (s: StreamScript = stream()): StreamScript => s.retry(250);
const nth = (r: SeenRequest): number => server.of("stream").indexOf(r);
const isLive = (s: Sample): boolean => s.kind === "live" || s.showLive;

describe("the dot after a silent server", () => {
  // Spec: State.QuietDot, Honesty: a server that accepts but never speaks never brings the word Live back (LiveWire step, check 8 Honesty.LiveState)
  test("DS1 A9's quiet scene: Live, then not Live, never Live again, then offline", async () => {
    let heartbeatAt = 0;
    const s1 = opening();
    server.handler = (r) => (nth(r) === 0 ? s1 : opening());
    const rig = build();
    await until(() => rig.m.state().kind === "live", 3000, "the first live");
    heartbeatAt = performance.now();
    s1.heartbeat();
    await until(() => rig.confirmTimes.length >= 2, 1000, "the heartbeat to confirm");
    await until(() => rig.m.state().kind !== "live", 2500, "the dot to leave live");
    const leftAt = performance.now();
    // The window is 400 ms from the last confirmation; the timer cannot fire before it.
    expect(leftAt - heartbeatAt).toBeGreaterThanOrEqual(WINDOW_MS - 10);
    await wait(1000);
    // Streams 2 and 3 have each sent an opening line by now, and none of them brought Live back.
    expect(rig.samples.filter((s) => s.t > leftAt && isLive(s))).toEqual([]);
    await until(() => rig.m.state().kind === "offline", 2500, "offline");
    const offlineAt = performance.now();
    // Offline is due OFFLINE_MS after the silence began, and the silence began WINDOW_MS after the heartbeat.
    expect(offlineAt - heartbeatAt).toBeGreaterThanOrEqual(WINDOW_MS + OFFLINE_MS - 20);
    expect(offlineAt - heartbeatAt).toBeLessThan(WINDOW_MS + OFFLINE_MS + 500);
    // Streams 2 and 3 each sent an opening line, and none of them brought Live back.
    expect(server.of("stream").length).toBeGreaterThanOrEqual(3);
    expect(rig.samples.filter((s) => s.t > leftAt && isLive(s))).toEqual([]);
  });

  // Spec: State.QuietDot, Honesty: the first heartbeat of a new connection brings Live back, and not before (LiveWire step, check 8 Honesty.LiveState)
  test("DS2 recovery: a heartbeat on stream 2 brings Live back at that heartbeat and not before", async () => {
    let sentAt = 0;
    let openedAt = 0;
    let before3 = -1;
    const s1 = opening();
    const s2 = opening();
    server.handler = (r) => {
      const n = nth(r);
      if (n === 0) return s1;
      if (n === 1) {
        openedAt = performance.now();
        later(150, () => { sentAt = performance.now(); s2.heartbeat().cut(); });
        return s2;
      }
      if (n === 2) before3 = rig.confirmTimes.length;
      return opening();
    };
    const rig = build();
    await until(() => rig.m.state().kind === "live", 3000, "the first live");
    s1.heartbeat();
    await until(() => rig.m.state().kind !== "live", 2500, "the dot to leave live");
    const leftAt = performance.now();
    await until(() => sentAt > 0 && rig.m.state().kind === "live", 3000, "Live to return");
    const backAt = performance.now();
    expect(openedAt).toBeGreaterThan(leftAt - 50);
    expect(backAt).toBeGreaterThanOrEqual(sentAt);
    // Between the departure and the heartbeat, no sample (the opening line of stream 2 included) said Live.
    expect(rig.samples.filter((s) => s.t > leftAt && s.t < sentAt && isLive(s))).toEqual([]);
    // The heartbeat cleared the doubt for good: stream 3, which follows stream 2's cut, is trusted on its opening line.
    await until(() => before3 >= 0 && rig.confirmTimes.length > before3, 2000, "stream 3's opening line to confirm");
  });

  // Spec: State.QuietDot, Honesty: a reconnect after a healthy connection does not flash or go offline (LiveWire step, check 8 Honesty.LiveState)
  test("DS3 a healthy reconnect does not flash: back to live within 200 ms, never offline", async () => {
    let cutAt = 0;
    const s1 = stream();
    server.handler = (r) => (nth(r) === 0 ? s1 : opening());
    const rig = build();
    // Stream 1 carries only heartbeats (no hint), so the transport reconnects after its short back-off.
    await until(() => server.requests.length === 1, 3000, "the request");
    s1.heartbeat();
    later(50, () => s1.heartbeat());
    later(100, () => s1.heartbeat());
    later(150, () => { cutAt = performance.now(); s1.cut(); });
    await until(() => cutAt > 0, 2000, "the cut");
    await until(() => server.of("stream").length >= 2, 2000, "stream 2");
    await until(() => rig.m.state().kind === "live" && performance.now() > cutAt, 2000, "Live after the cut");
    expect(performance.now() - cutAt).toBeLessThan(200);
    expect(rig.samples.some((s) => s.kind === "offline")).toBe(false);
  });

  // Spec: State.QuietDot, Honesty: a routine renewal (max_age) never flashes (LiveWire step, check 8 Honesty.LiveState)
  test("DS3b a max_age renewal stays live all the way through", async () => {
    const s1 = stream();
    server.handler = (r) => (nth(r) === 0 ? s1 : opening());
    const rig = build();
    await until(() => server.requests.length === 1, 3000, "the request");
    s1.heartbeat();
    await until(() => rig.m.state().kind === "live", 1000, "live");
    const liveAt = performance.now();
    s1.closedFrame("max_age").end();
    await until(() => server.of("stream").length >= 2, 2000, "stream 2");
    await wait(150);
    const after = rig.samples.filter((s) => s.t >= liveAt);
    expect(after.length).toBeGreaterThan(3);
    expect(after.every((s) => s.kind === "live" && s.showLive)).toBe(true);
  });

  // Spec: State.QuietDot, Honesty: the first connection on a quiet vault is Live at once and stays Live (LiveWire step, check 8 Honesty.LiveState)
  test("DS4 first start on a quiet vault: Live at once, and Live while heartbeats arrive", async () => {
    const s1 = opening();
    server.handler = (r) => (nth(r) === 0 ? s1 : stream());
    const rig = build();
    await until(() => server.requests.length === 1, 3000, "the request");
    const askedAt = performance.now();
    await until(() => rig.m.state().kind === "live", 300, "Live at the opening line");
    for (let i = 1; i <= 8; i++) later(i * 100, () => s1.heartbeat());
    const liveAt = performance.now();
    await wait(850);
    const after = rig.samples.filter((s) => s.t >= liveAt);
    expect(after.length).toBeGreaterThan(10);
    expect(after.every((s) => s.kind === "live" && s.showLive)).toBe(true);
    expect(liveAt - askedAt).toBeLessThan(300);
  });

  // Spec: State.QuietDot, Honesty: the word Live needs a confirmation within the window at every sampled moment (LiveWire step, check 8 Honesty.LiveState)
  test("DS5 the word: showLive is true only within the window of a confirmation, at every sample", async () => {
    const s1 = opening();
    server.handler = (r) => (nth(r) === 0 ? s1 : opening());
    const rig = build();
    await until(() => rig.m.state().kind === "live", 3000, "the first live");
    s1.heartbeat();
    await until(() => rig.m.state().kind === "offline", 4000, "offline");
    const live = rig.samples.filter((s) => s.showLive);
    const notLive = rig.samples.filter((s) => !s.showLive);
    // Not vacuous: the word was shown, and then it was not.
    expect(live.length).toBeGreaterThan(0);
    expect(notLive.length).toBeGreaterThan(0);
    for (const s of live) {
      expect(s.lastConfirmedAt).not.toBeNull();
      expect(s.at - (s.lastConfirmedAt as number)).toBeLessThanOrEqual(WINDOW_MS);
    }
  });
});
