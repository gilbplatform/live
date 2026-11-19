// Shared helpers for the L12 tests: records, notifications, hand-settled readers, a seeded random generator.

import type { LiveNotification, LiveRead, LiveStoreOptions, ReadBatchHint, RowChange, StoreRow } from "../../src/types.js";

export interface Rec {
  entityUri: string;
  v: string;
}

/** A valid cursor made from a number (40 to 4096 characters of the allowed set). */
export const cur = (i: number): string => String(i).padStart(43, "c");
export const CURSOR = cur(0);
export const TYPE = "https://vault.example/t/Value";
export const ent = (name: string): string => `https://vault.example/e/${name}`;
export const nameOf = (entity: string): string => entity.slice(ent("").length);
export const T0 = Date.UTC(2026, 10, 19, 10, 0, 0);
/** An ISO time `ms` milliseconds after 10:00:00Z. */
export const t = (ms: number): string => new Date(T0 + ms).toISOString();

/** A notification. `ms` null gives an unreadable source time. */
export const n = (
  name: string,
  ms: number | null,
  etag: string | null,
  kind: "change" | "ended" = "change",
  cursor: string | null = CURSOR,
): LiveNotification => ({
  kind,
  entity: ent(name),
  typeUri: TYPE,
  etag,
  updatedAt: ms === null ? null : t(ms),
  receivedAt: t(0),
  cursor,
});

export const rd = (name: string, etag: string): LiveRead<Rec> => ({ record: { entityUri: ent(name), v: etag }, etag });

export const at = <X,>(a: readonly X[], i: number): X => {
  const v = a[i];
  if (v === undefined) throw new Error(`no item at ${i} (length ${a.length})`);
  return v;
};

/** A row as the store emits it. */
export const row = (name: string, v: string, etag: string | null = v): StoreRow<Rec> => ({
  entity: ent(name),
  typeUri: TYPE,
  etag,
  updatedAt: null,
  record: { entityUri: ent(name), v },
});

/** A row change. */
export const rc = (rows: StoreRow<Rec>[], ended: string[] = [], full = false, atMs = 0): RowChange<Rec> => ({ full, rows, ended, at: atMs });

/** Seeded random generator (mulberry32): the same seed gives the same sequence. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Call {
  entity: string;
  typeUri: string;
  signal: AbortSignal;
  resolve(v: LiveRead<Rec> | null): void;
  reject(e: unknown): void;
}

/** A single-record reader whose answers the test settles by hand. */
export function fakeReader() {
  const calls: Call[] = [];
  const read: NonNullable<LiveStoreOptions<Rec>["read"]> = (nn, signal) =>
    new Promise((resolve, reject) => {
      calls.push({ entity: nn.entity, typeUri: nn.typeUri, signal, resolve, reject });
    });
  return { read, calls };
}

export type BatchAnswer = Map<string, LiveRead<Rec> | null>;
export interface BatchCall {
  items: Array<{ entity: string; typeUri: string }>;
  signal: AbortSignal;
  hint: ReadBatchHint;
  resolve(m: BatchAnswer): void;
  reject(e: unknown): void;
}

/** A batch reader whose answers the test settles by hand. It tracks how many calls are open at once. */
export function fakeBatchReader() {
  const calls: BatchCall[] = [];
  let open = 0;
  let maxOpen = 0;
  const readBatch: NonNullable<LiveStoreOptions<Rec>["readBatch"]> = (items, signal, hint) =>
    new Promise((resolve, reject) => {
      open++;
      maxOpen = Math.max(maxOpen, open);
      calls.push({
        items: items.map((i) => ({ entity: i.entity, typeUri: i.typeUri })),
        signal,
        hint,
        resolve: (m) => { open--; resolve(m); },
        reject: (e) => { open--; reject(e); },
      });
    });
  /** Answers every item of a call with `etagOf(name)` as value and etag. */
  const answerAll = (call: BatchCall, etagOf: (name: string) => string = (nm) => `${nm}-1`): void => {
    const m: BatchAnswer = new Map();
    for (const i of call.items) m.set(i.entity, rd(nameOf(i.entity), etagOf(nameOf(i.entity))));
    call.resolve(m);
  };
  return { readBatch, calls, maxOpen: () => maxOpen, answerAll };
}
