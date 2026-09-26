// @ts-check
// agent: vyred as an ssh-agent (draft-miller-ssh-agent) for the vault's `ssh-key` items.
//
// Private keys never leave vyred: ssh and git ask this socket for a signature and get one. What
// ssh cannot do by itself is say who is asking and why, so each signature request is read for
// its purpose (a login as a user to a host, or an SSHSIG signature such as a git commit) and the
// first one per key and destination needs a person's approval, then holds a lease for 8 hours or
// until the vault locks. The destination is the host key from OpenSSH's session-bind extension,
// whose signature is checked, or "unbound" when a client did not bind. Forwarded requests and
// SSHSIG signatures (commit signing) are never leased: each one asks (ADR 0006, section 6).
//
// Adding, removing and locking keys through the socket are refused: keys enter through the
// vault, never through a socket any local process can write to.

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { Reader, str, u32, byte } from "./wire.js";
import { fingerprint, sign, verify } from "./keys.js";

const FAILURE = 5, SUCCESS = 6;
const REQUEST_IDENTITIES = 11, IDENTITIES_ANSWER = 12, SIGN_REQUEST = 13, SIGN_RESPONSE = 14, EXTENSION = 27;
const MAX_MESSAGE = 256 * 1024;
export const LEASE_MS = 8 * 3600_000;
const USERAUTH_REQUEST = 50;

/**
 * What a signature request is for, read from the data ssh asks the agent to sign.
 * @param {Buffer} data
 * @returns {{ kind: "login", user: string, session: Buffer } | { kind: "sshsig", namespace: string } | { kind: "data" }}
 */
export function describe(data) {
  if (data.subarray(0, 6).toString("latin1") === "SSHSIG") {
    try { const r = new Reader(data.subarray(6)); return { kind: "sshsig", namespace: r.text() }; } catch { return { kind: "data" }; }
  }
  try {
    const r = new Reader(data);
    const session = Buffer.from(r.string());
    if (r.byte() !== USERAUTH_REQUEST) return { kind: "data" };
    const user = r.text();
    r.text(); // service, "ssh-connection"
    const method = r.text();
    if (method !== "publickey" && method !== "publickey-hostbound-v00@openssh.com") return { kind: "data" };
    return { kind: "login", user, session };
  } catch { return { kind: "data" }; }
}

/** The words a person reads before approving. Names and fingerprints only, never key material. */
export function summarize({ what, name, host, forwarded }) {
  const k = `ssh key "${name}"`;
  const tail = forwarded ? " (forwarded from another machine)" : "";
  if (what.kind === "login") return `log in as ${what.user} to ${host === "unbound" ? "an unverified host" : "host " + host} with ${k}${tail}`;
  if (what.kind === "sshsig") return (what.namespace === "git" ? "sign a git commit (SSHSIG namespace git)" : `sign data (SSHSIG namespace ${what.namespace})`) + ` with ${k}${tail}`;
  return `sign data for ${host === "unbound" ? "an unverified host" : "host " + host} with ${k}${tail}`;
}

/**
 * @typedef {{ name: string, blob: Buffer, comment?: string }} Identity
 * @typedef {{ name: string, fingerprint: string, host: string, expires: number, at: number }} Lease
 */

export class SshAgent {
  /**
   * @param {{
   *   identities: () => Promise<Identity[]>,
   *   privateKey: (name: string) => Promise<import("./keys.js").SshKey>,
   *   approve: (req: { summary: string, name: string, fingerprint: string, host: string, kind: string, id: string }) => Promise<boolean>,
   *   audit: (ok: boolean, name: string, host: string, why: string) => void,
   *   onApproved?: (lease: Lease) => void,
   *   isLocked?: () => Promise<boolean>,
   *   now?: () => number,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now || Date.now;
    /** @type {Map<string, Lease>} */
    this.leases = new Map();
    /** Requests a person was asked about and did not approve, newest last, for `approvals`. */
    /** @type {{ id: string, name: string, fingerprint: string, host: string, summary: string, at: number }[]} */
    this.waiting = [];
  }

  /** Every lease ends: the vault locked, or a person asked. */
  clear() { this.leases.clear(); this.waiting.length = 0; }

  /** @param {{ fingerprint?: string, name?: string, host?: string }} [by] @returns {number} how many ended */
  forget(by = {}) {
    let n = 0;
    for (const [k, l] of this.leases) {
      if ((by.fingerprint && l.fingerprint !== by.fingerprint) || (by.name && l.name !== by.name) || (by.host && l.host !== by.host)) continue;
      this.leases.delete(k); n++;
    }
    return n;
  }

  /** Live leases, and requests still waiting for a person. */
  approvals() {
    const t = this.now();
    for (const [k, l] of this.leases) if (l.expires <= t) this.leases.delete(k);
    return { leases: [...this.leases.values()].map(l => ({ ...l })), waiting: this.waiting.map(w => ({ ...w })) };
  }

  /** A person approved a waiting request (or named a key and host): lease it. */
  grant({ name, fingerprint: fp, host }) {
    const lease = { name, fingerprint: fp, host, at: this.now(), expires: this.now() + LEASE_MS };
    this.leases.set(`${fp}|${host}`, lease);
    this.waiting = this.waiting.filter(w => !(w.fingerprint === fp && w.host === host));
    return lease;
  }

  /** Serve one connection. @param {net.Socket} sock */
  connection(sock) {
    let buf = Buffer.alloc(0);
    let chain = Promise.resolve();
    /** @type {{ host: string, session: Buffer, forwarding: boolean }[]} */
    const binds = [];
    sock.on("data", chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len < 1 || len > MAX_MESSAGE) { sock.destroy(); return; }
        if (buf.length < 4 + len) break;
        const msg = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        chain = chain.then(() => this.message(msg, binds)).catch(() => byte(FAILURE)).then(reply => {
          if (!sock.destroyed) sock.write(Buffer.concat([u32(reply.length), reply]));
        });
      }
    });
    sock.on("error", () => {});
  }

  /** @param {Buffer} msg @param {{ host: string, session: Buffer, forwarding: boolean }[]} binds @returns {Promise<Buffer>} */
  async message(msg, binds) {
    const r = new Reader(msg);
    const type = r.byte();
    if (type === REQUEST_IDENTITIES) {
      const ids = await this.deps.identities();
      return Buffer.concat([byte(IDENTITIES_ANSWER), u32(ids.length), ...ids.flatMap(i => [str(i.blob), str(i.comment || i.name)])]);
    }
    if (type === SIGN_REQUEST) return this.signRequest(Buffer.from(r.string()), Buffer.from(r.string()), r.left >= 4 ? r.uint32() : 0, binds);
    if (type === EXTENSION) {
      const ext = r.text();
      if (ext !== "session-bind@openssh.com") return byte(FAILURE);
      const hostKey = Buffer.from(r.string()), session = Buffer.from(r.string()), sig = Buffer.from(r.string());
      const forwarding = r.bool();
      // A bind whose signature does not check is a lie about where we are logging in.
      let ok = false;
      try { ok = verify(hostKey, session, sig); } catch { ok = false; }
      if (!ok) return byte(FAILURE);
      binds.push({ host: fingerprint(hostKey), session, forwarding });
      return byte(SUCCESS);
    }
    // add, remove, remove-all, lock, unlock, smartcard: keys come from the vault, not this socket.
    return byte(FAILURE);
  }

  /** @param {Buffer} blob @param {Buffer} data @param {number} flags @param {{ host: string, session: Buffer, forwarding: boolean }[]} binds */
  async signRequest(blob, data, flags, binds) {
    const fp = fingerprint(blob);
    if (this.deps.isLocked && (await this.deps.isLocked())) this.clear();
    const id = (await this.deps.identities()).find(i => i.blob.equals(blob));
    if (!id) return byte(FAILURE);
    const last = binds[binds.length - 1];
    const host = last ? last.host : "unbound";
    const forwarded = binds.some(b => b.forwarding);
    const what = describe(data);
    const audit = (ok, why) => this.deps.audit(ok, id.name, host, why);
    // A login signs over the session id; when the connection was bound, it must be that session.
    if (what.kind === "login" && last && !what.session.equals(last.session)) { audit(false, "session id does not match the bound host"); return byte(FAILURE); }
    const leaseable = !forwarded && what.kind !== "sshsig";
    const key = `${fp}|${host}`;
    const lease = this.leases.get(key);
    const label = what.kind === "sshsig" ? `sshsig ${what.namespace}` : what.kind;
    if (!(leaseable && lease && lease.expires > this.now())) {
      const summary = summarize({ what, name: id.name, host, forwarded });
      const reqId = "s_" + crypto.randomBytes(6).toString("base64url");
      let yes = false;
      try { yes = await this.deps.approve({ summary, name: id.name, fingerprint: fp, host, kind: what.kind, id: reqId }); } catch { yes = false; }
      if (!yes) {
        this.waiting = [...this.waiting.filter(w => !(w.fingerprint === fp && w.host === host)), { id: reqId, name: id.name, fingerprint: fp, host, summary, at: this.now() }].slice(-20);
        audit(false, `${label}: not approved`);
        return byte(FAILURE);
      }
      if (leaseable) { const l = this.grant({ name: id.name, fingerprint: fp, host }); if (this.deps.onApproved) this.deps.onApproved(l); }
    }
    let k;
    try { k = await this.deps.privateKey(id.name); } catch (e) { audit(false, `${label}: ${/** @type {any} */ (e).code === "locked" ? "vault locked" : "key unavailable"}`); return byte(FAILURE); }
    if (!k.blob.equals(blob)) { audit(false, `${label}: key changed`); return byte(FAILURE); }
    let sig;
    try { sig = sign(k, data, flags); } catch (e) { audit(false, `${label}: ${/** @type {any} */ (e).code === "sha1" ? "ssh-rsa (SHA-1) refused" : "sign failed"}`); return byte(FAILURE); }
    audit(true, label + (forwarded ? " (forwarded)" : ""));
    return Buffer.concat([byte(SIGN_RESPONSE), str(sig)]);
  }
}

/**
 * Listen on a unix socket for the agent: the folder is made 0700 and the socket chmod 0600, and
 * a stale socket from a crashed vyred is replaced (only a socket; any other file is refused).
 * @param {string} socketPath @param {SshAgent} agent @returns {Promise<{ path: string, close(): Promise<void> }>}
 */
export async function listen(socketPath, agent) {
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  try {
    const st = fs.lstatSync(socketPath);
    if (!st.isSocket()) throw new Error(`${socketPath} exists and is not a socket; refusing to replace it`);
    fs.unlinkSync(socketPath);
  } catch (e) { if (/** @type {any} */ (e).code !== "ENOENT") throw e; }
  const open = new Set();
  const server = net.createServer(sock => { open.add(sock); sock.on("close", () => open.delete(sock)); agent.connection(sock); });
  const old = process.umask(0o177);
  try { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve(undefined)); }); }
  finally { process.umask(old); }
  fs.chmodSync(socketPath, 0o600);
  return {
    path: socketPath,
    close: () => new Promise(resolve => { for (const s of open) s.destroy(); server.close(() => { try { fs.unlinkSync(socketPath); } catch {} resolve(undefined); }); }),
  };
}
