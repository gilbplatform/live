import { createLiveClient } from "./client.js";
import type { AuthProviderLike, LiveClientOptions, SeedRow, TransportFactoryContext } from "./client.js";
import type { TransportLike, VisibilityPage } from "./session.js";
import type { LiveCache } from "./state-cache.js";
import { toLiveStatusInfo } from "./state.js";
import type { LiveStatusInfo } from "./state.js";
import type { LiveChange, LiveStoreOptions } from "./types.js";

/** What you give `createKitLiveSource`. */
export interface KitLiveSourceOptions<T> {
  /** The server origin for a vault. */
  originOf: (vaultId: string) => string;
  auth: AuthProviderLike;
  read?: LiveStoreOptions<T>["read"];
  readBatch?: LiveStoreOptions<T>["readBatch"];
  readBatchSize?: number;
  /** The app's full read of the list for a vault and its types. */
  resync: (vaultId: string, types: readonly string[], reason: "initial" | "bad_cursor" | "poll_start") => Promise<ReadonlyArray<SeedRow<T>>>;
  /** Makes one transport. Optional: without it each client uses the kit's own transport. */
  createTransport?: (ctx: TransportFactoryContext<T>) => TransportLike;
  /** The app's storage for a vault and its types, bound to its own key, or undefined for none. */
  cacheFor?: (vaultId: string, types: readonly string[]) => { cache: LiveCache<T>; scope: string } | undefined;
  /** The browser's page object, for hidden-tab handling. */
  pageFor?: VisibilityPage;
  fetch?: typeof fetch;
  holdMs?: number;
  coalesceMs?: number;
  schedule?: LiveClientOptions<T>["schedule"];
  hiddenCloseMs?: number;
  keepLive?: boolean;
  heartbeatWindowMs?: number;
  pollWindowMs?: number;
  offlineAfterMs?: number;
  now?: () => number;
}

/** What `subscribe` calls back. */
export interface KitLiveHandlers<T> {
  onChange(change: LiveChange<T>): void;
  onStatus?(info: LiveStatusInfo): void;
  onTick?(at: number): void;
}

/** A source with the shape of the app's own live source: one call per subscription, one handle to stop it. */
export interface KitLiveSource<T> {
  subscribe(vaultId: string, typeNames: readonly string[], handlers: KitLiveHandlers<T>): { stop(): void };
}

/**
 * Makes a source that follows the contract of a dashboard app's own live adapter, built on the headless client.
 *
 * @param options how to reach the server and how to read the list; see `KitLiveSourceOptions`
 * @returns the source; each `subscribe` makes its own client
 */
export function createKitLiveSource<T>(options: KitLiveSourceOptions<T>): KitLiveSource<T> {
  const now = options.now ?? Date.now;
  return {
    subscribe(vaultId, typeNames, handlers) {
      // Checked before any client, request or callback exists.
      if (!Array.isArray(typeNames) || typeNames.length === 0) throw new Error("a live subscription needs at least one type name");
      const types = [...typeNames];
      const cache = options.cacheFor?.(vaultId, types);
      // One client per subscription: two lists must never share a store, a cursor or a connection.
      const client = createLiveClient<T>({
        origin: options.originOf(vaultId),
        vaultId,
        types,
        auth: options.auth,
        read: options.read,
        readBatch: options.readBatch,
        readBatchSize: options.readBatchSize,
        resync: (reason) => options.resync(vaultId, types, reason),
        createTransport: options.createTransport,
        fetch: options.fetch,
        holdMs: options.holdMs,
        coalesceMs: options.coalesceMs,
        schedule: options.schedule,
        hiddenCloseMs: options.hiddenCloseMs,
        keepLive: options.keepLive,
        heartbeatWindowMs: options.heartbeatWindowMs,
        pollWindowMs: options.pollWindowMs,
        offlineAfterMs: options.offlineAfterMs,
        page: options.pageFor,
        now: options.now,
        ...(cache ? { cache: cache.cache, cacheScope: cache.scope } : {}),
      });

      let stopped = false;
      // The app's own adapter calls the handlers in this order: data, then status, then tick. They are wired in that order.
      const offChange = client.subscribe((change) => { if (!stopped) handlers.onChange(change); });
      let last: LiveStatusInfo | null = null;
      const status = (info: LiveStatusInfo): void => {
        if (stopped) return;
        // Only a different answer is a change for the app: kinds that mean the same status (live and polling) stay quiet.
        if (last !== null && last.status === info.status && last.cause === info.cause) return;
        last = info;
        handlers.onStatus?.(info);
      };
      const offDot = client.subscribeDot((dot) => { status(toLiveStatusInfo(dot)); });
      const offTick = client.subscribeTick((at) => { if (!stopped) handlers.onTick?.(at); });
      status(toLiveStatusInfo(client.dot()));

      client.start().catch(() => {
        // The cause is the app's or the network's and may hold an address; the app only learns that the start failed.
        if (!stopped) status({ status: "offline", at: now(), cause: "start_failed" });
      });

      return {
        stop(): void {
          if (stopped) return;
          stopped = true;
          offChange();
          offDot();
          offTick();
          void client.stop();
        },
      };
    },
  };
}
