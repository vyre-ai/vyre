// @ts-check
// A chat's folders at rest (team/0.3/DESIGN-chat-keys.md): the Drive under the gateway sees only ciphertext and ids. This wraps a Drive (or anything with its methods) so that for a path inside
// `Projects/<project>/chat/<chat>/` or `Projects/<project>/made/<chat>/` every segment after the chat id is stored as an HMAC id (lib/chat-keys.js `namer`), every file's bytes are stored sealed
// under a key of the file's own (sealFile), and the names and file keys are kept in one sealed index beside the files. A server's root, an admin, anyone with the disk sees ids and ciphertext.
// The gateway still authorizes on the logical path (membership first); this only decides what is stored. A chat whose key is not unlocked in this process is locked: reads and writes
// of its files say so, and its files do not appear in a listing. Paths outside chat folders pass straight through.
import { Readable } from "node:stream";
import { namer, sealFile, openFile, openShared, shareFile, unshareFile } from "../../lib/chat-keys.js";
import { seal, open } from "../../lib/keywrap.js";

const FILES = /^Projects\/([^/]+)\/files(?:\/(.*))?$/;
const FOLDER = /^Projects\/([^/]+)\/(chat|made)\/([^/]+)(?:\/(.*))?$/;
const err = (/** @type {string} */ code, /** @type {string} */ message = code) => Object.assign(new Error(message), { code });
const NAMES = ".names";
const aad = (/** @type {string} */ chat) => `chat-index:${chat}`;
const enc = (/** @type {any} */ v) => Buffer.from(JSON.stringify(v), "utf8");

/**
 * @param {any} drive the Drive underneath
 * @param {{ projectFiles?: boolean, keysFor: (chat: string) => import("../../lib/chat-keys.js").Keys | null, projectKeysFor?: (project: string) => import("../../lib/chat-keys.js").Keys | null, sealed?: (chat: string) => boolean }} src what this process holds: a chat's keys when it is unlocked; `sealed(chat)` says whether the chat keeps its folders sealed (a chat with no ring does not, and its paths pass straight through)
 */
export function sealedDrive(drive, src) {
  /** @param {string} p */
  const parse = p => {
    const q = String(p).replace(/\/{2,}/g, "/");
    // a project's own file area is sealed like a chat folder, under the project's server-held key (its "chat" id is `project-files:<project>`, so the one code path below serves both)
    const f = src.projectFiles ? FILES.exec(q) : null;
    if (f) return { project: f[1], kind: "files", chat: `project-files:${f[1]}`, rest: f[2] === undefined || f[2] === "" ? null : f[2], root: `Projects/${f[1]}/files` };
    const m = FOLDER.exec(q); return m && (!src.sealed || src.sealed(m[3])) ? { project: m[1], kind: m[2], chat: m[3], rest: m[4] === undefined || m[4] === "" ? null : m[4], root: `Projects/${m[1]}/${m[2]}/${m[3]}` } : null;
  };
  const keysOf = (/** @type {string} */ chat) => { const k = src.keysFor(chat); if (!k) throw err("unavailable", "this chat's key is not unlocked here"); return k; };
  /** @param {string} p */
  /** A file shared to a project is found through the PROJECT's ring alone (a member who is not in the chat never holds the chat's name key): the project's sealed index of what was shared, kept in memory
   *  once loaded (`loadShared`). @type {Map<string, Map<string, any>>} */
  const shared = new Map();
  const sharedPath = (/** @type {string} */ project) => `Projects/${project}/.shared`;
  const sharedAad = (/** @type {string} */ project) => `project-shared:${project}`;
  const sharedId = (/** @type {any} */ pk, /** @type {{ kind: string, chat: string, rest: string|null }} */ w) => namer(pk).id(`${w.kind}/${w.chat}/${w.rest}`);
  /** The entry a project's index holds for this logical path, or null. @param {{ project: string, kind: string, chat: string, rest: string|null }} w */
  const sharedEntry = w => {
    const pk = src.projectKeysFor ? src.projectKeysFor(w.project) : null, m = shared.get(w.project);
    return pk && m ? m.get(sharedId(pk, w)) || null : null;
  };
  const stored = p => {
    const w = parse(p);
    if (!w || w.rest === null) return p;
    const ck = src.keysFor(w.chat);
    if (ck) { const n = namer(ck); return `${w.root}/${w.rest.split("/").map(s => n.id(s)).join("/")}`; }
    const e = sharedEntry(w);
    if (e) return e.stored;
    throw err("unavailable", "this chat's key is not unlocked here");
  };
  /** One index per chat folder root, read and written one at a time. @type {Map<string, Promise<any>>} */
  const turns = new Map();
  const turn = (/** @type {string} */ root, /** @type {() => Promise<any>} */ fn) => { const prev = turns.get(root) || Promise.resolve(), run = prev.then(fn, fn), tail = run.catch(() => {}); turns.set(root, tail); return run.finally(() => { if (turns.get(root) === tail) turns.delete(root); }); };
  /** The sealed index of a chat folder: { files: { [stored relative path]: { name, recs: { [version]: FileRec } } } }. */
  const readIndex = async (/** @type {{ root: string, chat: string }} */ w) => {
    const k = keysOf(w.chat);
    try { return JSON.parse(Buffer.from(open(JSON.parse(Buffer.from(await drive.get(`${w.root}/${NAMES}`)).toString("utf8")), k.nameKey, aad(w.chat))).toString("utf8")); } catch { return { files: {} }; }
  };
  const writeIndex = async (/** @type {{ root: string, chat: string }} */ w, /** @type {any} */ ix) => { await drive.put(`${w.root}/${NAMES}`, enc(seal(JSON.stringify(ix), keysOf(w.chat).nameKey, aad(w.chat))), { by: "sealed-drive" }); };
  const rel = (/** @type {string} */ storedPath, /** @type {{ root: string }} */ w) => storedPath.slice(w.root.length + 1);

  /** Read a project's sealed index of shared files into memory (call when the project's ring is unlocked here, and after a restart). @param {string} project */
  const loadShared = async project => {
    const pk = src.projectKeysFor ? src.projectKeysFor(project) : null;
    if (!pk) return { loaded: 0 };
    let entries = {};
    try { entries = JSON.parse(Buffer.from(open(JSON.parse(Buffer.from(await drive.get(sharedPath(project))).toString("utf8")), pk.nameKey, sharedAad(project))).toString("utf8")).entries || {}; } catch { entries = {}; }
    shared.set(project, new Map(Object.entries(entries)));
    return { loaded: Object.keys(entries).length };
  };
  const saveShared = (/** @type {string} */ project, /** @type {(m: Map<string, any>) => void} */ mutate) => turn(`project:${project}`, async () => {
    const pk = src.projectKeysFor ? src.projectKeysFor(project) : null;
    if (!pk) return;
    if (!shared.has(project)) await loadShared(project);
    const m = shared.get(project) || new Map();
    mutate(m); shared.set(project, m);
    await drive.put(sharedPath(project), enc(seal(JSON.stringify({ entries: Object.fromEntries(m) }), pk.nameKey, sharedAad(project))), { by: "sealed-drive" });
  });

  const self = {
    // the pool under the Drive (wink storage places its encrypted chunks on paired drives through it) and the path check: a chat's sealing is above them, never in them
    pool: drive.pool,
    path: (/** @type {string} */ p) => drive.path(p),
    loadShared,
    /** The path the Drive actually stores a logical path under (ids for a chat's files): what the gateway authorizes and logs, so no name reaches the kernel's log either. @param {string} p */
    stored,
    /** @param {string} p @param {Uint8Array} bytes @param {any} [o] */
    async put(p, bytes, o = {}) {
      const w = parse(p);
      if (!w || w.rest === null) return drive.put(p, bytes, o);
      const k = keysOf(w.chat), n = namer(k), sp = stored(p), r = sealFile(k, `${sp}#${Math.random().toString(36).slice(2)}`, Buffer.from(bytes));
      return turn(w.root, async () => {
        const res = await drive.put(sp, enc(r.content), o);
        const ix = await readIndex(w), key = rel(sp, w), e = (ix.files[key] ||= { name: n.seal(w.rest), recs: {} });
        e.recs[res.version] = r.rec;
        await writeIndex(w, ix);
        return res;
      });
    },
    /** @param {string} p @param {{ version?: number|null }} [o] */
    async get(p, o = {}) {
      const w = parse(p);
      if (!w || w.rest === null) return drive.get(p, o);
      if (!src.keysFor(w.chat)) {
        // not in the chat: only a file shared to the project opens, through the project's ring, at the version that was shared
        if (!shared.has(w.project)) await loadShared(w.project);
        const e = sharedEntry(w), pk = src.projectKeysFor ? src.projectKeysFor(w.project) : null;
        if (!e || !pk) throw err("unavailable", "this chat's key is not unlocked here");
        return new Uint8Array(openShared(pk, e.rec, JSON.parse(Buffer.from(await drive.get(e.stored, { version: e.ver })).toString("utf8"))));
      }
      const k = keysOf(w.chat), sp = stored(p), version = o.version ?? drive.stat(sp, {}).version;
      const box = JSON.parse(Buffer.from(await drive.get(sp, { version })).toString("utf8"));
      const rec = (await readIndex(w)).files[rel(sp, w)]?.recs?.[version];
      if (!rec) throw err("not_found");
      return new Uint8Array(openFile(k, rec, box));
    },
    /** @param {string} p @param {any} [o] */
    stat(p, o = {}) { return drive.stat(stored(p), o); },
    /** @param {string} p @param {any} [o] */
    stream(p, o = {}) { const w = parse(p); if (!w || w.rest === null) return drive.stream(p, o); return Readable.from((async function* () { yield Buffer.from(await self.get(p, o)); })()); },
    /** @param {string} p @param {AsyncIterable<Buffer>} source @param {any} [o] */
    async putStream(p, source, o = {}) {
      const w = parse(p);
      if (!w || w.rest === null) return drive.putStream(p, source, o);
      const parts = []; let size = 0;
      for await (const c of source) { size += c.length; if (o.maxBytes != null && size > o.maxBytes) throw err("too_large"); parts.push(c); }
      const r = await self.put(p, Buffer.concat(parts), o);
      return { ...r, size, sha256: null };
    },
    /** @param {string} p */
    history(p) { return drive.history(stored(p)); },
    /** Entries under a prefix, with the logical path. A chat whose key is locked here is left out. @param {string} [prefix] */
    async list(prefix = "") {
      const out = [];
      const w = prefix ? parse(`${prefix.replace(/\/+$/, "")}/x`) : null;
      const inside = Boolean(w && w.rest !== null);
      const raw = inside ? null : drive.list(prefix);
      if (inside && w) {
        // inside one chat folder (the folder itself or below): its whole index, then those under the sub-prefix
        let k = null; try { k = keysOf(w.chat); } catch { return []; }
        const n = namer(k), ix = await readIndex(w), subRaw = new Map(drive.list(w.root).map((/** @type {any} */ e) => [rel(String(e.path), w), e]));
        for (const [key, f] of Object.entries(ix.files)) {
          const e = subRaw.get(key); if (!e) continue;
          const logical = `${w.root}/${n.open(/** @type {any} */ (f).name)}`;
          if (prefix && !(logical + "/").startsWith(prefix.replace(/\/?$/, "/"))) continue;
          out.push({ ...e, path: logical });
        }
        return out;
      }
      /** @type {Map<string, any>} */ const ixs = new Map();
      for (const e of /** @type {any[]} */ (raw)) {
        const sp = String(e.path ?? e.name ?? e), w = parse(sp);
        if (/^Projects\/[^/]+\/\.shared$/.test(sp)) continue;
        if (!w || w.rest === null) { out.push(e); continue; }
        if (w.rest === NAMES || w.rest === ".ring") continue;
        let k = null; try { k = keysOf(w.chat); } catch { continue; }
        if (!ixs.has(w.root)) ixs.set(w.root, await readIndex(w));
        const f = ixs.get(w.root).files[rel(sp, w)];
        if (f) out.push({ ...e, path: `${w.root}/${namer(k).open(f.name)}` });
      }
      return out;
    },
    /** @param {string} p @param {any} [o] */
    delete(p, o) { return drive.delete(stored(p), o); },
    /** @param {string} p @param {number} version @param {any} [o] */
    async restore(p, version, o) {
      const w = parse(p);
      if (!w || w.rest === null) return drive.restore(p, version, o);
      const sp = stored(p);
      return turn(w.root, async () => { const r = await drive.restore(sp, version, o); const ix = await readIndex(w), e = ix.files[rel(sp, w)]; if (e && e.recs[version]) { e.recs[r.version] = e.recs[version]; await writeIndex(w, ix); } return r; });
    },
    /** The logical path a project's index holds for a stored one (what a share record names), or null. @param {string} sp */
    logical(sp) {
      for (const [project, m] of shared) { const pk = src.projectKeysFor ? src.projectKeysFor(project) : null; for (const e of pk ? m.values() : []) if (e.stored === sp) return `Projects/${project}/${namer(pk).open(e.name)}`; }
      return null;
    },
    /** Share one file's key to a project's ring (a wrap, never a copy). A project whose key is not held here is skipped: the kernel grant still decides who reads. @param {string} p */
    async share(p) {
      const w = parse(p); if (!w || w.rest === null) return { wrapped: false };
      const pk = src.projectKeysFor ? src.projectKeysFor(w.project) : null;
      if (!pk) return { wrapped: false };
      const k = keysOf(w.chat), sp = stored(p);
      return turn(w.root, async () => {
        const ix = await readIndex(w), e = ix.files[rel(sp, w)]; if (!e) throw err("not_found");
        const ver = Math.max(...Object.keys(e.recs).map(Number));
        e.recs[ver] = shareFile(k, e.recs[ver], pk);
        await writeIndex(w, ix);
        // and the project's own index: where the file is stored and its name, sealed under the PROJECT's ring, with the one wrap that opens it
        const rec = { ...e.recs[ver], shares: { [pk.id]: e.recs[ver].shares[pk.id] } };
        await saveShared(w.project, m => m.set(sharedId(pk, w), { stored: sp, ver, rec, name: namer(pk).seal(`${w.kind}/${w.chat}/${w.rest}`) }));
        return { wrapped: true };
      });
    },
    /** Take the share back: the file key rotates and the content is sealed again as a new version; older versions lose the project's wrap. @param {string} p @param {any} [o] */
    async unshare(p, o = {}) {
      const w = parse(p); if (!w || w.rest === null) return { rotated: false };
      const pk = src.projectKeysFor ? src.projectKeysFor(w.project) : null;
      if (!pk) return { rotated: false };
      const k = keysOf(w.chat), sp = stored(p);
      return turn(w.root, async () => {
        const ix = await readIndex(w), e = ix.files[rel(sp, w)]; if (!e) throw err("not_found");
        const ver = Math.max(...Object.keys(e.recs).map(Number));
        const box = JSON.parse(Buffer.from(await drive.get(sp, { version: ver })).toString("utf8"));
        const { rec, content } = unshareFile(k, e.recs[ver], box, pk.id, []);
        const res = await drive.put(sp, enc(content), { ...o, base: ver });
        for (const r of Object.values(e.recs)) delete /** @type {any} */ (r).shares[pk.id];
        e.recs[res.version] = rec;
        await writeIndex(w, ix);
        await saveShared(w.project, m => m.delete(sharedId(pk, w)));
        return { rotated: true, version: res.version };
      });
    },
    prune: (/** @type {any} */ o) => drive.prune(o),
    backup: (/** @type {any[]} */ ...a) => drive.backup(...a), backups: (/** @type {any[]} */ ...a) => drive.backups(...a), restoreBackup: (/** @type {any[]} */ ...a) => drive.restoreBackup(...a), pruneBackups: (/** @type {any[]} */ ...a) => drive.pruneBackups(...a),
  };
  return Object.freeze(self);
}
