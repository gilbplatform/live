import { describe, expect, test } from "vitest";
import { parseLiveNotification } from "../src/index.js";

const CURSOR = "c".repeat(43);
const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "change",
  entity: "https://vault.example/e/A",
  typeUri: "https://vault.example/t/Value",
  etag: "e1",
  updatedAt: "2026-11-19T10:00:00.000Z",
  receivedAt: "2026-11-19T10:00:00.050Z",
  ...over,
});

describe("parseLiveNotification", () => {
  // Spec: Kit.Client, Notification: valid change and ended parse to the seven fields (LiveWire step, check Delivery.Shape)
  test("N1 valid change and ended objects parse to exactly the seven fields", () => {
    const change = parseLiveNotification(good(), CURSOR);
    expect(change).toEqual({ ...good(), cursor: CURSOR });
    const ended = parseLiveNotification(good({ kind: "ended", etag: null }), null);
    expect(ended).toEqual({ ...good({ kind: "ended", etag: null }), cursor: null });
    expect(Object.keys(change ?? {}).sort()).toHaveLength(7);
  });

  // Spec: Kit.Client, Notification: nothing the server did not mean to send is carried (check Delivery.NoLeak)
  test("N2 extra keys are dropped and never copied", () => {
    const input = good({
      body: "SECRET-BODY",
      "a:name": "SECRET-NAME",
      facts: { x: "SECRET-FACT" },
      secret: "SECRET-TOKEN",
      nested: { deep: { more: "SECRET-DEEP" } },
    });
    const result = parseLiveNotification(input, CURSOR);
    expect(result).not.toBeNull();
    expect(Object.keys(result ?? {}).sort()).toEqual(["cursor", "entity", "etag", "kind", "receivedAt", "typeUri", "updatedAt"]);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });

  // Spec: Kit.Client, Notification: every bad shape is refused, never thrown (check Delivery.Shape)
  test("N3 every bad shape returns null and never throws", () => {
    const bad: Array<[string, unknown, string | null]> = [
      ["string", "text", CURSOR],
      ["number", 7, CURSOR],
      ["undefined", undefined, CURSOR],
      ["null", null, CURSOR],
      ["array", [good()], CURSOR],
      ["bad kind", good({ kind: "deleted" }), CURSOR],
      ["missing kind", (() => { const g = good(); delete g.kind; return g; })(), CURSOR],
      ["empty entity", good({ entity: "" }), CURSOR],
      ["2049 entity", good({ entity: "x".repeat(2049) }), CURSOR],
      ["numeric entity", good({ entity: 5 }), CURSOR],
      ["empty typeUri", good({ typeUri: "" }), CURSOR],
      ["2049 typeUri", good({ typeUri: "t".repeat(2049) }), CURSOR],
      ["numeric etag", good({ etag: 5 }), CURSOR],
      ["object etag", good({ etag: {} }), CURSOR],
      ["numeric updatedAt", good({ updatedAt: 5 }), CURSOR],
      ["missing receivedAt", (() => { const g = good(); delete g.receivedAt; return g; })(), CURSOR],
      ["numeric receivedAt", good({ receivedAt: 5 }), CURSOR],
      ["cursor newline", good(), "c".repeat(42) + "\n"],
      ["cursor space", good(), "c".repeat(42) + " "],
      ["cursor colon", good(), "c".repeat(42) + ":"],
      ["cursor 39", good(), "c".repeat(39)],
      ["cursor 4097", good(), "c".repeat(4097)],
      ["cursor empty", good(), ""],
      ["cursor number", good(), 5 as unknown as string],
    ];
    for (const [label, data, cursor] of bad) {
      let result: unknown = "not-run";
      expect(() => { result = parseLiveNotification(data, cursor); }, label).not.toThrow();
      expect(result, label).toBeNull();
    }
    // The longest allowed values still pass.
    expect(parseLiveNotification(good({ entity: "x".repeat(2048) }), "c".repeat(4096))).not.toBeNull();
    expect(parseLiveNotification(good(), "c".repeat(40))).not.toBeNull();
  });

  // Spec: Kit.Client, Notification: a missing etag or updatedAt is null (check Delivery.Shape)
  test("N4 missing etag and updatedAt become null", () => {
    const g = good();
    delete g.etag;
    delete g.updatedAt;
    const result = parseLiveNotification(g, null);
    expect(result?.etag).toBeNull();
    expect(result?.updatedAt).toBeNull();
    expect(result?.cursor).toBeNull();
  });
});
