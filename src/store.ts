import { nextBackoffMs } from "./backoff.js";
import { parseLiveNotification } from "./notification.js";
import type { LiveChange, LiveNotification, LiveRead, LiveStore, LiveStoreOptions, RowChange, StoreRow, StoreStats } from "./types.js";

/** The default hold period, in ms. */
export const DEFAULT_HOLD_MS = 250;
/** The longest hold period the store accepts, in ms. A bigger `holdMs` is cut to this. */
export const MAX_HOLD_MS = 500;
/** The default number of re-reads in flight at once. */
export const DEFAULT_MAX_PARALLEL_READS = 4;
/** The most ended records remembered (the oldest is forgotten first). */
export const MAX_TOMBSTONES = 10000;
/** The default number of items in one `readBatch` call. */
export const DEFAULT_READ_BATCH_SIZE = 50;
/** The most items in one `readBatch` call. A bigger `readBatchSize` is cut to this. */
export const MAX_READ_BATCH_SIZE = 200;

/** The default number of retries of an owed record before it is parked. */
export const DEFAULT_MAX_READ_ATTEMPTS = 6;
/** The most retries the store accepts. A bigger `maxReadAttempts` is cut to this. */
export const MAX_READ_ATTEMPTS_LIMIT = 50;
/** The default most records kept as owed at once. */
export const DEFAULT_MAX_OWED = 50000;
/** The default first retry delay of an owed record, in ms. */
export const DEFAULT_OWED_BASE_MS = 500;
/** The default longest retry delay of an owed record, in ms. */
export const DEFAULT_OWED_CAP_MS = 30000;

/** The fixed message for an item that `readBatch` did not return. */
const NOT_RETURNED = "not returned by readBatch";

// `before` is the store's cursor just before this notification arrived: the place a feed read can start from to see it.
type Held = LiveNotification & { seq: number; before: string | null };

/** One slot of a batch, in release order: either an ended record, or a re-read that will (maybe) apply a record. */
interface Slot {
  entity: string;
  ended: boolean;
  applied: boolean;
}

/** The work of one release. It emits one change when every one of its reads has settled. */
interface Batch {
  epoch: number;
  slots: Slot[];
  pending: number;
}

/**
 * A record whose read failed: it was announced, so it must be read, but nothing has read it yet. It is kept until a read
 * succeeds, the record is found gone, or something newer is released for it.
 */
interface Owed {
  /** The notification that was announced (entity, type, etag, source time). */
  held: Held;
  /** Retries started so far. */
  attempts: number;
  /** When the next retry is due (epoch ms); only meaningful while not parked and not retrying. */
  nextAt: number;
  /** True after the last allowed retry failed: visible, no timer, retried only on demand. */
  parked: boolean;
  /** True while a retry read is in flight. */
  retrying: boolean;
}

interface Job {
  batch: Batch;
  slot: Slot;
  n: Held;
  gen: number;
  /** The owed-list epoch when the job was made; `clearOwed` moves the epoch on, so older jobs keep no owed entry. */
  oe: number;
  /** Set when this job is a retry of an owed record. */
  owed?: Owed;
  /** Set when a failed `readBatch` call sent this job back to be read one by one (or a retry, which reads one record). */
  single?: boolean;
}

/** The default meaning of "gone for this viewer": a 403, 404 or 410 status, or an error marked `gone`. */
function defaultIsGone(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { status?: unknown; gone?: unknown };
  return e.gone === true || e.status === 403 || e.status === 404 || e.status === 410;
}

/** Parsed source time, or NaN when missing or unreadable. */
const time = (iso: string | null): number => (iso === null ? Number.NaN : Date.parse(iso));

/** An unreadable time counts as the least. */
const known = (t: number): number => (Number.isNaN(t) ? -Infinity : t);

/**
 * Creates a live store: notifications in through `push`, re-read records out through `subscribe`.
 * See `LiveStoreOptions` for what you supply.
 *
 * @param options the `read` and/or `readBatch` callback and optional tuning; throws when neither is given
 */
export function createLiveStore<T>(options: LiveStoreOptions<T>): LiveStore<T> {
  // --- Options ---
  if (typeof options.read !== "function" && typeof options.readBatch !== "function") {
    throw new Error("a live store needs read or readBatch");
  }
  const batchSize = typeof options.readBatchSize === "number" && !Number.isNaN(options.readBatchSize) && Math.floor(options.readBatchSize) >= 1
    ? Math.min(Math.floor(options.readBatchSize), MAX_READ_BATCH_SIZE)
    : DEFAULT_READ_BATCH_SIZE;
  const holdMs = typeof options.holdMs !== "number" || Number.isNaN(options.holdMs) || options.holdMs < 0
    ? DEFAULT_HOLD_MS
    : Math.min(options.holdMs, MAX_HOLD_MS);
  const maxParallel = typeof options.maxParallelReads === "number" && !Number.isNaN(options.maxParallelReads)
    ? Math.max(1, Math.floor(options.maxParallelReads))
    : DEFAULT_MAX_PARALLEL_READS;
  const now = options.now ?? Date.now;
  const maxAttempts = typeof options.maxReadAttempts === "number" && Number.isFinite(options.maxReadAttempts) && Math.floor(options.maxReadAttempts) >= 1
    ? Math.min(Math.floor(options.maxReadAttempts), MAX_READ_ATTEMPTS_LIMIT)
    : DEFAULT_MAX_READ_ATTEMPTS;
  const positiveMs = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);
  const owedBackoff = { baseMs: positiveMs(options.owedBackoff?.baseMs, DEFAULT_OWED_BASE_MS), capMs: positiveMs(options.owedBackoff?.capMs, DEFAULT_OWED_CAP_MS) };
  const random = options.random ?? Math.random;
  const isGone = options.isGone ?? defaultIsGone;
  const maxOwed = typeof options.maxOwed === "number" && Number.isFinite(options.maxOwed) && options.maxOwed >= 0
    ? Math.floor(options.maxOwed)
    : DEFAULT_MAX_OWED;

  // --- State ---
  const rows = new Map<string, StoreRow<T>>();
  // An ended record keeps a tombstone (its ended time) so a late, older change cannot bring it back.
  // The map is capped and the oldest is forgotten first: a long session must not grow without bound.
  const tombstones = new Map<string, string | null>();
  const buffer = new Map<string, Held>();
  // A per-entity generation guards every re-read: reads finish out of order, and an old answer must never overwrite a newer one.
  // `t` is the parsed source time of the newest item released for the entity while its read is pending (else -Infinity).
  const gen = new Map<string, { g: number; t: number }>();
  // Records applied as new but not yet announced to subscribers; they are moved into release order when announced.
  const unannounced = new Set<string>();
  const listeners = new Set<(c: LiveChange<T>) => void>();
  const rowListeners = new Set<(c: RowChange<T>) => void>();
  const queue: Job[] = [];
  const idleWaiters: Array<() => void> = [];
  // Records whose read failed, by entity. They are retried with back-off by ONE timer (the earliest due), and a record that
  // used up its tries is parked: still owed and visible, but quiet. The stream's cursor has already moved past these
  // records, so nothing else would ever read them again.
  const owed = new Map<string, Owed>();
  const owedListeners = new Set<(owed: number) => void>();
  const counters = { pushed: 0, invalid: 0, stale: 0, duplicate: 0, superseded: 0, unchanged: 0, reads: 0, readFailed: 0, applied: 0, ended: 0, batchReads: 0, batchFallbacks: 0, batchMissing: 0, owedRetries: 0, readGone: 0, owedDropped: 0 };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let owedTimer: ReturnType<typeof setTimeout> | undefined;
  let owedTimerAt = Infinity;
  let lastOwedCount = 0;
  // Moves on at `clearOwed`: a read that began before it must not leave an owed record behind (access was removed).
  let owedEpoch = 0;
  let inFlight = 0;
  // Calls to `read` or `readBatch` that are open now. A batch call is ONE unit of parallelism: `maxParallelReads` limits
  // requests on the wire, and a batch of 50 is one request. `inFlight` still counts jobs.
  let calls = 0;
  let seq = 0;
  let epoch = 0;
  let lastCursorValue: string | null = null;
  let closed = false;

  // --- Helpers ---
  const genOf = (entity: string): number => gen.get(entity)?.g ?? 0;
  /** New generation for the entity; `t` is the released time to remember (-Infinity for none). */
  const bump = (entity: string, t: number): number => {
    const prev = gen.get(entity);
    const g = (prev?.g ?? 0) + 1;
    gen.set(entity, { g, t });
    return g;
  };

  function writeTombstone(entity: string, endedAt: string | null): void {
    tombstones.delete(entity);
    tombstones.set(entity, endedAt);
    while (tombstones.size > MAX_TOMBSTONES) {
      const oldest = tombstones.keys().next();
      if (oldest.done) break;
      tombstones.delete(oldest.value);
    }
  }

  /** Greater order key wins: source time first (unreadable is least), then later arrival. */
  function newer(a: Held, b: Held): boolean {
    const ta = time(a.updatedAt);
    const tb = time(b.updatedAt);
    const ka = Number.isNaN(ta) ? -Infinity : ta;
    const kb = Number.isNaN(tb) ? -Infinity : tb;
    return ka !== kb ? ka > kb : a.seq > b.seq;
  }

  /** Release order: ascending source time (unreadable last, in arrival order), then entity address, then arrival. */
  function releaseOrder(a: Held, b: Held): number {
    const ta = time(a.updatedAt);
    const tb = time(b.updatedAt);
    const na = Number.isNaN(ta);
    const nb = Number.isNaN(tb);
    if (na && nb) return a.seq - b.seq;
    if (na) return 1;
    if (nb) return -1;
    if (ta !== tb) return ta - tb;
    if (a.entity !== b.entity) return a.entity < b.entity ? -1 : 1;
    return a.seq - b.seq;
  }

  /** The read has answered, so the row or tombstone now carries the time; the released time is no longer needed. */
  function clearReleased(entity: string): void {
    const e = gen.get(entity);
    if (e) e.t = -Infinity;
  }

  function isIdle(): boolean {
    return buffer.size === 0 && queue.length === 0 && inFlight === 0 && timer === undefined;
  }

  function checkIdle(): void {
    if (!closed && !isIdle()) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  function emit(change: LiveChange<T>, rowChange: RowChange<T>): void {
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch (error) {
        // Only the message is logged: the change holds record data, which must not end up in a log.
        console.error(`[live] a subscriber threw: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    // The same moment as the record feed, right after it, so both kinds of listener see the same batches in the same order.
    for (const listener of [...rowListeners]) {
      try {
        listener(rowChange);
      } catch (error) {
        console.error(`[live] a subscriber threw: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  }

  // --- Owed reads ---
  /** Tells the owed listeners when the COUNT changed (not on every attempt). A throwing listener is isolated. */
  function notifyOwed(): void {
    const count = owed.size;
    if (count === lastOwedCount) return;
    lastOwedCount = count;
    for (const listener of [...owedListeners]) {
      try {
        listener(count);
      } catch (error) {
        console.error(`[live] an owed listener threw: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  }

  function disarmOwed(): void {
    if (owedTimer !== undefined) {
      clearTimeout(owedTimer);
      owedTimer = undefined;
    }
    owedTimerAt = Infinity;
  }

  /** Makes sure the one retry timer fires no later than `at` (epoch ms). */
  function armOwed(at: number): void {
    if (closed || (owedTimer !== undefined && owedTimerAt <= at)) return;
    if (owedTimer !== undefined) clearTimeout(owedTimer);
    owedTimerAt = at;
    owedTimer = setTimeout(fireOwed, Math.max(0, at - Date.now()));
  }

  /** Forgets the owed entry of an entity; the caller notifies. With nothing left owed the timer goes too. */
  function dropOwed(entity: string): void {
    if (!owed.delete(entity)) return;
    if (owed.size === 0) disarmOwed();
  }

  /** The delay before retry number `attempt` (1 is the first). */
  const owedDelay = (attempt: number): number => nextBackoffMs(attempt, owedBackoff, random);

  /** The timer fired: start a retry for every entry that is due, then wait for the next one. */
  function fireOwed(): void {
    owedTimer = undefined;
    owedTimerAt = Infinity;
    if (closed) return;
    const t = Date.now();
    const due: Owed[] = [];
    let next = Infinity;
    for (const e of owed.values()) {
      if (e.parked || e.retrying) continue;
      if (e.nextAt <= t) due.push(e);
      else next = Math.min(next, e.nextAt);
    }
    startRetries(due);
    if (next !== Infinity) armOwed(next);
  }

  /**
   * Reads the due entries again, as one batch with a fresh generation each. The generation is what keeps an old retry from
   * overwriting anything newer: a notification released meanwhile bumps it, and the retry's answer is then ignored.
   */
  function startRetries(due: Owed[]): void {
    if (due.length === 0) return;
    due.sort((a, b) => releaseOrder(a.held, b.held));
    const batch: Batch = { epoch, slots: [], pending: 0 };
    for (const e of due) {
      const n = e.held;
      e.retrying = true;
      e.attempts++;
      counters.owedRetries++;
      const slot: Slot = { entity: n.entity, ended: false, applied: false };
      batch.slots.push(slot);
      const g = bump(n.entity, Math.max(gen.get(n.entity)?.t ?? -Infinity, known(time(n.updatedAt))));
      batch.pending++;
      // A retry reads ONE record; a store that has only `readBatch` reads it through that.
      queue.push({ batch, slot, n, gen: g, oe: owedEpoch, owed: e, single: options.read !== undefined });
    }
    pump();
    checkIdle();
  }

  /** A read failed and is still the newest word on the record: keep it owed (or, for a retry, count the try). */
  function keepOwed(job: Job): void {
    const e = job.owed;
    if (e) {
      e.retrying = false;
      if (e.attempts >= maxAttempts) {
        e.parked = true;
      } else {
        e.nextAt = Date.now() + owedDelay(e.attempts + 1);
        armOwed(e.nextAt);
      }
      return;
    }
    // Access was removed since this read began: nothing is kept for a viewer who lost the vault.
    if (job.oe !== owedEpoch) return;
    if (owed.size >= maxOwed) {
      counters.owedDropped++;
      return;
    }
    const entry: Owed = { held: job.n, attempts: 0, nextAt: Date.now() + owedDelay(1), parked: false, retrying: false };
    owed.set(job.n.entity, entry);
    armOwed(entry.nextAt);
  }

  /** The record is gone for this viewer, or an `ended` notification said so: the row goes, a tombstone stays. */
  function markGone(job: Job): void {
    const { n, slot } = job;
    rows.delete(n.entity);
    unannounced.delete(n.entity);
    let stamp = n.updatedAt;
    // A retry must not write an older tombstone over a newer one.
    if (job.owed && tombstones.has(n.entity)) {
      const held = tombstones.get(n.entity) ?? null;
      if (known(time(held)) > known(time(stamp))) stamp = held;
    }
    writeTombstone(n.entity, stamp);
    slot.ended = true;
    counters.ended++;
  }

  // --- Emitting a batch ---
  // One batch makes one change: a burst must be one render, not one per record.
  function emitBatch(batch: Batch): void {
    if (closed || batch.epoch !== epoch) return;
    const records: T[] = [];
    const announced: StoreRow<T>[] = [];
    const ended: string[] = [];
    for (const slot of batch.slots) {
      const row = rows.get(slot.entity);
      if (slot.ended) {
        // Revived since (by another batch): the current row is the truth, so do not announce an end.
        if (!row) ended.push(slot.entity);
      } else if (slot.applied && row) {
        if (unannounced.delete(slot.entity)) {
          // Answers settle in any order; the position of a new record follows release order, as subscribers will place it.
          rows.delete(slot.entity);
          rows.set(slot.entity, row);
        }
        // The CURRENT row, not the one this batch read: an overlapping newer batch may have replaced it.
        records.push(row.record);
        announced.push(row);
      }
    }
    if (records.length > 0 || ended.length > 0) {
      const at = now();
      emit({ full: false, records, ended, at }, { full: false, rows: announced, ended: [...ended], at });
    }
  }

  function finishSlot(batch: Batch): void {
    batch.pending--;
    if (batch.pending === 0) emitBatch(batch);
  }

  // --- Re-reads ---
  function pump(): void {
    while (!closed && calls < maxParallel) {
      const first = queue.shift();
      if (!first) return;
      if (dropIfCleared(first)) continue;
      if (options.readBatch && !first.single) {
        // Take the next jobs in release order, up to the chunk size, and answer them with ONE call.
        const chunk = [first];
        while (chunk.length < batchSize) {
          const next = queue[0];
          if (!next || next.single) break;
          queue.shift();
          if (dropIfCleared(next)) continue;
          chunk.push(next);
        }
        startBatch(chunk);
      } else {
        start(first);
      }
    }
  }

  /** A retry that waited in the queue while `clearOwed` ran is not made: access was removed, so no read may follow it. */
  function dropIfCleared(job: Job): boolean {
    if (job.owed === undefined || job.oe === owedEpoch) return false;
    counters.superseded++;
    finishSlot(job.batch);
    return true;
  }

  function start(job: Job): void {
    const { n } = job;
    inFlight++;
    calls++;
    let promise: Promise<unknown>;
    try {
      // `read` is present here: a job is only sent to a single read when the store has one (see settleBatchFailure).
      promise = (options.read as NonNullable<typeof options.read>)({ entity: n.entity, typeUri: n.typeUri }, controller.signal);
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(
      (result) => settle(job, true, result),
      (error) => settle(job, false, error),
    );
  }

  function startBatch(chunk: Job[]): void {
    inFlight += chunk.length;
    calls++;
    counters.batchReads++;
    // The hint is the cursor before the job whose notification ARRIVED first: from there the feed holds every change of the chunk.
    // It is advisory only; the store never depends on it, so a wrong or ignored hint cannot make an answer wrong.
    let earliest = chunk[0] as Job;
    for (const job of chunk) if (job.n.seq < earliest.n.seq) earliest = job;
    const items = chunk.map((j) => ({ entity: j.n.entity, typeUri: j.n.typeUri }));
    let promise: Promise<unknown>;
    try {
      promise = Promise.resolve((options.readBatch as NonNullable<typeof options.readBatch>)(items, controller.signal, { sinceCursor: earliest.n.before }));
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(
      (answer) => settleBatch(chunk, answer),
      (error) => settleBatchFailure(chunk, error),
    );
  }

  /** The answer of one batch call: every job of the chunk is settled from the Map. */
  function settleBatch(chunk: Job[], answer: unknown): void {
    const map = answer as ReadonlyMap<string, LiveRead<T> | null> | null | undefined;
    if (!closed && (typeof map !== "object" || map === null || typeof map.get !== "function")) {
      settleBatchFailure(chunk, new Error("readBatch did not return a Map"));
      return;
    }
    calls--;
    inFlight -= chunk.length;
    if (closed) return;
    for (const job of chunk) {
      const entity = job.n.entity;
      const value = (map as ReadonlyMap<string, LiveRead<T> | null>).get(entity);
      if (value === undefined) {
        // A key that is absent is a FAILED read, not "gone": an answer that did not contain the record proves nothing about it.
        // Only an explicit null may remove a row.
        if (genOf(entity) === job.gen) counters.batchMissing++;
        apply(job, false, new Error(NOT_RETURNED));
      } else {
        apply(job, true, value);
      }
    }
    pump();
    checkIdle();
  }

  /** The whole batch call failed. Fall back to single reads when there is a `read`; otherwise every job is a failed read. */
  function settleBatchFailure(chunk: Job[], error: unknown): void {
    calls--;
    inFlight -= chunk.length;
    if (closed) return;
    counters.batchFallbacks++;
    if (options.read) {
      // Back to the FRONT of the queue, in the same order, so the retry keeps its place and release order.
      for (const job of chunk) job.single = true;
      queue.unshift(...chunk);
    } else {
      for (const job of chunk) apply(job, false, error);
    }
    pump();
    checkIdle();
  }

  function settle(job: Job, ok: boolean, value: unknown): void {
    inFlight--;
    calls--;
    // After close every answer is ignored, including errors (no onReadError, no listener).
    if (closed) return;
    apply(job, ok, value);
    pump();
    checkIdle();
  }

  /** Applies the outcome of one job (from a single read or from a batch answer); the caller pumps and checks idle. */
  function apply(job: Job, ok: boolean, value: unknown): void {
    counters.reads++;
    const { n, slot, batch } = job;
    // A retry also dies with `clearOwed` (the owed epoch), which does not touch generations.
    if (genOf(n.entity) !== job.gen || (job.owed !== undefined && job.oe !== owedEpoch)) {
      counters.superseded++;
    } else if (!ok) {
      clearReleased(n.entity);
      let gone = false;
      try {
        gone = isGone(value);
      } catch {
        // A broken classifier counts as "not gone": a record is kept owed rather than dropped.
      }
      if (gone) {
        // The same as a read that found nothing: a denied record and an absent one look the same, by design.
        counters.readGone++;
        markGone(job);
        if (job.owed) dropOwed(n.entity);
      } else {
        counters.readFailed++;
        try {
          options.onReadError?.(n.entity, value);
        } catch {
          // A broken error handler must not break the store.
        }
        keepOwed(job);
      }
    } else if (value === null || value === undefined) {
      clearReleased(n.entity);
      markGone(job);
      if (job.owed) dropOwed(n.entity);
    } else {
      clearReleased(n.entity);
      const result = value as { record: T; etag: string | null };
      const row = rows.get(n.entity);
      if (job.owed) dropOwed(n.entity);
      const entombed = tombstones.has(n.entity) ? known(time(tombstones.get(n.entity) ?? null)) : -Infinity;
      if (job.owed && entombed > known(time(n.updatedAt))) {
        // The record ended after the notification this retry is about: a late answer must not bring it back.
        counters.superseded++;
      } else if (row && result.etag !== null && result.etag === row.etag) {
        counters.unchanged++;
      } else {
        // The etag of the READ is the truth: the notification is only a hint that something changed.
        if (!row) unannounced.add(n.entity);
        // A retry keeps the greater of the two source stamps, so it can never make a newer row look older.
        const stamp = job.owed && row && known(time(row.updatedAt)) > known(time(n.updatedAt)) ? row.updatedAt : n.updatedAt;
        rows.set(n.entity, { entity: n.entity, typeUri: n.typeUri, etag: result.etag, updatedAt: stamp, record: result.record });
        tombstones.delete(n.entity);
        slot.applied = true;
        counters.applied++;
      }
    }
    finishSlot(batch);
    notifyOwed();
  }

  // --- Release ---
  function release(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (closed || buffer.size === 0) return;
    const items = [...buffer.values()].sort(releaseOrder);
    buffer.clear();
    const batch: Batch = { epoch, slots: [], pending: 0 };
    for (const item of items) {
      const slot: Slot = { entity: item.entity, ended: false, applied: false };
      batch.slots.push(slot);
      // Something newer is released for the record: the new read (or the end) covers an owed one, which must not run later.
      dropOwed(item.entity);
      const when = time(item.updatedAt);
      const prevT = gen.get(item.entity)?.t ?? -Infinity;
      // An ended record is carried by its tombstone, so it leaves no released time (keeps the tombstone cap meaningful).
      const g = bump(item.entity, item.kind === "ended" ? -Infinity : Math.max(prevT, known(when)));
      if (item.kind === "ended") {
        rows.delete(item.entity);
        unannounced.delete(item.entity);
        writeTombstone(item.entity, item.updatedAt);
        slot.ended = true;
        counters.ended++;
      } else {
        batch.pending++;
        queue.push({ batch, slot, n: item, gen: g, oe: owedEpoch });
      }
    }
    pump();
    if (batch.pending === 0) emitBatch(batch);
    checkIdle();
    notifyOwed();
  }

  // --- Public ---
  function push(input: LiveNotification): void {
    if (closed) return;
    counters.pushed++;
    const cursorIn = (input as { cursor?: unknown } | null)?.cursor ?? null;
    const parsed = parseLiveNotification(input, cursorIn as string | null);
    if (!parsed) {
      counters.invalid++;
      return;
    }
    // Arrival order, set even if the notification is dropped below: the cursor says how far the stream has been read.
    const before = lastCursorValue;
    if (parsed.cursor !== null) lastCursorValue = parsed.cursor;
    if (options.accept) {
      let ok = false;
      try {
        ok = options.accept(parsed);
      } catch {
        ok = false;
      }
      if (!ok) return;
    }
    const row = rows.get(parsed.entity);
    const when = time(parsed.updatedAt);
    // Ordering uses `updatedAt`, never the cursor: the cursor is sealed and opaque, so the client cannot order or find gaps with it.
    // The released time counts too: a row does not exist until its read settles, so without it an older notification
    // could overtake a newer read still in flight (supersede it and store or end the entity with older data).
    if (!Number.isNaN(when)) {
      const newest = Math.max(
        row ? known(time(row.updatedAt)) : -Infinity,
        tombstones.has(parsed.entity) ? known(time(tombstones.get(parsed.entity) ?? null)) : -Infinity,
        gen.get(parsed.entity)?.t ?? -Infinity,
      );
      if (when < newest) {
        counters.stale++;
        return;
      }
    }
    if (parsed.kind === "change" && row && parsed.etag !== null && parsed.etag === row.etag) {
      counters.duplicate++;
      return;
    }
    const held: Held = { ...parsed, seq: ++seq, before };
    const existing = buffer.get(parsed.entity);
    if (existing && !newer(held, existing)) return;
    const wasEmpty = buffer.size === 0;
    buffer.set(parsed.entity, held);
    if (!wasEmpty) return;
    if (holdMs === 0) {
      release();
    } else {
      // A FIXED period from the first item, not restarted by later ones: a rolling period could delay forever under a
      // steady stream, so the wait is bounded by MAX_HOLD_MS.
      timer = setTimeout(release, holdMs);
    }
  }

  function seed(input: ReadonlyArray<{ entity: string; typeUri: string; etag: string | null; updatedAt?: string | null; record: T }>): void {
    if (closed) return;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    buffer.clear();
    // Every in-flight or queued read is now about a world that was just replaced.
    for (const entity of [...gen.keys()]) bump(entity, -Infinity);
    counters.superseded += queue.length;
    queue.length = 0;
    epoch++;
    // The seeded list is the truth: every owed record is covered by it, and every retry in flight is superseded above.
    owed.clear();
    disarmOwed();
    tombstones.clear();
    unannounced.clear();
    rows.clear();
    const records: T[] = [];
    for (const r of input) {
      rows.set(r.entity, { entity: r.entity, typeUri: r.typeUri, etag: r.etag, updatedAt: r.updatedAt ?? null, record: r.record });
    }
    for (const row of rows.values()) records.push(row.record);
    const at = now();
    emit({ full: true, records, ended: [], at }, { full: true, rows: [...rows.values()], ended: [], at });
    checkIdle();
    notifyOwed();
  }

  function flush(): Promise<void> {
    if (closed) return Promise.resolve();
    release();
    return idle();
  }

  function idle(): Promise<void> {
    if (closed || isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => { idleWaiters.push(resolve); });
  }

  function close(): void {
    if (closed) return;
    closed = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    controller.abort();
    buffer.clear();
    queue.length = 0;
    owed.clear();
    disarmOwed();
    listeners.clear();
    rowListeners.clear();
    owedListeners.clear();
    checkIdle();
  }

  // --- Owed reads, public ---
  function retryOwed(): void {
    if (closed || owed.size === 0) return;
    const t = Date.now();
    // A reconnect or a good poll is the moment to try again, so even a parked record gets a whole new set of tries.
    for (const e of owed.values()) {
      e.attempts = 0;
      e.parked = false;
      if (!e.retrying) e.nextAt = t;
    }
    armOwed(t);
  }

  function clearOwed(): void {
    if (closed) return;
    owedEpoch++;
    owed.clear();
    disarmOwed();
    notifyOwed();
  }
  return {
    push,
    seed,
    get: (entity) => rows.get(entity),
    all: () => [...rows.values()],
    size: () => rows.size,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    subscribeRows(listener) {
      rowListeners.add(listener);
      return () => { rowListeners.delete(listener); };
    },
    lastCursor: () => lastCursorValue,
    flush,
    idle,
    owed: () => owed.size,
    retryOwed,
    clearOwed,
    subscribeOwed(listener) {
      if (closed) return () => {};
      owedListeners.add(listener);
      return () => { owedListeners.delete(listener); };
    },
    stats: (): StoreStats => {
      let parked = 0;
      for (const e of owed.values()) if (e.parked) parked++;
      return { ...counters, held: buffer.size, inFlight, owed: owed.size, owedParked: parked };
    },
    close,
  };
}
