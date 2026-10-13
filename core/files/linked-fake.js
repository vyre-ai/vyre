// @ts-check
// A fake linked source for tests: files in a map, a change log for tokens, and a record of every call. It is not Google, SharePoint or GitHub and reaches nothing.
import { PROVIDER_METHODS } from "./linked-provider.js";

const mimeOf = (/** @type {string} */ p) => /\.png$/.test(p) ? "image/png" : /\.md$/.test(p) ? "text/markdown" : "text/plain";

/** @param {{ id?: string, files?: Record<string, string> }} [o] */
export function fakeProvider({ id = "fake", files = {} } = {}) {
  /** @type {Map<string, { id: string, path: string, bytes: Buffer, rev: number, modified: number, deleted?: boolean, revs: any[] }>} */
  const store = new Map();
  /** @type {{ seq: number, id: string }[]} */ const log = [];
  let seq = 0, n = 0;
  const calls = /** @type {any[]} */ ([]);
  const touched = /** @type {any[]} */ ([]);
  const put = (/** @type {string} */ path, /** @type {Buffer} */ bytes, /** @type {string} */ by = "src") => {
    const old = [...store.values()].find(f => f.path === path && !f.deleted);
    const f = old || { id: `f${++n}`, path, bytes, rev: 0, modified: 0, revs: [] };
    f.bytes = bytes; f.rev += 1; f.modified = 1_700_000_000_000 + ++seq; f.revs.push({ rev: String(f.rev), modified: f.modified, by });
    store.set(f.id, f); log.push({ seq, id: f.id });
    return f;
  };
  for (const [p, t] of Object.entries(files)) put(p, Buffer.from(t));
  const view = (/** @type {any} */ f) => ({ id: f.id, path: f.path, name: f.path.split("/").pop(), mime: mimeOf(f.path), size: f.bytes.length, modified: f.modified, rev: String(f.rev), ...(f.deleted ? { deleted: true } : {}) });
  const find = (/** @type {any} */ e) => { const f = store.get(e.id); if (!f) throw Object.assign(new Error("not found"), { code: "not_found" }); return f; };
  const provider = {
    id, label: "Fake source", calls, touched, store,
    async pick(/** @type {string} */ person, /** @type {{ parent?: string }} */ o = {}) { calls.push(["pick", person, o.parent ?? null]); return { parent: o.parent || "root", folders: [{ id: "F1", name: "Client docs" }, { id: "F2", name: "Archive" }] }; },
    /** a change made at the source, not through Vyre */
    external: { put: (/** @type {string} */ p, /** @type {string} */ t) => put(p, Buffer.from(t), "someone"), remove: (/** @type {string} */ p) => { const f = [...store.values()].find(x => x.path === p && !x.deleted); if (f) { f.deleted = true; f.rev += 1; log.push({ seq: ++seq, id: f.id }); } } },
    async list(/** @type {any} */ link, /** @type {any} */ person, /** @type {{ token?: string }} */ o = {}) {
      calls.push(["list", person, o.token ?? null]);
      if (o.token === undefined || o.token === null) return { entries: [...store.values()].filter(f => !f.deleted).map(view), next: String(seq), full: true };
      const since = Number(o.token), ids = new Set(log.filter(l => l.seq > since).map(l => l.id));
      return { entries: [...ids].map(i => view(/** @type {any} */ (store.get(i)))), next: String(seq), full: false };
    },
    async read(/** @type {any} */ link, /** @type {any} */ person, /** @type {any} */ entry) { calls.push(["read", person, entry.id]); const f = find(entry); return { bytes: new Uint8Array(f.bytes), mime: mimeOf(f.path), rev: String(f.rev) }; },
    async write(/** @type {any} */ link, /** @type {any} */ person, /** @type {string} */ path, /** @type {Uint8Array} */ bytes, /** @type {{ baseRev?: string }} */ o = {}) {
      calls.push(["write", person, path, o.baseRev ?? null]);
      const cur = [...store.values()].find(f => f.path === path && !f.deleted);
      if (cur && o.baseRev !== undefined && String(cur.rev) !== String(o.baseRev)) throw Object.assign(new Error("the file changed at the source since you opened it"), { code: "conflict" });
      const f = put(path, Buffer.from(bytes), person); return { id: f.id, rev: String(f.rev) };
    },
    async rename(/** @type {any} */ link, /** @type {any} */ person, /** @type {any} */ entry, /** @type {string} */ to) { calls.push(["rename", person, entry.id, to]); const f = find(entry); f.path = to; f.rev += 1; log.push({ seq: ++seq, id: f.id }); return { id: f.id, rev: String(f.rev) }; },
    async delete(/** @type {any} */ link, /** @type {any} */ person, /** @type {any} */ entry) { calls.push(["delete", person, entry.id]); const f = find(entry); f.deleted = true; f.rev += 1; log.push({ seq: ++seq, id: f.id }); return { deleted: true }; },
    async versions(/** @type {any} */ link, /** @type {any} */ person, /** @type {any} */ entry) { calls.push(["versions", person, entry.id]); return find(entry).revs.map((/** @type {any} */ r) => ({ ...r })); },
  };
  void PROVIDER_METHODS;
  return provider;
}
