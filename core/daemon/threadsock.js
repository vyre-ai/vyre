// @ts-check
// A socket for one Vyre-owned session (ADR 0030 phase 3, ADR 0032 part 3). Under the uid split a
// session runs as vyre-agent and cannot open vyred's own socket, so vyred opens this one for it:
// a random name in a folder the agent may enter but not list, and every request on it is that
// session's, whatever it says. vyred binds the caller ("mcp:thread:<id>", "harness:thread:<id>",
// or "mcp:agent:<name>" for an agent's thread), never reads one from the call, checks with the
// kernel that the connecting process belongs to the session (its process, group or session, or
// a descendant), and refuses every person-only and human-only tool outright. It closes when the
// thread stops.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { HUMAN_ONLY, PERSON_ONLY } from "../presence/index.js";
import { peerPid, processTable, ancestry } from "./peer.js";

/**
 * The folder for sessions' sockets. On the box, /run/vyre-threads (vyre:vyre-work, 2710): the
 * agent may pass through it and not list it, and a socket in it takes the vyre-work group. A Mac
 * or a test passes its own `dir` (a private folder; the sessions there run as the user anyway).
 */
export const DIR = process.env.VYRE_THREAD_SOCKETS || "/run/vyre-threads";

/**
 * Does this process belong to the session? Its own group or session is one of the session's, or
 * a process of the session is among its ancestors.
 * @param {number} pid @param {{ pids: number[], pgids?: number[], sids?: number[] }} of
 * @param {(pid: number) => any} [look]
 */
export function belongs(pid, of, look = processTable()) {
  const mine = new Set([...(of.pids || []), ...(of.pgids || []), ...(of.sids || [])].filter(n => Number.isInteger(n) && n > 1));
  if (!mine.size) return false;
  const row = look(pid);
  if (row && ((row.pgid && mine.has(row.pgid)) || (row.sid && mine.has(row.sid)))) return true;
  return ancestry(pid, look).chain.some(p => mine.has(p.pid));
}

const send = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

/**
 * Open one session's socket.
 * @param {{ handler: (policy: any) => (req: any, res: any, caller: string, peer?: any) => Promise<void>,
 *   thread: string, agent?: string|null, pids: () => Promise<{ pids: number[], pgids?: number[], sids?: number[] }>,
 *   kernelToken?: () => string | undefined | Promise<string | undefined>, dir?: string, mode?: number, look?: (pid: number) => any, log?: (m: string) => void }} o
 * @returns {Promise<{ path: string, close: () => Promise<void> }>}
 */
export async function openThreadSocket(o) {
  if (!/^[\w-]{1,64}$/.test(String(o.thread))) throw new Error("thread must be a thread id");
  if (o.agent != null && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(o.agent))) throw new Error("agent must be an agent name");
  const dir = o.dir || DIR;
  // The box's shared folder is passed through by a group (the agent runs as another user): 0710 and 0660. A private folder of the person's own user (a Mac, the sandboxed
  // sessions there) is theirs alone: 0700 and 0600, so nothing else of that user can even list it (reviewer-2 D-5).
  const shared = dir === DIR;
  fs.mkdirSync(dir, { recursive: true, mode: shared ? 0o710 : 0o700 });
  if (!shared) { try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ } }
  const file = path.join(dir, `${crypto.randomBytes(16).toString("base64url")}.sock`);
  const who = o.agent ? `agent:${o.agent}` : `thread:${o.thread}`;
  const route = o.handler({ thread: o.thread, ...(o.agent ? { agent: o.agent } : {}) });
  /** @param {boolean} lent a request that came through a lent computer's wire call (vyred's own private socket): the lender was checked there (its epoch, its Offers), so there is no process of this session to look for */
  const serve = (lent) => async (/** @type {any} */ req, /** @type {any} */ res) => {
    try {
      const url = new URL(req.url || "/", "http://vyred");
      const tool = url.pathname.startsWith("/v1/tools/") ? decodeURIComponent(url.pathname.slice("/v1/tools/".length)) : null;
      // A session never answers, approves, proves presence or signs a person in.
      if (tool && (PERSON_ONLY.has(tool) || HUMAN_ONLY.has(tool))) return send(res, 403, { error: { code: "denied", message: `${tool} is the person's own; a session never runs it` } });
      if (url.pathname.startsWith("/v1/presence") || url.pathname.startsWith("/v1/person")) return send(res, 403, { error: { code: "denied", message: "presence is the person's" } });
      // Only the session's own processes: the kernel says which process connected.
      if (!lent) {
        const pid = await peerPid(req.socket);
        if (!pid || !belongs(pid, await o.pids(), o.look)) return send(res, 403, { error: { code: "denied", message: "this socket is one session's, and the caller is not in it" } });
      }
      // The kind of client (its MCP server or its hooks) is the one thing the call may say.
      const kind = String(req.headers["x-vyre-caller"] || "").startsWith("harness") ? "harness" : "mcp";
      // The session's kernel credential (lib/kernel-session.js): set here from what vyred holds for this session, never from the client. Whatever the client sent is dropped.
      delete req.headers["x-vyre-kernel-session"];
      const kernelToken = o.kernelToken ? await o.kernelToken() : undefined;
      // A socket that has a kernel credential never lets a call go out unstamped: no valid token (the session ended, a renewal failed) means the call is refused.
      if (o.kernelToken && !kernelToken) return send(res, 401, { error: { code: "no_session", message: "this session's kernel credential is not valid; the call was not made" } });
      if (kernelToken) req.headers["x-vyre-kernel-session"] = kernelToken;
      await route(req, res, `${kind}:${who}`);
    } catch (e) { if (!res.headersSent) send(res, 500, { error: { code: "internal", message: /** @type {Error} */ (e).message } }); }
  };
  const server = http.createServer(serve(false));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(file, () => resolve(undefined)); });
  fs.chmodSync(file, o.mode ?? (shared ? 0o660 : 0o600));
  // A session that runs on a lent computer reaches Vyre through the home (contracts/lent-spawn.md, lent.http): the same route, the same caller binding and kernel credential, on a private socket of vyred's own that no session
  // process can reach; made the first time a lender asks.
  /** @type {null | { dir: string, file: string, server: http.Server }} */ let lentSide = null;
  const lentFile = async () => {
    if (lentSide) return lentSide.file;
    const ldir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-lent-"));
    fs.chmodSync(ldir, 0o700);
    const lfile = path.join(ldir, "t.sock");
    const lserver = http.createServer(serve(true));
    await new Promise((resolve, reject) => { lserver.once("error", reject); lserver.listen(lfile, () => resolve(undefined)); });
    fs.chmodSync(lfile, 0o600);
    lentSide = { dir: ldir, file: lfile, server: lserver };
    return lfile;
  };
  /** @type {LentDoor} */ const door = {
    request: async (method, urlPath, headers, body) => {
      const sock = await lentFile();
      return await new Promise((resolve, reject) => {
        const req = http.request({ socketPath: sock, method, path: urlPath, headers: { ...headers, "content-type": "application/json", ...(method === "GET" ? {} : { "content-length": Buffer.byteLength(body) }) }, agent: false, timeout: LENT_CALL_MS }, res => {
          const parts = /** @type {Buffer[]} */ ([]); let n = 0;
          res.on("data", c => { n += c.length; if (n <= LENT_MAX_REPLY) parts.push(c); });
          res.on("end", () => resolve({ status: res.statusCode || 502, body: n > LENT_MAX_REPLY ? JSON.stringify({ error: { code: "too_large", message: "that answer is too large to bring to a lent computer; ask for less" } }) : Buffer.concat(parts).toString("utf8") }));
        });
        req.on("timeout", () => { req.destroy(new Error("vyred did not answer in time")); });
        req.on("error", reject);
        req.end(body);
      });
    },
  };
  DOORS.set(String(o.thread), door);
  return {
    path: file,
    close: () => new Promise(r => {
      if (DOORS.get(String(o.thread)) === door) DOORS.delete(String(o.thread));
      const done = () => { server.closeAllConnections(); server.close(() => { try { fs.rmSync(file, { force: true }); } catch {} r(undefined); }); };
      if (lentSide) { const l = lentSide; lentSide = null; l.server.closeAllConnections(); l.server.close(() => { try { fs.rmSync(l.dir, { recursive: true, force: true }); } catch {} done(); }); } else done();
    }),
  };
}

/** How long one tool call of a session on a lent computer may run at the home (the lender asks again for it; lent-home keeps the same limit). */
const LENT_CALL_MS = 30 * 60_000;
/** The largest answer a lent computer is sent over the wire (the wire's own cap is 2 MiB). */
const LENT_MAX_REPLY = 1_500_000;
/** @typedef {{ request: (method: string, path: string, headers: Record<string, string>, body: string) => Promise<{ status: number, body: string }> }} LentDoor */
/** The door each open session socket has for a lent computer, by thread. @type {Map<string, LentDoor>} */
const DOORS = new Map();
/**
 * One request of a session that runs on a lent computer, as that session's own (the session socket's route, caller binding and kernel credential). Null when this thread has no socket open here.
 * @param {string} thread @param {string} method @param {string} urlPath @param {Record<string, string>} headers @param {string} body
 */
export function lentRequest(thread, method, urlPath, headers, body) {
  const d = DOORS.get(String(thread));
  return d ? d.request(method, urlPath, headers, body) : null;
}
