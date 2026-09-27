// @ts-check
// term: a terminal in the browser (ADR 0024, contract 4) that survives like mosh (ADR 0029, R4).
//
// term.open starts the user's login shell in a folder the files guard allows, and hands back a
// one-use ticket (30 s) for the WebSocket /v1/streams/term/pty, the same shape as Glass: the
// ticket is spent before the handshake completes, and a spent or stale one gets a 403. On the
// socket, binary frames are what the terminal prints; the browser sends text frames
// {"t":"in","d":"..."} (keys) and {"t":"size","cols":n,"rows":n}.
//
// Where the shell runs: under a dtach master (dtach.js) when dtach is on the PATH (the box), so it
// outlives a vyred restart. The next vyred finds it again from <home>/run/term/terms.json (id,
// folder, screen, owner key, byte count, master pid, socket) and term.attach works as before. With
// no dtach (a Mac, CI) it is a plain pty (pty.js) that ends with vyred. term.open, term.attach and
// term.list say which with `durable`.
//
// Offsets: the box counts every byte the terminal prints (ring.js), and keeps the newest 1 MB,
// trimmed only at line ends. A client that wants offsets asks for them with from=<offset> (on
// term.attach, or on the stream's URL; 0 for a new terminal). It then gets, as text frames:
//   {"t":"cut","from":<oldest held>,"asked":<its from>}  when bytes after its offset have left the
//      ring; the replay that follows starts at the oldest byte held
//   {"t":"at","offset":<n>}  the offset after the last byte sent: once after the replay, then at
//      most once a second while output flows. It is the box's count; a client adopts it.
// and binary frames carry exactly the bytes after its offset, then everything new. A client
// without from= gets what it always got: the last 64 KB, binary frames only, no text frames.
// Output while vyred is down (a restart) is lost; the count carries on from where vyred left it.
//
// Keys typed while the client is disconnected are the client's to hold (up to 4 KB) and send as
// {"t":"in"} after it reattaches; the box never queues input for a screen that is away.
//
// A client going away never ends a terminal. With no socket open it is kept for term.keep_hours
// (12 h by default), then ended. term.close ends it at once, and so does its shell exiting.
//
// Who may: only a person's surfaces (cli, local, deck, capsule; the owner's own Deck over the
// tailnet counts as deck, a tailnet guest never does). No passkey: opening a terminal is the
// owner's own action on their own screen, and Vyre does not nag (ADR 0024). Models, agents and
// guests are kept out by the caller allowlist, and a model's shell naming term.open by the
// harness floor (core/presence PERSON_ONLY).
//
// A terminal belongs to the screen that opened it: the caller label, the tailnet node the
// listener verified (when there is one) and the surface named in the input. term.attach from any
// other screen is not_found, so the owner's phone cannot pick up the shell open on their laptop.
//
// Nothing a terminal prints is written to the event log, vyred's log or the disk; term.opened and
// term.closed carry the id, the folder and why, never content. terms.json holds no output.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guard } from "../files/safety.js";
import { acceptKey, encodeFrame, FrameParser } from "../computers/ws.js";
import { Pty, size } from "./pty.js";
import { DtachPty, findDtach, isMaster, socketDir } from "./dtach.js";
import { Ring } from "./ring.js";

const str = { type: "string" };
const int = { type: "integer" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const PEOPLE = ["cli", "local", "deck", "capsule"];
/** How long a terminal lost to a box update still answers terminal_closed, not not_found. */
const GONE_MS = 24 * 60 * 60 * 1000;
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
const textFrame = m => encodeFrame(Buffer.from(JSON.stringify(m)), 0x1);

/** A byte offset a client sent, or null when it sent none (or nonsense). */
const offsetOf = v => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

/**
 * @typedef {{ id: string, cwd: string, surface: string, key: string, pty: any, started: number, durable: boolean,
 *   sock: string, sockets: Set<import("node:net").Socket>, aware: Set<import("node:net").Socket>, ring: Ring,
 *   idle: any, at: any, left: number|null, ended: boolean }} Term
 */

/** @type {{ start(ctx: any): Promise<any> }} */
export default {
  async start(ctx) {
    const cfg = (ctx.config && ctx.config.term) || {};
    const max = Number(cfg.max ?? 8);
    const scrollback = Number(cfg.scrollback ?? 64 * 1024);
    const ringCap = Number(cfg.ring ?? 1024 * 1024);
    const keepMs = Math.max(0, Number(cfg.keep_hours ?? 12)) * HOUR;
    const ticketMs = Number(cfg.ticketMs ?? 30_000);
    const shell = cfg.shell ? String(cfg.shell) : undefined;
    const login = cfg.login !== false;
    const dtach = findDtach();

    // The same roots and guard the files module builds, from the same config.
    const fcfg = (ctx.config && ctx.config.files) || {};
    const role = ctx.config && ctx.config.role === "box" ? "box" : "local";
    const roots = Array.isArray(fcfg.roots) && fcfg.roots.length ? fcfg.roots.map(String) : role === "box" ? ["/work"] : [os.homedir()];
    const g = guard({ roots, allowDot: Array.isArray(fcfg.allowDot) ? fcfg.allowDot : [], vyreHome: ctx.paths.root, vault: ctx.paths.vault });

    /** @type {Map<string, Term>} */
    const terms = new Map();
    /** @type {Map<string, { term: string, expires: number, from: number|null }>} */
    const tickets = new Map();
    let stopping = false;

    const emit = (type, payload) => { try { ctx.events.emit(type, payload); } catch {} };
    const now = () => Date.now();

    // The table of durable terminals, so the next vyred can find them. It holds no output.
    const runDir = path.join(ctx.paths.root, "run", "term");
    const tableFile = path.join(runDir, "terms.json");
    let saveTimer = null;
    /**
     * Terminals a previous vyred left whose shell is gone (the container was recreated by a deploy,
     * or the machine restarted): kept a day so their screen hears why, not a bare not_found.
     * @type {Map<string, { key: string, at: number }>}
     */
    const gone = new Map();
    const save = () => {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      const rows = [...terms.values()].filter(t => t.durable && !t.ended).map(t => ({
        id: t.id, cwd: t.cwd, surface: t.surface, key: t.key, offset: t.ring.end, started: t.started,
        pid: t.pty.pid, sock: t.sock, left: t.sockets.size && !stopping ? null : t.left ?? now(), cols: t.pty.cols, rows: t.pty.rows,
      }));
      try {
        fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
        const tmp = `${tableFile}.${process.pid}.tmp`;
        const lost = [...gone.entries()].map(([id, g]) => ({ id, key: g.key, at: g.at }));
        fs.writeFileSync(tmp, JSON.stringify({ terms: rows, gone: lost }), { mode: 0o600 });
        fs.renameSync(tmp, tableFile);
      } catch (e) { ctx.log(`term table: ${/** @type {Error} */ (e).message}`); }
    };
    /** The byte count moves with every output; write it down within 5 s, not on every chunk. */
    const saveSoon = () => {
      if (saveTimer) return;
      saveTimer = setTimeout(save, 5000);
      saveTimer.unref?.();
    };

    const surfaceOf = input => {
      const s = String(input.surface || "");
      if (!SURFACE.test(s)) throw fail("bad_input", "surface must name this screen, such as deck:<device> or phone:<device>");
      return s;
    };
    /** Which screen is asking, as precisely as vyred verified it: caller, tailnet node, surface. */
    const keyOf = (caller, peer, surface) => `${String(caller || "")}|${peer && peer.stableId ? String(peer.stableId) : peer && peer.node ? String(peer.node) : ""}|${surface}`;

    const issue = (t, from = null) => {
      for (const [k, v] of tickets) if (v.expires <= now()) tickets.delete(k);
      const ticket = token();
      tickets.set(ticket, { term: t.id, expires: now() + ticketMs, from });
      const q = from === null ? "" : `&from=${from}`;
      return { term: t.id, ticket, path: `/v1/streams/term/pty?ticket=${encodeURIComponent(ticket)}${q}` };
    };

    const view = t => ({ term: t.id, cwd: t.cwd, surface: t.surface, started: t.started, cols: t.pty.cols, rows: t.pty.rows,
      attached: t.sockets.size, durable: t.durable, offset: t.ring.end });

    /** End a terminal: its sockets get a close frame, its shell's session a hang-up then a kill. */
    const end = async (t, reason) => {
      if (t.ended) return;
      t.ended = true;
      if (t.idle) { clearTimeout(t.idle); t.idle = null; }
      if (t.at) { clearTimeout(t.at); t.at = null; }
      terms.delete(t.id);
      for (const [k, v] of tickets) if (v.term === t.id) tickets.delete(k);
      // A close frame with the reason, then the socket, once the frame is out (or 2 s, whichever first).
      for (const s of t.sockets) {
        try { s.end(closeFrame(1000, reason)); } catch {}
        const kill = setTimeout(() => { try { s.destroy(); } catch {} }, 2000);
        kill.unref?.();
        s.once("close", () => clearTimeout(kill));
      }
      t.sockets.clear(); t.aware.clear();
      t.ring.clear();
      if (t.durable && !stopping) save();
      emit("term.closed", { term: t.id, reason });
      await t.pty.close();
    };

    /** No socket is open: end the terminal after `ms` unless one opens first. */
    const idleSoon = (t, ms = keepMs) => {
      if (t.idle) clearTimeout(t.idle);
      t.idle = setTimeout(() => { t.idle = null; if (!t.sockets.size) end(t, "detached"); }, Math.max(0, Math.min(ms, 2 ** 31 - 1)));
      t.idle.unref?.();
    };

    /** Tell offset-aware clients where they are: at most once a second while output flows. */
    const atSoon = t => {
      if (t.at || !t.aware.size) return;
      t.at = setTimeout(() => {
        t.at = null;
        const f = textFrame({ t: "at", offset: t.ring.end });
        for (const s of t.aware) { try { s.write(f); } catch {} }
      }, 1000);
      t.at.unref?.();
    };

    const output = (t, b) => {
      t.ring.push(b);
      if (t.durable) saveSoon();
      if (!t.sockets.size) return;
      const frame = encodeFrame(b);
      let slow = false;
      for (const s of t.sockets) { try { s.write(frame); if (s.writableLength > 256 * 1024) slow = true; } catch {} }
      // A browser that cannot keep up (`yes` in a terminal) holds the shell back instead of vyred's memory.
      if (slow) t.pty.pause();
      atSoon(t);
    };

    /** @returns {Term} */
    const blank = (id, cwd, surface, key, started, offset, durable, sock) => ({
      id, cwd, surface, key, started, durable, sock, sockets: new Set(), aware: new Set(), ring: new Ring(ringCap, offset),
      idle: null, at: null, left: now(), ended: false, pty: null,
    });

    // Pick up the durable terminals a previous vyred left running.
    let table = [], lostBefore = [];
    try { const f = JSON.parse(fs.readFileSync(tableFile, "utf8")); table = f.terms || []; lostBefore = f.gone || []; } catch {}
    for (const g of Array.isArray(lostBefore) ? lostBefore : []) {
      if (g && typeof g.id === "string" && typeof g.key === "string" && now() - Number(g.at) < GONE_MS) gone.set(g.id, { key: g.key, at: Number(g.at) });
    }
    /** A shell the box lost while vyred was down: say so once, on the log every screen replays. */
    const lost = row => {
      gone.set(row.id, { key: String(row.key), at: now() });
      emit("term.closed", { term: row.id, reason: "box updated" });
    };
    for (const row of Array.isArray(table) ? table : []) {
      if (!row || typeof row.id !== "string" || typeof row.sock !== "string") continue;
      if (!fs.existsSync(row.sock)) { lost(row); continue; }
      if (!(await isMaster(Number(row.pid), row.sock))) { try { fs.unlinkSync(row.sock); } catch {} lost(row); continue; }
      const t = blank(row.id, String(row.cwd), String(row.surface), String(row.key), Number(row.started) || now(), offsetOf(row.offset) ?? 0, true, row.sock);
      t.left = Number(row.left) || now();
      t.pty = new DtachPty({ sock: row.sock, cols: row.cols, rows: row.rows, adopt: { pid: Number(row.pid) }, onData: b => output(t, b), onExit: () => { end(t, "exited"); } });
      terms.set(t.id, t);
      idleSoon(t, t.left + keepMs - now());
    }
    await Promise.all([...terms.values()].map(t => t.pty.ready));
    save();

    const tool = (name, description, input, run, extra = {}) => ctx.tool(name, { description, input, run, callers: PEOPLE, ...extra });

    tool("term.open", "Open a terminal: the user's login shell in a folder, on this machine. Returns a one-use ticket (30 s) for the stream at path, and whether the shell outlives a vyred restart (durable).",
      obj({ cwd: str, cols: int, rows: int, surface: str }, ["cwd", "surface"]), async (i, { caller, peer }) => {
        const surface = surfaceOf(i);
        const key = keyOf(caller, peer, surface);
        let dir;
        try { dir = g.resolveSafe(String(i.cwd)).real; }
        catch (e) { throw fail(/** @type {any} */ (e).code === "not_available" ? "not_available" : "bad_input", /** @type {Error} */ (e).message); }
        if (!fs.statSync(dir).isDirectory()) throw fail("bad_input", "cwd must be a folder");
        if (terms.size >= max) throw fail("too_many", `${max} terminals are open; close one first`);
        if (stopping) throw fail("failed", "vyred is stopping");
        const { cols, rows } = size(i.cols, i.rows);
        const id = "t_" + crypto.randomBytes(6).toString("hex");
        const durable = Boolean(dtach);
        const sock = durable ? path.join(socketDir(ctx.paths.root), `${id}.sock`) : "";
        const t = blank(id, dir, surface, key, now(), 0, durable, sock);
        const hooks = { onData: b => output(t, b), onExit: () => { end(t, "exited"); } };
        t.pty = durable
          ? new DtachPty({ bin: dtach, sock, cwd: dir, cols, rows, shell, login, ...hooks })
          : new Pty({ cwd: dir, cols, rows, shell, login, ...hooks });
        terms.set(id, t);
        // Never attached: the ticket's life, then the usual keep.
        idleSoon(t, keepMs + ticketMs);
        if (durable) save();
        emit("term.opened", { term: id, cwd: dir });
        return { ...issue(t), cwd: dir, cols, rows, durable, offset: 0 };
      });

    tool("term.attach", "A fresh one-use ticket for a live terminal (after a reload, a dropped connection or a vyred restart), for the screen that opened it. With from, the stream replays exactly the bytes after that offset.",
      obj({ term: str, surface: str, from: int }, ["term", "surface"]), async (i, { caller, peer }) => {
        const surface = surfaceOf(i);
        const key = keyOf(caller, peer, surface);
        const t = terms.get(String(i.term));
        const g = !t && gone.get(String(i.term));
        if (g && g.key === key) throw fail("terminal_closed", "the box was updated and this terminal was closed; open a new one");
        if (!t || t.key !== key) throw fail("not_found", "no such terminal on this screen");
        if (!t.sockets.size) idleSoon(t, keepMs + ticketMs);
        return { ...issue(t, offsetOf(i.from)), cwd: t.cwd, cols: t.pty.cols, rows: t.pty.rows, durable: t.durable, offset: t.ring.end, oldest: t.ring.start };
      });

    tool("term.list", "The live terminals: id, folder, the screen that opened it, when, size, open connections, bytes printed and whether each outlives a vyred restart.",
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
        t.left = null;

        // The replay. The URL's from wins over the one given to term.attach.
        const from = url.searchParams.has("from") ? offsetOf(url.searchParams.get("from")) : held ? held.from : null;
        try {
          if (from === null) {
            if (t.ring.bytes) socket.write(encodeFrame(t.ring.tail(scrollback)));
          } else {
            t.aware.add(socket);
            // A client ahead of the box (vyred restarted before it wrote its count down) has nothing to
            // replay; the "at" below tells it the box's count.
            if (from < t.ring.start) socket.write(textFrame({ t: "cut", from: t.ring.start, asked: from }));
            const b = t.ring.since(Math.min(from, t.ring.end));
            for (let i = 0; i < b.length; i += 64 * 1024) socket.write(encodeFrame(b.subarray(i, i + 64 * 1024)));
            socket.write(textFrame({ t: "at", offset: t.ring.end }));
          }
        } catch {}

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
          t.sockets.delete(socket); t.aware.delete(socket);
          try { socket.destroy(); } catch {}
          if (!t.ended && !t.sockets.size) {
            t.pty.resume();
            t.left = now();
            if (t.durable) save();
            idleSoon(t);
          }
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
        socket.on("drain", () => { if ([...t.sockets].every(s => s.writableLength <= 256 * 1024)) t.pty.resume(); });
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
      terms,
      durable: Boolean(dtach),
      /** vyred is stopping: durable terminals are let go of for the next vyred, the rest end. */
      async stop() {
        stopping = true;
        const live = [...terms.values()];
        for (const t of live) if (t.durable && t.sockets.size) t.left = now();
        save();
        await Promise.all(live.map(async t => {
          if (!t.durable) return end(t, "stopped");
          if (t.idle) { clearTimeout(t.idle); t.idle = null; }
          if (t.at) { clearTimeout(t.at); t.at = null; }
          for (const s of t.sockets) { try { s.end(closeFrame(1012, "restarting")); } catch {} setTimeout(() => { try { s.destroy(); } catch {} }, 500).unref?.(); }
          t.sockets.clear(); t.aware.clear();
          t.ended = true;
          t.pty.detach();
        }));
        terms.clear();
        tickets.clear();
      },
    };
  },
};
