// A small scripted HTTP server on 127.0.0.1 for the transport tests. It records every request, answers each one with
// what the test says, and watches for the one thing the transport must never do: use two sources at once.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** How long the server waits for an earlier connection's close to show before it calls two open sources a violation, in ms. */
const SETTLE_MS = 20;

export type RequestKind = "stream" | "feed-live" | "feed-ended" | "head-live" | "head-ended";

/** One request the server saw. `openedAt` and `closedAt` are values of one shared counter, so they can be compared. */
export interface SeenRequest {
  n: number;
  kind: RequestKind;
  url: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  aborted: boolean;
  openedAt: number;
  closedAt: number | null;
  /** wall-clock time (Date.now) when the request arrived */
  at: number;
  /** streams plus feed requests in flight, counted when this request began (this one included) */
  concurrent: number;
}

/** A plain answer: a status, optional headers, and a JSON body. */
export interface PlainAnswer {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  /** A raw text body instead of JSON (with a `content-type` in `headers`). */
  body?: string;
}

/** The server's cursor-shaped string: 43 characters containing the tag. */
export const cursor = (tag: string): string => tag.padStart(43, "c");

/** The six-field JSON of one change event. */
export function frameData(entity: string, updatedAt: string | null, kind: "change" | "ended" = "change", etag: string | null = null): Record<string, unknown> {
  return { kind, entity, typeUri: "https://vault.example/t/Value", etag, updatedAt, receivedAt: new Date(0).toISOString() };
}

/** The JSON of one feed page. */
export function feedPage(
  rows: Array<{ entity: string; updatedAt: string | null; typeUri?: string }>,
  nextCursor: string | null,
  complete: boolean,
): Record<string, unknown> {
  return {
    records: rows.map((r) => ({ entity: r.entity, typeUri: r.typeUri ?? "https://vault.example/t/Value", updatedAt: r.updatedAt })),
    nextCursor,
    complete,
  };
}

/** The answer of one stream request. The test calls its methods, now or later; what is written before the request is attached waits. */
export class StreamScript {
  private res: ServerResponse | null = null;
  private pending: Array<(r: ServerResponse) => void> = [];
  private abortCbs: Array<() => void> = [];
  private ended = false;
  /** True once the connection is closed by either side. */
  closed = false;

  /** @internal called by the server */
  attach(res: ServerResponse): void {
    this.res = res;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
    res.flushHeaders();
    res.on("close", () => {
      this.closed = true;
      for (const cb of this.abortCbs) cb();
    });
    for (const p of this.pending.splice(0)) p(res);
  }

  private act(fn: (r: ServerResponse) => void): this {
    if (this.res) fn(this.res);
    else this.pending.push(fn);
    return this;
  }

  private write(text: string): this {
    return this.act((r) => {
      if (!this.ended && !r.destroyed) r.write(text);
    });
  }

  /** One change or ended frame. `data` that is not a string is written as JSON. */
  frame(f: { id?: string; event?: string; data: unknown }): this {
    const data = typeof f.data === "string" ? f.data : JSON.stringify(f.data);
    return this.write(`${f.id !== undefined ? `id: ${f.id}\n` : ""}event: ${f.event ?? "change"}\ndata: ${data}\n\n`);
  }

  heartbeat(): this {
    return this.write(": heartbeat\n\n");
  }

  retry(ms: number): this {
    return this.write(`retry: ${ms}\n\n`);
  }

  closedFrame(reason: string): this {
    return this.write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
  }

  /** Writes text exactly as given (for half frames). */
  raw(text: string): this {
    return this.write(text);
  }

  /** Destroys the socket once what was written before has left (a cut that loses earlier frames would test nothing). */
  cut(): this {
    return this.act((r) => {
      this.ended = true;
      r.write("", () => r.destroy());
    });
  }

  /** Ends the response normally. */
  end(): this {
    return this.act((r) => {
      this.ended = true;
      if (!r.destroyed) r.end();
    });
  }

  /** Sends nothing at all after the headers. */
  silent(): this {
    return this;
  }

  /** Calls `cb` when the connection closes (the client went away, or the server ended it). */
  onAbort(cb: () => void): this {
    this.abortCbs.push(cb);
    return this;
  }
}

export type Answer = PlainAnswer | StreamScript;

/** The scripted server. Set `handler` to decide each answer. */
export class FrameServer {
  private server: Server | null = null;
  private clock = 0;
  private openStreams = 0;
  private feedInFlight = 0;
  private sockets = new Set<Socket>();
  readonly requests: SeenRequest[] = [];
  /** Recorded when a feed request starts while a stream is open, or a stream request starts while a feed request is in flight. */
  readonly violations: string[] = [];
  /** The most requests in flight together, over the whole run. */
  maxConcurrent = 0;
  origin = "";
  handler: (req: SeenRequest, all: readonly SeenRequest[]) => Answer | Promise<Answer> = () => ({ status: 500, json: { error: "unscripted" } });

  async start(): Promise<string> {
    this.server = createServer((req, res) => { void this.onRequest(req, res); });
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.origin;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /** The requests of one kind, in order. */
  of(...kinds: RequestKind[]): SeenRequest[] {
    return this.requests.filter((r) => kinds.includes(r.kind));
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const isStream = /\/live$/.test(url.pathname);
    const q = url.searchParams;
    const head = q.get("since") === "head";
    const ended = q.get("lifecycle") === "ended";
    const kind: RequestKind = isStream ? "stream" : head ? (ended ? "head-ended" : "head-live") : ended ? "feed-ended" : "feed-live";
    const seen: SeenRequest = { n: this.requests.length, kind, url: req.url ?? "", query: q, headers: req.headers, aborted: false, openedAt: -1, closedAt: null, at: Date.now(), concurrent: 0 };
    this.requests.push(seen);
    // The client lets go of a connection a moment before this server's own "close" event for it fires, because both
    // sit in the same event loop. So a conflict is judged only if it is still there after SETTLE_MS: a transport that
    // really keeps two sources open keeps them open for far longer than that.
    const conflicting = (): boolean => (isStream ? this.feedInFlight > 0 : this.openStreams > 0);
    for (let waited = 0; conflicting() && waited < SETTLE_MS; waited += 2) await new Promise<void>((r) => setTimeout(r, 2));
    if (conflicting()) {
      this.violations.push(
        isStream ? `stream request ${seen.n} started while ${this.feedInFlight} feed request(s) in flight` : `feed request ${seen.n} started while ${this.openStreams} stream(s) open`,
      );
    }
    seen.openedAt = this.clock++;
    if (isStream) this.openStreams++;
    else this.feedInFlight++;
    seen.concurrent = this.openStreams + this.feedInFlight;
    this.maxConcurrent = Math.max(this.maxConcurrent, seen.concurrent);
    res.on("close", () => {
      if (seen.closedAt !== null) return;
      seen.closedAt = this.clock++;
      seen.aborted = !res.writableFinished;
      if (isStream) this.openStreams--;
      else this.feedInFlight--;
    });
    let answer: Answer;
    try {
      answer = await this.handler(seen, this.requests);
    } catch {
      answer = { status: 500, json: { error: "handler_threw" } };
    }
    if (answer instanceof StreamScript) {
      answer.attach(res);
      return;
    }
    const headers: Record<string, string> = { ...(answer.json !== undefined ? { "content-type": "application/json" } : {}), ...answer.headers };
    res.writeHead(answer.status, headers);
    res.end(answer.body ?? (answer.json !== undefined ? JSON.stringify(answer.json) : ""));
  }
}
