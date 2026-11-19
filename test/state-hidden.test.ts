import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createConfirmationClock } from "../src/confirm.js";
import type { ConfirmationClock } from "../src/confirm.js";
import { createLiveSession } from "../src/session.js";
import type { LiveSession, SessionState, TransportLike } from "../src/session.js";
import { computeDot, createDotMachine, toLiveStatusInfo } from "../src/state.js";
import type { DotInputs, DotKind, DotLink, DotMachine, DotState, TransportStateLike } from "../src/state.js";

// The hidden tab is never "stopped": the session closes its own transport on purpose, and that routine stop must not
// speak for the dot (batch L13b, fix 1).

const T0 = 1_000_000;

/** A full input set from a patch; a recent confirmation is the default so a live transport reads as live. */
function inp(patch: Partial<DotInputs> = {}): DotInputs {
  return {
    transport: null, transportAt: null, session: null, paused: false, waiting: 0,
    lastConfirmedAt: T0, screenConfirmedAt: null, troubleSince: null, startedAt: T0, now: T0 + 1000, ...patch,
  };
}
const step = (patch: Partial<DotInputs> = {}): DotState => computeDot(inp(patch));

const BY_APP: TransportStateLike = { state: "stopped", cause: "stopped_by_app" };
const LIVE: TransportStateLike = { state: "live", mode: "stream" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A machine plus a log of every emission, and the plain status each emission maps to. */
function machineRig(): { m: DotMachine; clock: ConfirmationClock; emissions: DotState[] } {
  const clock = createConfirmationClock();
  const emissions: DotState[] = [];
  const m = createDotMachine({ clock, onChange: (s) => emissions.push(s) });
  return { m, clock, emissions };
}
const kindsOf = (es: DotState[]): DotKind[] => es.map((e) => e.kind);
const neverStopped = (es: DotState[]): void => {
  expect(kindsOf(es)).not.toContain("stopped");
  for (const e of es) expect(toLiveStatusInfo(e).status).not.toBe("stopped");
};

describe("a hidden tab is never stopped: the truth table", () => {
  // Spec: State.QuietDot, Honesty: a hidden tab is never stopped (LiveWire step, check 8 Honesty.LiveState)
  test("HD1 each row of the table gives the stated kind, cause and link", () => {
    const rows: Array<{ name: string; session: SessionState | null; transport: TransportStateLike | null; kind: DotKind; link?: DotLink; cause?: string | null }> = [
      { name: "1 hidden_closed + routine stop", session: "hidden_closed", transport: BY_APP, kind: "hidden", link: "none", cause: "hidden" },
      { name: "2 hidden_closed + no transport", session: "hidden_closed", transport: null, kind: "hidden", link: "none" },
      { name: "3 hidden_pending + live", session: "hidden_pending", transport: LIVE, kind: "hidden", link: "ok" },
      { name: "4 hidden_pending + routine stop", session: "hidden_pending", transport: BY_APP, kind: "hidden" },
      { name: "5 reopening + routine stop", session: "reopening", transport: BY_APP, kind: "connecting" },
      { name: "6 hidden_closed + revoked", session: "hidden_closed", transport: { state: "stopped", cause: "revoked" }, kind: "stopped", cause: "access_removed" },
      { name: "7 hidden_pending + refused", session: "hidden_pending", transport: { state: "stopped", cause: "refused" }, kind: "stopped", cause: "no_access" },
      { name: "8 open + routine stop", session: "open", transport: BY_APP, kind: "stopped", cause: "stopped_by_app" },
      { name: "9 no session + routine stop", session: null, transport: BY_APP, kind: "stopped", cause: "stopped_by_app" },
      { name: "11 terminal + routine stop", session: "terminal", transport: BY_APP, kind: "stopped", cause: "unknown" },
    ];
    for (const r of rows) {
      const d = step({ session: r.session, transport: r.transport, transportAt: T0 });
      expect(d.kind, r.name).toBe(r.kind);
      if (r.link !== undefined) expect(d.link, r.name).toBe(r.link);
      if (r.cause !== undefined) expect(d.cause, r.name).toBe(r.cause);
      expect(d.showLive, r.name).toBe(false);
    }
    // Row 3 also keeps the recent confirmation honest: the link is ok because the transport is live and heard recently.
    expect(step({ session: "hidden_pending", transport: LIVE }).asOf).toBe(T0);
    // Row 10: a stopped session is stopped whatever the transport says.
    const any: Array<TransportStateLike | null> = [null, LIVE, BY_APP, { state: "stopped", cause: "revoked" }, { state: "reconnecting", cause: "cut" }, { state: "polling", reason: "capacity" }];
    for (const t of any) {
      const d = step({ session: "stopped", transport: t });
      expect(d.kind).toBe("stopped");
      expect(d.link).toBe("none");
      expect(d.showLive).toBe(false);
    }
  });

  // Spec: State.QuietDot, Honesty: a transport with a missing cause is the app's own stop (LiveWire step, check 8 Honesty.LiveState)
  test("HD1b a stopped transport with no cause counts as the routine stop", () => {
    expect(step({ session: "hidden_closed", transport: { state: "stopped" } }).kind).toBe("hidden");
    expect(step({ session: "reopening", transport: { state: "stopped" } }).kind).toBe("connecting");
    expect(step({ session: "open", transport: { state: "stopped" } })).toMatchObject({ kind: "stopped", cause: "stopped_by_app" });
  });

  // Spec: State.QuietDot, Honesty: every real cause still wins over hidden and over reopening (LiveWire step, check 8 Honesty.LiveState)
  test("HD1c every real stop cause wins in every hidden or reopening session", () => {
    const table: Array<[string, string]> = [
      ["revoked", "access_removed"], ["refused", "no_access"], ["unauthorized", "signed_out"], ["bad_request", "rejected"],
      ["resync_failed", "could_not_load"], ["something_new", "unknown"],
    ];
    for (const session of ["hidden_pending", "hidden_closed", "reopening"] as const) {
      for (const [word, cause] of table) {
        expect(step({ session, transport: { state: "stopped", cause: word } }), `${session} ${word}`).toMatchObject({ kind: "stopped", cause, link: "none" });
      }
    }
  });
});

describe("a hidden tab is never stopped: the machine", () => {
  // Spec: State.QuietDot, Honesty: the stop report comes before the session reaches hidden_closed, as in the real session (LiveWire step, check 8 Honesty.LiveState)
  test("HD2 sequence A: the stop report first, then hidden_closed", () => {
    const { m, clock, emissions } = machineRig();
    m.feedSession("open");
    m.feedTransport(LIVE);
    clock.confirm();
    expect(m.state()).toMatchObject({ kind: "live", showLive: true });
    m.feedSession("hidden_pending");
    expect(m.state()).toMatchObject({ kind: "hidden", link: "ok" });
    m.feedTransport(BY_APP);
    expect(m.state().kind).toBe("hidden");
    m.feedSession("hidden_closed");
    expect(m.state()).toMatchObject({ kind: "hidden", link: "none", cause: "hidden" });
    neverStopped(emissions);
    expect(kindsOf(emissions).at(-1)).toBe("hidden");
    // Time passing while hidden changes nothing: there is no connection to be silent.
    vi.advanceTimersByTime(300_000);
    expect(m.state()).toMatchObject({ kind: "hidden", link: "none" });
    m.close();
  });

  // Spec: State.QuietDot, Honesty: the same, with the reports in the other order (LiveWire step, check 8 Honesty.LiveState)
  test("HD3 sequence B: hidden_closed first, the stop report after", () => {
    const { m, clock, emissions } = machineRig();
    m.feedSession("open");
    m.feedTransport(LIVE);
    clock.confirm();
    m.feedSession("hidden_pending");
    m.feedSession("hidden_closed");
    m.feedTransport(BY_APP);
    expect(m.state()).toMatchObject({ kind: "hidden", link: "none", cause: "hidden" });
    neverStopped(emissions);
    expect(kindsOf(emissions).at(-1)).toBe("hidden");
    m.close();
  });

  // Spec: State.QuietDot, Honesty: a throttled hidden tab shown again never passes through hidden_closed and never reads stopped (LiveWire step, check 8 Honesty.LiveState)
  test("HD4 the throttled path: hidden_pending, stop report, reopening, open", () => {
    const { m, clock, emissions } = machineRig();
    m.feedSession("open");
    m.feedTransport(LIVE);
    clock.confirm();
    m.feedSession("hidden_pending");
    m.feedTransport(BY_APP);
    expect(m.state().kind).toBe("hidden");
    m.feedSession("reopening");
    expect(m.state().kind).toBe("connecting");
    expect(m.state().showLive).toBe(false);
    m.feedTransport({ state: "connecting" });
    expect(m.state().kind).toBe("connecting");
    m.feedSession("open");
    expect(m.state().kind).toBe("connecting");
    m.feedTransport(LIVE);
    clock.confirm();
    expect(m.state()).toMatchObject({ kind: "live", showLive: true });
    neverStopped(emissions);
    m.close();
  });

  // Spec: State.QuietDot, Honesty: an old transport's report never speaks for the new one, whatever it said (LiveWire step, check 8 Honesty.LiveState)
  test("HD4b reopening drops the old report: neither a stale stop nor a stale live speaks for the new transport", () => {
    const stale = machineRig();
    stale.m.feedSession("open");
    stale.m.feedTransport(LIVE);
    stale.clock.confirm();
    stale.m.feedSession("hidden_pending");
    stale.m.feedTransport(BY_APP);
    stale.m.feedSession("reopening");
    // The new transport has not reported yet and the session is already open: the old stop must not read as stopped.
    stale.m.feedSession("open");
    expect(stale.m.state().kind).toBe("connecting");
    neverStopped(stale.emissions);
    stale.m.close();

    const old = machineRig();
    old.m.feedSession("open");
    old.m.feedTransport(LIVE);
    old.clock.confirm();
    old.m.feedSession("hidden_pending");
    old.m.feedSession("reopening");
    // The old transport said "live" and was confirmed a moment ago, but it is gone: nothing is connected yet.
    expect(old.m.state()).toMatchObject({ kind: "connecting", showLive: false });
    old.m.close();
  });

  // Spec: State.QuietDot, Honesty: a quick return keeps the still-running transport's report, so the dot is not stuck on connecting (LiveWire step, check 8 Honesty.LiveState)
  test("HD5 the quick return: hidden_pending back to open keeps the report", () => {
    const { m, clock, emissions } = machineRig();
    m.feedSession("open");
    m.feedTransport(LIVE);
    clock.confirm();
    vi.advanceTimersByTime(5000);
    m.feedSession("hidden_pending");
    expect(m.state().kind).toBe("hidden");
    vi.advanceTimersByTime(5000);
    m.feedSession("open");
    expect(m.state()).toMatchObject({ kind: "live", showLive: true, link: "ok" });
    neverStopped(emissions);
    m.close();
  });

  // Spec: State.QuietDot, Honesty: the app's status type never says stopped for a hidden tab (LiveWire step, check 8 Honesty.LiveState)
  test("HD6 the status mapping: a hidden dot with no link is offline with cause hidden", () => {
    for (const order of ["A", "B"] as const) {
      const { m, clock, emissions } = machineRig();
      m.feedSession("open");
      m.feedTransport(LIVE);
      clock.confirm();
      m.feedSession("hidden_pending");
      if (order === "A") m.feedTransport(BY_APP);
      m.feedSession("hidden_closed");
      if (order === "B") m.feedTransport(BY_APP);
      neverStopped(emissions);
      const info = toLiveStatusInfo(m.state());
      expect(info.status).toBe("offline");
      expect(info.cause).toBe("hidden");
      m.close();
    }
  });

  // Spec: State.QuietDot, Honesty: stopped only for a stopped session, a real cause, or the app's own stop outside hidden (LiveWire step, check 8 Honesty.LiveState)
  test("HD7 property: over 3000 seeded random pairs, stopped appears only where the rule allows", () => {
    let seed = 20261119;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const sessions: Array<SessionState | null> = [null, "idle", "open", "hidden_pending", "hidden_closed", "reopening", "terminal", "stopped"];
    const transports: Array<TransportStateLike | null> = [
      null, { state: "connecting" }, LIVE, { state: "polling", reason: "capacity" }, { state: "reconnecting", cause: "cut", retryInMs: 3000 },
      { state: "reconnecting", cause: "max_age", quiet: true }, { state: "resyncing", cause: "gap" }, { state: "stopped" },
      BY_APP, { state: "stopped", cause: "revoked" }, { state: "stopped", cause: "refused" }, { state: "stopped", cause: "unauthorized" },
      { state: "stopped", cause: "bad_request" }, { state: "stopped", cause: "resync_failed" }, { state: "stopped", cause: "something_new" },
    ];
    let stoppedSeen = 0;
    let hiddenSeen = 0;
    for (let i = 0; i < 3000; i++) {
      const session = pick(sessions);
      const transport = pick(transports);
      const d = step({ session, transport, transportAt: T0, paused: rnd() < 0.2, waiting: pick([0, 0, 3]), now: T0 + Math.floor(rnd() * 90_000) });
      const tStopped = transport?.state === "stopped";
      const realCause = tStopped && typeof transport?.cause === "string" && transport.cause !== "stopped_by_app";
      const routineStop = tStopped && !realCause;
      const allowed = session === "stopped" || session === "terminal" || realCause
        || (routineStop && (session === null || session === "idle" || session === "open"));
      if (d.kind === "stopped") {
        stoppedSeen++;
        expect(allowed, `${session} ${JSON.stringify(transport)} gave stopped`).toBe(true);
      } else {
        // And the other way round: every case the rule names as stopped is stopped.
        expect(allowed, `${session} ${JSON.stringify(transport)} gave ${d.kind}`).toBe(false);
      }
      if (d.kind === "hidden") hiddenSeen++;
    }
    expect(stoppedSeen).toBeGreaterThan(100);
    expect(hiddenSeen).toBeGreaterThan(100);
  });
});

// --- The real session ---

/** The small fake from the session tests, extended so that it reports its own stop to a callback, as the real transport does. */
class FakeTransport implements TransportLike {
  st: { state: string; cause?: string } = { state: "open" };
  stops = 0;
  private release: () => void = () => {};
  constructor(private readonly report: (s: TransportStateLike) => void, private readonly rig: SessionRig) {}
  start(): void {
    this.st = { state: "live" };
    this.report({ state: "connecting" });
  }
  stop(): Promise<void> {
    this.stops++;
    // The real transport reports `stopped` only once its runner has ended; the session's afterStop runs after that.
    this.st = { state: "stopped", cause: "stopped_by_app" };
    if (!this.rig.silentStop) this.report({ state: "stopped", cause: "stopped_by_app" });
    if (!this.rig.holdStops) return Promise.resolve();
    return new Promise<void>((resolve) => { this.release = resolve; });
  }
  state(): { state: string; cause?: string } { return this.st; }
  settleStop(): void { this.release(); }
  /** The transport ended for a reason of its own (for example the server revoked access). */
  endFor(cause: string): void {
    this.st = { state: "stopped", cause };
    this.report({ state: "stopped", cause });
  }
}

interface SessionRig {
  session: LiveSession;
  m: DotMachine;
  clock: ConfirmationClock;
  emissions: DotState[];
  created: FakeTransport[];
  holdStops: boolean;
  /** True: the fake ends without telling the dot machine, so the session's own state is the only witness. */
  silentStop: boolean;
}

/** A real session and a real dot machine, joined as the client joins them. */
function sessionRig(): SessionRig {
  const clock = createConfirmationClock();
  const emissions: DotState[] = [];
  const m = createDotMachine({ clock, onChange: (s) => emissions.push(s) });
  const rig = { m, clock, emissions, created: [] as FakeTransport[], holdStops: false, silentStop: false } as SessionRig;
  rig.session = createLiveSession({
    createTransport: () => {
      const tr = new FakeTransport((s) => m.feedTransport(s), rig);
      rig.created.push(tr);
      return tr;
    },
    hiddenCloseMs: 100,
    onState: (s) => m.feedSession(s),
  });
  return rig;
}

/** Brings the first transport to live and confirmed, as a connected page would be. */
function goLive(rig: SessionRig): void {
  rig.session.start();
  rig.m.feedTransport(LIVE);
  rig.clock.confirm();
}

describe("a hidden tab is never stopped: the real session", () => {
  // Spec: State.QuietDot, Honesty: a real session closing its hidden transport never shows stopped (LiveWire step, check 8 Honesty.LiveState)
  test("HS1 hidden past hiddenCloseMs reads hidden, and showing the page goes connecting then live", async () => {
    const rig = sessionRig();
    goLive(rig);
    expect(rig.m.state()).toMatchObject({ kind: "live", showLive: true });
    rig.session.setVisible(false);
    expect(rig.m.state().kind).toBe("hidden");
    await vi.advanceTimersByTimeAsync(100);
    expect(rig.created[0]?.stops).toBe(1);
    expect(rig.session.state()).toBe("hidden_closed");
    expect(rig.m.state()).toMatchObject({ kind: "hidden", link: "none", cause: "hidden" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rig.m.state().kind).toBe("hidden");
    neverStopped(rig.emissions);
    rig.session.setVisible(true);
    expect(rig.created.length).toBe(2);
    expect(rig.m.state().kind).toBe("connecting");
    rig.m.feedTransport(LIVE);
    rig.clock.confirm();
    expect(rig.m.state()).toMatchObject({ kind: "live", showLive: true });
    neverStopped(rig.emissions);
    await rig.session.stop();
    rig.m.close();
  });

  // Spec: State.QuietDot, Honesty: the page returning while the close settles (hidden_pending to reopening) never shows stopped (LiveWire step, check 8 Honesty.LiveState)
  test("HS1b the page returns during the stop: hidden_pending to reopening, never stopped", async () => {
    const rig = sessionRig();
    rig.holdStops = true;
    goLive(rig);
    rig.session.setVisible(false);
    await vi.advanceTimersByTimeAsync(100);
    // The old transport has reported its stop but the close has not settled: the session is still hidden_pending.
    expect(rig.created[0]?.stops).toBe(1);
    expect(rig.session.state()).toBe("hidden_pending");
    expect(rig.m.state().kind).toBe("hidden");
    rig.session.setVisible(true);
    expect(rig.session.state()).toBe("reopening");
    expect(rig.m.state().kind).toBe("connecting");
    rig.created[0]?.settleStop();
    await vi.advanceTimersByTimeAsync(0);
    expect(rig.created.length).toBe(2);
    expect(rig.session.state()).toBe("open");
    expect(rig.m.state().kind).toBe("connecting");
    rig.m.feedTransport(LIVE);
    rig.clock.confirm();
    expect(rig.m.state()).toMatchObject({ kind: "live", showLive: true });
    neverStopped(rig.emissions);
    rig.holdStops = false;
    await rig.session.stop();
    rig.m.close();
  });

  // Spec: State.QuietDot, Honesty: a real stop is still a stop, and a real revoke is not hidden behind "hidden" (LiveWire step, check 8 Honesty.LiveState)
  test("HS2 session.stop() is stopped_by_app; a revoke while hidden is access_removed", async () => {
    const a = sessionRig();
    goLive(a);
    await a.session.stop();
    expect(a.session.state()).toBe("stopped");
    expect(a.m.state()).toMatchObject({ kind: "stopped", cause: "stopped_by_app", link: "none" });
    a.m.close();

    // The session's own word is enough: a stopped session is stopped even when the transport never said so.
    const c = sessionRig();
    c.silentStop = true;
    goLive(c);
    await c.session.stop();
    expect(c.session.state()).toBe("stopped");
    expect(c.m.state()).toMatchObject({ kind: "stopped", cause: "stopped_by_app", link: "none" });
    c.m.close();

    const b = sessionRig();
    goLive(b);
    b.session.setVisible(false);
    expect(b.m.state().kind).toBe("hidden");
    b.created[0]?.endFor("revoked");
    expect(b.m.state()).toMatchObject({ kind: "stopped", cause: "access_removed" });
    // When the close timer fires the session sees a transport that ended for a real cause and goes terminal; it stays stopped.
    await vi.advanceTimersByTimeAsync(100);
    expect(b.session.state()).toBe("terminal");
    expect(b.m.state()).toMatchObject({ kind: "stopped", cause: "access_removed" });
    expect(toLiveStatusInfo(b.m.state())).toMatchObject({ status: "stopped", cause: "access_removed" });
    await b.session.stop();
    b.m.close();
  });

  // Spec: State.QuietDot, Honesty: a hidden reopen after the app's own stop starts clean, so its first connection confirms (LiveWire step, check 8 Honesty.LiveState)
  test("HS3 a reopen after a hidden stop gets a new transport that is not stopped", async () => {
    const rig = sessionRig();
    goLive(rig);
    rig.session.setVisible(false);
    await vi.advanceTimersByTimeAsync(100);
    rig.session.setVisible(true);
    const second = rig.created[1];
    expect(second?.state().state).toBe("live");
    expect(rig.m.state().kind).not.toBe("stopped");
    await rig.session.stop();
    rig.m.close();
  });
});
