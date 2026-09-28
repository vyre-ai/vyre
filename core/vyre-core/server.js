// @ts-check
// vyre-core: the trusted root split from vyred on a Mac (ADR 0040). Phase 1: its own socket, its
// own peer check, and presence, the trust anchors every other phase stands on.
//
// core trusts nothing vyred says. Every connection is checked by the kernel's word for who
// connected (peercred.js): a uid other than the owner's is refused before any route. A write
// carries a proof core checks against its OWN keys, in its OWN db under its data directory. The
// methods it takes are the ones it can check itself: a Capsule, device or passkey signature, a
// one-time code only the installer can mint, and a session core itself opened. Never touchid (that
// is vyred trusting its own dialog helper) and never tty (a same-uid process can read the tty).
//
// Protocol: HTTP over the unix socket, JSON in and out, { data } or { error }.
//   GET  /v1/hello                      -> { name, protocol, version }
//   GET  /v1/peer                       -> core's own verdict on this connection: { pid, uid, person, why }
//   POST /v1/tools/<tool>               -> body is the input; x-vyre-presence carries a write's proof
//     presence.keys                        read: enrolled keys, never their public keys
//     presence.challenge {tool, input}     read: a passkey challenge core issued for that exact call
//     presence.verify {tool, input, proof} read: does this proof (a header string) prove that call?
//     presence.enroll / presence.remove    write: needs a proof over this exact input
//     presence.session.open                write: after a capsule, device or passkey proof only

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { open } from "../store/index.js";
import { Presence, parse } from "../presence/index.js";
import { insideClaude, loginOf } from "../daemon/peer.js";
import { readPeerCred } from "./peercred.js";
import { procTable } from "./procs.js";

export const PROTOCOL = 1;
/** The proofs core can check itself. */
export const CORE_METHODS = new Set(["capsule", "device", "passkey", "code", "session"]);
/** The proofs a core session may open from: a live key, never a code or another session. */
const SESSION_OPENERS = new Set(["capsule", "device", "passkey"]);
const MAX_BODY = 256 * 1024;

/**
 * core's default verdict on a peer pid: the person's own surface, as vyred's socket judges it
 * today (core/daemon/peer.js), but computed here on core's own connection. Not inside a Claude
 * session, an ancestry read to the top, and a login terminal.
 * @param {number} pid @returns {{ person: boolean, why: string }}
 */
export function personOf(pid) {
  // One table for the whole verdict, read by core itself (procs.js): peer.js's walks are pure
  // given it, and never reach its own ps-from-PATH or tmux.
  const look = procTable();
  const inside = insideClaude(pid, { look });
  if (inside.inside) return { person: false, why: "inside a Claude session" };
  if (inside.unknown) return { person: false, why: "its ancestry can't be read to the top" };
  if (!loginOf(pid, /** @type {any} */ (look))) return { person: false, why: "no login terminal" };
  return { person: true, why: "a login terminal" };
}

/**
 * core's own db and presence, in its data directory. The installer's `code` command opens it too,
 * with core's own rights, to mint the first enrollment code.
 * @param {string} dataDir @param {{ log?: (m: string) => void, now?: () => number, webauthn?: any }} [o]
 */
export function openStore(dataDir, o = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = open(path.join(dataDir, "core.db"));
  const presence = new Presence({
    db, log: o.log || (() => {}), role: "local", now: o.now, touchid: null, webauthn: o.webauthn,
    // core has no terminal and shows no dialog: nothing it does may reach the person's screen.
    writeTty: () => {}, who: async () => [], env: {},
  });
  return { db, presence };
}

/**
 * Start vyre-core on a unix socket.
 * @param {{ socket: string, dataDir: string, ownerUid: number, version?: string, log?: (m: string) => void, now?: () => number,
 *   peerCred?: (s: import("node:net").Socket) => Promise<{ pid: number, uid: number } | null>,
 *   personOf?: (pid: number) => { person: boolean, why: string }, webauthn?: any }} o
 *   peerCred, personOf and webauthn: tests only.
 */
export async function startCore(o) {
  const log = o.log || (() => {});
  const credOf = o.peerCred || readPeerCred;
  const judge = o.personOf || personOf;
  const { db, presence } = openStore(o.dataDir, { log, now: o.now, webauthn: o.webauthn });

  /** @type {WeakMap<object, Promise<{ pid: number, uid: number } | null>>} */
  const creds = new WeakMap();
  const peer = sock => {
    let p = creds.get(sock);
    if (!p) { p = credOf(sock).then(c => { if (!c) creds.delete(sock); return c; }); creds.set(sock, p); }
    return p;
  };

  /** A write's proof, checked by core against its own keys. @returns {Promise<{ ok: true, method: string, keyId: string|null } | { ok: false, code: string, message: string, methods?: string[] }>} */
  const prove = async (tool, input, header) => {
    const proof = parse(header);
    if (!proof) return { ok: false, code: "presence_required", message: `${tool} needs a proof vyre-core can check`, methods: [...CORE_METHODS] };
    if (!CORE_METHODS.has(proof.method)) return { ok: false, code: "presence_required", message: `vyre-core doesn't take a ${proof.method} proof`, methods: [...CORE_METHODS] };
    const r = await presence.verify({ tool, input, caller: "core", proof });
    return r.ok ? { ok: true, method: r.method, keyId: r.keyId ?? null } : { ok: false, code: r.code, message: r.message, methods: [...CORE_METHODS] };
  };

  const READ = {
    "presence.keys": async () => presence.keys(),
    "presence.challenge": async input => {
      const r = await presence.challenge({ tool: String(input.tool || ""), input: input.input ?? {}, method: "passkey" });
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r;
    },
    "presence.verify": async input => {
      const r = await prove(String(input.tool || ""), input.input ?? {}, input.proof);
      return r.ok ? r : { ok: false, code: r.code, message: r.message };
    },
  };
  const WRITE = {
    "presence.enroll": async input => presence.enroll(input),
    "presence.remove": async input => ({ removed: presence.remove(String(input.id || "")) }),
    "presence.session.open": async (_input, proved) => {
      if (!SESSION_OPENERS.has(proved.method)) throw Object.assign(new Error("a session opens only after a Capsule, device or passkey proof"), { code: "presence_required" });
      return presence.openSession({ method: proved.method, keyId: proved.keyId });
    },
  };

  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  const body = req => new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on("data", d => { size += d.length; if (size > MAX_BODY) { reject(Object.assign(new Error("request too large"), { code: "too_large" })); req.destroy(); } else parts.push(d); });
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf8");
      if (!raw) return resolve({});
      try { const v = JSON.parse(raw); resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {}); }
      catch { reject(Object.assign(new Error("the body must be a JSON object"), { code: "bad_input" })); }
    });
    req.on("error", reject);
  });

  const server = http.createServer(async (req, res) => {
    try {
      const c = await peer(req.socket);
      // The owner's uid and nobody else's, before anything is read.
      if (!c || c.uid !== o.ownerUid) {
        res.setHeader("connection", "close");
        return send(res, 403, { error: { code: "not_owner", message: "vyre-core answers only its owner" } });
      }
      const url = new URL(req.url || "/", "http://core");
      if (req.method === "GET" && url.pathname === "/v1/hello") return send(res, 200, { data: { name: "vyre-core", protocol: PROTOCOL, version: o.version || null } });
      if (req.method === "GET" && url.pathname === "/v1/peer") {
        const v = judge(c.pid);
        return send(res, 200, { data: { pid: c.pid, uid: c.uid, person: v.person, why: v.why } });
      }
      const m = /^\/v1\/tools\/([a-z][a-z0-9._-]{0,63})$/.exec(url.pathname);
      if (req.method !== "POST" || !m) return send(res, 404, { error: { code: "not_found", message: "no such route" } });
      const tool = m[1];
      const input = await body(req);
      if (READ[tool]) return send(res, 200, { data: await READ[tool](input) });
      if (!WRITE[tool]) return send(res, 404, { error: { code: "unknown_tool", message: `vyre-core has no tool ${tool}` } });
      const proved = await prove(tool, input, req.headers["x-vyre-presence"]);
      if (!proved.ok) return send(res, 401, { error: { code: proved.code, message: proved.message, methods: proved.methods } });
      log(`vyre-core: ${tool} by pid ${c.pid}, proved by ${proved.method}`);
      return send(res, 200, { data: await WRITE[tool](input, proved) });
    } catch (e) {
      const err = /** @type {any} */ (e);
      const code = typeof err.code === "string" && /^[a-z_]+$/.test(err.code) ? err.code : "bad_input";
      if (!res.headersSent) send(res, code === "too_large" ? 413 : 400, { error: { code, message: String(err.message || err) } });
    }
  });

  try { fs.unlinkSync(o.socket); } catch {}
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(o.socket, () => resolve(undefined)); });
  // Anyone may connect; only the owner's uid gets an answer (the check above is the kernel's).
  fs.chmodSync(o.socket, 0o666);
  log(`vyre-core: listening on ${o.socket} for uid ${o.ownerUid}`);

  return {
    presence,
    close: () => new Promise(resolve => { server.close(() => { try { db.close(); } catch {} resolve(undefined); }); server.closeAllConnections?.(); }),
  };
}
