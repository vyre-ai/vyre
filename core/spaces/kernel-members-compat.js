// @ts-check
// spaces: the createMembers-shaped face of a Space's kernel (lib/spaces/members.js), so the module's tools can keep calling `m.setRole({ actor, person, role, ... })` while the
// kernel decides. It is thin on purpose: every rule is the kernel's, every call goes through kernel-members.js, and the only things added are the legacy call shape and the
// legacy error codes (SpacesError). Each call takes the acting person's kernel context as `kernel: { chain, proof }` (ctx.kernel.chain(meta), ctx.kernel.proofFrom(meta)); the legacy
// `actor` and `presence` fields are ignored on this path (the chain says who acts, the kernel proof is the presence). A remote Space needs no chain.
//
// Not carried over, because the kernel does not have it: the legacy `emit` events (the kernel's own log is the history: member.set, owner.changed), a stored membership (nothing is
// kept here), and the system actor of a join link (a link is a kernel invite). Role display names stay local to the module (not authority). See team/archive/work-journals/kernel-2.md for the
// callers still on the legacy shape.
import { ROLE_IDS } from "../../kernel/contracts/index.js";
import { SpacesError, abilitiesOf, roleRank } from "../../lib/spaces/members.js";
import { kernelMembers } from "./kernel-members.js";

/** A raw kernel refusal as the legacy SpacesError code it is. @param {any} e @returns {SpacesError | any} */
export function legacyError(e) {
  if (e instanceof SpacesError) return e;
  const code = e && e.code, msg = String((e && e.message) || "");
  const own = (/** @type {string} */ c, /** @type {string} */ m) => Object.assign(new SpacesError(c, m), { own: true });
  if (code === "not_contained") return own("exceeds_role", "You cannot give a role above your own.");
  if (code === "needs_presence") return own("needs_presence", "This change needs your approval on your device.");
  if (code === "not_found") return own("not_a_member", "That person is not a member of this space.");
  if (code === "expired") return own("expired", "That person's access has ended.");
  if (code === "chain_not_person") return own("forbidden", "Only a person can do that.");
  if (code === "bad_input") return own(/scope|expiry/.test(msg) ? "bad_scope" : "bad_input", /scope|expiry/.test(msg) ? "A temp member needs a scope and an end date in the future." : "That is not a valid request.");
  if (code === "not_allowed") {
    if (/at least one owner/.test(msg)) return own("last_owner", "A space must always have an owner. Make someone else an owner first.");
    const m = /^an? (\w+) cannot make someone (\w+)/.exec(msg);
    if (m && roleRank(m[2]) < roleRank(m[1])) return own("exceeds_role", "You cannot give a role above your own.");
    return own("forbidden", "Your role cannot do that here.");
  }
  return e;
}

/** The handle's grants calls with their refusals turned into legacy codes, before kernel-members.js words them. @param {any} handle */
function legacyHandle(handle) {
  const g = handle && handle.gateway && handle.gateway.grants;
  if (!g) return handle;
  const wrap = (/** @type {(...a: any[]) => Promise<any>} */ f) => async (/** @type {any[]} */ ...a) => { try { return await f(...a); } catch (e) { throw legacyError(e); } };
  return { ...handle, gateway: { ...handle.gateway, grants: { ...g, members: { list: wrap(g.members.list), get: wrap(g.members.get) }, setRole: wrap(g.setRole), removeMember: wrap(g.removeMember), transferOwner: wrap(g.transferOwner), sweep: g.sweep && wrap(g.sweep), invites: g.invites } } };
}

/**
 * @param {{ space: string, handle: any, now?: () => number, displayNames?: Record<string, string>, reader?: () => any }} deps
 *   handle: ctx.kernel.for(space). reader: the default kernel context for a call that names none (ownerCount, warnings): a manager or above sees everyone, so only they can count.
 */
export function createKernelMembers(deps) {
  const { space } = deps, now = deps.now || Date.now;
  const handle = legacyHandle(deps.handle);
  const m = kernelMembers({ handle, now });
  /** @type {Record<string, string>} */ const displayNames = { ...(deps.displayNames || {}) };
  const ctxOf = (/** @type {any} */ a) => { const k = (a && a.kernel) || (deps.reader && deps.reader()); return k || {}; };
  const need = (/** @type {any} */ k) => { if (handle && handle.hosted !== false && !k.chain) throw new SpacesError("not_a_member", "Sign in on this device first."); return k; };
  const warnings = (/** @type {number | null} */ owners) => (owners !== null && owners < 2 ? [{ code: "single_owner", message: "This space has one owner. Add a second owner so nobody is ever locked out." }] : []);
  const run = async (/** @type {() => Promise<any>} */ f) => { try { return await f(); } catch (e) { throw legacyError(e); } };

  /** Owners as the caller sees them, or null when the caller is below manager and so cannot see everyone. @param {any} k */
  async function owners(k) {
    const list = await m.list(need(k));
    const me = list.length === 1 ? list[0] : null;
    if (me && !["owner", "admin", "manager"].includes(me.role)) return null;
    return list.filter((/** @type {any} */ x) => x.role === "owner").length;
  }
  const withWarnings = async (/** @type {any} */ r, /** @type {any} */ k) => ({ ...r, warnings: warnings(await owners(k).catch(() => null)) });

  return {
    space, policy: {}, now,
    /** The kernel made the first owner when the Space began; this only reports it. */
    bootstrapOwner: (/** @type {string} */ person) => run(async () => { throw new SpacesError("duplicate", "This space's first owner is made by its kernel when it begins."); }),
    /** Add a person, or change them: the kernel's `grants.setRole`. A person who is already a member is `duplicate`, as before. */
    addMember: (/** @type {any} */ a) => run(async () => {
      const k = need(ctxOf(a));
      if (typeof a.person !== "string" || !a.person) throw new SpacesError("bad_input", "Name the person to add.");
      if (a.actor && typeof a.actor === "object" && a.actor.system === true) throw new SpacesError("forbidden", "A join link is a kernel invite, not a system step.");
      if (!ROLE_IDS.includes(a.role)) throw new SpacesError("bad_input", "Unknown role.");
      const have = await m.get(k, a.person).then((/** @type {any} */ x) => x, () => null);
      if (have && !(have.role === "temp" && have.expires && have.expires <= now())) throw new SpacesError("duplicate", "That person is already a member of this space.");
      return withWarnings({ membership: await m.setRole(k, { person: a.person, role: a.role, ...(a.scope ? { scope: a.scope } : {}), ...(a.expires ? { expires: a.expires } : {}) }) }, k);
    }),
    setRole: (/** @type {any} */ a) => run(async () => {
      const k = need(ctxOf(a));
      return withWarnings({ membership: await m.setRole(k, { person: a.person, role: a.role, ...(a.scope ? { scope: a.scope } : {}), ...(a.expires ? { expires: a.expires } : {}) }) }, k);
    }),
    removeMember: (/** @type {any} */ a) => run(async () => { const k = need(ctxOf(a)); const before = await m.get(k, a.person); await m.removeMember(k, a.person); return withWarnings({ removed: before }, k); }),
    /** Two steps inside the kernel under one proof (grants.transferOwner): the new owner first, so a failure leaves two owners, never none. */
    transferOwnership: (/** @type {any} */ a) => run(async () => {
      const k = need(ctxOf(a));
      const r = await handle.gateway.grants.transferOwner(k.chain, { to: a.to, ...(a.demoteTo ? { demote_to: a.demoteTo } : {}) }, k.proof);
      return withWarnings({ owner: r.owner, previous: r.previous, previous_role: r.previous_role }, k);
    }),
    extendTemp: (/** @type {any} */ a) => run(async () => { const k = need(ctxOf(a)); return withWarnings({ membership: await m.extendTemp(k, { person: a.person, expires: a.newExpires }) }, k); }),
    sweepExpired: () => run(async () => m.sweep()),
    setDisplayName: (/** @type {any} */ a) => { if (!ROLE_IDS.includes(a.role)) throw new SpacesError("bad_input", "Unknown role."); displayNames[a.role] = String(a.name || "").slice(0, 40); return { role: a.role, name: displayNames[a.role] }; },
    roleLabel: (/** @type {string} */ role) => displayNames[role] || role[0].toUpperCase() + role.slice(1),
    getDisplayNames: () => ({ ...displayNames }),
    get: (/** @type {string} */ person, /** @type {any} */ k) => run(async () => m.get(need(k || ctxOf()), person).then((/** @type {any} */ x) => x, (/** @type {any} */ e) => { if (e && e.code === "not_a_member") return undefined; throw e; })),
    list: (/** @type {any} */ k) => run(async () => m.list(need(k || ctxOf()))),
    /** The number of owners as the caller can see it: a manager or above counts, anyone else gets null (unknown). */
    ownerCount: (/** @type {any} */ k) => run(async () => owners(k || ctxOf())),
    warnings: (/** @type {any} */ k) => run(async () => warnings(await owners(k || ctxOf()))),
    abilitiesFor: (/** @type {string} */ person, /** @type {any} */ k) => run(async () => { const x = await m.get(need(k || ctxOf()), person).then((/** @type {any} */ y) => y, () => null); return x ? abilitiesOf(x, now()) : []; }),
  };
}
