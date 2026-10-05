// @ts-check
// Per-chat keys (team/0.3/DESIGN-chat-keys.md): the one implementation, over lib/keywrap.js. A chat, and a project, has a ring: epochs of a random key, each wrapped to the device keys that may read it.
// Files have a key of their own under the chat's key; sharing a file to a project wraps that file key to the project's ring (a grant, never a copy); names are encrypted, with a stable index id.
// Nothing here stores anything: every call takes a document and returns a new one; the caller (the chat or project store) keeps it. A server holds documents and ciphertext, never a key.
//
//   ring doc   { v: 1, id, epoch, epochs: { [n]: { wraps: { [holder]: wrapped } } }, names: { [n]: box } }      holder = a device key's name (its fingerprint)
//   file rec   { id, epoch, key: box, shares: { [ringId]: { epoch, box } } }                                    the file key, sealed under the chat's key, and wrapped again under each project ring it is shared to
//   a name     index id (HMAC, stable: the pool's index), and a sealed display name (random IV)

import crypto from "node:crypto";
import { newKey, seal, open, wrapForDevice, unwrapWithDevice, Keys, createRing, openRing, addHolders, removeHolders } from "./keywrap.js";

export { Keys, createRing, openRing, addHolders, removeHolders };

const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });
const fileAad = (/** @type {string} */ ring, /** @type {string} */ file) => `file-key:${ring}:${file}`;
const shareAad = (/** @type {string} */ ring, /** @type {string} */ file) => `file-share:${ring}:${file}`;
const contentAad = (/** @type {string} */ file) => `file:${file}`;

/** @typedef {{ id: string, epoch: number, key: any, shares: Record<string, { epoch: number, box: any }> }} FileRec */

// ---------------------------------------------------------------------------------------------------- files

/**
 * Seal a file: a key of its own, sealed under the ring's current key.
 * @param {Keys} k @param {string} fileId @param {Buffer|string} plain @returns {{ rec: FileRec, content: any }}
 */
export function sealFile(k, fileId, plain) {
  const fileKey = newKey(), cur = k.current();
  return { rec: { id: fileId, epoch: cur.epoch, key: seal(fileKey, cur.key, fileAad(k.id, fileId)), shares: {} }, content: seal(plain, fileKey, contentAad(fileId)) };
}

/** @param {Keys} k @param {FileRec} rec */
const fileKeyOf = (k, rec) => open(rec.key, k.at(rec.epoch), fileAad(k.id, rec.id));

/** @param {Keys} k @param {FileRec} rec @param {any} content @returns {Buffer} */
export const openFile = (k, rec, content) => open(content, fileKeyOf(k, rec), contentAad(rec.id));

/** Read a file through a project it was shared to: the project's ring key opens the share. @param {Keys} project @param {FileRec} rec @param {any} content @returns {Buffer} */
export function openShared(project, rec, content) {
  const s = rec.shares[project.id];
  if (!s) throw bad("this file is not shared to that project", "denied");
  return open(content, open(s.box, project.at(s.epoch), shareAad(project.id, rec.id)), contentAad(rec.id));
}

/** Share a file to a project: its file key is wrapped to the project's ring too. Nothing is copied. @param {Keys} k @param {FileRec} rec @param {Keys} project */
export function shareFile(k, rec, project) {
  const cur = project.current();
  return { ...rec, shares: { ...rec.shares, [project.id]: { epoch: cur.epoch, box: seal(fileKeyOf(k, rec), cur.key, shareAad(project.id, rec.id)) } } };
}

/**
 * Unshare: the project's wrap is removed and the file key ROTATES, the content sealed again under the new key, so the project keeps nothing it had not already read. Shares to other projects stay,
 * wrapped again (`keep`: those projects' keys).
 * @param {Keys} k @param {FileRec} rec @param {any} content @param {string} projectId @param {Keys[]} [keep]
 */
export function unshareFile(k, rec, content, projectId, keep = []) {
  const plain = openFile(k, rec, content);
  const { rec: fresh, content: sealed } = sealFile(k, rec.id, plain);
  let out = fresh;
  for (const p of keep) if (p.id !== projectId && rec.shares[p.id]) out = shareFile(k, out, p);
  return { rec: out, content: sealed };
}

/** After a rotation, move file keys to the newest epoch (only the holder that stays can). @param {Keys} k @param {FileRec} rec */
export function rewrapFile(k, rec) {
  const cur = k.current();
  if (rec.epoch === cur.epoch) return rec;
  return { ...rec, epoch: cur.epoch, key: seal(fileKeyOf(k, rec), cur.key, fileAad(k.id, rec.id)) };
}

// ---------------------------------------------------------------------------------------------------- names

/** Names under one ring: a stable id for the pool's index (an HMAC: the same name is the same id across epochs, and a server cannot read it) and a sealed display name. @param {Keys} k */
export function namer(k) {
  return Object.freeze({
    /** @param {string} name */ id: name => crypto.createHmac("sha256", k.nameKey).update(`name\u0000${name}`).digest("hex"),
    /** @param {string} name */ seal: name => seal(name, k.nameKey, `name:${k.id}`),
    /** @param {any} box */ open: box => open(box, k.nameKey, `name:${k.id}`).toString("utf8"),
  });
}

// ---------------------------------------------------------------------------------------------------- in process only (an agent working in a chat on a server)

/** A bundle of a ring's keys wrapped to a one-use session key, what a person's device sends a server so an agent can work in the chat; the server opens it into process memory only. @param {Keys} k @param {any} sessionPub */
export function bundleFor(k, sessionPub) {
  const body = JSON.stringify({ id: k.id, epoch: k.epoch, nameKey: k.nameKey.toString("base64url"), keys: Object.fromEntries([...k.keys].map(([n, v]) => [n, v.toString("base64url")])) });
  return wrapForDevice(Buffer.from(body), sessionPub, `chat-bundle:${k.id}`);
}

/** @param {any} bundle @param {string} id @param {any} sessionPrivate */
export function openBundle(bundle, id, sessionPrivate) {
  const b = JSON.parse(unwrapWithDevice(bundle, sessionPrivate, `chat-bundle:${id}`).toString("utf8"));
  return new Keys(b.id, new Map(Object.entries(b.keys).map(([n, v]) => [Number(n), Buffer.from(String(v), "base64url")])), Buffer.from(b.nameKey, "base64url"), b.epoch);
}

/**
 * The keys a server process holds for agents: in memory only, used under a check, dropped on lock or stop. `allowed(chat, agent)` is the kernel's answer (the chat's membership and the agent's grant);
 * an agent without it gets nothing, and what an agent is handed is plain text for the turn, never a key.
 */
export class ProcessKeys {
  /** @param {(chat: string, agent: string) => boolean | Promise<boolean>} allowed */
  constructor(allowed) { this.allowed = allowed; /** @type {Map<string, Keys>} */ this.held = new Map(); }
  /** @param {Keys} k */ hold(k) { this.held.get(k.id)?.lock(); this.held.set(k.id, k); }
  /** The keys held for a chat, or null when it is locked here. @param {string} chat */ get(chat) { return this.held.get(chat) || null; }
  /** @param {string} chat */ drop(chat) { this.held.get(chat)?.lock(); this.held.delete(chat); }
  /** Run `fn` with the keys, for an agent the kernel allows. @template T @param {string} chat @param {string} agent @param {(k: Keys) => T} fn @returns {Promise<T>} */
  async use(chat, agent, fn) {
    const k = this.held.get(chat);
    if (!k) throw bad("this chat's key is not unlocked here", "locked");
    if (!(await this.allowed(chat, agent))) throw bad("this agent may not work in that chat", "denied");
    return fn(k);
  }
  lock() { for (const k of this.held.values()) k.lock(); this.held.clear(); }
  toJSON() { throw bad("keys are never serialised", "denied"); }
}
