import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { createLiveClient } from "../client.js";
import type { LiveClient, LiveClientOptions } from "../client.js";
import type { DotState } from "../state.js";

/**
 * What you give `useLive`: the client's options, plus `keyOf` (required here: the hook returns the list) and `enabled`.
 * Only `enabled`, `origin`, `vaultId`, `types` and `cacheScope` restart the connection when they change; the callbacks
 * (`auth`, `read`, `readBatch`, `resync`, `createTransport`, `keyOf`, `cache`) are always the latest ones; the remaining
 * options (timings, `fetch`, `page`, `now`, `schedule`) are read when the client is made.
 */
export type UseLiveOptions<T> = LiveClientOptions<T> & {
  /** False makes no client and no request. Default true. */
  enabled?: boolean;
  keyOf: (record: T) => string;
};

/** What `useLive` returns. The pause control belongs to the app: the hook gives only `pause`, `resume`, `paused` and `waiting`. */
export interface UseLiveResult<T> {
  /** The delivered list. The same array until the next delivery. */
  records: T[];
  dot: DotState;
  /** How many records changed since the screen was last updated. Counted only while paused; 0 otherwise. */
  waiting: number;
  paused: boolean;
  /** True while the list is a restored one that the server has not confirmed. */
  stale: boolean;
  /** How many records were announced but could not be read yet. While above 0 the dot does not say Live. */
  owed: number;
  /** When the screen was last known to be current (epoch ms), or null. */
  asOf: number | null;
  /** True after the first full list has been delivered. */
  ready: boolean;
  pause(): void;
  resume(): void;
  setKeepLive(b: boolean): void;
  /** The client behind the hook, or null while there is none (disabled, or not yet made). */
  client: LiveClient<T> | null;
}

interface Snap<T> {
  /** Which connection this belongs to; a snapshot of another key is never shown. */
  key: string;
  records: T[];
  dot: DotState;
  waiting: number;
  paused: boolean;
  stale: boolean;
  owed: number;
  asOf: number | null;
  ready: boolean;
  client: LiveClient<T> | null;
}

const NO_RECORDS: never[] = [];

function idleDot(enabled: boolean): DotState {
  return {
    kind: enabled ? "connecting" : "stopped",
    showLive: false, asOf: null, ageMs: null, retryAt: null, waiting: 0, owed: 0,
    cause: enabled ? null : "stopped_by_app",
    link: enabled ? "connecting" : "none", mode: null, quiet: false, at: 0,
  };
}

function idleSnap<T>(key: string, enabled: boolean): Snap<T> {
  const dot = idleDot(enabled);
  return { key, records: NO_RECORDS as T[], dot, waiting: 0, paused: false, stale: false, owed: 0, asOf: null, ready: false, client: null };
}

/** Two dots read the same on screen. `ageMs` and `at` move every moment; `waiting` matters only while paused. */
function sameDot(a: DotState, b: DotState, paused: boolean): boolean {
  return a.kind === b.kind && a.showLive === b.showLive && a.asOf === b.asOf && a.retryAt === b.retryAt
    && a.cause === b.cause && a.link === b.link && a.mode === b.mode && a.quiet === b.quiet && a.owed === b.owed
    && (!paused || a.waiting === b.waiting);
}

interface Store<T> {
  snap: Snap<T>;
  /** The stop of the most recent client; the next client starts only after it. */
  stopping: Promise<void>;
  replace(next: Snap<T>): void;
  patch(change: Partial<Snap<T>>, owner: LiveClient<T>): void;
  subscribe(fn: () => void): () => void;
  getSnapshot(): Snap<T>;
}

function makeStore<T>(first: Snap<T>): Store<T> {
  const listeners = new Set<() => void>();
  const store: Store<T> = {
    snap: first,
    stopping: Promise.resolve(),
    replace(next) {
      store.snap = next;
      for (const fn of [...listeners]) fn();
    },
    patch(change, owner) {
      // A late call from a client that has been replaced must not write into the new one's snapshot.
      if (store.snap.client !== owner) return;
      const cur = store.snap;
      const next = { ...cur, ...change };
      let differs = false;
      for (const k of Object.keys(next) as Array<keyof Snap<T>>) {
        if (next[k] !== cur[k]) { differs = true; break; }
      }
      // An unchanged snapshot keeps its identity, so nothing renders for it.
      if (differs) store.replace(next);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    getSnapshot: () => store.snap,
  };
  return store;
}

/**
 * Keeps one vault's list live in a React component.
 *
 * @param options see `UseLiveOptions`
 * @returns the list, the dot's state and the controls; see `UseLiveResult`
 */
export function useLive<T>(options: UseLiveOptions<T>): UseLiveResult<T> {
  const enabled = options.enabled !== false;
  const { origin, vaultId, cacheScope } = options;
  const typesKey = options.types.join(",");
  const key = enabled ? JSON.stringify([origin, vaultId, typesKey, cacheScope ?? null]) : "";

  // Other options are read through a ref: a callback that is a new function on every render must not restart the connection.
  const latest = useRef(options);
  useEffect(() => { latest.current = options; });

  const holder = useRef<Store<T> | null>(null);
  if (holder.current === null) holder.current = makeStore<T>(idleSnap<T>(key, enabled));
  const store = holder.current;

  // The client is made in an effect, never in render: a render must have no side effect (React may run it twice or throw it away).
  useEffect(() => {
    const needsReset = store.snap.key !== key || store.snap.client !== null;
    if (!enabled) {
      if (needsReset) store.replace(idleSnap<T>(key, false));
      return;
    }
    if (needsReset) store.replace(idleSnap<T>(key, true));

    const o = latest.current;
    const { enabled: _enabled, ...rest } = o;
    const client = createLiveClient<T>({
      ...rest,
      auth: (request, context) => latest.current.auth(request, context),
      resync: (reason) => latest.current.resync(reason),
      // Without one, the client builds the kit's own transport.
      ...(o.createTransport ? { createTransport: (ctx: Parameters<NonNullable<typeof o.createTransport>>[0]) => latest.current.createTransport!(ctx) } : {}),
      keyOf: (record) => latest.current.keyOf(record),
      ...(o.read ? { read: (item: { entity: string; typeUri: string }, signal: AbortSignal) => latest.current.read?.(item, signal) ?? Promise.resolve(null) } : {}),
      ...(o.readBatch ? { readBatch: (...args: Parameters<NonNullable<typeof o.readBatch>>) => latest.current.readBatch!(...args) } : {}),
      ...(o.cache
        ? {
          cache: {
            load: () => latest.current.cache?.load() ?? null,
            save: (state: Parameters<NonNullable<typeof o.cache>["save"]>[0]) => latest.current.cache?.save(state),
            remove: () => latest.current.cache?.remove?.(),
          },
        }
        : {}),
    });

    const first = client.dot();
    store.replace({ ...idleSnap<T>(key, true), client, dot: first, asOf: first.asOf, stale: client.stale(), owed: client.owed() });

    const offs = [
      client.subscribe((change) => {
        store.patch({ records: client.records(), ready: store.snap.ready || change.full, stale: client.stale() }, client);
      }),
      client.subscribeDot((d) => {
        const paused = client.paused();
        const cur = store.snap;
        // Counting up what waits is not news while the screen is not paused; the dot is kept as it was.
        const dot = sameDot(cur.dot, d, paused) ? cur.dot : d;
        store.patch({ dot, asOf: dot.asOf, paused, waiting: paused ? d.waiting : 0 }, client);
      }),
      client.subscribeWaiting((n) => {
        const paused = client.paused();
        store.patch({ waiting: paused ? n : 0, paused }, client);
      }),
      client.subscribeStale((stale) => { store.patch({ stale }, client); }),
      client.subscribeOwed((owed) => { store.patch({ owed }, client); }),
    ];

    // --- Start after the previous client has stopped ---
    // Two clients for one list must never hold two connections: the new one starts only once the old one's stop has settled.
    let alive = true;
    void store.stopping
      .then(() => (alive ? client.start() : undefined))
      .catch(() => {
        if (!alive) return;
        // The start failed (the starting position could not be read). Saying "connecting" for ever would be a false status.
        const d = client.dot();
        store.patch({ dot: { ...d, kind: "offline", showLive: false, cause: "could_not_load", link: "offline", at: (latest.current.now ?? Date.now)() } }, client);
      });

    return () => {
      alive = false;
      for (const off of offs) off();
      store.stopping = client.stop().catch(() => {});
    };
  }, [store, enabled, key]);

  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  // Between a change of key and the effect that follows it, the old connection's list must not be shown for the new one.
  const idle = useMemo(() => idleSnap<T>(key, enabled), [key, enabled]);
  const view = snap.key === key ? snap : idle;

  const pause = useCallback(() => {
    const c = store.snap.client;
    if (!c) return;
    c.pause();
    store.patch({ paused: c.paused(), waiting: c.waiting() }, c);
  }, [store]);
  const resume = useCallback(() => {
    const c = store.snap.client;
    if (!c) return;
    c.resume();
    store.patch({ paused: c.paused(), waiting: 0 }, c);
  }, [store]);
  const setKeepLive = useCallback((b: boolean) => { store.snap.client?.setKeepLive(b); }, [store]);

  return useMemo(
    () => ({
      records: view.records, dot: view.dot, waiting: view.waiting, paused: view.paused, stale: view.stale, owed: view.owed,
      asOf: view.asOf, ready: view.ready, pause, resume, setKeepLive, client: view.client,
    }),
    [view, pause, resume, setKeepLive],
  );
}
