// @ts-check
// The home's end of a preview of a dev server that runs on a lent computer (contracts/lent-spawn.md, `lent.preview`; design item 13). The previews module (core/previews) opens a server on a loopback PORT of the
// box and puts it behind the front; this gives it such a port for a chat whose program runs on a person's computer: a loopback HTTP listener that turns each request into a job for the lender, who runs it against
// the dev server inside the sandbox and sends the answer back. The wire is a pull, as for `lent.pipe`: the lender asks `lent.preview { session, epoch, replies, wait_ms }` and is told the requests that are waiting.
// One request, one answer, each at most MAX_BODY bytes. An upgrade (a WebSocket: hot reload) is a byte tunnel: the browser's request and everything after it goes to the dev server as it is, and the server's bytes come back
// as they are, in order, in the same pulls (`tun` down, `replies` with `tun` up). Nothing here decides who may preview: the caller
// (runner.preview) is the chat's person, and the lender is held to the epoch like every write.
import http from "node:http";
import { newPrefixedId } from "../../lib/id.js";
import { within } from "../../lib/within.js";

export const PREVIEW = Object.freeze({ MAX_BODY: 1024 * 1024, REQ_MS: 60_000, WAIT_MS: 20_000, WAIT_MAX_MS: 25_000, MAX_QUEUE: 64, MAX_PER_SESSION: 4, MAX_TUNNELS: 8, CHUNK: 32 * 1024, TUNNEL_QUEUE_BYTES: 2 * 1024 * 1024 });
/** Headers that describe one hop, or that the home's front sets itself: never sent to the dev server as the browser's. */
const HOP = /^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|host|content-length|expect)$/i;
/** Vyre's own headers (the front's signed viewer, and any other x-vyre-*): never sent on to the dev server, and never taken from it, so neither side can speak as the front (trust row 31). */
const VYRE = /^x-vyre-/i;
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** @param {{ now?: () => number, reqMs?: number }} [o] */
export function createPreviews(o = {}) {
  const reqMs = o.reqMs ?? PREVIEW.REQ_MS;
  /** @type {Map<string, { session: string, port: number, server: http.Server, listen: number, viewer: null | ((header: string) => Promise<boolean>) }>} */ const bridges = new Map();
  /** @type {Map<string, { queue: any[], waiting: Map<string, { resolve: (r: any) => void }>, wake: null | (() => void), tunnels: Map<string, { socket: import("node:net").Socket, seq: number, up: number, ended: boolean, pend: Map<number, string>, last?: number }>, tq: any[], tqBytes: number, paused: Set<import("node:net").Socket> }>} */ const sessions = new Map();
  const stateOf = (/** @type {string} */ s) => { let x = sessions.get(s); if (!x) { x = { queue: [], waiting: new Map(), wake: null, tunnels: new Map(), tq: [], tqBytes: 0, paused: new Set() }; sessions.set(s, x); } return x; };

  /** An upgrade, as a tunnel: the raw request goes to the dev server through the lender, and the bytes of both sides follow in order until either ends. */
  const tunnel = (/** @type {string} */ session, /** @type {number} */ port, /** @type {http.IncomingMessage} */ req, /** @type {import("node:net").Socket} */ socket, /** @type {Buffer} */ head) => {
    const st = stateOf(session);
    if (st.tunnels.size >= PREVIEW.MAX_TUNNELS) { socket.end("HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n"); return; }
    const id = newPrefixedId("pvt");
    /** @type {string[]} */ const raw = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !/^(host|content-length)$/i.test(k) && !VYRE.test(k) && !/[\r\n]/.test(v)) raw.push(`${k}: ${v}`);
    raw.push(`host: localhost:${port}`);
    const t = { socket, seq: 0, up: 0, ended: false, pend: new Map(), last: undefined };
    st.tunnels.set(id, t);
    st.queue.push({ id, port, tunnel: true });
    st.tq.push({ id, seq: ++t.seq, b64: Buffer.concat([Buffer.from(raw.join("\r\n") + "\r\n\r\n"), head]).toString("base64") });
    if (st.wake) st.wake();
    // the browser is held (paused) while more than TUNNEL_QUEUE_BYTES wait for the computer to collect them; poll lets it go again as they are taken (trust row 30)
    socket.on("data", d => { if (t.ended) return; for (let at = 0; at < d.length; at += PREVIEW.CHUNK) { const b64 = d.subarray(at, at + PREVIEW.CHUNK).toString("base64"); st.tqBytes += b64.length; st.tq.push({ id, seq: ++t.seq, b64 }); } if (st.tqBytes > PREVIEW.TUNNEL_QUEUE_BYTES) { try { socket.pause(); } catch { /* gone */ } st.paused.add(socket); } if (st.wake) st.wake(); });
    const done = () => { if (t.ended) return; t.ended = true; st.tq.push({ id, end: true, seq: ++t.seq }); st.tunnels.delete(id); if (st.wake) st.wake(); };
    socket.on("end", done); socket.on("close", done); socket.on("error", () => { try { socket.destroy(); } catch { /* gone */ } done(); });
  };

  /** A browser request, as a job for the lender, answered when the lender answers. */
  const forward = (/** @type {string} */ session, /** @type {number} */ port, /** @type {http.IncomingMessage} */ req, /** @type {http.ServerResponse} */ res) => {
    const say = (/** @type {number} */ status, /** @type {string} */ text) => { if (res.headersSent) return; res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }); res.end(text); };
    const st = stateOf(session);
    if (st.queue.length + st.waiting.size >= PREVIEW.MAX_QUEUE) return say(503, "The preview is busy: try again.");
    /** @type {Buffer[]} */ const parts = []; let n = 0, over = false;
    req.on("data", c => { n += c.length; if (n > PREVIEW.MAX_BODY) { over = true; req.destroy(); } else parts.push(c); });
    req.on("error", () => {});
    req.on("end", () => {
      if (over) return say(413, "That request is too large for a preview.");
      const id = newPrefixedId("pvr");
      /** @type {Record<string, string>} */ const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.test(k) && !VYRE.test(k) && typeof v === "string") headers[k] = v;
      const job = { id, port, method: String(req.method || "GET"), path: String(req.url || "/"), headers, body: Buffer.concat(parts).toString("base64") };
      const answered = new Promise(resolve => { st.waiting.set(id, { resolve }); });
      st.queue.push(job); if (st.wake) st.wake();
      within(answered, reqMs, null).then((/** @type {any} */ r) => {
        st.waiting.delete(id); st.queue = st.queue.filter(j => j.id !== id);
        if (!r) return say(504, "The computer did not answer in time.");
        if (r.error) return say(502, String(r.error).slice(0, 200));
        /** @type {Record<string, string>} */ const h = {};
        for (const [k, v] of Object.entries(r.headers || {})) if (!HOP.test(k) && !VYRE.test(k) && typeof v === "string") h[k] = v;
        const body = Buffer.from(String(r.body || ""), "base64");
        res.writeHead(Number.isInteger(r.status) && r.status >= 100 && r.status < 600 ? r.status : 502, { ...h, "content-length": String(body.length) });
        res.end(body);
      });
    });
  };

  return {
    /**
     * A loopback port of this box that leads to `port` on the lender's computer for `session`. One bridge per session and port; at most MAX_PER_SESSION a session.
     * With `viewer`, a request is served only when the front's signed `x-vyre-viewer` header verifies (the previews module holds the key): another process on this box that finds the port gets a 401 and reaches nothing
     * of the person's computer (trust row 32).
     * @param {string} session @param {number} port @param {(header: string) => Promise<boolean>} [viewer]
     * @returns {Promise<{ port: number }>}
     */
    async open(session, port, viewer) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw err("bad_input", "a preview is of a port from 1024 to 65535");
      const key = `${session}:${port}`, had = bridges.get(key);
      if (had) { if (viewer) had.viewer = viewer; return { port: had.listen }; }
      if ([...bridges.values()].filter(b => b.session === session).length >= PREVIEW.MAX_PER_SESSION) throw err("quota", "this chat already has the most previews it may have: close one");
      /** @type {{ viewer: null | ((header: string) => Promise<boolean>) }} */ const gate = { viewer: viewer || null };
      const allowed = async (/** @type {http.IncomingMessage} */ req) => { const b = bridges.get(key); const v = (b && b.viewer) || gate.viewer; if (!v) return true; try { return await v(String(req.headers["x-vyre-viewer"] || "")) === true; } catch { return false; } };
      const server = http.createServer(async (req, res) => { if (!(await allowed(req))) { req.resume(); res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }); res.end("Sign in to Vyre to see this preview."); return; } forward(session, port, req, res); });
      server.on("upgrade", async (req, socket, head) => { socket.on("error", () => {}); if (!(await allowed(req))) { socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n"); return; } tunnel(session, port, req, socket, head); });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(undefined)); });
      const listen = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
      server.unref();
      bridges.set(key, { session, port, server, listen, viewer: viewer || null });
      return { port: listen };
    },
    /** The lender asks for work, handing in the answers it has: `replies: [{ id, status, headers, body (base64) } | { id, error }]`. Held up to `wait_ms` when nothing is waiting. @param {string} session @param {{ replies?: any[], wait_ms?: number }} i */
    async poll(session, i = {}) {
      const st = stateOf(session);
      for (const r of Array.isArray(i.replies) ? i.replies.slice(0, PREVIEW.MAX_QUEUE) : []) {
        // the dev server's bytes for a tunnel, in order, or its end
        if (r && r.tun === true) {
          const tn = typeof r.id === "string" ? st.tunnels.get(r.id) : undefined;
          if (tn) {
            // calls can arrive out of order: a chunk waits for the ones before it, then all go to the browser in order
            if (typeof r.b64 === "string" && r.b64.length <= Math.ceil(PREVIEW.CHUNK * 4 / 3) + 8 && Number.isInteger(r.seq) && r.seq > tn.up && tn.pend.size < 256) tn.pend.set(r.seq, r.b64);
            for (let b = tn.pend.get(tn.up + 1); b !== undefined; b = tn.pend.get(tn.up + 1)) { tn.pend.delete(tn.up + 1); tn.up++; try { tn.socket.write(Buffer.from(b, "base64")); } catch { /* gone */ } }
            if (r.end === true) tn.last = Number.isInteger(r.seq) ? r.seq : tn.up;
            if (tn.last !== undefined && tn.up >= tn.last) { tn.ended = true; st.tunnels.delete(r.id); try { tn.socket.end(); } catch { /* gone */ } }
          }
          continue;
        }
        const w = r && typeof r.id === "string" ? st.waiting.get(r.id) : undefined;
        if (!w) continue;
        if (typeof r.body === "string" && r.body.length > Math.ceil(PREVIEW.MAX_BODY * 4 / 3) + 8) w.resolve({ error: "the answer is too large for a preview" });
        else w.resolve(r);
        st.waiting.delete(r.id);
      }
      const ms = Math.max(0, Math.min(PREVIEW.WAIT_MAX_MS, Number.isInteger(i.wait_ms) ? /** @type {number} */ (i.wait_ms) : PREVIEW.WAIT_MS));
      const take = () => {
        const tun = st.tq.splice(0, 64); for (const x of tun) st.tqBytes -= x.b64 ? x.b64.length : 0;
        if (st.tqBytes < 0) st.tqBytes = 0;
        if (st.tqBytes <= PREVIEW.TUNNEL_QUEUE_BYTES / 2) { for (const sk of st.paused) { try { sk.resume(); } catch { /* gone */ } } st.paused.clear(); }
        return { reqs: st.queue.splice(0, 16), ...(tun.length ? { tun } : {}) };
      };
      if (st.queue.length || st.tq.length || ms === 0) return take();
      await new Promise(res => { const t = setTimeout(() => { st.wake = null; res(undefined); }, ms); t.unref?.(); st.wake = () => { clearTimeout(t); st.wake = null; res(undefined); }; });
      return take();
    },
    /** Does this session have a preview open? @param {string} session */
    has(session) { return [...bridges.values()].some(b => b.session === session); },
    /** The session left (stopped, moved, taken): its previews close and what waited answers 502. @param {string} session */
    close(session) {
      for (const [k, b] of bridges) if (b.session === session) { try { b.server.close(); b.server.closeAllConnections?.(); } catch { /* gone */ } bridges.delete(k); }
      const st = sessions.get(session); if (st) { for (const w of st.waiting.values()) w.resolve({ error: "the chat's computer closed the preview" }); st.waiting.clear(); for (const t of st.tunnels.values()) { try { t.socket.destroy(); } catch { /* gone */ } } st.tunnels.clear(); st.queue = []; st.tq = []; if (st.wake) st.wake(); sessions.delete(session); }
    },
  };
}
