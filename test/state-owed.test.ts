import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createConfirmationClock } from "../src/confirm.js";
import type { SessionState } from "../src/session.js";
import {
  computeDot, createDotMachine, toLiveStatusInfo,
  DEFAULT_HEARTBEAT_WINDOW_MS, DEFAULT_POLL_WINDOW_MS,
} from "../src/state.js";
import type { DotInputs, DotKind, DotState, TransportStateLike } from "../src/state.js";

// The dot never says Live while a record is owed (batch L14c).

const T0 = 1_000_000;
const HB = DEFAULT_HEARTBEAT_WINDOW_MS;
const POLL = DEFAULT_POLL_WINDOW_MS;

function inp(patch: Partial<DotInputs> = {}): DotInputs {
  return {
    transport: null, transportAt: null, session: null, paused: false, waiting: 0,
    lastConfirmedAt: null, screenConfirmedAt: null, troubleSince: null, startedAt: T0, now: T0, ...patch,
  };
}
const step = (patch: Partial<DotInputs> = {}): DotState => computeDot(inp(patch));
const junk = (v: unknown): TransportStateLike => v as TransportStateLike;
const healthy = { transport: { state: "live", mode: "stream" } as TransportStateLike, lastConfirmedAt: T0 };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(T0); });
afterEach(() => { vi.useRealTimers(); });

describe("the dot with owed reads", () => {
  // Spec: State.QuietDot, Honesty: Live is not shown while a record is owed (LiveWire step, check 8 Honesty.LiveState)
  test("ST-O1 a healthy live link with owed 3 keeps the kind, loses Live, carries the count and the cause owed", () => {
    const d = step({ ...healthy, owed: 3 });
    expect(d.kind).toBe("live");
    expect(d.showLive).toBe(false);
    expect(d.owed).toBe(3);
    expect(d.cause).toBe("owed");
    expect(d.link).toBe("ok");
    const ok = step({ ...healthy, owed: 0 });
    expect(ok.kind).toBe("live");
    expect(ok.showLive).toBe(true);
    expect(ok.owed).toBe(0);
    expect(ok.cause).toBeNull();
    // Absent means none.
    const absent = step({ ...healthy });
    expect(absent.showLive).toBe(true);
    expect(absent.owed).toBe(0);
  });

  test("ST-O2 the same for polling; paused and hidden carry the count and never show Live", () => {
    const polling = step({ transport: { state: "polling", reason: "capacity" }, lastConfirmedAt: T0, owed: 2 });
    expect(polling.kind).toBe("polling");
    expect(polling.showLive).toBe(false);
    expect(polling.owed).toBe(2);
    expect(polling.cause).toBe("owed");
    const pollingOk = step({ transport: { state: "polling", reason: "capacity" }, lastConfirmedAt: T0, owed: 0 });
    expect(pollingOk.showLive).toBe(true);

    const paused = step({ ...healthy, paused: true, owed: 4 });
    expect(paused.kind).toBe("paused");
    expect(paused.owed).toBe(4);
    expect(paused.showLive).toBe(false);
    const hidden = step({ ...healthy, session: "hidden_pending", owed: 4 });
    expect(hidden.kind).toBe("hidden");
    expect(hidden.owed).toBe(4);
    expect(hidden.showLive).toBe(false);
    // A kind that was already not live keeps its own cause and still carries the count.
    const re = step({ transport: { state: "reconnecting", cause: "cut", retryInMs: 1000 }, transportAt: T0, lastConfirmedAt: T0, owed: 1 });
    expect(re.kind).toBe("reconnecting");
    expect(re.cause).toBe("cut");
    expect(re.owed).toBe(1);
  });

  test("ST-O2b bad owed values are treated as none", () => {
    for (const bad of [Number.NaN, -3, Infinity, undefined]) {
      const d = step({ ...healthy, owed: bad as number });
      expect(d.owed, String(bad)).toBe(0);
      expect(d.showLive, String(bad)).toBe(true);
    }
    expect(step({ ...healthy, owed: 2.7 }).owed).toBe(2);
  });

  // Spec: State.QuietDot, Honesty: the invariant over seeded random sequences, now with owed (check 8 Honesty.LiveState)
  test("ST-O3 over 3000 seeded random sequences Live needs a recent confirmation, nothing waiting, nothing owed, not paused, tab shown, session open", () => {
    let seed = 20261120;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const pick = <X,>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length)] as X;
    const transports: Array<TransportStateLike | null> = [
      null, { state: "connecting" }, { state: "live", mode: "stream" }, { state: "polling", reason: "capacity" },
      { state: "polling", reason: "no_stream" }, { state: "reconnecting", cause: "cut", retryInMs: 3000 },
      { state: "reconnecting", cause: "max_age", quiet: true }, { state: "resyncing", cause: "gap" },
      { state: "stopped", cause: "revoked" }, { state: "weird" }, junk({}),
    ];
    const sessions: Array<SessionState | null> = [null, "idle", "open", "hidden_pending", "hidden_closed", "reopening", "terminal", "stopped"];
    const seen = new Set<DotKind>();
    let liveCount = 0;
    let owedLive = 0;
    for (let seq = 0; seq < 3000; seq++) {
      let now = T0;
      for (let i = 0; i < 6; i++) {
        now += Math.floor(rnd() * 90_000);
        const transport = pick(transports);
        const session = pick(sessions);
        const paused = rnd() < 0.2;
        const waiting = pick([0, 0, 0, 1, 7]);
        const owed = pick([0, 0, 0, 1, 5]);
        const lastConfirmedAt = rnd() < 0.1 ? null : now - Math.floor(rnd() * 120_000) * (rnd() < 0.5 ? 1 : 0.1);
        const troubleSince = rnd() < 0.5 ? null : now - Math.floor(rnd() * 90_000);
        const d = step({ transport, session, paused, waiting, owed, lastConfirmedAt, troubleSince, now, transportAt: now - 100 });
        seen.add(d.kind);
        const span = transport?.state === "polling" ? POLL : HB;
        // The count is always carried, whatever the kind.
        expect(d.owed).toBe(owed);
        if (owed > 0) expect(d.showLive).toBe(false);
        if (d.showLive) {
          liveCount++;
          expect(["live", "polling"]).toContain(d.kind);
          expect(lastConfirmedAt).not.toBeNull();
          expect(now - (lastConfirmedAt as number)).toBeLessThanOrEqual(span);
          expect(waiting).toBe(0);
          expect(owed).toBe(0);
          expect(paused).toBe(false);
          expect(session === null || session === "open" || session === "idle").toBe(true);
          expect(d.link).toBe("ok");
        }
        // The reverse: a live kind with nothing waiting, nothing owed and a good session never loses the flag.
        const goodSession = session === null || session === "open" || session === "idle";
        if ((d.kind === "live" || d.kind === "polling") && waiting === 0 && owed === 0 && goodSession) expect(d.showLive).toBe(true);
        if ((d.kind === "live" || d.kind === "polling") && owed > 0) {
          owedLive++;
          expect(d.cause).toBe("owed");
        }
      }
    }
    // Not vacuous: Live was shown often, and live kinds with owed records were really reached.
    expect(liveCount).toBeGreaterThan(200);
    expect(owedLive).toBeGreaterThan(100);
    for (const k of ["connecting", "live", "polling", "reconnecting", "offline", "paused", "hidden", "stopped"] as const) expect(seen.has(k), k).toBe(true);
  });

  // Spec: State.QuietDot, Honesty: the machine reads the owed count at every evaluation and speaks when it changes (check 8 Honesty.LiveState)
  test("ST-O4 the machine emits when owed changes, not when it stays; it reads owed() at every evaluation", () => {
    let owedNow = 0;
    const reads = vi.fn(() => owedNow);
    const clock = createConfirmationClock();
    const events: DotState[] = [];
    const m = createDotMachine({ clock, owed: reads, onChange: (s) => events.push(s) });
    m.feedTransport({ state: "live", mode: "stream" });
    clock.confirm();
    expect(m.state().showLive).toBe(true);
    expect(m.state().owed).toBe(0);

    const before = events.length;
    owedNow = 2;
    const readsBefore = reads.mock.calls.length;
    m.refresh();
    expect(reads.mock.calls.length).toBeGreaterThan(readsBefore);
    expect(events.length).toBe(before + 1);
    expect(m.state().showLive).toBe(false);
    expect(m.state().owed).toBe(2);
    expect(m.state().kind).toBe("live");
    expect(m.state().cause).toBe("owed");

    // Unchanged: no new event.
    m.refresh();
    m.refresh();
    expect(events.length).toBe(before + 1);

    // A different count is news, even though Live stays off.
    owedNow = 3;
    m.refresh();
    expect(events.length).toBe(before + 2);
    expect(m.state().owed).toBe(3);

    owedNow = 0;
    m.refresh();
    expect(events.length).toBe(before + 3);
    expect(m.state().showLive).toBe(true);
    expect(m.state().owed).toBe(0);
    expect(m.state().cause).toBeNull();
    m.close();
  });

  // Spec: State.QuietDot, Honesty: the status word describes the link, not the data (check 8 Honesty.LiveState)
  test("ST-O5 toLiveStatusInfo for a live dot with owed records is still live and carries no cause", () => {
    const d = step({ ...healthy, owed: 3 });
    expect(d.kind).toBe("live");
    expect(d.owed).toBe(3);
    expect(toLiveStatusInfo(d)).toEqual({ status: "live", at: d.at });
    const p = step({ transport: { state: "polling", reason: "capacity" }, lastConfirmedAt: T0, owed: 3 });
    expect(toLiveStatusInfo(p)).toEqual({ status: "live", at: p.at });
  });
});
