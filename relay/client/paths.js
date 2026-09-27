// @ts-check
// paths: one box, several ways to reach it, one API (ADR 0029, R5; "Direction A"). The list is
// ordered best first, for example:
//
//   [{ kind: "direct", base: "https://<box>.<tailnet>.ts.net" },
//    { kind: "relay", relay, route, box, keyStore, crypto }]
//
// A direct path is used only once it answers a probe within 1.5 s; a transport error on it moves
// to the next path at once and the request is sent there (a non-GET keeps its Idempotency-Key).
// While on a worse path, the better ones are probed every 60 s, only while visible, and the
// connection moves back when one answers. Event streams follow the move and resume from their
// cursor, which belongs to the box, not the path. So the web app on an iPhone uses the tailnet
// when Tailscale is on and the relay otherwise, and does not care which.

import { connect, defaultVisibility } from "./client.js";
import { fromNative, lowerHeaders } from "./response.js";
import { followEvents } from "./sse.js";
import { uuidFrom } from "./bytes.js";

const PROBE_MS = 60_000;
const DIRECT_TIMEOUT = 1500;

/**
 * @param {{ paths: Array<{ kind: "direct", base: string } | ({ kind: "relay" } & Record<string, any>)>,
 *   fetch?: typeof globalThis.fetch, WebSocket?: any, visibility?: import("./client.js").Visibility,
 *   connect?: typeof connect, directTimeout?: number, probeMs?: number, probePath?: string,
 *   onstate?: (s: { kind: string, index: number, state: string }) => void }} o
 */
export function createPaths(o) {
  if (!o || !Array.isArray(o.paths) || !o.paths.length) throw new Error("createPaths needs at least one path");
  const nativeFetch = o.fetch || globalThis.fetch?.bind(globalThis);
  const visibility = o.visibility || defaultVisibility();
  const directTimeout = o.directTimeout ?? DIRECT_TIMEOUT;
  const probeMs = o.probeMs ?? PROBE_MS;
  const probePath = o.probePath || "/v1/health";
  const connectRelay = o.connect || connect;
  let closed = false;
  let index = 0;
  /** @type {any} */
  let prober = null;
  /** In-flight requests, aborted on close. */
  /** @type {Set<{ index: number, ac: AbortController }>} */
  const live = new Set();
  /** @type {Set<ReturnType<typeof followEvents>>} */
  const follows = new Set();

  const paths = o.paths.map((p, i) => p.kind === "direct" ? directPath(p, i) : relayPath(p, i));

  function directPath(p, i) {
    const base = String(p.base).replace(/\/+$/, "");
    const path = {
      kind: "direct", index: i, base,
      /** null: not tried; true: answered lately; false: failed */
      /** @type {boolean|null} */ good: null,
      async probe() {
        const ac = new AbortController();
        const t = globalThis.setTimeout(() => ac.abort(), directTimeout);
        try {
          const res = await nativeFetch(base + probePath, { signal: ac.signal });
          try { await res.body?.cancel(); } catch {}
          path.good = true;
        } catch { path.good = false; }
        finally { globalThis.clearTimeout(t); }
        return path.good;
      },
      async fetch(p2, init) {
        let res;
        try { res = await nativeFetch(base + p2, init); } catch (e) {
          if (init.signal?.aborted) throw e;
          path.good = false;
          throw Object.assign(/** @type {Error} */ (e), { transport: true });
        }
        path.good = true;
        return fromNative(res, () => { path.good = false; });
      },
      socket(p2) {
        const WS = o.WebSocket || globalThis.WebSocket;
        return new WS(base.replace(/^http/, "ws") + p2);
      },
      close() {},
    };
    return path;
  }

  function relayPath(p, i) {
    /** @type {import("./client.js").Connection | null} */
    let conn = null;
    const get = () => conn || (conn = connectRelay({ WebSocket: o.WebSocket, visibility, ...p }));
    return {
      kind: "relay", index: i,
      get good() { return conn ? conn.state === "open" : null; },
      get connection() { return conn; },
      async probe() {
        const c = get();
        if (c.state === "open") return true;
        c.wake();
        return false;
      },
      fetch: (p2, init) => get().fetch(p2, init),
      socket: p2 => get().socket(p2),
      close() { conn?.close(); conn = null; },
    };
  }

  const api = {
    /** @type {(s: { kind: string, index: number, state: string }) => void} */
    onstate: o.onstate || (() => {}),
    get current() { return paths[index].kind; },
    get index() { return index; },
    paths,

    /**
     * fetch on the best working path.
     * @param {string} path
     * @param {{ method?: string, headers?: any, body?: any, signal?: AbortSignal }} [init]
     */
    async fetch(path, init = {}) {
      const method = String(init.method || "GET").toUpperCase();
      const headers = lowerHeaders(init.headers);
      // One key per intent, set here so a move to another path sends the same one.
      if (method !== "GET" && method !== "HEAD" && !headers["idempotency-key"]) headers["idempotency-key"] = newKey();
      for (;;) {
        if (closed) throw new Error("closed");
        if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        const i = index;
        const p = paths[i];
        const last = i === paths.length - 1;
        if (p.kind === "direct" && p.good !== true && !last) {
          if (!(await p.probe())) { moveTo(i + 1, "direct did not answer"); continue; }
        }
        // Each request gets its own abort, so a move can pull it off the old path.
        const ac = new AbortController();
        const entry = { index: i, ac };
        const outer = init.signal;
        const onOuter = () => ac.abort();
        outer?.addEventListener?.("abort", onOuter, { once: true });
        live.add(entry);
        const done = () => { live.delete(entry); outer?.removeEventListener?.("abort", onOuter); };
        try {
          const res = await p.fetch(path, { ...init, method, headers, signal: ac.signal });
          return track(res, done);
        } catch (e) {
          done();
          if (outer?.aborted) throw e;
          const moved = index !== i;
          if (moved) continue;                                   // the connection moved under us: send it on the new path
          if (/** @type {any} */ (e)?.transport && !last) { moveTo(i + 1, String(/** @type {any} */ (e)?.message || e)); continue; }
          throw e;
        }
      }
    },

    /** Follow an event stream on whichever path is current; it moves with the connection. */
    events(path, eo) {
      const f = followEvents((p, init) => api.fetch(p, init), path, eo);
      follows.add(f);
      return { get lastEventId() { return f.lastEventId; }, reopen: () => f.reopen(), close: () => { f.close(); follows.delete(f); } };
    },

    /** A WebSocket on the current path. It does not move: on close, open another. */
    socket(path) { return paths[index].socket(path); },

    /** Probe the better paths now (the app came to the front, the network changed). */
    probe: () => probeBetter(),

    close() {
      closed = true;
      globalThis.clearInterval(prober);
      offVisible();
      for (const f of follows) f.close();
      for (const e of live) e.ac.abort();
      for (const p of paths) p.close();
    },
  };

  /** Keep the request registered until its body is read or dropped, so a move can abort it. */
  function track(res, done) {
    const body = res.body;
    let finished = false;
    const fin = () => { if (!finished) { finished = true; done(); } };
    const wrapped = {
      [Symbol.asyncIterator]() {
        const it = body[Symbol.asyncIterator]();
        return {
          async next() { try { const r = await it.next(); if (r.done) fin(); return r; } catch (e) { fin(); throw e; } },
          async return() { fin(); return it.return ? it.return() : { done: true, value: undefined }; },
        };
      },
    };
    const read = fn => async () => { try { return await fn(); } finally { fin(); } };
    return { ...res, body: wrapped, text: read(res.text), json: read(res.json), bytes: read(res.bytes), arrayBuffer: read(res.arrayBuffer) };
  }

  function moveTo(i, why) {
    if (i === index || closed) return;
    const old = index;
    index = i;
    // Event streams reopen on the new path from their cursor. A request already in flight
    // finishes where it is, or comes back here and is sent again on the new path.
    for (const f of follows) f.reopen();
    // Back on a better path: drop the relay's channel rather than keep it warm.
    if (i < old && paths[old].kind === "relay") paths[old].close();
    try { api.onstate({ kind: paths[i].kind, index: i, state: why }); } catch {}
    schedule();
  }

  async function probeBetter() {
    if (closed || visibility.hidden()) return;
    for (let j = 0; j < index; j++) {
      if (await paths[j].probe()) { moveTo(j, "a better path answered"); return; }
    }
  }

  function schedule() {
    globalThis.clearInterval(prober);
    prober = null;
    if (index > 0 && !closed) prober = globalThis.setInterval(() => { probeBetter(); }, probeMs);
  }

  const offVisible = visibility.on(() => { if (!visibility.hidden()) probeBetter(); });

  return api;
}

function newKey() {
  const g = /** @type {any} */ (globalThis).crypto;
  if (g && typeof g.randomUUID === "function") return g.randomUUID();
  const r = new Uint8Array(16);
  g.getRandomValues(r);
  return uuidFrom(r);
}
