// @ts-check
// previews/docs: a preview's documents (the `db` capability, shaped like Claude's artifact db: JSON documents at slash paths, collections, last-writer-wins). Kept in the Space's Records as one internal type,
// `preview_doc`, through the module's own service chain: one row per document { preview, path, collection, docid, data (the JSON as text), owner, updated, gone }. Every write goes through this module, so it
// also tells the live subscribers; nothing here needs Records to push changes. Records answers a stale `base_version` with a conflict, where the db is last-writer-wins: a write re-reads and tries again.
// Pure of Vyre: `store` is the kernel's records API (get, create, update, query) and `chain` its service chain, injected, so a test can give a map.

export const TYPE = "preview_doc";
export const MAX_DOC_BYTES = 256 * 1024;
export const MAX_DOCS = 25_000;
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

/** A document path (an even number of segments) or a collection path (odd); null for neither, with the reason. @param {string} p */
export function parsePath(p) {
  const s = String(p ?? "");
  if (!s || s.length > 1000) return { error: "a path is up to 1000 bytes" };
  const segs = s.split("/");
  if (segs.length > 16) return { error: "a path has at most 16 segments" };
  for (const x of segs) if (!SEG.test(x) || x === "." || x === "..") return { error: `"${x.slice(0, 40)}" is not a valid path segment` };
  return { segs, doc: segs.length % 2 === 0, collection: segs.length % 2 === 0 ? segs.slice(0, -1).join("/") : s, id: segs[segs.length - 1] };
}

/** Merge-write like Firestore: nested objects merge, anything else (arrays included) replaces. @param {any} base @param {any} patch */
export function mergeDeep(base, patch) {
  const out = { ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) out[k] = v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k]) ? mergeDeep(out[k], v) : v;
  return out;
}

/** How deep a JSON value goes. @param {any} v */
const depth = v => (v && typeof v === "object" ? 1 + Math.max(0, ...Object.values(v).map(depth)) : 0);

/** A body is a plain JSON object, within the size and depth limits. @param {any} data @returns {string | null} the problem, or null */
export function badBody(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "a document is a JSON object";
  let text; try { text = JSON.stringify(data); } catch { return "a document must be plain JSON"; }
  if (Buffer.byteLength(text) > MAX_DOC_BYTES) return "a document is at most 256 KiB";
  if (depth(data) > 32) return "a document is at most 32 levels deep";
  return null;
}

/**
 * @param {{ store: any, chain: () => any }} o
 */
export function createDocs(o) {
  const q = (/** @type {string} */ preview, /** @type {any[]} */ more = []) => ({ filter: { and: [{ field: "preview", op: "eq", value: preview }, { field: "gone", op: "eq", value: 0 }, ...more] } });
  /** @param {string} preview @param {string} path */
  async function find(preview, path) {
    const r = await o.store.query(o.chain(), TYPE, { ...q(preview, [{ field: "path", op: "eq", value: path }]), page: { limit: 2 } });
    return r.rows[0] || null;
  }
  const shape = (/** @type {any} */ r) => ({ path: r.data.path, id: r.data.docid, data: JSON.parse(r.data.data || "{}"), owner: r.data.owner || "", updated: r.data.updated || 0 });
  return {
    /** @param {string} preview @param {string} path */
    async get(preview, path) { const r = await find(preview, path); return r ? shape(r) : null; },
    /** A full replace, creating it if absent. @param {string} preview @param {string} path @param {any} data @param {string} owner */
    async set(preview, path, data, owner) {
      const p = parsePath(path); if (!("doc" in p) || !p.doc) throw Object.assign(new Error("not a document path"), { code: "invalid_argument" });
      const text = JSON.stringify(data);
      for (let n = 0; n < 4; n++) {
        const have = await find(preview, path);
        try {
          if (have) await o.store.update(o.chain(), TYPE, have.id, { data: text, updated: Date.now() }, have.version);
          else await o.store.create(o.chain(), TYPE, { preview, path, collection: p.collection, docid: p.id, data: text, owner, updated: Date.now(), gone: 0 });
          return;
        } catch (e) { if (!/** @type {any} */ (e) || /** @type {any} */ (e).code !== "version_conflict" || n === 3) throw e; }
      }
    },
    /** Merge into a document that exists. @param {string} preview @param {string} path @param {any} patch */
    async update(preview, path, patch) {
      for (let n = 0; n < 4; n++) {
        const have = await find(preview, path);
        if (!have) throw Object.assign(new Error("that document does not exist"), { code: "invalid_argument" });
        const merged = mergeDeep(JSON.parse(have.data.data || "{}"), patch);
        const bad = badBody(merged); if (bad) throw Object.assign(new Error(bad), { code: "invalid_argument" });
        try { await o.store.update(o.chain(), TYPE, have.id, { data: JSON.stringify(merged), updated: Date.now() }, have.version); return merged; }
        catch (e) { if (!/** @type {any} */ (e) || /** @type {any} */ (e).code !== "version_conflict" || n === 3) throw e; }
      }
    },
    /** Idempotent. @param {string} preview @param {string} path */
    async del(preview, path) {
      for (let n = 0; n < 4; n++) {
        const have = await find(preview, path);
        if (!have) return;
        try { await o.store.update(o.chain(), TYPE, have.id, { gone: 1, data: "{}", updated: Date.now() }, have.version); return; }
        catch (e) { if (!/** @type {any} */ (e) || /** @type {any} */ (e).code !== "version_conflict" || n === 3) throw e; }
      }
    },
    /** Every document directly in a collection (up to 1000), for a query to filter and order in memory. @param {string} preview @param {string} collection */
    async list(preview, collection) {
      /** @type {any[]} */ const out = [];
      let cursor;
      do {
        const r = await o.store.query(o.chain(), TYPE, { ...q(preview, [{ field: "collection", op: "eq", value: collection }]), page: { limit: 200, ...(cursor ? { cursor } : {}) } });
        out.push(...r.rows.map(shape));
        cursor = r.next_cursor || undefined;
      } while (cursor && out.length < 1000);
      return out;
    },
    /** How many documents a preview holds (for the quota). @param {string} preview */
    async count(preview) {
      let n = 0, cursor;
      do { const r = await o.store.query(o.chain(), TYPE, { ...q(preview), page: { limit: 200, ...(cursor ? { cursor } : {}) } }); n += r.rows.length; cursor = r.next_cursor || undefined; } while (cursor && n < MAX_DOCS + 1);
      return n;
    },
    /** Remove every document of a preview (it was removed). @param {string} preview */
    async purge(preview) {
      let cursor;
      do {
        const r = await o.store.query(o.chain(), TYPE, { ...q(preview), page: { limit: 200 } });
        for (const row of r.rows) { try { await o.store.update(o.chain(), TYPE, row.id, { gone: 1, data: "{}" }, row.version); } catch { /* the next pass takes it */ } }
        cursor = r.rows.length === 200 ? "more" : undefined;
      } while (cursor);
    },
  };
}
