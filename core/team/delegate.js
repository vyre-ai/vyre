// @ts-check
// A teammate's grants never exceed the adder's (contract 9.4, R6-8, R6-9). Containment is the kernel's (grants.create with `parent`); this
// chooses the parent, converts the adder's conditions into obligations on the teammate, intersects time, and rechecks the parent at every
// decision so the teammate pauses when the adder loses the grant, leaves or is limited (it fails closed).

import { isOutward } from "./roles.js";

/** @typedef {{ kind: string, id: string, space: string }} ActorRef */

const covers = (/** @type {any} */ g, /** @type {string[]} */ actions, /** @type {string} */ prefix) =>
  actions.every(a => g.actions.includes(a) || g.actions.includes("*")) && prefix.startsWith(g.resource.prefix);

/**
 * The time condition of the child: never later than the parent's expiry, never earlier than its start.
 * @param {any} parent @param {any} want
 */
function timeOf(parent, want) {
  const pw = parent.conditions?.when || {}, ww = want.conditions?.when || {};
  const expires = [pw.expires, ww.expires].filter(x => typeof x === "number");
  const starts = [pw.not_before, ww.not_before].filter(x => typeof x === "number");
  return { ...(starts.length ? { not_before: Math.max(...starts) } : {}), ...(expires.length ? { expires: Math.min(...expires) } : {}), ...(pw.schedule || ww.schedule ? { schedule: ww.schedule || pw.schedule } : {}) };
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
 * @param {{ adder: ActorRef, teammate: ActorRef, wanted: readonly { actions: readonly string[], prefix: string, conditions?: any }[], source?: string }} o
 * @returns {Promise<{ grants: any[], obligations: { grant: string, obligations: any[] }[] }>}
 */
export async function delegateGrants(kernel, chain, { adder, teammate, wanted, source = "team" }) {
  const mine = await kernel.grants.list(chain, { subject: { kind: "actor", actor: adder }, status: "active" });
  const plan = [];
  for (const w of wanted) {
    const parent = mine.find((/** @type {any} */ g) => covers(g, [...w.actions], w.prefix));
    if (!parent) throw Object.assign(new Error(`${adder.id} cannot give ${w.actions.join(", ")} on ${w.prefix}: no grant of theirs covers it`), { code: "not_contained", actions: w.actions, prefix: w.prefix });
    plan.push({ w, parent });
  }
  const grants = [], obligations = [];
  for (const { w, parent } of plan) {
    const conditions = {
      ...(w.conditions || {}),
      when: { ...timeOf(parent, w) },
      // The adder's presence, approval and surface conditions stay on the delegate (R6-8); the teammate's own wants add to them, never remove.
      how: { ...(parent.conditions?.how || {}), ...(w.conditions?.how || {}) },
      ...(parent.conditions?.where ? { where: parent.conditions.where } : {}),
      ...(parent.conditions?.budget ? { budget: parent.conditions.budget } : {}),
    };
    if (!conditions.when.expires && !conditions.when.not_before && !conditions.when.schedule) delete conditions.when;
    const g = await kernel.grants.create(chain, { subject: { kind: "actor", actor: teammate }, actions: [...w.actions], resource: { prefix: w.prefix }, conditions, source, parent: parent.id, reason: `added by ${adder.id}` });
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
