// kernel/grants/index.js: the grants store and the calls on it (contract section 6; grant.d.ts, roles.d.ts; invariants 2, 3, 4 and 10).
// Grants and memberships are kernel records held on the home. The event log is the durable copy: every change is one event (grant.created,
// grant.revoked, grant.narrowed, member.set, actor.added) and `rebuild()` replays them, so a restart loses nothing. `authorize` reads its grants and
// members from here (`provider`, `members`). Every change is a `grant`-risk act: a fresh presence proof by the granting person, never from a chain
// that holds a model (authorize denies `model_chain`), and the proof is bound to the exact input (`input_hash`). Widening is always a new grant;
// narrowing and revoking happen in place; a delegated grant has a parent and must be contained in it; revoking a parent revokes its children.
import { canonical, sha256 } from "../core/canonical.js";
import { mintUuid } from "../core/ids.js";
import { isChain, isExactlyPerson } from "../core/chain.js";
import { createGate } from "../core/gate.js";
import { KernelError } from "../core/errors.js";
import { segments, containedPrefix, spaceOf } from "../core/urn.js";
import { contains, patternCovers } from "../core/authorize.js";
import { ROLE_IDS } from "../contracts/index.js";
import { ROLE_ACTIONS, MAY_SET } from "./roles.js";

/** The actions the grants calls register with the authorizer. All but `list` are risk `grant`. */
export const GRANT_ACTIONS = Object.freeze([
  { action: "grants.create", resource_type: "grant", risk: "grant", label: "give access", gloss: "Give a person or an assistant access to something." },
  { action: "grants.revoke", resource_type: "grant", risk: "grant", label: "take access away", gloss: "Remove access, and everything given from it." },
  { action: "grants.narrow", resource_type: "grant", risk: "grant", label: "reduce access", gloss: "Make an existing access smaller." },
  { action: "grants.role", resource_type: "grant", risk: "grant", label: "set a role", gloss: "Make someone an owner, admin, manager, member or temp." },
  { action: "grants.list", resource_type: "grant", risk: "read", label: "see who has access", gloss: "List access you may see." },
].map(a => Object.freeze(a)));

const SUBJECT_KINDS = new Set(["actor", "role", "group"]);
const MAX_DEPTH = 3;
const freeze = (/** @type {any} */ o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) freeze(v); } return o; };
const actorKey = (/** @type {any} */ a) => `${a.kind}:${a.id}`;
const sameActor = (/** @type {any} */ a, /** @type {any} */ b) => Boolean(a && b) && a.kind === b.kind && a.id === b.id && a.space === b.space;

/**
 * @param {{ space: string, log: any, chains: any, clock?: () => number, action_set_version?: number, actions?: () => Iterable<any> }} cfg
 *   actions: the registry (read at call time, so the store never holds a stale copy)
 */
export function createGrantsStore(cfg) {
  const clock = cfg.clock || Date.now;
  const version = cfg.action_set_version ?? 1;
  /** @type {Map<string, any>} */ const grants = new Map();
  /** @type {Map<string, any>} person id -> Membership */ const memberships = new Map();
  /** @type {Set<string>} agent, service and automation actors that belong to the Space */ const actors = new Set();
  /** @type {{ gate: any, allowed: any, registry: () => Map<string, any> } | null} */ let bound = null;

  const reg = () => (bound ? bound.registry() : new Map([...(cfg.actions ? cfg.actions() : [])].map(a => [a.action, a])));
  const since = (/** @type {string} */ a) => reg().get(a)?.since || 0;
  const riskOf = (/** @type {string} */ a) => reg().get(a)?.risk;
  const urn = (/** @type {string} */ type, id = "new") => `vyre://${cfg.space}/${type}/${id}`;
  const kernelChain = () => cfg.chains.fromFacts({ kind: "module", module: "grants", first_party: true });
  const note = (/** @type {any} */ chain, /** @type {string} */ type, /** @type {string} */ subject, /** @type {any} */ data, /** @type {any} */ decision) =>
    cfg.log.append(chain, { type, sv: 1, subject, data, vis: "owner", red: "internal" }, decision ? { decision } : {});

  const memberOk = (/** @type {any} */ a) => {
    if (!a || a.space !== cfg.space) return false;
    if (a.kind === "person") { const m = memberships.get(a.id); return Boolean(m) && !(m.role === "temp" && !(m.expires > clock())); }
    return actors.has(actorKey(a));
  };
  const roleOf = (/** @type {any} */ a) => (a && a.kind === "person" && memberOk(a) ? memberships.get(a.id).role : null);
  const isAdmin = (/** @type {any} */ a) => { const r = roleOf(a); return r === "owner" || r === "admin"; };

  const members = Object.freeze({
    has: memberOk,
    membership: (/** @type {any} */ a) => (a && a.kind === "person" ? memberships.get(a.id) : undefined),
  });
  /** What `authorize` asks: active grants for this subject, by actor or by the role the person holds. */
  const provider = Object.freeze({
    forSubject: (/** @type {any} */ a) => {
      const role = roleOf(a);
      return [...grants.values()].filter(g => g.status === "active" && ((g.subject.kind === "actor" && sameActor(g.subject.actor, a)) || (g.subject.kind === "role" && role !== null && g.subject.name === role)));
    },
    get: (/** @type {string} */ id) => grants.get(id),
  });

  function validateInput(/** @type {any} */ i) {
    if (!i || typeof i !== "object") throw new KernelError("bad_input", "a grant needs an input");
    const s = i.subject;
    if (!s || !SUBJECT_KINDS.has(s.kind) || (s.kind === "actor" && (!s.actor || s.actor.space !== cfg.space || typeof s.actor.id !== "string")) || (s.kind === "role" && !ROLE_IDS.includes(s.name))) throw new KernelError("bad_input", "a grant needs a subject in this Space");
    if (!Array.isArray(i.actions) || !i.actions.length || i.actions.some((/** @type {any} */ a) => typeof a !== "string" || !/^[a-z*][a-z0-9_*]*(\.[a-z*][a-z0-9_*]*)?$/.test(a))) throw new KernelError("bad_input", "a grant needs actions");
    if (!i.resource || !segments(i.resource.prefix) || spaceOf(i.resource.prefix) !== cfg.space) throw new KernelError("bad_input", "a grant needs a resource in this Space");
    if (i.resource.fields !== undefined && (!Array.isArray(i.resource.fields) || i.resource.fields.some((/** @type {any} */ f) => typeof f !== "string" || !f))) throw new KernelError("bad_input", "fields must be a list of field names");
    if (typeof i.source !== "string" || !i.source) throw new KernelError("bad_input", "a grant needs a source");
    // A named action must exist; a pattern is checked at use (it covers only what existed at action_set_version).
    for (const a of i.actions) if (!a.includes("*") && !reg().has(a)) throw new KernelError("bad_input", `${a} is not an action`);
  }

  async function gate(/** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ resource, /** @type {any} */ input, /** @type {any} */ presence) {
    if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
    if (!bound) throw new KernelError("unavailable", "the grants store is not bound to an authorizer");
    // One authorize call, one proof: the proof is bound to this exact input.
    return bound.gate(chain, action, resource, { presence, input_hash: sha256(canonical({ action, input })) });
  }
  const person = (/** @type {any} */ chain) => { if (!isExactlyPerson(chain)) throw new KernelError("chain_not_person", "only a person on their own gives or takes access"); return chain.hops[0].actor; };

  function depthOf(/** @type {any} */ g) { let d = 0; for (let p = g; p && p.parent && d <= MAX_DEPTH + 1; p = grants.get(p.parent)) d++; return d; }

  const api = {
    /** @param {any} chain @param {any} input @param {{ presence?: any }} [o] */
    async create(chain, input, o = {}) {
      validateInput(input);
      const issuer = person(chain);
      const d = await gate(chain, "grants.create", urn("grant"), input, o.presence);
      const draft = { subject: input.subject, actions: [...input.actions], action_set_version: version, resource: { prefix: input.resource.prefix, ...(input.resource.where ? { where: input.resource.where } : {}), ...(input.resource.fields ? { fields: [...input.resource.fields] } : {}) }, conditions: input.conditions || {}, source: input.source };
      if (input.subject.kind === "role" && input.subject.name === "temp" && !(draft.conditions.when && draft.conditions.when.expires > clock())) throw new KernelError("bad_input", "a temp grant needs an expiry");
      if (input.parent) {
        const parent = grants.get(input.parent);
        if (!parent || parent.status !== "active") throw new KernelError("not_found", "no such grant to delegate from");
        // Delegation is the holder's own act, and the child must be provably inside the parent (R6-8).
        if (parent.subject.kind !== "actor" || !sameActor(parent.subject.actor, issuer)) throw new KernelError("not_allowed", "only the holder of a grant delegates it");
        if (depthOf(parent) + 1 > Math.min(MAX_DEPTH, parent.conditions?.delegate?.max_depth ?? 0)) throw new KernelError("not_allowed", "this grant may not be delegated further");
        if (!contains(parent, { ...draft, space: cfg.space }, since, riskOf)) throw new KernelError("not_contained", "the new grant is not inside its parent");
        if ((parent.resource.fields && !draft.resource.fields) || (parent.resource.fields && draft.resource.fields.some((/** @type {string} */ f) => !parent.resource.fields.includes(f)))) throw new KernelError("not_contained", "the new grant reaches fields its parent does not");
      } else if (!isAdmin(issuer)) throw new KernelError("not_allowed", "only an owner or an admin gives access");
      const g = freeze({ id: `gr_${mintUuid(clock())}`, space: cfg.space, ...draft, issuer: { ...issuer }, ...(input.parent ? { parent: input.parent } : {}), ...(input.reason ? { reason: String(input.reason).slice(0, 200) } : {}), status: "active", created_at: clock() });
      grants.set(g.id, g);
      note(chain, "grant.created", urn("grant", g.id), { grant: g }, d.decision);
      return g;
    },

    /** Revoke in place; everything delegated from it goes too. */
    async revoke(chain, id, reason, o = {}) {
      const issuer = person(chain);
      const g = grants.get(id);
      const d = await gate(chain, "grants.revoke", urn("grant", id), { id, reason }, o.presence);
      if (!g) throw new KernelError("not_found", "no such grant");
      // The holder, or an admin, may take a grant away; nobody else.
      if (!isAdmin(issuer) && !(g.issuer && sameActor(g.issuer, issuer))) throw new KernelError("not_allowed", "only an admin or the grant's maker revokes it");
      const out = [];
      const kill = (/** @type {any} */ x) => {
        if (x.status === "revoked") return;
        const n = freeze({ ...x, status: "revoked", revoked_at: clock(), reason: String(reason || "").slice(0, 200) });
        grants.set(n.id, n); out.push(n);
        note(chain, "grant.revoked", urn("grant", n.id), { id: n.id, reason: n.reason, ...(n.id !== id ? { because: id } : {}) }, d.decision);
        for (const c of [...grants.values()]) if (c.parent === n.id) kill(c);
      };
      kill(g);
      return out[0] || g;
    },

    /** Narrow in place: fewer actions, a deeper prefix, more predicates, a shorter life, a smaller field list. Never wider. */
    async narrow(chain, id, patch, o = {}) {
      person(chain);
      const g = grants.get(id);
      const d = await gate(chain, "grants.narrow", urn("grant", id), { id, patch }, o.presence);
      if (!g || g.status !== "active") throw new KernelError("not_found", "no such grant");
      const next = { ...g, actions: patch.actions ? [...patch.actions] : g.actions, resource: { ...g.resource, ...(patch.prefix ? { prefix: patch.prefix } : {}), ...(patch.where ? { where: patch.where } : {}), ...(patch.fields ? { fields: [...patch.fields] } : {}) }, conditions: { ...g.conditions, ...(patch.expires !== undefined ? { when: { ...(g.conditions.when || {}), expires: patch.expires } } : {}) } };
      const gv = g.action_set_version;
      const inside = next.actions.every((/** @type {string} */ a) => g.actions.includes(a) || g.actions.some((/** @type {string} */ p) => !a.includes("*") && patternCovers(p, a, since(a), gv, riskOf(a)) === "covered"))
        && containedPrefix(next.resource.prefix, g.resource.prefix)
        && (g.resource.where || []).every((/** @type {any} */ p) => (next.resource.where || []).some((/** @type {any} */ q) => q.attr === p.attr && q.op === p.op && canonical(q.value) === canonical(p.value)))
        && (g.conditions.when?.expires === undefined || (next.conditions.when?.expires !== undefined && next.conditions.when.expires <= g.conditions.when.expires))
        && (!g.resource.fields || (next.resource.fields && next.resource.fields.every((/** @type {string} */ f) => g.resource.fields.includes(f))));
      if (!inside) throw new KernelError("not_contained", "narrowing may only make a grant smaller");
      const n = freeze(next);
      grants.set(id, n);
      note(chain, "grant.narrowed", urn("grant", id), { grant: n }, d.decision);
      return n;
    },

    /** An admin sees every grant; anyone else only the grants made to them. */
    async list(chain, filter = {}) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      if (!bound) throw new KernelError("unavailable", "the grants store is not bound to an authorizer");
      const me = isExactlyPerson(chain) ? chain.hops[0].actor : null;
      // Everyone may see what they themselves were given; seeing others' access is `grants.list` (managers and above).
      if (!me || !memberOk(me)) throw new KernelError("not_found", "no such grants");
      if (isAdmin(me)) await bound.gate(chain, "grants.list", urn("grant", "*"));
      const mine = (/** @type {any} */ g) => me && g.subject.kind === "actor" && sameActor(g.subject.actor, me);
      return [...grants.values()].filter(g => (me && isAdmin(me)) || mine(g))
        .filter(g => (!filter.status || g.status === filter.status) && (!filter.subject || canonical(g.subject) === canonical(filter.subject)) && (!filter.resource_prefix || g.resource.prefix.startsWith(filter.resource_prefix)))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
    },

    /**
     * Give a person a role: replaces the role's old grants with the bundle's, and records the membership. Temp carries a scope and an expiry.
     * @param {any} chain @param {{ person: string, role: string, scope?: string[], expires?: number }} m @param {{ presence?: any }} [o]
     */
    async setRole(chain, m, o = {}) {
      const issuer = person(chain);
      if (!m || typeof m.person !== "string" || !ROLE_IDS.includes(m.role)) throw new KernelError("bad_input", "a role needs a person and one of the five roles");
      const d = await gate(chain, "grants.role", urn("member", m.person), m, o.presence);
      const mine = roleOf(issuer);
      if (!mine || !(MAY_SET[/** @type {"owner"} */ (mine)] || []).includes(m.role)) throw new KernelError("not_allowed", `a ${mine || "non-member"} cannot make someone ${m.role}`);
      const prior = memberships.get(m.person);
      if (prior && !(MAY_SET[/** @type {"owner"} */ (mine)] || []).includes(prior.role)) throw new KernelError("not_allowed", `a ${mine} cannot change a ${prior.role}`);
      if (m.role === "temp" && (!Array.isArray(m.scope) || !m.scope.length || m.scope.some(s => !segments(s) || spaceOf(s) !== cfg.space) || !(m.expires > clock()))) throw new KernelError("bad_input", "a temp role needs a scope and an expiry");
      const actor = { kind: "person", id: m.person, space: cfg.space };
      // The last owner stays: the Space is never left without one.
      if (prior && prior.role === "owner" && m.role !== "owner" && [...memberships.values()].filter(x => x.role === "owner").length === 1) throw new KernelError("not_allowed", "a Space keeps at least one owner");
      for (const g of [...grants.values()]) if (g.status === "active" && g.source.startsWith("role:") && g.subject.kind === "actor" && sameActor(g.subject.actor, actor)) {
        const n = freeze({ ...g, status: "revoked", revoked_at: clock(), reason: "role changed" }); grants.set(n.id, n);
        note(chain, "grant.revoked", urn("grant", n.id), { id: n.id, reason: "role changed" }, d.decision);
      }
      const membership = freeze({ space: cfg.space, person: m.person, role: m.role, ...(m.role === "temp" ? { scope: [...m.scope], expires: m.expires } : {}), added_by: issuer.id, added_at: clock() });
      memberships.set(m.person, membership);
      note(chain, "member.set", urn("member", m.person), { membership }, d.decision);
      const deleg = m.role === "owner" || m.role === "admin" ? { allowed: true, max_depth: 2 } : { allowed: false, max_depth: 0 };
      const prefixes = m.role === "temp" ? m.scope : [`vyre://${cfg.space}/*/*`];
      const made = [];
      for (const prefix of prefixes) {
        const g = freeze({ id: `gr_${mintUuid(clock())}`, space: cfg.space, subject: { kind: "actor", actor }, actions: [...ROLE_ACTIONS[/** @type {"owner"} */ (m.role)]], action_set_version: version, resource: { prefix }, conditions: { delegate: deleg, ...(m.role === "temp" ? { when: { expires: m.expires } } : {}) }, issuer: { ...issuer }, source: `role:${m.role}`, status: "active", created_at: clock() });
        grants.set(g.id, g); made.push(g);
        note(chain, "grant.created", urn("grant", g.id), { grant: g }, d.decision);
      }
      return { membership, grants: made };
    },

    /** Add an assistant, service or automation to the Space (a membership of its own kind). */
    async addActor(chain, actor, o = {}) {
      const issuer = person(chain);
      if (!actor || !["agent", "service", "automation"].includes(actor.kind) || actor.space !== cfg.space || typeof actor.id !== "string") throw new KernelError("bad_input", "an actor needs a kind, an id and this Space");
      const d = await gate(chain, "grants.role", urn("member", actor.id), { actor }, o.presence);
      if (!isAdmin(issuer)) throw new KernelError("not_allowed", "only an owner or an admin adds an actor");
      actors.add(actorKey(actor));
      note(chain, "actor.added", urn("member", actor.id), { actor }, d.decision);
      return freeze({ ...actor });
    },

    /** The first owner of a new Space, written by the kernel itself (no chain can give the first grant). Once only. */
    bootstrap({ owner }) {
      if (memberships.size) throw new KernelError("not_allowed", "this Space already has members");
      const k = kernelChain();
      const membership = freeze({ space: cfg.space, person: owner, role: "owner", added_by: "kernel", added_at: clock() });
      memberships.set(owner, membership);
      note(k, "member.set", urn("member", owner), { membership });
      const g = freeze({ id: `gr_${mintUuid(clock())}`, space: cfg.space, subject: { kind: "actor", actor: { kind: "person", id: owner, space: cfg.space } }, actions: [...ROLE_ACTIONS.owner], action_set_version: version, resource: { prefix: `vyre://${cfg.space}/*/*` }, conditions: { delegate: { allowed: true, max_depth: 2 } }, issuer: { kind: "service", id: "grants", space: cfg.space }, source: "role:owner", status: "active", created_at: clock() });
      grants.set(g.id, g);
      note(k, "grant.created", urn("grant", g.id), { grant: g });
      return membership;
    },

    /** Rebuild every grant and membership from the log (after a restart). The log is the durable copy. */
    rebuild() {
      grants.clear(); memberships.clear(); actors.clear();
      for (const e of cfg.log.read({})) {
        const d = e.data;
        if (!d || typeof d !== "object") continue;
        if (e.type === "grant.created" || e.type === "grant.narrowed") grants.set(d.grant.id, freeze(structuredClone(d.grant)));
        else if (e.type === "grant.revoked") { const g = grants.get(d.id); if (g) grants.set(d.id, freeze({ ...g, status: "revoked", revoked_at: e.time, reason: d.reason })); }
        else if (e.type === "member.set") memberships.set(d.membership.person, freeze(structuredClone(d.membership)));
        else if (e.type === "actor.added") actors.add(actorKey(d.actor));
      }
    },
  };

  return Object.freeze({
    ...api, provider, members, isAdmin, roleOf,
    /** Called once by the gateway, with the authorizer it built from `provider` and `members`. */
    bind(/** @type {{ authorizer: any, registry: () => Map<string, any> }} */ b) { bound = { ...createGate({ authorizer: b.authorizer, log: cfg.log }), registry: b.registry }; },
  });
}
