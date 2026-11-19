import type { LiveNotification } from "./types.js";

const MAX_ADDRESS = 2048;
const CURSOR_SHAPE = /^[A-Za-z0-9_-]{40,4096}$/;

function address(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ADDRESS;
}

/** A string, null, or a missing key are all fine (the last two give null). Returns `undefined` for anything else. */
function stringOrNull(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  return typeof v === "string" ? v : undefined;
}

/**
 * Turns the JSON of one stream event (plus the `id:` line as `cursor`) into a notification, or null when the shape is wrong.
 * Never throws. Only the six known fields and the cursor are kept.
 *
 * @param data the parsed JSON of the event's data line
 * @param cursor the event's `id:` value, or null; a string of 40 to 4096 characters from `A-Za-z0-9_-` is kept
 */
export function parseLiveNotification(data: unknown, cursor: string | null): LiveNotification | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.kind !== "change" && d.kind !== "ended") return null;
  if (!address(d.entity) || !address(d.typeUri)) return null;
  const etag = stringOrNull(d.etag);
  const updatedAt = stringOrNull(d.updatedAt);
  if (etag === undefined || updatedAt === undefined) return null;
  if (typeof d.receivedAt !== "string") return null;
  if (cursor !== null && (typeof cursor !== "string" || !CURSOR_SHAPE.test(cursor))) return null;
  // Built key by key on purpose: the store must never carry data the server did not mean to send, so a future
  // server mistake (a record body or a field value in the event) cannot reach a screen. Do not spread `data`.
  return { kind: d.kind, entity: d.entity, typeUri: d.typeUri, etag, updatedAt, receivedAt: d.receivedAt, cursor };
}
