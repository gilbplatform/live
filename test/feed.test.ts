import { describe, expect, test } from "vitest";
import { feedUrl, isCursor, liveUrl, normalizeOrigin, notificationsFromFeed, parseFeedPage, type FeedPage } from "../src/feed.js";

const O = "https://a.example";
const C = "C".repeat(43);
const D = "D".repeat(43);

describe("feed urls", () => {
  // Spec: Kit.Client, Transport: build the stream address from a closed set of parts (LiveWire step, check Contract.Url)
  test("F1 liveUrl", () => {
    expect(liveUrl(O, "v1")).toBe(`${O}/lws/vault/v1/live`);
    expect(liveUrl(O, "v1", { since: "head" })).toBe(`${O}/lws/vault/v1/live?since=head`);
    expect(liveUrl(O, "v1", { since: "start" })).toBe(`${O}/lws/vault/v1/live?since=start`);
    expect(liveUrl(O, "v1", { since: C })).toBe(`${O}/lws/vault/v1/live?since=${C}`);
    expect(liveUrl(O, "v1", { types: ["Value", "Scale"] })).toBe(`${O}/lws/vault/v1/live?type=Value&type=Scale`);
    expect(liveUrl(O, "v1", { since: C, types: ["B", "A", "B", "A_1", "x-y"] })).toBe(`${O}/lws/vault/v1/live?since=${C}&type=B&type=A&type=A_1&type=x-y`);
    expect(liveUrl(O, "https://p.example/v 1", {})).toBe(`${O}/lws/vault/${encodeURIComponent("https://p.example/v 1")}/live`);
    expect(liveUrl(O, "https://p.example/v 1", {})).not.toContain("/v 1");
    // A trailing slash on the origin is dropped.
    expect(liveUrl(`${O}/`, "v1")).toBe(`${O}/lws/vault/v1/live`);
    expect(liveUrl(O, "v1", { types: [] })).toBe(`${O}/lws/vault/v1/live`);
  });

  // Spec: Kit.Client, Transport: refuse odd text before it reaches a URL (check Contract.Url)
  test("F2 liveUrl refuses bad input", () => {
    for (const since of ["a b", "A".repeat(39), "START", "", "Head", "A".repeat(4097), "a/b" + "c".repeat(40)]) {
      expect(() => liveUrl(O, "v1", { since }), JSON.stringify(since.slice(0, 20))).toThrow();
    }
    for (const t of ["t:Person", "x".repeat(65), "", "a b", "a&type=b", "a/b"]) {
      expect(() => liveUrl(O, "v1", { types: [t] }), JSON.stringify(t.slice(0, 20))).toThrow();
    }
    const many = Array.from({ length: 21 }, (_, i) => `T${i}`);
    expect(() => liveUrl(O, "v1", { types: many })).toThrow();
    expect(() => liveUrl(O, "v1", { types: many.slice(0, 20) })).not.toThrow();
    // Duplicates do not count towards the 20.
    expect(() => liveUrl(O, "v1", { types: [...many.slice(0, 20), "T0", "T1"] })).not.toThrow();
    expect(() => liveUrl(O, "v1", { types: ["x".repeat(64)] })).not.toThrow();
  });

  // Spec: Kit.Client, Transport: the feed address (check Contract.Url)
  test("F3 feedUrl", () => {
    expect(feedUrl(O, "v1", { since: "head" })).toBe(`${O}/lws/vault/v1/records?since=head`);
    expect(feedUrl(O, "v1", { since: C, lifecycle: "live" })).toBe(`${O}/lws/vault/v1/records?since=${C}`);
    expect(feedUrl(O, "v1", { since: D, lifecycle: "ended" })).toBe(`${O}/lws/vault/v1/records?since=${D}&lifecycle=ended`);
    expect(feedUrl(O, "v1", { since: C, lifecycle: "ended", types: ["A", "B"], limit: 200 })).toBe(
      `${O}/lws/vault/v1/records?since=${C}&lifecycle=ended&type=A&type=B&limit=200`,
    );
    expect(feedUrl(O, "v1", { since: "start", limit: 1 })).toBe(`${O}/lws/vault/v1/records?since=start&limit=1`);
    for (const limit of [0, 201, -1, 1.5, NaN, Infinity]) expect(() => feedUrl(O, "v1", { since: "head", limit }), String(limit)).toThrow();
    expect(() => feedUrl(O, "v1", { since: "bad one" })).toThrow();
    expect(() => feedUrl(O, "v1", { since: "head", types: ["t:Person"] })).toThrow();
    expect(() => feedUrl(O, "v1", { since: "head", types: Array.from({ length: 21 }, (_, i) => `T${i}`) })).toThrow();
  });

  // Spec: Kit.Client, Transport: a credential can never reach a URL (check Security.NoTokenInUrl)
  test("F4 only the agreed query keys", () => {
    const urls = [
      liveUrl(O, "v1"),
      liveUrl(O, "v1", { since: C, types: ["A", "B"] }),
      feedUrl(O, "v1", { since: "head" }),
      feedUrl(O, "v1", { since: C, lifecycle: "ended", types: ["A"], limit: 50 }),
      feedUrl(O, "v1", { since: C, lifecycle: "live", types: ["A"], limit: 50 }),
    ];
    for (const u of urls) {
      const q = new URL(u).searchParams;
      for (const k of q.keys()) expect(["since", "type", "lifecycle", "limit"], u).toContain(k);
      for (const bad of ["token", "authorization", "dpop", "access_token"]) expect(u.toLowerCase().includes(bad), u).toBe(false);
      expect(new URL(u).hash).toBe("");
      expect(new URL(u).username).toBe("");
    }
  });

  // Spec: Kit.Client, Transport: the origin is only scheme and host (check Contract.Url)
  test("F5 normalizeOrigin", () => {
    expect(normalizeOrigin("https://a.example")).toBe("https://a.example");
    expect(normalizeOrigin("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(normalizeOrigin("https://a.example///")).toBe("https://a.example");
    for (const bad of ["https://a.example/base", "https://u:p@a.example", "ftp://a", "a.example", "https://a.example?x=1", "https://a.example#f", "", "https://", "https://a.example/a/"]) {
      expect(() => normalizeOrigin(bad), bad).toThrow("origin must be scheme://host[:port] with no path or credentials");
    }
  });

  // Spec: Kit.Client, Transport: cursors are opaque strings of a closed alphabet (check Contract.Cursor)
  test("isCursor", () => {
    expect(isCursor(C)).toBe(true);
    expect(isCursor("A".repeat(40))).toBe(true);
    expect(isCursor("A".repeat(4096))).toBe(true);
    expect(isCursor("A".repeat(39))).toBe(false);
    expect(isCursor("A".repeat(4097))).toBe(false);
    expect(isCursor("A".repeat(42) + "=")).toBe(false);
    expect(isCursor("A".repeat(42) + "+")).toBe(false);
    expect(isCursor("a_-".repeat(15))).toBe(true);
    expect(isCursor(null)).toBe(false);
    expect(isCursor(5)).toBe(false);
  });
});

describe("feed pages", () => {
  const row = { entity: "https://x/e/1", typeUri: "https://x/t/V", updatedAt: "2026-11-19T10:00:00Z" };

  // Spec: Kit.Client, Transport: read a feed page strictly (check Contract.Feed)
  test("F6 parseFeedPage", () => {
    const good = { records: [row, { ...row, entity: "https://x/e/2", updatedAt: null, secret: "no" }], nextCursor: C, complete: true, extra: 1 };
    const p = parseFeedPage(good);
    expect(p).toEqual({
      rows: [
        { entity: "https://x/e/1", typeUri: "https://x/t/V", updatedAt: "2026-11-19T10:00:00Z" },
        { entity: "https://x/e/2", typeUri: "https://x/t/V", updatedAt: null },
      ],
      nextCursor: C,
      complete: true,
    });
    expect(Object.keys(p as object).sort()).toEqual(["complete", "nextCursor", "rows"]);
    for (const r of p!.rows) expect(Object.keys(r).sort()).toEqual(["entity", "typeUri", "updatedAt"]);
    expect(parseFeedPage({ records: [], complete: false })).toEqual({ rows: [], nextCursor: null, complete: false });
    expect(parseFeedPage({ records: [], complete: false, nextCursor: null })?.nextCursor).toBeNull();
    // A row with no updatedAt key at all reads as null.
    expect(parseFeedPage({ records: [{ entity: "e", typeUri: "t" }], complete: true })?.rows[0]?.updatedAt).toBeNull();

    const nulls: unknown[] = [
      null,
      "x",
      5,
      [],
      {},
      { records: {}, complete: true },
      { records: [], nextCursor: C },
      { records: [], complete: "true" },
      { records: [], complete: 1 },
      { records: [{ entity: "e" }], complete: true },
      { records: [{ typeUri: "t" }], complete: true },
      { records: [{ entity: "", typeUri: "t" }], complete: true },
      { records: [{ entity: "e", typeUri: "" }], complete: true },
      { records: [{ entity: "e", typeUri: "t", updatedAt: 5 }], complete: true },
      { records: [null], complete: true },
      { records: [row, { entity: "e" }], complete: true },
      { records: [], complete: true, nextCursor: "short" },
      { records: [], complete: true, nextCursor: 12 },
      { records: [], complete: true, nextCursor: "A".repeat(42) + "=" },
    ];
    for (const n of nulls) expect(parseFeedPage(n), JSON.stringify(n)).toBeNull();
  });

  const page = (n: number, nextCursor: string | null): FeedPage => ({
    rows: Array.from({ length: n }, (_, i) => ({ entity: `https://x/e/${i}`, typeUri: "https://x/t/V", updatedAt: `2026-11-19T10:00:0${i}Z` })),
    nextCursor,
    complete: true,
  });
  const at = new Date("2026-11-19T12:00:00.000Z");

  // Spec: Kit.Client, Transport: only a live-feed cursor may reach the store (check Contract.CursorScope)
  test("F7 notificationsFromFeed", () => {
    const live = notificationsFromFeed(page(3, C), "change", at);
    expect(live.map((n) => n.cursor)).toEqual([null, null, C]);
    expect(live.map((n) => n.kind)).toEqual(["change", "change", "change"]);
    expect(live.map((n) => n.etag)).toEqual([null, null, null]);
    expect(live.map((n) => n.entity)).toEqual(["https://x/e/0", "https://x/e/1", "https://x/e/2"]);
    expect(live[1]).toEqual({
      kind: "change",
      entity: "https://x/e/1",
      typeUri: "https://x/t/V",
      etag: null,
      updatedAt: "2026-11-19T10:00:01Z",
      receivedAt: "2026-11-19T12:00:00.000Z",
      cursor: null,
    });

    // The ended feed has its own scope: its cursor must never reach the store, on any row.
    const ended = notificationsFromFeed(page(3, D), "ended", at);
    expect(ended.map((n) => n.cursor)).toEqual([null, null, null]);
    expect(ended.every((n) => n.kind === "ended")).toBe(true);
    expect(notificationsFromFeed(page(1, D), "ended", at)[0]?.cursor).toBeNull();
    expect(JSON.stringify(ended).includes(D)).toBe(false);

    expect(notificationsFromFeed(page(0, C), "change", at)).toEqual([]);
    expect(notificationsFromFeed(page(0, D), "ended", at)).toEqual([]);
    expect(notificationsFromFeed(page(3, null), "change", at).map((n) => n.cursor)).toEqual([null, null, null]);
    expect(notificationsFromFeed(page(1, C), "change", at)[0]?.cursor).toBe(C);
  });
});
