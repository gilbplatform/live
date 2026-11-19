import { createCoalescer } from "./coalescer.js";
import type { Coalescer } from "./coalescer.js";
import { createConfirmationClock } from "./confirm.js";
import type { ConfirmationClock } from "./confirm.js";
import { feedUrl, normalizeOrigin, parseFeedPage } from "./feed.js";
import { createLiveSession, watchVisibility } from "./session.js";
import type { LiveSession, TransportLike, VisibilityPage } from "./session.js";
import { createDotMachine } from "./state.js";
import type { DotMachine, DotState, TransportStateLike } from "./state.js";
import { createStateCache } from "./state-cache.js";
import type { LiveCache, StateCache } from "./state-cache.js";
import { createLiveStore } from "./store.js";
import { createLiveTransport } from "./transport.js";
import type { LiveChange, LiveStore, LiveStoreOptions } from "./types.js";

/** One row of the app's full read: the address, the type, the version tag, the source time (if known) and the record itself. */
export interface SeedRow<T> {
  entity: string;
  typeUri: string;
  etag: string | null;
  updatedAt?: string | null;
  record: T;
}

/**
 * Gives the request headers for one request. In: the request (method and address) and whether a fresh credential is needed
 * (`refresh: true` after a refusal). Out: the headers, directly or as a promise. The same shape as the transport's provider.
 */
export type AuthProviderLike = (
  request: { method: "GET"; url: string },
  context: { refresh: boolean },
) => Promise<Record<string, string>> | Record<string, string>;

/** Everything the app's transport factory is given to build one transport. */
export interface TransportFactoryContext<T> {
  store: LiveStore<T>;
  clock: ConfirmationClock;
  origin: string;
  vaultId: string;
  types: readonly string[];
  auth: AuthProviderLike;
  /** Where the stream starts: the head cursor, `start`, or a cursor from a cache or from the store. */
  from: string;
  /** The store's cursor at the moment this transport was made, or null. */
  resumeCursor: string | null;
  /** The transport calls this when its position is lost (`bad_cursor`) or it begins to poll (`poll_start`). */
  resync: (reason: "bad_cursor" | "poll_start") => Promise<void>;
  /** The transport reports every change of its state here. */
  onState: (s: TransportStateLike) => void;
  /** The transport reports every sign that the server spoke (a heartbeat, an event) here, with its time. */
  onConfirm: (atMs: number) => void;
  fetch?: typeof fetch;
}

/** What you give `createLiveClient`. */
export interface LiveClientOptions<T> {
  /** The server origin, `scheme://host[:port]`. */
  origin: string;
  vaultId: string;
  /** The bare type names to follow. At least one. */
  types: readonly string[];
  auth: AuthProviderLike;
  read?: LiveStoreOptions<T>["read"];
  readBatch?: LiveStoreOptions<T>["readBatch"];
  readBatchSize?: number;
  /** The app's full read of the list. Called for `initial` (before the stream), and when the transport asks for a resync. */
  resync: (reason: "initial" | "bad_cursor" | "poll_start") => Promise<ReadonlyArray<SeedRow<T>>>;
  /**
   * Makes ONE transport. A new one is made after a long hidden time. Optional: without it the client uses the kit's own
   * transport (`createLiveTransport`), started from `ctx.from`. Give it to use another transport, or a fake in a test.
   */
  createTransport?: (ctx: TransportFactoryContext<T>) => TransportLike;
  fetch?: typeof fetch;
  /** The app's storage, bound to its own key. Give it together with `cacheScope`, or give neither. */
  cache?: LiveCache<T>;
  cacheScope?: string;
  /** Gives the entity address of a record. Needed only for `records()`. */
  keyOf?: (record: T) => string;
  holdMs?: number;
  coalesceMs?: number;
  /** The least time between two screen-time ticks (`subscribeTick`), in ms. Default 1000; 0 gives a tick for every confirmation. */
  tickMinIntervalMs?: number;
  /** How many times a failed record read is retried before the record is parked (an integer from 1 to 50, default 6). A parked record is tried again on every reconnect and good poll. */
  maxReadAttempts?: LiveStoreOptions<T>["maxReadAttempts"];
  /** The back-off between retries of a failed record read, in ms. Default 500 up to 30000. */
  owedBackoff?: LiveStoreOptions<T>["owedBackoff"];
  /** Tells whether a failed read means "gone for this viewer". Default: status 403, 404 or 410, or an error marked `gone`. */
  isGone?: LiveStoreOptions<T>["isGone"];
  schedule?: (run: () => void) => () => void;
  hiddenCloseMs?: number;
  keepLive?: boolean;
  heartbeatWindowMs?: number;
  pollWindowMs?: number;
  offlineAfterMs?: number;
  /** The browser's page object; with it the client closes the connection after a long hidden time. */
  page?: VisibilityPage;
  now?: () => number;
}

/** The client: one vault, one set of types, one list kept live. */
export interface LiveClient<T> {
  /** Reads the starting position and the list, then opens the connection. Once; later calls return the same promise. */
  start(): Promise<void>;
  /** Ends the client for good. Safe to call twice. A stopped client is never started again: make a new one. */
  stop(): Promise<void>;
  store: LiveStore<T>;
  /** Calls `fn` with every delivered change, one per period. The first is the whole list (`full: true`). Returns the function that stops it. */
  subscribe(fn: (c: LiveChange<T>) => void): () => void;
  /** The delivered list. Needs `keyOf` (the entity address of a record), else it throws. The same array until the next delivery. */
  records(): T[];
  dot(): DotState;
  subscribeDot(fn: (s: DotState) => void): () => void;
  pause(): void;
  resume(): void;
  paused(): boolean;
  /** How many records changed since the screen was last updated. */
  waiting(): number;
  subscribeWaiting(fn: (n: number) => void): () => void;
  /** Tell the client whether the page is shown (also done by `page`). */
  setVisible(v: boolean): void;
  setKeepLive(b: boolean): void;
  lastConfirmedAt(): number | null;
  screenConfirmedAt(): number | null;
  subscribeTick(fn: (at: number) => void): () => void;
  /** How many records are owed: announced by the server, but their read failed and has not yet succeeded. While above 0 the dot never says Live. */
  owed(): number;
  /** Calls `fn` with the new count each time the number of owed records changes. Returns the function that stops it. */
  subscribeOwed(fn: (owed: number) => void): () => void;
  /** True while the list is a restored one that the server has not confirmed. */
  stale(): boolean;
  /** Calls `fn` each time `stale()` changes (true after a restore, false once confirmed). Returns the function that stops it. */
  subscribeStale(fn: (stale: boolean) => void): () => void;
  /** Saves the cache now. */
  flushCache(): Promise<void>;
}

/** The kit's own transport, built from the factory context. Used when the app gives no `createTransport`. */
function defaultTransport<T>(ctx: TransportFactoryContext<T>): TransportLike {
  return createLiveTransport({
    // The transport only hands the store notifications, so the record type does not matter to it.
    store: ctx.store as LiveStore<unknown>,
    origin: ctx.origin,
    vaultId: ctx.vaultId,
    types: ctx.types,
    auth: ctx.auth,
    resync: ctx.resync,
    from: ctx.from,
    onState: ctx.onState,
    onConfirm: ctx.onConfirm,
    ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
  });
}

const PLAIN_HEAD_FAILURE = "could not read the starting position";

/**
 * Puts the kit's pieces together for one vault and one set of types.
 *
 * @param options see `LiveClientOptions`; the origin, the types and the cache pair are checked here and throw a plain `Error`
 * @returns the client; nothing runs until `start()`
 */
export function createLiveClient<T>(options: LiveClientOptions<T>): LiveClient<T> {
  // --- Validation ---
  // Everything is checked before anything is built, so a bad option leaves no timer or listener behind.
  const origin = normalizeOrigin(options.origin);
  if (typeof options.vaultId !== "string" || options.vaultId === "") throw new Error("a live client needs a vaultId");
  if (!Array.isArray(options.types) || options.types.length === 0) throw new Error("a live client needs at least one type name");
  const types: readonly string[] = [...options.types];
  // The address builder holds the rules for a bare type name; reuse it instead of copying them.
  feedUrl(origin, options.vaultId, { since: "head", types });
  if ((options.cache === undefined) !== (options.cacheScope === undefined)) throw new Error("cache and cacheScope go together: give both or neither");
  // Absent means the kit's own transport; anything else that is not a function is a mistake worth refusing.
  if (options.createTransport !== undefined && typeof options.createTransport !== "function") throw new Error("createTransport must be a function");
  if (typeof options.resync !== "function") throw new Error("a live client needs resync");
  if (typeof options.auth !== "function") throw new Error("a live client needs auth");
  if (typeof options.read !== "function" && typeof options.readBatch !== "function") throw new Error("a live store needs read or readBatch");
  const vaultId = options.vaultId;
  const keyOf = options.keyOf;
  const makeTransport = options.createTransport ?? defaultTransport<T>;

  // --- Listeners ---
  const changeListeners = new Set<(c: LiveChange<T>) => void>();
  const dotListeners = new Set<(s: DotState) => void>();
  const waitingListeners = new Set<(n: number) => void>();
  const tickListeners = new Set<(at: number) => void>();
  const staleListeners = new Set<(stale: boolean) => void>();
  const owedListeners = new Set<(owed: number) => void>();

  // A listener is the app's code: one that throws must not stop the others or the client. Only the message is logged,
  // because the argument may hold record data.
  function fire<A>(set: ReadonlySet<(a: A) => void>, arg: A, label: string): void {
    for (const fn of [...set]) {
      try {
        fn(arg);
      } catch (error) {
        console.error(`[live] a ${label} listener threw: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  }

  function add<A>(set: Set<(a: A) => void>, fn: (a: A) => void): () => void {
    if (stopped) return () => {};
    set.add(fn);
    return () => { set.delete(fn); };
  }

  // --- State ---
  let stopped = false;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let startFrom: string | null = null;
  const headAbort = new AbortController();
  let list: T[] = [];

  // --- The pieces ---
  const clock = createConfirmationClock({ now: options.now });
  const store = createLiveStore<T>({
    read: options.read,
    readBatch: options.readBatch,
    readBatchSize: options.readBatchSize,
    holdMs: options.holdMs,
    maxReadAttempts: options.maxReadAttempts,
    owedBackoff: options.owedBackoff,
    isGone: options.isGone,
    now: options.now,
  });

  let dotMachine: DotMachine | null = null;

  /** The delivered list is mirrored here, so the app can read it without keeping its own copy. */
  function mirror(change: LiveChange<T>): void {
    if (!keyOf) return;
    try {
      if (change.full) {
        list = [...change.records];
        return;
      }
      const next = [...list];
      const at = new Map<string, number>();
      next.forEach((r, i) => { at.set(keyOf(r), i); });
      // A changed record keeps its place; a new one goes to the end, as the app's own list does.
      for (const r of change.records) {
        const key = keyOf(r);
        const i = at.get(key);
        if (i === undefined) {
          at.set(key, next.length);
          next.push(r);
        } else {
          next[i] = r;
        }
      }
      if (change.ended.length > 0) {
        const gone = new Set(change.ended);
        list = next.filter((r) => !gone.has(keyOf(r)));
      } else {
        list = next;
      }
    } catch (error) {
      console.error(`[live] keyOf threw: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  const coalescer: Coalescer<T> = createCoalescer<T>(store, {
    intervalMs: options.coalesceMs,
    schedule: options.schedule,
    now: options.now,
    clock,
    tickMinIntervalMs: options.tickMinIntervalMs,
    owed: () => store.owed(),
    onApply: (change) => {
      mirror(change);
      fire(changeListeners, change, "change");
      // Data first, then the status it may have changed; the screen time the coalescer reports after this call comes last.
      dotMachine?.refresh();
    },
    onWaiting: (n) => {
      fire(waitingListeners, n, "waiting");
      dotMachine?.refresh();
    },
    onTick: (at) => { fire(tickListeners, at, "tick"); },
  });

  dotMachine = createDotMachine({
    clock,
    coalescer,
    owed: () => store.owed(),
    now: options.now,
    heartbeatWindowMs: options.heartbeatWindowMs,
    pollWindowMs: options.pollWindowMs,
    offlineAfterMs: options.offlineAfterMs,
    onChange: (s) => {
      // Access is gone: the records that were owed can never be read by this viewer, and a retry would only be refused.
      if (s.kind === "stopped" && (s.cause === "access_removed" || s.cause === "no_access" || s.cause === "signed_out")) store.clearOwed();
      fire(dotListeners, s, "dot");
    },
  });
  const dotNow = dotMachine;

  // The screen time and the dot both depend on the owed count: the coalescer first (it may catch its time up), then the dot.
  store.subscribeOwed((count) => {
    coalescer.recheck();
    dotNow.refresh();
    fire(owedListeners, count, "owed");
  });

  /** The transport asks for a new list: read it, replace the store's rows and show it at once. */
  async function resync(reason: "bad_cursor" | "poll_start"): Promise<void> {
    if (stopped) return;
    const rows = await options.resync(reason);
    if (stopped) return;
    store.seed(rows);
    coalescer.flushNow();
  }

  /** The context for one transport. `from` is the store's cursor when it has one, else the position the client started from. */
  function transportContext(resumeCursor: string | null): TransportFactoryContext<T> {
    return {
      store,
      clock,
      origin,
      vaultId,
      types,
      auth: options.auth,
      from: resumeCursor ?? startFrom ?? "head",
      resumeCursor,
      resync,
      onState: (s) => { dotNow.feedTransport(s); },
      onConfirm: (at) => { clock.confirm(at); },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    };
  }

  const session: LiveSession = createLiveSession({
    // A new transport is made here every time the session needs one, from the cursor the store holds at that moment.
    createTransport: ({ resumeCursor }) => makeTransport(transportContext(resumeCursor)),
    getResumeCursor: () => store.lastCursor(),
    hiddenCloseMs: options.hiddenCloseMs,
    keepLive: options.keepLive,
    now: options.now,
    onShow: () => { coalescer.flushNow(); },
    onState: (s) => { dotNow.feedSession(s); },
  });
  const unwatch = options.page ? watchVisibility(session, options.page) : null;

  const stateCache: StateCache<T> | null = options.cache && options.cacheScope !== undefined
    ? createStateCache<T>({
      store, cache: options.cache, scope: options.cacheScope, clock, now: options.now,
      onStaleChange: (value) => { fire(staleListeners, value, "stale"); },
    })
    : null;
  stateCache?.attach();

  // --- Starting position ---
  async function readHead(): Promise<string> {
    const url = feedUrl(origin, vaultId, { since: "head", types });
    const fetchFn = options.fetch ?? globalThis.fetch;
    try {
      // One retry with a fresh credential after a refusal, and never more: a loop here would hammer a server that says no.
      for (let attempt = 0; attempt < 2; attempt++) {
        const headers = await options.auth({ method: "GET", url }, { refresh: attempt === 1 });
        const res = await fetchFn(url, { method: "GET", headers, signal: headAbort.signal });
        if (res.status === 401 && attempt === 0) {
          void res.body?.cancel().catch(() => {});
          continue;
        }
        if (!res.ok) break;
        const page = parseFeedPage(await res.json());
        if (page === null || page.nextCursor === null) break;
        return page.nextCursor;
      }
    } catch {
      // The cause may hold the address or a header; the caller gets the plain message below.
    }
    throw new Error(PLAIN_HEAD_FAILURE);
  }

  async function run(): Promise<void> {
    if (stopped) return;
    let from: string | null = null;
    let needsRead = true;
    // --- Restore ---
    if (stateCache) {
      const restored = await stateCache.restore();
      if (stopped) return;
      if (restored.restored) {
        // Show what was kept at once; it is marked stale until the server has confirmed it.
        coalescer.flushNow();
        if (restored.cursor !== null) {
          // The stream catches up from the saved cursor, so no full read is needed; a cursor the server refuses reseeds through resync.
          from = restored.cursor;
          needsRead = false;
        }
      }
    }
    if (needsRead) {
      // --- Head, then read ---
      // The head is taken BEFORE the list is read: a change made between the read and the connection would otherwise be in
      // neither. With the head first, the stream starts at the head and replays everything after it.
      from = await readHead();
      if (stopped) return;
      const rows = await options.resync("initial");
      if (stopped) return;
      store.seed(rows);
      coalescer.flushNow();
    }
    // --- Stream ---
    // Only now, after the seed: a stream that started earlier would deliver into rows that the seed then replaces.
    startFrom = from;
    session.start();
  }

  return {
    start(): Promise<void> {
      if (!startPromise) startPromise = run();
      return startPromise;
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      // A stopped transport is finished and cannot be restarted, so stop is terminal: the app makes a new client.
      stopped = true;
      headAbort.abort();
      changeListeners.clear();
      dotListeners.clear();
      waitingListeners.clear();
      tickListeners.clear();
      staleListeners.clear();
      owedListeners.clear();
      stopPromise = (async () => {
        await session.stop();
        try {
          await stateCache?.flush();
        } catch {
          // A cache that fails to save must not keep the client from closing.
        }
        unwatch?.();
        stateCache?.close();
        coalescer.close();
        dotNow.close();
        store.close();
      })();
      return stopPromise;
    },
    store,
    subscribe: (fn) => add(changeListeners, fn),
    records(): T[] {
      if (!keyOf) throw new Error("records() needs a keyOf function");
      return list;
    },
    dot: () => dotNow.state(),
    subscribeDot: (fn) => add(dotListeners, fn),
    pause(): void {
      coalescer.pause();
      dotNow.refresh();
    },
    resume(): void {
      coalescer.resume();
      dotNow.refresh();
    },
    paused: () => coalescer.paused(),
    waiting: () => coalescer.waiting(),
    subscribeWaiting: (fn) => add(waitingListeners, fn),
    setVisible: (v) => { session.setVisible(v); },
    setKeepLive: (b) => { session.setKeepLive(b); },
    lastConfirmedAt: () => clock.lastConfirmedAt(),
    screenConfirmedAt: () => coalescer.screenConfirmedAt(),
    subscribeTick: (fn) => add(tickListeners, fn),
    owed: () => store.owed(),
    subscribeOwed: (fn) => add(owedListeners, fn),
    stale: () => stateCache?.isStale() ?? false,
    subscribeStale: (fn) => add(staleListeners, fn),
    flushCache: () => (stateCache ? stateCache.flush() : Promise.resolve()),
  };
}
