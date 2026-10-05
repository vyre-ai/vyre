// kernel/gateway/drive.js: VyreDrive (kernel/storage/drive.js, vault's) behind the gateway. The Drive does storage: versions, conflicts, chunks over the pool. It decides
// nothing about who may. Every call here takes a kernel-built chain and asks `authorize` with the drive.* actions (kernel/seal/uses.js) first; a refusal looks like absence;
// the actor recorded on a version is the chain's acting actor, never a name the caller supplied; a path is checked (no dot segments, no encoding) before it is turned
// into a resource; and one event says what happened, with the path and the version, never the bytes. Delete and restoring a backup are the kinds of act that need a person.
import { createGate } from "../core/gate.js";
import { isChain } from "../core/chain.js";
import { KernelError } from "../core/errors.js";
import { safePath, segment } from "../seal/uses.js";

/**
 * @param {{ space: string, drive: any, authorizer: any, log: any, enforce?: (chain: any, d: any) => void }} cfg
 */
export function createDriveGateway(cfg) {
  const { gate, check } = createGate({ authorizer: cfg.authorizer, log: cfg.log, enforce: cfg.enforce });
  const actor = (/** @type {any} */ chain) => { const a = chain.hops[chain.hops.length - 1].actor; return `${a.kind}:${a.id}`; };
  const mustChain = (/** @type {any} */ c) => { if (!isChain(c)) throw new KernelError("bad_input", "a call needs a kernel-built chain"); };
  const file = (/** @type {string} */ p) => { try { return `vyre://${cfg.space}/file/${safePath(p)}`; } catch { throw new KernelError("bad_input", "bad path"); } };
  const backup = (/** @type {string} */ n) => { try { return `vyre://${cfg.space}/file/backups/${segment(n)}`; } catch { throw new KernelError("bad_input", "bad name"); } };
  const note = (/** @type {any} */ chain, /** @type {string} */ type, /** @type {string} */ subject, /** @type {any} */ data, /** @type {any} */ decision) => { try { cfg.log.append(chain, { type, sv: 1, subject, data, vis: "subject", red: "internal" }, decision ? { decision } : {}); } catch { /* the act stands; the note is best effort */ } };
  const mapErr = (/** @type {any} */ e) => (e instanceof KernelError ? e : new KernelError(typeof e?.code === "string" ? e.code : "unavailable", "the drive could not do that"));
  const run = async (/** @type {() => Promise<any>} */ f) => { try { return await f(); } catch (e) { throw mapErr(e); } };
  /** A read of a missing or hidden thing is the same: absence. */
  const read = async (/** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ resource, /** @type {() => Promise<any>} */ f, /** @type {string} */ type, /** @type {any} */ data) => {
    mustChain(chain);
    const d = await gate(chain, action, resource);
    const r = await run(f);
    note(chain, type, resource, data, d.decision);
    return r;
  };

  return Object.freeze({
    /**
     * The Drive as the vault's file seam for ONE chain (a lent member's request, `leases.forward`): the same `read(path, version)` and `write(path, source, { maxBytes })` the vault's
     * `deps.files` has, but every call goes through the gate for this chain (`drive.read`, `drive.write`), so a route's Drive lists only ever narrow what the member may already do (FW-2).
     * The bytes move a chunk at a time and one event says what happened, never the bytes.
     */
    files(chain) {
      mustChain(chain);
      return Object.freeze({
        async read(/** @type {string} */ p, /** @type {number | null} */ version = null) {
          const d = await gate(chain, "drive.read", file(p));
          const st = await run(async () => cfg.drive.stat(p, { version }));
          note(chain, "file.accessed", file(p), { path: p, version: st.version, what: "forward" }, d.decision);
          return { ...st, stream: () => cfg.drive.stream(p, { version: st.version }) };
        },
        async write(/** @type {string} */ p, /** @type {AsyncIterable<Buffer>} */ source, /** @type {{ maxBytes: number, by?: string }} */ o) {
          const d = await gate(chain, "drive.write", file(p));
          const r = await run(() => cfg.drive.putStream(p, source, { by: actor(chain), maxBytes: o.maxBytes }));
          note(chain, "file.written", file(p), { path: p, version: r.version, bytes: r.size, what: "forward" }, d.decision);
          return { path: p, version: r.version, size: r.size, sha256: r.sha256 };
        },
      });
    },
    /** `maxBytes` refuses a file larger than that from the Drive's own metadata, before any chunk is read (`too_large`). */
    async get(chain, /** @type {string} */ p, /** @type {{ version?: number | null, maxBytes?: number }} */ o = {}) {
      if (o.version != null && (!Number.isInteger(o.version) || o.version < 1)) throw new KernelError("bad_input", "name a version number");
      return read(chain, "drive.read", file(p), async () => {
        if (o.maxBytes != null && typeof cfg.drive.stat === "function") { const st = cfg.drive.stat(p, { version: o.version ?? null }); if (st.size > o.maxBytes) throw new KernelError("too_large", "that file is larger than this call returns"); }
        return cfg.drive.get(p, { version: o.version ?? null });
      }, "file.accessed", { path: p, version: o.version ?? null }); },
    async history(chain, /** @type {string} */ p) { return read(chain, "drive.read", file(p), async () => cfg.drive.history(p), "file.accessed", { path: p, what: "history" }); },
    /** The listing shows only what the chain may read: the folder is authorized once, then each entry is asked about until a page is full. A page is at most 1,000 entries and a call looks at most 5,000, so the cost of one call is bounded whatever the folder holds. `after` is the last path the previous page covered. */
    async listPage(chain, /** @type {string} */ prefix = "", /** @type {{ limit?: number, after?: string | null }} */ o = {}) {
      mustChain(chain);
      const limit = Math.min(Math.max(Number.isInteger(o.limit) ? /** @type {number} */ (o.limit) : 500, 1), 1000);
      const folder = String(prefix).replace(/\/+$/, "");
      await gate(chain, "drive.read", folder ? `${file(folder)}/*` : `vyre://${cfg.space}/file/*`);
      const all = (await run(async () => cfg.drive.list(prefix))).map((/** @type {any} */ e) => [String(e.path ?? e.name ?? e), e]).sort((/** @type {any} */ a, /** @type {any} */ b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      const out = []; let scanned = 0, last = null, more = false;
      for (const [path, e] of all) {
        if (o.after != null && path <= o.after) continue;
        if (out.length >= limit || scanned >= 5000) { more = true; break; }
        scanned++; last = path;
        if (await check(chain, "drive.read", file(path))) out.push(e);
      }
      return { entries: out, next: more ? last : null };
    },
    async list(chain, /** @type {string} */ prefix = "") {
      const out = []; let after = null;
      for (;;) { const r = await this.listPage(chain, prefix, { limit: 1000, after }); out.push(...r.entries); if (!r.next) return out; after = r.next; }
    },
    /** A version written by this chain: `by` is the chain's actor. Two writers on one file give two versions and `conflict: true` (no merge). */
    async put(chain, /** @type {string} */ p, /** @type {Uint8Array} */ bytes, /** @type {{ base?: number | null }} */ o = {}) {
      mustChain(chain);
      if (!(bytes instanceof Uint8Array) || bytes.length > (cfg.maxBytes ?? 256 * 1024 * 1024)) throw new KernelError("bad_input", "a file is bytes, within the size limit");
      const d = await gate(chain, "drive.write", file(p));
      const r = await run(() => cfg.drive.put(p, bytes, { by: actor(chain), base: o.base ?? null }));
      note(chain, "file.written", file(p), { path: p, version: r.version, conflict: Boolean(r.conflict), bytes: bytes.length }, d.decision);
      return r;
    },
    /**
     * Rename a folder: every file under `from` is written under `to` and the old path is tombstoned (the Drive keeps every version, so nothing is lost and the old versions stay in history).
     * It needs `drive.write` on both folders and nothing more: it is the same person's own files under a new name, not a delete. One event says what moved, never the bytes.
     * @returns {Promise<{ moved: number }>}
     */
    async moveFolder(chain, /** @type {string} */ from, /** @type {string} */ to) {
      mustChain(chain);
      const a = String(from).replace(/\/+$/, ""), b = String(to).replace(/\/+$/, "");
      if (!a || !b || a === b || b.startsWith(a + "/") || a.startsWith(b + "/")) throw new KernelError("bad_input", "name two different folders, neither inside the other");
      const d1 = await gate(chain, "drive.write", `${file(a)}/*`);
      await gate(chain, "drive.write", `${file(b)}/*`);
      const entries = await run(async () => cfg.drive.list(a));
      // Every file is checked BEFORE anything moves: read and write of the source, write of the destination, each under this chain. One refusal aborts the whole move (a file with its own
      // restriction is never moved or tombstoned on a folder-wide grant).
      const plan = entries.map((/** @type {any} */ e) => { const path = String(e.path ?? e.name ?? e); return { path, dest: `${b}/${path.slice(a.length + 1)}` }; });
      for (const f of plan) {
        if (!(await check(chain, "drive.read", file(f.path))) || !(await check(chain, "drive.write", file(f.path))) || !(await check(chain, "drive.write", file(f.dest)))) throw new KernelError("not_found", "that folder is not yours to move");
      }
      let moved = 0;
      for (const f of plan) {
        await run(async () => { const bytes = await cfg.drive.get(f.path, {}); await cfg.drive.put(f.dest, bytes, { by: actor(chain) }); await cfg.drive.delete(f.path, { by: actor(chain) }); });
        moved++;
      }
      note(chain, "file.moved", `${file(b)}`, { from: a, to: b, files: moved }, d1.decision);
      return { moved };
    },
    /** A restore is a new version, and its own admin act: an assistant's `drive.write` never reaches it. */
    async restore(chain, /** @type {string} */ p, /** @type {number} */ version, /** @type {{ presence?: any }} */ opt = {}) {
      mustChain(chain);
      if (!Number.isInteger(version) || version < 1) throw new KernelError("bad_input", "name a version number");
      const d = await gate(chain, "drive.restore", file(p), opt.presence ? { presence: opt.presence } : {});
      const r = await run(() => cfg.drive.restore(p, version, { by: actor(chain) }));
      note(chain, "file.restored", file(p), { path: p, from: version, version: r.version }, d.decision);
      return r;
    },
    /** Removing a file for good is an outward act (`drive.delete`): it asks. */
    async delete(chain, /** @type {string} */ p) {
      mustChain(chain);
      const d = await gate(chain, "drive.delete", file(p));
      const r = await run(() => cfg.drive.delete(p, { by: actor(chain) }));
      note(chain, "file.deleted", file(p), { path: p }, d.decision);
      return r;
    },
    async prune(chain, /** @type {any} */ o = {}) {
      mustChain(chain);
      const d = await gate(chain, "drive.delete", `vyre://${cfg.space}/file/*`);
      const r = await run(() => cfg.drive.prune(o));
      note(chain, "file.pruned", `vyre://${cfg.space}/file/*`, { keep: o.keep ?? null }, d.decision);
      return r;
    },
    async backup(chain, /** @type {string} */ name, /** @type {Uint8Array} */ bytes) {
      mustChain(chain);
      const d = await gate(chain, "drive.write", backup(name));
      const r = await run(() => cfg.drive.backup(name, bytes));
      note(chain, "file.written", backup(name), { backup: name, bytes: bytes.length }, d.decision);
      return r;
    },
    async backups(chain, /** @type {string} */ name) { return read(chain, "drive.read", backup(name), async () => cfg.drive.backups(name), "file.accessed", { backup: name }); },
    /** Bringing a backup back replaces what is there: its own admin act (`drive.restore`), like restore. */
    async restoreBackup(chain, /** @type {string} */ name, /** @type {string | null} */ id = null, /** @type {{ presence?: any }} */ opt = {}) {
      mustChain(chain);
      const d = await gate(chain, "drive.restore", backup(name), opt.presence ? { presence: opt.presence } : {});
      const r = await run(() => cfg.drive.restoreBackup(name, id));
      note(chain, "file.restored", backup(name), { backup: name, id }, d.decision);
      return r;
    },
    async pruneBackups(chain, /** @type {string} */ name, /** @type {number} */ keep = 7) {
      mustChain(chain);
      const d = await gate(chain, "drive.delete", backup(name));
      const r = await run(() => cfg.drive.pruneBackups(name, keep));
      note(chain, "file.pruned", backup(name), { backup: name, keep }, d.decision);
      return r;
    },
  });
}
