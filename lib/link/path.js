// @ts-check
// link/path: the one resolver for a path that goes through record relationships, shared by Flows and Documents. {contact.spouse.name}: "spouse" is a link field (its stored value is { urn } of
// the linked record, or a list of them when the field is `many`), and the token reads that record's field. Nothing here names an object or a field: the urn of a link says which object it points at.
//
// Rules, stated once:
//   - at most MAX_HOPS links are followed in one path; a longer one stops with a plain error
//   - every linked record is read through `read`, which the caller binds to its own chain, so a record the caller may not read stops the path (LinkError), never a silent blank
//   - a sealed value is never returned, only its placeholder, "[sealed: <field>]"
//   - a `many` link answers a list (resolvePath) or a list of expanded records (expandPaths); Flows join the list into text, Documents loop over it
//   - a list link is read for at most MAX_LIST records; a longer one stops the path, plainly
//   - a link to another Space is not followed

/** The most links one path may follow. */
export const MAX_HOPS = 3;

/** The most records one list link is read for in a path; a longer list stops with a plain error (a number in the path, kids.0.name, reads one). */
export const MAX_LIST = 200;

/** A path that cannot be followed, said in plain words. `code` is not_found, too_deep or bad_input. */
export class LinkError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = "LinkError"; this.code = code; }
}

const isObj = (/** @type {any} */ v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sealedShape = (/** @type {any} */ v) => isObj(v) && typeof v.sealed === "string";
/** What a sealed value reads as. @param {string} field */
export const sealedPlaceholder = (field) => `[sealed: ${field}]`;
/** A link as stored: nothing but the urn of the linked record. @param {any} v */
export const isLink = (v) => isObj(v) && typeof v.urn === "string" && v.urn.startsWith("vyre://") && Object.keys(v).length === 1;
/** A list of links (a `many` link field). @param {any} v */
export const isLinkList = (v) => Array.isArray(v) && v.length > 0 && v.every(isLink);
const isIndex = (/** @type {string} */ p) => /^\d+$/.test(p);

/** @param {string} urn @returns {{ space: string, type: string, id: string } | null} */
function parts(urn) {
  const m = /^vyre:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(urn);
  return m ? { space: m[1], type: m[2], id: m[3] } : null;
}

/**
 * @typedef {{ read: (type: string, id: string) => Promise<any>, space?: string, cache?: Map<string, Promise<any>> }} Reader
 * `read` is the records read under the caller's own chain: the record, or null when it is not there or not the caller's to see.
 */

/** @param {any[]} list @param {string} at */
function capped(list, at) {
  if (list.length > MAX_LIST) throw new LinkError("too_many", `${at || "this list"}: links to ${list.length} records, and a path reads at most ${MAX_LIST}. Pick one with a number, such as ${at || "list"}.0, or narrow the list first.`);
}

/** Follow one link: the linked record's data with sealed values as placeholders. @param {any} link @param {Reader} o @param {number} hops hops taken so far @param {string} at where we are, for the error */
async function hop(link, o, hops, at) {
  if (hops >= MAX_HOPS) throw new LinkError("too_deep", `${at}: a path follows at most ${MAX_HOPS} links. Start from the record nearest the value you want.`);
  const p = parts(link.urn);
  if (!p) throw new LinkError("bad_input", `${at}: that link does not point at a record`);
  if (o.space && p.space !== o.space) throw new LinkError("not_found", `${at}: that record is in another Space, so it is not followed`);
  const cache = o.cache || (o.cache = new Map());
  let pending = cache.get(link.urn);
  if (!pending) { pending = Promise.resolve(o.read(p.type, p.id)).catch(() => null); cache.set(link.urn, pending); }
  const rec = await pending;
  if (!rec) throw new LinkError("not_found", `${at}: the ${p.type} it links to is not there, or is not yours to see`);
  return masked(rec.data || {});
}

/** @param {Record<string, any>} data */
function masked(data) {
  /** @type {Record<string, any>} */ const out = {};
  for (const [k, v] of Object.entries(data)) out[k] = sealedShape(v) ? sealedPlaceholder(k) : v;
  return out;
}

/**
 * The value at `path` below `value`, following links. Absent is undefined. A list link gives a list (one value per linked record, the ones with nothing there left out); a number in the path
 * picks one item. A link left at the end of the path is returned as it is, { urn }.
 * @param {any} value the record's data (or any value below it) @param {string[]} path @param {Reader} o
 * @param {string} [label] how errors name the start, e.g. "contact"
 * @returns {Promise<any>}
 */
export async function resolvePath(value, path, o, label = "") {
  return walk(value, path, o, 0, label);
}

/** @param {any} v @param {string[]} path @param {Reader} o @param {number} hops @param {string} at @returns {Promise<any>} */
async function walk(v, path, o, hops, at) {
  if (!path.length) return v;
  const [head, ...rest] = path;
  const here = at ? `${at}.${head}` : head;
  if (isLink(v) && head === "urn" && !rest.length) return v.urn;
  if (isLink(v)) { const data = await hop(v, o, hops, at || "this record"); return walk(data, path, o, hops + 1, at); }
  if (Array.isArray(v)) {
    if (isIndex(head)) return walk(v[Number(head)], rest, o, hops, here);
    capped(v, at);
    const got = await Promise.all(v.map((x, i) => walk(x, path, o, hops, `${at}[${i}]`)));
    return got.filter(x => x !== undefined && x !== null && x !== "");
  }
  if (!isObj(v) || !Object.hasOwn(v, head)) {
    return undefined;
  }
  const next = v[head];
  if (sealedShape(next)) return rest.length ? undefined : sealedPlaceholder(head);
  return walk(next, rest, o, hops, here);
}

/**
 * `data` (a record's fields) with every link that a path goes through replaced by the linked record's fields (and its urn), so a plain lookup of "spouse.name" then finds it. A `many` link becomes a
 * list of such records. Only the links the paths need are read. The linked record's sealed values are placeholders.
 * @param {Record<string, any>} data @param {string[][]} paths each relative to `data` @param {Reader} o @param {string} [label]
 * @returns {Promise<Record<string, any>>}
 */
export async function expandPaths(data, paths, o, label = "") {
  return expand(data, paths, o, 0, label);
}

/** @param {any} v @param {string[][]} paths @param {Reader} o @param {number} hops @param {string} at @returns {Promise<any>} */
async function expand(v, paths, o, hops, at) {
  const live = paths.filter(p => p.length);
  if (!live.length) return v;
  if (isLink(v)) {
    const data = await hop(v, o, hops, at || "this record");
    return { ...(await expand(data, live, o, hops + 1, at)), urn: v.urn };
  }
  if (Array.isArray(v)) {
    if (live.some(p => !isIndex(p[0]))) capped(v, at);
    return Promise.all(v.map((x, i) => expand(x, live.flatMap(p => (isIndex(p[0]) ? (Number(p[0]) === i ? [p.slice(1)] : []) : [p])), o, hops, `${at}[${i}]`)));
  }
  if (!isObj(v)) return v;
  /** @type {Map<string, string[][]>} */ const byHead = new Map();
  for (const p of live) byHead.set(p[0], [...(byHead.get(p[0]) || []), p.slice(1)]);
  const out = { ...v };
  for (const [head, rest] of byHead) {
    if (!Object.hasOwn(v, head)) continue;
    out[head] = await expand(v[head], rest, o, hops, at ? `${at}.${head}` : head);
  }
  return out;
}

/**
 * The fields an object offers to a picker, nesting through its links up to MAX_HOPS deep, built from the Space's record types (the `types` records.types returns). Each entry is
 * { name, label, kind, to?, many?, fields? }: a link carries the object it points at and, below MAX_HOPS, that object's own fields.
 * @param {any[]} types @param {string} object @param {number} [depth]
 * @returns {any[]}
 */
export function fieldTree(types, object, depth = 0) {
  const def = (types || []).find(t => t && t.name === object);
  if (!def || !Array.isArray(def.fields)) return [];
  return def.fields.map((/** @type {any} */ f) => {
    const link = (f.kind === "link" || f.kind === "ref") && typeof f.to === "string";
    return { name: f.name, label: f.label || f.name, kind: f.kind, ...(link ? { to: f.to, many: f.many === true, ...(depth < MAX_HOPS ? { fields: fieldTree(types, f.to, depth + 1) } : {}) } : {}) };
  });
}
