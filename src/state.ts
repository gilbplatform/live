import type { Coalescer } from "./coalescer.js";
import type { ConfirmationClock } from "./confirm.js";
import type { SessionState } from "./session.js";

/** How long the server may stay silent on a stream before the dot stops claiming "live", in ms. */
export const DEFAULT_HEARTBEAT_WINDOW_MS = 45000;
/** How old the last confirmation may be while polling before the dot stops claiming "live", in ms. */
export const DEFAULT_POLL_WINDOW_MS = 10000;
/** How long trouble may last before the dot says "offline" instead of "reconnecting", in ms. */
export const DEFAULT_OFFLINE_AFTER_MS = 60000;

/**
 * What kind of answer the dot gives. `live` and `polling` are the only kinds that may carry the word "Live"
 * (and only when `showLive` is also true); the others say why the screen may not be current.
 */
export type DotKind = "connecting" | "live" | "polling" | "reconnecting" | "offline" | "paused" | "hidden" | "stopped";

/** The health of the connection underneath. `none` means there is deliberately no connection (a closed hidden tab, or stopped). */
export type DotLink = "ok" | "connecting" | "reconnecting" | "offline" | "none";

/** Why the screen is not live, as a code. The app chooses the words. */
export type DotCause =
  | "no_news" | "cut" | "network" | "server_error" | "sign_in_problem" | "too_slow" | "renewing" | "catching_up"
  | "no_stream" | "busy" | "unreliable" | "access_removed" | "no_access" | "signed_out" | "rejected"
  | "could_not_load" | "stopped_by_app" | "hidden" | "owed" | "unknown";

/** The whole answer to "can I trust what is on the screen right now?". */
export interface DotState {
  kind: DotKind;
  /** True only when the word "Live" may be shown: a recent confirmation, nothing waiting, tab visible, session open. */
  showLive: boolean;
  /** When the screen was last known to be current (epoch ms), or null when never. */
  asOf: number | null;
  /** `at - asOf`, or null when `asOf` is null. */
  ageMs: number | null;
  /** When the next reconnect try is due (epoch ms), or null when not known. */
  retryAt: number | null;
  /** How many changes have arrived but are not on the screen yet. */
  waiting: number;
  /** How many records were announced but could not be read yet (0 when none). While this is above 0, `showLive` is false. */
  owed: number;
  /** Why the screen is not live, or null when nothing is wrong. */
  cause: DotCause | null;
  /** The health of the connection underneath, useful while paused or hidden. */
  link: DotLink;
  /** Whether the data comes by stream or by polling, or null when not known. */
  mode: "stream" | "poll" | null;
  /** True while a routine connection renewal is under way; it does not flash. */
  quiet: boolean;
  /** The time this answer was worked out (epoch ms). */
  at: number;
}

/** The transport's state report, described by shape only so this file imports no transport. */
export interface TransportStateLike {
  state: string;
  mode?: string;
  reason?: string;
  cause?: string;
  retryInMs?: number;
  quiet?: boolean;
}

/** The status word set the app already uses. */
export type LiveStatus = "connecting" | "live" | "offline" | "stopped";

/** The same shape as the app's own status type, so an app can pass it straight through. */
export interface LiveStatusInfo {
  status: LiveStatus;
  at: number;
  cause?: string;
}

/** Everything `computeDot` reads. Numbers that are not finite are treated as null. */
export interface DotInputs {
  transport: TransportStateLike | null;
  /** When `transport` was reported (epoch ms). */
  transportAt: number | null;
  session: SessionState | null;
  paused: boolean;
  waiting: number;
  /** How many records are owed (announced, read failed, not yet read). Missing or not a count means none. */
  owed?: number;
  /** The confirmation clock's latest time. */
  lastConfirmedAt: number | null;
  /** The coalescer's screen time, when there is one. */
  screenConfirmedAt: number | null;
  /** When the current spell of trouble began, or null when it has not. */
  troubleSince: number | null;
  /** When the machine was created; the offline clock starts here when nothing else gives a start. */
  startedAt: number;
  /** The time of this evaluation (epoch ms). */
  now: number;
}

/** The tunable times. Each must be a positive finite number, else the default is used. */
export interface DotOptions {
  heartbeatWindowMs?: number;
  pollWindowMs?: number;
  offlineAfterMs?: number;
}

// --- Small helpers ---

const finite = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);
const positive = (n: unknown, fallback: number): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : fallback);

/** Turns the transport's word for a reconnect into the dot's code. */
function mapCause(word: unknown): DotCause {
  switch (word) {
    case "cut": return "cut";
    case "watchdog": return "no_news";
    case "network": return "network";
    case "http_5xx": case "bad_content_type": case "closed_recheck_failed": case "closed_shutdown": case "closed_unknown": case "ended":
      return "server_error";
    case "auth_provider_failed": return "sign_in_problem";
    case "slow_consumer": return "too_slow";
    case "max_age": case "token_expired": return "renewing";
    default: return "unknown";
  }
}

/** Turns the transport's word for a stop into the dot's code. */
function mapStoppedCause(word: unknown): DotCause {
  switch (word) {
    case "stopped_by_app": return "stopped_by_app";
    case "revoked": return "access_removed";
    case "refused": return "no_access";
    case "unauthorized": return "signed_out";
    case "bad_request": return "rejected";
    case "resync_failed": return "could_not_load";
    default: return "unknown";
  }
}

function mapPollReason(word: unknown): DotCause {
  switch (word) {
    case "no_stream": return "no_stream";
    case "capacity": return "busy";
    case "failures": return "unreliable";
    default: return "unknown";
  }
}

/** The answer plus what the machine needs to schedule itself. */
interface Analysis {
  dot: DotState;
  /** The moment (epoch ms) the answer can next change on its own, or null when it cannot. */
  deadline: number | null;
  /** When trouble really began, if the inputs can tell (a silent connection began to be silent at the end of its allowed span). */
  troubleStartHint: number | null;
}

function analyse(inputs: DotInputs, options?: DotOptions): Analysis {
  // --- Options and inputs, made safe ---
  const heartbeat = positive(options?.heartbeatWindowMs, DEFAULT_HEARTBEAT_WINDOW_MS);
  const pollSpan = positive(options?.pollWindowMs, DEFAULT_POLL_WINDOW_MS);
  const offlineAfter = positive(options?.offlineAfterMs, DEFAULT_OFFLINE_AFTER_MS);
  const now = finite(inputs.now) ?? 0;
  const lastConfirmedAt = finite(inputs.lastConfirmedAt);
  const screenAt = finite(inputs.screenConfirmedAt);
  const troubleSince = finite(inputs.troubleSince);
  const startedAt = finite(inputs.startedAt) ?? now;
  const transportAt = finite(inputs.transportAt);
  const waitingRaw = finite(inputs.waiting);
  const waiting = waitingRaw !== null && waitingRaw > 0 ? Math.floor(waitingRaw) : 0;
  const owedRaw = finite(inputs.owed);
  const owed = owedRaw !== null && owedRaw > 0 ? Math.floor(owedRaw) : 0;
  const session = inputs.session ?? null;
  const transport = inputs.transport ?? null;
  const tState = transport && typeof transport.state === "string" ? transport.state : null;

  // The screen's own time wins: while changes wait it stands still, and that is exactly what must show.
  const asOf = screenAt ?? lastConfirmedAt;
  const ageMs = asOf === null ? null : Math.max(0, now - asOf);

  const make = (part: Partial<DotState> & Pick<DotState, "kind" | "link">): DotState => ({
    showLive: false, asOf, ageMs, retryAt: null, waiting, owed, cause: null, mode: null, quiet: false, at: now, ...part,
  });

  // --- Rule 1: stopped beats everything, except the session's own routine stop while it is hidden or reopening ---
  // The session closes a hidden tab's transport on purpose, and that transport reports `stopped_by_app`. It is the session
  // talking to itself, so it says nothing about the screen and is ignored: a hidden session reads hidden, a reopening one
  // reads connecting. A stop for a real cause (a revoked tab, a refusal) is different: it must never hide behind "hidden".
  const transportCause = tState === "stopped" && typeof transport?.cause === "string" ? transport.cause : null;
  const routineStop = tState === "stopped" && (transportCause === null || transportCause === "stopped_by_app")
    && (session === "hidden_pending" || session === "hidden_closed" || session === "reopening");
  if (session === "stopped" || session === "terminal" || (tState === "stopped" && !routineStop)) {
    let cause: DotCause;
    // A terminal session means something other than the app ended the transport, so a stale `stopped_by_app` explains nothing.
    if (transportCause !== null && !(session === "terminal" && transportCause === "stopped_by_app")) cause = mapStoppedCause(transportCause);
    else if (session === "terminal") cause = "unknown";
    else cause = "stopped_by_app";
    return { dot: make({ kind: "stopped", link: "none", cause }), deadline: null, troubleStartHint: null };
  }
  // From here a routine stop counts as no transport at all, so the rules below do not mistake it for a connection.
  const linkTransport = routineStop ? null : transport;
  const linkState = routineStop ? null : tState;

  // --- Rule 2: the link underneath, worked out even when the answer will be paused or hidden ---
  const polling = linkState === "polling";
  const span = polling ? pollSpan : heartbeat;
  const recent = lastConfirmedAt !== null && now - lastConfirmedAt <= span;
  const silentLive = (linkState === "live" || polling) && !recent && lastConfirmedAt !== null;
  const silenceBegan = silentLive ? (lastConfirmedAt as number) + span : null;
  // The offline clock starts at the latest sign of trouble, so an old confirmation cannot make a fresh start look offline.
  let silentStart = startedAt;
  if (troubleSince !== null || silenceBegan !== null) silentStart = Math.max(troubleSince ?? -Infinity, silenceBegan ?? -Infinity);
  const offlineDue = now - silentStart >= offlineAfter;

  interface LinkResult { link: DotLink; cause: DotCause | null; mode: "stream" | "poll" | null; quiet: boolean; retryAt: number | null }
  const trouble = (c: DotCause | null, retryAt: number | null = null): LinkResult =>
    ({ link: offlineDue ? "offline" : "reconnecting", cause: c, mode: null, quiet: false, retryAt });

  const result = ((): LinkResult => {
    switch (linkState) {
      case "live":
        return recent ? { link: "ok", cause: null, mode: "stream", quiet: false, retryAt: null } : trouble("no_news");
      case "polling":
        return recent ? { link: "ok", cause: mapPollReason(linkTransport?.reason), mode: "poll", quiet: false, retryAt: null } : trouble("no_news");
      case "reconnecting": {
        if (linkTransport?.quiet === true && lastConfirmedAt !== null && now - lastConfirmedAt <= heartbeat) {
          // A routine renewal with a fresh confirmation: nothing is wrong, so nothing may flash.
          return { link: "ok", cause: "renewing", mode: "stream", quiet: true, retryAt: null };
        }
        const retry = finite(linkTransport?.retryInMs);
        return trouble(mapCause(linkTransport?.cause), transportAt !== null && retry !== null ? transportAt + retry : null);
      }
      default: {
        // No transport yet, connecting, resyncing, or a state this file does not know: all "not connected yet".
        let cause: DotCause | null = null;
        if (offlineDue) cause = "no_news";
        else if (linkState === "resyncing") cause = "catching_up";
        else if (linkState !== null && linkState !== "connecting") cause = "unknown";
        else if (linkTransport !== null && linkState === null) cause = "unknown";
        return { link: offlineDue ? "offline" : "connecting", cause, mode: null, quiet: false, retryAt: null };
      }
    }
  })();
  const { link, cause, mode, quiet, retryAt } = result;

  let deadline: number | null = null;
  if (link === "ok" && lastConfirmedAt !== null) deadline = lastConfirmedAt + span + 1;
  else if (link === "connecting" || link === "reconnecting") deadline = silentStart + offlineAfter;
  const hint = silenceBegan;

  // --- Rule 3: hidden ---
  if (session === "hidden_pending" || session === "hidden_closed") {
    const closed = session === "hidden_closed";
    return {
      dot: make({ kind: "hidden", link: closed ? "none" : link, cause: "hidden", mode, quiet, retryAt }),
      deadline: closed ? null : deadline,
      troubleStartHint: hint,
    };
  }

  // --- Rule 4: paused ---
  if (inputs.paused === true) {
    return { dot: make({ kind: "paused", link, cause, mode, quiet, retryAt }), deadline, troubleStartHint: hint };
  }

  // --- Rule 5: the connection kinds ---
  const kind: DotKind = link === "ok" ? (mode === "poll" ? "polling" : "live") : link === "none" ? "offline" : link;
  // "Live" is a computed flag, not a kind: every condition is checked here, in one place, so the word cannot appear
  // without a recent confirmation, an empty waiting list, nothing owed, a visible tab and an open session.
  const showLive = (kind === "live" || kind === "polling") && waiting === 0 && owed === 0 && link === "ok" && recent
    && (session === null || session === "open" || session === "idle");
  // The connection is fine when records are owed, so the kind stays; only the claim and the cause change. A kind that is
  // already in trouble keeps its own cause, which says more.
  const shownCause = owed > 0 && (kind === "live" || kind === "polling") ? "owed" : cause;
  return { dot: make({ kind, link, cause: shownCause, mode, quiet, retryAt, showLive }), deadline, troubleStartHint: hint };
}

/**
 * Works out the dot from what the other kit pieces know. Pure: the same inputs give the same answer.
 *
 * @param inputs the transport's report, the session, the pause flag, the waiting count and the clocks
 * @param options the three tunable times
 * @returns the dot's state; `showLive` is true only when the word "Live" is honest
 */
export function computeDot(inputs: DotInputs, options?: DotOptions): DotState {
  return analyse(inputs, options).dot;
}

/**
 * Maps the dot onto the app's own status type, one to one. It describes the LINK only: records that are owed (`dot.owed`)
 * change what the dot may claim, not the state of the connection, so a live dot with owed records is still `live` here.
 *
 * @param dot a state from `computeDot` or the machine
 * @returns the status; `cause` is present only for `offline` and `stopped`
 */
export function toLiveStatusInfo(dot: DotState): LiveStatusInfo {
  const withCause = (status: "offline" | "stopped", cause: string | null): LiveStatusInfo =>
    cause === null ? { status, at: dot.at } : { status, at: dot.at, cause };
  switch (dot.kind) {
    case "stopped": return withCause("stopped", dot.cause);
    case "connecting": return { status: "connecting", at: dot.at };
    case "live": case "polling": return { status: "live", at: dot.at };
    case "reconnecting": case "offline": return withCause("offline", dot.cause);
    case "paused": case "hidden":
      // Paused and hidden say nothing about the connection themselves, so the link underneath decides.
      if (dot.link === "ok") return { status: "live", at: dot.at };
      if (dot.link === "connecting") return { status: "connecting", at: dot.at };
      if (dot.link === "none") return withCause("offline", "hidden");
      return withCause("offline", dot.cause);
  }
}

/** What you give `createDotMachine`. */
export interface DotMachineOptions extends DotOptions {
  clock: ConfirmationClock;
  /** Only the three reads the dot needs. Without one, the dot is never paused and nothing waits. */
  coalescer?: Pick<Coalescer<unknown>, "paused" | "waiting" | "screenConfirmedAt">;
  /** How many records are owed; read at every evaluation. Without it, nothing is owed. */
  owed?: () => number;
  /** The time source. Default `Date.now`. */
  now?: () => number;
  /** Called whenever a listener would be (see `subscribe`). */
  onChange?: (s: DotState) => void;
}

/** The machine: holds the inputs, re-evaluates on every change and at its own deadlines. */
export interface DotMachine {
  /** Give it every report from the transport. */
  feedTransport(state: TransportStateLike): void;
  /** Give it every change of the session. */
  feedSession(state: SessionState): void;
  /** Re-evaluate now. Call it after `pause()`/`resume()`, from the coalescer's `onWaiting` and when the owed count changes. */
  refresh(): void;
  /** The latest answer. */
  state(): DotState;
  /** Calls `fn` when the answer changes in a way a person could see. Returns the function that stops it. */
  subscribe(fn: (s: DotState) => void): () => void;
  /** Stops the timer, drops listeners and the clock subscription. Later calls do nothing. */
  close(): void;
}

/** The setTimeout ceiling; a longer wait is simply re-armed when it fires. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Creates the machine that keeps the dot's answer current.
 *
 * @param options the clock, an optional coalescer, and the usual time options
 */
export function createDotMachine(options: DotMachineOptions): DotMachine {
  const now = options.now ?? Date.now;
  const dotOptions: DotOptions = {
    heartbeatWindowMs: options.heartbeatWindowMs,
    pollWindowMs: options.pollWindowMs,
    offlineAfterMs: options.offlineAfterMs,
  };
  const startedAt = now();

  let transport: TransportStateLike | null = null;
  let transportAt: number | null = null;
  let session: SessionState | null = null;
  let troubleSince: number | null = null;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(s: DotState) => void>();
  let current: DotState;
  let lastEmitted: DotState | null = null;

  function inputsAt(t: number): DotInputs {
    return {
      transport, transportAt, session,
      paused: options.coalescer?.paused() ?? false,
      waiting: options.coalescer?.waiting() ?? 0,
      owed: options.owed?.() ?? 0,
      lastConfirmedAt: options.clock.lastConfirmedAt(),
      screenConfirmedAt: options.coalescer?.screenConfirmedAt() ?? null,
      troubleSince, startedAt, now: t,
    };
  }

  // The dedupe ignores `ageMs` and `at`: they change every moment, and a listener woken for each would repaint for nothing.
  // Every field a person could see is compared.
  function differs(a: DotState, b: DotState): boolean {
    return a.kind !== b.kind || a.showLive !== b.showLive || a.asOf !== b.asOf || a.retryAt !== b.retryAt
      || a.waiting !== b.waiting || a.owed !== b.owed || a.cause !== b.cause || a.link !== b.link || a.mode !== b.mode || a.quiet !== b.quiet;
  }

  function disarm(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  // The machine keeps its own watch. A transport's timer can be throttled by the runtime; if the dot relied on it, the
  // dot could keep saying "live" while nothing arrives. One timer, re-armed on every evaluation, for the next moment
  // the answer can change by itself.
  function arm(deadline: number | null, t: number): void {
    disarm();
    if (deadline === null || closed) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(1, deadline - t));
    timer = setTimeout(() => {
      timer = undefined;
      evaluate();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  }

  function emit(): void {
    if (lastEmitted !== null && !differs(current, lastEmitted)) return;
    lastEmitted = current;
    const snapshot = current;
    const targets = [...(options.onChange ? [options.onChange] : []), ...listeners];
    for (const fn of targets) {
      try {
        fn(snapshot);
      } catch (error) {
        console.error(`[live] a dot listener threw: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  }

  function evaluate(initial = false): void {
    if (closed) return;
    const t = finite(now()) ?? 0;
    let a = analyse(inputsAt(t), dotOptions);
    // --- The offline clock ---
    // It starts when trouble starts and is cleared when the link is good. Without it, an old confirmation would make a
    // freshly reopened tab look offline at once. A silent connection began its trouble when its allowed silence ended,
    // not when we noticed, so a late check (a throttled timer) still counts the true time.
    if (a.dot.link === "ok") troubleSince = null;
    else if (a.dot.link !== "none" && troubleSince === null) {
      troubleSince = a.troubleStartHint ?? t;
      a = analyse(inputsAt(t), dotOptions);
    }
    current = a.dot;
    arm(a.deadline, t);
    if (!initial) emit();
  }

  const offClock = options.clock.subscribe(() => evaluate());

  evaluate(true);
  lastEmitted = current!;

  return {
    feedTransport(s: TransportStateLike): void {
      if (closed) return;
      transport = s ?? null;
      transportAt = finite(now());
      evaluate();
    },
    feedSession(s: SessionState): void {
      if (closed) return;
      const wasHidden = session === "hidden_pending" || session === "hidden_closed";
      const isHidden = s === "hidden_pending" || s === "hidden_closed";
      if (wasHidden && !isHidden) {
        // A reopened tab starts a new spell of trouble from now.
        troubleSince = finite(now());
      }
      // A closed tab's old transport is gone, and a reopening session is about to make a new one, so the old report
      // must not speak for the new one. The one exception is hidden_pending back to open: the same transport is still
      // running and will send no new report, so dropping its report would leave the dot on "connecting" for good.
      if ((wasHidden && !isHidden && session === "hidden_closed") || s === "reopening") { transport = null; transportAt = null; }
      session = s;
      evaluate();
    },
    refresh(): void { evaluate(); },
    state: () => current,
    subscribe(fn): () => void {
      if (closed) return () => {};
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    close(): void {
      if (closed) return;
      closed = true;
      disarm();
      listeners.clear();
      offClock();
    },
  };
}
