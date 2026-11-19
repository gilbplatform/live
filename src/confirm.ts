/** The confirmation clock: the last moment we knew the server had spoken to us. */
export interface ConfirmationClock {
  /** Records a confirmation at `at` (default: now). A time that is not a finite number, or older than the last, is ignored. Calls the subscribers. */
  confirm(at?: number): void;
  /** The latest confirmation in epoch milliseconds, or null when there has been none. */
  lastConfirmedAt(): number | null;
  /** Calls `fn` with the time of every confirmation. Returns the function that stops it. */
  subscribe(fn: (at: number) => void): () => void;
}

/**
 * Creates a confirmation clock. The transport confirms it; the coalescer and the state cache read it.
 *
 * @param options `now` replaces the time source (default `Date.now`)
 */
export function createConfirmationClock(options?: { now?: () => number }): ConfirmationClock {
  const now = options?.now ?? Date.now;
  const subscribers = new Set<(at: number) => void>();
  let last: number | null = null;

  return {
    confirm(at?: number): void {
      const value = at ?? now();
      // A heartbeat, a received event and a quiet successful poll all count as "we heard from the server just now",
      // so a stream with no changes can still say how fresh it is. A confirmation never goes backwards: an old one
      // arriving late must not make the screen look staler than it is.
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      if (last !== null && value < last) return;
      last = value;
      for (const fn of [...subscribers]) {
        try {
          fn(value);
        } catch (error) {
          console.error(`[live] a subscriber threw: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
    },
    lastConfirmedAt: () => last,
    subscribe(fn): () => void {
      subscribers.add(fn);
      return () => { subscribers.delete(fn); };
    },
  };
}
