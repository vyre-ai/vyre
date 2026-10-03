// @ts-check
// A teammate's grants never exceed the adder's (contract 9.4, R6-8, R6-9). Containment is the kernel's (grants.create with `parent`); this
// chooses the parent, converts the adder's conditions into obligations on the teammate, intersects time, and rechecks the parent at every
// decision so the teammate pauses when the adder loses the grant, leaves or is limited (it fails closed).

import { isOutward } from "./roles.js";
import { segments, containedPrefix } from "../../../kernel/core/urn.js";

/** @typedef {{ kind: string, id: string, space: string }} ActorRef */

/** Which of the adder's grants could be the parent? Chosen by action and by the kernel's own selector rule (`*` segments); a selector that is not a Space URN falls back to a plain prefix. The kernel's `grants.create` with `parent` is what proves containment (and the delegate condition) and refuses what is not. */
const covers = (/** @type {any} */ g, /** @type {string[]} */ actions, /** @type {string} */ prefix) =>
  actions.every(a => g.actions.includes(a) || g.actions.includes("*") || g.actions.some((/** @type {string} */ p) => p.endsWith(".*") && a.startsWith(p.slice(0, -1))))
  && (segments(g.resource.prefix) ? containedPrefix(prefix, g.resource.prefix) : prefix.startsWith(g.resource.prefix));

const loosens = (/** @type {string} */ what) => Object.assign(new Error(`a teammate's grant cannot loosen the adder's: ${what}`), { code: "loosens", what });
const PRESENCE = { none: 0, session: 1, fresh: 2 };
const same = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The child's conditions: the PARENT's, tightened by what the teammate asks for and never loosened. Each of presence, approval, time, schedule, `where`, budget, rate, fields
 * and depth stays as the parent has it or gets stricter; a wanted value that would make it looser refuses the whole add (`loosens`). The kernel's `grants.create` also checks
 * containment, but this is the helper's own rule and does not lean on it.
 * @param {any} parent @param {any} want a wanted entry: { conditions?, fields? }
 * @returns {{ conditions: any, fields?: string[] }}
 */
export function tighten(parent, want) {
  const pc = parent.conditions || {}, wc = want.conditions || {};
  /** @type {any} */ const out = {};
  // presence: never lower
  const pp = pc.how?.presence ?? "none", wp = wc.how?.presence;
  if (wp !== undefined && !(wp in PRESENCE)) throw loosens("presence");
  if (wp !== undefined && PRESENCE[/** @type {"none"} */ (wp)] < PRESENCE[/** @type {"none"} */ (pp)]) throw loosens("presence");
  const presence = wp !== undefined ? wp : pp;
  // approval: kept as the parent has it, same approver, and `once` never relaxed
  /** @type {any} */ let approval = pc.how?.approval;
  const wa = wc.how && "approval" in wc.how ? wc.how.approval : undefined;
  if (approval) {
    if (wa !== undefined && (!wa || wa.by !== approval.by || (approval.once === true && wa.once === false))) throw loosens("approval");
    approval = { ...approval, ...(approval.once === true || (wa && wa.once === true) ? { once: true } : {}) };
  } else if (wa) approval = wa;
  const how = { ...(presence !== "none" || pc.how?.presence !== undefined || wp !== undefined ? { presence } : {}), ...(approval ? { approval } : {}) };
  if (Object.keys(how).length) out.how = how;
  // time: never later, never earlier; a schedule is kept exactly (a cron's containment is not ours to judge) unless the parent has none
  const pw = pc.when || {}, ww = wc.when || {};
  const expires = [pw.expires, ww.expires].filter(x => typeof x === "number"), starts = [pw.not_before, ww.not_before].filter(x => typeof x === "number");
  if (pw.schedule !== undefined && ww.schedule !== undefined && ww.schedule !== pw.schedule) throw loosens("schedule");
  const schedule = pw.schedule ?? ww.schedule;
  const when = { ...(starts.length ? { not_before: Math.max(...starts) } : {}), ...(expires.length ? { expires: Math.min(...expires) } : {}), ...(schedule !== undefined ? { schedule } : {}) };
  if (Object.keys(when).length) out.when = when;
  // where: the parent's, with nothing overridden; a list (surfaces) may only shrink
  if (pc.where || wc.where) {
    /** @type {any} */ const where = { ...(pc.where || {}) };
    for (const [k, v] of Object.entries(wc.where || {})) {
      if (!(k in where)) { where[k] = v; continue; }
      if (Array.isArray(where[k]) && Array.isArray(v)) { if (!v.every(x => where[k].includes(x))) throw loosens(`where.${k}`); where[k] = v; }
      else if (!same(where[k], v)) throw loosens(`where.${k}`);
    }
    out.where = where;
  }
  // budget: one meter, the smaller limit
  if (pc.budget || wc.budget) {
    if (pc.budget && wc.budget && (pc.budget.meter !== wc.budget.meter)) throw loosens("budget");
    const b = pc.budget && wc.budget ? { meter: pc.budget.meter, limit: Math.min(pc.budget.limit, wc.budget.limit) } : pc.budget || wc.budget;
    out.budget = b;
  }
  // rate: no faster than the parent
  if (pc.rate || wc.rate) {
    if (pc.rate && wc.rate && wc.rate.n / wc.rate.per_seconds > pc.rate.n / pc.rate.per_seconds) throw loosens("rate");
    out.rate = pc.rate && wc.rate ? wc.rate : pc.rate || wc.rate;
  }
  // depth: a child is never delegable as far as its parent
  const pd = pc.delegate, wd = wc.delegate;
  if (wd && wd.allowed && (!pd || !pd.allowed || !(wd.max_depth < pd.max_depth))) throw loosens("delegation depth");
  if (wd && wd.allowed) out.delegate = wd;
  // fields: a subset of the parent's, and the parent's own when none are asked for
  const pf = parent.resource?.fields;
  /** @type {string[]|undefined} */ let fields = want.fields;
  if (pf) { if (fields && !fields.every((/** @type {string} */ f) => pf.includes(f))) throw loosens("fields"); if (!fields) fields = [...pf]; }
  return { conditions: out, ...(fields ? { fields } : {}) };
}

/**
 * Obligations a delegate carries because its adder's grant had these conditions: presence or approval for the adder is an Ask for the teammate.
 * @param {any} parent @returns {{ type: string, method?: string, approver?: string }[]}
 */
export function obligationsFrom(parent) {
  const how = parent.conditions?.how || {};
  /** @type {any[]} */ const out = [];
  if (how.presence && how.presence !== "none") out.push({ type: "presence", method: how.presence });
  if (how.approval) out.push({ type: "ask", approver: how.approval.by });
  return out;
}

/**
 * Create the teammate's grants as narrowings of the adder's. One grant per wanted entry, each under the adder grant that covers it; a wanted entry no
 * grant of the adder covers refuses the whole add (nothing is created for the others).
 * @param {any} kernel @param {any} chain the adder's chain (the kernel built it)
 * `presence(input)` gives the adder's own presence proof for exactly that grant (the kernel binds a proof to its input, and `grants.create` always needs one).
 * @param {{ presence?: ((input: any) => any) | null, adder: ActorRef, teammate: ActorRef, wanted: readonly { actions: readonly string[], prefix: string, conditions?: any }[], source?: string }} o
 * @returns {Promise<{ grants: any[], obligations: { grant: string, obligations: any[] }[] }>}
 */
export async function delegateGrants(kernel, chain, { adder, teammate, wanted, source = "team", presence = null }) {
  const mine = await kernel.grants.list(chain, { subject: { kind: "actor", actor: adder }, status: "active" });
  const plan = [];
  for (const w of wanted) {
    // Only a grant that may be delegated can be a parent (the kernel refuses any other); of those that cover, the most conditioned one, so the teammate inherits the
    // strictest path rather than the widest one the adder happens to hold.
    const strict = (/** @type {any} */ g) => ["how", "when", "where", "budget"].filter(k => g.conditions && g.conditions[k] && Object.keys(g.conditions[k]).length).length;
    const parent = mine.filter((/** @type {any} */ g) => g.status !== "revoked" && (!g.conditions || !g.conditions.delegate || g.conditions.delegate.allowed !== false) && covers(g, [...w.actions], w.prefix))
      .sort((/** @type {any} */ a, /** @type {any} */ b) => strict(b) - strict(a) || String(b.resource.prefix).length - String(a.resource.prefix).length)[0];
    if (!parent) throw Object.assign(new Error(`${adder.id} cannot give ${w.actions.join(", ")} on ${w.prefix}: no grant of theirs covers it`), { code: "not_contained", actions: w.actions, prefix: w.prefix });
    plan.push({ w, parent });
  }
  const grants = [], obligations = [];
  for (const { w, parent } of plan) {
    const { conditions, fields } = tighten(parent, w);
    const input = { subject: { kind: "actor", actor: teammate }, actions: [...w.actions], resource: { prefix: w.prefix, ...(fields ? { fields } : {}) }, conditions, source, parent: parent.id, reason: `added by ${adder.id}` };
    const g = await kernel.grants.create(chain, input, presence ? { presence: await presence(input) } : {});
    grants.push(g);
    obligations.push({ grant: g.id, obligations: obligationsFrom(parent) });
  }
  return { grants, obligations };
}

/**
 * The recheck at every decision (R6-8): the teammate may act only while each delegated grant's parent is still active and unexpired, the adder is
 * still a member and not limited. It fails closed: any doubt pauses the teammate.
 * @param {any} kernel @param {any} chain
 * @param {{ adder: ActorRef, grants: readonly { id: string, parent?: string }[], now?: number, membership?: (adder: ActorRef) => Promise<{ member: boolean, limited?: boolean }> }} o
 * @returns {Promise<{ ok: boolean, paused: boolean, reason?: "parent_gone"|"adder_left"|"adder_limited"|"unknown" }>}
 */
export async function recheckParent(kernel, chain, { adder, grants, now = Date.now(), membership }) {
  try {
    if (membership) {
      const m = await membership(adder);
      if (!m || !m.member) return { ok: false, paused: true, reason: "adder_left" };
      if (m.limited) return { ok: false, paused: true, reason: "adder_limited" };
    }
    const mine = await kernel.grants.list(chain, { subject: { kind: "actor", actor: adder }, status: "active" });
    const live = new Map(mine.map((/** @type {any} */ g) => [g.id, g]));
    for (const g of grants) {
      const p = g.parent && live.get(g.parent);
      if (!p || (p.conditions?.when?.expires && p.conditions.when.expires <= now)) return { ok: false, paused: true, reason: "parent_gone" };
    }
    return { ok: true, paused: false };
  } catch {
    return { ok: false, paused: true, reason: "unknown" };
  }
}

/**
 * The actors a task's chain is made of: the assigner first, then the teammate (R6-9). A person cannot use a teammate that someone else added
 * with broad grants as a lever, because the intersection includes the assigner's own grants. The kernel builds the chain from this.
 * @param {ActorRef} assigner @param {ActorRef} teammate
 */
export const taskChainActors = (assigner, teammate) => (assigner.kind === teammate.kind && assigner.id === teammate.id ? [teammate] : [assigner, teammate]);

/**
 * True when `chain` is a chain of this task: it begins with the task's assigner and ends with its doer.
 * @param {any} chain @param {{ assigned_by: ActorRef, doer: ActorRef }} task
 */
export function chainIncludesAssigner(chain, task) {
  const h = chain.hops.map((/** @type {any} */ x) => x.actor);
  return h.length >= 2 && h[0].id === task.assigned_by.id && h[0].kind === task.assigned_by.kind && h.at(-1).id === task.doer.id;
}

/** True when any of the teammate's grants is outward: a person must have added it. @param {readonly { actions: readonly string[] }[]} grants @param {Record<string, string>} [registry] */
export const hasOutwardPower = (grants, registry) => grants.some(g => g.actions.some(a => isOutward(a, registry)));
