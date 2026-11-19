import type { ConfirmationClock } from "./confirm.js";
import type { LiveChange, RowChange, StoreRow } from "./types.js";

/** The default length of one delivery period, in ms. */
export const DEFAULT_COALESCE_MS = 250;
/** The longest delivery period the coalescer accepts, in ms. A bigger `intervalMs` is cut to this. */
export const MAX_COALESCE_MS = 1000;

/** What you give `createCoalescer`. */
export interface CoalescerOptions<T> {
  /** Receives each merged change. Apply it to your held list exactly as you apply a store change. Errors thrown from it are logged (message only) and do not stop later deliveries. */
  onApply: (change: LiveChange<T>) => void;
  /** The delivery period in ms. Default 250, cut into 0 to 1000; NaN, negative and non-numbers use the default. 0 delivers every batch at once. */
  intervalMs?: number;
  /** Replaces the timer: called to schedule ONE delivery, returns its cancel function. An app can pass its frame callback. */
  schedule?: (run: () => void) => () => void;
  /** The clock used for `LiveChange.at`. Default `Date.now`. */
  now?: () => number;
  /** When given, every received batch confirms it, and `screenConfirmedAt` follows it. */
  clock?: ConfirmationClock;
  /** Called with the number of distinct records waiting, whenever that number changes. */
  onWaiting?: (waiting: number) => void;
  /** Called with the new screen time, at most once per `tickMinIntervalMs`. */
  onTick?: (at: number) => void;
  /** The least time between two `onTick` calls, in ms. Default 1000. 0 gives a tick for every confirmation. */
  tickMinIntervalMs?: number;
  /**
   * How many records are owed (announced, but their read failed and has not yet succeeded). While it is above 0 the screen
   * time stands still, even when nothing is queued: the screen lacks records the server has announced. Default: none owed.
   */
  owed?: () => number;
}

/** The coalescer: merges bursts of store batches into one change per period, and can hold the screen still. */
export interface Coalescer<T> {
  /** Stops deliveries. Batches keep being collected and counted. */
  pause(): void;
  /** Delivers everything that waited as ONE change at once, then goes on delivering. */
  resume(): void;
  /** Whether deliveries are paused. */
  paused(): boolean;
  /** How many distinct records changed or ended since the last delivery (the whole list after a full change). */
  waiting(): number;
  /** Delivers what waits right now, unless paused. */
  flushNow(): void;
  /** The last moment the screen was truly current: it moves only when nothing waits and nothing is owed. Null without a clock or before a confirmation. */
  screenConfirmedAt(): number | null;
  /** Works out the screen time again. Call it when the owed count changed: it catches up (and ticks) once nothing is owed. */
  recheck(): void;
  /** Counters for tests and diagnostics. */
  stats(): { applies: number; batchesSeen: number; fullApplies: number; ticks: number };
  /** Stops everything: cancels timers, drops subscriptions and callbacks. Later calls do nothing. */
  close(): void;
}

/**
 * Creates a coalescer over a store (anything with `subscribeRows`). It turns many store batches into one `LiveChange`
 * per period, so a burst is one render. It also counts what waits while paused and keeps an honest "current as of" time.
 *
 * @param source the store, or any object that hands out whole batches through `subscribeRows`
 * @param options see `CoalescerOptions`
 */
export function createCoalescer<T>(
  source: { subscribeRows(listener: (c: RowChange<T>) => void): () => void },
  options: CoalescerOptions<T>,
): Coalescer<T> {
  // --- Options ---
  const interval = typeof options.intervalMs === "number" && !Number.isNaN(options.intervalMs) && options.intervalMs >= 0
    ? Math.min(options.intervalMs, MAX_COALESCE_MS)
    : DEFAULT_COALESCE_MS;
  const now = options.now ?? Date.now;
  const tickMin = typeof options.tickMinIntervalMs === "number" && !Number.isNaN(options.tickMinIntervalMs) && options.tickMinIntervalMs >= 0
    ? options.tickMinIntervalMs
    : 1000;
  const clock = options.clock;
  let onApply: ((c: LiveChange<T>) => void) | null = options.onApply;
  let onWaiting: ((n: number) => void) | null = options.onWaiting ?? null;
  let onTick: ((at: number) => void) | null = options.onTick ?? null;

  // --- State ---
  // The mirror is built ONLY from whole batches handed to us, never read from the store: the store's rows can already hold
  // a batch that is still settling, and a snapshot of it would show half a batch.
  const mirror = new Map<string, StoreRow<T>>();
  // What the screen holds: a copy of the mirror at the last delivery.
  let delivered = new Map<string, StoreRow<T>>();
  const dirty = new Set<string>();
  let pendingFull = false;
  let isPaused = false;
  let closed = false;
  let cancelWindow: (() => void) | null = null;
  let lastWaiting = 0;
  const counters = { applies: 0, batchesSeen: 0, fullApplies: 0, ticks: 0 };
  // Screen confirmation
  let latest: number | null = null;
  let screenAt: number | null = null;
  let lastTickAt: number | null = null;
  let tickTimer: ReturnType<typeof setTimeout> | undefined;

  const waitingNow = (): number => (pendingFull ? mirror.size : dirty.size);
  // A broken counter must not break the screen time; an unreadable count is taken as "none owed", as before.
  const owedCount = (): number => {
    try {
      const n = options.owed?.() ?? 0;
      return typeof n === "number" && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  };

  // --- Screen time ---
  function emitTick(): void {
    if (closed || !onTick || screenAt === null) return;
    const t = now();
    if (lastTickAt !== null && t - lastTickAt < tickMin) {
      // Too soon: the screen time itself is already updated, only the callback waits for its next allowed moment.
      if (tickTimer === undefined) {
        tickTimer = setTimeout(() => {
          tickTimer = undefined;
          emitTick();
        }, tickMin - (t - lastTickAt));
      }
      return;
    }
    if (tickTimer !== undefined) {
      clearTimeout(tickTimer);
      tickTimer = undefined;
    }
    lastTickAt = t;
    counters.ticks++;
    try {
      onTick(screenAt);
    } catch (error) {
      console.error(`[live] onTick threw: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  // The screen is "current as of T" only when nothing waits and nothing is owed: while changes wait, or a record was announced
  // but could not be read yet, the server has told us things the screen does not show, so its time stands still.
  function syncScreen(): void {
    if (latest === null || dirty.size > 0 || pendingFull || owedCount() > 0) return;
    if (screenAt !== null && latest <= screenAt) return;
    screenAt = latest;
    emitTick();
  }

  const offClock = clock
    ? clock.subscribe((at) => {
        if (closed) return;
        latest = latest === null ? at : Math.max(latest, at);
        syncScreen();
      })
    : null;

  // --- Waiting count ---
  function notifyWaiting(): void {
    const w = waitingNow();
    if (w === lastWaiting) return;
    lastWaiting = w;
    if (!onWaiting) return;
    try {
      onWaiting(w);
    } catch (error) {
      console.error(`[live] onWaiting threw: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  // --- Delivery ---
  function clearWindow(): void {
    if (cancelWindow) {
      const cancel = cancelWindow;
      cancelWindow = null;
      cancel();
    }
  }

  function deliver(): void {
    clearWindow();
    let full = pendingFull;
    const records: T[] = [];
    const ended: string[] = [];
    if (!full) {
      // What the screen will hold after applying a delta: kept rows in their place, then new rows appended in order.
      const expected: string[] = [];
      for (const key of delivered.keys()) if (mirror.has(key)) expected.push(key);
      for (const [key, r] of mirror) {
        const old = delivered.get(key);
        if (old === undefined) {
          expected.push(key);
          records.push(r.record);
        } else if (old !== r && !(r.etag !== null && r.etag === old.etag)) {
          records.push(r.record);
        }
      }
      for (const key of delivered.keys()) if (!mirror.has(key)) ended.push(key);
      // A delta cannot say "ended, then came back at the end" or "new, between two kept ones": it only replaces in place,
      // appends new ones and drops ended ones. When that would not give the mirror's order, send the whole list.
      let same = expected.length === mirror.size;
      if (same) {
        let i = 0;
        for (const key of mirror.keys()) {
          if (expected[i++] !== key) { same = false; break; }
        }
      }
      if (!same) full = true;
    }
    if (full) {
      records.length = 0;
      ended.length = 0;
      for (const r of mirror.values()) records.push(r.record);
    } else if (records.length === 0 && ended.length === 0) {
      // Nothing differs from the screen (for example a record that appeared and ended inside one period).
      dirty.clear();
      syncScreen();
      notifyWaiting();
      return;
    }
    delivered = new Map(mirror);
    dirty.clear();
    pendingFull = false;
    counters.applies++;
    if (full) counters.fullApplies++;
    const change: LiveChange<T> = { full, records, ended, at: now() };
    const apply = onApply;
    if (apply) {
      try {
        apply(change);
      } catch (error) {
        // Only the message is logged: the change holds record data, which must not end up in a log.
        console.error(`[live] onApply threw: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    // Nothing waits now, so the screen is as current as the latest confirmation.
    syncScreen();
    notifyWaiting();
  }

  function startWindow(): void {
    if (cancelWindow || isPaused || closed) return;
    // A FIXED period from the first batch, not restarted by later ones: a steady stream must not postpone the screen for ever.
    const fire = (): void => {
      cancelWindow = null;
      if (!closed && !isPaused) deliver();
    };
    if (options.schedule) {
      cancelWindow = options.schedule(fire);
    } else if (interval === 0) {
      deliver();
    } else {
      const timer = setTimeout(fire, interval);
      cancelWindow = () => clearTimeout(timer);
    }
  }

  // --- Batches in ---
  const offSource = source.subscribeRows((change) => {
    if (closed) return;
    counters.batchesSeen++;
    if (change.full) {
      mirror.clear();
      pendingFull = true;
    }
    for (const r of change.rows) {
      mirror.set(r.entity, r);
      dirty.add(r.entity);
    }
    for (const entity of change.ended) {
      mirror.delete(entity);
      dirty.add(entity);
    }
    // The mirror and the waiting set are updated BEFORE the confirmation, so the screen time cannot move past a batch
    // that has not been shown yet.
    clock?.confirm();
    startWindow();
    notifyWaiting();
  });

  return {
    pause(): void {
      if (closed || isPaused) return;
      isPaused = true;
      clearWindow();
    },
    resume(): void {
      if (closed || !isPaused) return;
      isPaused = false;
      deliver();
    },
    paused: () => isPaused,
    waiting: () => (closed ? 0 : waitingNow()),
    flushNow(): void {
      if (closed || isPaused) return;
      deliver();
    },
    screenConfirmedAt: () => screenAt,
    recheck(): void {
      if (closed) return;
      syncScreen();
    },
    stats: () => ({ ...counters }),
    close(): void {
      if (closed) return;
      closed = true;
      clearWindow();
      if (tickTimer !== undefined) {
        clearTimeout(tickTimer);
        tickTimer = undefined;
      }
      offSource();
      offClock?.();
      onApply = null;
      onWaiting = null;
      onTick = null;
      mirror.clear();
      delivered.clear();
      dirty.clear();
    },
  };
}
