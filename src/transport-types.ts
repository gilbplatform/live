import type { LiveStore } from "./types.js";

/**
 * Gives the headers to send with ONE request. It is called for every request, with the exact address that will be
 * requested, so a proof that may be used only once can be made fresh each time. `refresh: true` is passed once after the
 * server answered 401 (and for the first request after the server said the token ran out): make a new token if you can.
 *
 * In: the method (always GET) and the full address; whether this is a refresh.
 * Out: the headers, for example `{ authorization: "Bearer <token>" }`, directly or as a promise.
 */
export type AuthProvider = (
  request: { method: "GET"; url: string },
  context: { refresh: boolean },
) => Promise<Record<string, string>> | Record<string, string>;

/**
 * Where the transport is. `cause` and `reason` are fixed words, never server text, never a header or a token.
 * - `connecting`: the first request is being made.
 * - `live`: the stream is open.
 * - `polling`: the stream is not used; the change feed is asked on a timer.
 * - `reconnecting`: the stream was lost; it will be asked again in `retryInMs`. `quiet` is true for routine renewals.
 * - `resyncing`: the transport asked the app for a full read.
 * - `stopped`: the end. Nothing more is requested.
 */
export type TransportState =
  | { state: "connecting" }
  | { state: "live"; mode: "stream" }
  | { state: "polling"; reason: "no_stream" | "capacity" | "failures" }
  | { state: "reconnecting"; cause: string; retryInMs: number; quiet: boolean }
  | { state: "resyncing"; cause: "bad_cursor" | "poll_start" }
  | { state: "stopped"; cause: "stopped_by_app" | "revoked" | "refused" | "unauthorized" | "bad_request" | "resync_failed" };

/** What you give `createLiveTransport`. */
export interface TransportOptions {
  /** The store that receives the notifications. */
  store: LiveStore<unknown>;
  /** `scheme://host[:port]` with no path or credentials. */
  origin: string;
  /** The vault to watch. */
  vaultId: string;
  /** Bare type names to watch (at most 20). Leave out for all types. */
  types?: readonly string[];
  /** Asked for the headers of every request. */
  auth: AuthProvider;
  /**
   * The app's full read of the list, ending in `store.seed(...)`. Called when the position is lost (`bad_cursor`) and when
   * the transport starts to poll (`poll_start`). The transport takes its head cursors BEFORE calling it, so a change made
   * during the read is not lost.
   */
  resync: (reason: "bad_cursor" | "poll_start") => Promise<void>;
  /** Where the first stream starts when the store holds no cursor: `head` (default, no `since`), `start`, or a cursor. */
  from?: "head" | "start" | string;
  /** The fetch to use. Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Time between poll ticks, in ms. Default 2000. */
  pollMs?: number;
  /** A stream with no byte for this long is cut and asked again, in ms. Default 45000. */
  heartbeatTimeoutMs?: number;
  /** After this many failures in a row, poll instead. Default 3. */
  failuresBeforePoll?: number;
  /** While polling, the stream is tried again this often, in ms. Default 30000. */
  streamProbeMs?: number;
  /** A stream open this long counts as good and resets the failure count, in ms. Default 10000. */
  stableMs?: number;
  /** Reconnect delay settings, in ms. Defaults 1000 and 30000. */
  backoff?: { baseMs?: number; capMs?: number };
  /** Random source in [0, 1). Default `Math.random`. */
  random?: () => number;
  /** The clock for notification times. Default `new Date()`. */
  now?: () => Date;
  /** Called on every change of state. A throw is swallowed. */
  onState?: (s: TransportState) => void;
  /**
   * Called with the time (ms) whenever the server is known to be there: on every chunk of the stream (a heartbeat counts),
   * after every notification pushed, after every successful poll tick (even an empty one) and after `resync` resolves.
   * Never on a failure, and never after the transport stopped. A throw is swallowed.
   */
  onConfirm?: (atMs: number) => void;
}

/** Counters for tests and diagnostics. Numbers only. */
export interface TransportStats {
  /** Requests made to the stream address (a retry after a 401 counts). */
  streamRequests: number;
  /** Requests made to the change feed (heads and pages). */
  feedRequests: number;
  /** Notifications given to the store, from the stream or from the feed. */
  framesPushed: number;
  /** Stream events that were ignored (bad JSON, bad shape, unknown event name). */
  framesIgnored: number;
  /** Times a new stream request was scheduled after a loss or a routine renewal. */
  reconnects: number;
  /** Calls made to `resync`. */
  resyncs: number;
  /** Calls made to `auth` with `refresh: true`. */
  authRefreshes: number;
}

/** The transport. It can be started once; after `stop()` or a terminal state the app makes a new one. */
export interface LiveTransport {
  /** Begins. A second call does nothing. */
  start(): void;
  /** Stops everything and resolves when no request is open and no timer runs. Safe to call twice. */
  stop(): Promise<void>;
  /** The state now. */
  state(): TransportState;
  /** `stream` while the stream is open, `poll` while polling, otherwise null. */
  mode(): "stream" | "poll" | null;
  /** A fresh copy of the counters. */
  stats(): TransportStats;
}
