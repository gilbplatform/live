// Hand-written parser for the server-sent-events wire format, so the transport needs only `fetch` and `ReadableStream`.

/** One dispatched event. `id` is the last `id:` value set so far (it persists across events until changed), or null. */
export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

/** Thrown by `feed` when the event in progress grows past `maxEventBytes`. The parser is unusable afterwards. */
export class SseTooLargeError extends Error {
  constructor() {
    super("event too large");
    this.name = "SseTooLargeError";
  }
}

/** The callbacks the parser reports to. Only `onEvent` is required. */
export interface SseHandlers {
  /** A complete event with non-empty data. */
  onEvent(e: SseEvent): void;
  /** A comment line; `text` is what follows the colon (including a leading space, if any). */
  onComment?(text: string): void;
  /** A `retry:` value in milliseconds (digits only). */
  onRetry?(ms: number): void;
}

/** Parser settings. `maxEventBytes` defaults to 1_048_576. */
export interface SseParserOptions {
  maxEventBytes?: number;
}

/** The parser: `feed` takes the next bytes (or text) of the stream, `end` is called when the stream is over. */
export interface SseParser {
  /** Gives the next chunk; dispatches every event it completes. Throws `SseTooLargeError` past the size limit. */
  feed(chunk: Uint8Array | string): void;
  /** Marks the end of the stream. An incomplete event and a partial line are discarded, never dispatched. */
  end(): void;
}

const DEFAULT_MAX_EVENT_BYTES = 1_048_576;
const utf8 = new TextEncoder();

/**
 * Creates a parser following the standard event-stream rules. Chunk boundaries may fall anywhere.
 * Events go to `handlers.onEvent`, comments to `onComment`, `retry:` values to `onRetry`.
 */
export function createSseParser(handlers: SseHandlers, options?: SseParserOptions): SseParser {
  const max = options?.maxEventBytes !== undefined && options.maxEventBytes > 0 ? options.maxEventBytes : DEFAULT_MAX_EVENT_BYTES;
  // One decoder for the whole stream: a character split across two chunks must not become two replacement characters.
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let started = false;
  let dead = false;
  let lastId: string | null = null;
  let eventName = "";
  let dataLines: string[] = [];
  // Bytes of the lines already taken into the event in progress; the unfinished line is counted from `buf`.
  let eventBytes = 0;

  const resetEvent = (): void => {
    eventName = "";
    dataLines = [];
    eventBytes = 0;
  };

  const dispatch = (): void => {
    const hadData = dataLines.length > 0;
    const data = dataLines.join("\n");
    const name = eventName === "" ? "message" : eventName;
    resetEvent();
    // An event with no data (only `event:`, or an empty `data:`) says nothing and is dropped.
    if (!hadData || data === "") return;
    handlers.onEvent({ event: name, data, id: lastId });
  };

  const handleLine = (line: string): void => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) {
      handlers.onComment?.(line.slice(1));
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") {
      if (!value.includes("\u0000")) lastId = value;
    } else if (field === "retry") {
      if (/^[0-9]+$/.test(value)) handlers.onRetry?.(Number(value));
    }
  };

  const drain = (): void => {
    let pos = 0;
    for (;;) {
      let i = pos;
      while (i < buf.length && buf.charCodeAt(i) !== 10 && buf.charCodeAt(i) !== 13) i++;
      if (i >= buf.length) break;
      // A lone CR at the very end of the buffer waits: the next chunk may begin with the LF that belongs to it.
      if (buf.charCodeAt(i) === 13 && i === buf.length - 1) break;
      const line = buf.slice(pos, i);
      pos = i + (buf.charCodeAt(i) === 13 && buf.charCodeAt(i + 1) === 10 ? 2 : 1);
      eventBytes += utf8.encode(line).length + 1;
      if (eventBytes > max) {
        dead = true;
        throw new SseTooLargeError();
      }
      handleLine(line);
    }
    buf = buf.slice(pos);
  };

  return {
    feed(chunk) {
      if (dead) throw new SseTooLargeError();
      let text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      // The standard allows one byte-order mark at the start of the stream. The byte decoder already drops it, so only
      // text input needs this.
      if (!started && text.length > 0) {
        started = true;
        if (typeof chunk === "string" && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      buf += text;
      drain();
      // A bad proxy must not grow memory without bound: an endless line with no line end is also caught here.
      if (eventBytes + buf.length > max) {
        dead = true;
        throw new SseTooLargeError();
      }
    },
    end() {
      // A cut connection must never apply half a notification, so whatever is incomplete is thrown away.
      buf = "";
      resetEvent();
    },
  };
}
