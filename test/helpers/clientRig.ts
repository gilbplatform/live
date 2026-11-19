// Shared rig for the L14 tests: a fake transport factory, a fake head fetch, a fake auth, hand-settled gates and a
// recorder for what the client delivers. Nothing here touches a network, a database or a real clock.

import { vi } from "vitest";
import { createMemoryCache } from "../../src/state-cache.js";
import type { LiveCache } from "../../src/state-cache.js";
import type { TransportLike } from "../../src/session.js";
import type { LiveChange } from "../../src/types.js";
import type { LiveClient, LiveClientOptions, SeedRow, TransportFactoryContext } from "../../src/client.js";
import { createLiveClient } from "../../src/client.js";
import type { KitLiveSource, KitLiveSourceOptions } from "../../src/live-source.js";
import { createKitLiveSource } from "../../src/live-source.js";
import { cur, ent, n, row, T0 } from "./liveKit.js";
import type { Rec } from "./liveKit.js";

export const ORIGIN = "https://vault.example";
export const VAULT = "vault-1";
export const TYPES = ["Value"];
/** The head cursor the fake feed answers with. */
export const HEAD = cur(777);
export const TOKEN = "tok-SECRET-1";

export type Ctx = TransportFactoryContext<Rec>;

export interface Deferred<X> {
  promise: Promise<X>;
  resolve(v: X): void;
  reject(e: unknown): void;
}
export function deferred<X = void>(): Deferred<X> {
  let resolve!: (v: X) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<X>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
export const headBody = (next: string | null = HEAD): unknown => ({ records: [], complete: true, nextCursor: next });

/** A transport the test drives by hand. Its stop can be held, to prove nothing else starts before it settles. */
export class FakeTransport implements TransportLike {
  started = 0;
  stops = 0;
  st: { state: string; cause?: string } = { state: "connecting" };
  settled = false;
  private release: () => void = () => {};
  constructor(readonly ctx: Ctx, private readonly f: FakeFactory) {}
  start(): void {
    this.started++;
    this.f.events.push("transport.start");
  }
  stop(): Promise<void> {
    this.stops++;
    this.f.events.push("transport.stop");
    const done = (): void => {
      this.st = { state: "stopped", cause: "stopped_by_app" };
      this.settled = true;
      this.f.live--;
      this.f.events.push("transport.stopped");
    };
    if (!this.f.holdStops) {
      done();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => { this.release = () => { done(); resolve(); }; });
  }
  state(): { state: string; cause?: string } { return this.st; }
  /** Lets a held `stop()` settle. */
  settleStop(): void { this.release(); }
}

export interface FakeFactory {
  created: FakeTransport[];
  live: number;
  maxLive: number;
  holdStops: boolean;
  events: string[];
  create: (ctx: Ctx) => TransportLike;
}
export function fakeTransportFactory(events: string[]): FakeFactory {
  const f: FakeFactory = {
    created: [], live: 0, maxLive: 0, holdStops: false, events,
    create: (ctx) => {
      const tr = new FakeTransport(ctx, f);
      f.created.push(tr);
      f.live++;
      f.maxLive = Math.max(f.maxLive, f.live);
      events.push("transport.create");
      return tr;
    },
  };
  return f;
}

export interface FetchCall { url: string; headers: Record<string, string>; method: string | undefined }

/** Wraps a memory cache so the test can see loads and saves. */
export function loggedCache(events: string[]): { cache: LiveCache<Rec>; inner: LiveCache<Rec>; saves: () => number } {
  const inner = createMemoryCache<Rec>();
  let saves = 0;
  return {
    inner,
    saves: () => saves,
    cache: {
      load: () => { events.push("cache.load"); return inner.load(); },
      save: (s) => { saves++; events.push("cache.save"); return inner.save(s); },
      remove: () => inner.remove?.(),
    },
  };
}

export interface RigOptions {
  /** Use a logged memory cache with this scope. */
  cacheScope?: string;
  keyOf?: boolean;
  client?: Partial<LiveClientOptions<Rec>>;
}

/** Everything one client test needs. */
export function makeRig(opts: RigOptions = {}) {
  const events: string[] = [];
  const factory = fakeTransportFactory(events);
  const versions = new Map<string, string>();
  const fetchCalls: FetchCall[] = [];
  const authCalls: Array<{ url: string; refresh: boolean }> = [];
  const resyncCalls: string[] = [];
  const changes: Array<LiveChange<Rec>> = [];
  const state = {
    seedRows: [row("A", "v1"), row("B", "v1")] as SeedRow<Rec>[],
    respond: (_i: number): Response | Promise<Response> => json(200, headBody()),
    resyncGate: null as Deferred<void> | null,
    resyncFails: false,
    seq: 0,
  };
  const lc = opts.cacheScope !== undefined ? loggedCache(events) : null;

  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const index = fetchCalls.length;
    fetchCalls.push({ url: String(input), headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) }, method: init?.method });
    events.push("head");
    return new Promise<Response>((resolve, reject) => {
      if (init?.signal) init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      Promise.resolve(state.respond(index)).then(resolve, reject);
    });
  }) as typeof fetch;

  const auth: LiveClientOptions<Rec>["auth"] = (req, ctx) => {
    authCalls.push({ url: req.url, refresh: ctx.refresh });
    return { authorization: `Bearer ${ctx.refresh ? TOKEN + "-refreshed" : TOKEN}` };
  };

  const resync: LiveClientOptions<Rec>["resync"] = async (reason) => {
    resyncCalls.push(reason);
    events.push(`resync:${reason}`);
    if (state.resyncGate) await state.resyncGate.promise;
    if (state.resyncFails) throw new Error("app read failed");
    return state.seedRows;
  };

  const options: LiveClientOptions<Rec> = {
    origin: ORIGIN,
    vaultId: VAULT,
    types: TYPES,
    auth,
    read: async ({ entity }) => {
      const v = versions.get(entity);
      return v === undefined ? null : { record: { entityUri: entity, v }, etag: v };
    },
    resync,
    createTransport: factory.create,
    fetch: fetchFn,
    holdMs: 0,
    ...(lc ? { cache: lc.cache, cacheScope: opts.cacheScope } : {}),
    ...(opts.keyOf === false ? {} : { keyOf: (r: Rec) => r.entityUri }),
    ...opts.client,
  };
  const client = createLiveClient<Rec>(options);
  clients.push({ client, factory });
  client.store.subscribe((c) => { if (c.full) events.push("seed"); });
  client.subscribe((c) => { changes.push(c); events.push(c.full ? "deliver:full" : "deliver:partial"); });

  const rig = {
    events, factory, versions, fetchCalls, authCalls, resyncCalls, changes, state, client, lc, options,
    /** The context of the n-th transport made. */
    ctx(i = 0): Ctx {
      const tr = factory.created[i];
      if (!tr) throw new Error(`no transport ${i}`);
      return tr.ctx;
    },
    /** Pushes a created-or-changed notification for `name` at version `v`, dated later than any before. */
    change(name: string, v: string): void {
      state.seq++;
      versions.set(ent(name), v);
      client.store.push(n(name, 1000 * state.seq, v, "change", cur(state.seq)));
    },
    /** Pushes an ended notification. */
    end(name: string): void {
      state.seq++;
      versions.delete(ent(name));
      client.store.push(n(name, 1000 * state.seq, null, "ended", cur(state.seq)));
    },
    /** Starts the client and lets everything settle. */
    async startAndSettle(): Promise<void> {
      const p = client.start();
      await vi.advanceTimersByTimeAsync(0);
      await p;
    },
    async advance(ms: number): Promise<void> { await vi.advanceTimersByTimeAsync(ms); },
  };
  return rig;
}
export type Rig = ReturnType<typeof makeRig>;

// Every client a test made, so afterEach can stop them and no timer leaks into the next test.
const clients: Array<{ client: LiveClient<Rec>; factory: FakeFactory }> = [];
const sources: Array<{ stops: Array<() => void> }> = [];
export async function stopAll(): Promise<void> {
  for (const { client, factory } of clients.splice(0)) {
    factory.holdStops = false;
    for (const tr of factory.created) tr.settleStop();
    await client.stop();
  }
  for (const s of sources.splice(0)) for (const stop of s.stops) stop();
}

export const startTime = (): void => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
};

// --- Source rig ---

export interface Recorded {
  t: "change" | "status" | "tick";
  v: unknown;
}

export function recordHandlers(log: Recorded[]) {
  return {
    onChange: (c: LiveChange<Rec>): void => { log.push({ t: "change", v: c }); },
    onStatus: (s: unknown): void => { log.push({ t: "status", v: s }); },
    onTick: (at: number): void => { log.push({ t: "tick", v: at }); },
  };
}

export interface FakePage {
  visibilityState: string;
  listeners: Set<() => void>;
  addEventListener(type: "visibilitychange", fn: () => void): void;
  removeEventListener(type: "visibilitychange", fn: () => void): void;
  set(state: "visible" | "hidden"): void;
}
export function fakePage(): FakePage {
  const p: FakePage = {
    visibilityState: "visible",
    listeners: new Set(),
    addEventListener: (_t, fn) => { p.listeners.add(fn); },
    removeEventListener: (_t, fn) => { p.listeners.delete(fn); },
    set(state) { p.visibilityState = state; for (const fn of [...p.listeners]) fn(); },
  };
  return p;
}

export function makeSourceRig(extra: Partial<KitLiveSourceOptions<Rec>> = {}) {
  const events: string[] = [];
  const factory = fakeTransportFactory(events);
  const versions = new Map<string, string>();
  const fetchCalls: FetchCall[] = [];
  const resyncCalls: Array<{ vaultId: string; types: readonly string[]; reason: string }> = [];
  const state = {
    seedRows: [row("A", "v1"), row("B", "v1")] as SeedRow<Rec>[],
    respond: (_i: number): Response | Promise<Response> => json(200, headBody()),
    seq: 0,
  };
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const index = fetchCalls.length;
    fetchCalls.push({ url: String(input), headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) }, method: init?.method });
    events.push("head");
    return new Promise<Response>((resolve, reject) => {
      if (init?.signal) init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      Promise.resolve(state.respond(index)).then(resolve, reject);
    });
  }) as typeof fetch;
  const options: KitLiveSourceOptions<Rec> = {
    originOf: () => ORIGIN,
    auth: () => ({ authorization: `Bearer ${TOKEN}` }),
    read: async ({ entity }) => {
      const v = versions.get(entity);
      return v === undefined ? null : { record: { entityUri: entity, v }, etag: v };
    },
    resync: async (vaultId, types, reason) => {
      resyncCalls.push({ vaultId, types, reason });
      events.push(`resync:${reason}`);
      return state.seedRows;
    },
    createTransport: factory.create,
    fetch: fetchFn,
    holdMs: 0,
    ...extra,
  };
  const source: KitLiveSource<Rec> = createKitLiveSource<Rec>(options);
  const handle = { stops: [] as Array<() => void> };
  sources.push(handle);
  return {
    source, events, factory, versions, fetchCalls, resyncCalls, state,
    subscribe(vaultId: string, types: readonly string[], log: Recorded[]) {
      const sub = source.subscribe(vaultId, types, recordHandlers(log));
      handle.stops.push(() => sub.stop());
      return sub;
    },
    ctx(i = 0): Ctx {
      const tr = factory.created[i];
      if (!tr) throw new Error(`no transport ${i}`);
      return tr.ctx;
    },
    change(name: string, v: string, i = 0): void {
      state.seq++;
      versions.set(ent(name), v);
      this.ctx(i).store.push(n(name, 1000 * state.seq, v, "change", cur(state.seq)));
    },
    async advance(ms: number): Promise<void> { await vi.advanceTimersByTimeAsync(ms); },
  };
}
export type SourceRig = ReturnType<typeof makeSourceRig>;
