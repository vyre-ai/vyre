// @ts-check
// lib/spaces/members.js: the five roles as membership rules for one Space. Pure library: every impure thing
// (clock, event emitter, storage, presence verifier) is injected, so each rule is unit-testable.
// Source: team/0.3/DESIGN-spaces-first.md section 4, SPEC-core-contract sections 4 and 10.8, kernel/contracts/roles.d.ts.
//
// Rules in one place:
//   owner    everything; at least one owner always (two recommended).
//   admin    members and roles below admin (manager, member, temp), devices; never owners or admins; never delete, move, transfer.
//   manager, member, temp  manage no members.
//   temp     needs a non-empty scope (project or record URNs) and an expiry in the future; non-temp carry neither.
//   A person holds one membership per Space. An actor cannot grant a role above its own.
//   Grant changes that need a presence proof: granting owner, transferring ownership, extending a temp.

import { ROLE_IDS, ROLE_BUNDLES } from "../../kernel/contracts/index.js";

/** @typedef {import("../../kernel/contracts/roles.js").RoleId} RoleId */
/** @typedef {import("../../kernel/contracts/roles.js").RoleAbility} RoleAbility */
/** @typedef {import("../../kernel/contracts/roles.js").Membership & { expired?: boolean, expired_at?: number }} StoredMembership */

export const ERROR_CODES = Object.freeze([
  // members
  "not_a_member", "forbidden", "last_owner", "bad_scope", "expired", "needs_presence", "exceeds_role", "duplicate", "bad_input",
  // invites (lib/spaces/invites.js)
  "forged", "revoked", "wrong_space", "used_up", "bad_proof", "unknown_invite",
]);

export class SpacesError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "SpacesError";
    this.code = code;
  }
}

/** @param {string} code @param {string} message @returns {never} */
const fail = (code, message) => { throw new SpacesError(code, message); };

const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_POLICY = Object.freeze({
  /** Longest a temp membership may run from now. */
  maxTempMs: 365 * DAY,
  /** Furthest an extension may reach from now. */
  maxExtendMs: 365 * DAY,
  /** Whether managers may create invites (member or temp, inside their own projects). */
  managersInvite: false,
});

/** Strongest first: lower rank is stronger. */
export const roleRank = (/** @type {string} */ role) => ROLE_IDS.indexOf(/** @type {any} */ (role));
const isRole = (/** @type {any} */ r) => typeof r === "string" && roleRank(r) >= 0;

/** Roles each role may assign, add or remove. Owner may touch every role; admin only below admin. */
const MANAGEABLE = Object.freeze({
  owner: [...ROLE_IDS],
  admin: ["manager", "member", "temp"],
  manager: [], member: [], temp: [],
});

/** @param {string} actorRole @param {string} targetRole */
export function canAssign(actorRole, targetRole) {
  return !!(MANAGEABLE[/** @type {RoleId} */ (actorRole)] || []).includes(/** @type {never} */ (targetRole));
}
/** @param {string} actorRole @param {string} targetRole */
export function canRemove(actorRole, targetRole) {
  return canAssign(actorRole, targetRole);
}

/** An expired temp is one whose end has come (end is exclusive: at `expires` access is already gone) or that a sweep marked. */
export function isExpired(/** @type {StoredMembership} */ m, /** @type {number} */ now) {
  if (!m || m.role !== "temp") return false;
  return m.expired === true || (typeof m.expires === "number" && m.expires <= now);
}

/** @param {StoredMembership} m @param {number} now @returns {readonly RoleAbility[]} */
export function abilitiesOf(m, now) {
  if (!m || !isRole(m.role) || isExpired(m, now)) return Object.freeze([]);
  return ROLE_BUNDLES[/** @type {RoleId} */ (m.role)].abilities;
}

const URN_RE = /^vyre:\/\/[^/?#\s]+(\/[A-Za-z0-9._~:@-]+)+$/;
/** A URN with no traversal segments, query, fragment or escapes. */
export function isCleanUrn(/** @type {any} */ u) {
  return typeof u === "string" && u.length <= 512 && URN_RE.test(u) && !u.split("/").slice(3).some(s => s === "." || s === "..");
}
/** A scope entry names one project or record: `vyre://<space>/<type>/<id>[/...]`, at least type and id. */
export function isValidScopeEntry(/** @type {any} */ s) {
  return isCleanUrn(s) && s.split("/").length >= 5;
}
/** Prefix match on whole path segments. */
export function urnWithin(/** @type {string} */ urn, /** @type {string} */ prefix) {
  return urn === prefix || urn.startsWith(prefix + "/");
}

/**
 * Whether the membership reaches a resource. Temp: only inside its scope list and only until it expires.
 * Every other role: true while its abilities are non-empty (per-resource rules belong to the kernel).
 */
export function reaches(/** @type {StoredMembership} */ m, /** @type {string} */ urn, /** @type {number} */ now) {
  if (!m || !isCleanUrn(urn)) return false;
  if (abilitiesOf(m, now).length === 0) return false;
  if (m.role !== "temp") return true;
  const scope = Array.isArray(m.scope) ? m.scope : [];
  return scope.length > 0 && scope.some(s => isValidScopeEntry(s) && urnWithin(urn, s));
}

/**
 * Per-project override: a subset of the role's abilities. It may narrow and never widen:
 * anything the role lacks, or anything the role never holds, throws.
 * @param {RoleId} role @param {readonly RoleAbility[]} subset @returns {readonly RoleAbility[]}
 */
export function narrow(role, subset) {
  if (!isRole(role)) fail("bad_input", "Unknown role.");
  if (!Array.isArray(subset)) fail("bad_input", "A narrowed role needs a list of abilities.");
  const b = ROLE_BUNDLES[role];
  for (const a of subset) {
    if (b.never.includes(a)) fail("exceeds_role", `The ${role} role never holds ${a}.`);
    if (!b.abilities.includes(a)) fail("exceeds_role", `The ${role} role does not hold ${a}, so a project cannot add it.`);
  }
  return Object.freeze([...new Set(subset)]);
}

/**
 * What a device may do: its person's abilities in that Space. No active membership, a revoked device or a device
 * with no person (a server is a Space node, authorised by the kernel) has none.
 * @param {{ id?: string, person?: string, space: string, revoked?: boolean }} device
 * @param {{ get(space: string, person: string): any }} store @param {number} now
 */
export async function deviceAbilities(device, store, now) {
  if (!device || device.revoked || !device.person || !device.space) return Object.freeze([]);
  const m = await store.get(device.space, device.person);
  return m ? abilitiesOf(m, now) : Object.freeze([]);
}

/**
 * The most an assistant may do: the grants of the person who added it, capped by that person's role. A temp's
 * assistants act only when `granted` is true, and then only inside the temp's scope and until its expiry.
 * @param {StoredMembership} addedBy @param {number} now @param {{ granted?: boolean }} [opts]
 * @returns {{ abilities: readonly RoleAbility[], scope?: readonly string[], expires?: number }}
 */
export function assistantCap(addedBy, now, opts = {}) {
  const abilities = abilitiesOf(addedBy, now);
  if (abilities.length === 0) return { abilities };
  const b = ROLE_BUNDLES[addedBy.role];
  if (!b.assistants_act_for_holder && !opts.granted) return { abilities: Object.freeze([]) };
  if (addedBy.role === "temp") return { abilities, scope: addedBy.scope, expires: addedBy.expires };
  return { abilities };
}

/**
 * Check scope and expiry for a role. Returns the normalised pair to store.
 * @param {RoleId} role @param {any} scope @param {any} expires @param {number} now @param {{ maxTempMs: number }} policy
 */
export function validateGrant(role, scope, expires, now, policy) {
  if (role !== "temp") {
    if ((scope !== undefined && scope !== null && !(Array.isArray(scope) && scope.length === 0)) || (expires !== undefined && expires !== null)) {
      fail("bad_scope", "Only a temp membership carries a scope or an end date.");
    }
    return {};
  }
  if (!Array.isArray(scope) || scope.length === 0) fail("bad_scope", "A temp membership must name the projects or records it reaches.");
  if (!scope.every(isValidScopeEntry)) fail("bad_scope", "Each temp scope entry must be a project or record address.");
  if (typeof expires !== "number" || !Number.isFinite(expires)) fail("bad_scope", "A temp membership must have an end date.");
  if (expires <= now) fail("expired", "The end date is already past.");
  if (expires - now > policy.maxTempMs) fail("bad_scope", "That end date is further out than this space allows.");
  return { scope: Object.freeze([...new Set(scope)]), expires };
}

/** In-memory MembershipStore for tests. Records are copied in and out. */
export function memoryStore() {
  /** @type {Map<string, StoredMembership>} */
  const m = new Map();
  const key = (/** @type {string} */ s, /** @type {string} */ p) => `${s}\u0000${p}`;
  const copy = (/** @type {any} */ r) => (r ? Object.freeze(structuredClone(r)) : undefined);
  return {
    /** @param {string} space @param {string} person */
    get(space, person) { return copy(m.get(key(space, person))); },
    /** @param {StoredMembership} rec */
    put(rec) { m.set(key(rec.space, rec.person), structuredClone(rec)); },
    /** @param {string} space @param {string} person */
    delete(space, person) { return m.delete(key(space, person)); },
    /** @param {string} space */
    list(space) { return [...m.values()].filter(r => r.space === space).map(copy); },
  };
}

/** The actor for system-driven changes such as an accepted invite. It can never grant owner. */
export const systemActor = (/** @type {string} */ onBehalfOf) => Object.freeze({ system: true, by: onBehalfOf });

/**
 * One Space's membership service.
 * @param {{
 *   space: string,
 *   store: { get(space: string, person: string): any, put(rec: any): any, delete(space: string, person: string): any, list(space: string): any },
 *   now: () => number,
 *   emit?: (type: string, payload: Record<string, any>) => any,
 *   verifyPresence?: (payload: { action: string, space: string, person: string, from: any, to: any }, proof: any) => any,
 *   policy?: Partial<typeof DEFAULT_POLICY>,
 *   displayNames?: Partial<Record<RoleId, string>>,
 * }} deps
 */
export function createMembers(deps) {
  const { space, store, now } = deps;
  if (!space || !store || typeof now !== "function") fail("bad_input", "createMembers needs a space, a store and a clock.");
  const emit = deps.emit || (() => {});
  const policy = { ...DEFAULT_POLICY, ...(deps.policy || {}) };
  /** @type {Partial<Record<RoleId, string>>} */
  const displayNames = { ...(deps.displayNames || {}) };

  let chain = Promise.resolve();
  /** Operations run one at a time so the owner count cannot be raced. @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const locked = fn => { const r = chain.then(fn); chain = r.then(() => {}, () => {}); return r; };

  const all = async () => /** @type {StoredMembership[]} */ ((await store.list(space)) || []);
  const ownerCount = async () => (await all()).filter(m => m.role === "owner").length;
  const warningsFor = (/** @type {number} */ owners) => owners < 2
    ? [{ code: "single_owner", message: "This space has one owner. Add a second owner so nobody is ever locked out." }] : [];

  /** @param {any} actor @returns {Promise<{ id: string, role: RoleId, system: boolean, m?: StoredMembership }>} */
  async function who(actor) {
    if (actor && typeof actor === "object" && actor.system === true) {
      if (typeof actor.by !== "string" || !actor.by) fail("bad_input", "A system actor names who it acts for.");
      return { id: actor.by, role: "temp", system: true };
    }
    if (typeof actor !== "string" || !actor) fail("bad_input", "Name the person who is acting.");
    const m = await store.get(space, actor);
    if (!m) fail("not_a_member", "That person is not a member of this space.");
    if (isExpired(m, now())) fail("expired", "That person's access has ended.");
    return { id: actor, role: m.role, system: false, m };
  }

  /** @param {string} type @param {string} person @param {RoleId} role @param {string} by @param {Record<string, any>} [extra] */
  const ev = (type, person, role, by, extra) => emit(type, { space, person, role, by, at: now(), ...(extra || {}) });

  /** @param {{ action: string, space: string, person: string, from: any, to: any }} payload @param {any} proof */
  async function needPresence(payload, proof) {
    if (proof === undefined || proof === null || typeof deps.verifyPresence !== "function") fail("needs_presence", "This change needs your approval on your device.");
    let ok = false;
    try { ok = !!(await deps.verifyPresence(payload, proof)); } catch { ok = false; }
    if (!ok) fail("needs_presence", "The approval did not match this change. Approve it again on your device.");
  }

  const checkAbove = (/** @type {RoleId} */ actorRole, /** @type {RoleId} */ role) => {
    if (roleRank(role) < roleRank(actorRole)) fail("exceeds_role", "You cannot give a role above your own.");
  };

  /** Create the first owner of an empty space. */
  function bootstrapOwner(/** @type {string} */ person) {
    return locked(async () => {
      if (typeof person !== "string" || !person) fail("bad_input", "Name the first owner.");
      if ((await all()).length > 0) fail("duplicate", "This space already has members.");
      const rec = { space, person, role: /** @type {RoleId} */ ("owner"), added_by: person, added_at: now() };
      await store.put(rec);
      await ev("member.added", person, "owner", person);
      return { membership: rec, warnings: warningsFor(1) };
    });
  }

  function addMember(/** @type {{ actor: any, person: string, role: RoleId, scope?: string[], expires?: number, presence?: any }} */ a) {
    return locked(async () => {
      const t = now();
      if (typeof a.person !== "string" || !a.person) fail("bad_input", "Name the person to add.");
      if (!isRole(a.role)) fail("bad_input", "Unknown role.");
      const actor = await who(a.actor);
      if (actor.system) {
        if (a.role === "owner") fail("forbidden", "An owner is never added by a link or a system step.");
      } else {
        checkAbove(actor.role, a.role);
        if (!canAssign(actor.role, a.role)) fail("forbidden", "You cannot add someone with that role.");
      }
      const existing = await store.get(space, a.person);
      if (existing && !isExpired(existing, t)) fail("duplicate", "That person is already a member of this space.");
      const grant = validateGrant(a.role, a.scope, a.expires, t, policy);
      if (a.role === "owner") await needPresence({ action: "member.grant_owner", space, person: a.person, from: null, to: "owner" }, a.presence);
      /** @type {any} */
      const rec = { space, person: a.person, role: a.role, ...grant, added_by: actor.id, added_at: t };
      await store.put(rec);
      await ev("member.added", a.person, a.role, actor.id, grant.expires ? { expires: grant.expires, scope: grant.scope } : undefined);
      return { membership: rec, warnings: warningsFor(await ownerCount()) };
    });
  }

  function setRole(/** @type {{ actor: any, person: string, role: RoleId, scope?: string[], expires?: number, presence?: any }} */ a) {
    return locked(async () => {
      const t = now();
      if (!isRole(a.role)) fail("bad_input", "Unknown role.");
      const actor = await who(a.actor);
      if (actor.system) fail("forbidden", "A system step cannot change roles.");
      const target = await store.get(space, a.person);
      if (!target || isExpired(target, t)) fail("not_a_member", "That person is not a member of this space.");
      const self = actor.id === a.person;
      const lowering = roleRank(a.role) > roleRank(target.role);
      if (!(self && lowering)) {
        if (!canAssign(actor.role, target.role)) fail("forbidden", "You cannot change that person's role.");
        checkAbove(actor.role, a.role);
        if (!canAssign(actor.role, a.role)) fail("forbidden", "You cannot give that role.");
      }
      if (target.role === a.role && a.role !== "temp") fail("bad_input", "That person already has this role.");
      const grant = validateGrant(a.role, a.scope, a.expires, t, policy);
      if (target.role === "temp" && a.role === "temp") {
        // Same role: only a narrowing is a plain edit. Anything wider is a grant change with its own path.
        const old = target.scope || [];
        if (!(grant.scope || []).every(s => old.some(o => urnWithin(s, o)))) fail("bad_scope", "That would widen the temp scope. Remove the person and add them again.");
        if (/** @type {number} */ (grant.expires) > /** @type {number} */ (target.expires)) fail("needs_presence", "Extending a temp end date is done with extendTemp and your approval.");
      }
      if (target.role === "owner" && a.role !== "owner" && (await ownerCount()) <= 1) fail("last_owner", "A space must always have an owner. Make someone else an owner first.");
      if (a.role === "owner") await needPresence({ action: "member.grant_owner", space, person: a.person, from: target.role, to: "owner" }, a.presence);
      /** @type {any} */
      const rec = { space, person: a.person, role: a.role, ...grant, added_by: target.added_by, added_at: target.added_at };
      await store.put(rec);
      await ev("member.role_changed", a.person, a.role, actor.id, { from_role: target.role, ...(grant.expires ? { expires: grant.expires, scope: grant.scope } : {}) });
      return { membership: rec, warnings: warningsFor(await ownerCount()) };
    });
  }

  function removeMember(/** @type {{ actor: any, person: string }} */ a) {
    return locked(async () => {
      const actor = await who(a.actor);
      if (actor.system) fail("forbidden", "A system step cannot remove members.");
      const target = await store.get(space, a.person);
      if (!target) fail("not_a_member", "That person is not a member of this space.");
      if (actor.id !== a.person && !canRemove(actor.role, target.role)) fail("forbidden", "You cannot remove that person.");
      if (target.role === "owner" && (await ownerCount()) <= 1) fail("last_owner", "A space must always have an owner. Make someone else an owner first.");
      await store.delete(space, a.person);
      await ev("member.removed", a.person, target.role, actor.id);
      return { removed: target, warnings: warningsFor(await ownerCount()) };
    });
  }

  /** Hand the space to another member. The old owner drops to `demoteTo` (default admin). Needs an owner and a presence proof. */
  function transferOwnership(/** @type {{ actor: any, to: string, presence?: any, demoteTo?: RoleId }} */ a) {
    return locked(async () => {
      const t = now();
      const demoteTo = a.demoteTo || "admin";
      if (!["admin", "manager", "member"].includes(demoteTo)) fail("bad_input", "The old owner can become admin, manager or member.");
      const actor = await who(a.actor);
      if (actor.system || actor.role !== "owner") fail("forbidden", "Only an owner can transfer ownership.");
      if (a.to === actor.id) fail("bad_input", "Choose someone else.");
      const target = await store.get(space, a.to);
      if (!target || isExpired(target, t)) fail("not_a_member", "That person is not a member of this space.");
      if (target.role === "temp") fail("bad_input", "A temp member cannot become an owner. Give them a regular role first.");
      if (target.role === "owner") fail("bad_input", "That person is already an owner.");
      await needPresence({ action: "ownership.transfer", space, person: a.to, from: actor.id, to: a.to }, a.presence);
      const old = /** @type {StoredMembership} */ (actor.m);
      await store.put({ space, person: a.to, role: "owner", added_by: target.added_by, added_at: target.added_at });
      await store.put({ space, person: actor.id, role: demoteTo, added_by: old.added_by, added_at: old.added_at });
      await ev("member.role_changed", a.to, "owner", actor.id, { from_role: target.role });
      await ev("member.role_changed", actor.id, demoteTo, actor.id, { from_role: "owner" });
      await ev("ownership.transferred", a.to, "owner", actor.id, { from: actor.id, to: a.to });
      return { owner: a.to, previous: actor.id, previous_role: demoteTo, warnings: warningsFor(await ownerCount()) };
    });
  }

  /** Mark every temp whose end has come, emit member.expired once per member, return them. */
  function sweepExpired(/** @type {number} */ at) {
    return locked(async () => {
      const t = typeof at === "number" ? at : now();
      const out = [];
      for (const m of await all()) {
        if (m.role !== "temp" || m.expired === true || typeof m.expires !== "number" || m.expires > t) continue;
        const rec = { ...m, expired: true, expired_at: t };
        await store.put(rec);
        await ev("member.expired", m.person, "temp", "system", { expires: m.expires });
        out.push(rec);
      }
      return out;
    });
  }

  /** Extend a temp's end date. A grant change: needs `members.manage_below_admin` and a presence proof bound to exactly this payload. */
  function extendTemp(/** @type {{ actor: any, person: string, newExpires: number, presence?: any }} */ a) {
    return locked(async () => {
      const t = now();
      const actor = await who(a.actor);
      if (actor.system || !abilitiesOf(/** @type {any} */ (actor.m), t).includes("members.manage_below_admin")) fail("forbidden", "You cannot extend someone's access.");
      const target = await store.get(space, a.person);
      if (!target) fail("not_a_member", "That person is not a member of this space.");
      if (target.role !== "temp" || typeof target.expires !== "number") fail("bad_input", "Only a temp membership has an end date to extend.");
      if (typeof a.newExpires !== "number" || !Number.isFinite(a.newExpires)) fail("bad_input", "Give the new end date.");
      if (a.newExpires <= t) fail("expired", "The new end date is already past.");
      if (a.newExpires <= target.expires) fail("bad_input", "The new end date must be later than the current one.");
      if (a.newExpires - t > policy.maxExtendMs) fail("bad_scope", "That end date is further out than this space allows.");
      await needPresence({ action: "member.extend", space, person: a.person, from: target.expires, to: a.newExpires }, a.presence);
      /** @type {any} */
      const rec = { space, person: a.person, role: "temp", scope: target.scope, expires: a.newExpires, added_by: target.added_by, added_at: target.added_at };
      await store.put(rec);
      await ev("member.extended", a.person, "temp", actor.id, { from: target.expires, to: a.newExpires });
      return { membership: rec };
    });
  }

  /** Display names only: ids never change. Owner or admin. */
  function setDisplayName(/** @type {{ actor: any, role: RoleId, name: string }} */ a) {
    return locked(async () => {
      const actor = await who(a.actor);
      if (actor.system || !["owner", "admin"].includes(actor.role)) fail("forbidden", "Only an owner or admin can rename roles.");
      if (!isRole(a.role)) fail("bad_input", "Unknown role.");
      const name = typeof a.name === "string" ? a.name.trim() : "";
      // eslint-disable-next-line no-control-regex
      if (!name || name.length > 32 || /[\u0000-\u001f<>]/.test(name)) fail("bad_input", "A role name is 1 to 32 plain characters.");
      for (const r of ROLE_IDS) if (r !== a.role && roleLabel(r).toLowerCase() === name.toLowerCase()) fail("duplicate", "Another role already uses that name.");
      displayNames[a.role] = name;
      return { role: a.role, name };
    });
  }
  function roleLabel(/** @type {string} */ role) {
    return displayNames[/** @type {RoleId} */ (role)] || role[0].toUpperCase() + role.slice(1);
  }

  return {
    space, store, policy,
    bootstrapOwner, addMember, setRole, removeMember, transferOwnership, sweepExpired, extendTemp, setDisplayName, roleLabel,
    getDisplayNames: () => ({ ...displayNames }),
    get: (/** @type {string} */ person) => store.get(space, person),
    list: all,
    ownerCount,
    warnings: async () => warningsFor(await ownerCount()),
    abilitiesFor: async (/** @type {string} */ person) => { const m = await store.get(space, person); return m ? abilitiesOf(m, now()) : []; },
  };
}
