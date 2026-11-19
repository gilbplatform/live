import type { ConfirmationClock } from "./confirm.js";
import type { LiveStore } from "./types.js";

/** The version of the saved state format. A state with another version is ignored. */
export const STATE_CACHE_VERSION = 1;
/** The default oldest state that is restored, in ms (7 days). */
export const DEFAULT_STATE_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
/** The default most rows in a saved or restored state. */
export const DEFAULT_STATE_MAX_ROWS = 5000;

const CURSOR_SHAPE = /^[A-Za-z0-9_-]{40,4096}$/;
// A saved time a little ahead of ours is clock skew; a long way ahead would never age out, so it is refused.
const MAX_FUTURE_SKEW_MS = 60_000;

/** The state that is saved: the rows the store held and the cursor to resume from. */
export interface CachedState<T> {
  version: 1;
  /** Who and what this state belongs to (for example the signed-in person and the vault). */
  scope: string;
  /** When it was saved, in epoch milliseconds. */
  savedAt: number;
  /** The resume cursor the store held, or null when there was no safe one. */
  cursor: string | null;
  rows: Array<{ entity: string; typeUri: string; etag: string | null; updatedAt: string | null; record: T }>;
}

/**
 * The storage the app supplies. The app builds it already bound to its own key (for example one per signed-in person and
 * vault) over whatever store it already has. The kit never opens any storage itself.
 */
export interface LiveCache<T> {
  /** Returns the saved state (anything), or null when there is none. */
  load(): Promise<unknown | null> | unknown | null;
  /** Saves the state, replacing the old one. */
  save(state: CachedState<T>): Promise<void> | void;
  /** Deletes the saved state. */
  remove?(): Promise<void> | void;
}

/** Why a restore did or did not happen. */
export interface RestoreResult {
  restored: boolean;
  reason: "ok" | "empty" | "scope" | "version" | "shape" | "too_old" | "too_many" | "store_not_empty" | "load_failed";
  /** When the restored state was saved, or null. */
  savedAt: number | null;
  /** The newest source time among the restored rows (an ISO string), or null. The screen can say "as of" this. */
  asOf: string | null;
  /** The saved cursor: pass it to the transport as its starting point. Null when there is none or nothing was restored. */
  cursor: string | null;
  /** The number of restored rows. */
  rows: number;
  /**
   * True when the restore succeeded but the state has no cursor (it was saved while reads were pending). The app must then
   * do a full read and `store.seed(...)` (its resync) instead of trusting the restored rows: nothing can say what changed
   * since the save, so the state stays stale until a full change or `markFresh()`.
   */
  needsResync: boolean;
}

/** What you give `createStateCache`. */
export interface StateCacheOptions<T> {
  store: LiveStore<T>;
  cache: LiveCache<T>;
  /** Must equal the scope the state was saved with, or the state is ignored. Use one per person and vault. */
  scope: string;
  /** Its confirmations let a restored state become fresh. */
  clock?: ConfirmationClock;
  /** The oldest state that is restored. Default 7 days. */
  maxAgeMs?: number;
  /** The most rows that are restored or saved. Default 5000. */
  maxRows?: number;
  /** One save per this many ms after a change. Default 2000. */
  saveDebounceMs?: number;
  /** A restored state becomes fresh by a confirmation only after this many ms. Default 3000. */
  freshAfterMs?: number;
  /** Save an empty store too. Default false. */
  saveEmpty?: boolean;
  /** The time source. Default `Date.now`. */
  now?: () => number;
  /** Called with true when a state is restored (it is old) and with false when it becomes fresh. */
  onStaleChange?: (stale: boolean) => void;
}

/** The state cache: restores the last known state at once, marks it old, and saves the store as it changes. */
export interface StateCache<T> {
  /** Loads the saved state and seeds the store with it. Never throws. Pass `cursor` of the result as the transport's starting point. */
  restore(): Promise<RestoreResult>;
  /** Starts saving: one save per `saveDebounceMs` after the store changes. */
  attach(): void;
  /** True from a restore until the server has confirmed the state. */
  isStale(): boolean;
  /** The app says the state is confirmed (for example after its own full load). */
  markFresh(): void;
  /** Saves at once (also when the app is about to leave the page). */
  flush(): Promise<void>;
  /** Deletes the saved state. */
  clear(): Promise<void>;
  /** Cancels the save timer and drops the subscriptions. */
  close(): void;
  /** Counters for tests and diagnostics. */
  stats(): { loads: number; saves: number; loadFailed: number; saveFailed: number };
}

/**
 * An in-memory cache for tests and for apps with no storage. It copies on save and on load, so what you hold never changes
 * what is kept.
 */
export function createMemoryCache<T>(): LiveCache<T> {
  let slot: unknown = null;
  const copy = <X,>(x: X): X => JSON.parse(JSON.stringify(x)) as X;
  return {
    load: () => (slot === null ? null : copy(slot)),
    save: (state) => { slot = copy(state); },
    remove: () => { slot = null; },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const textOrNull = (v: unknown): boolean => v === null || typeof v === "string";

/**
 * Creates a state cache over a store and an app-supplied cache.
 *
 * @param options see `StateCacheOptions`
 */
export function createStateCache<T>(options: StateCacheOptions<T>): StateCache<T> {
  const { store, cache, scope } = options;
  const now = options.now ?? Date.now;
  const num = (v: unknown, fallback: number, min: number): number =>
    typeof v === "number" && !Number.isNaN(v) && v >= min ? v : fallback;
  const maxAge = num(options.maxAgeMs, DEFAULT_STATE_MAX_AGE_MS, 0);
  const maxRows = num(options.maxRows, DEFAULT_STATE_MAX_ROWS, 0);
  const debounce = num(options.saveDebounceMs, 2000, 0);
  const freshAfter = num(options.freshAfterMs, 3000, 0);

  const counters = { loads: 0, saves: 0, loadFailed: 0, saveFailed: 0 };
  let stale = false;
  let restoredAt = 0;
  // A state without a cursor cannot be caught up from the stream, so a quiet stream proves nothing about it.
  let hasCursor = false;
  let restoring = false;
  let attached = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let offStore: (() => void) | null = null;
  let offClock: (() => void) | null = null;
  let chain: Promise<void> = Promise.resolve();

  const outcome = (reason: RestoreResult["reason"]): RestoreResult => ({ restored: false, reason, savedAt: null, asOf: null, cursor: null, rows: 0, needsResync: false });

  function setStale(value: boolean): void {
    if (stale === value) return;
    stale = value;
    try {
      options.onStaleChange?.(value);
    } catch {
      // A broken callback must not break the cache.
    }
  }

  function markFresh(): void {
    if (!stale) return;
    setStale(false);
    // The state is confirmed now, so it is worth saving.
    if (attached) scheduleSave();
  }

  /** Checks the whole state. Any failure ignores all of it: half a state is worse than none. */
  function validate(raw: unknown): RestoreResult["reason"] | { cursor: string | null; savedAt: number; rows: NonNullable<ReturnType<typeof readRows>> } {
    if (!isObject(raw)) return "shape";
    if (raw.version !== STATE_CACHE_VERSION) return "version";
    if (typeof raw.scope !== "string") return "shape";
    // One person's stale numbers must never appear for the next person on the same device.
    if (raw.scope !== scope) return "scope";
    const savedAt = raw.savedAt;
    if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return "shape";
    const t = now();
    if (savedAt > t + MAX_FUTURE_SKEW_MS) return "shape";
    if (t - savedAt > maxAge) return "too_old";
    if (!Array.isArray(raw.rows)) return "shape";
    if (raw.rows.length > maxRows) return "too_many";
    const rows = readRows(raw.rows);
    if (!rows) return "shape";
    const cursor = raw.cursor;
    if (cursor !== null && (typeof cursor !== "string" || !CURSOR_SHAPE.test(cursor))) return "shape";
    return { cursor: cursor as string | null, savedAt, rows };
  }

  function readRows(list: unknown[]): CachedState<T>["rows"] | null {
    const out: CachedState<T>["rows"] = [];
    for (const item of list) {
      if (!isObject(item)) return null;
      if (!isText(item.entity) || !isText(item.typeUri)) return null;
      if (!textOrNull(item.etag) || !textOrNull(item.updatedAt) || item.etag === undefined || item.updatedAt === undefined) return null;
      if (!("record" in item)) return null;
      out.push({ entity: item.entity, typeUri: item.typeUri, etag: item.etag as string | null, updatedAt: item.updatedAt as string | null, record: item.record as T });
    }
    return out;
  }

  // --- Store and clock ---
  function ensureListening(): void {
    if (!offStore) {
      offStore = store.subscribe((change) => {
        if (closed) return;
        // A full change after the restore is a resync: the server has told us the whole truth. Our own seed does not count.
        if (change.full && stale && !restoring) markFresh();
        if (attached) scheduleSave();
      });
    }
    if (!offClock && options.clock) {
      offClock = options.clock.subscribe(() => {
        if (closed || !stale || !hasCursor) return;
        const s = store.stats();
        if (s.held === 0 && s.inFlight === 0 && now() - restoredAt >= freshAfter) markFresh();
      });
    }
  }

  async function restore(): Promise<RestoreResult> {
    if (closed) return outcome("empty");
    if (store.size() > 0) return outcome("store_not_empty");
    let raw: unknown;
    counters.loads++;
    try {
      raw = await cache.load();
    } catch {
      counters.loadFailed++;
      return outcome("load_failed");
    }
    if (raw === null || raw === undefined) return outcome("empty");
    // The load took time; rows that arrived meanwhile are newer than anything saved.
    if (closed || store.size() > 0) return outcome("store_not_empty");
    const checked = validate(raw);
    if (typeof checked === "string") return outcome(checked);
    restoring = true;
    try {
      store.seed(checked.rows);
    } finally {
      restoring = false;
    }
    // A restored state is old: it is never a confirmation by itself. It turns fresh only when the server has spoken since.
    restoredAt = now();
    hasCursor = checked.cursor !== null;
    ensureListening();
    setStale(true);
    let asOf: string | null = null;
    let asOfMs = -Infinity;
    for (const r of checked.rows) {
      const ms = r.updatedAt === null ? Number.NaN : Date.parse(r.updatedAt);
      if (!Number.isNaN(ms) && ms > asOfMs) {
        asOfMs = ms;
        asOf = r.updatedAt;
      }
    }
    return { restored: true, reason: "ok", savedAt: checked.savedAt, asOf, cursor: checked.cursor, rows: checked.rows.length, needsResync: checked.cursor === null };
  }

  // --- Saving ---
  function scheduleSave(): void {
    if (closed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void enqueueSave(false);
    }, debounce);
  }

  function enqueueSave(force: boolean): Promise<void> {
    chain = chain.then(() => save(force));
    return chain;
  }

  async function save(force: boolean): Promise<void> {
    if (closed) return;
    // An old restored state is not saved again as if it were new, and it would renew its own life.
    if (stale) return;
    const size = store.size();
    if (size === 0 && options.saveEmpty !== true) return;
    // Half a state is worse than none: a store above the limit would be refused at restore anyway.
    if (size > maxRows) return;
    const s = store.stats();
    // A record whose read failed is owed: the cursor is already past it, so a saved cursor would skip it for good on reload.
    const busy = s.held > 0 || s.inFlight > 0 || store.owed() > 0;
    if (busy && !force) {
      // The cursor may be ahead of the rows while reads are pending or owed; wait for a quiet moment.
      scheduleSave();
      return;
    }
    const state: CachedState<T> = {
      version: 1,
      scope,
      savedAt: now(),
      // A forced save while busy keeps the rows but gives no resume point, so a restore cannot skip a change
      // (the restore then asks for a full read).
      cursor: busy ? null : store.lastCursor(),
      rows: store.all().map((r) => ({ entity: r.entity, typeUri: r.typeUri, etag: r.etag, updatedAt: r.updatedAt, record: r.record })),
    };
    try {
      await cache.save(state);
      counters.saves++;
    } catch {
      counters.saveFailed++;
    }
  }

  return {
    restore,
    attach(): void {
      if (closed || attached) return;
      attached = true;
      ensureListening();
    },
    isStale: () => stale,
    markFresh,
    flush(): Promise<void> {
      if (closed) return Promise.resolve();
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      return enqueueSave(true);
    },
    async clear(): Promise<void> {
      try {
        await cache.remove?.();
      } catch {
        // Nothing to do: the app's storage failed to forget, and the next save replaces the state anyway.
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      offStore?.();
      offClock?.();
      offStore = null;
      offClock = null;
    },
    stats: () => ({ ...counters }),
  };
}
