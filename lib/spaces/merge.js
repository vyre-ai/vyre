// @ts-check
// The device-side merge API (contract 10.6). The device holds one link per Space and reads each Space through its own
// gateway, separately. Lists, boards, search and Now are merged HERE, on the device: sorted and grouped locally, every
// row tagged with its Space name and colour. No server joins data across Spaces. The merged result is for the person's
// eyes only (`humanOnly: true`); an assistant session built from it is a multi-Space session (see sessionPolicy).

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { BridgeError, sessionPolicy } from "./bridges.js";

/**
 * @typedef {{ space: string, name: string, color: string, read: (op: any) => Promise<any>|any }} MergeSource
 * A source reads ONE Space through that Space's own gateway link. It returns an array of rows, or `{ rows }`.
 */

const isSealedShape = (/** @type {any} */ v) => !!v && typeof v === "object" && !Array.isArray(v) && typeof v.sealed === "string" && "ref" in v;
/** Defence in depth: a sealed reference never rides in a merged row, only a placeholder. */
function scrub(/** @type {any} */ v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (isSealedShape(v)) return { sealed: v.sealed, present: v.present !== false, valid_format: v.valid_format !== false };
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
}
const cmp = (/** @type {any} */ a, /** @type {any} */ b) => (a < b ? -1 : a > b ? 1 : 0);
const get = (/** @type {any} */ row, /** @type {string} */ field) => (row && typeof row === "object" ? (field in row ? row[field] : row.data?.[field]) : undefined);

/** Stable sort by `[{field, dir}]`, nulls last, then Space order, then arrival order. */
function sortRows(/** @type {any[]} */ rows, /** @type {{field:string, dir?:"asc"|"desc"}[]} */ sort, /** @type {string[]} */ order) {
  const idx = rows.map((r, i) => ({ r, i }));
  idx.sort((x, y) => {
    for (const s of sort) {
      const a = get(x.r, s.field), b = get(y.r, s.field);
      const an = a == null, bn = b == null;
      if (an || bn) { if (an && bn) continue; return an ? 1 : -1; }
      const c = cmp(a, b);
      if (c) return s.dir === "desc" ? -c : c;
    }
    return cmp(order.indexOf(x.r._space.id), order.indexOf(y.r._space.id)) || x.i - y.i;
  });
  return idx.map(x => x.r);
}

/**
 * Read every source separately and merge on the device. A failing or revoked source degrades alone.
 * @param {MergeSource[]} sources
 * @param {any} op  passed unchanged to each source's read
 * @param {{ sort?: {field:string, dir?:"asc"|"desc"}[], groupBy?: string, limit?: number }} [options]
 */
export async function mergeRead(sources, op, options = {}) {
  if (!Array.isArray(sources)) throw new BridgeError("bad_input", "sources must be a list");
  const order = sources.map(s => s.space);
  const settled = await Promise.allSettled(sources.map(async s => s.read(op)));
  /** @type {any[]} */ const rows = [];
  const status = sources.map((s, i) => {
    const r = settled[i];
    if (r.status === "rejected") {
      const code = /** @type {any} */ (r.reason)?.code;
      return { space: s.space, name: s.name, color: s.color, status: code === "revoked" ? "revoked" : "unavailable", count: 0, reason: typeof code === "string" ? code : "error" };
    }
    const list = Array.isArray(r.value) ? r.value : Array.isArray(r.value?.rows) ? r.value.rows : null;
    if (!list) return { space: s.space, name: s.name, color: s.color, status: "unavailable", count: 0, reason: "bad_result" };
    for (const row of list) {
      const clean = scrub(row);
      rows.push({ ...clean, _space: { id: s.space, name: s.name, color: s.color }, _key: `${s.space}:${clean?.id ?? rows.length}` });
    }
    return { space: s.space, name: s.name, color: s.color, status: "ok", count: list.length };
  });
  let out = sortRows(rows, options.sort ?? [], order);
  if (Number.isFinite(options.limit)) out = out.slice(0, /** @type {number} */ (options.limit));
  /** @type {{key:string, rows:any[]}[]|undefined} */ let groups;
  if (options.groupBy) {
    const m = new Map();
    for (const r of out) {
      const k = options.groupBy === "space" ? r._space.name : String(get(r, options.groupBy) ?? "");
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    groups = [...m].map(([key, rs]) => ({ key, rows: rs }));
  }
  return { humanOnly: /** @type {true} */ (true), rows: out, groups, sources: status, unavailable: status.filter(s => s.status !== "ok").map(s => s.space), complete: status.every(s => s.status === "ok") };
}

/** Merged search: each Space searches itself, hits sort by score then Space order. */
export function mergedSearch(/** @type {MergeSource[]} */ sources, /** @type {string} */ text, /** @type {any} */ options = {}) {
  return mergeRead(sources, { kind: "search", text, limit: options.limit }, { sort: [{ field: "score", dir: "desc" }], ...options });
}
/** Merged Now: each Space answers for itself, rows sort by due time, undated last. */
export function mergedNow(/** @type {MergeSource[]} */ sources, /** @type {any} */ options = {}) {
  return mergeRead(sources, { kind: "now" }, { sort: [{ field: "due", dir: "asc" }], ...options });
}

/**
 * An assistant asked to work on a merged view becomes a multi-Space session. Returns the policy over the Spaces that
 * actually contributed rows. `residencyBySpace` is each Space's residency policy as its gateway reported it.
 */
export function sessionFromMerge(/** @type {{humanOnly:true, sources:any[]}} */ merged, /** @type {Record<string, any>} */ residencyBySpace = {}) {
  if (!merged || merged.humanOnly !== true) throw new BridgeError("bad_input", "only a merged result can start a multi-Space session");
  const used = merged.sources.filter(s => s.status === "ok").map(s => ({ space: s.space, residency: residencyBySpace[s.space] }));
  if (used.length === 0) throw new BridgeError("not_found", "no Space contributed");
  return sessionPolicy(used);
}

/**
 * A per-Space cache, encrypted with AES-256-GCM under a key from `deriveKey`, which is tied to that Space's grant.
 * Wiped when the grant is revoked. Space and name are authenticated data, so an entry cannot be moved between caches.
 * @param {{ spaceId: string, deriveKey: (info:{spaceId:string, purpose:string}) => Promise<Buffer>|Buffer, grantId?: string, storage?: Map<string, any>, randomBytes?: (n:number)=>Buffer }} cfg
 */
export function createSpaceCache(cfg) {
  const { spaceId } = cfg;
  if (!spaceId || typeof cfg.deriveKey !== "function") throw new BridgeError("bad_input", "a cache needs a Space and a key derivation");
  const storage = cfg.storage ?? new Map();
  const rnd = cfg.randomBytes ?? randomBytes;
  let revoked = false;
  /** @type {Buffer|null} */ let key = null;
  const slot = (/** @type {string} */ name) => createHash("sha256").update(`${spaceId}\0${name}`).digest("hex");
  const getKey = async () => {
    if (revoked) throw new BridgeError("revoked", "this Space's cache was wiped when its grant was revoked");
    if (!key) {
      const k = await cfg.deriveKey({ spaceId, purpose: "space-cache" });
      if (!Buffer.isBuffer(k) || k.length !== 32) throw new BridgeError("bad_input", "the cache key must be 32 bytes");
      key = Buffer.from(k);
    }
    return key;
  };
  return {
    spaceId,
    async put(/** @type {string} */ name, /** @type {any} */ value) {
      const k = await getKey();
      const iv = rnd(12);
      const c = createCipheriv("aes-256-gcm", k, iv);
      c.setAAD(Buffer.from(`${spaceId}\0${name}`));
      const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
      storage.set(slot(name), { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") });
    },
    async get(/** @type {string} */ name) {
      const k = await getKey();
      const e = storage.get(slot(name));
      if (!e) return undefined;
      const d = createDecipheriv("aes-256-gcm", k, Buffer.from(e.iv, "base64"));
      d.setAAD(Buffer.from(`${spaceId}\0${name}`));
      d.setAuthTag(Buffer.from(e.tag, "base64"));
      try { return JSON.parse(Buffer.concat([d.update(Buffer.from(e.ct, "base64")), d.final()]).toString("utf8")); }
      catch { storage.delete(slot(name)); return undefined; }
    },
    async delete(/** @type {string} */ name) { return storage.delete(slot(name)); },
    /** Call when the Space's grant is revoked (`info.grantId` or `info.space` matching). Wipes entries and the key. */
    onRevoke(/** @type {{grantId?:string, space?:string}} */ info = {}) {
      const hit = (info.grantId !== undefined && info.grantId === cfg.grantId) || (info.space !== undefined && info.space === spaceId) || (info.grantId === undefined && info.space === undefined);
      if (!hit) return 0;
      const n = storage.size;
      storage.clear();
      if (key) key.fill(0);
      key = null; revoked = true;
      return n;
    },
    get size() { return storage.size; },
    get revoked() { return revoked; },
  };
}
