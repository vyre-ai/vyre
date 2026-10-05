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
  // A Drive that stores a chat's files under ids (kernel/storage/sealed-drive.js) names the stored path: authorization, grants and the log all use it, so no file or folder name is written anywhere
  // but the sealed index. A chat whose key is locked in this process cannot be named, which looks like it is not there.
  const shown = (/** @type {string} */ p) => { if (typeof cfg.drive.stored !== "function") return p; try { return cfg.drive.stored(p); } catch { throw new KernelError("unavailable", "this chat's key is not unlocked here"); } };
  const file = (/** @type {string} */ p) => { const sp = shown(p); try { return `vyre://${cfg.space}/file/${safePath(sp)}`; } catch (e) { if (e instanceof KernelError) throw e; throw new KernelError("bad_input", "bad path"); } };
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
          note(chain, "file.accessed", file(p), { path: shown(p), version: st.version, what: "forward" }, d.decision);
          return { ...st, stream: () => cfg.drive.stream(p, { version: st.version }) };
        },
        async write(/** @type {string} */ p, /** @type {AsyncIterable<Buffer>} */ source, /** @type {{ maxBytes: number, by?: string }} */ o) {
          const d = await gate(chain, "drive.write", file(p));
          const r = await run(() => cfg.drive.putStream(p, source, { by: actor(chain), maxBytes: o.maxBytes }));
          note(chain, "file.written", file(p), { path: shown(p), version: r.version, bytes: r.size, what: "forward" }, d.decision);
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
      }, "file.accessed", { path: shown(p), version: o.version ?? null }); },
    async history(chain, /** @type {string} */ p) { return read(chain, "drive.read", file(p), async () => cfg.drive.history(p), "file.accessed", { path: shown(p), what: "history" }); },
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
      note(chain, "file.written", file(p), { path: shown(p), version: r.version, conflict: Boolean(r.conflict), bytes: bytes.length }, d.decision);
      return r;
    },
    /** One folder to another: `moveFolders` with a single pair. @returns {Promise<{ moved: number }>} */
    async moveFolder(chain, /** @type {string} */ from, /** @type {string} */ to) { return this.moveFolders(chain, [[from, to]]); },
    /**
     * Move folders: every file under each `from` is written under its `to` and the old path is tombstoned (the Drive keeps every version, so nothing is lost). EVERY file of EVERY pair is
     * checked first, under this chain (`drive.read` and `drive.write` on the source, `drive.write` on the destination), and one refusal aborts the whole move before anything moves, so a set of
     * folders is never left split. One event says what moved, never the bytes.
     * @param {any} chain @param {[string, string][]} pairs @returns {Promise<{ moved: number }>}
     */
    async moveFolders(chain, pairs) {
      mustChain(chain);
      if (!Array.isArray(pairs) || !pairs.length || pairs.length > 10) throw new KernelError("bad_input", "name the folders to move");
      /** @type {{ path: string, dest: string }[]} */ const plan = [];
      /** @type {{ a: string, b: string, d: any }[]} */ const folders = [];
      for (const [from, to] of pairs) {
        const a = String(from).replace(/\/+$/, ""), b = String(to).replace(/\/+$/, "");
        if (!a || !b || a === b || b.startsWith(a + "/") || a.startsWith(b + "/")) throw new KernelError("bad_input", "name two different folders, neither inside the other");
        const d1 = await gate(chain, "drive.write", `${file(a)}/*`);
        await gate(chain, "drive.write", `${file(b)}/*`);
        folders.push({ a, b, d: d1 });
        for (const e of await run(async () => cfg.drive.list(a))) { const path = String(e.path ?? e.name ?? e); plan.push({ path, dest: `${b}/${path.slice(a.length + 1)}` }); }
      }
      for (const f of plan) {
        if (!(await check(chain, "drive.read", file(f.path))) || !(await check(chain, "drive.write", file(f.path))) || !(await check(chain, "drive.write", file(f.dest)))) throw new KernelError("not_found", "that folder is not yours to move");
      }
      for (const f of plan) await run(async () => { const bytes = await cfg.drive.get(f.path, {}); await cfg.drive.put(f.dest, bytes, { by: actor(chain) }); await cfg.drive.delete(f.path, { by: actor(chain) }); });
      for (const f of folders) note(chain, "file.moved", file(f.b), { from: shown(f.a), to: shown(f.b), files: plan.filter(p => p.path.startsWith(f.a + "/")).length }, f.d.decision);
      return { moved: plan.length };
    },
    /**
     * Remove the source files of a project that was MOVED to another Space, after the copy was verified. A Drive delete is an outward act that asks; here the person's ONE approval of the move
     * already covered it, and the proof that it was given is the source log's own `project.move_started` for this `move_id`, by this same person, within a day. Every file is still checked
     * under the caller's chain (`drive.read` and `drive.write`), nothing outside `Projects/` goes, and a file already gone is not an error (so a resumed move finishes). One event says what went.
     * @param {any} chain @param {string[]} paths @param {{ move_id: string }} o @returns {Promise<{ removed: number }>}
     */
    async removeMoved(chain, paths, o) {
      mustChain(chain);
      const who = chain.hops.length === 1 && chain.hops[0].actor.kind === "person" ? chain.hops[0].actor.id : null;
      if (!who || !o || typeof o.move_id !== "string" || !Array.isArray(paths) || paths.length > 5000) throw new KernelError("bad_input", "name the move and the files");
      const ev = typeof cfg.log.read === "function" ? cfg.log.read({ type: "project.move_started" }).find((/** @type {any} */ e) => e.data && e.data.move_id === o.move_id) : null;
      if (!ev || !String(ev.actor).startsWith(`person:${who}@`) || !(Date.now() - Number(ev.time) <= 24 * 60 * 60 * 1000)) throw new KernelError("not_found", "no such move to remove files for");
      for (const p of paths) {
        if (!/^Projects\/[^/]+\//.test(String(p))) throw new KernelError("bad_input", "only a project's own files go");
        if (!(await check(chain, "drive.read", file(p))) || !(await check(chain, "drive.write", file(p)))) throw new KernelError("not_found", "that file is not yours to remove");
      }
      let removed = 0;
      for (const p of paths) { try { await run(async () => cfg.drive.delete(p, { by: actor(chain) })); removed++; } catch (e) { if (!(e instanceof KernelError && e.code === "not_found")) throw e; } }
      note(chain, "file.deleted", `vyre://${cfg.space}/file/Projects`, { move_id: o.move_id, files: removed, what: "moved away" }, undefined);
      return { removed };
    },
    /** A restore is a new version, and its own admin act: an assistant's `drive.write` never reaches it. */
    async restore(chain, /** @type {string} */ p, /** @type {number} */ version, /** @type {{ presence?: any }} */ opt = {}) {
      mustChain(chain);
      if (!Number.isInteger(version) || version < 1) throw new KernelError("bad_input", "name a version number");
      const d = await gate(chain, "drive.restore", file(p), opt.presence ? { presence: opt.presence } : {});
      const r = await run(() => cfg.drive.restore(p, version, { by: actor(chain) }));
      note(chain, "file.restored", file(p), { path: shown(p), from: version, version: r.version }, d.decision);
      return r;
    },
    /** Removing a file for good is an outward act (`drive.delete`): it asks. */
    async delete(chain, /** @type {string} */ p) {
      mustChain(chain);
      const d = await gate(chain, "drive.delete", file(p));
      const r = await run(() => cfg.drive.delete(p, { by: actor(chain) }));
      note(chain, "file.deleted", file(p), { path: shown(p) }, d.decision);
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
