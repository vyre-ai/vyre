// @ts-check
// Flow tokens through links. A token like {contact.spouse.name} compiles to a path; when the path goes through a link field (a value that is only { urn }), the runner reads the linked record under the
// Flow's own chain (lib/link/path.js, the same resolver Documents use) and lays what it read over the scope for this step, so the expression evaluates as it always did.
//
// The rules, for Flows:
//   - a path may follow up to 3 links; a record the Flow cannot read stops the step with a plain error
//   - a `many` link read without a number gives the values of every linked record joined as text, ", " between; `children[0].name` gives the first one's
//   - a field or a link with nothing in it reads as nothing (null, empty text), in a value and in a condition alike, as an absent value always did; only a linked record the Flow's chain may not read stops the step
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
  const copy = Object.assign(Array.isArray(base) ? [] : {}, base);     // an array keeps the names laid on it (children.name)
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
  for (const { src } of sourcesOf(step)) {
    let node; try { node = parse(src); } catch { continue; }
    for (const chain of chains(node, [])) {
      let cur = /** @type {any} */ (scope), i = 0;
      for (; i < chain.length; i++) {
        const part = chain[i];
        const list = isLinkList(cur) && !/^\d+$/.test(part);
        if ((isLink(cur) && part !== "urn") || list) break;
        if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, part)) {
          cur = undefined; break;
        }
        cur = cur[part];
      }
      if (i >= chain.length || cur === undefined) continue;
      const at = chain.slice(0, i), rest = chain.slice(i);
      const key = at.join("\u0000");
      const mine = found.get(key) || { at, base: cur, over: undefined };
      const got = await resolvePath(cur, rest, reader, at.slice(-1)[0] || "");
      const leaf = Array.isArray(got) ? joined(got) : got ?? null;
      mine.over = merge(mine.over, nest(rest, leaf));
      found.set(key, mine);
    }
  }
  return [...found.values()].map(f => ({ at: f.at, over: Array.isArray(f.base) ? Object.assign([...f.base], f.over) : { ...f.over, urn: f.base.urn } }));
}

/** The scope with the links laid over it. @param {Record<string, any>} scope @param {{ at: string[], over: any }[]} overs */
export function withLinks(scope, overs) {
  let out = scope;
  for (const { at, over } of [...overs].sort((a, b) => a.at.length - b.at.length)) out = setAt(out, at, over);
  return out;
}

/** The person whose change fired a Flow (the event's verified actor), when there is one: a linked record is read only if they may read it too. A schedule or a web call has none. @param {unknown} actor */
export const byPerson = (actor, chain) => {
  if (typeof actor === "string" && actor.startsWith("person:")) return { by: actor.slice(7).split("@")[0] };   // the log writes a person as "person:<id>@<space>"
  // an event the records or tasks service emitted for a person's change names the service as its last actor; the chain it came from still begins with that person (an assistant's change counts as theirs)
  const first = Array.isArray(chain) && chain[0] && chain[0].actor && chain[0].actor.kind === "person" ? chain[0].actor : null;
  return first ? { by: String(first.id) } : {};
};

/**
 * Who started the run an event fires: the person whose change it was (byPerson); and for an event a Flow run wrote (its chain has an automation hop; the event's correlation is that run's id) the starter that
 * run recorded, which each run stores from what it inherited, so a chain of Flows keeps the person who began it. A run with no starter (a schedule, a service's event) passes none, and the approver of the
 * Flow that wrote the record is never mistaken for it.
 * @param {any} env @param {(id: string) => Promise<any>} getRun
 */
export const starterOfEvent = async (env, getRun) => {
  const hops = Array.isArray(env && env.chain) ? env.chain : [];
  if (!hops.some((/** @type {any} */ h) => h && h.actor && h.actor.kind === "automation")) return byPerson(env && env.actor, hops);
  const src = typeof env.corr === "string" && env.corr ? await getRun(env.corr).catch(() => null) : null;
  return src && typeof src.started_by === "string" && src.started_by ? { by: src.started_by } : {};
};

/** Who started a run by hand, from the verified chain: a linked record is read only if THEY may read it too, so a member cannot see through a Flow what she could not open herself. @param {any} chain */
export const starterOf = (chain) => { const h = ((chain && chain.hops) || []).find((/** @type {any} */ x) => x.actor.kind === "person"); return h ? { by: String(h.actor.id) } : {}; };

/**
 * A linked record is read under the lesser of the Flow's chain and the chain of whoever started the run (`by`, when there is one and the host can make their chain): both must be able to read it, else it reads
 * as not readable (the step stops with the plain error).
 * @param {{ get: Function }} records @param {any} flowChain @param {((id: string) => any) | undefined} actorChain @param {string | undefined} by @returns {(type: string, id: string) => Promise<any>}
 */
export const lesserRead = (records, flowChain, actorChain, by) => async (type, id) => {
  const rec = await records.get(flowChain, type, id);
  if (!rec || !by || typeof actorChain !== "function") return rec;
  let seen = null; try { seen = await records.get(actorChain(String(by)), type, id); } catch { seen = null; }
  return seen ? rec : null;
};
