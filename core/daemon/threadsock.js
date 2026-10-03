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
 *   dir?: string, mode?: number, look?: (pid: number) => any, log?: (m: string) => void,
 *   token?: string, valid?: () => Promise<boolean> }} o
 *   token: the session's own kernel token (kernel surfaces.open): every call on this socket carries it as `meta.token`, set from here and never from a header, so the kernel
 *   knows which chat the call is in. valid: asked before every call; once it says no (the session was revoked, its token expired) the socket closes, open connections included.
 * @returns {Promise<{ path: string, close: () => Promise<void> }>}
 */
export async function openThreadSocket(o) {
  if (!/^[\w-]{1,64}$/.test(String(o.thread))) throw new Error("thread must be a thread id");
  if (o.agent != null && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(o.agent))) throw new Error("agent must be an agent name");
  const dir = o.dir || DIR;
  // The box's shared folder is passed through by a group (the agent runs as another user): 0710 and 0660. A private folder of the person's own user (a Mac, the sandboxed
  // sessions there) is theirs alone: 0700 and 0600, so nothing else of that user can even list it.
  const shared = dir === DIR;
  fs.mkdirSync(dir, { recursive: true, mode: shared ? 0o710 : 0o700 });
  if (!shared) { try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ } }
  const file = path.join(dir, `${crypto.randomBytes(16).toString("base64url")}.sock`);
  const who = o.agent ? `agent:${o.agent}` : `thread:${o.thread}`;
  const route = o.handler({ thread: o.thread, ...(o.agent ? { agent: o.agent } : {}), ...(o.token ? { token: o.token } : {}) });
  /** @type {import("node:http").Server} */ let server;
  let closed = false;
  const shut = () => new Promise(r => { closed = true; server.closeAllConnections(); server.close(() => { try { fs.rmSync(file, { force: true }); } catch {} r(undefined); }); });
  server = http.createServer(async (req, res) => {
    try {
      // Revoked or expired: the socket goes, and so does every connection already open on it.
      if (o.valid && !closed && !(await o.valid().catch(() => false))) { send(res, 403, { error: { code: "denied", message: "this session has ended" } }); void shut(); return; }
      const url = new URL(req.url || "/", "http://vyred");
      const tool = url.pathname.startsWith("/v1/tools/") ? decodeURIComponent(url.pathname.slice("/v1/tools/".length)) : null;
      // A session never answers, approves, proves presence or signs a person in.
      if (tool && (PERSON_ONLY.has(tool) || HUMAN_ONLY.has(tool))) return send(res, 403, { error: { code: "denied", message: `${tool} is the person's own; a session never runs it` } });
      if (url.pathname.startsWith("/v1/presence") || url.pathname.startsWith("/v1/person")) return send(res, 403, { error: { code: "denied", message: "presence is the person's" } });
      // Only the session's own processes: the kernel says which process connected.
      const pid = await peerPid(req.socket);
      if (!pid || !belongs(pid, await o.pids(), o.look)) return send(res, 403, { error: { code: "denied", message: "this socket is one session's, and the caller is not in it" } });
      // The kind of client (its MCP server or its hooks) is the one thing the call may say.
      const said = String(req.headers["x-vyre-caller"] || "");
      const kind = said.startsWith("harness") ? "harness" : said.startsWith("cli") ? "cli" : "mcp";
      await route(req, res, `${kind}:${who}`);
    } catch (e) { if (!res.headersSent) send(res, 500, { error: { code: "internal", message: /** @type {Error} */ (e).message } }); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(file, () => resolve(undefined)); });
  fs.chmodSync(file, o.mode ?? (shared ? 0o660 : 0o600));
  return { path: file, close: () => shut() };
}
