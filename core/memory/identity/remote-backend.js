// @ts-check
// A backend for the sealed stores over a remote, per-member object storage on a team server (windows' member storage). The stores' core is synchronous (a store's write-through hooks, the identity home) so
// this keeps a local cache of the person's ciphertext objects and speaks to the server in two async steps the store's proxy calls around each operation:
//   pull()   list the server's objects (name, sha256, size), fetch the ones that changed, drop the ones that are gone: the phone sees what the laptop wrote
//   flush()  send the queued writes in order, each as a compare-and-set on the sha this device last saw; a write that lost makes flush() throw `conflict`, the queue is dropped and the next pull() reads the winner
// The transport is five calls (the server sees names, ciphertext and shas, nothing else):
//   list(prefix) -> [{ name, sha, size }]    get(name) -> Buffer | null    put(name, bytes, { ifMatch }) -> { ok }    delete(name, { ifMatch }) -> { ok }
// where ifMatch is the sha256 the writer last saw, or null for "must not exist". The same four sync calls as FileBackend (put, get, list, delete) plus putIf, so a store cannot tell the two apart.
import crypto from "node:crypto";

const sha = (/** @type {Buffer} */ b) => crypto.createHash("sha256").update(b).digest("hex");
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/**
 * @typedef {{ list(prefix: string): Promise<{ name: string, sha: string, size: number }[]>, get(name: string): Promise<Buffer|null>,
 *   put(name: string, bytes: Buffer, o: { ifMatch: string|null }): Promise<{ ok: boolean }>, delete(name: string, o: { ifMatch: string|null }): Promise<{ ok: boolean }> }} Transport
 */

export class RemoteBackend {
  /** @param {Transport} transport @param {{ prefixes: string[], name?: string }} o the folders of the server's storage this backend mirrors (the person's own) */
  constructor(transport, o) {
    this.t = transport; this.prefixes = o.prefixes; this.name = o.name || "the team server";
    /** @type {Map<string, Buffer>} */ this.cache = new Map();
    /** the sha the server held when this device last read (or wrote) each object @type {Map<string, string>} */ this.seen = new Map();
    /** @type {{ op: "put"|"delete", name: string, bytes?: Buffer, ifMatch: string|null }[]} */ this.queue = [];
  }

  // ---- the synchronous face (what a store calls)
  /** @param {string} name @returns {Buffer|null} */
  get(name) { return this.cache.get(name) || null; }
  /** Immediate children of a prefix, as FileBackend lists them. @param {string} prefix @returns {string[]} */
  list(prefix) {
    const base = prefix.replace(/\/$/, "") + "/", out = new Set();
    for (const n of this.cache.keys()) if (n.startsWith(base)) out.add(base + n.slice(base.length).split("/")[0]);
    return [...out];
  }
  /** @param {string} name @param {Buffer|string} bytes */
  put(name, bytes) { const b = Buffer.from(bytes); this.queue.push({ op: "put", name, bytes: b, ifMatch: this.seen.has(name) ? /** @type {string} */ (this.seen.get(name)) : null }); this.cache.set(name, b); }
  /** A write that lands only if the object is what this device last saw. @param {string} name @param {Buffer|string} bytes @param {string|null} expected @returns {boolean} */
  putIf(name, bytes, expected) {
    const cur = this.cache.get(name);
    if ((cur ? sha(cur) : null) !== expected) return false;
    this.put(name, bytes);
    return true;
  }
  /** @param {string} name */
  delete(name) { this.queue.push({ op: "delete", name, ifMatch: this.seen.get(name) || null }); this.cache.delete(name); }

  // ---- the asynchronous face (the store's proxy calls it around each operation)
  /** Read the server's state into the cache. A queued write not yet sent is kept on top. */
  async pull() {
    /** @type {Map<string, { sha: string, size: number }>} */ const remote = new Map();
    for (const p of this.prefixes) for (const e of await this.t.list(p)) remote.set(e.name, e);
    const queued = new Set(this.queue.map(q => q.name));
    for (const [name, e] of remote) {
      if (queued.has(name)) continue;
      if (this.seen.get(name) === e.sha && this.cache.has(name)) continue;
      const b = await this.t.get(name);
      if (b) { this.cache.set(name, b); this.seen.set(name, sha(b)); }
    }
    for (const name of [...this.cache.keys()]) if (!remote.has(name) && !queued.has(name) && this.prefixes.some(p => name.startsWith(p))) { this.cache.delete(name); this.seen.delete(name); }
  }
  /** Send the queued writes. A write that lost to another device throws `conflict`: nothing after it is sent, the queue is dropped, and the next pull reads what the winner wrote. */
  async flush() {
    const q = this.queue; this.queue = [];
    for (let i = 0; i < q.length; i++) {
      const w = q[i];
      const r = w.op === "put" ? await this.t.put(w.name, /** @type {Buffer} */ (w.bytes), { ifMatch: w.ifMatch }) : await this.t.delete(w.name, { ifMatch: w.ifMatch });
      if (!r.ok) { for (const x of q.slice(i)) { this.cache.delete(x.name); this.seen.delete(x.name); } throw err("conflict", `another device changed ${w.name}: it is read again`); }
      if (w.op === "put") this.seen.set(w.name, sha(/** @type {Buffer} */ (w.bytes))); else this.seen.delete(w.name);
    }
  }
}
