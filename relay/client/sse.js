// @ts-check
// sse: server-sent events over any fetch that returns our Response-like object, with resume
// (ADR 0029, R1). The cursor is the last event id applied; every reopen sends it as Last-Event-ID,
// and an event at or below it is dropped, so a reconnect or a path switch replays nothing twice.
// 45 s without a byte (three missed 15 s heartbeats) is a dead stream: it is dropped and reopened.

import { fromUtf8 } from "./bytes.js";

/** Splits a byte stream into SSE events. `retry` hears the server's reconnect hint. */
export class SSEParser {
  /** @param {(e: { id: string|null, event: string, data: string }) => void} onevent @param {(ms: number) => void} [onretry] */
  constructor(onevent, onretry = () => {}) {
    this.onevent = onevent;
    this.onretry = onretry;
    this.buf = "";
    this.dec = new TextDecoder();
    this.reset();
  }
  reset() { this.data = /** @type {string[]} */ ([]); this.event = ""; this.id = /** @type {string|null} */ (null); }
  /** @param {Uint8Array} chunk */
  push(chunk) {
    this.buf += this.dec.decode(chunk, { stream: true });
    let at;
    while ((at = this.buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.buf.slice(0, at);
      const nl = this.buf[at] === "\r" && this.buf[at + 1] === "\n" ? 2 : 1;
      // A lone \r at the very end may be half of \r\n: wait for the next chunk.
      if (this.buf[at] === "\r" && at + 1 === this.buf.length) break;
      this.buf = this.buf.slice(at + nl);
      this.line(line);
    }
  }
  /** @param {string} line */
  line(line) {
    if (line === "") {
      if (this.data.length) this.onevent({ id: this.id, event: this.event || "message", data: this.data.join("\n") });
      this.reset();
      return;
    }
    if (line.startsWith(":")) return;
    const c = line.indexOf(":");
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? "" : line.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
    else if (field === "retry" && /^\d+$/.test(value)) this.onretry(Number(value));
  }
}

const later = (ms, signal) => new Promise(resolve => {
  const t = globalThis.setTimeout(resolve, ms);
  signal?.addEventListener?.("abort", () => { globalThis.clearTimeout(t); resolve(undefined); }, { once: true });
});

/** Is `id` at or below `last`? Only comparable when both are numbers, as vyred's ids are. */
const seen = (id, last) => last != null && id != null && /^\d+$/.test(id) && /^\d+$/.test(String(last)) && Number(id) <= Number(last);

/**
 * Follow an event stream until closed.
 * @param {(path: string, init: any) => Promise<any>} fetcher
 * @param {string} path
 * @param {{ lastEventId?: string|number|null, onEvent: (e: { id: string|null, event: string, data: string }) => void,
 *   onOpen?: () => void, onError?: (e: any) => void, stallMs?: number, headers?: Record<string, string>,
 *   backoff?: { min?: number, max?: number }, random?: () => number }} o
 */
export function followEvents(fetcher, path, o) {
  let last = o.lastEventId == null ? null : String(o.lastEventId);
  const stallMs = o.stallMs ?? 45_000;
  const min = o.backoff?.min ?? 1000, max = o.backoff?.max ?? 60_000;
  const random = o.random || Math.random;
  let closed = false;
  let retryMs = 2000;
  let now = false;
  const stop = new AbortController();
  /** @type {AbortController|null} */
  let current = null;

  (async () => {
    let backoff = min;
    while (!closed) {
      const ac = new AbortController();
      current = ac;
      const headers = { ...(o.headers || {}), accept: "text/event-stream" };
      if (last != null) headers["last-event-id"] = last;
      let good = false, started = Date.now();
      /** @type {any} */
      let stall = null;
      const arm = () => { globalThis.clearTimeout(stall); stall = globalThis.setTimeout(() => ac.abort(), stallMs); };
      try {
        const res = await fetcher(path, { headers, signal: ac.signal });
        if (res.status !== 200) {
          o.onError?.(Object.assign(new Error(`event stream answered ${res.status}`), { status: res.status }));
          try { await res.cancel?.(); } catch {}
        } else {
          good = true;
          started = Date.now();
          o.onOpen?.();
          const parser = new SSEParser(e => {
            if (e.id != null && seen(e.id, last)) return;
            if (e.id != null) last = e.id;
            if (!closed) o.onEvent(e);
          }, ms => { retryMs = ms; });
          arm();
          for await (const chunk of res.body) {
            if (closed) break;
            arm();
            parser.push(chunk);
          }
        }
      } catch (e) {
        if (!closed && !ac.signal.aborted) o.onError?.(e);
      } finally { globalThis.clearTimeout(stall); }
      if (closed) break;
      if (good) backoff = min;
      // A stream that ran a while reopens at the server's retry hint; a failure backs off.
      let wait = good && Date.now() - started >= retryMs ? 0 : good ? retryMs : backoff * (0.8 + 0.4 * random());
      if (!good) backoff = Math.min(backoff * 2, max);
      if (now) { now = false; wait = 0; }
      if (wait) await later(wait, stop.signal);
    }
  })();

  return {
    get lastEventId() { return last; },
    /** Drop the current stream and reopen now (a path switch, a wake). */
    reopen() { now = true; current?.abort(); },
    close() { closed = true; stop.abort(); current?.abort(); },
  };
}
