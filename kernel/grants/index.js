// kernel/grants/index.js: the grants store and the calls on it (contract section 6; grant.d.ts, roles.d.ts; invariants 2, 3, 4 and 10).
// Grants and memberships are kernel records held on the home. The event log is the durable copy: every change is one event (grant.created,
// grant.revoked, grant.narrowed, member.set, actor.added) and `rebuild()` replays them, so a restart loses nothing. `authorize` reads its grants and
// members from here (`provider`, `members`). Every change is a `grant`-risk act: a fresh presence proof by the granting person, never from a chain
// that holds a model (authorize denies `model_chain`), and the proof is bound to the exact input (`input_hash`). Widening is always a new grant;
// narrowing and revoking happen in place; a delegated grant has a parent and must be contained in it; revoking a parent revokes its children.
import { canonical, sha256, hmac, sameMac } from "../core/canonical.js";
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
  { action: "grants.offer", resource_type: "offer", risk: "grant", label: "offer a computer for work", gloss: "Let a Space's work run on a member's computer, or accept that on your own." },
  { action: "grants.invite", resource_type: "invite", risk: "grant", label: "invite someone", gloss: "Invite a person to join with a role." },
  { action: "grants.list", resource_type: "grant", risk: "read", label: "see who has access", gloss: "List access you may see." },
].map(a => Object.freeze(a)));

const SUBJECT_KINDS = new Set(["actor", "role", "group"]);
const MAX_DEPTH = 3;
const freeze = (/** @type {any} */ o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) freeze(v); } return o; };
const actorKey = (/** @type {any} */ a) => `${a.kind}:${a.id}`;
const sameActor = (/** @type {any} */ a, /** @type {any} */ b) => Boolean(a && b) && a.kind === b.kind && a.id === b.id && a.space === b.space;

/**
 * @param {{ presence?: { check(i: any): Promise<string | null> }, space: string, log: any, chains: any, key: Uint8Array | string, clock?: () => number, action_set_version?: number, actions?: () => Iterable<any>, label?: () => { name?: string, words?: string } }} cfg
 *   actions: the registry (read at call time, so the store never holds a stale copy). key: the kernel's secret (as the chain builder's): every event this
 *   store writes carries a MAC under it, and `rebuild` takes authority only from events that verify, so an event any chain appends in these names is nothing.
 */
export function createGrantsStore(cfg) {
  const clock = cfg.clock || Date.now;
  const version = cfg.action_set_version ?? 1;
  /** @type {Map<string, any>} */ const grants = new Map();
  /** @type {Map<string, any>} person id -> Membership */ const memberships = new Map();
  /** @type {Set<string>} agent, service and automation actors that belong to the Space */ const actors = new Set();
  /** @type {Map<string, any>} pending, single-use invitations an admin approved */ const invites = new Map();
  /** @type {Map<string, any>} compute offers: the two grants a member's computer runs a Space's work under */ const offers = new Map();
  /** @type {Set<(e: { id: string, side: string, member: string, device: string | null, reason: string }) => void>} */ const revokeListeners = new Set();
  const tell = (/** @type {any} */ o, /** @type {string} */ reason, /** @type {any} */ by) => { for (const f of revokeListeners) { try { f({ id: o.id, side: o.side, member: o.member, device: o.device, reason }, by); } catch { /* a listener never blocks a change */ } } };
  /** @type {{ gate: any, allowed: any, registry: () => Map<string, any> } | null} */ let bound = null;

  const reg = () => (bound ? bound.registry() : new Map([...(cfg.actions ? cfg.actions() : [])].map(a => [a.action, a])));
  const since = (/** @type {string} */ a) => reg().get(a)?.since || 0;
  const riskOf = (/** @type {string} */ a) => reg().get(a)?.risk;
  const urn = (/** @type {string} */ type, id = "new") => `vyre://${cfg.space}/${type}/${id}`;
  const kernelChain = () => cfg.chains.fromFacts({ kind: "module", module: "grants", first_party: true });
  if (!cfg.key) throw new KernelError("bad_input", "the grants store needs the kernel's key to seal its events");
  // The MAC binds the event's POSITION (its seq and the hash of the event before it), not just its content: a genuine event copied and appended again
  // later sits at another position and does not verify, so a revoked grant or a removed member cannot be brought back by replay.
  const macOf = (/** @type {string} */ type, /** @type {string} */ subject, /** @type {any} */ data, /** @type {number} */ seq, /** @type {string} */ prev) => hmac(cfg.key, canonical({ type, subject, data, seq, prev }));
  const note = (/** @type {any} */ chain, /** @type {string} */ type, /** @type {string} */ subject, /** @type {any} */ data, /** @type {any} */ decision, /** @type {string} */ vis = "owner") => {
    // Computed and appended in one synchronous step, so the position it names is the position it takes.
    const seq = cfg.log.latestSeq() + 1, prev = cfg.log.head();
    return cfg.log.append(chain, { type, sv: 1, subject, data: { ...data, mac: macOf(type, subject, data, seq, prev) }, vis, red: "internal" }, decision ? { decision } : {});
  };

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

  /** The caller of a read: exactly one person who belongs to this Space, else the Space does not exist for them. */
  function reader(/** @type {any} */ chain) {
    if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
    if (!bound) throw new KernelError("unavailable", "the grants store is not bound to an authorizer");
    const me = isExactlyPerson(chain) ? chain.hops[0].actor : null;
    if (!me || !memberOk(me)) throw new KernelError("not_found", "no such grants");
    return me;
  }
  function depthOf(/** @type {any} */ g) { let d = 0; for (let p = g; p && p.parent && d <= MAX_DEPTH + 1; p = grants.get(p.parent)) d++; return d; }

  /**
   * What the spaces module needs to append an owner op to the Space's identity chain, or null when nobody's ownership changed: `{ op: "add" | "remove", person, by, role_was,
   * role_is, space }`. Carried on the `member.set` (and `member.removed`) event, which is then visible to the Space (the owner list is public to its members and devices).
   */
  const ownerOp = (/** @type {any} */ prior, /** @type {string | null} */ role, /** @type {string} */ person, /** @type {string} */ by, /** @type {any} */ decision) => {
    const was = prior ? prior.role : null;
    if ((was === "owner") === (role === "owner")) return null;
    return { op: role === "owner" ? "add" : "remove", person, by, role_was: was, role_is: role, space: cfg.space, ...(decision ? { decision: decision.decision || decision } : {}) };
  };

  /** Apply a role to a person (the shared step of `setRole` and an accepted invite): checks the issuer's CURRENT authority over both roles, replaces the role's grants, records the membership. */
  function applyRole(/** @type {any} */ chain, /** @type {any} */ issuer, /** @type {any} */ m, /** @type {any} */ decision) {
    const d = { decision };
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
    // An owner change is also a fact for the Space's identity chain: the spaces module reads `owner_change` and appends the owner op, signed by the owner's devices.
    const ownerChange = ownerOp(prior, m.role, m.person, issuer.id, d.decision);
    for (const of of offers.values()) if (of.member === m.person && of.status === "active") tell(of, "role_changed", chain);
    note(chain, "member.set", urn("member", m.person), { membership, ...(ownerChange ? { owner_change: ownerChange } : {}) }, d.decision, ownerChange ? "space" : "owner");
    const deleg = m.role === "owner" || m.role === "admin" ? { allowed: true, max_depth: 2 } : { allowed: false, max_depth: 0 };
    const prefixes = m.role === "temp" ? m.scope : [`vyre://${cfg.space}/*/*`];
    const made = [];
    for (const prefix of prefixes) {
      const g = freeze({ id: `gr_${mintUuid(clock())}`, space: cfg.space, subject: { kind: "actor", actor }, actions: [...ROLE_ACTIONS[/** @type {"owner"} */ (m.role)]], action_set_version: version, resource: { prefix }, conditions: { delegate: deleg, ...(m.role === "temp" ? { when: { expires: m.expires } } : {}) }, issuer: { ...issuer }, source: `role:${m.role}`, status: "active", created_at: clock() });
      grants.set(g.id, g); made.push(g);
      note(chain, "grant.created", urn("grant", g.id), { grant: g }, d.decision);
    }
    return { membership, grants: made };
  }

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

    /** Whoever `authorize` lets list grants (a manager and above) sees every grant; anyone else only the grants made to them. */
    async list(chain, filter = {}) {
      const me = reader(chain);
      const all = await bound.allowed(chain, "grants.list", urn("grant", "*"));
      const mine = (/** @type {any} */ g) => g.subject.kind === "actor" && sameActor(g.subject.actor, me);
      return [...grants.values()].filter(g => all || mine(g))
        .filter(g => (!filter.status || g.status === filter.status) && (!filter.subject || canonical(g.subject) === canonical(filter.subject)) && (!filter.resource_prefix || g.resource.prefix.startsWith(filter.resource_prefix)))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
    },

    /** The Space's members, as the same read `list` is: a manager and above sees everyone, anyone else only themselves. Each is a Membership (role, scope, expires). */
    async membersList(chain) {
      const me = reader(chain);
      const all = await bound.allowed(chain, "grants.list", urn("member", "*"));
      return [...memberships.values()].filter(m => (all || m.person === me.id) && !(m.role === "temp" && !(m.expires > clock()))).sort((a, b) => (a.person < b.person ? -1 : 1)).map(m => structuredClone(m));
    },
    /** One member's Membership: your own, or anyone's if `authorize` lets you list members. A person you may not see is indistinguishable from one who does not exist. */
    async membersGet(chain, /** @type {string} */ id) {
      const me = reader(chain);
      const m = typeof id === "string" ? memberships.get(id) : undefined;
      if (!m || (m.person !== me.id && !(await bound.allowed(chain, "grants.list", urn("member", id)))) || (m.role === "temp" && !(m.expires > clock()))) throw new KernelError("not_found", "no such member");
      return structuredClone(m);
    },
    /**
     * The join card. Read by the person who made the invite, a manager and above, or the person it is for (an open invite is read by whoever holds its id, which the
     * link carries and nothing else lists; the invitee is not a member yet, so `authorize` has nothing to say about them). It returns what the card shows and never
     * the contents hash, the invite's id list, or any secret; `space` is the label the home gives (its name and fingerprint words), and `status` says expired once past its life.
     */
    async invitesGet(chain, /** @type {string} */ id) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      if (!isExactlyPerson(chain)) throw new KernelError("not_found", "no such invite");
      const me = chain.hops[0].actor;
      const inv = typeof id === "string" ? invites.get(id) : undefined;
      const sees = inv && ((memberOk(me) && (sameActor(inv.issuer, me) || (bound && await bound.allowed(chain, "grants.list", urn("invite", id))))) || (!inv.invitee || inv.invitee === me.id));
      if (!inv || !sees) throw new KernelError("not_found", "no such invite");
      const status = inv.status === "pending" && !(inv.valid_until > clock()) ? "expired" : inv.status;
      return freeze({ id: inv.id, role: inv.role, scope: inv.scope, expires: inv.expires, invitee: inv.invitee, needs_confirm: inv.needs_confirm, confirmed: inv.confirmed, valid_until: inv.valid_until, status, space: { id: cfg.space, ...(cfg.label ? cfg.label() : {}) } });
    },

    /**
     * Give a person a role: replaces the role's old grants with the bundle's, and records the membership. Temp carries a scope and an expiry.
     * @param {any} chain @param {{ person: string, role: string, scope?: string[], expires?: number }} m @param {{ presence?: any }} [o]
     */
    async setRole(chain, m, o = {}) {
      const issuer = person(chain);
      if (!m || typeof m.person !== "string" || !ROLE_IDS.includes(m.role)) throw new KernelError("bad_input", "a role needs a person and one of the five roles");
      const d = await gate(chain, "grants.role", urn("member", m.person), m, o.presence);
      return applyRole(chain, issuer, m, d.decision);
    },

    /**
     * Take a person out of the Space (a grant-risk act with a fresh proof): their membership and every grant made to them go, their compute offers
     * are withdrawn, and the runner is told at once. The last owner stays.
     * @param {any} chain @param {{ person: string }} m @param {{ presence?: any }} [o]
     */
    async removeMember(chain, m, o = {}) {
      const issuer = person(chain);
      if (!m || typeof m.person !== "string") throw new KernelError("bad_input", "name the person to remove");
      const d = await gate(chain, "grants.role", urn("member", m.person), { remove: m.person }, o.presence);
      const prior = memberships.get(m.person);
      if (!prior) throw new KernelError("not_found", "no such member");
      const mine = roleOf(issuer);
      if (!mine || !(MAY_SET[/** @type {"owner"} */ (mine)] || []).includes(prior.role)) throw new KernelError("not_allowed", `a ${mine || "non-member"} cannot remove a ${prior.role}`);
      if (prior.role === "owner" && [...memberships.values()].filter(x => x.role === "owner").length === 1) throw new KernelError("not_allowed", "a Space keeps at least one owner");
      const actor = { kind: "person", id: m.person, space: cfg.space };
      const gone = [...grants.values()].filter(g => g.status === "active" && ((g.subject.kind === "actor" && sameActor(g.subject.actor, actor)) || (g.issuer && sameActor(g.issuer, actor) && g.parent)));
      for (const g of gone) {
        const n = freeze({ ...g, status: "revoked", revoked_at: clock(), reason: "member removed" }); grants.set(n.id, n);
        note(chain, "grant.revoked", urn("grant", n.id), { id: n.id, reason: "member removed" }, d.decision);
      }
      memberships.delete(m.person);
      const oc = ownerOp(prior, null, m.person, issuer.id, d.decision);
      note(chain, "member.removed", urn("member", m.person), { person: m.person, ...(oc ? { owner_change: oc } : {}) }, d.decision, oc ? "space" : "owner");
      for (const o2 of [...offers.values()]) if (o2.member === m.person && o2.status === "active") {
        const n = freeze({ ...o2, status: "revoked", revoked_at: clock() }); offers.set(n.id, n);
        note(chain, "offer.revoked", urn("offer", n.id), { id: n.id }, d.decision);
        tell(n, "removed", chain);
      }
      return { removed: m.person, grants_revoked: gone.length };
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

    /**
     * One side of the compute pair (DESIGN-wink 7): the Space allows its work to run on a member's computer (an owner or admin, for a member of this
     * Space; `device` null covers any of that member's computers), or the member accepts it for one of their own computers (the member's own act).
     * Both must be active for `offers.active` to say yes, and it covers only that member's own sessions on that member's own machine.
     * The acceptance is bound to the computer's KEY (`device_key`, from the Identity stud's device identity): `active` answers yes only for the device that
     * presents that key, so a second machine cannot claim the first one's offer by naming its id.
     * @param {any} chain @param {{ side: "space_allows" | "member_accepts", member: string, device?: string | null, device_key?: string }} o @param {{ presence?: any }} [opt]
     */
    async offer(chain, o, opt = {}) {
      const issuer = person(chain);
      if (!o || !["space_allows", "member_accepts"].includes(o.side) || typeof o.member !== "string" || (o.side === "member_accepts" && (typeof o.device !== "string" || !o.device || typeof o.device_key !== "string" || !o.device_key || o.device_key.length > 200)) || (o.device != null && typeof o.device !== "string") || (o.device_key !== undefined && (typeof o.device_key !== "string" || o.device_key.length > 200))) throw new KernelError("bad_input", "an offer needs a side, a member and (to accept) one of the member's computers with its key");
      const d = await gate(chain, "grants.offer", urn("offer"), o, opt.presence);
      const m = { kind: "person", id: o.member, space: cfg.space };
      if (!memberOk(m)) throw new KernelError("not_found", "no such member");
      if (o.side === "space_allows" ? !isAdmin(issuer) : issuer.id !== o.member) throw new KernelError("not_allowed", o.side === "space_allows" ? "only an owner or an admin lets the Space's work run on a member's computer" : "only the member accepts work on their own computer");
      const rec = freeze({ id: `of_${mintUuid(clock())}`, space: cfg.space, side: o.side, offer: "compute", member: o.member, device: o.device ?? null, device_key: o.device_key ?? null, status: "active", made_by: issuer.id, at: clock() });
      offers.set(rec.id, rec);
      note(chain, "offer.created", urn("offer", rec.id), { offer: rec }, d.decision);
      return rec;
    },

    /** Withdraw an offer. An admin withdraws the Space's side; the member withdraws their own acceptance. The runner is told at once. */
    async unoffer(chain, id, opt = {}) {
      const issuer = person(chain);
      const d = await gate(chain, "grants.offer", urn("offer", id), { revoke: id }, opt.presence);
      const o = offers.get(id);
      if (!o || o.status !== "active") throw new KernelError("not_found", "no such offer");
      if (o.side === "space_allows" ? !isAdmin(issuer) : issuer.id !== o.member) throw new KernelError("not_allowed", "that is not yours to withdraw");
      const n = freeze({ ...o, status: "revoked", revoked_at: clock() });
      offers.set(id, n);
      note(chain, "offer.revoked", urn("offer", id), { id }, d.decision);
      tell(n, "withdrawn", chain);
      return n;
    },

    /** Are both sides of the compute pair active for this member and computer? Read at every session start. Sync: it reads the store, never the network. */
    active(/** @type {{ member: string, device: string, device_key?: string }} */ q) {
      const live = (/** @type {any} */ o) => o.status === "active" && o.member === q.member;
      // A bound offer answers only for the key it was made for; the caller presents the key of the connected device (verified by the network layer), never a bare id.
      const keyOk = (/** @type {any} */ o) => !o.device_key || (typeof q.device_key === "string" && o.device_key === q.device_key);
      const spaceAllows = memberOk({ kind: "person", id: q.member, space: cfg.space }) && [...offers.values()].some(o => live(o) && o.side === "space_allows" && (o.device === null || (o.device === q.device && keyOk(o))));
      const memberAccepts = [...offers.values()].some(o => live(o) && o.side === "member_accepts" && o.device === q.device && keyOk(o));
      return { spaceAllows, memberAccepts };
    },
    /** Be told when an offer is withdrawn or a member's role changes (so the runner can end work at once). Returns an unsubscribe. */
    onRevoke(/** @type {(e: any, by?: any) => void} */ f) { revokeListeners.add(f); return () => revokeListeners.delete(f); },

    /**
     * Invites (windows' ruling). An admin's act, with the admin's fresh presence proof bound to exactly these contents, stores a pending, single-use approval; the
     * invitee accepts under their own chain and their own presence, and the kernel applies the membership from the stored approval: no admin is present at accept.
     * An invite for admin or owner stays pending until the inviter confirms the invitee's fingerprint words (a second, small presence act). An invite that has
     * expired, was used, or whose contents differ from what was approved is refused.
     * @param {any} chain @param {{ role: string, scope?: string[], expires?: number, invitee?: string, valid_ms?: number }} i @param {{ presence?: any }} [o]
     */
    async inviteCreate(chain, i, o = {}) {
      const issuer = person(chain);
      if (!i || !ROLE_IDS.includes(i.role)) throw new KernelError("bad_input", "an invite names one of the five roles");
      if (i.role === "temp" && (!Array.isArray(i.scope) || !i.scope.length || i.scope.some(s => !segments(s) || spaceOf(s) !== cfg.space) || !(i.expires > clock()))) throw new KernelError("bad_input", "a temp invite needs a scope and an expiry");
      if (i.invitee !== undefined && (typeof i.invitee !== "string" || !i.invitee)) throw new KernelError("bad_input", "invitee is a person id");
      const d = await gate(chain, "grants.invite", urn("invite"), i, o.presence);
      const mine = roleOf(issuer);
      if (!mine || !(MAY_SET[/** @type {"owner"} */ (mine)] || []).includes(i.role)) throw new KernelError("not_allowed", `a ${mine || "non-member"} cannot invite someone as ${i.role}`);
      const contents = { role: i.role, scope: i.scope || null, expires: i.expires ?? null, invitee: i.invitee ?? null };
      const rec = freeze({ id: `inv_${mintUuid(clock())}`, space: cfg.space, ...contents, hash: sha256(canonical(contents)), issuer: { ...issuer }, status: "pending", needs_confirm: i.role === "admin" || i.role === "owner", confirmed: false, valid_until: clock() + (i.valid_ms ?? 7 * 24 * 3600 * 1000), created_at: clock() });
      invites.set(rec.id, rec);
      note(chain, "invite.created", urn("invite", rec.id), { invite: rec }, d.decision);
      return rec;
    },
    /** The inviter confirms the invitee's fingerprint words (an admin or owner invite stays pending until they do): a second presence act, bound to the words. */
    async inviteConfirm(chain, /** @type {string} */ id, /** @type {{ words: string }} */ c, o = {}) {
      const issuer = person(chain);
      const inv = invites.get(id);
      const d = await gate(chain, "grants.invite", urn("invite", id), { confirm: id, words: c && c.words }, o.presence);
      if (!inv || inv.status !== "pending" || !sameActor(inv.issuer, issuer)) throw new KernelError("not_found", "no such invite");
      if (typeof c.words !== "string" || !c.words.trim()) throw new KernelError("bad_input", "confirm the invitee's fingerprint words");
      const n = freeze({ ...inv, confirmed: true, confirmed_words_hash: sha256(c.words.trim().toLowerCase()) });
      invites.set(id, n);
      note(chain, "invite.confirmed", urn("invite", id), { id, words_hash: n.confirmed_words_hash }, d.decision);
      return n;
    },
    /**
     * The invitee accepts under their own chain (from the Surfaces door: a person chain that need not be a member yet) and their own presence proof over exactly
     * these contents. `seen` is what the invitee was shown; if it differs from what the admin approved the invite is refused.
     * @param {any} chain @param {string} id @param {{ seen: { role: string, scope?: string[] | null, expires?: number | null, invitee?: string | null }, proof: any }} a
     */
    async inviteAccept(chain, id, a) {
      const me = person(chain);
      const inv = invites.get(id);
      if (!inv || inv.status !== "pending") throw new KernelError("not_found", "no such invite");
      if (!(inv.valid_until > clock())) throw new KernelError("expired", "that invite has expired");
      if (inv.invitee && inv.invitee !== me.id) throw new KernelError("not_found", "no such invite");
      const seen = { role: a.seen && a.seen.role, scope: (a.seen && a.seen.scope) ?? null, expires: (a.seen && a.seen.expires) ?? null, invitee: (a.seen && a.seen.invitee) ?? null };
      if (sha256(canonical(seen)) !== inv.hash) throw new KernelError("contents_differ", "that is not what was approved");
      if (inv.needs_confirm && !inv.confirmed) throw new KernelError("needs_confirmation", "the person who invited you has not yet confirmed your fingerprint words");
      if (!cfg.presence) throw new KernelError("unavailable", "no presence verifier is wired");
      if (await cfg.presence.check({ chain, op: "grant.accept", fields: { invite: id, hash: inv.hash, person: me.id }, proof: a.proof }) !== null) throw new KernelError("needs_presence", "accepting needs your confirmation on this device");
      // Single use: taken before the membership is applied, so a second accept (concurrent or later) finds it used.
      invites.set(id, freeze({ ...inv, status: "used", used_by: me.id, used_at: clock() }));
      try {
        const r = applyRole(chain, inv.issuer, { person: me.id, role: inv.role, ...(inv.role === "temp" ? { scope: inv.scope, expires: inv.expires } : {}) }, null);
        note(chain, "invite.used", urn("invite", id), { id, by: me.id });
        return r;
      } catch (e) { invites.set(id, inv); throw e; }
    },
    /**
     * The clean-up of expired power, the kernel's own service act (no person present): grants past their `when.expires` are revoked, and a temp membership past its
     * expiry is removed with its offers withdrawn. It only ever reduces power; nothing that widens runs here.
     */
    sweep() {
      const k = kernelChain(), now = clock();
      let revoked = 0, removed = 0;
      for (const g of [...grants.values()]) if (g.status === "active" && g.conditions && g.conditions.when && g.conditions.when.expires !== undefined && g.conditions.when.expires <= now) {
        const n = freeze({ ...g, status: "revoked", revoked_at: now, reason: "expired" }); grants.set(n.id, n);
        note(k, "grant.revoked", urn("grant", n.id), { id: n.id, reason: "expired" }); revoked++;
      }
      for (const m of [...memberships.values()]) if (m.role === "temp" && !(m.expires > now)) {
        memberships.delete(m.person);
        note(k, "member.removed", urn("member", m.person), { person: m.person, reason: "expired" }); removed++;
        for (const o of [...offers.values()]) if (o.member === m.person && o.status === "active") { const n = freeze({ ...o, status: "revoked", revoked_at: now }); offers.set(n.id, n); note(k, "offer.revoked", urn("offer", n.id), { id: n.id }); tell(n, "expired", null); }
      }
      return { revoked, removed };
    },
    /**
     * A first-party module's own authority (kernel-only, at boot: nothing a caller can ask for): the module becomes a service actor of the Space and is given the
     * actions its manifest declared under `needs.kernel`, over the prefixes it declared, as grants whose source is `install:<module>`. Idempotent.
     * @param {string} name @param {{ actions: string[], prefixes?: string[] }} needs
     */
    installModule(name, needs) {
      const k = kernelChain(), actor = { kind: "service", id: name, space: cfg.space };
      if (!actors.has(actorKey(actor))) { actors.add(actorKey(actor)); note(k, "actor.added", urn("member", name), { actor }); }
      const have = [...grants.values()].find(g => g.status === "active" && g.source === `install:${name}`);
      const prefixes = (needs.prefixes && needs.prefixes.length ? needs.prefixes : ["*/*"]).map(p => `vyre://${cfg.space}/${p}`);
      const want = canonical({ a: [...needs.actions].sort(), p: prefixes });
      if (have && canonical({ a: [...have.actions].sort(), p: [have.resource.prefix] }) === want) return have;
      for (const g of [...grants.values()]) if (g.status === "active" && g.source === `install:${name}`) { const n = freeze({ ...g, status: "revoked", revoked_at: clock(), reason: "reinstalled" }); grants.set(n.id, n); note(k, "grant.revoked", urn("grant", n.id), { id: n.id, reason: "reinstalled" }); }
      let last;
      for (const prefix of prefixes) {
        last = freeze({ id: `gr_${mintUuid(clock())}`, space: cfg.space, subject: { kind: "actor", actor }, actions: [...needs.actions], action_set_version: version, resource: { prefix }, conditions: {}, issuer: { kind: "service", id: "grants", space: cfg.space }, source: `install:${name}`, status: "active", created_at: clock() });
        grants.set(last.id, last);
        note(k, "grant.created", urn("grant", last.id), { grant: last });
      }
      return last;
    },

    /** The first owner of a new Space, written by the kernel itself (no chain can give the first grant). Once only. */
    bootstrap({ owner }) {
      if (memberships.size || cfg.log.latestSeq() > 0) throw new KernelError("not_allowed", "this Space already has a history: its first owner is made once, at its start");
      const k = kernelChain();
      const membership = freeze({ space: cfg.space, person: owner, role: "owner", added_by: "kernel", added_at: clock() });
      memberships.set(owner, membership);
      note(k, "member.set", urn("member", owner), { membership, owner_change: ownerOp(null, "owner", owner, "kernel", null) }, null, "space");
      const g = freeze({ id: `gr_${mintUuid(clock())}`, space: cfg.space, subject: { kind: "actor", actor: { kind: "person", id: owner, space: cfg.space } }, actions: [...ROLE_ACTIONS.owner], action_set_version: version, resource: { prefix: `vyre://${cfg.space}/*/*` }, conditions: { delegate: { allowed: true, max_depth: 2 } }, issuer: { kind: "service", id: "grants", space: cfg.space }, source: "role:owner", status: "active", created_at: clock() });
      grants.set(g.id, g);
      note(k, "grant.created", urn("grant", g.id), { grant: g });
      return membership;
    },

    /** Rebuild every grant and membership from the log (after a restart). The log is the durable copy. */
    rebuild() {
      grants.clear(); memberships.clear(); actors.clear(); offers.clear(); invites.clear();
      for (const e of cfg.log.read({})) {
        let d = e.data;
        if (!d || typeof d !== "object" || !/^(grant|member|actor|offer|invite)\./.test(e.type)) continue;
        // Authority comes only from events this store sealed: anything else in these names is ignored (and not trusted for a grant, a member or an offer).
        const { mac, ...bare } = d;
        if (typeof mac !== "string" || !sameMac(macOf(e.type, e.subject, bare, e.seq, e.prev), mac)) continue;
        d = bare;
        if (e.type === "grant.created" && grants.has(d.grant.id)) continue; // an id is made once: a second creation of it is never a resurrection
        if (e.type === "grant.created" || e.type === "grant.narrowed") grants.set(d.grant.id, freeze(structuredClone(d.grant)));
        else if (e.type === "grant.revoked") { const g = grants.get(d.id); if (g) grants.set(d.id, freeze({ ...g, status: "revoked", revoked_at: e.time, reason: d.reason })); }
        else if (e.type === "member.set") memberships.set(d.membership.person, freeze(structuredClone(d.membership)));
        else if (e.type === "member.removed") memberships.delete(d.person);
        else if (e.type === "invite.created") invites.set(d.invite.id, freeze(structuredClone(d.invite)));
        else if (e.type === "invite.used") { const v = invites.get(d.id); if (v) invites.set(d.id, freeze({ ...v, status: "used", used_by: d.by })); }
        else if (e.type === "invite.confirmed") { const v = invites.get(d.id); if (v) invites.set(d.id, freeze({ ...v, confirmed: true })); }
        else if (e.type === "actor.added") actors.add(actorKey(d.actor));
        else if (e.type === "offer.created") offers.set(d.offer.id, freeze(structuredClone(d.offer)));
        else if (e.type === "offer.revoked") { const o = offers.get(d.id); if (o) offers.set(d.id, freeze({ ...o, status: "revoked", revoked_at: e.time })); }
      }
    },
  };

  return Object.freeze({
    ...api, provider, members, isAdmin, roleOf,
    /** Called once by the gateway, with the authorizer it built from `provider` and `members`. */
    bind(/** @type {{ authorizer: any, registry: () => Map<string, any>, enforce?: (chain: any, d: any) => void }} */ b) { bound = { ...createGate({ authorizer: b.authorizer, log: cfg.log, enforce: b.enforce }), registry: b.registry }; },
  });
}
