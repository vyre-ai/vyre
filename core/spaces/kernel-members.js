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
import { ownerWideRead } from "../../lib/member-scope.js";

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
  // A space's home on a server answers a presence ask with a one-use challenge: it is kept (plain data) so the tool can hand it to the person's device to sign.
  if (e && e.challenge && typeof e.challenge === "object") /** @type {any} */ (out).challenge = e.challenge;
  return out;
}

/**
 * @param {{ handle: any, now?: () => number }} d
 */
export function kernelMembers({ handle, now = Date.now }) {
  const grants = () => {
    const g = handle && handle.gateway && handle.gateway.grants;
    if (!g) throw Object.assign(new Error("This space's kernel is not reachable; wait a minute and try again, or check the home is on."), { code: "unreachable" });
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
        if (typeof g.invites.revoke !== "function") throw Object.assign(new Error("This space's kernel cannot cancel an invite yet; ask the owner to update its home."), { code: "unavailable", own: true });
        return g.invites.revoke(need(k).chain, id, k.proof);
      }),
      /** The invites the caller may see: their own, or all of them for a manager and above. Needs the kernel's `invites.list(chain)`; never carries a link or a hash. */
      list: (/** @type {any} */ k) => run(async () => {
        const g = grants();
        if (typeof g.invites.list !== "function") throw Object.assign(new Error("This space's kernel cannot list invites yet; ask the owner to update its home."), { code: "unavailable", own: true });
        return g.invites.list(need(k).chain);
      }),
      /** The join card: what the invite offers, from the kernel. */
      get: (/** @type {any} */ k, /** @type {string} */ id) => run(async () => grants().invites.get(need(k).chain, id)),
      /** The invitee accepts under their own chain and their own proof, over exactly what they were shown. */
      accept: (/** @type {any} */ k, /** @type {string} */ id, /** @type {{ role: string, scope?: string[]|null, expires?: number|null, invitee?: string|null }} */ seen, /** @type {any} */ bind) => run(async () => grants().invites.accept(need(k).chain, id, { seen, proof: k.proof && k.proof.presence, ...(bind ? { bind } : {}) })),
    },
    now,
  };
}

/** A membership as the tools show it. @param {any} m */
const shape = m => ({ space: m.space, person: m.person, role: m.role, scope: m.scope ?? null, expires: m.expires ?? null, added_by: m.added_by ?? null, added_at: m.added_at ?? null, ...(m.partial ? { partial: true } : {}) });

/** The words a person may be shown about a starting store: the progress sentence the store gives, and for anything else (a failure's own text, which can hold paths or errors) one fixed sentence. */
const PROGRESS = /^(starting Records|the record store is still starting)/;

/**
 * Whether the records of the spaces the caller is in are up (a team space's own store takes about a minute the first time): `{ spaces: [{ space, ready, words? }] }`. Only the spaces in `mine` (the
 * caller's own list) are looked at, so nothing is said of another person's Space on the same server. The app's Now shows a calm "setting up" card from it instead of an error or an empty list.
 * @param {any} K @param {string[]} mine
 */
export async function recordsStatus(K, mine) {
  const out = [];
  const known = new Set([...(K && typeof K.space === "string" ? [K.space] : []), ...(K && K.spaces && typeof K.spaces.list === "function" ? K.spaces.list() : [])]);
  for (const id of mine) {
    if (!known.has(id)) continue;
    let h = null; try { h = K ? K.for(id) : null; } catch { h = null; }
    const store = (h && h.store) || (id === (K && K.space) ? K.store : null);
    if (!store || typeof store.attached !== "function" || store.attached()) { out.push({ space: id, ready: true }); continue; }
    let detail = "";
    try { detail = String((await store.health()).detail || ""); } catch { /* no words */ }
    out.push({ space: id, ready: false, words: PROGRESS.test(detail) ? detail : "the records are not ready yet" });
  }
  return { spaces: out };
}

/** The first person on the call's chain, whatever hops follow (a person's assistant acts for that person); null when the call carries no chain or none of its hops is a person. @param {any} K @param {any} meta @returns {Promise<string | null>} */
async function firstPerson(K, meta) {
  if (!(K && typeof K.chain === "function" && meta && (meta.kernelFacts || meta.token))) return null;
  try { const c = await K.chain(meta); const h = c && Array.isArray(c.hops) ? c.hops.find((/** @type {any} */ x) => x.actor && x.actor.kind === "person") : null; return h ? String(h.actor.id) : null; } catch { return null; }
}

/**
 * The person an ACT is by: the first person on the call's chain, so another person's assistant is that person and never the home's owner. A call that carries a chain but no person is nobody (null, which
 * matches no one); a call with no chain at all is this box's own terminal, the home's person `home`.
 * @param {any} K @param {any} meta @param {string} home @returns {Promise<string | null>}
 */
export async function actingPerson(K, meta, home) {
  if (!(meta && (meta.kernelFacts || meta.token)) || !K || typeof K.chain !== "function") return home;
  return firstPerson(K, meta);
}

/**
 * The person a Space LIST is for: the first person on the call's chain, whatever hops follow (a person's assistant or an automation asks for that person). A call with no person on its chain is the
 * owner's own only when it came over one of this box's own surfaces (the terminal, the deck, the capsule: lib/person-surfaces.js); any other caller without a chain gets nothing. Not `callerPerson`: the one-hop rule there is deliberate for acts.
 * @param {any} K @param {any} meta @returns {Promise<string | null>}
 */
export async function listCaller(K, meta) {
  const p = await firstPerson(K, meta);
  if (p) return p;
  const wide = await ownerWideRead(K, meta || {}, String(meta?.caller || "cli"));
  return wide && typeof K.owner === "string" ? K.owner : null;
}

/**
 * The Spaces this home's kernel hosts that a person is in, as spaces.merge-list lists them ({ space, name, color, link }). The module's own table holds only the Spaces it made itself; a server's team Spaces are
 * the kernel's, so a module that asks "which Spaces is this person in" (Publish, the doors) must read them here. The home's own Space stays out: it is internal, as in spaces.list.
 * @param {any} K @param {string} person @returns {Promise<{ space: string, name: string | null, color: null, link: string | null }[]>}
 */
export async function kernelTeamSpaces(K, person) {
  const out = [];
  if (!K || !K.spaces || typeof K.spaces.list !== "function" || typeof K.membership !== "function") return out;
  for (const id of K.spaces.list()) {
    if (id === K.space) continue;
    let m = null; try { const r = await K.membership(person, id); if (r && r.member === true) m = r; } catch { m = null; }
    if (!m) continue;
    const d = typeof K.spaces.describe === "function" ? K.spaces.describe(id) : null, host = d && d.name ? `${String(d.name).replace(/\.vyre\.run$/, "")}.vyre.run` : null;
    out.push({ space: id, name: host, color: null, link: host ? `https://${host}` : null });
  }
  return out;
}

/**
 * Whether a Space lets its members run their sessions on their own computers (G01), read or set. The allow is ONE kernel Offer, the Space's side for member "*" with no computer named: an owner or an admin makes it (under
 * their own yes), withdraws it the same way, and every member's own lend then counts as allowed by the Space. Each member still lends their own computer with their own yes; the Space's allow is not a lend.
 * `allow` left out reads. Answers { space, allowed }.
 * @param {{ i: { space: string, allow?: boolean }, meta: any, row: { id: string }, h: any, caller: string, self: string, role: string | null, kctxOf: (meta: any, space: string) => Promise<{ chain: any, proof: any }>, answerChallenge: (ch: any, space: string) => Promise<any>, refuse: (message: string, code: string) => Error }} d
 * @returns {Promise<{ space: string, allowed: boolean }>}
 */
export async function membersComputers(d) {
  const { i, meta, row, h, caller, self, role, kctxOf, answerChallenge, refuse } = d;
  const offers = h && h.gateway && h.gateway.grants && h.gateway.grants.offers;
  if (!offers || typeof offers.find !== "function") throw refuse("This Space cannot say whether its members' computers are allowed here: ask the owner of this server to update it.", "unavailable");
  const find = () => offers.find({ side: "space_allows", member: "*", device: null });
  if (i.allow === undefined) { if (!role) throw refuse("You are not a member of this space.", "not_a_member"); return { space: row.id, allowed: Boolean(await find()) }; }
  if (caller !== self) throw refuse("That is not yours to do; only that person can do it, on their own device.", "forbidden");
  if (role !== "owner" && role !== "admin") throw refuse("Only an owner or an admin of the Space says whether its members may run sessions on their own computers.", "forbidden");
  const withYes = async (/** @type {(k: any) => Promise<any>} */ run) => {
    const k = await kctxOf(meta, row.id);
    try { return await run(k); } catch (e) {
      const ch = /** @type {any} */ (e) && /** @type {any} */ (e).challenge;
      if (!ch || typeof ch.nonce !== "string" || !/^(presence_required|needs_presence)$/.test(String(/** @type {any} */ (e).code))) throw plainKernelError(e);
      const proof = await answerChallenge(ch, row.id);
      if (!proof) throw plainKernelError(e);
      return run(await kctxOf({ ...meta, kernel_proof: proof }, row.id));
    }
  };
  const have = await find();
  if (i.allow === true && !have) await withYes(k => offers.offer(k.chain, { side: "space_allows", member: "*", device: null }, k.proof));
  if (i.allow === false && have) await withYes(k => offers.unoffer(k.chain, have.id, k.proof));
  return { space: row.id, allowed: Boolean(await find()) };
}
