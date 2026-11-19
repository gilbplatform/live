import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLiveSession, DEFAULT_HIDDEN_CLOSE_MS, watchVisibility } from "../src/session.js";
import type { LiveSession, SessionState, TransportLike, VisibilityPage } from "../src/session.js";
import { at } from "./helpers/liveKit.js";

class FakeTransport implements TransportLike {
  started = 0;
  stops = 0;
  st: { state: string; cause?: string } = { state: "open" };
  settled = false;
  private release: () => void = () => {};
  constructor(private readonly rig: Rig, readonly resumeCursor: string | null) {}
  start(): void { this.started++; }
  stop(): Promise<void> {
    this.stops++;
    const done = (): void => { this.st = { state: "stopped", cause: "stopped_by_app" }; this.settled = true; this.rig.live--; };
    if (!this.rig.holdStops) { done(); return Promise.resolve(); }
    return new Promise<void>((resolve) => { this.release = () => { done(); resolve(); }; });
  }
  state(): { state: string; cause?: string } { return this.st; }
  /** Lets a held `stop()` settle. */
  settleStop(): void { this.release(); }
}
class Rig {
  created: FakeTransport[] = [];
  live = 0;
  maxLive = 0;
  holdStops = false;
  cursor: string | null = "cursor-0";
  now = 1_000_000;
  states: SessionState[] = [];
  create = (ctx: { resumeCursor: string | null }): TransportLike => {
    const tr = new FakeTransport(this, ctx.resumeCursor);
    this.created.push(tr);
    this.live++;
    this.maxLive = Math.max(this.maxLive, this.live);
    return tr;
  };
  /** Moves both the fake timers and the injected clock. */
  async advance(ms: number): Promise<void> { this.now += ms; await vi.advanceTimersByTimeAsync(ms); }
}

let rig = new Rig();
const sessions: LiveSession[] = [];
function mk(extra: Partial<Parameters<typeof createLiveSession>[0]> = {}): LiveSession {
  rig = new Rig();
  return mkWith(rig, extra);
}
function mkWith(r: Rig, extra: Partial<Parameters<typeof createLiveSession>[0]> = {}): LiveSession {
  const s = createLiveSession({
    createTransport: r.create,
    getResumeCursor: () => r.cursor,
    now: () => r.now,
    onState: (st) => r.states.push(st),
    ...extra,
  });
  sessions.push(s);
  return s;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  for (const s of sessions.splice(0)) {
    rig.holdStops = false;
    for (const tr of rig.created) tr.settleStop();
    await s.stop();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("live session", () => {
  test("constants", () => { expect(DEFAULT_HIDDEN_CLOSE_MS).toBe(60_000); });

  // Spec: Kit.Client, Session: one transport is made and started, from the store's cursor (LiveWire step, check 9 Resume.Exact)
  test("SE1 start creates exactly one transport with the resume cursor", () => {
    const s = mk();
    expect(s.state()).toBe("idle");
    s.start();
    s.start();
    expect(rig.created).toHaveLength(1);
    expect(at(rig.created, 0).resumeCursor).toBe("cursor-0");
    expect(at(rig.created, 0).started).toBe(1);
    expect(s.transport()).toBe(at(rig.created, 0));
    expect(s.state()).toBe("open");
    const bare = createLiveSession({ createTransport: rig.create });
    sessions.push(bare);
    bare.start();
    expect(at(rig.created, 1).resumeCursor).toBeNull();
  });

  // Spec: Kit.Client, Session: a hidden tab closes its connection after 60 s (check 12 Smoothness.Motion, Resource.Bounded)
  test("SE2 hidden for 59 s keeps the transport; hidden for 60 s stops it once and releases it", async () => {
    const s = mk();
    s.start();
    s.setVisible(false);
    expect(s.state()).toBe("hidden_pending");
    await rig.advance(59_000);
    s.setVisible(true);
    expect(at(rig.created, 0).stops).toBe(0);
    expect(s.state()).toBe("open");
    expect(rig.created).toHaveLength(1);

    s.setVisible(false);
    await rig.advance(60_000);
    expect(at(rig.created, 0).stops).toBe(1);
    expect(s.transport()).toBeNull();
    expect(s.state()).toBe("hidden_closed");
    await rig.advance(600_000);
    expect(at(rig.created, 0).stops).toBe(1);
  });

  // Spec: Kit.Client, Session: the new transport starts only after the old one has finished, from the cursor of that moment (check 9 Resume.Exact)
  test("SE3 a show after the close makes a new transport only after the old stop settled, with the current cursor", async () => {
    const s = mk();
    s.start();
    rig.holdStops = true;
    s.setVisible(false);
    await rig.advance(60_000);
    expect(at(rig.created, 0).stops).toBe(1);
    expect(at(rig.created, 0).settled).toBe(false);
    rig.cursor = "cursor-1";
    s.setVisible(true);
    await rig.advance(1000);
    // The old stop has not settled: no second transport yet.
    expect(rig.created).toHaveLength(1);
    expect(s.state()).toBe("reopening");
    rig.cursor = "cursor-2";
    at(rig.created, 0).settleStop();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.created).toHaveLength(2);
    expect(at(rig.created, 1).resumeCursor).toBe("cursor-2");
    expect(at(rig.created, 1).started).toBe(1);
    expect(s.state()).toBe("open");
    expect(s.transport()).toBe(at(rig.created, 1));

    // And when the stop had settled long before, the show makes the new one at once.
    rig.holdStops = false;
    s.setVisible(false);
    await rig.advance(60_000);
    expect(s.state()).toBe("hidden_closed");
    rig.cursor = "cursor-3";
    s.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.created).toHaveLength(3);
    expect(at(rig.created, 2).resumeCursor).toBe("cursor-3");
    expect(rig.maxLive).toBe(1);
  });

  // Spec: Kit.Client, Session: keep-live never closes (wall board)
  test("SE4 keepLive never closes; setKeepLive(true) cancels a timer; setKeepLive(false) starts it from now", async () => {
    const s = mk({ keepLive: true });
    s.start();
    s.setVisible(false);
    expect(s.state()).toBe("open");
    await rig.advance(10 * 60_000);
    expect(at(rig.created, 0).stops).toBe(0);
    s.setVisible(true);
    expect(rig.created).toHaveLength(1);

    const s2 = mk();
    s2.start();
    s2.setVisible(false);
    await rig.advance(30_000);
    s2.setKeepLive(true);
    expect(s2.state()).toBe("open");
    await rig.advance(120_000);
    expect(at(rig.created, 0).stops).toBe(0);

    // Turning it off while hidden starts a fresh 60 s, counted from now.
    s2.setKeepLive(false);
    expect(s2.state()).toBe("hidden_pending");
    await rig.advance(59_000);
    expect(at(rig.created, 0).stops).toBe(0);
    await rig.advance(1000);
    expect(at(rig.created, 0).stops).toBe(1);
    expect(s2.state()).toBe("hidden_closed");
  });

  test("SE4b keepLive turned on while the connection is closed brings it back", async () => {
    const s = mk();
    s.start();
    s.setVisible(false);
    await rig.advance(60_000);
    expect(s.state()).toBe("hidden_closed");
    s.setKeepLive(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.created).toHaveLength(2);
    expect(s.state()).toBe("open");
  });

  // Spec: Kit.Client, Session: flapping does not open and close connections (check Resource.Bounded)
  test("SE5 hide and show ten times under 60 s makes no second transport", async () => {
    const s = mk();
    s.start();
    for (let i = 0; i < 10; i++) {
      s.setVisible(false);
      await rig.advance(5000);
      s.setVisible(true);
    }
    expect(rig.created).toHaveLength(1);
    expect(at(rig.created, 0).stops).toBe(0);
    expect(s.state()).toBe("open");
    await rig.advance(600_000);
    expect(at(rig.created, 0).stops).toBe(0);
  });

  // Spec: Kit.Client, Session: never two transports at once (check 7 Delivery.Order)
  test("SE6 a show racing the timer's stop is serialised: never two transports alive", async () => {
    const s = mk();
    s.start();
    rig.holdStops = true;
    for (let round = 0; round < 3; round++) {
      s.setVisible(false);
      await rig.advance(60_000);
      s.setVisible(true);
      s.setVisible(false);
      s.setVisible(true);
      await rig.advance(500);
      expect(rig.live).toBeLessThanOrEqual(1);
      const last = rig.created[rig.created.length - 1] as FakeTransport;
      last.settleStop();
      await vi.advanceTimersByTimeAsync(0);
      expect(rig.live).toBeLessThanOrEqual(1);
    }
    expect(rig.maxLive).toBe(1);
    expect(rig.created).toHaveLength(4);
    expect(s.state()).toBe("open");
  });

  // Spec: Kit.Client, Session: a throttled timer does not leave a dead connection trusted (check 9 Resume.Exact)
  test("SE7 a throttled timer: after a long hidden time the show replaces the transport", async () => {
    const s = mk();
    s.start();
    s.setVisible(false);
    // The browser slept: the clock moved 90 s but no timer fired.
    rig.now += 90_000;
    s.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(at(rig.created, 0).stops).toBe(1);
    expect(rig.created).toHaveLength(2);
    expect(s.state()).toBe("open");
    expect(s.transport()).toBe(at(rig.created, 1));
    // The old timer must not close the new transport later.
    await rig.advance(120_000);
    expect(at(rig.created, 1).stops).toBe(0);
  });

  // Spec: Kit.Client, Session: a transport that ended for good is not reopened (check 9 Resume.Exact)
  test("SE8 a terminal transport makes the session terminal and a show does not reopen it", async () => {
    const s = mk();
    s.start();
    at(rig.created, 0).st = { state: "stopped", cause: "revoked" };
    s.setVisible(false);
    await rig.advance(60_000);
    expect(s.state()).toBe("terminal");
    s.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.created).toHaveLength(1);
    expect(s.state()).toBe("terminal");

    // The same when it is found at the show.
    const s2 = mk();
    s2.start();
    s2.setVisible(false);
    at(rig.created, 0).st = { state: "stopped", cause: "revoked" };
    s2.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.created).toHaveLength(1);
    expect(s2.state()).toBe("terminal");

    // A stop by the app is not final: the show makes a new one.
    const s3 = mk();
    s3.start();
    s3.setVisible(false);
    at(rig.created, 0).st = { state: "stopped", cause: "stopped_by_app" };
    s3.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.created).toHaveLength(2);
    expect(s3.state()).toBe("open");
    const s4 = mk();
    s4.start();
    s4.setVisible(false);
    at(rig.created, 0).st = { state: "stopped", cause: "stopped_by_app" };
    await rig.advance(60_000);
    expect(s4.state()).toBe("hidden_closed");
    s4.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.created).toHaveLength(2);
  });

  // Spec: Kit.Client, Session: stopping the session is final (check Resource.Bounded)
  test("SE9 stop is terminal and idempotent; nothing is recreated afterwards", async () => {
    const s = mk();
    s.start();
    s.setVisible(false);
    await Promise.all([s.stop(), s.stop()]);
    expect(at(rig.created, 0).stops).toBe(1);
    expect(s.state()).toBe("stopped");
    expect(s.transport()).toBeNull();
    s.setVisible(true);
    s.setVisible(false);
    await rig.advance(120_000);
    s.setVisible(true);
    s.setKeepLive(true);
    s.start();
    await s.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.created).toHaveLength(1);
    expect(s.state()).toBe("stopped");
    expect(vi.getTimerCount()).toBe(0);

    // A stop while a close is under way ends there; the show that was waiting does not recreate.
    const s2 = mk();
    s2.start();
    rig.holdStops = true;
    s2.setVisible(false);
    await rig.advance(60_000);
    s2.setVisible(true);
    const stopping = s2.stop();
    at(rig.created, 0).settleStop();
    await stopping;
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.created).toHaveLength(1);
    expect(s2.state()).toBe("stopped");
  });

  // Spec: Kit.Client, Session: the app can follow the states in order
  test("SE10 onState sees the states in order; a throwing onState is isolated", async () => {
    const seen: SessionState[] = [];
    const s = mk({ onState: (st) => { seen.push(st); throw new Error("ui broke"); } });
    s.start();
    s.setVisible(false);
    await rig.advance(60_000);
    s.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    await s.stop();
    expect(seen).toEqual(["open", "hidden_pending", "hidden_closed", "reopening", "open", "stopped"]);
    expect(rig.created).toHaveLength(2);
  });

  test("SE11 onShow runs on a show that finds the transport open and after a reopen has started", async () => {
    const calls: number[] = [];
    const s = mk({ onShow: () => calls.push(rig.created.length) });
    s.start();
    s.setVisible(false);
    await rig.advance(5000);
    s.setVisible(true);
    expect(calls).toEqual([1]);
    s.setVisible(false);
    await rig.advance(60_000);
    s.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    // The new transport existed when onShow ran.
    expect(calls).toEqual([1, 2]);
  });

  // Spec: Kit.Client, Session: the app gives the page object; the kit names no global
  test("SE12 watchVisibility starts from the current state, follows each event, and detaches", () => {
    const setVisible = vi.fn();
    const session = { setVisible } as unknown as LiveSession;
    const fns = new Set<() => void>();
    const page: VisibilityPage & { visibilityState: string } = {
      visibilityState: "hidden",
      addEventListener: (_type, fn) => { fns.add(fn); },
      removeEventListener: (_type, fn) => { fns.delete(fn); },
    };
    const detach = watchVisibility(session, page);
    expect(setVisible).toHaveBeenCalledTimes(1);
    expect(setVisible).toHaveBeenLastCalledWith(false);
    expect(fns.size).toBe(1);
    page.visibilityState = "visible";
    for (const f of fns) f();
    expect(setVisible).toHaveBeenLastCalledWith(true);
    page.visibilityState = "prerender";
    for (const f of fns) f();
    expect(setVisible).toHaveBeenLastCalledWith(true);
    page.visibilityState = "hidden";
    for (const f of fns) f();
    expect(setVisible).toHaveBeenLastCalledWith(false);
    expect(setVisible).toHaveBeenCalledTimes(4);
    detach();
    expect(fns.size).toBe(0);
    page.visibilityState = "visible";
    for (const f of fns) f();
    expect(setVisible).toHaveBeenCalledTimes(4);
  });
});
