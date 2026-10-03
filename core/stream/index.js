// @ts-check
// stream: the session stream as a module (ADR 0052). It listens to the switchboard's thread.* and
// ask.* events, maps them to frames (adapter.js), keeps one gapless log per session (log.js) in
// memory and in the module's own table, and serves them on the WebSocket
// /v1/streams/stream/session. One tool, stream.open, hands the screen a one-use ticket (30 s) and
// the log's head and floor, the same shape as term.open and Glass. Nothing polls: frames are sent
// the moment an event lands.
//
// The ticket is the whole authority, as for term: it is spent before the handshake completes.

import crypto from "node:crypto";
import { Logs } from "./log.js";
import { createAdapter, pipe } from "./adapter.js";
import { serveWS } from "./server.js";

export { SessionLog, Logs } from "./log.js";
export { serve, serveSSE, serveWS, HEARTBEAT_MS } from "./server.js";
export { connect, wsDuplex, sseDuplex, trim } from "./client.js";
export { createAdapter, pipe } from "./adapter.js";
export * from "./protocol.js";

const str = { type: "string" };
const int = { type: "integer" };
const obj = (/** @type {any} */ properties, required = []) => ({ type: "object", properties, required });
const PEOPLE = ["cli", "local", "deck", "capsule"];
const EVENTS = /^(thread\.|ask\.|term\.command$)/;

/** @param {import("node:net").Socket} socket @param {number} status @param {string} reason */
const reject = (socket, status, reason) => { try { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`); } catch {} };

/** @type {{ start(ctx: any): Promise<any> }} */
export default {
  async start(ctx) {
    const cfg = (ctx.config && ctx.config.stream) || {};
    const ticketMs = Number(cfg.ticketMs ?? 30_000);
    const now = () => Date.now();
    const logs = new Logs({ db: ctx.store && ctx.store.db, maxFrames: cfg.maxFrames, maxBytes: cfg.maxBytes });
    /** @type {Map<string, ReturnType<typeof createAdapter>>} */
    const adapters = new Map();
    /** @type {Map<string, { session: string, expires: number, from: number|null }>} */
    const tickets = new Map();
    const sockets = new Set();

    const off = ctx.events.on("*", (/** @type {any} */ e) => {
      if (!e || !e.thread || !EVENTS.test(e.type)) return;
      let ad = adapters.get(e.thread);
      if (!ad) { ad = createAdapter(); adapters.set(e.thread, ad); }
      try { pipe(logs.get(e.thread), ad, e); } catch (err) { ctx.log(`stream: ${e.type} for ${e.thread}: ${/** @type {Error} */ (err).message}`); }
      if (e.type === "thread.stopped") adapters.delete(e.thread);
    });

    ctx.tool("stream.open", {
      description: "A one-use ticket (30 s) for the session stream at path, resuming after cursor from (0 for everything the log holds). Also the log's head and floor: a from below floor will be sent a reset.",
      input: obj({ session: str, from: int }, ["session"]),
      callers: PEOPLE,
      run: async (/** @type {any} */ i) => {
        const session = String(i.session || "");
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(session)) { const e = /** @type {any} */ (new Error("session must be a thread id")); e.code = "bad_input"; throw e; }
        for (const [k, v] of tickets) if (v.expires <= now()) tickets.delete(k);
        const ticket = crypto.randomBytes(24).toString("base64url");
        const from = Number.isInteger(i.from) && i.from >= 0 ? i.from : null;
        tickets.set(ticket, { session, expires: now() + ticketMs, from });
        const log = logs.get(session);
        return { session, ticket, path: `/v1/streams/stream/session?ticket=${encodeURIComponent(ticket)}${from === null ? "" : `&from=${from}`}`, head: log.head, floor: log.floor };
      },
    });

    ctx.upgrade("session", (/** @type {any} */ req, /** @type {import("node:net").Socket} */ socket, /** @type {Buffer} */ head, /** @type {any} */ info) => {
      try {
        const url = (info && info.url) || new URL(req.url || "/", "http://vyred");
        const tk = url.searchParams.get("ticket") || "";
        const held = tickets.get(tk);
        tickets.delete(tk);
        if (!held || held.expires <= now()) { reject(socket, 403, "Forbidden"); return; }
        const q = url.searchParams.get("from");
        const n = q === null || q === "" ? NaN : Number(q);
        const from = Number.isInteger(n) && n >= 0 ? n : held.from ?? undefined;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        serveWS(logs.get(held.session), req, socket, head, from === undefined ? {} : { from });
      } catch { reject(socket, 400, "Bad Request"); }
    });

    return {
      logs,
      async stop() {
        off();
        for (const s of sockets) { try { s.destroy(); } catch {} }
        sockets.clear(); tickets.clear();
        logs.close();
      },
    };
  },
};
