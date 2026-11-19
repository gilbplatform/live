/** The part of a transport that the session needs. The real transport satisfies it; the session does not import it. */
export interface TransportLike {
  start(): void;
  stop(): Promise<void>;
  state(): { state: string; cause?: string };
}

/**
 * Where the session is. `open`: a transport is running. `hidden_pending`: the page is hidden and the close timer runs.
 * `hidden_closed`: closed because the page stayed hidden. `reopening`: a new transport is about to start. `terminal`: the
 * transport ended for good (for example access was withdrawn) and will not be reopened. `stopped`: the app stopped the session.
 */
export type SessionState = "idle" | "open" | "hidden_pending" | "hidden_closed" | "reopening" | "terminal" | "stopped";

/** The default time a page may stay hidden before its connection is closed, in ms. */
export const DEFAULT_HIDDEN_CLOSE_MS = 60000;

/** What you give `createLiveSession`. */
export interface LiveSessionOptions {
  /** Makes a NEW transport. `resumeCursor` is the store's cursor at that moment (pass it as the transport's starting point). */
  createTransport: (ctx: { resumeCursor: string | null }) => TransportLike;
  /** Returns the cursor to resume from, usually `store.lastCursor`. */
  getResumeCursor?: () => string | null;
  /** How long a hidden page keeps its connection, in ms. Default 60000. */
  hiddenCloseMs?: number;
  /** True never closes on hidden (a wall board). */
  keepLive?: boolean;
  /** The time source. Default `Date.now`. */
  now?: () => number;
  /** Called after a show that found the transport open, and after a reopen has started. The app uses it to flush the coalescer. */
  onShow?: () => void;
  /** Called on every change of state. Errors thrown from it are swallowed. */
  onState?: (s: SessionState) => void;
}

/** The session: keeps one transport alive while the page is shown and reopens it after a long hidden time. */
export interface LiveSession {
  /** Creates and starts the first transport. Does nothing the second time. */
  start(): void;
  /** Tell the session whether the page is shown. */
  setVisible(visible: boolean): void;
  /** True never closes on hidden. */
  setKeepLive(keep: boolean): void;
  /** Stops the transport and ends the session for good. Safe to call twice. */
  stop(): Promise<void>;
  state(): SessionState;
  /** The transport that exists now, or null. */
  transport(): TransportLike | null;
}

/** The page object the app passes to `watchVisibility`: the browser's page, seen through only what the kit uses. */
export interface VisibilityPage {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
}

/**
 * Creates a session.
 *
 * @param options see `LiveSessionOptions`
 */
export function createLiveSession(options: LiveSessionOptions): LiveSession {
  const hiddenCloseMs = typeof options.hiddenCloseMs === "number" && !Number.isNaN(options.hiddenCloseMs) && options.hiddenCloseMs >= 0
    ? options.hiddenCloseMs
    : DEFAULT_HIDDEN_CLOSE_MS;
  const now = options.now ?? Date.now;

  let state: SessionState = "idle";
  let current: TransportLike | null = null;
  // A transport that is being stopped. While it exists, no new transport may be made: the store's order holds only within
  // one source, so two transports alive at once could deliver out of order.
  let stopping: Promise<void> | null = null;
  let started = false;
  let ended = false;
  let visible = true;
  let keepLive = options.keepLive === true;
  let hiddenAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopPromise: Promise<void> | null = null;

  function setState(next: SessionState): void {
    if (state === next) return;
    state = next;
    try {
      options.onState?.(next);
    } catch {
      // A broken callback must not break the session.
    }
  }

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  /** A transport that ended for good: stopped by something other than this app. */
  function isTerminal(tr: TransportLike): boolean {
    let s: { state: string; cause?: string };
    try {
      s = tr.state();
    } catch {
      return false;
    }
    return s.state === "stopped" && typeof s.cause === "string" && s.cause !== "stopped_by_app";
  }

  function isDead(tr: TransportLike): boolean {
    try {
      return tr.state().state === "stopped";
    } catch {
      return false;
    }
  }

  // Reads the state through a function, so the compiler does not narrow it after a call that changes it.
  const stateIs = (s: SessionState): boolean => state === s;

  function notifyShow(): void {
    try {
      options.onShow?.();
    } catch {
      // A broken callback must not break the session.
    }
  }

  // A new transport, never a restart: a stopped transport is finished, and a new one starts from the store's cursor, which
  // is the single resume point. The cursor is read now, after the old transport settled, so it is never stale.
  function open(): void {
    let resumeCursor: string | null = null;
    try {
      resumeCursor = options.getResumeCursor?.() ?? null;
    } catch {
      resumeCursor = null;
    }
    try {
      const tr = options.createTransport({ resumeCursor });
      current = tr;
      tr.start();
    } catch {
      current = null;
      setState("terminal");
      return;
    }
    setState("open");
  }

  /** Stops the current transport and, when it has settled, goes on according to what the page wants by then. */
  function closeCurrent(): void {
    const old = current;
    if (!old || stopping) return;
    let p: Promise<void>;
    try {
      p = Promise.resolve(old.stop());
    } catch {
      p = Promise.resolve();
    }
    stopping = p.catch(() => {}).then(() => {
      current = null;
      stopping = null;
      afterStop();
    });
  }

  function afterStop(): void {
    if (ended || state === "terminal") return;
    // The page may have come back (or keep-live turned on) while the stop was settling.
    if (visible || keepLive) {
      setState("reopening");
      open();
      if (stateIs("open")) notifyShow();
    } else {
      setState("hidden_closed");
    }
  }

  function armTimer(): void {
    clearTimer();
    timer = setTimeout(onTimer, hiddenCloseMs);
  }

  function onTimer(): void {
    timer = undefined;
    if (ended || !current || stopping || visible || keepLive) return;
    if (isTerminal(current)) {
      setState("terminal");
      return;
    }
    closeCurrent();
  }

  return {
    start(): void {
      if (started || ended) return;
      started = true;
      open();
      if (stateIs("open") && !visible && !keepLive) {
        setState("hidden_pending");
        armTimer();
      }
    },
    setVisible(next: boolean): void {
      if (next === visible) return;
      visible = next;
      if (!next) {
        hiddenAt = now();
        if (!started || ended || state === "terminal") return;
        if (keepLive) return;
        if (current && !stopping) {
          setState("hidden_pending");
          armTimer();
        }
        return;
      }
      clearTimer();
      if (!started || ended || state === "terminal") return;
      if (stopping) {
        // The close is still settling: the new transport waits for it, then afterStop opens it.
        setState("reopening");
        return;
      }
      if (!current) {
        setState("reopening");
        open();
        if (stateIs("open")) notifyShow();
        return;
      }
      if (isTerminal(current)) {
        setState("terminal");
        return;
      }
      // Browsers throttle timers in hidden tabs, so the timer may not have fired. The elapsed time is checked again here.
      const overdue = !keepLive && hiddenAt !== null && now() - hiddenAt >= hiddenCloseMs;
      if (overdue || isDead(current)) {
        setState("reopening");
        closeCurrent();
        return;
      }
      setState("open");
      notifyShow();
    },
    setKeepLive(keep: boolean): void {
      keepLive = keep;
      if (!started || ended || state === "terminal") return;
      if (keep) {
        clearTimer();
        if (state === "hidden_pending") setState("open");
        else if (state === "hidden_closed" && !stopping) {
          setState("reopening");
          open();
          if (stateIs("open")) notifyShow();
        }
        return;
      }
      if (!visible && current && !stopping) {
        hiddenAt = now();
        setState("hidden_pending");
        armTimer();
      }
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      // Set at once, so nothing can be recreated while the stop settles.
      ended = true;
      clearTimer();
      stopPromise = (async () => {
        if (stopping) await stopping;
        const tr = current;
        if (tr) {
          try {
            await tr.stop();
          } catch {
            // A transport that fails to stop is released anyway.
          }
        }
        current = null;
        clearTimer();
        setState("stopped");
      })();
      return stopPromise;
    },
    state: () => state,
    transport: () => current,
  };
}

/**
 * Connects a session to the page's visibility. Call it with the browser's page object; the kit never names a global.
 *
 * @param session the session to drive
 * @param page the page object (it has `visibilityState` and `visibilitychange` events)
 * @returns the function that detaches it
 */
export function watchVisibility(session: LiveSession, page: VisibilityPage): () => void {
  const update = (): void => { session.setVisible(page.visibilityState !== "hidden"); };
  page.addEventListener("visibilitychange", update);
  update();
  return () => { page.removeEventListener("visibilitychange", update); };
}
