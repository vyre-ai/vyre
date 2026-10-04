// @ts-check
// spaces: roles, memberships and invites as calls on a Space's own kernel (`ctx.kernel.for(spaceId)`, hosted here or remote), not a store of ours. The kernel
// decides who may set a role, who may invite whom, what a temp member may reach and when it ends, and it needs the acting person's chain and a fresh presence
// proof bound to the exact input for each of these acts: this file only translates the module's calls into those, and the kernel's refusals into plain words.
//
//   const m = kernelMembers({ handle, now })      handle = ctx.kernel.for(spaceId): { gateway: { grants }, ... } (a remote handle has the same calls)
//   await m.setRole(kctx, { person, role, scope?, expires? })   kctx = { chain, proof }: the person's chain (ctx.kernel.chain(meta)) and ctx.kernel.proofFrom(meta), which is the `{ presence }` option
//
// Reads (list, get, invite) are the kernel's own, by the same chain, so a member sees only what the kernel lets them. Nothing is kept here: a device may keep a
// marked cache of "the spaces I am in" for drawing the screen offline, and never reads it for a decision.

import { ROLE_IDS } from "../../kernel/contracts/index.js";

/** What a kernel refusal says to a person, by its code. */
const WORDS = Object.freeze({
  not_allowed: ["forbidden", "Your role cannot do that here."],
  needs_presence: ["presence_required", "That needs your approval on your device."],
  not_contained: ["exceeds_role", "That is more than your own role allows."],
  not_found: ["not_found", "No such person or invite."],
  expired: ["expired", "That has expired."],
  needs_confirmation: ["needs_confirmation", "The person who invited you has not confirmed your fingerprint words yet."],
  contents_differ: ["contents_differ", "That is not what was approved. Ask for a new invite."],
  chain_not_person: ["forbidden", "Only a person can do that."],
  bad_input: ["bad_input", "That is not a valid request."],
  rate_limited: ["rate_limited", "Slow down for a moment."],
});

/** @param {any} e */
export function plainKernelError(e) {
  if (e && e.own === true) return e;
  const known = e && /** @type {Record<string, string[]>} */ (WORDS)[e.code];
  const out = /** @type {Error & { code?: string }} */ (new Error(known ? (e.code === "not_allowed" && e.message ? e.message : known[1]) : "The space's kernel could not do that."));
  out.code = known ? known[0] : "failed";
  return out;
}

/**
 * @param {{ handle: any, now?: () => number }} d
 */
export function kernelMembers({ handle, now = Date.now }) {
  const grants = () => {
    const g = handle && handle.gateway && handle.gateway.grants;
    if (!g) throw Object.assign(new Error("This space's kernel is not reachable."), { code: "unreachable" });
    return g;
  };
  /** @template T @param {() => Promise<T>} f @returns {Promise<T>} */
  const run = async f => { try { return await f(); } catch (e) { throw plainKernelError(e); } };
  const need = (/** @type {any} */ k) => { if (handle && handle.hosted === false) return k || {}; if (!k || !k.chain) throw Object.assign(new Error("Sign in on this device first."), { code: "no_identity" }); return k; };

  return {
    /** Everyone the caller may see (a manager and above sees all). */
    list: (/** @type {any} */ k) => run(async () => (await grants().members.list(need(k).chain)).map(shape)),
    get: (/** @type {any} */ k, /** @type {string} */ person) => run(async () => shape(await grants().members.get(need(k).chain, person))),
    /** Give someone a role, or change it. A temp role carries a scope and an end date. Making an owner is the kernel's rule, with presence. */
    setRole: (/** @type {any} */ k, /** @type {{ person: string, role: string, scope?: string[], expires?: number }} */ m) => run(async () => {
      if (!ROLE_IDS.includes(/** @type {any} */ (m.role))) throw Object.assign(new Error("Unknown role."), { code: "bad_input", own: true });
      const r = await grants().setRole(need(k).chain, m, k.proof);
      return shape(r.membership);
    }),
    /** A temp member's end date moves later: the same set-role, with the new date, so it is a grant act with a fresh proof like any other. */
    extendTemp: (/** @type {any} */ k, /** @type {{ person: string, expires: number }} */ m) => run(async () => {
      const cur = await grants().members.get(need(k).chain, m.person);
      if (cur.role !== "temp") throw Object.assign(new Error("Only a temp member has an end date."), { code: "bad_scope", own: true });
      return shape((await grants().setRole(k.chain, { person: m.person, role: "temp", scope: cur.scope, expires: m.expires }, k.proof)).membership);
    }),
    removeMember: (/** @type {any} */ k, /** @type {string} */ person) => run(async () => grants().removeMember(need(k).chain, { person }, k.proof)),
    /** The kernel's own clean-up of expired power. Needs no person; only reduces power. */
    sweep: () => run(async () => grants().sweep()),
    invites: {
      create: (/** @type {any} */ k, /** @type {{ role: string, scope?: string[], expires?: number, invitee?: string, valid_ms?: number }} */ i) => run(async () => grants().invites.create(need(k).chain, i, k.proof)),
      /** The inviter confirms the invitee's fingerprint words (admin and owner invites wait for this). */
      confirm: (/** @type {any} */ k, /** @type {string} */ id, /** @type {string} */ words) => run(async () => grants().invites.confirm(need(k).chain, id, { words }, k.proof)),
      /** Cancel an invite (its issuer, or a manager and above). Needs the kernel's `invites.revoke(chain, id, proof)`. */
      revoke: (/** @type {any} */ k, /** @type {string} */ id) => run(async () => {
        const g = grants();
        if (typeof g.invites.revoke !== "function") throw Object.assign(new Error("This space's kernel cannot cancel an invite yet."), { code: "unavailable", own: true });
        return g.invites.revoke(need(k).chain, id, k.proof);
      }),
      /** The invites the caller may see: their own, or all of them for a manager and above. Needs the kernel's `invites.list(chain)`; never carries a link or a hash. */
      list: (/** @type {any} */ k) => run(async () => {
        const g = grants();
        if (typeof g.invites.list !== "function") throw Object.assign(new Error("This space's kernel cannot list invites yet."), { code: "unavailable", own: true });
        return g.invites.list(need(k).chain);
      }),
      /** The join card: what the invite offers, from the kernel. */
      get: (/** @type {any} */ k, /** @type {string} */ id) => run(async () => grants().invites.get(need(k).chain, id)),
      /** The invitee accepts under their own chain and their own proof, over exactly what they were shown. */
      accept: (/** @type {any} */ k, /** @type {string} */ id, /** @type {{ role: string, scope?: string[]|null, expires?: number|null, invitee?: string|null }} */ seen) => run(async () => grants().invites.accept(need(k).chain, id, { seen, proof: k.proof && k.proof.presence })),
    },
    now,
  };
}

/** A membership as the tools show it. @param {any} m */
const shape = m => ({ space: m.space, person: m.person, role: m.role, scope: m.scope ?? null, expires: m.expires ?? null, added_by: m.added_by ?? null, added_at: m.added_at ?? null });
