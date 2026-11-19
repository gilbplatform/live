// Test mirror of the pure `applyChange` function of the dashboard adapter that consumes this store.
// Source: the adapter's liveAdapter.ts at commit a7cb8cff (copied, with a local record type in place of the app's own).
// It exists only so contract.test.ts can prove the store's output applies to a held list the way that adapter applies it.

import type { LiveChange } from "../../src/index.js";

/** The record shape the mirror needs: an optional entity address. */
export interface MirrorRecord {
  entityUri?: string;
}

/** The records held after a change (pure). A full change gives `change.records`; a partial one replaces by `entityUri`, appends new ones in order given, then removes `change.ended`. */
export function applyChange<R extends MirrorRecord>(held: readonly R[], change: LiveChange<R>): R[] {
  if (change.full) return [...change.records];
  const changed = new Map<string, R>();
  for (const r of change.records) if (r.entityUri !== undefined) changed.set(r.entityUri, r);
  const out: R[] = [];
  const placed = new Set<string>();
  for (const r of held) {
    const swap = r.entityUri !== undefined ? changed.get(r.entityUri) : undefined;
    out.push(swap ?? r);
    if (swap && r.entityUri !== undefined) placed.add(r.entityUri);
  }
  for (const [entity, r] of changed) if (!placed.has(entity)) out.push(r);
  if (change.ended.length === 0) return out;
  const gone = new Set(change.ended);
  return out.filter((r) => r.entityUri === undefined || !gone.has(r.entityUri));
}
