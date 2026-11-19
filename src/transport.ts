// The network side of the kit: one live stream (or, when it is not available, a timed poll of the change feed) that
// gives notifications to a store. Only `fetch` and `ReadableStream` are used, so it runs in Node 22 and in browsers.

import { clampRetryHintMs, nextBackoffMs, retryAfterMs } from "./backoff.js";
import { feedUrl, isCursor, liveUrl, normalizeOrigin, notificationsFromFeed, parseFeedPage } from "./feed.js";
import { parseLiveNotification } from "./notification.js";
import { createSseParser } from "./sse.js";
import type { LiveTransport, TransportOptions, TransportState, TransportStats } from "./transport-types.js";

/** Headers the transport sets itself or must never take from the app. */
const FORBIDDEN_HEADERS = new Set(["accept", "host", "cookie", "content-length", "connection"]);
/** After this many failed resyncs in a row the transport gives up. */
const MAX_RESYNC_FAILURES = 5;
/** A routine renewal waits a random time up to this long, in ms. */
const QUIET_RECONNECT_MAX_MS = 250;
/** After a `shed` the stream is not asked again for at least this long, in ms. */
const SHED_MIN_WAIT_MS = 5000;
/** This many `slow_consumer` closes in a row send the transport to polling. */
const SLOW_CONSUMER_LIMIT = 3;
/** A safety stop for one tick's paging, so a server that never says "complete" cannot loop forever. */
const MAX_PAGES_PER_TICK = 1000;

/** A step ended in a loss that deserves a retry. `cause` is a fixed word; there is never server text in it. */
class Failure {
  constructor(
    readonly cause: string,
    readonly waitMs = 0,
    readonly badCursor = false,
  ) {}
}

/** The transport must end for good, for this fixed reason. */
class Terminal {
  constructor(readonly cause: Extract<TransportState, { state: "stopped" }>["cause"]) {}
}

/**
 * Creates a transport. Call `start()` once; give the app's `resync` and `auth`. See `TransportOptions`.
 *
 * @param options the store, the address, how to sign in, and optional tuning; throws a plain `Error` when one is wrong
 * @returns the transport, not yet started
 */
export function createLiveTransport(options: TransportOptions): LiveTransport {
  // --- Validation: fail at creation, never in the middle of a connection ---
  const origin = normalizeOrigin(options.origin);
  const vaultId = options.vaultId;
  if (typeof vaultId !== "string" || vaultId === "") throw new Error("vaultId must be a non-empty string");
  const types = options.types;
  liveUrl(origin, vaultId, { types });
  const from = options.from ?? "head";
  if (from !== "head" && from !== "start" && !isCursor(from)) throw new Error("from must be head, start or a cursor");
  const store = options.store;
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") throw new Error("no fetch is available");
  if (typeof options.auth !== "function" || typeof options.resync !== "function") throw new Error("auth and resync are required");

  const num = (v: number | undefined, d: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d);
  const pollMs = num(options.pollMs, 2000);
  const heartbeatTimeoutMs = num(options.heartbeatTimeoutMs, 45000);
  const failuresBeforePoll = Math.max(1, num(options.failuresBeforePoll, 3));
  const streamProbeMs = num(options.streamProbeMs, 30000);
  const stableMs = num(options.stableMs, 10000);
  const backoff = options.backoff ?? {};
  const random = options.random ?? Math.random;
  const clock = options.now ?? ((): Date => new Date());

  // --- State ---
  let epoch = 0; // bumped at every source change and at stop: a push from an older epoch is discarded
  let started = false;
  let stopping = false;
  let terminalCause: Extract<TransportState, { state: "stopped" }>["cause"] | null = null;
  let finalEmitted = false;
  let current: TransportState = { state: "connecting" };
  let runner: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let active: AbortController | null = null;
  const wakers = new Set<() => void>();
  let stopSignal!: () => void;
  const stopped = new Promise<void>((resolve) => { stopSignal = resolve; });

  let phase: "stream" | "poll" = "stream";
  let probing = false; // a stream try made from poll mode
  let streamAllowed = true; // false for good after "not available here"
  let nextStreamTryAt = 0;
  let pollReason: "no_stream" | "capacity" | "failures" = "failures";
  let failures = 0;
  let pollFailures = 0;
  let slowCount = 0;
  let retryHint = 0;
  let pendingRefresh = false;
  let afterReseed = false;
  let pushedSincePoll = false;
  let pollReseeded = false;
  let cursorOverride: string | null = null;
  let pollCursors: { live: string; ended: string } | null = null;
  // True after a connection that ended without the server saying anything beyond its opening line. While it is set, a new
  // connection's opening line does not confirm: that line only proves the server answered (it says nothing about the hub),
  // and a server that accepts but never speaks would otherwise bring "Live" back at every reconnect.
  let distrust = false;
  const counters: TransportStats = { streamRequests: 0, feedRequests: 0, framesPushed: 0, framesIgnored: 0, reconnects: 0, resyncs: 0, authRefreshes: 0 };

  const alive = (): boolean => !stopping && terminalCause === null;

  /** Reports a state to the app. After the final `stopped`, nothing more is reported. */
  function setState(s: TransportState): void {
    if (finalEmitted) return;
    if (s.state === "stopped") finalEmitted = true;
    current = s;
    try {
      options.onState?.(s);
    } catch {
      // A fixed line with no data: the app's callback is its own business, but its failure should not be silent.
      console.error("[live] onState callback threw");
    }
  }

  /** Tells the app the server is there. Never after a stop; never lets the app's throw out. */
  function confirm(): void {
    if (!alive() || !options.onConfirm) return;
    try {
      options.onConfirm(clock().getTime());
    } catch {
      // Swallowed on purpose: a confirmation clock must not be able to break the connection.
    }
  }

  /**
   * Asks the store to retry every record whose read failed. A connection that works again (a stream accepted, a poll tick
   * that succeeded, a resync that finished) is the moment: the cursor is past those records, so nothing else would read them.
   * Never after a stop, and a store that throws cannot break the connection.
   */
  function retryOwed(): void {
    if (!alive()) return;
    try {
      store.retryOwed();
    } catch {
      // A fixed line with no data: the store's own trouble is not the connection's.
      console.error("[live] retryOwed threw");
    }
  }

  function wakeAll(): void {
    stopSignal();
    for (const w of [...wakers]) w();
  }

  /** Waits `ms`, or less if the transport is stopped. The caller checks `alive()` afterwards. */
  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(t);
        wakers.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      wakers.add(done);
    });
  }

  /** Ends the transport for a fixed reason and tells the app. */
  function terminate(cause: NonNullable<typeof terminalCause>): void {
    if (terminalCause !== null || finalEmitted) return;
    terminalCause = cause;
    epoch++;
    active?.abort();
    wakeAll();
    setState({ state: "stopped", cause });
  }

  /** Never reads server text into the transport: only the fixed `error` word, and only when it is a short plain word. */
  async function errorWord(res: Response): Promise<string> {
    try {
      const j = (await res.json()) as unknown;
      const e = typeof j === "object" && j !== null ? (j as Record<string, unknown>).error : undefined;
      return typeof e === "string" && /^[a-z_]{1,64}$/.test(e) ? e : "";
    } catch {
      return "";
    }
  }

  async function discard(res: Response): Promise<void> {
    try {
      await res.body?.cancel();
    } catch {
      // Nothing to do: the body is being thrown away anyway.
    }
  }

  // --- One request, with credentials asked fresh every time ---
  // A proof of possession is single-use, so the provider is asked for every request, with the exact address.
  async function request(url: string, kind: "stream" | "feed", signal: AbortSignal): Promise<Response> {
    let refresh = pendingRefresh;
    pendingRefresh = false;
    for (;;) {
      let headers: Record<string, string>;
      try {
        if (refresh) counters.authRefreshes++;
        const given: unknown = await options.auth({ method: "GET", url }, { refresh });
        if (typeof given !== "object" || given === null || Array.isArray(given)) throw new Error("bad headers");
        headers = {};
        for (const [k, v] of Object.entries(given as Record<string, unknown>)) {
          const name = k.toLowerCase();
          if (typeof v === "string" && !FORBIDDEN_HEADERS.has(name)) headers[name] = v;
        }
      } catch {
        // The provider's own message may hold a token, so it is dropped here and never reaches a state or an error.
        throw new Failure("auth_provider_failed");
      }
      headers.accept = kind === "stream" ? "text/event-stream" : "application/json";
      if (signal.aborted) throw new Failure("aborted");
      if (kind === "stream") counters.streamRequests++;
      else counters.feedRequests++;
      let res: Response;
      try {
        res = await fetchFn(url, { method: "GET", headers, signal, cache: "no-store", credentials: "omit", redirect: "error" });
      } catch {
        throw new Failure("network");
      }
      if (res.status !== 401) return res;
      await discard(res);
      // One refresh per refusal: a second 401 in a row means the credentials are really not accepted.
      if (refresh) throw new Terminal("unauthorized");
      refresh = true;
    }
  }

  // --- The change feed: heads and pages ---
  async function feedJson(url: string, signal: AbortSignal): Promise<unknown> {
    const res = await request(url, "feed", signal);
    const status = res.status;
    if (status === 200) {
      try {
        return (await res.json()) as unknown;
      } catch {
        throw new Failure("bad_page");
      }
    }
    // A 404 cannot be told from "no access", and retrying a refusal only hammers the server, so it ends here.
    if (status === 403 || status === 404) {
      await discard(res);
      throw new Terminal("refused");
    }
    if (status === 400) {
      const word = await errorWord(res);
      if (word === "since_cursor_invalid") throw new Failure("bad_cursor", 0, true);
      throw new Terminal("bad_request");
    }
    const header = res.headers.get("retry-after");
    await discard(res);
    throw new Failure(status === 429 ? "http_429" : status >= 500 ? "http_5xx" : "http_other", status === 429 || header !== null ? retryAfterMs(header) : 0);
  }

  /** The current position of a feed: a page with no rows whose `nextCursor` is the head. */
  async function fetchHead(lifecycle: "live" | "ended", signal: AbortSignal): Promise<string> {
    const page = parseFeedPage(await feedJson(feedUrl(origin, vaultId, { since: "head", lifecycle, types }), signal));
    if (page === null || page.nextCursor === null) throw new Failure("bad_page");
    return page.nextCursor;
  }

  /**
   * Takes the head cursors, THEN asks the app for its full read, so a change made while the app reads is still ahead of
   * the cursors. A failure (of the heads or of the app) waits a back-off delay and tries again, five times at most.
   */
  async function resyncWithHeads(reason: "bad_cursor" | "poll_start", wantEnded: boolean, signal: AbortSignal): Promise<{ live: string; ended: string }> {
    for (let attempt = 1; ; attempt++) {
      try {
        const live = await fetchHead("live", signal);
        const ended = wantEnded ? await fetchHead("ended", signal) : "";
        if (!alive()) throw new Failure("aborted");
        counters.resyncs++;
        const outcome = await Promise.race([Promise.resolve().then(() => options.resync(reason)).then(() => "done" as const), stopped.then(() => "stop" as const)]);
        if (outcome === "stop" || !alive()) throw new Failure("aborted");
        confirm();
        retryOwed();
        return { live, ended };
      } catch (e) {
        if (e instanceof Terminal) throw e;
        if (!alive()) throw new Failure("aborted");
        if (attempt >= MAX_RESYNC_FAILURES) throw new Terminal("resync_failed");
        await sleep(nextBackoffMs(attempt, backoff, random));
        if (!alive()) throw new Failure("aborted");
      }
    }
  }

  /** Pushes to the store, only while this epoch is still the current one. Returns false when it was discarded. */
  function pushIfCurrent(ep: number, notifications: ReturnType<typeof notificationsFromFeed>): boolean {
    if (ep !== epoch || !alive()) return false;
    for (const n of notifications) {
      store.push(n);
      counters.framesPushed++;
      if (n.cursor !== null) cursorOverride = null;
    }
    return true;
  }

  // --- Connection failures ---
  /** A lost connection: count it, wait a back-off delay, or give up on the stream for a while and poll. */
  async function fail(cause: string, waitMs = 0): Promise<void> {
    failures++;
    if (probing) {
      // A probe from poll mode that fails simply leaves the transport polling; the next probe is a full interval away.
      probing = false;
      nextStreamTryAt = Date.now() + streamProbeMs;
      phase = "poll";
      return;
    }
    if (failures >= failuresBeforePoll) {
      nextStreamTryAt = Date.now() + streamProbeMs;
      toPoll("failures");
      return;
    }
    const delay = Math.max(nextBackoffMs(failures, backoff, random), retryHint, waitMs);
    counters.reconnects++;
    setState({ state: "reconnecting", cause, retryInMs: delay, quiet: false });
    await sleep(delay);
  }

  function toPoll(reason: "no_stream" | "capacity" | "failures"): void {
    pollReason = reason;
    phase = "poll";
    probing = false;
    slowCount = 0;
  }

  // --- The stream ---
  async function streamPhase(): Promise<void> {
    const ep = ++epoch;
    const ac = new AbortController();
    active = ac;
    // The resume point: a held override, else what the store last saw, else where the app asked us to start.
    // It goes in the query only, never in a header: one way to resume, so nothing can disagree.
    const since = cursorOverride ?? store.lastCursor() ?? from;
    const url = liveUrl(origin, vaultId, { types, since: since === "head" ? undefined : since });
    let res: Response;
    try {
      res = await request(url, "stream", ac.signal);
    } catch (e) {
      if (e instanceof Terminal) throw e;
      if (!alive()) return;
      await fail(e instanceof Failure ? e.cause : "network", e instanceof Failure ? e.waitMs : 0);
      return;
    }
    const status = res.status;
    if (status === 200) {
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (!type.startsWith("text/event-stream")) {
        // A proxy page or similar: never parsed.
        await discard(res);
        await fail("bad_content_type");
        return;
      }
      afterReseed = false;
      await readStream(res, ac, ep);
      return;
    }
    if (status === 400) {
      const word = await errorWord(res);
      // A reseed is tried once. If the very next open is refused too, the server is at fault and a loop would hide it.
      if (word === "since_cursor_invalid" && !afterReseed) {
        setState({ state: "resyncing", cause: "bad_cursor" });
        const heads = await resyncWithHeads("bad_cursor", false, ac.signal);
        cursorOverride = heads.live; // the store learns cursors only from events, so it would still offer the bad one
        pollCursors = null;
        afterReseed = true;
        return;
      }
      throw new Terminal("bad_request");
    }
    if (status === 403) {
      // An explicit refusal is final. It is not probed: the server has said "no" in so many words.
      await discard(res);
      throw new Terminal("refused");
    }
    if (status === 404) {
      await discard(res);
      await probeFeedAfterStream404(ac.signal);
      return;
    }
    if (status === 429) {
      const wait = retryAfterMs(res.headers.get("retry-after"));
      await discard(res);
      nextStreamTryAt = Date.now() + Math.max(wait, streamProbeMs);
      toPoll("capacity");
      return;
    }
    if (status === 501) {
      const word = await errorWord(res);
      if (word === "live_not_available_here") {
        streamAllowed = false; // for the life of this transport: this is not an error and not a loop
        toPoll("no_stream");
        return;
      }
      await fail("http_5xx");
      return;
    }
    const header = res.headers.get("retry-after");
    await discard(res);
    await fail(status >= 500 ? "http_5xx" : "http_other", header !== null ? retryAfterMs(header) : 0);
  }

  /**
   * A 404 on the stream is not final: an app on a platform without the `/live` route must still be able to poll, so the
   * poll feed is asked ONCE (the `since=head` request, with the usual auth and the one 401 refresh). The feed is the
   * probe because it refuses a viewer with no access in exactly the way the stream does (403 or 404, which `feedJson`
   * turns into a final `refused`), so a viewer with no access learns nothing the stream's 404 had not told them and
   * costs one extra request. A 403 on the stream is never probed. A failure of the probe that is not a refusal (a 5xx, a
   * 429, a network loss, a bad page) says nothing about access, so it ends nothing: the usual back-off runs and the next
   * stream try meets the 404 again and probes again.
   *
   * @param signal aborts the probe when the phase is left or the transport stops
   * @returns when the transport has been sent to poll mode, or a failure has been counted; throws `Terminal("refused")`
   *   when the feed refuses too
   */
  async function probeFeedAfterStream404(signal: AbortSignal): Promise<void> {
    try {
      await fetchHead("live", signal);
    } catch (e) {
      if (e instanceof Terminal) throw e;
      if (!alive()) return;
      await fail(e instanceof Failure ? e.cause : "network", e instanceof Failure ? e.waitMs : 0);
      return;
    }
    if (!alive()) return;
    // The route is not there: for the life of this transport, as for a 501 "not available here". Poll mode takes its own
    // heads and the app's read from here; the probe's answer is only proof that the feed can be read.
    streamAllowed = false;
    toPoll("no_stream");
  }

  async function readStream(res: Response, ac: AbortController, ep: number): Promise<void> {
    probing = false;
    setState({ state: "live", mode: "stream" });
    retryOwed();
    const reader = res.body?.getReader();
    if (!reader) {
      distrust = true;
      await fail("cut");
      return;
    }
    const openedAt = Date.now();
    let delivered = false;
    let closedReason: string | null = null;
    let watchdogFired = false;
    let tooLarge = false;
    let readFailed = false;
    // Whether THIS connection has said anything beyond its opening line: a comment (a heartbeat) or any event.
    let contentSeen = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A stream that goes quiet for longer than two missed heartbeats is dead even if the socket looks open.
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        watchdogFired = true;
        ac.abort();
      }, heartbeatTimeoutMs);
    };
    const parser = createSseParser({
      onRetry: (ms) => { retryHint = clampRetryHintMs(ms); },
      // Any comment line is the server speaking (today a heartbeat, later perhaps a statement from the hub), so it is
      // content. A `retry:` line is not: it is part of the opening line and is handled by `onRetry`.
      onComment: () => {
        contentSeen = true;
        distrust = false;
      },
      onEvent: (e) => {
        // Every event is content, a `closed` frame included: it is the server speaking, and a quiet renewal that ends
        // with one must leave the next connection trusted.
        contentSeen = true;
        distrust = false;
        if (closedReason !== null) return;
        if (e.event === "closed") {
          let reason = "unknown";
          try {
            const j = JSON.parse(e.data) as unknown;
            const r = typeof j === "object" && j !== null ? (j as Record<string, unknown>).reason : undefined;
            if (typeof r === "string" && /^[a-z_]{1,32}$/.test(r)) reason = r;
          } catch {
            // Not JSON: the reason stays unknown.
          }
          closedReason = reason;
          return;
        }
        if (e.event !== "change" && e.event !== "ended") {
          counters.framesIgnored++;
          return;
        }
        let data: unknown;
        try {
          data = JSON.parse(e.data);
        } catch {
          counters.framesIgnored++;
          return;
        }
        const n = parseLiveNotification(data, e.id);
        if (n === null) {
          counters.framesIgnored++;
          return;
        }
        // Checked in the same synchronous block as the push: a frame that arrives after a switch is never applied.
        if (ep !== epoch || !alive()) return;
        store.push(n);
        counters.framesPushed++;
        delivered = true;
        pushedSincePoll = true;
        if (n.cursor !== null) cursorOverride = null;
        confirm();
      },
    });
    arm();
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        if (ep !== epoch || !alive()) break;
        // Re-armed for every chunk, even one that will not confirm: a connection that only ever sends its opening line
        // must still be cut by the watchdog, not held for ever.
        arm();
        try {
          parser.feed(r.value);
        } catch {
          tooLarge = true;
          break;
        }
        // Judged AFTER parsing, so a chunk that holds the opening line and a heartbeat counts as content. A connection
        // that follows a good one (or is the first) confirms on its opening line at once: a reconnect after a healthy
        // connection must not look "reconnecting" for a whole heartbeat period.
        if (contentSeen || !distrust) confirm();
        if (closedReason !== null) break;
      }
    } catch {
      readFailed = true;
    } finally {
      // The request is fully ended before anything else starts: the reader is released and the connection aborted.
      clearTimeout(timer);
      ac.abort();
      try {
        await reader.cancel();
      } catch {
        // The stream is already broken or aborted; there is nothing left to release.
      }
    }
    // The parser is dropped with the connection: a half frame is never applied; the last pushed cursor is the resume point.
    if (!alive()) return;
    // Not for the app's own stop (returned above): a connection the app ended says nothing about the server.
    // A connection the watchdog cut ended in silence even if it spoke earlier, so it cannot vouch for the next one: if it
    // could, the opening line of the very next connection would bring "Live" back for a whole heartbeat period.
    if (!contentSeen || watchdogFired) distrust = true;
    if (delivered || Date.now() - openedAt >= stableMs) failures = 0;
    if (closedReason === null) {
      slowCount = 0;
      await fail(watchdogFired ? "watchdog" : tooLarge ? "event_too_large" : readFailed ? "cut" : "ended");
      return;
    }
    await afterClosed(closedReason);
  }

  async function afterClosed(reason: string): Promise<void> {
    if (reason !== "slow_consumer") slowCount = 0;
    switch (reason) {
      case "revoked":
        // Also means "signed out". Access is gone: retrying would only hammer the server.
        throw new Terminal("revoked");
      case "max_age":
      case "token_expired": {
        // Routine renewal, not a fault: no failure is counted and the delay stays tiny and random.
        if (reason === "token_expired") pendingRefresh = true;
        const delay = Math.floor(Math.min(1, Math.max(0, random())) * (QUIET_RECONNECT_MAX_MS + 1));
        counters.reconnects++;
        setState({ state: "reconnecting", cause: reason, retryInMs: delay, quiet: true });
        await sleep(delay);
        return;
      }
      case "shed":
        nextStreamTryAt = Date.now() + Math.max(SHED_MIN_WAIT_MS, streamProbeMs);
        toPoll("capacity");
        return;
      case "slow_consumer":
        slowCount++;
        if (slowCount >= SLOW_CONSUMER_LIMIT) {
          nextStreamTryAt = Date.now() + streamProbeMs;
          toPoll("failures");
          return;
        }
        await fail("closed_slow_consumer");
        return;
      case "recheck_failed":
        await fail("closed_recheck_failed");
        return;
      case "shutdown":
        await fail("closed_shutdown");
        return;
      default:
        await fail("closed_unknown");
    }
  }

  // --- Poll mode ---
  /** One tick: the live feed page by page, then the ended feed with its OWN cursor (the two cursors have different scopes). */
  async function tick(ep: number, signal: AbortSignal): Promise<void> {
    const cursors = pollCursors;
    if (cursors === null) return;
    const live = await readFeed("change", cursors.live, ep, signal);
    const ended = await readFeed("ended", cursors.ended, ep, signal);
    // Cursors move only when the whole tick succeeded, so a tick that failed halfway is read again from the same place.
    if (ep !== epoch || !alive()) return;
    pollCursors = { live, ended };
  }

  async function readFeed(kind: "change" | "ended", start: string, ep: number, signal: AbortSignal): Promise<string> {
    let cursor = start;
    for (let pages = 0; pages < MAX_PAGES_PER_TICK; pages++) {
      const url = feedUrl(origin, vaultId, { since: cursor, lifecycle: kind === "ended" ? "ended" : "live", types, limit: 200 });
      const page = parseFeedPage(await feedJson(url, signal));
      if (page === null) throw new Failure("bad_page");
      if (!pushIfCurrent(ep, notificationsFromFeed(page, kind, clock()))) throw new Failure("aborted");
      const next = page.nextCursor ?? cursor;
      if (page.complete) return next;
      if (page.nextCursor === null || page.nextCursor === cursor) throw new Failure("bad_page");
      cursor = page.nextCursor;
    }
    throw new Failure("bad_page");
  }

  async function pollPhase(): Promise<void> {
    const ep = ++epoch;
    const ac = new AbortController();
    active = ac;
    // A new poll phase after the stream pushed anything must read the list again: the cursors are from before.
    if (pushedSincePoll) pollCursors = null;
    let announced = false;
    const announce = (): void => {
      if (announced) return;
      announced = true;
      if (current.state !== "polling") setState({ state: "polling", reason: pollReason });
    };
    while (alive() && phase === "poll") {
      if (pollCursors === null) {
        setState({ state: "resyncing", cause: "poll_start" });
        // Heads first, then the app's read (inside), so a change made during the read is not lost.
        pollCursors = await resyncWithHeads("poll_start", true, ac.signal);
        pushedSincePoll = false;
        if (!alive()) return;
      }
      announce();
      let wait = pollMs;
      try {
        await tick(ep, ac.signal);
        pollFailures = 0;
        pollReseeded = false;
        // The feed just answered with our position, which is real news about currency, so the doubt is over.
        distrust = false;
        confirm();
        retryOwed();
      } catch (e) {
        if (e instanceof Terminal) throw e;
        if (!alive()) return;
        if (e instanceof Failure && e.badCursor) {
          // The poll's own position was refused: read the list again once; a second refusal in a row is final.
          if (pollReseeded) throw new Terminal("bad_request");
          pollReseeded = true;
          pollCursors = null;
          announced = false;
          continue;
        }
        pollFailures++;
        wait = Math.max(nextBackoffMs(pollFailures, backoff, random), e instanceof Failure ? e.waitMs : 0);
      }
      if (!alive()) return;
      await sleep(wait);
      if (!alive()) return;
      if (streamAllowed && Date.now() >= nextStreamTryAt && pollCursors !== null) {
        // Back to the stream: the tick has finished and ended, and the stream starts from the poller's position.
        cursorOverride = pollCursors.live;
        phase = "stream";
        probing = true;
        ac.abort();
        return;
      }
    }
  }

  // --- The runner: one loop, so only one source can ever be active ---
  async function main(): Promise<void> {
    setState({ state: "connecting" });
    while (alive()) {
      try {
        if (phase === "stream") await streamPhase();
        else await pollPhase();
      } catch (e) {
        if (e instanceof Terminal) {
          terminate(e.cause);
          return;
        }
        if (!alive()) return;
        // Not expected. Treated as a lost connection so that a fault cannot become a tight loop.
        await fail("network");
      }
    }
  }

  return {
    start(): void {
      if (started || stopping || terminalCause !== null) return;
      started = true;
      runner = main();
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopping = true;
      epoch++;
      active?.abort();
      wakeAll();
      stopPromise = (async () => {
        if (runner) await runner;
        if (terminalCause === null) terminalCause = "stopped_by_app";
        setState({ state: "stopped", cause: terminalCause });
      })();
      return stopPromise;
    },
    state: () => current,
    mode: () => (current.state === "live" ? "stream" : current.state === "polling" ? "poll" : null),
    stats: () => ({ ...counters }),
  };
}
