// @ts-check
// terminal: the stream behind /v1/streams/computers/terminal. A person types into one of an agent's terminals (a tmux session in that agent's own computer account) and sees what
// it prints. The ticket was issued by computers.agent.terminal.open after the agents module said the person may edit the agent (a terminal types as the agent), spent here once, and
// names one agent and one session. The bytes travel to agentd's relay with a ticket of the relay's own (agentd-relay.js), which starts the terminal as that agent's uid.

import net from "node:net";
import { encodeFrame, FrameParser, upgradeHead } from "../../lib/ws.js";
import { closeWith } from "./glass.js";
import { scrub } from "../../lib/scrub.js";

export const TERMINAL_PREFIX = "terminal:";
const MAX_FRAME_OUT = 64 * 1024;

/** @param {import("node:net").Socket} socket @param {number} status @param {string} reason */
function reject(socket, status, reason) { try { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`); } catch {} }

export class Terminal {
  /** @param {{ pool: { redeem: (t: any) => any }, screen: { openTerminal: (agent: string, session: string) => Promise<{ host: string, port: number, hello: string, release: () => void }> }, log?: (m: string) => void }} deps */
  constructor({ pool, screen, log }) { this.pool = pool; this.screen = screen; this.log = log || (() => {}); }

  /** The upgrade handler index.js registers at ctx.upgrade("terminal", ...). Never throws. */
  handle(req, socket, head, info) {
    this.connect(req, socket, head, info).catch(e => { this.log(`terminal: ${scrub(e && e.message, [], { marker: "[redacted]", min: 1 })}`); try { socket.destroy(); } catch {} });
  }

  /** @param {any} req @param {import("node:net").Socket} socket @param {Buffer} head @param {{ url?: URL }} [info] */
  async connect(req, socket, head, info) {
    const url = (info && info.url) || new URL(req.url || "/", "http://vyred");
    const t = this.pool.redeem(url.searchParams.get("ticket"));
    if (!t || !t.perAgent || !String(t.surface).startsWith(TERMINAL_PREFIX)) return reject(socket, 403, "Forbidden");
    const key = req.headers && req.headers["sec-websocket-key"];
    if (String(req.headers && req.headers["upgrade"] || "").toLowerCase() !== "websocket" || !key) return reject(socket, 400, "Bad Request");
    socket.write(upgradeHead(key, ""));
    let closed = false, up = /** @type {import("node:net").Socket | null} */ (null), release = /** @type {(() => void) | null} */ (null);
    const closeAll = (/** @type {boolean} */ flush = false) => {
      if (closed) return; closed = true;
      if (release) { const r = release; release = null; try { r(); } catch {} }
      try { if (flush) socket.end(); else socket.destroy(); } catch {}
      if (up) try { up.destroy(); } catch {}
    };
    const parser = new FrameParser();
    /** @type {Buffer[]} */ const early = [];
    const fromBrowser = (/** @type {Buffer} */ chunk) => {
      if (closed) return;
      let frames;
      try { frames = parser.push(chunk); } catch { return closeAll(); }
      for (const f of frames) {
        if ("control" in f) { if (f.control === "close") return closeAll(); if (f.control === "ping") { try { socket.write(encodeFrame(f.payload, 0xa)); } catch {} } continue; }
        if (up && up.writable) up.write(f.message); else early.push(f.message);
      }
    };
    socket.on("data", fromBrowser); socket.on("close", () => closeAll()); socket.on("error", () => closeAll());
    if (head && head.length) fromBrowser(head);
    const session = String(t.surface).slice(TERMINAL_PREFIX.length);
    try {
      const target = await this.screen.openTerminal(t.agent, session);
      release = target.release;
      if (closed) { closeAll(); return; }
      up = net.connect(target.port, target.host);
      up.on("error", () => closeAll());
      up.on("close", () => { if (!closed) { closeWith(socket, 1000, ""); closeAll(true); } });
      up.write(target.hello);
      for (const m of early.splice(0)) up.write(m);
      up.on("data", b => { for (let i = 0; i < b.length; i += MAX_FRAME_OUT) { try { socket.write(encodeFrame(b.subarray(i, i + MAX_FRAME_OUT))); } catch { return closeAll(); } } });
    } catch (e) {
      closeWith(socket, 4001, String(/** @type {Error} */ (e).message).slice(0, 120));
      closeAll(true);
    }
  }
}
