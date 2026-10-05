// @ts-check
// The Personal backup (team/0.3/DESIGN-basic-backup.md): a person's personal projects and chats (the device's row files and the projects' folders) kept as ciphertext on a team server they belong to.
//
// One backup key (BK), sealed under the person's identity memory key (the IMK of core/memory/identity), which every device of theirs and their recovery code already wrap: so every device in the
// identity's list opens the backup, a device added to the identity home opens it at once, and the recovery code restores it onto a new device, with no second ring to keep in step. Files are cut into chunks of up to 4 MiB; a chunk's
// id is an HMAC of its plaintext under a key derived from BK, so an unchanged chunk keeps its id (incremental) and the server cannot confirm that it holds a known file; each chunk is AES-256-GCM under BK,
// bound to its id. A manifest lists every item and is written LAST, in one put, so an interrupted run leaves the previous manifest the newest and the chunks already up are skipped by the next run (resumable).
// The server (any backend with put/get/list/delete) sees ciphertext, names of random ids, sizes and times of runs: never a file name or a byte of content.

import crypto from "node:crypto";
import { newKey, seal, open, sha256 } from "../../../lib/keywrap.js";

export const CHUNK = 4 * 1024 * 1024;
/** Manifests kept after a successful run. */
export const KEEP = 3;
/** "ok" means nothing that changed longer ago than this is missing from the newest manifest (ruling: an hour). */
export const FRESH_MS = 60 * 60 * 1000;

const bad = (/** @type {string} */ m, code = "bad_input") => Object.assign(new Error(m), { code });
const dir = (/** @type {string} */ id) => `backup/${id}`;
const aadChunk = (/** @type {string} */ id, /** @type {string} */ cid) => `vyre-backup/${id}/chunk/${cid}`;
const aadManifest = (/** @type {string} */ id, /** @type {number} */ rev) => `vyre-backup/${id}/manifest/${rev}`;
const aadKey = (/** @type {string} */ id) => `vyre-backup/${id}/key`;
const rev = (/** @type {number} */ n) => String(n).padStart(10, "0");
const text = (/** @type {any} */ v) => Buffer.from(JSON.stringify(v), "utf8");
const json = (/** @type {Uint8Array|null} */ b) => (b ? JSON.parse(Buffer.from(b).toString("utf8")) : null);

/**
 * @typedef {{ kind: "file"|"rows", name: string, size: number, mtime: number, read: () => Buffer|Promise<Buffer> }} Item
 * @typedef {{ put(name: string, bytes: Buffer|string): any, get(name: string): any, list(prefix: string): any, delete(name: string): any }} Backend
 * @typedef {{ kind: "file"|"rows", name: string, size: number, mtime: number, hash: string, chunks: string[] }} Entry
 * @typedef {{ v: 1, rev: number, at: number, items: Entry[] }} Manifest
 */

export class Backup {
  /** @param {{ backend: Backend, identity: string, key: Buffer, clock?: () => number }} o */
  constructor(o) { this.backend = o.backend; this.id = o.identity; this.key = o.key; this.clock = o.clock || Date.now; this.idKey = Buffer.from(crypto.hkdfSync("sha256", o.key, Buffer.alloc(0), Buffer.from("vyre-backup-chunk-id"), 32)); /** @type {string|null} */ this.lastError = null; /** @type {Promise<any>|null} */ this.running = null; this.me = crypto.randomBytes(8).toString("hex"); }

  /** The first backup of an identity on a server: a new key sealed under the identity memory key. @param {{ backend: Backend, identity: string, imk: Buffer, clock?: () => number }} o */
  static async create(o) {
    if (await o.backend.get(`${dir(o.identity)}/ring.json`)) throw bad("a backup already exists for this identity here", "conflict");
    const key = newKey();
    await o.backend.put(`${dir(o.identity)}/ring.json`, text({ v: 2, box: seal(key, o.imk, aadKey(o.identity)) }));
    return new Backup({ ...o, key });
  }

  /** Open an existing backup with the identity memory key (a device's key or the recovery code open the identity home, which gives it). @param {{ backend: Backend, identity: string, imk: Buffer, clock?: () => number }} o */
  static async open(o) {
    const file = json(await o.backend.get(`${dir(o.identity)}/ring.json`));
    if (!file) throw bad("no backup for this identity on this server", "not_found");
    let key;
    try { key = open(file.box, o.imk, aadKey(o.identity)); } catch { throw bad("this identity memory key does not open the backup", "denied"); }
    return new Backup({ ...o, key });
  }

  /** One run per identity at a time: here (a second call while one runs gets the same run) and across devices (a lease on the server, so a run never trims chunks another is uploading). */
  async #lease() {
    const name = `${dir(this.id)}/lock.json`, now = this.clock();
    const held = json(await this.backend.get(name));
    if (held && held.by !== this.me && held.until > now) throw bad("a backup of this identity is already running", "busy");
    await this.backend.put(name, text({ by: this.me, until: now + 15 * 60 * 1000 }));
    const back = json(await this.backend.get(name));
    if (!back || back.by !== this.me) throw bad("a backup of this identity is already running", "busy");
    return async () => { const cur = json(await this.backend.get(name)); if (cur && cur.by === this.me) await this.backend.delete(name); };
  }

  /** @returns {Promise<Manifest|null>} the newest manifest, opened */
  async latest() {
    const names = (await this.backend.list(`${dir(this.id)}/manifests`)).filter((/** @type {string} */ n) => n.endsWith(".json")).sort();
    for (const n of names.reverse()) {
      const r = Number(n.split("/").pop()?.replace(".json", ""));
      try { return JSON.parse(Buffer.from(open(json(await this.backend.get(n)), this.key, aadManifest(this.id, r))).toString("utf8")); } catch { /* a torn or foreign one: the next older */ }
    }
    return null;
  }

  /**
   * One run: upload what the server lacks, then write the next manifest. An item whose name, size and time are unchanged is carried over without being read.
   * @param {Item[]} items
   * @returns {Promise<{ rev: number, uploaded: number, reused: number, items: number, bytes: number }>}
   */
  run(items) {
    if (this.running) return this.running;
    const p = this.#run(items).finally(() => { this.running = null; });
    this.running = p;
    return p;
  }

  /** @param {Item[]} items */
  async #run(items) {
    const release = await this.#lease();
    try {
      const prev = await this.latest();
      const had = new Map((prev ? prev.items : []).map(e => [`${e.kind}:${e.name}`, e]));
      const onServer = new Set((await this.backend.list(`${dir(this.id)}/chunks`)).map((/** @type {string} */ n) => n.split("/").pop()));
      /** @type {Entry[]} */ const out = [];
      let uploaded = 0, reused = 0, bytes = 0;
      for (const it of items) {
        const old = had.get(`${it.kind}:${it.name}`);
        if (old && old.size === it.size && old.mtime === it.mtime && old.chunks.every(c => onServer.has(c))) { out.push(old); reused++; continue; }
        const data = Buffer.from(await it.read());
        const chunks = [];
        for (let o = 0; o < data.length || (o === 0 && data.length === 0); o += CHUNK) {
          const part = data.subarray(o, o + CHUNK);
          const cid = crypto.createHmac("sha256", this.idKey).update(part).digest("hex");
          chunks.push(cid);
          if (!onServer.has(cid)) { await this.backend.put(`${dir(this.id)}/chunks/${cid}`, text(seal(part, this.key, aadChunk(this.id, cid)))); onServer.add(cid); uploaded++; bytes += part.length; }
          if (data.length === 0) break;
        }
        out.push({ kind: it.kind, name: it.name, size: data.length, mtime: it.mtime, hash: sha256(data), chunks });
      }
      // The manifest goes last, and only when every chunk it names is on the server: a chunk that is not (it was lost, or another run trimmed it) fails the run and the next one uploads it again.
      const there = new Set((await this.backend.list(`${dir(this.id)}/chunks`)).map((/** @type {string} */ n) => n.split("/").pop()));
      for (const e of out) for (const c of e.chunks) if (!there.has(c)) throw bad(`a chunk of ${e.kind === "file" ? "a file" : "a row file"} is not on the server: the next run uploads it again`, "unavailable");
      const n = (prev ? prev.rev : 0) + 1;
      /** @type {Manifest} */ const m = { v: 1, rev: n, at: this.clock(), items: out };
      await this.backend.put(`${dir(this.id)}/manifests/${rev(n)}.json`, text(seal(text(m), this.key, aadManifest(this.id, n))));
      await this.#trim(n);
      this.lastError = null;
      return { rev: n, uploaded, reused, items: out.length, bytes };
    } catch (e) { this.lastError = String(/** @type {Error} */ (e).message); throw e; }
    finally { await release().catch(() => {}); }
  }

  /** Keep the last KEEP manifests and every chunk they name; the rest go. @param {number} n */
  async #trim(n) {
    const names = (await this.backend.list(`${dir(this.id)}/manifests`)).filter((/** @type {string} */ x) => x.endsWith(".json")).sort();
    const keep = new Set(), live = new Set();
    for (const x of names.slice(-KEEP)) {
      const r = Number(x.split("/").pop()?.replace(".json", ""));
      try { const m = JSON.parse(Buffer.from(open(json(await this.backend.get(x)), this.key, aadManifest(this.id, r))).toString("utf8")); keep.add(x); for (const e of m.items) for (const c of e.chunks) live.add(c); } catch { /* unreadable: left for the next run */ }
    }
    if (keep.size === 0) return;
    for (const x of names) if (!keep.has(x) && Number(x.split("/").pop()?.replace(".json", "")) < n) await this.backend.delete(x);
    for (const c of await this.backend.list(`${dir(this.id)}/chunks`)) if (!live.has(c.split("/").pop())) await this.backend.delete(c);
  }

  /**
   * Read the newest manifest back: every item, rebuilt from its chunks and checked by hash, handed to `write`. A missing or damaged chunk is named in `missing`, never skipped silently.
   * @param {(e: { kind: string, name: string, mtime: number }, bytes: Buffer) => any} write
   * @param {{ skip?: (e: Entry) => boolean }} [o] skip: already restored (a restore that stopped resumes)
   * @returns {Promise<{ rev: number|null, restored: number, missing: { name: string, why: string }[] }>}
   */
  async restore(write, o = {}) {
    const m = await this.latest();
    if (!m) return { rev: null, restored: 0, missing: [] };
    let restored = 0;
    /** @type {{ name: string, why: string }[]} */ const missing = [];
    for (const e of m.items) {
      if (o.skip && o.skip(e)) continue;
      const parts = [];
      let why = "";
      for (const c of e.chunks) {
        const box = json(await this.backend.get(`${dir(this.id)}/chunks/${c}`));
        if (!box) { why = `chunk ${c.slice(0, 8)} is missing`; break; }
        try { parts.push(open(box, this.key, aadChunk(this.id, c))); } catch { why = `chunk ${c.slice(0, 8)} is damaged`; break; }
      }
      if (!why) { const data = Buffer.concat(parts); if (sha256(data) !== e.hash) why = "its content does not match its hash"; else { await write({ kind: e.kind, name: e.name, mtime: e.mtime }, data); restored++; continue; } }
      missing.push({ name: e.name, why });
    }
    return { rev: m.rev, restored, missing };
  }

  /**
   * What the app reads. ok: nothing that changed more than FRESH_MS ago is missing from the newest manifest; behind: such changes are waiting, or the last attempt failed.
   * @param {Item[]} items what the device holds now (name, size, mtime; content is not read)
   * @param {string|null} to the team Space's name
   * @returns {Promise<{ to: string|null, last: number|null, state: "ok"|"behind"|"none" }>}
   */
  async status(items, to) {
    const m = await this.latest();
    const have = new Map((m ? m.items : []).map(e => [`${e.kind}:${e.name}`, e]));
    const now = this.clock();
    const waiting = items.some(it => { const e = have.get(`${it.kind}:${it.name}`); return !(e && e.size === it.size && e.mtime === it.mtime) && now - it.mtime > FRESH_MS; });
    return { to, last: m ? m.at : null, state: this.lastError || waiting || (!m && items.length > 0 && items.some(i => now - i.mtime > FRESH_MS)) ? "behind" : "ok" };
  }
}

/** The status when there is no team server to back up to. */
export const noBackup = () => ({ to: null, last: null, state: /** @type {const} */ ("none") });
