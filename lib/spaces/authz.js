// @ts-check
// authz: a role-based `authorize` for the Spaces modules until the kernel's own authorize lands (work/kernel). It has the kernel's shape
// (kernel/contracts/authorize.d.ts: effect allow, deny or ask, a stable reason, obligations) and decides from the person's membership role
// (ROLE_BUNDLES) in the Space the chain acts in. When the kernel arrives the modules pass its authorize instead; nothing else changes.
//
// The chain here is the minimal stand-in `{ space, hops: [{ actor: { kind, id, space } }] }` (see `personChain`), never read from an input.
// A chain with any hop that is not a person or a device is not exactly one person, so it can never do an admin act, and any outward act it
// asks for is only ever HELD (ask) for a person to decide.

import { ROLE_BUNDLES, RISKS } from "../../kernel/contracts/index.js";
import { abilitiesOf } from "./members.js";

/** Each action: the ability it needs, its risk, and whether the Space's policy must also allow it. */
export const ACTIONS = Object.freeze({
  "deploy.read": { ability: "projects.work_member_of", risk: "read" },
  "deploy.preview": { ability: "projects.work_member_of", risk: "write" },
  "deploy.create": { ability: "projects.create_run", risk: "write" },
  "deploy.retire": { ability: "projects.create_run", risk: "write" },
  "deploy.domain": { ability: "projects.create_run", risk: "write" },
  "deploy.publish": { ability: "projects.approve_inside", risk: "outward.publish" },
  "deploy.rollback": { ability: "projects.approve_inside", risk: "outward.publish" },
  "deploy.secret": { ability: "connectors.manage", risk: "grant" },
  "views.share": { ability: "space.policy", risk: "outward.share" },
  "references.share": { ability: "space.policy", risk: "outward.share" },
  "events.project": { ability: "space.policy", risk: "outward.share" },
  "bridges.accept": { ability: "space.policy", risk: "grant" },
  "bridges.revoke": { ability: "space.policy", risk: "admin" },
  "kits.install": { ability: "customize.definitions", risk: "grant" },
  "records.copy": { ability: "space.shared_by_policy", risk: "outward.share", policy: "allow_copy" },
  "tasks.continue": { ability: "projects.work_member_of", risk: "write" },
  "views.read": { ability: null, risk: "read" },
  "references.resolve": { ability: null, risk: "read" },
  // Off by default and never for a model: a sealed value does not cross a Space without the owner's presence-protected grant.
  "copy.sealed": { ability: "space.root_key", risk: "outward.share", off: true },
});

const OUTWARD = new Set(RISKS.filter(r => r.startsWith("outward.")));

/**
 * @param {{ membership: (space: string, personId: string) => Promise<any>|any, now?: () => number, policy?: (space: string) => Promise<any>|any }} deps
 */
export function createRoleAuthorize({ membership, now = Date.now, policy = () => ({}) }) {
  const out = (effect, reason, extra = {}) => ({ effect, reason, grants: [], obligations: [], decision: `dec_${now().toString(36)}`, ...extra });
  /** @param {{ chain: any, action: string, resource?: string }} input */
  return async function authorize({ chain, action }) {
    const def = /** @type {any} */ (ACTIONS)[action];
    if (!def) return out("deny", "unknown_action");
    const hops = chain && Array.isArray(chain.hops) ? chain.hops : [];
    const personHop = hops.find(h => h.actor && h.actor.kind === "person");
    if (!personHop) return out("deny", "chain_not_person");
    const onlyPeople = hops.every(h => h.actor && (h.actor.kind === "person" || h.actor.kind === "device"));
    const space = String(chain.space || personHop.actor.space || "");
    if (def.off) return out("deny", "needs_presence");
    const m = await membership(space, personHop.actor.id);
    if (!m) return out("deny", "not_a_member");
    const have = abilitiesOf(m, now());
    if (def.ability && !have.includes(def.ability)) return out("deny", have.length ? "no_grant" : "expired");
    if (def.policy) { const p = (await policy(space)) || {}; if (!p[def.policy]) return out("deny", "no_grant"); }
    // A model, an automation or a service anywhere in the chain: it may read and write what the person may, but anything that
    // leaves the Space or changes who can do what is held for a person, and an admin act is not available to it at all.
    if (!onlyPeople) {
      if (OUTWARD.has(def.risk) || def.risk === "grant") return out("ask", "needs_approval", { obligations: [{ type: "ask", kind: def.risk, approver: "owner", checker_must_be_person: true }] });
      if (def.risk === "admin") return out("deny", "chain_not_person");
    }
    if (OUTWARD.has(def.risk)) return out("ask", "needs_approval", { obligations: [{ type: "ask", kind: def.risk, approver: "owner", checker_must_be_person: true }, { type: "presence", method: "fresh" }] });
    if (def.risk === "grant") return out("allow", "ok", { obligations: [{ type: "presence", method: "session" }] });
    return out("allow", "ok");
  };
}

/** A person chain, the dev stand-in for the kernel's chain builder (kernel invariant 2: only the kernel builds a real one). */
export function personChain({ space, person, name, device, extra = [] }) {
  const hop = (actor, entered_by) => ({ actor: { space, ...actor }, entered_by });
  return Object.freeze({ space, built_at: Date.now(), labels: { trust: "member", spaces: [space] },
    hops: Object.freeze([hop({ kind: "person", id: person, ...(name ? { name } : {}) }, "surface"), ...(device ? [hop({ kind: "device", id: device }, "surface")] : []), ...extra.map(a => hop(a, "registry"))]) });
}

export { ROLE_BUNDLES };
