// @ts-check
// Flow tokens through links. A token like {contact.spouse.name} compiles to a path; when the path goes through a link field (a value that is only { urn }), the runner reads the linked record under the
// Flow's own chain (lib/link/path.js, the same resolver Documents use) and lays what it read over the scope for this step, so the expression evaluates as it always did.
//
// The rules, for Flows:
//   - a path may follow up to 3 links; a record the Flow cannot read stops the step with a plain error
//   - a `many` link read without a number gives the values of every linked record joined as text, ", " between; `children[0].name` gives the first one's
//   - in a value (a field to write, a message), a link with nothing in it stops the step and names the field; in a condition it reads as nothing, as an absent value always did
//   - a sealed value is its placeholder
import { parse } from "./expr.js";
import { isLink, isLinkList, resolvePath, LinkError } from "../../lib/link/path.js";

/** The names a chain of member reads gives, root first, or null when it is not a plain chain. @param {any} n @returns {string[] | null} */
function chainOf(n) {
  if (n.k === "id") return [n.name];
  if (n.k === "member") { const c = chainOf(n.obj); return c && [...c, n.name]; }
  if (n.k === "index" && n.idx.k === "lit" && (typeof n.idx.v === "number" || typeof n.idx.v === "string")) { const c = chainOf(n.obj); return c && [...c, String(n.idx.v)]; }
  return null;
}

/** Every plain chain an expression reads. @param {any} n @param {string[][]} out */
function chains(n, out) {
  if (!n || typeof n !== "object") return out;
  if (n.k === "member" || n.k === "index") {
    const c = chainOf(n);
    if (c) { out.push(c); if (n.k === "index") chains(n.idx, out); return out; }
  }
  if (n.k === "id") { out.push([n.name]); return out; }
  for (const k of ["obj", "idx", "a", "b"]) if (n[k]) chains(n[k], out);
  for (const k of ["args", "items"]) if (Array.isArray(n[k])) for (const x of n[k]) chains(x, out);
  return out;
}

const SRC_KEYS = new Set(["if", "from", "over", "where", "check", "until", "lock"]);
/** The expressions of one step (not of the steps inside it): every { expr } and the keys that hold a condition. @param {any} s @returns {{ src: string, value: boolean }[]} */
export function sourcesOf(s) {
  /** @type {{ src: string, value: boolean }[]} */ const out = [];
  const isSteps = (/** @type {any} */ a) => Array.isArray(a) && a.length > 0 && a.every(x => x && typeof x === "object" && typeof x.kind === "string");
  const go = (/** @type {any} */ v, /** @type {boolean} */ value) => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { if (!isSteps(v)) v.forEach(x => go(x, value)); return; }
    if (typeof v.expr === "string") { out.push({ src: v.expr, value }); return; }
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === "string" && SRC_KEYS.has(k)) out.push({ src: x, value: false });
      else go(x, value);
    }
  };
  go(s, true);
  return out;
}

/** Copy `base` with `value` set at `path`, copying only what lies along it. @param {any} base @param {string[]} path @param {any} value @returns {any} */
function setAt(base, path, value) {
  if (!path.length) return value;
  const [h, ...rest] = path;
  const copy = Array.isArray(base) ? [...base] : { ...(base || {}) };
  copy[h] = setAt(copy[h], rest, value);
  return copy;
}

/** @param {string[]} path @param {any} leaf */
function nest(path, leaf) { return path.reduceRight((acc, k) => ({ [k]: acc }), leaf); }
/** Merge two nested plain objects. @param {any} a @param {any} b @returns {any} */
function merge(a, b) {
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = k in o ? merge(o[k], v) : v; return o; }
  return b;
}
/** A list of values as one text. @param {any[]} list */
const joined = list => list.map(x => (x && typeof x === "object" ? "" : String(x))).filter(Boolean).join(", ");

/**
 * What to lay over the scope for the links this step's expressions go through: [{ at, over }], `at` the place of the link in the scope and `over` what stands there instead (the link's urn and the
 * values read through it). Empty when no path goes through a link.
 * @param {any} step @param {Record<string, any>} scope @param {import('../../lib/link/path.js').Reader} reader
 * @returns {Promise<{ at: string[], over: any }[]>}
 */
export async function linksFor(step, scope, reader) {
  /** @type {Map<string, { at: string[], base: any, over: any }>} */ const found = new Map();
  for (const { src, value } of sourcesOf(step)) {
    let node; try { node = parse(src); } catch { continue; }
    for (const chain of chains(node, [])) {
      let cur = /** @type {any} */ (scope), i = 0, inData = false;
      for (; i < chain.length; i++) {
        const part = chain[i];
        const list = isLinkList(cur) && !/^\d+$/.test(part);
        if ((isLink(cur) && part !== "urn") || list) break;
        if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, part)) {
          // a path through a field a record has no value for: in a value that is said; in a condition it is nothing, as it always was
          if (value && inData && i < chain.length - 1) throw new LinkError("not_found", `${chain.slice(0, i + 1).join(".")} has no value, so ${chain.join(".")} cannot be read. Fill in ${part} first.`);
          cur = undefined; break;
        }
        if (part === "data" || part === "after" || part === "before") inData = true;     // the fields of a record: a record step's data, a trigger's after and before
        cur = cur[part];
      }
      if (i >= chain.length || cur === undefined) continue;
      const at = chain.slice(0, i), rest = chain.slice(i);
      const key = at.join("\u0000");
      const mine = found.get(key) || { at, base: cur, over: undefined };
      const got = await resolvePath(cur, rest, { ...reader, strict: value }, at.slice(-1)[0] || "");
      const leaf = Array.isArray(got) ? joined(got) : got ?? null;
      mine.over = merge(mine.over, nest(rest, leaf));
      found.set(key, mine);
    }
  }
  return [...found.values()].map(f => ({ at: f.at, over: Array.isArray(f.base) ? f.over : { ...f.over, urn: f.base.urn } }));
}

/** The scope with the links laid over it. @param {Record<string, any>} scope @param {{ at: string[], over: any }[]} overs */
export function withLinks(scope, overs) {
  let out = scope;
  for (const { at, over } of overs) out = setAt(out, at, over);
  return out;
}
