// Reconnect delays and the reading of server timing hints. Pure functions: no timers are started here.

/** First reconnect delay before the random split, in ms. */
export const BACKOFF_BASE_MS = 1000;
/** No reconnect delay is ever longer than this, in ms. */
export const BACKOFF_CAP_MS = 30000;
/** The shortest wait taken from a `Retry-After` header, in ms. */
export const RETRY_AFTER_MIN_MS = 1000;
/** The longest wait taken from a `Retry-After` header, in ms. */
export const RETRY_AFTER_MAX_MS = 300000;
/** The wait used when `Retry-After` is missing or not whole seconds, in ms. */
export const RETRY_AFTER_DEFAULT_MS = 5000;

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const positive = (x: number | undefined, fallback: number): number => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : fallback);

/**
 * The delay before reconnect number `attempt` (1 is the first). In: the attempt, optional `baseMs`/`capMs`, and a
 * `random` function giving 0 to 1. Out: whole milliseconds, never above `capMs`.
 */
export function nextBackoffMs(attempt: number, options: { baseMs?: number; capMs?: number }, random: () => number): number {
  const base = positive(options.baseMs, BACKOFF_BASE_MS);
  const cap = positive(options.capMs, BACKOFF_CAP_MS);
  // Not-a-number, zero and negative attempts count as the first; an infinite one simply reaches the cap.
  const n = Number.isNaN(attempt) ? 1 : Math.max(1, attempt);
  // Beyond 2^60 the product is already past any cap; clamping the exponent also keeps it finite.
  const d = Math.min(cap, base * 2 ** Math.min(60, n - 1));
  // Half the delay is fixed so a client never hammers; half is random so many clients do not move in step.
  return Math.min(cap, Math.round(d / 2 + clamp01(random()) * (d / 2)));
}

/**
 * Reads a `Retry-After` header. In: the header text (or null). Out: milliseconds. Only 1 to 6 ASCII digits count as
 * seconds, clamped into the min..max range; a date, a negative, text or nothing gives the default.
 */
export function retryAfterMs(
  header: string | null | undefined,
  options?: { minMs?: number; maxMs?: number; defaultMs?: number },
): number {
  const min = options?.minMs ?? RETRY_AFTER_MIN_MS;
  const max = options?.maxMs ?? RETRY_AFTER_MAX_MS;
  const def = options?.defaultMs ?? RETRY_AFTER_DEFAULT_MS;
  // Dates are refused on purpose: they depend on a clock the client may not share with the server.
  if (typeof header !== "string" || !/^[0-9]{1,6}$/.test(header)) return def;
  return Math.min(max, Math.max(min, Number(header) * 1000));
}

/** Clamps the server's `retry:` hint (ms) into 250..60000, so a bad value can neither spin nor stall the client. */
export function clampRetryHintMs(ms: number): number {
  if (!Number.isFinite(ms)) return 250;
  return Math.min(60000, Math.max(250, ms));
}
