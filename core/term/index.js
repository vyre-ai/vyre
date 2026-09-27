// @ts-check
// term: a terminal in the browser (ADR 0024, contract 4).
//
// term.open starts the user's login shell on a pty (pty.js) in a folder the files guard allows,
// and hands back a one-use ticket (30 s) for the WebSocket /v1/streams/term/pty, the same shape
// as Glass: the ticket is spent before the handshake completes, and a spent or stale one gets a
// 403. On the socket, binary frames are what the terminal prints; the browser sends text frames
// {"t":"in","d":"..."} (keys) and {"t":"size","cols":n,"rows":n}. A reload asks term.attach for a
// fresh ticket, and the last 64 KB of output is replayed so the screen comes back. When the last
// socket closes the terminal ends 10 s later unless something reattaches.
//
// Who may: only a person's surfaces (cli, local, deck, capsule; the owner's own Deck over the
// tailnet counts as deck, a tailnet guest never does), and only after proving presence once.
//
// Presence, the simplest design that keeps guests and other callers out: term.unlock is a
// presence tool (a passkey from the Deck, Touch ID or a terminal code on the Mac), so the registry
// runs it only with a fresh proof. What it records is a grant, in memory only, for 12 h, keyed by
// who asked: the caller label, the tailnet node the listener verified (when there is one) and the
// surface named in the input. term.open and term.attach look up the same key and refuse with
// code "unlock_required" when there is none, so the Deck proves presence only when told to. The
// node in the key is what makes the grant a device's: the owner's phone unlocking cannot open a
// shell for the owner's laptop. A restart forgets every grant, which is the safe direction.
//
// Nothing a terminal prints is written to the event log or vyred's log; term.opened and
// term.closed carry the id, the folder and why, never content.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { guard } from "../files/safety.js";
import { acceptKey, encodeFrame, FrameParser } from "../computers/ws.js";
import { Pty, size } from "./pty.js";

const str = { type: "string" };
const int = { type: "integer" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const PEOPLE = ["cli", "local", "deck", "capsule"];
const SURFACE = /^(deck|phone|capsule|glass|cli):[A-Za-z0-9_-]{1,64}$/;
const HOUR = 3_600_000;

/** An error with a code the registry passes through to the caller. */
function fail(code, message) {
  const e = /** @type {Error & { code?: string }} */ (new Error(message));
  e.code = code;
  return e;
}

const token = () => crypto.randomBytes(24).toString("base64url");

/** @param {import("node:net").Socket} socket @param {number} status @param {string} reason */
function reject(socket, status, reason) {
  try { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`); } catch {}
}

/** A close frame with a status code, so the browser can tell a clean end from a drop. */
const closeFrame = (code, why = "") => encodeFrame(Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(why.slice(0, 100))]), 0x8);

/**
 * @typedef {{ id: string, cwd: string, surface: string, key: string, pty: Pty, started: number,
 *   sockets: Set<import("node:net").Socket>, ring: Buffer[], ringBytes: number, idle: any, ended: boolean }} Term
 */

/** @type {{ start(ctx: any): Promise<any> }} */
export default {
  async start(ctx) {
    const cfg = (ctx.config && ctx.config.term) || {};
    const max = Number(cfg.max ?? 8);
    const scrollback = Number(cfg.scrollback ?? 64 * 1024);
    const endAfterMs = Number(cfg.endAfterMs ?? 10_000);
    const grantMs = Number(cfg.grantMs ?? 12 * HOUR);
    const ticketMs = Number(cfg.ticketMs ?? 30_000);
    const shell = cfg.shell ? String(cfg.shell) : undefined;
    const login = cfg.login !== false;

    // The same roots and guard the files module builds, from the same config.
    const fcfg = (ctx.config && ctx.config.files) || {};
    const role = ctx.config && ctx.config.role === "box" ? "box" : "local";
    const roots = Array.isArray(fcfg.roots) && fcfg.roots.length ? fcfg.roots.map(String) : role === "box" ? ["/work"] : [os.homedir()];
    const g = guard({ roots, allowDot: Array.isArray(fcfg.allowDot) ? fcfg.allowDot : [], vyreHome: ctx.paths.root, vault: ctx.paths.vault });

    /** @type {Map<string, number>} grant key -> until */
    const grants = new Map();
    /** @type {Map<string, Term>} */
    const terms = new Map();
    /** @type {Map<string, { term: string, expires: number }>} */
    const tickets = new Map();
    let stopping = false;

    const emit = (type, payload) => { try { ctx.events.emit(type, payload); } catch {} };
    const now = () => Date.now();

    const surfaceOf = input => {
      const s = String(input.surface || "");
      if (!SURFACE.test(s)) throw fail("bad_input", "surface must name this screen, such as deck:<device> or phone:<device>");
      return s;
    };
    /** Who is asking, as precisely as vyred verified it: caller, tailnet node, surface. */
    const keyOf = (caller, peer, surface) => `${String(caller || "")}|${peer && peer.stableId ? String(peer.stableId) : peer && peer.node ? String(peer.node) : ""}|${surface}`;
    const granted = key => {
      const until = grants.get(key);
      if (until && until > now()) return true;
      grants.delete(key);
      return false;
    };
    const needGrant = key => {
      if (!granted(key)) throw fail("unlock_required", "prove you are here to open a terminal from this screen (term.unlock)");
    };

    const issue = t => {
      for (const [k, v] of tickets) if (v.expires <= now()) tickets.delete(k);
      const ticket = token();
      tickets.set(ticket, { term: t.id, expires: now() + ticketMs });
      return { term: t.id, ticket, path: `/v1/streams/term/pty?ticket=${encodeURIComponent(ticket)}` };
    };

    const view = t => ({ term: t.id, cwd: t.cwd, surface: t.surface, started: t.started, cols: t.pty.cols, rows: t.pty.rows, attached: t.sockets.size });

    /** End a terminal: its sockets get a close frame, its shell's session a hang-up then a kill. */
    const end = async (t, reason) => {
      if (t.ended) return;
      t.ended = true;
      if (t.idle) { clearTimeout(t.idle); t.idle = null; }
      terms.delete(t.id);
      for (const [k, v] of tickets) if (v.term === t.id) tickets.delete(k);
      // A close frame with the reason, then the socket, once the frame is out (or 2 s, whichever first).
      for (const s of t.sockets) {
        try { s.end(closeFrame(1000, reason)); } catch {}
        const kill = setTimeout(() => { try { s.destroy(); } catch {} }, 2000);
        kill.unref?.();
        s.once("close", () => clearTimeout(kill));
      }
      t.sockets.clear();
      t.ring = []; t.ringBytes = 0;
      emit("term.closed", { term: t.id, reason });
      await t.pty.close();
    };

    /** No socket is open: end the terminal after endAfterMs unless one opens first. */
    const idleSoon = (t, extra = 0) => {
      if (t.idle) clearTimeout(t.idle);
      t.idle = setTimeout(() => { t.idle = null; if (!t.sockets.size) end(t, "detached"); }, endAfterMs + extra);
      t.idle.unref?.();
    };

    const output = (t, b) => {
      t.ring.push(b); t.ringBytes += b.length;
      while (t.ringBytes > scrollback && t.ring.length > 1) t.ringBytes -= /** @type {Buffer} */ (t.ring.shift()).length;
      if (t.ringBytes > scrollback) { t.ring[0] = t.ring[0].subarray(t.ringBytes - scrollback); t.ringBytes = scrollback; }
      if (!t.sockets.size) return;
      const frame = encodeFrame(b);
      let slow = false;
      for (const s of t.sockets) { try { s.write(frame); if (s.writableLength > 256 * 1024) slow = true; } catch {} }
      // A browser that cannot keep up (`yes` in a terminal) holds the shell back instead of vyred's memory.
      if (slow) t.pty.child.stdout?.pause();
    };

    const tool = (name, description, input, run, extra = {}) => ctx.tool(name, { description, input, run, callers: PEOPLE, ...extra });

    tool("term.unlock", "Prove you are here so this screen may open terminals for the next 12 hours.",
      obj({ surface: str }, ["surface"]), async (i, { caller, peer }) => {
        const surface = surfaceOf(i);
        const until = now() + grantMs;
        grants.set(keyOf(caller, peer, surface), until);
        return { surface, until };
      }, { presence: { summary: () => "Open terminals on this machine from this screen for 12 hours" } });

    tool("term.open", "Open a terminal: the user's login shell in a folder, on this machine. Needs term.unlock from the same screen first (code unlock_required). Returns a one-use ticket (30 s) for the stream at path.",
      obj({ cwd: str, cols: int, rows: int, surface: str }, ["cwd", "surface"]), async (i, { caller, peer }) => {
        const surface = surfaceOf(i);
        const key = keyOf(caller, peer, surface);
        needGrant(key);
        let dir;
        try { dir = g.resolveSafe(String(i.cwd)).real; }
        catch (e) { throw fail(/** @type {any} */ (e).code === "not_available" ? "not_available" : "bad_input", /** @type {Error} */ (e).message); }
        if (!fs.statSync(dir).isDirectory()) throw fail("bad_input", "cwd must be a folder");
        if (terms.size >= max) throw fail("too_many", `${max} terminals are open; close one first`);
        if (stopping) throw fail("failed", "vyred is stopping");
        const { cols, rows } = size(i.cols, i.rows);
        const id = "t_" + crypto.randomBytes(6).toString("hex");
        /** @type {Term} */
        const t = { id, cwd: dir, surface, key, started: now(), sockets: new Set(), ring: [], ringBytes: 0, idle: null, ended: false, pty: /** @type {any} */ (null) };
        t.pty = new Pty({ cwd: dir, cols, rows, shell, login, onData: b => output(t, b), onExit: () => { end(t, "exited"); } });
        terms.set(id, t);
        // Never attached: the ticket's life, then the usual grace.
        idleSoon(t, ticketMs);
        emit("term.opened", { term: id, cwd: dir });
        return { ...issue(t), cwd: dir, cols, rows };
      });

    tool("term.attach", "A fresh one-use ticket for a live terminal (after a reload or a dropped connection), for the screen that opened it.",
      obj({ term: str, surface: str }, ["term", "surface"]), async (i, { caller, peer }) => {
        const surface = surfaceOf(i);
        const key = keyOf(caller, peer, surface);
        needGrant(key);
        const t = terms.get(String(i.term));
        if (!t || t.key !== key) throw fail("not_found", "no such terminal on this screen");
        if (!t.sockets.size) idleSoon(t, ticketMs);
        return { ...issue(t), cwd: t.cwd, cols: t.pty.cols, rows: t.pty.rows };
      });

    tool("term.list", "The live terminals: id, folder, the screen that opened it, when, size and open connections.",
      obj({}), async () => ({ terms: [...terms.values()].map(view) }));

    tool("term.close", "End a terminal and everything it started.",
      obj({ term: str }, ["term"]), async i => {
        const t = terms.get(String(i.term));
        if (!t) return { closed: false };
        await end(t, "closed");
        return { closed: true };
      });

    /** The WebSocket at /v1/streams/term/pty. The ticket is the whole authority, as for Glass. */
    ctx.upgrade("pty", (req, socket, head, info) => {
      try {
        const url = (info && info.url) || new URL(req.url || "/", "http://vyred");
        const tk = url.searchParams.get("ticket") || "";
        const held = tickets.get(tk);
        tickets.delete(tk);
        const t = held && held.expires > now() ? terms.get(held.term) : null;
        if (!t) { reject(socket, 403, "Forbidden"); return; }
        const key = req.headers && req.headers["sec-websocket-key"];
        const upgrade = req.headers && String(req.headers["upgrade"] || "").toLowerCase();
        if (upgrade !== "websocket" || !key) { reject(socket, 400, "Bad Request"); return; }
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
        socket.setNoDelay?.(true);
        if (t.idle) { clearTimeout(t.idle); t.idle = null; }
        t.sockets.add(socket);
        if (t.ringBytes) { try { socket.write(encodeFrame(Buffer.concat(t.ring))); } catch {} }

        let closed = false, missed = 0;
        const parser = new FrameParser();
        const pinger = setInterval(() => {
          if (missed >= 2) { done(); return; }
          missed += 1;
          try { socket.write(encodeFrame(Buffer.alloc(0), 0x9)); } catch { done(); }
        }, 30_000);
        pinger.unref();
        const done = () => {
          if (closed) return;
          closed = true;
          clearInterval(pinger);
          t.sockets.delete(socket);
          try { socket.destroy(); } catch {}
          if (!t.ended && !t.sockets.size) { t.pty.child.stdout?.resume(); idleSoon(t); }
        };
        const onData = chunk => {
          if (closed) return;
          let frames;
          try { frames = parser.push(chunk); } catch { done(); return; }
          for (const f of frames) {
            if ("control" in f) {
              if (f.control === "close") { try { socket.write(closeFrame(1000)); } catch {} done(); return; }
              if (f.control === "ping") { try { socket.write(encodeFrame(f.payload, 0xa)); } catch {} }
              if (f.control === "pong") missed = 0;
              continue;
            }
            if (f.opcode !== 1 || f.message.length > 256 * 1024) continue;
            let m;
            try { m = JSON.parse(f.message.toString("utf8")); } catch { continue; }
            if (m && m.t === "in" && typeof m.d === "string") t.pty.write(m.d);
            else if (m && m.t === "size") t.pty.resize(m.cols, m.rows);
          }
        };
        socket.on("data", onData);
        socket.on("drain", () => { if ([...t.sockets].every(s => s.writableLength <= 256 * 1024)) t.pty.child.stdout?.resume(); });
        // vyred's server allows half-open sockets, so a browser that goes away may only send a FIN.
        socket.on("end", done);
        socket.on("close", done);
        socket.on("error", done);
        if (head && head.length) onData(head);
      } catch (e) {
        ctx.log(`term stream: ${/** @type {Error} */ (e).message}`);
        try { socket.destroy(); } catch {}
      }
    });

    return {
      terms, grants,
      async stop() {
        stopping = true;
        await Promise.all([...terms.values()].map(t => end(t, "stopped")));
        tickets.clear();
        grants.clear();
      },
    };
  },
};
