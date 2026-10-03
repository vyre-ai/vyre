// core/space-sessions/workcopy.js: the encrypted working copy of a session that runs on a member's computer (Wink design section 7).
// Files live under one directory as AES-256-GCM blobs, named by a keyed hash so the folder shows no file names. The key is derived per
// session (HKDF) from a key the Space's vault releases at the moment of use and is held in memory only: no env file, nothing on disk.
// Every change is pushed back to the Space, debounced. The Space's version wins a clash; the caller's file is kept as a sibling version.
// Credentials come from the vault through a port and are never written here: a write that holds a handed-out credential is refused.
import crypto from "node:crypto";
import { sha256, canonical } from "../../kernel/core/canonical.js";

const DEBOUNCE_MS = 750;
const norm = (/** @type {string} */ p) => {
  if (typeof p !== "string" || !p || p.includes("\0") || p.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(p)) throw Object.assign(new Error("a path inside the working copy"), { code: "bad_input" });
  return p.replace(/\/+/g, "/");
};

/**
 * @param {{ dir: string, space: string, session: string, device: string, token: () => number,
 *   fs: { mkdir(p: string, o?: any): Promise<any>, readFile(p: string): Promise<Buffer>, writeFile(p: string, d: Buffer): Promise<any>, readdir(p: string): Promise<string[]>, rm(p: string, o?: any): Promise<any> },
 *   vault: { release(q: { space: string, session: string, purpose: string }): Promise<Buffer>, credential?(q: { space: string, session: string, name: string }): Promise<string> },
 *   transport: any, timers?: { set(fn: () => void, ms: number): any, clear(h: any): void }, debounce_ms?: number, emit?: (type: string, data: any) => void }} cfg
 */
export async function openWorkcopy(cfg) {
  const timers = cfg.timers || { set: (/** @type {any} */ f, /** @type {number} */ ms) => setTimeout(f, ms), clear: (/** @type {any} */ h) => clearTimeout(h) };
  const emit = cfg.emit || (() => {});
  const master = Buffer.from(await cfg.vault.release({ space: cfg.space, session: cfg.session, purpose: "workcopy" }));
  if (master.length < 16) throw Object.assign(new Error("the vault gave no usable key"), { code: "unavailable" });
  const key = Buffer.from(crypto.hkdfSync("sha256", master, Buffer.from(`${cfg.space}\0${cfg.session}`), "vyre workcopy v1", 32));
  const nameKey = Buffer.from(crypto.hkdfSync("sha256", master, Buffer.from(`${cfg.space}\0${cfg.session}`), "vyre workcopy names v1", 32));
  master.fill(0);
  await cfg.fs.mkdir(cfg.dir, { recursive: true });

  /** @type {Map<string, { version: number, hash: string }>} path -> the Space version this copy is based on (0 = never pushed) */ const meta = new Map();
  /** @type {Set<string>} */ const dirty = new Set();
  /** @type {Set<string>} */ const gone = new Set();
  /** @type {Set<string>} credential values handed out in this session */ const handed = new Set();
  /** @type {any} */ let timer = null;
  let pushing = Promise.resolve();
  let closed = false;

  const blobName = (/** @type {string} */ p) => crypto.createHmac("sha256", nameKey).update(p).digest("base64url") + ".enc";
  const seal = (/** @type {string} */ p, /** @type {Buffer} */ data) => {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
    c.setAAD(Buffer.from(p));
    const ct = Buffer.concat([c.update(canonical({ path: p, data: data.toString("base64") }), "utf8"), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  };
  const open = (/** @type {string} */ p, /** @type {Buffer} */ blob) => {
    const d = crypto.createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
    d.setAAD(Buffer.from(p)); d.setAuthTag(blob.subarray(12, 28));
    const j = JSON.parse(Buffer.concat([d.update(blob.subarray(28)), d.final()]).toString("utf8"));
    if (j.path !== p) throw new Error("blob is for another path");
    return Buffer.from(j.data, "base64");
  };
  const store = (/** @type {string} */ p, /** @type {Buffer} */ data) => cfg.fs.writeFile(`${cfg.dir}/${blobName(p)}`, seal(p, data));
  const readLocal = async (/** @type {string} */ p) => { try { return open(p, await cfg.fs.readFile(`${cfg.dir}/${blobName(p)}`)); } catch (e) { if (/** @type {any} */ (e).code === "ENOENT") return null; throw e; } };

  const base = (/** @type {{ path: string }} */ r) => ({ space: cfg.space, session: cfg.session, device: cfg.device, token: cfg.token(), path: r.path });

  async function flushOnce() {
    for (const path of [...gone]) {
      gone.delete(path);
      const m = meta.get(path);
      if (!m) continue;
      const r = await cfg.transport.remove({ ...base({ path }), base_version: m.version });
      if (r.stale_lease) { gone.add(path); throw Object.assign(new Error("another machine holds this session now"), { code: "stale_lease" }); }
      if (r.conflict) { gone.add(path); /* the Space changed it after we removed it: its version stands, pull it back */ gone.delete(path); await pullPath(path); } else meta.delete(path);
    }
    for (const path of [...dirty]) {
      dirty.delete(path);
      const bytes = await readLocal(path);
      if (!bytes) continue;
      const m = meta.get(path) || { version: 0, hash: "" };
      const r = await cfg.transport.push({ ...base({ path }), base_version: m.version, bytes });
      if (r.stale_lease) { dirty.add(path); throw Object.assign(new Error("another machine holds this session now"), { code: "stale_lease" }); }
      if (r.ok) { meta.set(path, { version: r.version, hash: sha256(bytes) }); emit("workcopy.synced", { path, version: r.version }); continue; }
      // The Space holds a newer version. It stays the path's content; ours is kept next to it, never merged and never dropped.
      const sib = `${path} (conflict ${cfg.device} ${Date.now().toString(36)})`;
      const s = await cfg.transport.push({ ...base({ path: sib }), base_version: 0, bytes });
      await store(sib, bytes); meta.set(sib, { version: s.ok ? s.version : 0, hash: sha256(bytes) });
      await pullPath(path);
      emit("workcopy.conflict", { path, kept_as: sib });
    }
  }
  async function pullPath(/** @type {string} */ path) {
    const got = await cfg.transport.pull({ space: cfg.space, session: cfg.session, path });
    if (!got) { meta.delete(path); try { await cfg.fs.rm(`${cfg.dir}/${blobName(path)}`, { force: true }); } catch {} return; }
    await store(path, got.bytes); meta.set(path, { version: got.version, hash: got.hash });
  }
  /** Push every change now. Concurrent flushes queue behind each other. */
  function flush() { pushing = pushing.then(() => flushOnce()); return pushing; }
  const later = () => { if (closed) return; if (timer) timers.clear(timer); timer = timers.set(() => { timer = null; flush().catch(e => emit("workcopy.error", { code: e.code || "error" })); }, cfg.debounce_ms ?? DEBOUNCE_MS); };

  return Object.freeze({
    async write(/** @type {string} */ path, /** @type {Buffer | string} */ data) {
      path = norm(path); const b = Buffer.from(data);
      const text = b.toString("utf8");
      for (const v of handed) if (v && text.includes(v)) throw Object.assign(new Error("a credential cannot be written into the working copy"), { code: "credential_in_file" });
      await store(path, b); dirty.add(path); gone.delete(path); later();
    },
    async read(/** @type {string} */ path) { return readLocal(norm(path)); },
    async remove(/** @type {string} */ path) { path = norm(path); await cfg.fs.rm(`${cfg.dir}/${blobName(path)}`, { force: true }); dirty.delete(path); if (meta.has(path)) gone.add(path); later(); },
    list() { return [...meta.keys(), ...dirty].filter((p, i, a) => a.indexOf(p) === i && !gone.has(p)).sort(); },
    /** A credential from the Space's vault, held in memory for this call's use. It is remembered only so a write of it is refused. */
    async credential(/** @type {string} */ name) {
      if (!cfg.vault.credential) throw Object.assign(new Error("no credential door"), { code: "unavailable" });
      const v = await cfg.vault.credential({ space: cfg.space, session: cfg.session, name }); if (v) handed.add(v); return v;
    },
    /** Bring the whole copy in from the Space (a resume): every path in the manifest, verified against its hash. */
    async hydrate() {
      const man = await cfg.transport.manifest({ space: cfg.space, session: cfg.session });
      for (const f of man) { await pullPath(f.path); const m = meta.get(f.path); if (!m || m.hash !== f.hash) throw Object.assign(new Error(`the Space's copy of ${f.path} did not match its hash`), { code: "integrity" }); }
      return man.length;
    },
    /** A hash over the paths, versions and content hashes: what a checkpoint records and a resume checks. */
    async manifestHash() { await flush(); const rows = [...meta].map(([p, m]) => [p, m.version, m.hash]).sort((a, b) => (a[0] < b[0] ? -1 : 1)); return sha256(canonical(rows)); },
    flush,
    /** Stop syncing, push what is left, and optionally wipe the encrypted folder. */
    async close(/** @type {{ wipe?: boolean }} */ o = {}) {
      closed = true; if (timer) timers.clear(timer);
      await flush();
      key.fill(0); nameKey.fill(0);
      if (o.wipe) await cfg.fs.rm(cfg.dir, { recursive: true, force: true });
    },
  });
}
