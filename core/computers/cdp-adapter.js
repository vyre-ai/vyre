// @ts-check
// cdp-adapter: where an agent's Chrome answers, for the code in vyred that drives it (the hands, the Vault fill, Glass screencast). Those speak computerd's old shape: GET /cdp/json/version with a
// bearer token, then a WebSocket. An agent's own Chrome has no such port (its debugging pipe is a unix socket in the agent's 0700 folder, reached only through agentd's relay), so vyred answers
// that shape itself, on loopback, per agent:
//   - every agent has its own random token; a token opens THAT agent's Chrome and no other, and only computers.endpoint hands a token out (after resolving the calling agent from its verified claim);
//   - a connection for an agent is joined to the agent's relay with a ticket of its own (open), never to a path or an address a client names;
//   - several clients of one agent (hands, fill) share the agent's one pipe: their message ids are rewritten so answers find their asker, and events go to every client of that agent only.
// The holder inside the computer serves one client; this is that client.

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { encodeFrame, FrameParser, upgradeHead } from "../../lib/ws.js";

const MAX_MSG = 16 * 1024 * 1024;
const sha = (/** @type {string} */ t) => crypto.createHash("sha256").update(t).digest("hex");

/**
 * @param {{ open: (agent: string) => Promise<{ host: string, port: number, hello: string, release: () => void }>, log?: (m: string) => void }} deps
 */
export function createCdpAdapter(deps) {
  const log = deps.log || (() => {});
  /** @type {Map<string, string>} agent -> token */ const tokens = new Map();
  /** @type {Map<string, string>} sha(token) -> agent */ const byHash = new Map();
  /** @type {Map<string, Link>} */ const links = new Map();
  /** @type {http.Server | null} */ let server = null;
  /** @type {Promise<number> | null} */ let listening = null;

  /** One agent's connection to its Chrome, shared by its clients. */
  class Link {
    /** @param {string} agent */
    constructor(agent) {
      this.agent = agent; this.seq = 0;
      /** @type {Set<(text: string) => void>} */ this.clients = new Set();
      /** @type {Map<number, { send: (text: string) => void, id: number }>} */ this.asked = new Map();
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
    /** @param {Buffer} d */
    fromChrome(d) {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        const i = this.buf.indexOf(0);
        if (i < 0) { if (this.buf.length > MAX_MSG) this.close(); return; }
        const text = this.buf.subarray(0, i).toString("utf8");
        this.buf = this.buf.subarray(i + 1);
        let m; try { m = JSON.parse(text); } catch { continue; }
        if (Number.isInteger(m.id)) {
          const who = this.asked.get(m.id);
          if (!who) continue;
          this.asked.delete(m.id);
          who.send(JSON.stringify({ ...m, id: who.id }));
        } else for (const c of this.clients) c(text);
      }
    }
    /** @param {string} text @param {(text: string) => void} client */
    toChrome(text, client) {
      if (this.closed || !this.sock || Buffer.byteLength(text) > MAX_MSG) return false;
      let m; try { m = JSON.parse(text); } catch { return false; }
      if (!m || typeof m !== "object" || !Number.isInteger(m.id)) return false;
      const up = ++this.seq;
      this.asked.set(up, { send: client, id: m.id });
      this.sock.write(JSON.stringify({ ...m, id: up }) + "\0");
      return true;
    }
    /** @param {(text: string) => void} client */
    leave(client) {
      this.clients.delete(client);
      for (const [k, v] of this.asked) if (v.send === client) this.asked.delete(k);
      if (!this.clients.size) setTimeout(() => { if (!this.clients.size) this.close(); }, 30_000).unref();
    }
    close() {
      if (this.closed) return; this.closed = true;
      if (links.get(this.agent) === this) links.delete(this.agent);
      try { this.sock?.destroy(); } catch {}
      if (this.release) { const r = this.release; this.release = null; try { r(); } catch {} }
      for (const c of this.clients) { try { c("\0close"); } catch {} }
      this.clients.clear(); this.asked.clear();
    }
  }

  const agentOfToken = (/** @type {string} */ t) => (t ? byHash.get(sha(t)) || null : null);
  const bearer = (/** @type {http.IncomingMessage} */ req) => String(req.headers.authorization || "").replace(/^Bearer /, "");

  const start = () => listening || (listening = new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://x");
      const agent = agentOfToken(bearer(req));
      if (url.pathname !== "/cdp/json/version" || req.method !== "GET" || !agent) { res.writeHead(agent ? 404 : 401); return void res.end(); }
      const port = /** @type {any} */ (server?.address()).port;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/cdp/devtools/browser` }));
    });
    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url || "/", "http://x");
      const agent = agentOfToken(url.searchParams.get("token") || "");
      const key = req.headers["sec-websocket-key"];
      if (!agent || url.pathname !== "/cdp/devtools/browser" || !key || String(req.headers.upgrade).toLowerCase() !== "websocket") { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
      socket.write(upgradeHead(String(key)));
      attach(agent, socket, head);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(/** @type {any} */ (server?.address()).port));
  }));

  /** @param {string} agent @param {net.Socket} socket @param {Buffer} head */
  function attach(agent, socket, head) {
    let link = links.get(agent);
    if (!link || link.closed) { link = new Link(agent); links.set(agent, link); }
    const l = link;
    const send = (/** @type {string} */ text) => {
      if (text === "\0close") { try { socket.end(encodeFrame(Buffer.alloc(0), 0x8)); } catch {} return; }
      try { socket.write(encodeFrame(Buffer.from(text), 1)); } catch {}
    };
    l.clients.add(send);
    const parser = new FrameParser({ max: MAX_MSG });
    const onData = async (/** @type {Buffer} */ chunk) => {
      let frames; try { frames = parser.push(chunk); } catch { return void socket.destroy(); }
      try { await l.ready; } catch { log(`cdp: ${agent}'s Chrome could not be reached`); return void socket.destroy(); }
      for (const f of frames) {
        if ("control" in f) { if (f.control === "close") return void socket.destroy(); if (f.control === "ping") socket.write(encodeFrame(f.payload, 0xa)); continue; }
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
    /** Close an agent's link (its computer went to sleep or was reset): its clients see a close and reconnect through the endpoint. @param {string} agent */
    drop(agent) { const l = links.get(agent); if (l) l.close(); },
    async close() { for (const l of [...links.values()]) l.close(); if (server) await new Promise(r => /** @type {http.Server} */ (server).close(() => r(undefined))); },
  };
}
