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
//     presence.enroll.first                write: a SERVER's first key only (firstkey.js): the key the install line named, within the hour, from outside every Claude session
//     keys.exists/ensure/box.pub/box.dh/route.pub/route.sign, keys.device.exists/ensure/pub/dh   the relay's keys (phase 5), never a private half

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { open } from "../store/index.js";
import { Presence, parse } from "../presence/index.js";
import { insideClaude, loginOf, ancestry } from "../daemon/peer.js";
import { readPeerCred } from "./peercred.js";
import { procTable } from "./procs.js";
import { openVault } from "./vault.js";
import { openKeys } from "./keys.js";
import { enrollFirst, migrateFirstKey } from "./firstkey.js";

export const PROTOCOL = 1;
/** The proofs core can check itself. */
export const CORE_METHODS = new Set(["capsule", "device", "passkey", "code", "session"]);
/** The proofs a core session may open from: a live key, never a code or another session. */
const SESSION_OPENERS = new Set(["capsule", "device", "passkey"]);
const MAX_BODY = 256 * 1024;
const CODE_MISSES = 5;
/** The installer's one-time code, handed to the Capsule over an inherited fd: 2 minutes. */
export const INSTALL_CODE = { ttl: 2 * 60_000, length: 6 };
/** The same, when the handoff failed and the person types it into the Capsule: 10 minutes. */
export const TYPED_CODE = { ttl: 10 * 60_000, length: 6 };

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
 * Is this peer outside every Claude session? No claude (or thread) in its ancestry, and the
 * ancestry read to the top. An ambiguous top (a launchd job's leader, which is what vyred is, or a
 * runner's own shell) is allowed: insideClaude cannot tell a real leader from a detached one there,
 * and refusing it would refuse vyred. What this does not stop is a same-uid process that deliberately
 * detaches from its parent to look like a leader; that limit is ADR 0040 section 3's, the same for
 * every check on this uid. A chain that can't be read to the top is refused.
 * @param {number} pid @param {{ look?: any }} [o]
 */
export function notModelOf(pid, { look = procTable() } = {}) {
  const inside = insideClaude(pid, { look });
  if (inside.inside) return false;
  if (!inside.unknown) return true;
  return ancestry(pid, look).complete;
}

/**
 * core's own db and presence, in its data directory. The installer's `code` command opens it too,
 * with core's own rights, to mint the first enrollment code.
 * @param {string} dataDir @param {{ log?: (m: string) => void, now?: () => number, webauthn?: any }} [o]
 */
export function openStore(dataDir, o = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = open(path.join(dataDir, "core.db"));
  migrateFirstKey(db);
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
 *   personOf?: (pid: number) => { person: boolean, why: string }, notModel?: (pid: number) => boolean, webauthn?: any, server?: boolean }} o
 *   peerCred, personOf, notModel and webauthn: tests only. `server`: this core belongs to a Mac that is a server (the installer's plist says so; vyred cannot), which is the only core that takes a first key by presence.enroll.first.
 */
export async function startCore(o) {
  const log = o.log || (() => {});
  const credOf = o.peerCred || readPeerCred;
  const judge = o.personOf || personOf;
  // Is this peer the Capsule core itself signed? The one check for the installer's code and for
  // every plain value (phase 4 brings the real one: the exe against core's DR, the audit token).
  // Until then a Mac core says no to both, and so does Linux unless o.dev is set.
  // The Linux "yes" is for development only, and only when asked for on purpose (o.dev, which
  // main.js sets from VYRE_CORE_STRICT=0): a core started any other way says no.
  const capsuleFrom = o.capsuleFrom || o.codeFrom || (async () => o.dev === true && process.platform !== "darwin");
  const codeFrom = capsuleFrom;
  // Which process a session is bound to: its pid and start time, so a leaked session secret is
  // useless to any other process, a reused pid included.
  const peerKey = o.peerKey || (pid => `${pid}@${(procTable()(pid) || {}).started || "?"}`);
  const { db, presence } = openStore(o.dataDir, { log, now: o.now, webauthn: o.webauthn });
  // What core did, for vyred to show (ADR 0040 phase 2a, condition d): a short ring in memory,
  // read by a long poll. Information only: vyred can forge its own log, so nothing decides on it.
  const EVENTS_MAX = 500;
  /** @type {{ seq: number, type: string, payload: any, at: number }[]} */
  const ring = [];
  let seq = 0;
  /** @type {Set<() => void>} */
  const waiting = new Set();
  const emit = (type, payload) => {
    ring.push({ seq: ++seq, type, payload, at: Date.now() });
    if (ring.length > EVENTS_MAX) ring.shift();
    for (const w of waiting) w();
  };
  const vaults = openVault({ db, dataDir: o.dataDir, log, emit, testKdf: o.testKdf });
  const keys = openKeys(o.dataDir);
  let keyUses = 0;
  // The relay's keys (phase 5). The private halves never leave; what core offers is below. Any
  // owner-uid process that is not a model's (inside no Claude session, its ancestry read to the top)
  // may ask: vyred is a launchd job with no terminal, so the person verdict (which wants a login
  // terminal) is the wrong test here. A DH answer is an oracle for impersonating the box, so a model
  // never gets one.
  const KEYS = {
    "keys.exists": async () => ({ exists: keys.exists() }),
    "keys.ensure": async () => keys.ensure(),
    "keys.box.pub": async () => ({ pub: keys.boxPub() }),
    "keys.box.dh": async input => ({ secret: keys.boxDh(input.remote) }),
    "keys.route.pub": async () => ({ pub: keys.routePub() }),
    "keys.route.sign": async input => ({ sig: keys.routeSign(input.message) }),
    "keys.device.exists": async () => ({ exists: keys.deviceExists() }),
    "keys.device.ensure": async () => keys.deviceEnsure(),
    "keys.device.pub": async () => ({ pub: keys.devicePub() }),
    "keys.device.dh": async input => ({ secret: keys.deviceDh(input.remote) }),
  };
  const notModel = o.notModel || (pid => notModelOf(pid));

  /** @type {WeakMap<object, Promise<{ pid: number, uid: number } | null>>} */
  const creds = new WeakMap();
  const peer = sock => {
    let p = creds.get(sock);
    if (!p) { p = credOf(sock).then(c => { if (!c) creds.delete(sock); return c; }); creds.set(sock, p); }
    return p;
  };

  let codeMisses = 0;
  /** A write's proof, checked by core against its own keys. @returns {Promise<{ ok: true, method: string, keyId: string|null } | { ok: false, code: string, message: string, methods?: string[] }>} */
  const prove = async (tool, input, header, { caller = "core", def = undefined, peer = null } = {}) => {
    const proof = parse(header);
    if (!proof) return { ok: false, code: "presence_required", message: `${tool} needs a proof vyre-core can check`, methods: [...CORE_METHODS] };
    if (!CORE_METHODS.has(proof.method)) return { ok: false, code: "presence_required", message: `vyre-core doesn't take a ${proof.method} proof`, methods: [...CORE_METHODS] };
    // A code proves nothing here: it is redeemed only by the first enroll (redeem, below).
    if (proof.method === "code") return { ok: false, code: "presence_required", message: "a code only enrolls the first key", methods: [...CORE_METHODS] };
    const r = await presence.verify({ tool, input, caller, proof, def, peer });
    return r.ok ? { ok: true, method: r.method, keyId: r.keyId ?? null } : { ok: false, code: r.code, message: r.message, methods: [...CORE_METHODS] };
  };

  const miss = () => {
    if (++codeMisses < CODE_MISSES) return;
    db.prepare("DELETE FROM presence_codes WHERE used IS NULL").run();
    codeMisses = 0;
    log("vyre-core: five wrong enrollment codes; every open code is void");
  };
  /**
   * The first key, from the installer's code (ADR 0040, 1c). The first key is the whole root, so:
   * only while core has no key at all, only a Capsule key, only from the Capsule core signed, and
   * the code is spent in the same transaction as the enroll, so two racing calls can't both win
   * and a failed enroll doesn't burn it.
   */
  const redeem = async (input, code, pid) => {
    const no = message => ({ error: { code: "presence_required", message, methods: [...CORE_METHODS] } });
    if (presence.keys().length) return no("vyre-core already has a key: enroll with a proof from it, not a code");
    if (input.kind !== "capsule") return no("the installer's code enrolls the Capsule's key and nothing else");
    if (!(await codeFrom(pid))) return no("only the Capsule vyre-core signed can use the installer's code");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (presence.keys().length) { db.exec("ROLLBACK"); return no("vyre-core already has a key: enroll with a proof from it, not a code"); }
      if (!presence.useCode(code)) { db.exec("ROLLBACK"); miss(); return no("that code is wrong, used or expired"); }
      const k = presence.enroll(input);
      db.exec("COMMIT");
      codeMisses = 0;
      log(`vyre-core: the first key (${k.kind} ${k.id}) enrolled with the installer's code by pid ${pid}`);
      return { data: k };
    } catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
  };

  const READ = {
    "presence.keys": async () => presence.keys(),
    "presence.challenge": async input => {
      const r = await presence.challenge({ tool: String(input.tool || ""), input: input.input ?? {}, method: "passkey" });
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return r;
    },
    "presence.verify": async input => {
      // A code is redeemed only by the enroll it was made for, never checked (and spent) here.
      const parsed = parse(input.proof);
      if (parsed && parsed.method === "code") return { ok: false, code: "presence_required", message: "a code is only redeemed by presence.enroll" };
      const r = await prove(String(input.tool || ""), input.input ?? {}, input.proof);
      return r.ok ? r : { ok: false, code: r.code, message: r.message };
    },
  };
  const WRITE = {
    "presence.enroll": async input => presence.enroll(input),
    "presence.remove": async input => ({ removed: presence.remove(String(input.id || "")) }),
    "presence.session.open": async (_input, proved, at) => {
      if (!SESSION_OPENERS.has(proved.method)) throw Object.assign(new Error("a session opens only after a Capsule, device or passkey proof"), { code: "presence_required" });
      // Only the Capsule holds a core session, bound to its own process.
      if (!at.capsule) throw Object.assign(new Error("only the Capsule vyre-core signed holds a session"), { code: "not_capsule" });
      return presence.openSession({ method: proved.method, keyId: proved.keyId, peer: at.peer });
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
      if (req.method === "GET" && url.pathname === "/v1/events") {
        // Events after `after`, waiting up to `wait` ms (at most 55 s) for one to happen.
        const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
        const wait = Math.min(55_000, Math.max(0, Number(url.searchParams.get("wait")) || 0));
        const pick = () => ring.filter(e => e.seq > after);
        let got = pick();
        if (!got.length && wait) {
          await new Promise(resolve => {
            const done = () => { waiting.delete(done); clearTimeout(timer); resolve(undefined); };
            const timer = setTimeout(done, wait);
            waiting.add(done);
            req.socket.once("close", done);
          });
          got = pick();
        }
        return send(res, 200, { data: { events: got, last: seq } });
      }
      if (req.method === "GET" && url.pathname === "/v1/peer") {
        const v = judge(c.pid);
        return send(res, 200, { data: { pid: c.pid, uid: c.uid, person: v.person, why: v.why } });
      }
      const m = /^\/v1\/tools\/([a-z][a-z0-9._-]{0,63})$/.exec(url.pathname);
      if (req.method !== "POST" || !m) return send(res, 404, { error: { code: "not_found", message: "no such route" } });
      const tool = m[1];
      const input = await body(req);
      if (READ[tool]) return send(res, 200, { data: await READ[tool](input) });
      if (KEYS[tool]) {
        if (!notModel(c.pid)) return send(res, 403, { error: { code: "not_person_side", message: "vyre-core's relay keys answer only a process outside every Claude session" } });
        // Audited: ancestry cannot tell vyred from a process that detached itself, so the use of the
        // box's key is counted and shown (vyred prints core's events), where misuse would show.
        const data = await KEYS[tool](input);
        if (tool === "keys.box.dh" || tool === "keys.route.sign" || tool === "keys.device.dh") {
          keyUses += 1;
          log(`vyre-core: ${tool} by pid ${c.pid} (use ${keyUses} since core started)`);
          emit("keys.used", { tool, uses: keyUses, pid: c.pid });
        }
        return send(res, 200, { data });
      }
      const header = req.headers["x-vyre-presence"];
      const who = `peer:${c.pid}`;
      const refused = r => send(res, 401, { error: { code: r.code, message: r.message, methods: r.methods } });

      // The vault (phase 2a, core/vyre-core/vault.js).
      if (vaults.read[tool]) return send(res, 200, { data: await vaults.read[tool](input) });
      if (tool === "vault.release") return send(res, 200, { data: await vaults.release(input) });
      if (tool === "vault.revoke") return send(res, 200, { data: await vaults.revoke(input, who) });
      if (tool === "vault.put") {
        if (header === undefined) return send(res, 200, { data: await vaults.put(input, { verified: false, by: `unverified:${who}` }) });
        const p = await prove(tool, input, header);
        if (!p.ok) return refused(p);
        return send(res, 200, { data: await vaults.put(input, { verified: true, by: `${who} (${p.method})` }) });
      }
      if (vaults.plain[tool]) {
        // A plain value leaves core only for the Capsule core signed, to show, copy or type.
        if (!(await capsuleFrom(c.pid))) return send(res, 403, { error: { code: "not_capsule", message: "on a vyre-core Mac, only the Capsule shows, copies or types a value" } });
        const at = { peer: { stableId: peerKey(c.pid) } };
        const p = await prove(tool, input, header, { caller: "capsule", def: { presence: { session: vaults.sessionOk } }, peer: at.peer });
        if (!p.ok) return refused(p);
        log(`vyre-core: ${tool} ${String(input.name || "")} for the Capsule (pid ${c.pid}), proved by ${p.method}`);
        return send(res, 200, { data: await vaults.plain[tool](input, "capsule") });
      }
      if (vaults.write[tool]) {
        const p = await prove(tool, input, header);
        if (!p.ok) return refused(p);
        log(`vyre-core: ${tool} by pid ${c.pid}, proved by ${p.method}`);
        return send(res, 200, { data: await vaults.write[tool](input, `${who} (${p.method})`) });
      }

      // The first key of a Mac server (firstkey.js): no proof exists yet, so the key is checked against the fingerprint the install line named, from a process outside every Claude session.
      if (tool === "presence.enroll.first") {
        if (o.server !== true) return send(res, 403, { error: { code: "not_server", message: "this vyre-core is not a server's: its first key comes from the Capsule" } });
        if (!notModel(c.pid)) return send(res, 403, { error: { code: "not_person_side", message: "a server's first key is enrolled only by a process outside every Claude session" } });
        const k = enrollFirst({ db, presence, now: o.now }, input);
        log(`vyre-core: the first key (${k.kind} ${k.id}) enrolled for this server by pid ${c.pid}`);
        emit("presence.first-key", { id: k.id });
        return send(res, 200, { data: k });
      }
      if (!WRITE[tool]) return send(res, 404, { error: { code: "unknown_tool", message: `vyre-core has no tool ${tool}` } });
      const asked = parse(header);
      if (tool === "presence.enroll" && asked && asked.method === "code") {
        const r = await redeem(input, asked.code, c.pid);
        return r.error ? send(res, 401, { error: r.error }) : send(res, 200, { data: r.data });
      }
      const proved = await prove(tool, input, header);
      if (!proved.ok) return send(res, 401, { error: { code: proved.code, message: proved.message, methods: proved.methods } });
      log(`vyre-core: ${tool} by pid ${c.pid}, proved by ${proved.method}`);
      const at = { capsule: await capsuleFrom(c.pid), peer: { stableId: peerKey(c.pid) } };
      return send(res, 200, { data: await WRITE[tool](input, proved, at) });
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
    vault: vaults,
    close: () => new Promise(resolve => { for (const w of [...waiting]) w(); server.close(async () => { try { await vaults.vault.stop(); } catch {} try { db.close(); } catch {} resolve(undefined); }); server.closeAllConnections?.(); }),
  };
}
