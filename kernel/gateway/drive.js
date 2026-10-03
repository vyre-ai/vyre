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
    async get(chain, /** @type {string} */ p, /** @type {{ version?: number | null }} */ o = {}) { return read(chain, "drive.read", file(p), () => cfg.drive.get(p, { version: o.version ?? null }), "file.accessed", { path: p, version: o.version ?? null }); },
    async history(chain, /** @type {string} */ p) { return read(chain, "drive.read", file(p), async () => cfg.drive.history(p), "file.accessed", { path: p, what: "history" }); },
    /** The listing shows only what the chain may read: each entry is asked about, and a hidden one is not there. */
    async list(chain, /** @type {string} */ prefix = "") {
      mustChain(chain);
      // The folder as a resource: its own path and one more level, so a grant on `proj/*` covers listing `proj/`.
      const folder = String(prefix).replace(/\/+$/, "");
      await gate(chain, "drive.read", folder ? `${file(folder)}/*` : `vyre://${cfg.space}/file/*`);
      const all = await run(async () => cfg.drive.list(prefix));
      const out = [];
      for (const e of all) if (await check(chain, "drive.read", file(e.path ?? e.name ?? String(e)))) out.push(e);
      return out;
    },
    /** A version written by this chain: `by` is the chain's actor. Two writers on one file give two versions and `conflict: true` (no merge). */
    async put(chain, /** @type {string} */ p, /** @type {Uint8Array} */ bytes, /** @type {{ base?: number | null }} */ o = {}) {
      mustChain(chain);
      const d = await gate(chain, "drive.write", file(p));
      const r = await run(() => cfg.drive.put(p, bytes, { by: actor(chain), base: o.base ?? null }));
      note(chain, "file.written", file(p), { path: p, version: r.version, conflict: Boolean(r.conflict), bytes: bytes.length }, d.decision);
      return r;
    },
    /** A restore is a new version. */
    async restore(chain, /** @type {string} */ p, /** @type {number} */ version) {
      mustChain(chain);
      const d = await gate(chain, "drive.write", file(p));
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
    /** Bringing a backup back replaces what is there: a write by a person's act, like restore. */
    async restoreBackup(chain, /** @type {string} */ name, /** @type {string | null} */ id = null) {
      mustChain(chain);
      const d = await gate(chain, "drive.write", backup(name));
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
