// @ts-check
// agentd-relay: the way a viewer reaches ONE agent's screen. An agent's screen is a unix socket in that agent's own 0700 folder, so only that uid can open it. The relay listens on one
// TCP port inside the computer; a connection says nothing but a ticket, and the ticket (which vyred registered through the authenticated agentd channel, single use, short life) names the
// agent. The relay then starts agentd-pipe.py AS that agent's uid, which opens that uid's own socket and nothing else, and joins the connection to it. A connection with no good ticket within
// a few seconds is closed without a byte; the ticket, once spent, is gone.

import net from "node:net";
import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import fs from "node:fs";
import { asAgent } from "./agentd.js";

export const RELAY_PORT = 5910;
/** The address vyred has, written by computerd when it pins it (computerd/peer-file.js). */
export const PEER_FILE = "/var/lib/vyre/vyred-peer";
const plain = (/** @type {unknown} */ a) => String(a || "").replace(/^::ffff:/, "");
export const peerFromFile = (/** @type {string} */ file = PEER_FILE) => () => { try { return fs.readFileSync(file, "utf8").trim() || null; } catch { return null; } };
export const PIPE = "/opt/agentd/agentd-pipe.py";
const TICKET_RE = /^[A-Za-z0-9_-]{32,64}$/;
export const TICKET_MS = 30_000;
const hash = (/** @type {string} */ t) => crypto.createHash("sha256").update(t).digest("hex");

/** Single-use tickets held in memory, by hash. */
export class Tickets {
  /** @param {() => number} [now] */
  constructor(now = Date.now) { this.now = now; /** @type {Map<string, { u: { user: string, uid: number, display: number }, expires: number }>} */ this.map = new Map(); }
  /** @param {string} ticket @param {{ user: string, uid: number, display: number }} u */
  add(ticket, u) {
    if (!TICKET_RE.test(ticket)) throw new Error("not a ticket");
    const t = this.now();
    for (const [k, v] of this.map) if (v.expires <= t) this.map.delete(k);
    if (this.map.size >= 256) throw new Error("too many tickets waiting");
    this.map.set(hash(ticket), { u, expires: t + TICKET_MS });
  }
  /** Spend a ticket: the agent it names, or null when unknown, used or expired. @param {string} ticket */
  take(ticket) {
    if (!TICKET_RE.test(ticket)) return null;
    const k = hash(ticket), v = this.map.get(k);
    this.map.delete(k);
    return v && v.expires > this.now() ? v.u : null;
  }
}

/**
 * Only vyred's address may connect (the same pin computerd keeps): any other peer is closed before it can send a ticket, so an agent cannot even try one. The ticket is the second gate.
 * @param {{ tickets: Tickets, spawn?: (argv: string[]) => import("node:child_process").ChildProcess, peer?: () => string | null, maxPerAgent?: number, maxPending?: number, helloMs?: number }} o
 */
export function createRelay(o) {
  const spawn = o.spawn || (argv => nodeSpawn(argv[0], argv.slice(1), { env: {}, stdio: ["pipe", "pipe", "ignore"] }));
  const peer = o.peer || peerFromFile();
  const maxPerAgent = o.maxPerAgent ?? 2, maxPending = o.maxPending ?? 16, helloMs = o.helloMs ?? 3000;
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
      const child = spawn([...asAgent(u), "/usr/bin/python3", "-I", PIPE]);
      let done = false;
      const finish = () => { if (done) return; done = true; open.set(u.uid, Math.max(0, (open.get(u.uid) || 1) - 1)); try { child.stdin?.end(); } catch {} try { sock.destroy(); } catch {} };
      child.on("error", finish); child.on("exit", finish); sock.on("close", finish);
      child.stdin?.on("error", () => {}); child.stdout?.on("error", () => {});
      if (rest.length) child.stdin?.write(rest);
      sock.pipe(/** @type {any} */ (child.stdin)); /** @type {any} */ (child.stdout).pipe(sock);
      sock.resume();
    };
    sock.on("data", onData);
  });
}
