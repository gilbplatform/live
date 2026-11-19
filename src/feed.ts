// Addresses for the live stream and the change feed, the reading of one feed page, and its turn into notifications.
import type { LiveNotification } from "./types.js";

const TYPE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]{40,4096}$/;
const MAX_TYPES = 20;

/**
 * Checks and tidies a server origin. In: `scheme://host[:port]`, trailing slashes allowed. Out: the origin without them.
 * Throws when there is a path, query, fragment or credentials.
 */
export function normalizeOrigin(origin: string): string {
  const o = typeof origin === "string" ? origin.replace(/\/+$/, "") : "";
  if (!/^https?:\/\/[^/?#@]+$/.test(o)) throw new Error("origin must be scheme://host[:port] with no path or credentials");
  return o;
}

/** True for an opaque resume cursor: 40 to 4096 characters from `A-Z a-z 0-9 _ -`. */
export function isCursor(x: unknown): x is string {
  return typeof x === "string" && CURSOR_RE.test(x);
}

// The URL builders accept only a closed set of shapes, so no credential or odd text can ever end up in an address.
function checkSince(since: string): void {
  if (since !== "start" && since !== "head" && !isCursor(since)) throw new Error("since must be start, head or a cursor");
}

function typeParts(types: readonly string[] | undefined): string {
  if (!types) return "";
  const seen = new Set<string>();
  for (const t of types) {
    if (typeof t !== "string" || !TYPE_RE.test(t)) throw new Error("type must be a bare name of 1 to 64 letters, digits, _ or -");
    seen.add(t);
  }
  if (seen.size > MAX_TYPES) throw new Error("at most 20 distinct types");
  return [...seen].map((t) => `&type=${encodeURIComponent(t)}`).join("");
}

/** Replaces the first `&` with `?` so the first query part never starts with an ampersand. */
function asQuery(parts: string): string {
  return parts === "" ? "" : `?${parts.slice(1)}`;
}

/**
 * The address of the live stream. In: origin, vault id, optional `since` (`start`, `head` or a cursor) and `types`.
 * Out: `<origin>/lws/vault/<vault>/live` plus `since` and one `type=` per distinct type. Throws on any other shape.
 */
export function liveUrl(origin: string, vaultId: string, o?: { types?: readonly string[]; since?: string }): string {
  const base = `${normalizeOrigin(origin)}/lws/vault/${encodeURIComponent(vaultId)}/live`;
  let q = "";
  if (o?.since !== undefined) {
    checkSince(o.since);
    q += `&since=${o.since}`;
  }
  q += typeParts(o?.types);
  return base + asQuery(q);
}

/**
 * The address of one change-feed page. In: origin, vault id, `since` (required), `lifecycle` (`ended` asks for deleted
 * records), `types` and `limit` (1 to 200). Out: `<origin>/lws/vault/<vault>/records?...`. Throws on any other shape.
 */
export function feedUrl(
  origin: string,
  vaultId: string,
  o: { since: string; lifecycle?: "live" | "ended"; types?: readonly string[]; limit?: number },
): string {
  const base = `${normalizeOrigin(origin)}/lws/vault/${encodeURIComponent(vaultId)}/records`;
  checkSince(o.since);
  let q = `&since=${o.since}`;
  if (o.lifecycle === "ended") q += "&lifecycle=ended";
  q += typeParts(o.types);
  if (o.limit !== undefined) {
    if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > 200) throw new Error("limit must be an integer from 1 to 200");
    q += `&limit=${o.limit}`;
  }
  return base + asQuery(q);
}

/** One feed page as the transport reads it: only the fields it needs. */
export interface FeedPage {
  rows: { entity: string; typeUri: string; updatedAt: string | null }[];
  nextCursor: string | null;
  complete: boolean;
}

/** Reads the JSON of a feed answer. Out: the page, or null when anything is the wrong shape. Other keys are never copied. */
export function parseFeedPage(json: unknown): FeedPage | null {
  if (typeof json !== "object" || json === null) return null;
  const j = json as Record<string, unknown>;
  if (!Array.isArray(j.records) || typeof j.complete !== "boolean") return null;
  const next = j.nextCursor;
  if (next !== undefined && next !== null && !isCursor(next)) return null;
  const rows: FeedPage["rows"] = [];
  for (const r of j.records as unknown[]) {
    if (typeof r !== "object" || r === null) return null;
    const row = r as Record<string, unknown>;
    if (typeof row.entity !== "string" || row.entity === "" || typeof row.typeUri !== "string" || row.typeUri === "") return null;
    const u = row.updatedAt;
    if (u !== undefined && u !== null && typeof u !== "string") return null;
    rows.push({ entity: row.entity, typeUri: row.typeUri, updatedAt: typeof u === "string" ? u : null });
  }
  return { rows, nextCursor: typeof next === "string" ? next : null, complete: j.complete };
}

/**
 * Turns a page into notifications for the store, in row order. In: the page, whether its rows are `change` or `ended`,
 * and the receive time. Out: one notification per row; `etag` is null.
 */
export function notificationsFromFeed(page: FeedPage, kind: "change" | "ended", receivedAt: Date): LiveNotification[] {
  const at = receivedAt.toISOString();
  const out: LiveNotification[] = page.rows.map((r) => ({
    kind,
    entity: r.entity,
    typeUri: r.typeUri,
    etag: null,
    updatedAt: r.updatedAt,
    receivedAt: at,
    cursor: null,
  }));
  // Only the last row carries the cursor, because the cursor names the position AFTER the whole page. An ended-feed
  // cursor has a different scope than the live stream and is withheld: it must never become the store's resume point.
  if (kind === "change" && page.nextCursor !== null && out.length > 0) out[out.length - 1]!.cursor = page.nextCursor;
  return out;
}
