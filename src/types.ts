// Public types of @gilbplatform/live. Nothing here runs; it is the vocabulary of the store.

/**
 * One notification from the server's change stream. It says THAT something changed, never WHAT the record now holds.
 * Build one with `parseLiveNotification` from the JSON of a stream event; pass it to `store.push`.
 */
export interface LiveNotification {
  /** `change`: the record was created or changed. `ended`: the record no longer exists. */
  kind: "change" | "ended";
  /** The full address (IRI) of the record. */
  entity: string;
  /** The full address (IRI) of the record's type. */
  typeUri: string;
  /** The record's version tag at the source, or null when the source gave none. A hint only: the re-read decides. */
  etag: string | null;
  /** The source's own time of the change as an ISO string (for `ended`, when it ended), or null when unknown. */
  updatedAt: string | null;
  /** When the server sent the notification, as an ISO string. */
  receivedAt: string;
  /** The resume cursor from the stream's `id:` line, or null when there was none. Opaque: only store it and send it back. */
  cursor: string | null;
}

/** What your `read` callback returns for one record: the record itself and its current version tag (null if unknown). */
export interface LiveRead<T> {
  record: T;
  etag: string | null;
}

/** One record as the store holds it, with the address, type, version tag and source time that went with it. */
export interface StoreRow<T> {
  entity: string;
  typeUri: string;
  etag: string | null;
  updatedAt: string | null;
  record: T;
}

/**
 * One batch of change, handed to subscribers. `full: true`: `records` is the whole list, replace what you hold.
 * Otherwise `records` are created or changed records (already re-read) and `ended` are the entity addresses that no longer
 * exist. `at` is epoch milliseconds (`now()`).
 */
export interface LiveChange<T> {
  full: boolean;
  records: T[];
  ended: string[];
  at: number;
}

/**
 * The same batch as a `LiveChange`, but with the whole rows (address, type, version tag, source time, record) instead of
 * only the records. `full: true`: `rows` is the whole list. Otherwise `rows` are the created or changed rows and `ended` are
 * the entity addresses that no longer exist. For a batch, `rows[i].record` is the record at `records[i]` of the `LiveChange`.
 * A coalescer needs the addresses to merge bursts.
 */
export interface RowChange<T> {
  full: boolean;
  rows: StoreRow<T>[];
  ended: string[];
  at: number;
}

/** What the store tells `readBatch` besides the items. It is advisory only. */
export interface ReadBatchHint {
  /**
   * The cursor the store held just before the earliest-arrived notification of this chunk, or null when there was none.
   * An app can ask the `since=` feed from here to answer the chunk with one request. Ignoring it is always correct.
   */
  sinceCursor: string | null;
}

/** Counters for tests and diagnostics. `held` and `inFlight` are right-now values; the rest only grow. */
export interface StoreStats {
  /** Notifications given to `push`. */
  pushed: number;
  /** Notifications refused because their shape was wrong. */
  invalid: number;
  /** Notifications dropped because the store already holds something newer. */
  stale: number;
  /** Change notifications dropped because their etag equals the held row's etag. */
  duplicate: number;
  /** Re-reads whose answer was ignored because something newer was asked since (or the store was seeded or closed). */
  superseded: number;
  /** Re-reads whose answer equalled the held row, so nothing was applied. */
  unchanged: number;
  /** Re-reads that finished (any outcome except after `close`). */
  reads: number;
  /** Re-reads that failed. */
  readFailed: number;
  /** Re-read records stored. */
  applied: number;
  /** Records removed (an `ended` notification or a re-read that found nothing). */
  ended: number;
  /** Notifications waiting in the hold period now. */
  held: number;
  /** Re-reads started and not yet finished now. */
  inFlight: number;
  /** Calls made to `readBatch`. */
  batchReads: number;
  /** Calls to `readBatch` that failed, so that the chunk was re-read one by one (or counted as failed reads). */
  batchFallbacks: number;
  /** Items that `readBatch` did not return at all (each counts as a failed read). */
  batchMissing: number;
  /** Records owed now: announced, but their read failed and has not yet succeeded (right-now value). */
  owed: number;
  /** Retries of owed records started. */
  owedRetries: number;
  /** Owed records parked now: tried the most times allowed, waiting for `retryOwed()` (right-now value). */
  owedParked: number;
  /** Reads that failed in a way that means "gone for this viewer" (for example status 403, 404 or 410). */
  readGone: number;
  /** Failed reads that were not kept because `maxOwed` records were already owed. */
  owedDropped: number;
}

/** What you give `createLiveStore`. */
export interface LiveStoreOptions<T> {
  /**
   * Re-reads one changed record through your normal read. Return the record and its etag, or null when it no longer exists.
   * Reject to report a failure (the store keeps the old row). `signal` aborts when the store closes.
   * Give `read`, `readBatch`, or both (`read` then serves as the fallback when a `readBatch` call fails). One of them is required.
   */
  read?: (n: { entity: string; typeUri: string }, signal: AbortSignal) => Promise<LiveRead<T> | null>;
  /**
   * Re-reads many changed records with one request. Answer with a Map from entity address to the record and etag, or to null
   * when the record no longer exists. An address that is NOT in the Map counts as a failed read (the old row is kept): an
   * answer that did not contain the record proves nothing about it. `hint` is advisory. Reject to report that the whole call failed.
   */
  readBatch?: (
    items: ReadonlyArray<{ entity: string; typeUri: string }>,
    signal: AbortSignal,
    hint: ReadBatchHint,
  ) => Promise<ReadonlyMap<string, LiveRead<T> | null>>;
  /** The most items in one `readBatch` call. Default 50, at least 1, never more than 200 (zero, NaN and non-numbers use the default). */
  readBatchSize?: number;
  /** How long notifications are held to be put in time order before reading, in ms. Default 250, never more than 500. */
  holdMs?: number;
  /** The most re-reads in flight at once. Default 4, at least 1. */
  maxParallelReads?: number;
  /** Return false to ignore a notification (for example, types you do not show). It still moves `lastCursor`. */
  accept?: (n: LiveNotification) => boolean;
  /** The clock used for `LiveChange.at`. Default `Date.now`. */
  now?: () => number;
  /** Called when a re-read fails (the first read and every retry). Errors thrown from it are swallowed. */
  onReadError?: (entity: string, error: unknown) => void;
  /**
   * How many times a failed read is retried before the record is parked. An integer from 1 to 50; default 6. A parked record
   * stays owed and visible, is not retried by timer, and is tried again by `retryOwed()` or by a newer notification.
   */
  maxReadAttempts?: number;
  /** The back-off between retries of an owed record, in ms: `baseMs` default 500, `capMs` default 30000. */
  owedBackoff?: { baseMs?: number; capMs?: number };
  /** Gives a number from 0 to 1 for the jitter of the back-off. Default `Math.random`. */
  random?: () => number;
  /**
   * Tells whether a failed read means "this viewer cannot read the record now" (it is then treated as a read that found
   * nothing, and is not retried). Default: an error with a numeric `status` of 403, 404 or 410, or with `gone === true`.
   * A network error, a 401, 429, 5xx or a timeout is retryable.
   */
  isGone?: (error: unknown) => boolean;
  /** The most records kept as owed at once (a memory bound). Default 50000. A failure beyond it is counted, not kept. */
  maxOwed?: number;
}

/** The store. Feed it with `push` (and `seed` for the first full list), read it with `get`/`all`, listen with `subscribe`. */
export interface LiveStore<T> {
  /** Gives the store one notification. Never throws; a bad one is counted and ignored. */
  push(n: LiveNotification): void;
  /** Replaces everything with a full list, drops pending work and old ends, and emits one `full: true` change. */
  seed(rows: ReadonlyArray<{ entity: string; typeUri: string; etag: string | null; updatedAt?: string | null; record: T }>): void;
  /** The held row for an entity address, or undefined. */
  get(entity: string): StoreRow<T> | undefined;
  /** All held rows, first seen first, as a fresh array. */
  all(): StoreRow<T>[];
  /** The number of held rows. */
  size(): number;
  /** Calls `listener` for every change. Returns the function that stops it. */
  subscribe(listener: (c: LiveChange<T>) => void): () => void;
  /** Like `subscribe`, at the same moments with the same batches, but with whole rows. Returns the function that stops it. */
  subscribeRows(listener: (c: RowChange<T>) => void): () => void;
  /** The cursor of the last notification given to `push`, in arrival order, or null. Send it as the resume point. */
  lastCursor(): string | null;
  /** Releases the held notifications at once; resolves when everything has settled. */
  flush(): Promise<void>;
  /** Resolves when nothing is held, queued or in flight. */
  idle(): Promise<void>;
  /** How many records are owed now: their read failed and has not yet succeeded (parked ones included). */
  owed(): number;
  /** Retries every owed record now, parked ones too, with a fresh set of attempts. Does nothing when nothing is owed or the store is closed. */
  retryOwed(): void;
  /** Forgets every owed record and stops the retry timer (for example when access is removed), and tells the owed listeners. */
  clearOwed(): void;
  /** Calls `listener` with the new count each time the number of owed records changes (not on every attempt). Returns the function that stops it. */
  subscribeOwed(listener: (owed: number) => void): () => void;
  /** A fresh copy of the counters. */
  stats(): StoreStats;
  /** Stops the store: cancels the timer and in-flight reads, drops listeners. Safe to call twice. */
  close(): void;
}
