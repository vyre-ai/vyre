// @ts-check
// cdp-adapter: where an agent's Chrome answers, for the code in vyred that drives it (the hands, the Vault fill, Glass screencast). Those speak computerd's old shape: GET /cdp/json/version with a
// bearer token, then a WebSocket. An agent's own Chrome has no such port (its debugging pipe is a unix socket in the agent's 0700 folder, reached only through agentd's relay), so vyred answers
// that shape itself, on loopback, per agent:
//   - every agent has its own random token; a token opens THAT agent's Chrome and no other, and only computers.endpoint hands a token out (after resolving the calling agent from its verified claim);
//   - a CDP session belongs to the client that attached it (and to what that session auto-attaches): its events go to that client only, and a command naming a session another client owns is refused, so
//     the hands never hear the fill's page or type into its session; only sessionless browser-level events go to every client;
//   - a connection for an agent is joined to the agent's relay with a ticket of its own (open), never to a path or an address a client names;
//   - several clients of one agent (hands, fill) share the agent's one pipe: their message ids are rewritten so answers find their asker, and events go to every client of that agent only.
//   - a Vault fill raises a WINDOW (shield): the agent's own clients are cut and refused (423), only the fill's token is let in, and the exact values the fill types are registered. Whatever the agent's DevTools
//     return afterwards, for as long as the values are registered, has every occurrence of them (plain, URL-encoded, JSON-escaped, base64, and inside a base64 response body) replaced by a marker, and the sign-in
//     requests' bodies are never given out. Nothing else is held back: the agent has full DevTools in its own Chrome (the owner's ruling, 18 Oct 2026).
// Limits of the scrub, stated plainly: it is by EXACT value (every common form of it, min length 4), it holds for the window plus RETAIN_MS, and it lives in memory only (a JavaScript string cannot be wiped).
// A value the page transforms, or shows again after that, is not caught. The real controls are that the fields are emptied at the end of the fill and that the sign-in requests' bodies are never given out.
// The holder inside the computer serves one client; this is that client.

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { encodeFrame, FrameParser, upgradeHead } from "../../lib/ws.js";
import { scrubAll, scrub } from "../../lib/scrub.js";

const MAX_MSG = 16 * 1024 * 1024;
/** How long a fill's values stay scrubbed after its window ends (the redirect after submit, bodies read soon after). */
export const RETAIN_MS = 10 * 60_000;
/** Requests made in a fill's window and just after it, whose bodies are never given out. */
const AFTER_MS = 10_000;
const MARK = "[value]";
const sha = (/** @type {string} */ t) => crypto.createHash("sha256").update(t).digest("hex");

/**
 * @param {{ open: (agent: string) => Promise<{ host: string, port: number, hello: string, release: () => void }>, log?: (m: string) => void, now?: () => number }} deps
 */
export function createCdpAdapter(deps) {
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  /** @type {Map<string, string>} agent -> token */ const tokens = new Map();
  /** @type {Map<string, string>} sha(token) -> agent */ const byHash = new Map();
  /** @type {Map<string, Link>} */ const links = new Map();
  /** An open fill window per agent: the token that alone is let in. @type {Map<string, { token: string }>} */ const windows = new Map();
  /** When each agent's last window ended. @type {Map<string, number>} */ const endedAt = new Map();
  /** The values a fill typed, per agent, and when they stop being scrubbed. @type {Map<string, Array<{ values: string[], expires: number }>>} */ const secrets = new Map();
  /** Request ids made in a window: their bodies are never given out. @type {Map<string, Set<string>>} */ const signIns = new Map();
  const secretsOf = (/** @type {string} */ agent) => {
    const t = now(); const list = (secrets.get(agent) || []).filter(e => e.expires > t);
    secrets.set(agent, list); return list.flatMap(e => e.values);
  };
  const inWindow = (/** @type {string} */ agent) => windows.has(agent) || now() - (endedAt.get(agent) || -Infinity) < AFTER_MS;
  /** @type {http.Server | null} */ let server = null;
  /** @type {Promise<number> | null} */ let listening = null;

  /** One agent's connection to its Chrome, shared by its clients. */
  class Link {
    /** @param {string} agent */
    constructor(agent) {
      this.agent = agent; this.seq = 0;
      /** @type {Map<(text: string) => void, { fill: boolean }>} */ this.clients = new Map();
      /** @type {Map<number, { send: (text: string) => void, id: number, method: string, request: string }>} */ this.asked = new Map();
      /** Which client owns each CDP session. @type {Map<string, (text: string) => void>} */ this.owners = new Map();
      /** @type {net.Socket | null} */ this.sock = null; this.release = /** @type {(() => void) | null} */ (null);
      this.buf = Buffer.alloc(0); this.closed = false;
      this.ready = this.start();
      this.ready.catch(() => this.close());
    }
    async start() {
      const t = await deps.open(this.agent);
      this.release = t.release;
      const s = net.connect(t.port, t.host);
      this.sock = s;
      s.on("error", () => this.close());
      s.on("close", () => this.close());
      s.on("data", d => this.fromChrome(d));
      s.write(t.hello);
    }
    /** What the agent's DevTools may be given: the fill's values out of every string (and out of a base64 body), the sign-in requests' bodies gone. The fill's own client gets the message as it is. @param {any} m @param {{ method: string, request: string } | null} ask */
    forAgent(m, ask) {
      const values = secretsOf(this.agent);
      const mine = signIns.get(this.agent);
      if (m.method === "Network.requestWillBeSent" && m.params && m.params.request && mine && mine.has(String(m.params.requestId))) {
        m = { ...m, params: { ...m.params, request: { ...m.params.request, postData: undefined, postDataEntries: undefined, hasPostData: false } } };
      }
      if (ask && ask.method === "Network.getRequestPostData" && mine && mine.has(ask.request)) {
        return { id: m.id, error: { code: -32000, message: "the body of a sign-in request is not kept" } };
      }
      if (!values.length) return m;
      if (ask && /^(Network|Fetch)\.getResponseBody$/.test(ask.method) && m.result && m.result.base64Encoded === true && typeof m.result.body === "string") {
        const body = scrub(Buffer.from(m.result.body, "base64").toString("latin1"), values, { marker: MARK, min: 4 });
        m = { ...m, result: { ...m.result, body: Buffer.from(body, "latin1").toString("base64") } };
      }
      return scrubAll(m, values, { marker: MARK, min: 4 });
    }
    /** @param {Buffer} d */
    fromChrome(d) {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        const i = this.buf.indexOf(0);
        if (i < 0) { if (this.buf.length > MAX_MSG) this.close(); return; }
        const text = this.buf.subarray(0, i).toString("utf8");
        this.buf = this.buf.subarray(i + 1);
        let m; try { m = JSON.parse(text); } catch { continue; }
        // a request made while a fill is signing in (or just after) is a sign-in request: remember it, whoever is listening
        if (m.method === "Network.requestWillBeSent" && m.params && inWindow(this.agent)) {
          const set = signIns.get(this.agent) || new Set(); signIns.set(this.agent, set);
          set.add(String(m.params.requestId)); if (set.size > 2000) set.delete(set.values().next().value);
        }
        if (Number.isInteger(m.id)) {
          const who = this.asked.get(m.id);
          if (!who) continue;
          this.asked.delete(m.id);
          // a session made for a client is that client's
          if (!m.error && m.result && typeof m.result.sessionId === "string" && /^Target\.attach(ToTarget|ToBrowserTarget)$/.test(who.method)) this.owners.set(m.result.sessionId, who.send);
          const fill = Boolean(this.clients.get(who.send)?.fill);
          who.send(JSON.stringify(fill ? { ...m, id: who.id } : { ...this.forAgent(m, who), id: who.id }));
        } else {
          // an event of a session goes to the session's owner alone; a session attached inside an owned one (a frame, a worker) is owned by the same client; a browser-level event goes to all
          if (m.method === "Target.attachedToTarget" && m.params && typeof m.params.sessionId === "string" && m.sessionId && this.owners.has(m.sessionId)) this.owners.set(m.params.sessionId, /** @type {any} */ (this.owners.get(m.sessionId)));
          const targets = m.sessionId ? (this.owners.has(m.sessionId) ? [this.owners.get(m.sessionId)] : []) : [...this.clients.keys()];
          let agentText = /** @type {string | null} */ (null);
          for (const c of targets) { const info = this.clients.get(/** @type {any} */ (c)); if (info) /** @type {any} */ (c)(info.fill ? text : (agentText ??= JSON.stringify(this.forAgent(m, null)))); }
          if (m.method === "Target.detachedFromTarget" && m.params) this.owners.delete(String(m.params.sessionId));
        }
      }
    }
    /** @param {string} text @param {(text: string) => void} client */
    toChrome(text, client) {
      if (this.closed || !this.sock || Buffer.byteLength(text) > MAX_MSG) return false;
      let m; try { m = JSON.parse(text); } catch { return false; }
      if (!m || typeof m !== "object" || !Number.isInteger(m.id)) return false;
      // a command into a session that is not this client's is refused, whoever's it is
      if (m.sessionId !== undefined && this.owners.get(String(m.sessionId)) !== client) { client(JSON.stringify({ id: m.id, error: { code: -32001, message: "that session is not yours" } })); return true; }
      const up = ++this.seq;
      this.asked.set(up, { send: client, id: m.id, method: String(m.method || ""), request: String(m.params && m.params.requestId || "") });
      this.sock.write(JSON.stringify({ ...m, id: up }) + "\0");
      return true;
    }
    /** Close the clients that are (fill: true) or are not the fill's. @param {boolean} fill */
    cut(fill) { for (const [c, info] of [...this.clients]) if (info.fill === fill) { try { c("\0close"); } catch {} } }
    /** @param {(text: string) => void} client */
    leave(client) {
      this.clients.delete(client);
      for (const [k, v] of this.asked) if (v.send === client) this.asked.delete(k);
      // the sessions it made go with it (the pages stay)
      for (const [sid, owner] of [...this.owners]) if (owner === client) {
        this.owners.delete(sid);
        // stop what the session was recording, then let it go: nothing of the fill's page keeps flowing once its window is over
        if (this.sock && !this.closed) for (const [method, params] of [["Network.disable", {}], ["Fetch.disable", {}], ["Target.detachFromTarget", { sessionId: sid }]]) {
          this.sock.write(JSON.stringify({ id: ++this.seq, method, params, ...(method === "Target.detachFromTarget" ? {} : { sessionId: sid }) }) + "\0");
        }
      }
      if (!this.clients.size) setTimeout(() => { if (!this.clients.size) this.close(); }, 30_000).unref();
    }
    close() {
      if (this.closed) return; this.closed = true;
      if (links.get(this.agent) === this) links.delete(this.agent);
      try { this.sock?.destroy(); } catch {}
      if (this.release) { const r = this.release; this.release = null; try { r(); } catch {} }
      for (const c of this.clients.keys()) { try { c("\0close"); } catch {} }
      this.clients.clear(); this.asked.clear(); this.owners.clear();
    }
  }

  /** Who a token is: the agent it opens, whether it is the fill's, and whether the agent's own token is shut out right now (a fill's window is open). @param {string} t */
  const whoIs = t => {
    if (!t) return null;
    for (const [agent, w] of windows) if (w.token.length === t.length && crypto.timingSafeEqual(Buffer.from(w.token), Buffer.from(t))) return { agent, fill: true, busy: false };
    const agent = byHash.get(sha(t));
    return agent ? { agent, fill: false, busy: windows.has(agent) } : null;
  };
  const bearer = (/** @type {http.IncomingMessage} */ req) => String(req.headers.authorization || "").replace(/^Bearer /, "");

  const start = () => listening || (listening = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://x");
      const who = whoIs(bearer(req));
      if (url.pathname !== "/cdp/json/version" || req.method !== "GET" || !who || who.busy) { res.writeHead(!who ? 401 : who.busy ? 423 : 404); return void res.end(); }
      const port = /** @type {any} */ (server?.address()).port;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/cdp/devtools/browser` }));
    });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", "http://x");
      const who = whoIs(url.searchParams.get("token") || "");
      const key = req.headers["sec-websocket-key"];
      if (!who || url.pathname !== "/cdp/devtools/browser" || !key || String(req.headers.upgrade).toLowerCase() !== "websocket") { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
      if (who.busy) { socket.end("HTTP/1.1 423 Locked\r\nConnection: close\r\n\r\n"); return; }
      socket.write(upgradeHead(String(key)));
      attach(who.agent, who.fill, socket, head);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(/** @type {any} */ (server?.address()).port));
  }));

  /** @param {string} agent @param {boolean} fill @param {net.Socket} socket @param {Buffer} head */
  function attach(agent, fill, socket, head) {
    let link = links.get(agent);
    if (!link || link.closed) { link = new Link(agent); links.set(agent, link); }
    const l = link;
    const send = (/** @type {string} */ text) => {
      if (text === "\0close") { try { socket.end(encodeFrame(Buffer.alloc(0), 0x8)); } catch {} return; }
      try { socket.write(encodeFrame(Buffer.from(text), 1)); } catch {}
    };
    l.clients.set(send, { fill });
    const parser = new FrameParser({ max: MAX_MSG });
    const onData = async (/** @type {Buffer} */ chunk) => {
      let frames; try { frames = parser.push(chunk); } catch { return void socket.destroy(); }
      try { await l.ready; } catch (e) { log(`cdp: ${agent}'s Chrome could not be reached: ${String(/** @type {Error} */ (e) && /** @type {Error} */ (e).message || e).slice(0, 200)}`); return void socket.destroy(); }
      for (const f of frames) {
        if ("control" in f) { if (f.control === "close") return void socket.destroy(); if (f.control === "ping") socket.write(encodeFrame(f.payload, 0xa)); continue; }
        // a client that is not the fill's, while a window is open, is refused whatever it was let in before
        if (!fill && windows.has(agent)) return void socket.destroy();
        if (!l.toChrome(f.message.toString("utf8"), send)) return void socket.destroy();
      }
    };
    socket.on("data", onData);
    socket.on("close", () => l.leave(send));
    socket.on("error", () => {});
    if (head && head.length) onData(head);
  }

  return {
    /** Where this agent's Chrome answers and the token that opens it: the same shape computerd's helper had. @param {string} agent */
    async endpoint(agent) {
      const port = await start();
      let token = tokens.get(agent);
      if (!token) { token = crypto.randomBytes(32).toString("base64url"); tokens.set(agent, token); byHash.set(sha(token), agent); }
      return { url: `http://127.0.0.1:${port}`, token };
    },
    /**
     * Raise or lower a fill's window. On: the agent's own clients are cut and refused (423) and only fill_token is let in. Off: the fill's clients are cut, the agent's token works again, and the values the fill
     * registered stay scrubbed for RETAIN_MS. @param {string} agent @param {boolean} on @param {{ fill_token?: string }} [o]
     */
    async shield(agent, on, o = {}) {
      if (on) {
        if (!o.fill_token || o.fill_token.length < 32) throw new Error("a fill window needs the fill's token");
        windows.set(agent, { token: o.fill_token });
        links.get(agent)?.cut(false);
      } else {
        windows.delete(agent); endedAt.set(agent, now());
        for (const e of secrets.get(agent) || []) if (e.expires === Infinity) e.expires = now() + RETAIN_MS;
        links.get(agent)?.cut(true);
      }
      return true;
    },
    /** The exact values a fill types: scrubbed from what the agent's DevTools return while the window is open and for RETAIN_MS after. @param {string} agent @param {string[]} values */
    register(agent, values) {
      const list = (Array.isArray(values) ? values : []).filter(v => typeof v === "string" && v.length >= 4);
      if (!list.length) return;
      secrets.set(agent, [...(secrets.get(agent) || []), { values: list, expires: windows.has(agent) ? Infinity : now() + RETAIN_MS }]);
    },
    /** Close an agent's link (its computer went to sleep or was reset): its clients see a close and reconnect through the endpoint. @param {string} agent */
    drop(agent) { const l = links.get(agent); if (l) l.close(); },
    async close() {
      for (const l of [...links.values()]) l.close();
      const s = server;
      if (!s) return;
      server = null;
      // A hands client stays connected after the page opens. close() alone waits for that socket, so a stop would never finish.
      if (typeof s.closeAllConnections === "function") s.closeAllConnections();
      await new Promise(r => s.close(() => r(undefined)));
    },
  };
}
