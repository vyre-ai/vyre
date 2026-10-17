// @ts-check
// agentd-relay: the way a viewer reaches ONE agent's screen. An agent's screen is a unix socket in that agent's own 0700 folder, so only that uid can open it. The relay listens on one
// TCP port inside the computer; a connection says nothing but a ticket, and the ticket (which vyred registered through the authenticated agentd channel, single use, short life) names the
// agent. The relay then starts agentd-pipe.py AS that agent's uid, which opens that uid's own socket and nothing else, and joins the connection to it. A connection with no good ticket within
// a few seconds is closed without a byte; the ticket, once spent, is gone. Only vyred's address (the pin computerd keeps) may connect at all. A computer is never published to the host
// (driver/policy.js refuses PortBindings), so this port is reachable on the computers' own network only. With the pin an agent cannot even connect, so it cannot hold the 16 pending slots; if the pin were ever wrong, the worst a holder does is deny viewers for 3 s at a time, never gain access.

import net from "node:net";
import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import { asAgent, asBrowser, browserOf, validateRun, RUN_ARGV_BYTES } from "./agentd.js";

export const RELAY_PORT = 5910;
/** The address vyred has, written by computerd when it pins it (computerd/peer-file.js). */
export const PEER_FILE = "/var/lib/vyre/vyred-peer";
const plain = (/** @type {unknown} */ a) => String(a || "").replace(/^::ffff:/, "");
export const peerFromFile = (/** @type {string} */ file = PEER_FILE) => () => { try { return fs.readFileSync(file, "utf8").trim() || null; } catch { return null; } };
export const PIPE = "/opt/agentd/agentd-pipe.py";
export const TERM = "/opt/agentd/agentd-term.py";
export const RUN = "/opt/agentd/agentd-run.py";
export const KINDS = Object.freeze(["vnc", "cdp", "term", "run"]);
export const SESSION_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const TICKET_RE = /^[A-Za-z0-9_-]{32,64}$/;
export const TICKET_MS = 30_000;
/** One frame of the run stream: a type byte, a 4-byte big-endian length, the payload. @param {number} type @param {Buffer} payload */
export const frame = (type, payload) => Buffer.concat([Buffer.from([type]), (b => (b.writeUInt32BE(payload.length), b))(Buffer.alloc(4)), payload]);
const hash = (/** @type {string} */ t) => crypto.createHash("sha256").update(t).digest("hex");

/** Single-use tickets held in memory, by hash. A ticket opens an agent's screen, or one terminal (a tmux session) of that agent. */
export class Tickets {
  /** @param {() => number} [now] */
  constructor(now = Date.now) { this.now = now; /** @type {Map<string, { u: { user: string, uid: number, display: number }, kind: string, session: string | null, spec: any, expires: number }>} */ this.map = new Map(); }
  /** @param {string} ticket @param {{ user: string, uid: number, display: number }} u @param {"vnc" | "cdp" | "term" | "run"} [kind] the agent's screen, its Chrome's debugging pipe, or one terminal @param {string | null} [session] a terminal's name */
  add(ticket, u, kind = "vnc", session = null, spec = null) {
    if (!KINDS.includes(kind)) throw new Error("not a ticket kind");
    // a run ticket carries what to run, checked here and again by the helper as the agent; no other ticket carries anything but its agent
    if ((kind === "run") !== (spec !== null)) throw new Error("a run ticket names what to run, and no other ticket does");
    if (spec !== null && session !== null) throw new Error("a run ticket names no terminal");
    if (spec !== null) spec = validateRun(u, spec, RUN_ARGV_BYTES);
    if ((kind === "term") !== (session !== null)) throw new Error("a terminal ticket names its terminal, and no other ticket does");
    if (!TICKET_RE.test(ticket)) throw new Error("not a ticket");
    if (session !== null && !SESSION_RE.test(session)) throw new Error("not a terminal name");
    const t = this.now();
    for (const [k, v] of this.map) if (v.expires <= t) this.map.delete(k);
    if (this.map.size >= 256) throw new Error("too many tickets waiting");
    this.map.set(hash(ticket), { u, kind, session, spec, expires: t + TICKET_MS });
  }
  /** Spend a ticket: the agent (and terminal) it names, or null when unknown, used or expired. @param {string} ticket */
  take(ticket) {
    if (!TICKET_RE.test(ticket)) return null;
    const k = hash(ticket), v = this.map.get(k);
    this.map.delete(k);
    return v && v.expires > this.now() ? { ...v.u, kind: v.kind, session: v.session, spec: v.spec } : null;
  }
}

/**
 * Only vyred's address may connect (the same pin computerd keeps): any other peer is closed before it can send a ticket, so an agent cannot even try one. The ticket is the second gate.
 * @param {{ tickets: Tickets, spawn?: (argv: string[]) => import("node:child_process").ChildProcess, peer?: () => string | null, maxPerAgent?: number, maxPending?: number, helloMs?: number }} o
 */
export function createRelay(o) {
  const spawn = o.spawn || (argv => nodeSpawn(argv[0], argv.slice(1), { env: {}, stdio: ["pipe", "pipe", "ignore"] }));
  const peer = o.peer || peerFromFile();
  const maxPerAgent = o.maxPerAgent ?? 6, maxPending = o.maxPending ?? 16, helloMs = o.helloMs ?? 3000;
  /** @type {Map<number, number>} */ const open = new Map();
  let pending = 0;
  return net.createServer(sock => {
    const want = peer();
    if (!want || plain(sock.remoteAddress) !== want) return void sock.destroy();
    if (pending >= maxPending) return void sock.destroy();
    pending++;
    let counted = true, buf = Buffer.alloc(0);
    const settle = () => { if (counted) { counted = false; pending--; } };
    const timer = setTimeout(() => { settle(); sock.destroy(); }, helloMs);
    sock.on("error", () => {});
    sock.on("close", () => { clearTimeout(timer); settle(); });
    const onData = (/** @type {Buffer} */ chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(10);
      if (nl < 0) { if (buf.length > 80) sock.destroy(); return; }
      sock.off("data", onData);
      sock.pause();
      clearTimeout(timer); settle();
      const u = o.tickets.take(buf.subarray(0, nl).toString("latin1"));
      const rest = buf.subarray(nl + 1);
      if (!u || (open.get(u.uid) || 0) >= maxPerAgent) return void sock.destroy();
      open.set(u.uid, (open.get(u.uid) || 0) + 1);
      // the helper and its one fixed word come from the ticket's kind, never from text the ticket carried
      // a harness session needs more room than a screen helper: a Node process reserves a lot of address space
      const argv = u.kind === "term" ? [...asAgent(u, {}, { TERM: "xterm-256color", DISPLAY: `:${u.display}`, XAUTHORITY: browserOf(u).xauth }), "/usr/bin/python3", "-I", TERM, String(u.session)]
        : u.kind === "run" ? [...asAgent(u, { memoryMb: 8192, procs: 1024 }), "/usr/bin/python3", "-I", RUN]
        : [...asBrowser(u), "/usr/bin/python3", "-I", PIPE, u.kind === "cdp" ? "cdp" : "vnc"];
      const child = spawn(argv);
      let done = false;
      const finish = () => { if (done) return; done = true; open.set(u.uid, Math.max(0, (open.get(u.uid) || 1) - 1)); try { child.stdin?.end(); } catch {} try { sock.destroy(); } catch {} };
      child.on("error", finish); child.on("exit", finish); sock.on("close", finish);
      child.stdin?.on("error", () => {}); child.stdout?.on("error", () => {});
      // the run helper is told what to run as its first frame (type 4); it is not on its command line, in a file or in its environment
      if (u.kind === "run") child.stdin?.write(frame(4, Buffer.from(JSON.stringify(u.spec))));
      if (rest.length) child.stdin?.write(rest);
      sock.pipe(/** @type {any} */ (child.stdin)); /** @type {any} */ (child.stdout).pipe(sock);
      sock.resume();
    };
    sock.on("data", onData);
  });
}
