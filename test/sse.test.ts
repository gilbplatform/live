import { describe, expect, test } from "vitest";
import { createSseParser, SseTooLargeError, type SseEvent } from "../src/sse.js";

interface Run {
  events: SseEvent[];
  comments: string[];
  retries: number[];
}

/** Feeds the given chunks to a fresh parser and collects everything it reports. */
function run(chunks: Array<Uint8Array | string>, opts?: { maxEventBytes?: number }, end = true): Run {
  const out: Run = { events: [], comments: [], retries: [] };
  const p = createSseParser(
    { onEvent: (e) => out.events.push(e), onComment: (t) => out.comments.push(t), onRetry: (m) => out.retries.push(m) },
    opts,
  );
  for (const c of chunks) p.feed(c);
  if (end) p.end();
  return out;
}

const enc = new TextEncoder();
const bytes = (s: string): Uint8Array => enc.encode(s);

const CURSOR = "A".repeat(43);
const CURSOR2 = "B".repeat(43);
const DATA = JSON.stringify({
  entity: "https://x.example/e/1",
  typeUri: "https://x.example/t/Value",
  etag: "e1",
  updatedAt: "2026-11-19T10:00:00Z",
  receivedAt: "2026-11-19T10:00:01Z",
  cursor: null,
});
const REAL =
  "retry: 3000\n\n" +
  ": heartbeat\n\n" +
  `id: ${CURSOR}\nevent: change\ndata: ${DATA}\n\n` +
  `id: ${CURSOR2}\nevent: ended\ndata: ${DATA}\n\n` +
  'event: closed\ndata: {"reason":"max_age"}\n\n';

function expectedReal(): Run {
  return {
    retries: [3000],
    comments: [" heartbeat"],
    events: [
      { event: "change", data: DATA, id: CURSOR },
      { event: "ended", data: DATA, id: CURSOR2 },
      { event: "closed", data: '{"reason":"max_age"}', id: CURSOR2 },
    ],
  };
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("sse parser", () => {
  // Spec: Kit.Client, Transport: parse the event stream by hand (LiveWire step, check 4 Latency.LiveChange)
  test("P1 the server's real frames", () => {
    expect(run([REAL])).toEqual(expectedReal());
  });

  // Spec: Kit.Client, Transport: parse in any chunking (check 4 Latency.LiveChange)
  test("P2 chunking independence", () => {
    const all = bytes(REAL);
    expect(run([all])).toEqual(expectedReal());
    expect(run(Array.from(all, (b) => new Uint8Array([b])))).toEqual(expectedReal());
    for (let i = 0; i <= all.length; i++) {
      expect(run([all.slice(0, i), all.slice(i)]), `split at ${i}`).toEqual(expectedReal());
    }
    const rnd = mulberry32(20261119);
    for (let n = 0; n < 200; n++) {
      const cuts = new Set<number>();
      const k = 1 + Math.floor(rnd() * 12);
      for (let j = 0; j < k; j++) cuts.add(Math.floor(rnd() * all.length));
      const sorted = [...cuts].sort((a, b) => a - b);
      const chunks: Uint8Array[] = [];
      let prev = 0;
      for (const c of sorted) {
        chunks.push(all.slice(prev, c));
        prev = c;
      }
      chunks.push(all.slice(prev));
      expect(run(chunks), `random split ${n}`).toEqual(expectedReal());
    }
  });

  // Spec: Kit.Client, Transport: a character split across chunks arrives whole (check 4)
  test("P3 multi-byte characters split across chunks", () => {
    const entity = "https://x.example/café/\u{1F600}/end";
    const raw = bytes(`event: change\ndata: ${entity}\n\n`);
    for (let i = 0; i <= raw.length; i++) {
      const r = run([raw.slice(0, i), raw.slice(i)]);
      expect(r.events, `split at ${i}`).toEqual([{ event: "change", data: entity, id: null }]);
    }
    // One byte per chunk: the 4-byte emoji is cut at every inner position.
    const r = run(Array.from(raw, (b) => new Uint8Array([b])));
    expect(r.events[0]?.data).toBe(entity);
    expect(r.events[0]?.data.includes("�")).toBe(false);
  });

  // Spec: Kit.Client, Transport: all three line ends (check 4)
  test("P4 line ends", () => {
    const want = [{ event: "change", data: "x", id: null }];
    expect(run(["event: change\r\ndata: x\r\n\r\n"]).events).toEqual(want);
    expect(run(["event: change\ndata: x\n\n"]).events).toEqual(want);
    // A final CR waits for a possible LF, so the closing blank line needs one more byte to follow.
    expect(run(["event: change\rdata: x\r\r"]).events).toEqual([]);
    expect(run(["event: change\rdata: x\r\r", ": c\n"]).events).toEqual(want);
    // CR at the end of a chunk, LF at the start of the next: one line end, not two (a second would be a blank line).
    expect(run(["event: change\r", "\ndata: x\r", "\n\r", "\n"]).events).toEqual(want);
    expect(run(["event: change\r\n", "data: x\r", "\n", "\r\n"]).events).toEqual(want);
    // If a trailing CR were a complete line end and the LF another, the pair would read as a blank line and split the event.
    const r = run(["data: a\r", "\ndata: b\r\n\r\n"]);
    expect(r.events).toEqual([{ event: "message", data: "a\nb", id: null }]);
    // Same with a CR-terminated comment followed by LF: the LF must not count as a blank line dispatch of a pending event.
    const c = run(["data: z\r\n: note\r", "\ndata: y\n\n"]);
    expect(c.events).toEqual([{ event: "message", data: "z\ny", id: null }]);
    expect(c.comments).toEqual([" note"]);
    // No blank line yet: nothing is dispatched.
    expect(run(["data: a\r"], undefined, false).events).toEqual([]);
  });

  // Spec: Kit.Client, Transport: field syntax (check 4)
  test("P5 field syntax", () => {
    expect(run(["data:x\n\n"]).events[0]?.data).toBe("x");
    expect(run(["data: x\n\n"]).events[0]?.data).toBe("x");
    expect(run(["data:  x\n\n"]).events[0]?.data).toBe(" x");
    expect(run(["data\n\n"]).events).toEqual([]);
    expect(run(["data\ndata\n\n"]).events).toEqual([{ event: "message", data: "\n", id: null }]);
    expect(run(["data: a\ndata: b\ndata: c\n\n"]).events[0]?.data).toBe("a\nb\nc");
    expect(run(["foo: bar\nbogus\ndata: x\n\n"]).events).toEqual([{ event: "message", data: "x", id: null }]);
    expect(run(["event:change\ndata: x\n\n"]).events[0]?.event).toBe("change");
    expect(run(["event:  change\ndata: x\n\n"]).events[0]?.event).toBe(" change");
    expect(run(["data: x-b\n\n"]).events[0]?.data).toBe("x-b");
    // A data line with an empty value still adds a line to a multi-line value.
    expect(run(["data: a\ndata\ndata: b\n\n"]).events[0]?.data).toBe("a\n\nb");
  });

  // Spec: Kit.Client, Transport: the last event id persists (check 4)
  test("P6 id persists, NUL ignored", () => {
    const r = run(["id: one\ndata: a\n\n", "data: b\n\n", "id: two\ndata: c\n\n"]);
    expect(r.events.map((e) => e.id)).toEqual(["one", "one", "two"]);
    const n = run(["id: one\ndata: a\n\n", "id: bad\u0000id\ndata: b\n\n"]);
    expect(n.events.map((e) => e.id)).toEqual(["one", "one"]);
    const first = run(["id: x\u0000\ndata: b\n\n"]);
    expect(first.events[0]?.id).toBeNull();
  });

  // Spec: Kit.Client, Transport: a leading BOM is stripped (check 4)
  test("P7 BOM", () => {
    expect(run([new Uint8Array([0xef, 0xbb, 0xbf, ...bytes("data: x\n\n")])]).events).toEqual([{ event: "message", data: "x", id: null }]);
    // BOM split across chunks.
    expect(run([new Uint8Array([0xef]), new Uint8Array([0xbb, 0xbf, ...bytes("data: x\n\n")])]).events).toHaveLength(1);
    expect(run(["﻿data: x\n\n"]).events[0]?.data).toBe("x");
    // Only one BOM at the start of the stream is stripped: a second makes the field name unknown.
    expect(run(["﻿﻿data: x\n\n"]).events).toEqual([]);
  });

  // Spec: Kit.Client, Transport: an event without data is not dispatched (check 4)
  test("P8 no data, no event", () => {
    expect(run(["event: change\n\n"]).events).toEqual([]);
    expect(run(["event: change\ndata:\n\n"]).events).toEqual([]);
    expect(run(["event: change\ndata\n\n"]).events).toEqual([]);
    expect(run(["id: x\n\n"]).events).toEqual([]);
    // The event name must not leak into the next event.
    expect(run(["event: change\n\ndata: y\n\n"]).events).toEqual([{ event: "message", data: "y", id: null }]);
  });

  // Spec: Kit.Client, Transport: retry is digits only (check 4)
  test("P9 retry", () => {
    expect(run(["retry: 3000\n\n"]).retries).toEqual([3000]);
    expect(run(["retry:0\n\n"]).retries).toEqual([0]);
    expect(run(["retry: 12x\nretry: -5\nretry: 1.5\nretry:\nretry: ٣\n\n"]).retries).toEqual([]);
  });

  // Spec: Kit.Client, Transport: a cut never applies half a notification (check 4)
  test("P10 end drops incomplete input", () => {
    expect(run(["event: change\ndata: x\n"]).events).toEqual([]);
    expect(run(["event: change\ndata: x"]).events).toEqual([]);
    const r = run(["data: a\n\ndata: b\ndata: part"]);
    expect(r.events).toEqual([{ event: "message", data: "a", id: null }]);
  });

  // Spec: Kit.Client, Transport: a bad proxy cannot grow memory without bound (check 4)
  test("P11 size guard", () => {
    const p = createSseParser({ onEvent: () => undefined }, { maxEventBytes: 100 });
    expect(() => p.feed("data: " + "a".repeat(50) + "\n")).not.toThrow();
    expect(() => p.feed("data: " + "a".repeat(80) + "\n")).toThrow(SseTooLargeError);
    // Dead afterwards, even for good input.
    expect(() => p.feed("data: ok\n\n")).toThrow();
    // One endless line with no line end is also bounded.
    const q = createSseParser({ onEvent: () => undefined }, { maxEventBytes: 100 });
    expect(() => q.feed("a".repeat(200))).toThrow(SseTooLargeError);
    // The default limit is one megabyte.
    const big = createSseParser({ onEvent: () => undefined });
    expect(() => big.feed("data: " + "a".repeat(1_048_576 + 10))).toThrow(SseTooLargeError);
    // The counter restarts after a dispatch: many small events never trip the guard.
    const seen: SseEvent[] = [];
    const ok = createSseParser({ onEvent: (e) => seen.push(e) }, { maxEventBytes: 100 });
    for (let i = 0; i < 50; i++) ok.feed("data: " + "b".repeat(60) + "\n\n");
    expect(seen).toHaveLength(50);
  });

  // Spec: Kit.Client, Transport: comments are reported, never events (check 4)
  test("P12 comments", () => {
    const r = run([": hello\n\n", ":\n", ":no space\n"]);
    expect(r.comments).toEqual([" hello", "", "no space"]);
    expect(r.events).toEqual([]);
  });
});
