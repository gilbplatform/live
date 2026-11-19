import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createConfirmationClock } from "../src/confirm.js";
import type { ConfirmationClock } from "../src/confirm.js";
import type { SessionState } from "../src/session.js";
import {
  computeDot, createDotMachine, toLiveStatusInfo,
  DEFAULT_HEARTBEAT_WINDOW_MS, DEFAULT_OFFLINE_AFTER_MS, DEFAULT_POLL_WINDOW_MS,
} from "../src/state.js";
import type { DotInputs, DotKind, DotLink, DotMachine, DotMachineOptions, DotState, TransportStateLike } from "../src/state.js";

const T0 = 1_000_000;
const HB = DEFAULT_HEARTBEAT_WINDOW_MS;
const POLL = DEFAULT_POLL_WINDOW_MS;
const OFFLINE = DEFAULT_OFFLINE_AFTER_MS;

/** Builds a full input set from a patch, so each test names only what matters to it. */
function inp(patch: Partial<DotInputs> = {}): DotInputs {
  return {
    transport: null, transportAt: null, session: null, paused: false, waiting: 0,
    lastConfirmedAt: null, screenConfirmedAt: null, troubleSince: null, startedAt: T0, now: T0, ...patch,
  };
}
const step = (patch: Partial<DotInputs> = {}): DotState => computeDot(inp(patch));
const junk = (v: unknown): TransportStateLike => v as TransportStateLike;

/** A fake coalescer: the three reads the machine uses, set by hand. */
class FakeCoalescer {
  isPaused = false;
  w = 0;
  screen: number | null = null;
  paused = (): boolean => this.isPaused;
  waiting = (): number => this.w;
  screenConfirmedAt = (): number | null => this.screen;
}

interface Rig {
  m: DotMachine;
  clock: ConfirmationClock;
  co: FakeCoalescer;
  events: DotState[];
}

/** A machine on fake timers, with a fake coalescer (or none) and a log of what `onChange` heard. */
function rig(extra: Partial<Omit<DotMachineOptions, "coalescer">> & { coalescer?: FakeCoalescer | null } = {}): Rig {
  const clock = extra.clock ?? createConfirmationClock();
  const co = extra.coalescer === null ? new FakeCoalescer() : (extra.coalescer ?? new FakeCoalescer());
  const events: DotState[] = [];
  const { coalescer: _ignored, ...rest } = extra;
  const m = createDotMachine({
    clock,
    ...(extra.coalescer === null ? {} : { coalescer: co }),
    onChange: (s) => events.push(s),
    ...rest,
  });
  return { m, clock, co, events };
}

/** A machine whose transport is live and has just been confirmed (at T0). */
function liveRig(extra: Partial<Omit<DotMachineOptions, "coalescer">> & { coalescer?: FakeCoalescer | null } = {}): Rig {
  const r = rig(extra);
  r.m.feedTransport({ state: "live", mode: "stream" });
  r.clock.confirm();
  return r;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the connection dot: computeDot and the machine", () => {
  // Spec: State.QuietDot, Start: before any report the dot says connecting and never Live
  test("D1 initial: no transport yet gives connecting, showLive false, asOf null", () => {
    const d = step();
    expect(d.kind).toBe("connecting");
    expect(d.showLive).toBe(false);
    expect(d.asOf).toBeNull();
    expect(d.ageMs).toBeNull();
    expect(d.link).toBe("connecting");
    expect(d.cause).toBeNull();
    expect(rig().m.state().kind).toBe("connecting");
  });

  // Spec: State.QuietDot, Honesty: the word Live needs a recent confirmation (LiveWire step, check 8 Honesty.LiveState)
  test("D2 a live transport with a confirmation now gives live, showLive true, link ok, stream", () => {
    const d = step({ transport: { state: "live", mode: "stream" }, lastConfirmedAt: T0, now: T0 + 1000 });
    expect(d).toMatchObject({ kind: "live", showLive: true, link: "ok", mode: "stream", cause: null, waiting: 0, quiet: false });
    expect(d.asOf).toBe(T0);
    expect(d.ageMs).toBe(1000);
  });

  // Spec: State.QuietDot, Honesty: the machine's own watch stops the dot lying when no news arrives (check 8 Honesty.LiveState)
  test("D3 the heartbeat watch: silence turns the dot to reconnecting, then offline, with no feed call; a confirmation restores it", () => {
    const { m, clock, events } = liveRig();
    expect(m.state()).toMatchObject({ kind: "live", showLive: true });
    vi.advanceTimersByTime(HB);
    expect(m.state()).toMatchObject({ kind: "live", showLive: true });
    vi.advanceTimersByTime(1);
    expect(m.state()).toMatchObject({ kind: "reconnecting", cause: "no_news", showLive: false });
    expect(events.at(-1)?.kind).toBe("reconnecting");
    // The silence began when the allowed time ended, so offline comes OFFLINE ms after that.
    vi.advanceTimersByTime(OFFLINE - 2);
    expect(m.state().kind).toBe("reconnecting");
    vi.advanceTimersByTime(1);
    expect(m.state()).toMatchObject({ kind: "offline", showLive: false, link: "offline" });
    clock.confirm();
    expect(m.state()).toMatchObject({ kind: "live", showLive: true, link: "ok" });
  });

  // Spec: State.QuietDot, Honesty: a throttled timer must not make the dot lie (check 8 Honesty.LiveState)
  test("D4 a throttled timer: 120 s pass with no timer firing, then refresh() says offline, not live", () => {
    let t = T0;
    const clock = createConfirmationClock({ now: () => t });
    const m = createDotMachine({ clock, now: () => t });
    m.feedTransport({ state: "live" });
    clock.confirm();
    expect(m.state().kind).toBe("live");
    t = T0 + 120_000; // the fake timers are never advanced, so the watch timer never fires
    m.refresh();
    expect(m.state()).toMatchObject({ kind: "offline", showLive: false });
  });

  // Spec: State.QuietDot, Retry: the retry time is the report time plus the wait; the offline clock counts from the FIRST trouble
  test("D5 reconnecting gives retryAt from the report time; repeated reports keep troubleSince; offline counts from the first trouble", () => {
    const { m, clock } = liveRig();
    expect(clock.lastConfirmedAt()).toBe(T0);
    vi.advanceTimersByTime(10_000);
    m.feedTransport({ state: "reconnecting", cause: "cut", retryInMs: 8000, quiet: false });
    expect(m.state()).toMatchObject({ kind: "reconnecting", cause: "cut", retryAt: T0 + 10_000 + 8000, showLive: false, link: "reconnecting" });
    vi.advanceTimersByTime(30_000);
    m.feedTransport({ state: "reconnecting", cause: "cut", retryInMs: 8000, quiet: false });
    expect(m.state().retryAt).toBe(T0 + 40_000 + 8000);
    // First trouble was at T0+10 s, so offline is due at T0+70 s, not 60 s after the last report.
    vi.advanceTimersByTime(29_999);
    expect(m.state().kind).toBe("reconnecting");
    vi.advanceTimersByTime(1);
    expect(m.state().kind).toBe("offline");
    expect(m.state().cause).toBe("cut");
  });

  // Spec: State.QuietDot, NoFlash: a routine renewal keeps the dot live and quiet, and only a stale one shows trouble
  test("D6 a quiet renewal with a recent confirmation stays live and quiet, with no kind change; a stale one becomes reconnecting", () => {
    const { m, events } = liveRig();
    const kindsBefore = events.map((e) => e.kind);
    expect(kindsBefore.at(-1)).toBe("live");
    vi.advanceTimersByTime(5000);
    m.feedTransport({ state: "reconnecting", cause: "max_age", quiet: true, retryInMs: 0 });
    expect(m.state()).toMatchObject({ kind: "live", quiet: true, showLive: true, cause: "renewing", link: "ok" });
    expect(events.slice(kindsBefore.length).every((e) => e.kind === "live")).toBe(true);
    // The same report, but the last confirmation is older than the heartbeat span.
    const stale = step({ transport: { state: "reconnecting", cause: "max_age", quiet: true }, lastConfirmedAt: T0 - HB - 1000, now: T0 });
    expect(stale).toMatchObject({ kind: "reconnecting", showLive: false, quiet: false });
    // And a quiet report with no confirmation at all is not quiet.
    expect(step({ transport: { state: "reconnecting", cause: "max_age", quiet: true } }).kind).toBe("reconnecting");
  });

  // Spec: State.QuietDot, Polling: the polling span is short (10 s), and the cause says why we poll
  test("D7 polling is live within 10 s of a confirmation, reconnecting after; reasons map to causes", () => {
    const base = { transport: { state: "polling", reason: "capacity" } as TransportStateLike, now: T0 + 20_000 };
    expect(step({ ...base, lastConfirmedAt: T0 + 20_000 - 5000 })).toMatchObject({ kind: "polling", showLive: true, cause: "busy", mode: "poll", link: "ok" });
    expect(step({ ...base, lastConfirmedAt: T0 + 20_000 - POLL })).toMatchObject({ kind: "polling", showLive: true });
    expect(step({ ...base, lastConfirmedAt: T0 + 20_000 - 11_000 })).toMatchObject({ kind: "reconnecting", cause: "no_news", showLive: false });
    for (const [reason, cause] of [["no_stream", "no_stream"], ["capacity", "busy"], ["failures", "unreliable"]] as const) {
      expect(step({ transport: { state: "polling", reason }, lastConfirmedAt: T0, now: T0 }).cause, reason).toBe(cause);
    }
  });

  // Spec: State.QuietDot, CatchUp: a resync is connecting, never live
  test("D8 resyncing gives connecting with cause catching_up", () => {
    const d = step({ transport: { state: "resyncing", cause: "gap" }, lastConfirmedAt: T0, now: T0 });
    expect(d).toMatchObject({ kind: "connecting", cause: "catching_up", showLive: false, link: "connecting" });
  });

  // Spec: State.QuietDot, Honesty: paused or waiting changes mean the screen is not current, so never Live (check 8 Honesty.LiveState)
  test("D9 paused with 7 waiting says paused, waiting 7, no Live, link from the transport; resume returns to live", () => {
    const { m, co } = liveRig();
    co.isPaused = true;
    co.w = 7;
    m.refresh();
    expect(m.state()).toMatchObject({ kind: "paused", waiting: 7, showLive: false, link: "ok" });
    co.isPaused = false;
    co.w = 0;
    m.refresh();
    expect(m.state()).toMatchObject({ kind: "live", waiting: 0, showLive: true });
    // Waiting without a pause (a delivery is due) is not Live either.
    co.w = 2;
    m.refresh();
    expect(m.state().showLive).toBe(false);
    // The link underneath shows through a pause.
    const bad = step({ paused: true, waiting: 3, transport: { state: "reconnecting", cause: "network" }, lastConfirmedAt: T0, now: T0 });
    expect(bad).toMatchObject({ kind: "paused", link: "reconnecting", cause: "network", waiting: 3, showLive: false });
  });

  // Spec: State.QuietDot, Hidden: a hidden tab is never Live, and a reopened tab is not "offline" because of an old confirmation
  test("D10 hidden gives hidden (link ok or none); a reopened tab shows connecting, not offline, for its first minute", () => {
    const live = { transport: { state: "live" } as TransportStateLike, lastConfirmedAt: T0, now: T0 };
    expect(step({ ...live, session: "hidden_pending" })).toMatchObject({ kind: "hidden", link: "ok", cause: "hidden", showLive: false });
    expect(step({ ...live, session: "hidden_closed" })).toMatchObject({ kind: "hidden", link: "none", cause: "hidden", showLive: false });

    const { m } = liveRig();
    m.feedSession("open");
    m.feedSession("hidden_pending");
    vi.advanceTimersByTime(60_000);
    m.feedSession("hidden_closed");
    expect(m.state()).toMatchObject({ kind: "hidden", link: "none" });
    vi.advanceTimersByTime(600_000); // the last confirmation is now 10 minutes old
    m.feedSession("reopening");
    m.feedSession("open");
    m.feedTransport({ state: "connecting" });
    expect(m.state()).toMatchObject({ kind: "connecting", showLive: false, link: "connecting" });
    vi.advanceTimersByTime(30_000);
    expect(m.state().kind).toBe("connecting");
    vi.advanceTimersByTime(OFFLINE);
    expect(m.state().kind).toBe("offline"); // after a full minute of nothing, it may say so
  });

  // Spec: State.QuietDot, Stopped: each stop cause has its own code, and stopped beats hidden and paused
  test("D11 stopped: every stop cause maps; terminal gives unknown; stopped beats hidden and paused", () => {
    const table: Array<[string, string]> = [
      ["revoked", "access_removed"], ["refused", "no_access"], ["unauthorized", "signed_out"], ["bad_request", "rejected"],
      ["resync_failed", "could_not_load"], ["stopped_by_app", "stopped_by_app"], ["something_new", "unknown"],
    ];
    for (const [word, cause] of table) {
      const d = step({ transport: { state: "stopped", cause: word } });
      expect(d, word).toMatchObject({ kind: "stopped", cause, showLive: false, link: "none" });
    }
    expect(step({ session: "terminal" })).toMatchObject({ kind: "stopped", cause: "unknown" });
    expect(step({ session: "stopped" })).toMatchObject({ kind: "stopped", cause: "stopped_by_app" });
    expect(step({ session: "terminal", transport: { state: "stopped", cause: "revoked" } }).cause).toBe("access_removed");
    expect(step({ transport: { state: "stopped" } }).cause).toBe("stopped_by_app");
    const gone = { transport: { state: "stopped", cause: "revoked" } as TransportStateLike };
    expect(step({ ...gone, session: "hidden_pending" }).kind).toBe("stopped");
    expect(step({ ...gone, paused: true, waiting: 4 }).kind).toBe("stopped");
  });

  // Spec: State.QuietDot, Priority: stopped, then hidden, then paused, then the connection kinds
  test("D12 priority: stopped over hidden over paused over the connection kinds, in each pairing", () => {
    const live = { lastConfirmedAt: T0, now: T0 };
    const kindOf = (patch: Partial<DotInputs>): DotKind => step({ ...live, ...patch }).kind;
    const stopped: Partial<DotInputs> = { transport: { state: "stopped", cause: "revoked" } };
    const liveT: Partial<DotInputs> = { transport: { state: "live" } };
    expect(kindOf({ ...stopped, session: "hidden_closed", paused: true })).toBe("stopped");
    expect(kindOf({ ...stopped, session: "hidden_pending" })).toBe("stopped");
    expect(kindOf({ ...stopped, paused: true })).toBe("stopped");
    expect(kindOf({ ...stopped })).toBe("stopped");
    expect(kindOf({ ...liveT, session: "hidden_pending", paused: true })).toBe("hidden");
    expect(kindOf({ ...liveT, session: "hidden_closed", paused: true })).toBe("hidden");
    expect(kindOf({ ...liveT, paused: true })).toBe("paused");
    expect(kindOf({ ...liveT, session: "hidden_pending" })).toBe("hidden");
    expect(kindOf({ transport: { state: "reconnecting", cause: "cut" }, paused: true })).toBe("paused");
    expect(kindOf({ transport: { state: "polling", reason: "capacity" }, paused: true })).toBe("paused");
    expect(kindOf({ ...liveT })).toBe("live");
  });

  // Spec: State.QuietDot, Honesty: whenever showLive is true, every honesty condition holds (LiveWire step, check 8 Honesty.LiveState)
  test("D13 the invariant over 2000 seeded random sequences: Live only with a recent confirmation, nothing waiting, not paused, tab shown, session open", () => {
    let seed = 20261119;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const transports: Array<TransportStateLike | null> = [
      null, { state: "connecting" }, { state: "live", mode: "stream" }, { state: "polling", reason: "capacity" },
      { state: "polling", reason: "no_stream" }, { state: "reconnecting", cause: "cut", retryInMs: 3000 },
      { state: "reconnecting", cause: "max_age", quiet: true }, { state: "resyncing", cause: "gap" },
      { state: "stopped", cause: "revoked" }, { state: "weird" }, junk({}),
    ];
    const sessions: Array<SessionState | null> = [null, "idle", "open", "hidden_pending", "hidden_closed", "reopening", "terminal", "stopped"];
    const seen = new Set<DotKind>();
    let liveCount = 0;
    for (let seq = 0; seq < 2000; seq++) {
      let now = T0;
      for (let i = 0; i < 6; i++) {
        now += Math.floor(rnd() * 90_000);
        const transport = pick(transports);
        const session = pick(sessions);
        const paused = rnd() < 0.2;
        const waiting = pick([0, 0, 0, 1, 7]);
        const lastConfirmedAt = rnd() < 0.1 ? null : now - Math.floor(rnd() * 120_000) * (rnd() < 0.5 ? 1 : 0.1);
        const troubleSince = rnd() < 0.5 ? null : now - Math.floor(rnd() * 90_000);
        const d = step({ transport, session, paused, waiting, lastConfirmedAt, troubleSince, now, transportAt: now - 100 });
        seen.add(d.kind);
        const span = transport?.state === "polling" ? POLL : HB;
        if (d.showLive) {
          liveCount++;
          expect(["live", "polling"]).toContain(d.kind);
          expect(lastConfirmedAt).not.toBeNull();
          expect(now - (lastConfirmedAt as number)).toBeLessThanOrEqual(span);
          expect(waiting).toBe(0);
          expect(paused).toBe(false);
          expect(session === null || session === "open" || session === "idle").toBe(true);
          expect(d.link).toBe("ok");
        }
        // The reverse: a live kind with nothing waiting and a good session never loses the flag.
        if (d.kind === "live" && waiting === 0 && (session === null || session === "open" || session === "idle")) expect(d.showLive).toBe(true);
        if (d.kind === "polling" && waiting === 0 && (session === null || session === "open" || session === "idle")) expect(d.showLive).toBe(true);
        if (d.kind === "paused" || d.kind === "hidden" || d.kind === "stopped") expect(d.showLive).toBe(false);
      }
    }
    // Not vacuous: the generator really did reach every kind, and Live was shown often.
    expect(liveCount).toBeGreaterThan(200);
    for (const k of ["connecting", "live", "polling", "reconnecting", "offline", "paused", "hidden", "stopped"] as const) expect(seen.has(k), k).toBe(true);
  });

  // Spec: State.QuietDot, Honesty: the screen time stands still while changes wait, so the age grows (check 8 Honesty.LiveState)
  test("D14 asOf follows the screen time when there is one, else the clock; it stands still while changes wait", () => {
    const { m, clock, co } = rig();
    m.feedTransport({ state: "live" });
    co.screen = T0;
    clock.confirm(T0);
    expect(m.state().asOf).toBe(T0);
    // Changes wait: the clock moves on, the screen time does not.
    co.w = 3;
    vi.advanceTimersByTime(10_000);
    clock.confirm();
    expect(m.state()).toMatchObject({ asOf: T0, ageMs: 10_000, waiting: 3, showLive: false });
    vi.advanceTimersByTime(5000);
    clock.confirm();
    m.refresh();
    expect(m.state()).toMatchObject({ asOf: T0, ageMs: 15_000 });
    // A coalescer that has no screen time yet falls back to the clock.
    const r2 = rig();
    r2.m.feedTransport({ state: "live" });
    r2.clock.confirm(T0 + 100);
    expect(r2.m.state().asOf).toBe(T0 + 100);
    // No coalescer at all: the clock.
    const r3 = rig({ coalescer: null });
    r3.clock.confirm(T0 + 200);
    expect(r3.m.state().asOf).toBe(T0 + 200);
    expect(step({ lastConfirmedAt: T0 + 5, screenConfirmedAt: null, now: T0 + 50 })).toMatchObject({ asOf: T0 + 5, ageMs: 45 });
    expect(step({ lastConfirmedAt: T0 + 5, screenConfirmedAt: T0 + 2, now: T0 + 50 })).toMatchObject({ asOf: T0 + 2, ageMs: 48 });
  });

  // Spec: State.QuietDot, Mapping: every dot kind maps onto the app's own status words, one to one
  test("D15 toLiveStatusInfo: the whole mapping table", () => {
    const dot = (patch: Partial<DotState>): DotState => ({
      kind: "live", showLive: true, asOf: T0, ageMs: 0, retryAt: null, waiting: 0, owed: 0, cause: null, link: "ok", mode: "stream", quiet: false, at: 4242, ...patch,
    });
    const s = toLiveStatusInfo;
    expect(s(dot({ kind: "stopped", cause: "access_removed", link: "none", showLive: false }))).toStrictEqual({ status: "stopped", at: 4242, cause: "access_removed" });
    expect(s(dot({ kind: "connecting", link: "connecting", showLive: false }))).toStrictEqual({ status: "connecting", at: 4242 });
    expect(s(dot({ kind: "live" }))).toStrictEqual({ status: "live", at: 4242 });
    expect(s(dot({ kind: "polling", cause: "busy", mode: "poll" }))).toStrictEqual({ status: "live", at: 4242 });
    expect(s(dot({ kind: "reconnecting", cause: "cut", link: "reconnecting", showLive: false }))).toStrictEqual({ status: "offline", at: 4242, cause: "cut" });
    expect(s(dot({ kind: "offline", cause: "no_news", link: "offline", showLive: false }))).toStrictEqual({ status: "offline", at: 4242, cause: "no_news" });
    // A quiet renewal keeps the kind live, so it is live.
    const quiet = step({ transport: { state: "reconnecting", cause: "max_age", quiet: true }, lastConfirmedAt: T0, now: T0 + 1, });
    expect(s(quiet)).toStrictEqual({ status: "live", at: T0 + 1 });
    // Paused follows the link.
    const paused = (link: DotLink, cause: DotState["cause"]): DotState => dot({ kind: "paused", showLive: false, link, cause });
    expect(s(paused("ok", null))).toStrictEqual({ status: "live", at: 4242 });
    expect(s(paused("connecting", null))).toStrictEqual({ status: "connecting", at: 4242 });
    expect(s(paused("reconnecting", "network"))).toStrictEqual({ status: "offline", at: 4242, cause: "network" });
    expect(s(paused("offline", "no_news"))).toStrictEqual({ status: "offline", at: 4242, cause: "no_news" });
    // Hidden follows the link too; a closed hidden tab is offline with cause hidden.
    const hidden = (link: DotLink): DotState => dot({ kind: "hidden", showLive: false, link, cause: "hidden" });
    expect(s(hidden("ok"))).toStrictEqual({ status: "live", at: 4242 });
    expect(s(hidden("connecting"))).toStrictEqual({ status: "connecting", at: 4242 });
    expect(s(hidden("reconnecting"))).toStrictEqual({ status: "offline", at: 4242, cause: "hidden" });
    expect(s(hidden("offline"))).toStrictEqual({ status: "offline", at: 4242, cause: "hidden" });
    expect(s(hidden("none"))).toStrictEqual({ status: "offline", at: 4242, cause: "hidden" });
    // From real inputs, `at` is the dot's own time and the live statuses carry no cause.
    const real = step({ transport: { state: "live" }, lastConfirmedAt: T0, now: T0 + 77 });
    expect(s(real).at).toBe(real.at);
    expect("cause" in s(real)).toBe(false);
    expect("cause" in s(step())).toBe(false);
  });

  // Spec: State.QuietDot, Emission: listeners hear only changes a person could see
  test("D16 emission: silent at creation, silent for age alone, loud for each visible field, isolated and unsubscribable", () => {
    // Creation is silent.
    expect(rig().events).toHaveLength(0);

    // Age alone is silent.
    const quietRig = liveRig();
    const heard: DotState[] = [];
    quietRig.m.subscribe((s) => heard.push(s));
    vi.setSystemTime(T0 + 10_000); // time passes, no timer fires
    quietRig.m.refresh();
    expect(quietRig.m.state().ageMs).toBe(10_000);
    expect(heard).toHaveLength(0);

    // Each visible field. Setup runs first, then the heard list is cleared, then one change happens.
    const scenarios: Array<[string, (r: Rig) => void, (r: Rig) => void, Rig?]> = [
      ["kind", (r) => { r.m.feedTransport({ state: "live" }); r.clock.confirm(); }, (r) => r.m.feedTransport({ state: "connecting" })],
      ["showLive", (r) => { r.m.feedTransport({ state: "live" }); r.clock.confirm(); }, (r) => { r.co.w = 2; r.m.refresh(); }],
      ["asOf", (r) => { r.m.feedTransport({ state: "live" }); r.clock.confirm(); }, (r) => { vi.advanceTimersByTime(1000); r.clock.confirm(); }],
      ["retryAt", (r) => r.m.feedTransport({ state: "reconnecting", cause: "cut", retryInMs: 8000 }), (r) => { vi.advanceTimersByTime(1000); r.m.feedTransport({ state: "reconnecting", cause: "cut", retryInMs: 8000 }); }],
      ["waiting", (r) => { r.co.isPaused = true; r.co.w = 3; r.m.refresh(); }, (r) => { r.co.w = 4; r.m.refresh(); }],
      ["cause", (r) => r.m.feedTransport({ state: "reconnecting", cause: "cut" }), (r) => r.m.feedTransport({ state: "reconnecting", cause: "network" })],
      ["link", (r) => { r.co.isPaused = true; r.m.feedTransport({ state: "reconnecting", cause: "cut", retryInMs: 8000 }); }, () => { vi.advanceTimersByTime(OFFLINE); }],
      ["mode", (r) => { r.co.isPaused = true; r.m.feedTransport({ state: "live" }); r.clock.confirm(); }, (r) => r.m.feedTransport({ state: "polling", reason: "no_stream" })],
      ["quiet", (r) => { r.m.feedTransport({ state: "live" }); r.clock.confirm(); }, (r) => r.m.feedTransport({ state: "reconnecting", cause: "max_age", quiet: true })],
    ];
    for (const [name, setup, change] of scenarios) {
      vi.setSystemTime(T0);
      const r = rig();
      setup(r);
      const calls: DotState[] = [];
      r.m.subscribe((s) => calls.push(s));
      r.events.length = 0;
      change(r);
      expect(calls.length, `${name}: listener`).toBeGreaterThan(0);
      expect(r.events.length, `${name}: onChange`).toBeGreaterThan(0);
      r.m.close();
    }

    // A throwing listener is isolated, with a message-only log line.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.setSystemTime(T0);
    const r = rig();
    const good: DotState[] = [];
    r.m.subscribe(() => { throw new Error("boom"); });
    r.m.subscribe((s) => good.push(s));
    r.m.feedTransport({ state: "live" });
    r.clock.confirm();
    expect(good.length).toBeGreaterThan(0);
    expect(errors).toHaveBeenCalled();
    expect(String(errors.mock.calls[0]?.[0])).toContain("boom");
    expect(String(errors.mock.calls[0]?.[0])).not.toContain("at ");
    expect(r.m.state().kind).toBe("live");

    // Unsubscribe works.
    const r2 = rig();
    const n: DotState[] = [];
    const off = r2.m.subscribe((s) => n.push(s));
    r2.m.feedTransport({ state: "connecting" });
    r2.m.feedTransport({ state: "reconnecting", cause: "cut" });
    const before = n.length;
    expect(before).toBeGreaterThan(0);
    off();
    r2.m.feedTransport({ state: "reconnecting", cause: "network" });
    expect(n).toHaveLength(before);
  });

  // Spec: State.QuietDot, Close: close() releases the timer, the listeners and the clock subscription
  test("D17 close clears the timer, drops listeners and the clock subscription; later calls do nothing", () => {
    const base = createConfirmationClock();
    let subscribers = 0;
    const clock: ConfirmationClock = {
      confirm: (at) => base.confirm(at),
      lastConfirmedAt: () => base.lastConfirmedAt(),
      subscribe(fn) {
        subscribers++;
        const off = base.subscribe(fn);
        return () => { subscribers--; off(); };
      },
    };
    const r = liveRig({ clock });
    const heard: DotState[] = [];
    r.m.subscribe((s) => heard.push(s));
    expect(subscribers).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    const frozen = r.m.state();
    r.events.length = 0;
    r.m.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(subscribers).toBe(0);
    r.m.feedTransport({ state: "reconnecting", cause: "cut" });
    r.m.feedSession("hidden_closed");
    r.m.refresh();
    base.confirm(T0 + 5);
    vi.advanceTimersByTime(10 * OFFLINE);
    expect(heard).toHaveLength(0);
    expect(r.events).toHaveLength(0);
    expect(r.m.state()).toBe(frozen);
    expect(vi.getTimerCount()).toBe(0);
    r.m.close(); // twice is fine
    const off = r.m.subscribe(() => {});
    off();
  });

  // Spec: State.QuietDot, Options: a bad time falls back to the default; a good one is honoured
  test("D18 options: non-finite, zero and negative times use the defaults; custom times are honoured", () => {
    expect([HB, POLL, OFFLINE]).toEqual([45000, 10000, 60000]);
    const live = (opts: object, ageOfConfirmation: number) =>
      computeDot(inp({ transport: { state: "live" }, lastConfirmedAt: T0, now: T0 + ageOfConfirmation }), opts);
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY, "x" as unknown as number]) {
      expect(live({ heartbeatWindowMs: bad }, HB).showLive, String(bad)).toBe(true);
      expect(live({ heartbeatWindowMs: bad }, HB + 1).showLive, String(bad)).toBe(false);
    }
    expect(live({ heartbeatWindowMs: 5000 }, 5001).kind).toBe("reconnecting");
    expect(live({ heartbeatWindowMs: 5000 }, 5000).showLive).toBe(true);
    expect(live({ heartbeatWindowMs: 100_000 }, 90_000).showLive).toBe(true);
    const poll = (opts: object, age: number) =>
      computeDot(inp({ transport: { state: "polling", reason: "capacity" }, lastConfirmedAt: T0, now: T0 + age }), opts);
    expect(poll({ pollWindowMs: Number.NaN }, POLL).showLive).toBe(true);
    expect(poll({ pollWindowMs: -1 }, POLL + 1).showLive).toBe(false);
    expect(poll({ pollWindowMs: 2000 }, 2001).showLive).toBe(false);
    expect(poll({ pollWindowMs: 30_000 }, 20_000).showLive).toBe(true);
    const trouble = (opts: object) =>
      computeDot(inp({ transport: { state: "reconnecting", cause: "cut" }, troubleSince: T0, now: T0 + 1000 }), opts).kind;
    expect(trouble({})).toBe("reconnecting");
    expect(trouble({ offlineAfterMs: 1000 })).toBe("offline");
    expect(trouble({ offlineAfterMs: 1001 })).toBe("reconnecting");
    expect(trouble({ offlineAfterMs: 0 })).toBe("reconnecting");
    expect(trouble({ offlineAfterMs: Number.NaN })).toBe("reconnecting");
    // A machine honours them on its own timer.
    const r = liveRig({ heartbeatWindowMs: 2000, offlineAfterMs: 3000 });
    vi.advanceTimersByTime(2001);
    expect(r.m.state().kind).toBe("reconnecting");
    vi.advanceTimersByTime(3000);
    expect(r.m.state().kind).toBe("offline");
  });

  // Spec: State.QuietDot, NoCoalescer: without a coalescer nothing is paused and nothing waits
  test("D19 a machine with no coalescer is never paused and has nothing waiting", () => {
    const { m, clock } = rig({ coalescer: null });
    m.feedTransport({ state: "live" });
    clock.confirm();
    m.refresh();
    expect(m.state()).toMatchObject({ kind: "live", waiting: 0, showLive: true });
  });

  // Spec: State.QuietDot, Monotone: the confirmation time never goes back, so the screen time never goes back
  test("D20 a late old confirmation does not move asOf back; non-finite times count as none", () => {
    const { m, clock } = rig({ coalescer: null });
    m.feedTransport({ state: "live" });
    clock.confirm(T0 + 1000);
    clock.confirm(T0);
    expect(m.state().asOf).toBe(T0 + 1000);
    clock.confirm(Number.NaN);
    expect(m.state().asOf).toBe(T0 + 1000);
    const d = step({ lastConfirmedAt: Number.NaN, screenConfirmedAt: Number.POSITIVE_INFINITY, transport: { state: "live" } });
    expect(d.asOf).toBeNull();
    expect(d.ageMs).toBeNull();
    expect(d.showLive).toBe(false);
  });

  // Spec: State.QuietDot, Robust: nothing the transport reports can make the dot throw
  test("D21 unknown state words and missing fields never throw and give connecting with cause unknown", () => {
    expect(step({ transport: { state: "weird" } })).toMatchObject({ kind: "connecting", cause: "unknown", showLive: false });
    expect(step({ transport: junk({}) })).toMatchObject({ kind: "connecting", cause: "unknown", showLive: false });
    expect(step({ transport: junk({ state: 42 }) }).kind).toBe("connecting");
    expect(step({ transport: junk(7) }).kind).toBe("connecting");
    expect(step({ session: "bogus" as unknown as SessionState }).kind).toBe("connecting");
    // A reconnecting report with nothing in it, and with a bad retry time.
    expect(step({ transport: { state: "reconnecting" } })).toMatchObject({ kind: "reconnecting", cause: "unknown", retryAt: null });
    expect(step({ transport: { state: "reconnecting", cause: "cut", retryInMs: Number.NaN }, transportAt: T0 }).retryAt).toBeNull();
    expect(step({ transport: { state: "reconnecting", cause: "cut", retryInMs: 5 }, transportAt: Number.NaN }).retryAt).toBeNull();
    expect(step({ transport: { state: "polling" }, lastConfirmedAt: T0 })).toMatchObject({ kind: "polling", cause: "unknown" });
    expect(step({ waiting: Number.NaN, now: Number.NaN, startedAt: Number.NaN }).waiting).toBe(0);
    const { m } = rig();
    expect(() => {
      m.feedTransport({ state: "weird" });
      m.feedTransport(junk({}));
      m.feedTransport(junk(null));
      m.feedSession("bogus" as unknown as SessionState);
      m.refresh();
    }).not.toThrow();
    expect(m.state().showLive).toBe(false);
    // Every known transport cause word maps.
    const causes: Array<[string, string]> = [
      ["cut", "cut"], ["watchdog", "no_news"], ["network", "network"], ["http_5xx", "server_error"], ["bad_content_type", "server_error"],
      ["closed_recheck_failed", "server_error"], ["closed_shutdown", "server_error"], ["closed_unknown", "server_error"], ["ended", "server_error"],
      ["auth_provider_failed", "sign_in_problem"], ["slow_consumer", "too_slow"], ["max_age", "renewing"], ["token_expired", "renewing"], ["other", "unknown"],
    ];
    for (const [word, cause] of causes) {
      expect(step({ transport: { state: "reconnecting", cause: word } }).cause, word).toBe(cause);
    }
  });

  // Spec: State.QuietDot, Independent: the file imports only the types of its three neighbours and names no browser global
  test("D22 source scan: only type imports of confirm, session and coalescer; no transport; no forbidden word", () => {
    const body = readFileSync(fileURLToPath(new URL("../src/state.ts", import.meta.url)), "utf8");
    const imports = [...body.matchAll(/^import\s+(type\s+)?[^;]*?from\s*["']([^"']+)["'];?/gms)];
    expect(imports.length).toBe(3);
    expect(imports.map((m) => m[2]).sort()).toEqual(["./coalescer.js", "./confirm.js", "./session.js"]);
    for (const m of imports) expect(m[1], `${m[2]} must be a type import`).toBeTruthy();
    expect(/transport(?:[-a-z]*)\.js/.test(body)).toBe(false);
    expect(/\brequire\(|\bimport\(/.test(body)).toBe(false);
    const banned = [
      "GilbApp", "BaseRecord", "data-live-", "gilbplatformcode", "a7cb8cff", "/Users/", "EventSource", "indexedDB", "localStorage",
      "sessionStorage", "window", "document", "navigator",
    ];
    for (const word of banned) expect(body.includes(word), word).toBe(false);
  });
});
