// @ts-check
// response: the Response-like object every path returns, whatever carried it. `status`, `ok`,
// `headers.get()`, `text()`, `json()`, `arrayBuffer()`, and `body`, an async iterator of
// Uint8Array chunks (for SSE and large downloads). The body can be read once.

import { concat, fromUtf8 } from "./bytes.js";

/** A one-reader queue of chunks with an end and an error. */
export class Pipe {
  constructor() {
    /** @type {Uint8Array[]} */ this.chunks = [];
    this.ended = false;
    /** @type {Error|null} */ this.error = null;
    /** @type {(() => void) | null} */ this.wake = null;
    /** @type {() => void} called when the reader stops early */ this.oncancel = () => {};
  }
  /** @param {Uint8Array} c */
  push(c) { if (this.ended) return; this.chunks.push(c); this.poke(); }
  end() { this.ended = true; this.poke(); }
  /** @param {Error} e */
  fail(e) { if (this.ended) return; this.error = e; this.ended = true; this.poke(); }
  poke() { const w = this.wake; this.wake = null; w?.(); }
  async *[Symbol.asyncIterator]() {
    let done = false;
    try {
      for (;;) {
        if (this.chunks.length) { yield /** @type {Uint8Array} */ (this.chunks.shift()); continue; }
        if (this.error) throw this.error;
        if (this.ended) { done = true; return; }
        await new Promise(r => { this.wake = () => r(undefined); });
      }
    } finally { if (!done && !this.error) this.oncancel(); }
  }
}

/** A case-insensitive, read-only view of a plain header object. */
export class HeadersLike {
  /** @param {Record<string, string>} h */
  constructor(h = {}) {
    /** @type {Map<string, string>} */ this.map = new Map();
    for (const [k, v] of Object.entries(h || {})) this.map.set(k.toLowerCase(), String(v));
  }
  /** @param {string} name */
  get(name) { return this.map.get(String(name).toLowerCase()) ?? null; }
  /** @param {string} name */
  has(name) { return this.map.has(String(name).toLowerCase()); }
  entries() { return this.map.entries(); }
  [Symbol.iterator]() { return this.map.entries(); }
  toJSON() { return Object.fromEntries(this.map); }
}

/**
 * @param {number} status @param {Record<string, string>} headers @param {AsyncIterable<Uint8Array>} body
 * @param {{ path?: string }} [meta]
 */
export function makeResponse(status, headers, body, meta = {}) {
  let used = false;
  const take = () => { if (used) throw new TypeError("body already read"); used = true; return body; };
  const bytes = async () => { const parts = []; for await (const c of take()) parts.push(c); return concat(...parts); };
  return {
    status,
    statusText: "",
    ok: status >= 200 && status < 300,
    headers: new HeadersLike(headers),
    url: meta.path || "",
    body: { [Symbol.asyncIterator]: () => take()[Symbol.asyncIterator]() },
    bytes,
    async arrayBuffer() { const b = await bytes(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    async text() { return fromUtf8(await bytes()); },
    async json() { return JSON.parse(fromUtf8(await bytes())); },
    /** Stop reading; the stream underneath is reset. */
    async cancel() { const it = take()[Symbol.asyncIterator](); await it.return?.(); },
  };
}

/** Headers from a plain object, a Headers instance or an array of pairs, lower-cased. @returns {Record<string, string>} */
export function lowerHeaders(h) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!h) return out;
  const pairs = typeof h.forEach === "function" && !Array.isArray(h) ? (() => { const p = []; h.forEach((v, k) => p.push([k, v])); return p; })()
    : Array.isArray(h) ? h : Object.entries(h);
  for (const [k, v] of pairs) if (v !== undefined && v !== null) out[String(k).toLowerCase()] = String(v);
  return out;
}

/** A native fetch Response as the same Response-like shape; `onerror` hears a body that broke. */
export function fromNative(res, onerror = () => {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  const body = {
    async *[Symbol.asyncIterator]() {
      if (!res.body) return;
      const reader = res.body.getReader();
      let done = false;
      try {
        for (;;) {
          let r;
          try { r = await reader.read(); } catch (e) { onerror(e); throw e; }
          if (r.done) { done = true; return; }
          yield r.value instanceof Uint8Array ? r.value : new Uint8Array(r.value);
        }
      } finally { if (!done) { try { await reader.cancel(); } catch {} } }
    },
  };
  return makeResponse(res.status, headers, body, { path: res.url });
}
