// @ts-check
// The home's end of a preview of a dev server that runs on a lent computer (contracts/lent-spawn.md, `lent.preview`; design item 13). The previews module (core/previews) opens a server on a loopback PORT of the
// box and puts it behind the front; this gives it such a port for a chat whose program runs on a person's computer: a loopback HTTP listener that turns each request into a job for the lender, who runs it against
// the dev server inside the sandbox and sends the answer back. The wire is a pull, as for `lent.pipe`: the lender asks `lent.preview { session, epoch, replies, wait_ms }` and is told the requests that are waiting.
// One request, one answer, each at most MAX_BODY bytes (HTTP only; an upgrade, a WebSocket and a stream are refused with 501 until a byte stream is carried). Nothing here decides who may preview: the caller
// (runner.preview) is the chat's person, and the lender is held to the epoch like every write.
import http from "node:http";
import { newPrefixedId } from "../../lib/id.js";
import { within } from "../../lib/within.js";

export const PREVIEW = Object.freeze({ MAX_BODY: 1024 * 1024, REQ_MS: 60_000, WAIT_MS: 20_000, WAIT_MAX_MS: 25_000, MAX_QUEUE: 64, MAX_PER_SESSION: 4 });
/** Headers that describe one hop, or that the home's front sets itself: never sent to the dev server as the browser's. */
const HOP = /^(connection|keep-alive|proxy-authenticate|proxy-authorization|te|trailer|transfer-encoding|upgrade|host|content-length|expect)$/i;
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** @param {{ now?: () => number, reqMs?: number }} [o] */
export function createPreviews(o = {}) {
  const reqMs = o.reqMs ?? PREVIEW.REQ_MS;
  /** @type {Map<string, { session: string, port: number, server: http.Server, listen: number }>} */ const bridges = new Map();
  /** @type {Map<string, { queue: any[], waiting: Map<string, { resolve: (r: any) => void }>, wake: null | (() => void) }>} */ const sessions = new Map();
  const stateOf = (/** @type {string} */ s) => { let x = sessions.get(s); if (!x) { x = { queue: [], waiting: new Map(), wake: null }; sessions.set(s, x); } return x; };

  /** A browser request, as a job for the lender, answered when the lender answers. */
  const forward = (/** @type {string} */ session, /** @type {number} */ port, /** @type {http.IncomingMessage} */ req, /** @type {http.ServerResponse} */ res) => {
    const say = (/** @type {number} */ status, /** @type {string} */ text) => { if (res.headersSent) return; res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }); res.end(text); };
    if (req.headers.upgrade) return say(501, "This preview does not carry WebSockets yet: reload the page by hand.");
    const st = stateOf(session);
    if (st.queue.length + st.waiting.size >= PREVIEW.MAX_QUEUE) return say(503, "The preview is busy: try again.");
    /** @type {Buffer[]} */ const parts = []; let n = 0, over = false;
    req.on("data", c => { n += c.length; if (n > PREVIEW.MAX_BODY) { over = true; req.destroy(); } else parts.push(c); });
    req.on("error", () => {});
    req.on("end", () => {
      if (over) return say(413, "That request is too large for a preview.");
      const id = newPrefixedId("pvr");
      /** @type {Record<string, string>} */ const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.test(k) && typeof v === "string") headers[k] = v;
      const job = { id, port, method: String(req.method || "GET"), path: String(req.url || "/"), headers, body: Buffer.concat(parts).toString("base64") };
      const answered = new Promise(resolve => { st.waiting.set(id, { resolve }); });
      st.queue.push(job); if (st.wake) st.wake();
      within(answered, reqMs, null).then((/** @type {any} */ r) => {
        st.waiting.delete(id); st.queue = st.queue.filter(j => j.id !== id);
        if (!r) return say(504, "The computer did not answer in time.");
        if (r.error) return say(502, String(r.error).slice(0, 200));
        /** @type {Record<string, string>} */ const h = {};
        for (const [k, v] of Object.entries(r.headers || {})) if (!HOP.test(k) && typeof v === "string") h[k] = v;
        const body = Buffer.from(String(r.body || ""), "base64");
        res.writeHead(Number.isInteger(r.status) && r.status >= 100 && r.status < 600 ? r.status : 502, { ...h, "content-length": String(body.length) });
        res.end(body);
      });
    });
  };

  return {
    /**
     * A loopback port of this box that leads to `port` on the lender's computer for `session`. One bridge per session and port; at most MAX_PER_SESSION a session.
     * @param {string} session @param {number} port
     * @returns {Promise<{ port: number }>}
     */
    async open(session, port) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw err("bad_input", "a preview is of a port from 1024 to 65535");
      const key = `${session}:${port}`, had = bridges.get(key);
      if (had) return { port: had.listen };
      if ([...bridges.values()].filter(b => b.session === session).length >= PREVIEW.MAX_PER_SESSION) throw err("quota", "this chat already has the most previews it may have: close one");
      const server = http.createServer((req, res) => forward(session, port, req, res));
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(undefined)); });
      const listen = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
      server.unref();
      bridges.set(key, { session, port, server, listen });
      return { port: listen };
    },
    /** The lender asks for work, handing in the answers it has: `replies: [{ id, status, headers, body (base64) } | { id, error }]`. Held up to `wait_ms` when nothing is waiting. @param {string} session @param {{ replies?: any[], wait_ms?: number }} i */
    async poll(session, i = {}) {
      const st = stateOf(session);
      for (const r of Array.isArray(i.replies) ? i.replies.slice(0, PREVIEW.MAX_QUEUE) : []) {
        const w = r && typeof r.id === "string" ? st.waiting.get(r.id) : undefined;
        if (!w) continue;
        if (typeof r.body === "string" && r.body.length > Math.ceil(PREVIEW.MAX_BODY * 4 / 3) + 8) w.resolve({ error: "the answer is too large for a preview" });
        else w.resolve(r);
        st.waiting.delete(r.id);
      }
      const ms = Math.max(0, Math.min(PREVIEW.WAIT_MAX_MS, Number.isInteger(i.wait_ms) ? /** @type {number} */ (i.wait_ms) : PREVIEW.WAIT_MS));
      const take = () => { const out = st.queue.splice(0, 16); return out; };
      if (st.queue.length || ms === 0) return { reqs: take() };
      await new Promise(res => { const t = setTimeout(() => { st.wake = null; res(undefined); }, ms); t.unref?.(); st.wake = () => { clearTimeout(t); st.wake = null; res(undefined); }; });
      return { reqs: take() };
    },
    /** Does this session have a preview open? @param {string} session */
    has(session) { return [...bridges.values()].some(b => b.session === session); },
    /** The session left (stopped, moved, taken): its previews close and what waited answers 502. @param {string} session */
    close(session) {
      for (const [k, b] of bridges) if (b.session === session) { try { b.server.close(); b.server.closeAllConnections?.(); } catch { /* gone */ } bridges.delete(k); }
      const st = sessions.get(session); if (st) { for (const w of st.waiting.values()) w.resolve({ error: "the chat's computer closed the preview" }); st.waiting.clear(); st.queue = []; if (st.wake) st.wake(); sessions.delete(session); }
    },
  };
}
