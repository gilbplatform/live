import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { createLiveClient } from "../src/client.js";
import type { LiveClient } from "../src/client.js";
import { createKitLiveSource } from "../src/live-source.js";
import type { LiveChange } from "../src/types.js";
import { FrameServer, StreamScript, cursor, feedPage, frameData } from "./helpers/frameServer.js";
import type { SeenRequest } from "./helpers/frameServer.js";

// The client with NO createTransport given: it must build the kit's own transport and run against a real (local) server.
// Real timers, real sockets on 127.0.0.1. The transport's default back-off is used as it is (about 0.5 to 1 s), so the
// cut test waits for it.

const SECRET = "SECRET-TOKEN-123";
const HEAD = cursor("H1");
const T0 = Date.UTC(2026, 10, 19, 10, 0, 0);
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const ent = (name: string): string => `https://vault.example/e/${name}`;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(predicate: () => boolean, ms = 3000, what = "the condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await wait(10);
  }
}

interface Rec { entity: string }

let server: FrameServer;
const clients: Array<{ stop(): Promise<void> | void }> = [];

beforeEach(async () => {
  server = new FrameServer();
  await server.start();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()));
  await server.close();
});

/** Answers the head request with HEAD, any other feed request with an empty page, and the stream requests with `streams` in turn. */
function serve(streams: StreamScript[]): void {
  let next = 0;
  server.handler = (r: SeenRequest) => {
    if (r.kind === "stream") return streams[Math.min(next++, streams.length - 1)] as StreamScript;
    if (r.kind === "head-live") return { status: 200, json: feedPage([], HEAD, true) };
    return { status: 200, json: feedPage([], r.query.get("since"), true) };
  };
}

function build(over: { fetch?: typeof fetch } = {}): { client: LiveClient<Rec>; changes: Array<LiveChange<Rec>> } {
  const changes: Array<LiveChange<Rec>> = [];
  const client = createLiveClient<Rec>({
    origin: server.origin,
    vaultId: "vault-1",
    types: ["Value"],
    auth: () => ({ authorization: `Bearer ${SECRET}` }),
    read: async (n) => ({ record: { entity: n.entity }, etag: `e-${n.entity}` }),
    resync: async () => [],
    keyOf: (r) => r.entity,
    holdMs: 0,
    coalesceMs: 0,
    ...over,
  });
  clients.push(client);
  client.subscribe((c) => changes.push(c));
  return { client, changes };
}

describe("the client with the kit's own transport", () => {
  // Spec: Kit.Client, DefaultTransport: with no createTransport the client builds the kit's transport, starts at the head cursor, and a streamed change reaches onChange (LiveWire step, check CD1)
  test("CD1 a streamed change reaches the app's change listener", async () => {
    const s = new StreamScript().frame({ id: cursor("S1"), data: frameData(ent("A"), at(1)) });
    serve([s]);
    const { client, changes } = build();
    await client.start();
    await until(() => client.records().length === 1, 3000, "the streamed record");
    expect(client.records()).toEqual([{ entity: ent("A") }]);
    expect(changes.some((c) => c.records.some((r) => r.entity === ent("A")))).toBe(true);
    // The head came first, then the stream, which started at the head cursor and sent no resume header.
    expect(server.of("head-live")).toHaveLength(1);
    const first = server.of("stream")[0] as SeenRequest;
    expect(first.query.get("since")).toBe(HEAD);
    expect(first.headers["last-event-id"]).toBeUndefined();
    expect(first.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(first.url).not.toContain(SECRET);
    expect(server.violations).toEqual([]);
  });

  // Spec: Kit.Client, DefaultTransport: after a cut the default transport asks again from the cursor of the last frame it pushed (check CD2)
  test("CD2 a cut resumes from the last cursor", { timeout: 10000 }, async () => {
    const first = new StreamScript().frame({ id: cursor("S1"), data: frameData(ent("A"), at(1)) }).cut();
    const second = new StreamScript().frame({ id: cursor("S2"), data: frameData(ent("B"), at(2)) });
    serve([first, second]);
    const { client } = build();
    await client.start();
    await until(() => server.of("stream").length >= 2, 6000, "the second stream request");
    const again = server.of("stream")[1] as SeenRequest;
    expect(again.query.get("since")).toBe(cursor("S1"));
    expect(again.headers["last-event-id"]).toBeUndefined();
    await until(() => client.records().length === 2, 3000, "both records");
    expect(client.records().map((r) => r.entity).sort()).toEqual([ent("A"), ent("B")]);
  });

  // Spec: Kit.Client, DefaultTransport: the default transport's onConfirm feeds the client's clock, so a heartbeat moves the confirmed time (check CD3)
  test("CD3 a heartbeat confirms", async () => {
    const s = new StreamScript();
    serve([s]);
    const { client } = build();
    await client.start();
    await until(() => server.of("stream").length === 1, 3000, "the stream request");
    // The first list the client shows already confirms once, so the start is a number to beat, not null.
    await wait(30);
    const t0 = client.lastConfirmedAt() ?? 0;
    s.heartbeat();
    await until(() => (client.lastConfirmedAt() ?? 0) > t0, 3000, "the first confirmation");
    const t1 = client.lastConfirmedAt() as number;
    await wait(30);
    s.heartbeat();
    await until(() => (client.lastConfirmedAt() ?? 0) > t1, 3000, "a later confirmation");
  });

  // Spec: Kit.Client, DefaultTransport: the injected fetch is the one used, for the head and for the stream (check CD4)
  test("CD4 the injected fetch is used", async () => {
    const urls: string[] = [];
    const counting = ((input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      return globalThis.fetch(input, init);
    }) as typeof fetch;
    serve([new StreamScript().heartbeat()]);
    const { client } = build({ fetch: counting });
    await client.start();
    await until(() => server.of("stream").length === 1, 3000, "the stream request");
    expect(urls.length).toBe(server.requests.length);
    expect(urls.some((u) => /since=head/.test(u))).toBe(true);
    expect(urls.some((u) => /\/live/.test(u))).toBe(true);
    for (const u of urls) expect(u).not.toContain(SECRET);
  });

  // Spec: Kit.Client, DefaultTransport: the kit-source form works the same, with no createTransport (check CD5)
  test("CD5 createKitLiveSource with no createTransport delivers a streamed change", async () => {
    serve([new StreamScript().frame({ id: cursor("S1"), data: frameData(ent("A"), at(1)) })]);
    const got: Array<LiveChange<Rec>> = [];
    const source = createKitLiveSource<Rec>({
      originOf: () => server.origin,
      auth: () => ({ authorization: `Bearer ${SECRET}` }),
      read: async (n) => ({ record: { entity: n.entity }, etag: "e1" }),
      resync: async () => [],
      holdMs: 0,
      coalesceMs: 0,
    });
    const handle = source.subscribe("vault-1", ["Value"], { onChange: (c) => got.push(c) });
    clients.push({ stop: () => handle.stop() });
    await until(() => got.some((c) => c.records.some((r) => r.entity === ent("A"))), 3000, "the change");
    expect(server.of("stream")[0]?.query.get("since")).toBe(HEAD);
  });

  // Spec: Kit.Client, DefaultTransport: client.ts reaches the kit's transport by a plain import and the network only through the injected or global fetch (check CD6)
  test("CD6 transport scan of client.ts", () => {
    const body = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
    expect(body).toMatch(/import \{ createLiveTransport \} from "\.\/transport\.js";/);
    expect([...body.matchAll(/globalThis\.fetch/g)]).toHaveLength(1);
    expect(body).toContain("options.fetch ?? globalThis.fetch");
    for (const banned of ["EventSource", "require(", 'from "node:', "process.", "Buffer", "localStorage", "document"]) {
      expect(body.includes(banned), banned).toBe(false);
    }
  });
});
