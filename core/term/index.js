// @ts-check
// term: a terminal in the browser (ADR 0024, contract 4) that survives like mosh (ADR 0029 R4).
//
// term.open starts the user's login shell in a folder the files guard allows, and hands back a
// one-use ticket (30 s) for the WebSocket /v1/streams/term/pty, the same shape as Glass: the
// ticket is spent before the handshake completes, and a spent or stale one gets a 403. On the
// socket, binary frames are what the terminal prints; the browser sends text frames
// {"t":"in","d":"..."} (keys) and {"t":"size","cols":n,"rows":n}.
//
// Where the shell runs: under a holder (holder.js), a small node process of its own session that
// owns the pty and a 1 MB ring of what it printed, and listens on a unix socket in <home>/run/term
// (a private folder under /tmp when that path is too long for a socket). vyred talks to it over
// that socket (ring.js has the wire). A vyred restart or crash leaves every holder running; the
// next vyred finds them again from their sockets alone (each holder's INFO carries its folder,
// screen, owner key and start time) and term.attach works as before.
//
// Offsets: the holder counts every byte the terminal prints. A client that wants offsets asks
// with from=<offset> (on term.attach, or on the stream's URL; 0 for a new screen). It then gets,
// as text frames:
//   {"t":"cut","from":<oldest held>,"asked":<its from>}  when bytes after its offset have left the
//      ring; the replay that follows starts at the oldest byte held, at a line start
//   {"t":"at","offset":<n>, ...}  the offset after the last byte sent on this socket: once when the
//      replay is done (with cols, rows and owner, below), then at most once a second while output
//      flows. A client adopts it.
//   {"t":"size","cols":n,"rows":n,"owner":"you"|"other"|"none"}  the terminal's size changed hands
// and binary frames carry exactly the bytes after its offset, then everything new. A client
// without from= gets what it always got: the last 64 KB, binary frames only, no text frames.
//
// Size: one screen owns the terminal's size, the socket that last sent one. Others watch at the
// owner's size (the first "at" says so: owner "other") until they send a size of their own
// ("Take size" in the Deck). When the owner's socket goes, the rest hear owner "none".
//
// Keys typed while a client is disconnected are the client's to hold (up to 4 KB) and send after
// it reattaches; nothing queues input for a screen that is away.
//
// A client going away never ends a terminal. With no socket open the holder keeps it for
// term.keep_hours (12 h by default), then ends it. term.close ends it at once, and so does its
// shell exiting. vyred stopping closes its sockets with 1012 "restarting" and leaves the holders.
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
// term.closed carry the id, the folder and why, never content. The holder's socket carries it
// and nothing else does.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guard } from "../files/safety.js";
import { acceptKey, encodeFrame, FrameParser } from "../computers/ws.js";
import { size } from "./pty.js";
import { spawnHolder, dial } from "./holder.js";
import { T, frame, json } from "./ring.js";

const str = { type: "string" };
const int = { type: "integer" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const PEOPLE = ["cli", "local", "deck", "capsule"];
const SURFACE = /^(deck|phone|capsule|glass|cli):[A-Za-z0-9_-]{1,64}$/;
const ID = /^t_[0-9a-f]{12}$/;
/** A browser socket holding more than this unread makes the holder wait. */
const SLOW = 256 * 1024;

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

/** A non-negative integer offset, or null. */
const offsetOf = v => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
};

/**
 * Where holders put their sockets: <home>/run/term, or, when that is too long for a unix socket,
 * a folder under /tmp named by a hash of the home that only this user can open.
 * @param {string} root
 */
export function socketDir(root) {
  const near = path.join(root, "run", "term");
  const far = path.join(os.tmpdir(), `vyre-term-${crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16)}`);
  const dir = Buffer.byteLength(path.join(near, "t_000000000000.sock")) <= 100 ? near : far;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (typeof process.getuid === "function" && st.uid !== process.getuid())) throw new Error(`${dir} is not ours`);
  fs.chmodSync(dir, 0o700);
  return dir;
}

/**
 * One browser socket on a terminal, and its own attach connection to the holder.
 * @typedef {{ ws: import("node:net").Socket, h: import("node:net").Socket|null, aware: boolean, offset: number,
 *   replayEnd: number, announced: boolean, at: any, closed: boolean, bye: (code?: number, why?: string) => void }} Conn
 */
/**
 * @typedef {{ id: string, cwd: string, surface: string, key: string, started: number, pid: number, sock: string,
 *   ctl: import("node:net").Socket|null, cols: number, rows: number, sockets: Set<Conn>, owner: Conn|null, ended: boolean }} Term
 */

/** @type {{ start(ctx: any): Promise<any> }} */
export default {
  async start(ctx) {
    const cfg = (ctx.config && ctx.config.term) || {};
    const max = Number(cfg.max ?? 8);
    const scrollback = Number(cfg.scrollback ?? 64 * 1024);
    const ringCap = Number(cfg.ring ?? 1024 * 1024);
    const keepMs = Number(cfg.keepMs ?? cfg.endAfterMs ?? Number(cfg.keep_hours ?? 12) * 3600_000);
    const ticketMs = Number(cfg.ticketMs ?? 30_000);
    const shell = cfg.shell ? String(cfg.shell) : undefined;
    const login = cfg.login !== false;

    // The same roots and guard the files module builds, from the same config.
    const fcfg = (ctx.config && ctx.config.files) || {};
    const role = ctx.config && ctx.config.role === "box" ? "box" : "local";
    const roots = Array.isArray(fcfg.roots) && fcfg.roots.length ? fcfg.roots.map(String) : role === "box" ? ["/work"] : [os.homedir()];
    const g = guard({ roots, allowDot: Array.isArray(fcfg.allowDot) ? fcfg.allowDot : [], vyreHome: ctx.paths.root, vault: ctx.paths.vault });
    const dir = socketDir(ctx.paths.root);

    /** @type {Map<string, Term>} */
    const terms = new Map();
    /** @type {Map<string, { term: string, expires: number, from: number|null }>} */
    const tickets = new Map();
    let stopping = false;

    const emit = (type, payload) => { try { ctx.events.emit(type, payload); } catch {} };
    const now = () => Date.now();

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

    const view = t => ({ term: t.id, cwd: t.cwd, surface: t.surface, started: t.started, cols: t.cols, rows: t.rows, attached: t.sockets.size, durable: true });

    /** The terminal has ended (its holder said so, or went away): tell its sockets and the log. */
    const end = (t, reason) => {
      if (t.ended) return;
      t.ended = true;
      terms.delete(t.id);
      for (const [k, v] of tickets) if (v.term === t.id) tickets.delete(k);
      for (const c of t.sockets) c.bye(1000, reason);
      t.sockets.clear(); t.owner = null;
      try { t.ctl?.destroy(); } catch {}
      t.ctl = null;
      emit("term.closed", { term: t.id, reason });
    };

    /** vyred's control connection to a holder: it hears EXIT, and CLOSE goes out on it. @param {Term} t */
    const watch = async t => {
      const c = await dial(t.sock, { mode: "control" }, f => {
        if (f.type === T.EXIT) end(t, String((json(f.body) || {}).reason || "exited"));
      });
      t.ctl = c;
      c.on("error", () => {});
      // The holder went without a word (killed): the terminal is gone all the same.
      c.on("close", () => { if (!stopping && t.ctl === c) end(t, "exited"); });
    };

    /** The size and who owns it, as a Conn sees it. @param {Term} t @param {Conn} c */
    const ownerFor = (t, c) => (t.owner === c ? "you" : t.owner ? "other" : "none");
    const sendText = (c, m) => { if (c.aware && !c.closed) { try { c.ws.write(textFrame(m)); } catch {} } };
    /** Everyone hears the size and who owns it now. @param {Term} t */
    const sizeChanged = t => { for (const c of t.sockets) if (c.announced) sendText(c, { t: "size", cols: t.cols, rows: t.rows, owner: ownerFor(t, c) }); };

    /** Tell an offset-aware socket where it is: at most once a second while output flows. @param {Conn} c */
    const atSoon = c => {
      if (c.at || !c.aware) return;
      c.at = setTimeout(() => { c.at = null; sendText(c, { t: "at", offset: c.offset }); }, 1000);
      c.at.unref?.();
    };

    /** A holder that answers on sock, as a Term, or null. A socket nothing listens on is removed. */
    const adopt = async sock => {
      /** @type {any} */ let info;
      /** @type {import("node:net").Socket|null} */ let probe = null;
      try {
        info = await new Promise(resolve => {
          const timer = setTimeout(() => resolve(undefined), 2000);
          dial(sock, { mode: "control" }, f => { if (f.type === T.INFO) { clearTimeout(timer); resolve(json(f.body)); } }, 2000)
            .then(s => { probe = s; s.on("error", () => {}); s.write(frame(T.QUERY, "")); },
              e => { clearTimeout(timer); resolve(e && (e.code === "ECONNREFUSED" || e.code === "ENOENT") ? null : undefined); });
        });
      } finally { try { /** @type {any} */ (probe)?.destroy(); } catch {} }
      if (info === null) { try { fs.rmSync(sock, { force: true }); } catch {} return null; }
      const m = info && info.meta;
      if (!info || !ID.test(String(info.id)) || !m || typeof m.key !== "string" || typeof m.cwd !== "string") return null;
      /** @type {Term} */
      const t = { id: info.id, cwd: m.cwd, surface: String(m.surface || ""), key: m.key, started: Number(m.started) || now(), pid: Number(info.pid) || 0,
        sock, ctl: null, cols: Number(info.cols) || 80, rows: Number(info.rows) || 24, sockets: new Set(), owner: null, ended: false };
      try { await watch(t); } catch { return null; }
      return t;
    };

    // Terminals a previous vyred started and left running: pick them up again.
    for (const name of fs.readdirSync(dir)) {
      if (!/^t_[0-9a-f]{12}\.sock$/.test(name)) continue;
      const t = await adopt(path.join(dir, name)).catch(() => null);
      if (t && !t.ended) terms.set(t.id, t);
    }

    const tool = (name, description, input, run, extra = {}) => ctx.tool(name, { description, input, run, callers: PEOPLE, ...extra });

    tool("term.open", "Open a terminal: the user's login shell in a folder, on this machine. Returns a one-use ticket (30 s) for the stream at path. The terminal outlives a dropped connection and a vyred restart.",
      obj({ cwd: str, cols: int, rows: int, surface: str }, ["cwd", "surface"]), async (i, { caller, peer }) => {
        const surface = surfaceOf(i);
        const key = keyOf(caller, peer, surface);
        let cwd;
        try { cwd = g.resolveSafe(String(i.cwd)).real; }
        catch (e) { throw fail(/** @type {any} */ (e).code === "not_available" ? "not_available" : "bad_input", /** @type {Error} */ (e).message); }
        if (!fs.statSync(cwd).isDirectory()) throw fail("bad_input", "cwd must be a folder");
        if (terms.size >= max) throw fail("too_many", `${max} terminals are open; close one first`);
        if (stopping) throw fail("failed", "vyred is stopping");
        const { cols, rows } = size(i.cols, i.rows);
        const id = "t_" + crypto.randomBytes(6).toString("hex");
        const sock = path.join(dir, `${id}.sock`);
        const started = now();
        let h;
        try {
          h = await spawnHolder({ id, cwd, cols, rows, shell, login, sock, ring: ringCap, keepMs, meta: { cwd, surface, key, started } });
        } catch (e) { throw fail("failed", /** @type {Error} */ (e).message); }
        /** @type {Term} */
        const t = { id, cwd, surface, key, started, pid: h.pid, sock, ctl: null, cols, rows, sockets: new Set(), owner: null, ended: false };
        try { await watch(t); }
        catch (e) { try { process.kill(h.pid, "SIGTERM"); } catch {} throw fail("failed", /** @type {Error} */ (e).message); }
        terms.set(id, t);
        emit("term.opened", { term: id, cwd });
        return { ...issue(t), cwd, cols, rows, durable: true, offset: 0 };
      });

    tool("term.attach", "A fresh one-use ticket for a live terminal (after a reload, a dropped connection or a vyred restart), for the screen that opened it. With from, the stream replays exactly the bytes after that offset.",
      obj({ term: str, surface: str, from: int }, ["term", "surface"]), async (i, { caller, peer }) => {
        const surface = surfaceOf(i);
        const key = keyOf(caller, peer, surface);
        const t = terms.get(String(i.term));
        if (!t || t.key !== key) throw fail("not_found", "no such terminal on this screen");
        return { ...issue(t, offsetOf(i.from)), cwd: t.cwd, cols: t.cols, rows: t.rows, durable: true };
      });

    tool("term.list", "The live terminals: id, folder, the screen that opened it, when, size and open connections.",
      obj({}), async () => ({ terms: [...terms.values()].map(view) }));

    tool("term.close", "End a terminal and everything it started.",
      obj({ term: str }, ["term"]), async i => {
        const t = terms.get(String(i.term));
        if (!t) return { closed: false };
        try { t.ctl?.write(frame(T.CLOSE, "")); } catch {}
        // The holder answers with EXIT once the shell's session is gone; a holder that does not is ended by signal.
        for (let n = 0; n < 60 && !t.ended; n++) await new Promise(r => setTimeout(r, 50));
        if (!t.ended) {
          try { if (t.pid) process.kill(t.pid, "SIGTERM"); } catch {}
          end(t, "closed");
        }
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

        // The URL's from wins over the one given to term.attach.
        const from = url.searchParams.has("from") ? offsetOf(url.searchParams.get("from")) : held ? held.from : null;
        /** @type {Conn} */
        const c = { ws: socket, h: null, aware: from !== null, offset: from ?? 0, replayEnd: 0, announced: false, at: null, closed: false, bye: () => {} };
        t.sockets.add(c);
        /** Keys and sizes that arrive before the holder connection is up. @type {Buffer[]} */
        let early = [];

        const announce = () => {
          c.announced = true;
          sendText(c, { t: "at", offset: c.offset, cols: t.cols, rows: t.rows, owner: ownerFor(t, c) });
        };

        let missed = 0;
        const parser = new FrameParser();
        const pinger = setInterval(() => {
          if (missed >= 2) { done(); return; }
          missed += 1;
          try { socket.write(encodeFrame(Buffer.alloc(0), 0x9)); } catch { done(); }
        }, 30_000);
        pinger.unref();
        /** This socket is done. With a code it hears a close frame first (the socket goes once it is out, or 2 s). */
        const done = (code = 0, why = "") => {
          if (c.closed) return;
          c.closed = true;
          clearInterval(pinger);
          if (c.at) { clearTimeout(c.at); c.at = null; }
          t.sockets.delete(c);
          try { c.h?.destroy(); } catch {}
          if (code) {
            try { socket.end(closeFrame(code, why)); } catch {}
            const kill = setTimeout(() => { try { socket.destroy(); } catch {} }, code === 1012 ? 500 : 2000);
            kill.unref?.();
            socket.once("close", () => clearTimeout(kill));
          } else { try { socket.destroy(); } catch {} }
          if (t.owner === c) { t.owner = null; if (!t.ended && !stopping) sizeChanged(t); }
        };
        c.bye = done;
        const toHolder = b => { if (c.h) { try { c.h.write(b); } catch {} } else early.push(b); };

        dial(t.sock, from === null ? { mode: "attach", from: null, tail: scrollback } : { mode: "attach", from }, f => {
          if (c.closed) return;
          if (f.type === T.OUT) {
            c.offset += f.body.length;
            try { socket.write(encodeFrame(f.body)); } catch {}
            // A browser that cannot keep up (`yes` in a terminal) holds the holder back, and it the shell.
            if (socket.writableLength > SLOW) c.h?.pause();
            if (!c.announced) { if (c.offset >= c.replayEnd) announce(); }
            else atSoon(c);
          } else if (f.type === T.AT) {
            const m = json(f.body) || {};
            if (from !== null && m.cut) sendText(c, { t: "cut", from: m.from, asked: from });
            c.offset = Number(m.from) || 0;
            c.replayEnd = Number(m.end) || 0;
            if (Number(m.cols) && Number(m.rows)) { t.cols = Number(m.cols); t.rows = Number(m.rows); }
            if (c.offset >= c.replayEnd) announce();
          } else if (f.type === T.EXIT) {
            end(t, String((json(f.body) || {}).reason || "exited"));
          }
        }).then(h => {
          if (c.closed) { h.destroy(); return; }
          c.h = h;
          h.on("error", () => {});
          h.on("close", () => { if (!t.ended && !stopping) done(1011, "lost"); });
          for (const b of early) { try { h.write(b); } catch {} }
          early = [];
        }, () => done(1011, "lost"));

        const onData = chunk => {
          if (c.closed) return;
          let frames;
          try { frames = parser.push(chunk); } catch { done(); return; }
          for (const f of frames) {
            if ("control" in f) {
              if (f.control === "close") { done(1000); return; }
              if (f.control === "ping") { try { socket.write(encodeFrame(f.payload, 0xa)); } catch {} }
              if (f.control === "pong") missed = 0;
              continue;
            }
            if (f.opcode !== 1 || f.message.length > 256 * 1024) continue;
            let m;
            try { m = JSON.parse(f.message.toString("utf8")); } catch { continue; }
            if (m && m.t === "in" && typeof m.d === "string") toHolder(frame(T.IN, m.d));
            else if (m && m.t === "size") {
              // The screen that sent a size owns it; everyone else watches at that size.
              const s = size(m.cols, m.rows);
              t.cols = s.cols; t.rows = s.rows;
              t.owner = c;
              toHolder(frame(T.SIZE, s));
              sizeChanged(t);
            }
          }
        };
        socket.on("data", onData);
        socket.on("drain", () => { if (socket.writableLength <= SLOW) c.h?.resume(); });
        // vyred's server allows half-open sockets, so a browser that goes away may only send a FIN.
        socket.on("end", () => done());
        socket.on("close", () => done());
        socket.on("error", () => done());
        if (head && head.length) onData(head);
      } catch (e) {
        ctx.log(`term stream: ${/** @type {Error} */ (e).message}`);
        try { socket.destroy(); } catch {}
      }
    });

    return {
      terms,
      dir,
      durable: true,
      /** vyred is stopping: its sockets hear 1012 "restarting" and the holders are left for the next vyred. */
      async stop() {
        stopping = true;
        for (const t of terms.values()) {
          for (const c of t.sockets) c.bye(1012, "restarting");
          t.sockets.clear(); t.owner = null;
          try { t.ctl?.destroy(); } catch {}
          t.ctl = null;
        }
        terms.clear();
        tickets.clear();
      },
    };
  },
};
