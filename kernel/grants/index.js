// kernel/grants/index.js: the grants store and the calls on it (contract section 6; grant.d.ts, roles.d.ts; invariants 2, 3, 4 and 10).
// Grants and memberships are kernel records held on the home. The event log is the durable copy: every change is one event (grant.created,
// grant.revoked, grant.narrowed, member.set, actor.added) and `rebuild()` replays them, so a restart loses nothing. `authorize` reads its grants and
// members from here (`provider`, `members`). Every change is a `grant`-risk act: a fresh presence proof by the granting person, never from a chain
// that holds a model (authorize denies `model_chain`), and the proof is bound to the exact input (`input_hash`). Widening is always a new grant;
// narrowing and revoking happen in place; a delegated grant has a parent and must be contained in it; revoking a parent revokes its children.
import { canonical, sha256, hmac, sameMac } from "../core/canonical.js";
import { createKernelSeal } from "../core/seal.js";
import { randomBytes } from "node:crypto";
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
const HISTORY = 1000;
const freeze = (/** @type {any} */ o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) freeze(v); } return o; };
const actorKey = (/** @type {any} */ a) => `${a.kind}:${a.id}`;
const sameActor = (/** @type {any} */ a, /** @type {any} */ b) => Boolean(a && b) && a.kind === b.kind && a.id === b.id && a.space === b.space;

/**
 * @param {{ seal?: any, sealer?: any, key?: Uint8Array | string, legacyKeys?: (Uint8Array | string)[], presence?: { check(i: any): Promise<string | null> }, space: string, log: any, chains: any, key: Uint8Array | string, clock?: () => number, action_set_version?: number, actions?: () => Iterable<any>, label?: () => { name?: string, words?: string } }} cfg
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
  /** @type {Map<string, any>} chats: the people (and assistants) in a room, which is the audience a turn in it writes for and the readers of its stream */ const chats = new Map();
  /** @type {Set<(e: { id: string, side: string, member: string, device: string | null, reason: string }) => void>} */ const revokeListeners = new Set();
  const tell = (/** @type {any} */ o, /** @type {string} */ reason, /** @type {any} */ by) => { for (const f of revokeListeners) { try { f({ id: o.id, side: o.side, member: o.member, device: o.device, reason }, by); } catch { /* a listener never blocks a change */ } } };
  /** @type {{ gate: any, allowed: any, registry: () => Map<string, any> } | null} */ let bound = null;

  const reg = () => (bound ? bound.registry() : new Map([...(cfg.actions ? cfg.actions() : [])].map(a => [a.action, a])));
  const since = (/** @type {string} */ a) => reg().get(a)?.since || 0;
  const riskOf = (/** @type {string} */ a) => reg().get(a)?.risk;
  const urn = (/** @type {string} */ type, id = "new") => `vyre://${cfg.space}/${type}/${id}`;
  const kernelChain = () => cfg.chains.fromFacts({ kind: "module", module: "grants", first_party: true });
  // K-3: the seal is the sealing process (or, for a development kernel with no sealing process, a local key). The store holds no key of its own.
  const seal = cfg.seal || createKernelSeal({ sealer: cfg.sealer, key: cfg.key });
  const LEGACY_RE = /^(grant|member|actor|offer|invite|chat)\./;
  // Every event this store writes is sealed (one `kernel.mac` per event) and numbered on THIS store's own chain: `gseq` counts its events and `gprev` is the hash of the
  // seal of the one before. A genuine event copied and appended again later has an old `gseq`, so rebuild skips it: a revoked grant or a removed member cannot be replayed
  // back. (The log's own position cannot be the number: another writer appends between the MAC and the append now that the MAC is a round trip to the sealing process.)
  let gseq = 0, gprev = "genesis", queue = Promise.resolve();
  const sealed = (/** @type {string} */ type, /** @type {string} */ subject, /** @type {any} */ core, /** @type {number} */ n, /** @type {string} */ prev) => canonical({ type, subject, data: core, gseq: n, gprev: prev });
  const note = (/** @type {any} */ chain, /** @type {string} */ type, /** @type {string} */ subject, /** @type {any} */ data, /** @type {any} */ decision, /** @type {string} */ vis = "owner") => {
    const run = async () => {
      const n = gseq + 1, prev = gprev;
      const mac = await seal.mac("grants-event-v1", sealed(type, subject, data, n, prev));
      const e = cfg.log.append(chain, { type, sv: 1, subject, data: { ...data, mac, gseq: n, gprev: prev }, vis, red: "internal" }, decision ? { decision } : {});
      gseq = n; gprev = sha256(mac);
      return e;
    };
    const p = queue.then(run);
    queue = p.then(() => {}, () => {});
    return p;
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
  async function applyRole(/** @type {any} */ chain, /** @type {any} */ issuer, /** @type {any} */ m, /** @type {any} */ decision) {
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
      await note(chain, "grant.revoked", urn("grant", n.id), { id: n.id, reason: "role changed" }, d.decision);
    }
    const membership = freeze({ space: cfg.space, person: m.person, role: m.role, ...(m.role === "temp" ? { scope: [...m.scope], expires: m.expires } : {}), added_by: issuer.id, added_at: clock() });
    memberships.set(m.person, membership);
    // An owner change is also a fact for the Space's identity chain: the spaces module reads `owner_change` and appends the owner op, signed by the owner's devices.
    const ownerChange = ownerOp(prior, m.role, m.person, issuer.id, d.decision);
    for (const of of offers.values()) if (of.member === m.person && of.status === "active") tell(of, "role_changed", chain);
    await note(chain, "member.set", urn("member", m.person), { membership }, d.decision);
    if (ownerChange) await note(chain, "owner.changed", urn("member", m.person), { owner_change: ownerChange }, d.decision, "space");
    const deleg = m.role === "owner" || m.role === "admin" ? { allowed: true, max_depth: 2 } : { allowed: false, max_depth: 0 };
    const prefixes = m.role === "temp" ? m.scope : [`vyre://${cfg.space}/*/*`];
    const made = [];
    for (const prefix of prefixes) {
      const g = freeze({ id: `gr_${mintUuid(clock())}`, space: cfg.space, subject: { kind: "actor", actor }, actions: [...ROLE_ACTIONS[/** @type {"owner"} */ (m.role)]], action_set_version: version, resource: { prefix }, conditions: { delegate: deleg, ...(m.role === "temp" ? { when: { expires: m.expires } } : {}) }, issuer: { ...issuer }, source: `role:${m.role}`, status: "active", created_at: clock() });
      grants.set(g.id, g); made.push(g);
      await note(chain, "grant.created", urn("grant", g.id), { grant: g }, d.decision);
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
      await note(chain, "grant.created", urn("grant", g.id), { grant: g }, d.decision);
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
      const kill = async (/** @type {any} */ x) => {
        if (x.status === "revoked") return;
        const n = freeze({ ...x, status: "revoked", revoked_at: clock(), reason: String(reason || "").slice(0, 200) });
        grants.set(n.id, n); out.push(n);
        await note(chain, "grant.revoked", urn("grant", n.id), { id: n.id, reason: n.reason, ...(n.id !== id ? { because: id } : {}) }, d.decision);
        for (const c of [...grants.values()]) if (c.parent === n.id) await kill(c);
      };
      await kill(g);
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
      await note(chain, "grant.narrowed", urn("grant", id), { grant: n }, d.decision);
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
     * Hand ownership to another member under ONE proof: the new owner is made first, then the caller steps down (to `demote_to`, admin by default). A failure between
     * the two leaves two owners, never none, and a repeat of the call (a fresh proof, the proof being single use) finds the new owner already made and does only the
     * second step.
     * @param {any} chain @param {{ to: string, demote_to?: string }} t @param {{ presence?: any }} [o]
     */
    async transferOwner(chain, t, o = {}) {
      const issuer = person(chain);
      const demote = (t && t.demote_to) || "admin";
      if (!t || typeof t.to !== "string" || !t.to || t.to === issuer.id || !["admin", "manager", "member"].includes(demote)) throw new KernelError("bad_input", "name the member to hand the Space to, and the role you keep (admin, manager or member: a temp role needs a scope and an end date, which a hand-over does not carry)");
      const d = await gate(chain, "grants.role", urn("member", t.to), { transfer: { to: t.to, demote_to: demote } }, o.presence);
      if (roleOf(issuer) !== "owner") throw new KernelError("not_allowed", "only an owner hands the Space on");
      if (!memberOk({ kind: "person", id: t.to, space: cfg.space })) throw new KernelError("not_found", "no such member");
      if (roleOf({ kind: "person", id: t.to, space: cfg.space }) !== "owner") await applyRole(chain, issuer, { person: t.to, role: "owner" }, d.decision);
      // The log is the durable copy: if the second step fails part way, the store is restored from it so what is held matches what was written (two owners), and the
      // caller's owner grants (which the step may already have revoked) are written again. If even that fails, the new owner still holds the Space in full.
      try { await applyRole(chain, issuer, { person: issuer.id, role: demote }, d.decision); } catch (e) {
        await api.rebuild();
        try { await applyRole(chain, issuer, { person: issuer.id, role: "owner" }, d.decision); } catch { /* the new owner is whole; the caller's own grants wait for the next attempt */ }
        throw e;
      }
      return { owner: t.to, previous: issuer.id, previous_role: demote };
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
        await note(chain, "grant.revoked", urn("grant", n.id), { id: n.id, reason: "member removed" }, d.decision);
      }
      memberships.delete(m.person);
      await note(chain, "member.removed", urn("member", m.person), { person: m.person }, d.decision);
      const oc = ownerOp(prior, null, m.person, issuer.id, d.decision);
      if (oc) await note(chain, "owner.changed", urn("member", m.person), { owner_change: oc }, d.decision, "space");
      for (const o2 of [...offers.values()]) if (o2.member === m.person && o2.status === "active") {
        const n = freeze({ ...o2, status: "revoked", revoked_at: clock() }); offers.set(n.id, n);
        await note(chain, "offer.revoked", urn("offer", n.id), { id: n.id }, d.decision);
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
      await note(chain, "actor.added", urn("member", actor.id), { actor }, d.decision);
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
      await note(chain, "offer.created", urn("offer", rec.id), { offer: rec }, d.decision);
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
      await note(chain, "offer.revoked", urn("offer", id), { id }, d.decision);
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
    /** The active offer record for a side, member and computer (`device` null = the Space's any-computer offer), or null. Sync; it reads the store. */
    find(/** @type {{ side: "space_allows" | "member_accepts", member: string, device?: string | null }} */ q) {
      for (const o of offers.values()) if (o.status === "active" && o.side === q.side && o.member === q.member && o.device === (q.device ?? null)) return o;
      return null;
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
      const rec = freeze({ id: `inv_${randomBytes(16).toString("hex")}`, space: cfg.space, ...contents, hash: sha256(canonical(contents)), issuer: { ...issuer }, status: "pending", needs_confirm: i.role === "admin" || i.role === "owner", confirmed: false, valid_until: clock() + (i.valid_ms ?? 7 * 24 * 3600 * 1000), created_at: clock() });
      invites.set(rec.id, rec);
      await note(chain, "invite.created", urn("invite", rec.id), { invite: rec }, d.decision);
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
      await note(chain, "invite.confirmed", urn("invite", id), { id, words_hash: n.confirmed_words_hash }, d.decision);
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
        const r = await applyRole(chain, inv.issuer, { person: me.id, role: inv.role, ...(inv.role === "temp" ? { scope: inv.scope, expires: inv.expires } : {}) }, null);
        await note(chain, "invite.used", urn("invite", id), { id, by: me.id });
        return r;
      } catch (e) { invites.set(id, inv); throw e; }
    },
    /**
     * The clean-up of expired power, the kernel's own service act (no person present): grants past their `when.expires` are revoked, and a temp membership past its
     * expiry is removed with its offers withdrawn. It only ever reduces power; nothing that widens runs here.
     */
    async sweep() {
      const k = kernelChain(), now = clock();
      let revoked = 0, removed = 0;
      for (const g of [...grants.values()]) if (g.status === "active" && g.conditions && g.conditions.when && g.conditions.when.expires !== undefined && g.conditions.when.expires <= now) {
        const n = freeze({ ...g, status: "revoked", revoked_at: now, reason: "expired" }); grants.set(n.id, n);
        await note(k, "grant.revoked", urn("grant", n.id), { id: n.id, reason: "expired" }); revoked++;
      }
      for (const m of [...memberships.values()]) if (m.role === "temp" && !(m.expires > now)) {
        memberships.delete(m.person);
        await note(k, "member.removed", urn("member", m.person), { person: m.person, reason: "expired" }); removed++;
        for (const o of [...offers.values()]) if (o.member === m.person && o.status === "active") { const n = freeze({ ...o, status: "revoked", revoked_at: now }); offers.set(n.id, n); await note(k, "offer.revoked", urn("offer", n.id), { id: n.id }); tell(n, "expired", null); }
      }
      return { revoked, removed };
    },
    /**
     * A first-party module's own authority (kernel-only, at boot: nothing a caller can ask for): the module becomes a service actor of the Space and is given the
     * actions its manifest declared under `needs.kernel`, over the prefixes it declared, as grants whose source is `install:<module>`. Idempotent.
     * @param {string} name @param {{ actions: string[], prefixes?: string[] }} needs
     */
    async installModule(name, needs) {
      const k = kernelChain(), actor = { kind: "service", id: name, space: cfg.space };
      if (!actors.has(actorKey(actor))) { actors.add(actorKey(actor)); await note(k, "actor.added", urn("member", name), { actor }); }
      const have = [...grants.values()].find(g => g.status === "active" && g.source === `install:${name}`);
      const prefixes = (needs.prefixes && needs.prefixes.length ? needs.prefixes : ["*/*"]).map(p => `vyre://${cfg.space}/${p}`);
      const want = canonical({ a: [...needs.actions].sort(), p: prefixes });
      if (have && canonical({ a: [...have.actions].sort(), p: [have.resource.prefix] }) === want) return have;
      for (const g of [...grants.values()]) if (g.status === "active" && g.source === `install:${name}`) { const n = freeze({ ...g, status: "revoked", revoked_at: clock(), reason: "reinstalled" }); grants.set(n.id, n); await note(k, "grant.revoked", urn("grant", n.id), { id: n.id, reason: "reinstalled" }); }
      let last;
      for (const prefix of prefixes) {
        last = freeze({ id: `gr_${mintUuid(clock())}`, space: cfg.space, subject: { kind: "actor", actor }, actions: [...needs.actions], action_set_version: version, resource: { prefix }, conditions: {}, issuer: { kind: "service", id: "grants", space: cfg.space }, source: `install:${name}`, status: "active", created_at: clock() });
        grants.set(last.id, last);
        await note(k, "grant.created", urn("grant", last.id), { grant: last });
      }
      return last;
    },

    /** The first owner of a new Space, written by the kernel itself (no chain can give the first grant). Once only. */
    async bootstrap({ owner }) {
      if (memberships.size || cfg.log.latestSeq() > 0) throw new KernelError("not_allowed", "this Space already has a history: its first owner is made once, at its start");
      const k = kernelChain();
      const membership = freeze({ space: cfg.space, person: owner, role: "owner", added_by: "kernel", added_at: clock() });
      memberships.set(owner, membership);
      await note(k, "member.set", urn("member", owner), { membership });
      await note(k, "owner.changed", urn("member", owner), { owner_change: ownerOp(null, "owner", owner, "kernel", null) }, null, "space");
      const g = freeze({ id: `gr_${mintUuid(clock())}`, space: cfg.space, subject: { kind: "actor", actor: { kind: "person", id: owner, space: cfg.space } }, actions: [...ROLE_ACTIONS.owner], action_set_version: version, resource: { prefix: `vyre://${cfg.space}/*/*` }, conditions: { delegate: { allowed: true, max_depth: 2 } }, issuer: { kind: "service", id: "grants", space: cfg.space }, source: "role:owner", status: "active", created_at: clock() });
      grants.set(g.id, g);
      await note(k, "grant.created", urn("grant", g.id), { grant: g });
      return membership;
    },

    // ---- chats: who is in a room (the kernel's own list, never a module's) ----
    // A chat is a list of people and assistants. The kernel keeps it because three decisions depend on it and none may be a module's word: who may READ the chat's stream
    // (its participants only: an owner or admin outside it is refused; an assistant reads only chats the person it acts for is in), who is in the AUDIENCE of a turn an
    // assistant writes (every person in the room, asker included), and who may change the list (a person in it). Every call here takes a kernel-built chain.
    /** @param {any} chain @param {{ people?: string[], assistants?: string[], id?: string }} [o] */
    async chatCreate(chain, o = {}) {
      if (chain && (chain.viewer === true || chain.delegated === true)) throw new KernelError("chain_not_person", "only a person acting directly starts a chat: a viewer or a session's chain does not");
      const p = person(chain);
      if (!memberOk(p)) throw new KernelError("not_a_member", "only a member starts a chat");
      const people = [...new Set([p.id, ...(Array.isArray(o.people) ? o.people.map(String) : [])])];
      for (const x of people) if (!memberOk({ kind: "person", id: x, space: cfg.space })) throw new KernelError("bad_input", "everyone in a chat is a member of the Space");
      const assistants = [...new Set((Array.isArray(o.assistants) ? o.assistants : []).map(String))];
      for (const a of assistants) if (!memberOk({ kind: "agent", id: a, space: cfg.space })) throw new KernelError("bad_input", "an assistant in a chat belongs to the Space");
      if (people.length > 100 || assistants.length > 20) throw new KernelError("bad_input", "too many in one chat");
      const id = o.id === undefined ? `chat_${mintUuid(clock())}` : String(o.id);
      if (!/^chat_[A-Za-z0-9_-]{4,64}$/.test(id) || chats.has(id)) throw new KernelError("bad_input", "a chat id is new and shaped chat_...");
      const rec = freeze({ id, space: cfg.space, people, assistants, made_by: p.id, at: clock(), ver: 1, h: [{ ver: 1, people: [...people] }] });
      chats.set(id, rec);
      await note(chain, "chat.created", urn("chat", id), { chat: rec }, null);
      return rec;
    },
    /** Add or remove people and assistants. Only a person in the chat does it; nobody else, an owner or admin included. @param {any} chain @param {string} id @param {{ add_people?: string[], remove_people?: string[], add_assistants?: string[], remove_assistants?: string[] }} change */
    async chatChange(chain, id, change = {}) {
      if (chain && (chain.viewer === true || chain.delegated === true)) throw new KernelError("chain_not_person", "only a person acting directly, in the chat, changes who is in it: a viewer or a session's chain does not");
      const p = person(chain);
      const c = chats.get(String(id));
      if (!c || !c.people.includes(p.id) || !memberOk(p)) throw new KernelError("not_found", "no such chat");
      const people = new Set(c.people), assistants = new Set(c.assistants);
      for (const x of change.add_people || []) { if (!memberOk({ kind: "person", id: String(x), space: cfg.space })) throw new KernelError("bad_input", "everyone in a chat is a member of the Space"); people.add(String(x)); }
      for (const x of change.remove_people || []) people.delete(String(x));
      for (const x of change.add_assistants || []) { if (!memberOk({ kind: "agent", id: String(x), space: cfg.space })) throw new KernelError("bad_input", "an assistant in a chat belongs to the Space"); assistants.add(String(x)); }
      for (const x of change.remove_assistants || []) assistants.delete(String(x));
      if (!people.size || people.size > 100 || assistants.size > 20) throw new KernelError("bad_input", "a chat keeps at least one person");
      // The room's version moves on every change, and the people at each version are kept: a message belongs to the version it was written under and is delivered only to the
      // people who were in the room then (the kernel answers "may this person receive it"; the stream never decides).
      const ver = (c.ver || 1) + 1;
      const joined = [...people].filter(x => !c.people.includes(x)), left = c.people.filter(x => !people.has(x));
      const n = freeze({ ...c, people: [...people], assistants: [...assistants], ver, h: [...(c.h || [{ ver: c.ver || 1, people: c.people }]), { ver, people: [...people] }].slice(-HISTORY) });
      chats.set(c.id, n);
      await note(chain, "chat.changed", urn("chat", c.id), { id: c.id, people: n.people, assistants: n.assistants, ver, joined, left }, null);
      return n;
    },
    /**
     * The read decision for a chat's stream: its participants only. A person reads when they are in the chat. An assistant (a chain of a person and an agent) reads when the
     * PERSON it acts for is in the chat and the assistant is a participant. An owner or admin who is not in the chat is refused, and a refusal looks like absence.
     * @param {any} chain @param {string} id @returns {any} the chat's people and assistants
     */
    chatRead(chain, id) {
      const c = chats.get(String(id));
      const hops = isChain(chain) ? chain.hops : [];
      const who = hops[0] && hops[0].actor.kind === "person" ? hops[0].actor : null;
      const agent = hops.length === 2 && hops[1].actor.kind === "agent" ? hops[1].actor : null;
      const shape = !(chain && chain.viewer === true) && (hops.length === 1 ? Boolean(who) : Boolean(who && agent));
      if (!c || !shape || !memberOk(who) || !c.people.includes(who.id) || (agent && !c.assistants.includes(agent.id))) throw new KernelError("not_found", "no such chat");
      return c;
    },
    /** Is this person in this chat (and still a member)? Sync, for the Surfaces door's check when it opens a session for a chat, and for every later room or append decision. @param {string} person @param {string} id */
    chatHas(person, id) {
      const c = chats.get(String(id));
      return Boolean(c) && c.people.includes(String(person)) && memberOk({ kind: "person", id: String(person), space: cfg.space });
    },
    /** The people of a chat who are still members, or null for no such chat. Kernel-internal: the room handle is built from this and never hands it out. @param {string} id @returns {string[] | null} */
    chatPeople(id) {
      const c = chats.get(String(id));
      return c ? c.people.filter((/** @type {string} */ x) => memberOk({ kind: "person", id: x, space: cfg.space })) : null;
    },
    /** The room's current membership version. @param {string} id @returns {{ ver: number } | null} */
    chatVersion(id) { const c = chats.get(String(id)); return c ? { ver: c.ver || 1 } : null; },
    /** Who was in the room at a version (the latest recorded version at or before it), or null when that version is older than the history kept. Kernel-internal. @param {string} id @param {number} ver @returns {string[] | null} */
    chatPeopleAt(id, ver) {
      const c = chats.get(String(id));
      const h = c && (c.h || [{ ver: c.ver || 1, people: c.people }]);
      if (!h || !h.length || !(ver >= h[0].ver)) return null;
      let at = h[0];
      for (const x of h) if (x.ver <= ver) at = x;
      return [...at.people];
    },
    /** The chat's assistants, for the append check. @param {string} id @returns {string[] | null} */
    chatAssistants(id) { const c = chats.get(String(id)); return c ? [...c.assistants] : null; },
    /**
     * The whole state as one sealed event: what a migration from an older key writes, and what rebuild can start from. Kernel-only.
     * A snapshot is a point the log can be read from: events before it are not needed once it exists.
     */
    async snapshot() {
      const state = { grants: [...grants.values()], memberships: [...memberships.values()], actors: [...actors], offers: [...offers.values()], invites: [...invites.values()], chats: [...chats.values()] };
      await note(kernelChain(), "grants.snapshot", urn("grant", "snapshot"), { state });
      return { grants: state.grants.length, memberships: state.memberships.length };
    },

    /**
     * Rebuild every grant and membership from the log (after a restart). The log is the durable copy, and authority comes only from events this store sealed:
     * each is checked by the sealing process (`kernel.verify`, pipelined in batches), must continue this store's own chain (`gseq`, `gprev`), and a genuine event
     * replayed later has an old `gseq` and is skipped. Events an older key sealed (position-bound, before custody moved) verify under `legacyKeys`, and once they have
     * been read a snapshot is written under the new seal so the old key is never needed again.
     * @returns {Promise<{ legacy: number, migrated: boolean }>}
     */
    async rebuild() {
      grants.clear(); memberships.clear(); actors.clear(); offers.clear(); invites.clear(); chats.clear();
      gseq = 0; gprev = "genesis";
      const evs = cfg.log.read({}).filter((/** @type {any} */ e) => e.data && typeof e.data === "object" && (LEGACY_RE.test(e.type) || e.type === "owner.changed" || e.type === "grants.snapshot"));
      /** @type {{ e: any, mac: any, n: number | undefined, prev: any, core: any, legacy: boolean }[]} */
      const items = evs.map((/** @type {any} */ e) => { const { mac, gseq: n, gprev: pv, ...core } = e.data; return { e, mac, n, prev: pv, core, legacy: n === undefined }; });
      // 1. Verify the new-style events, in pipelined batches.
      const fresh = items.filter(i => !i.legacy && typeof i.mac === "string" && Number.isInteger(i.n));
      const ok = new Set();
      for (let i = 0; i < fresh.length; i += 128) {
        const part = fresh.slice(i, i + 128);
        const res = await seal.verifyMany(part.map(x => ({ purpose: "grants-event-v1", data: sealed(x.e.type, x.e.subject, x.core, /** @type {number} */ (x.n), x.prev), mac: x.mac })));
        part.forEach((x, k) => { if (res[k]) ok.add(x); });
      }
      // 2. The newest verified snapshot (by its own number, not its place in the log: a replayed old one is older) is the starting state.
      const snaps = fresh.filter(i => ok.has(i) && i.e.type === "grants.snapshot").sort((a, b) => /** @type {number} */ (b.n) - /** @type {number} */ (a.n));
      const snap = snaps[0];
      let nextN = 1, nextPrev = "genesis", legacyCount = 0;
      const apply = (/** @type {any} */ e, /** @type {any} */ d) => {
        if (e.type === "grant.created" && grants.has(d.grant.id)) return; // an id is made once: a second creation of it is never a resurrection
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
        else if (e.type === "chat.created") { if (!chats.has(d.chat.id)) chats.set(d.chat.id, freeze(structuredClone(d.chat))); }
        else if (e.type === "chat.changed") { const c = chats.get(d.id); if (c) chats.set(d.id, freeze({ ...c, people: [...d.people], assistants: [...d.assistants], ver: d.ver ?? (c.ver || 1) + 1, h: [...(c.h || [{ ver: c.ver || 1, people: c.people }]), { ver: d.ver ?? (c.ver || 1) + 1, people: [...d.people] }].slice(-HISTORY) })); }
      };
      if (snap) {
        const st = snap.core.state;
        for (const g of st.grants) grants.set(g.id, freeze(structuredClone(g)));
        for (const m of st.memberships) memberships.set(m.person, freeze(structuredClone(m)));
        for (const a of st.actors) actors.add(a);
        for (const o of st.offers) offers.set(o.id, freeze(structuredClone(o)));
        for (const v of st.invites) invites.set(v.id, freeze(structuredClone(v)));
        for (const c of st.chats || []) chats.set(c.id, freeze(structuredClone(c)));
        nextN = /** @type {number} */ (snap.n) + 1; nextPrev = sha256(snap.mac);
      } else {
        // 3a. Events an older key sealed, in log order, each position-bound under a legacy key.
        for (const it of items) {
          if (!it.legacy || typeof it.mac !== "string" || it.e.type === "grants.snapshot") continue;
          const good = (cfg.legacyKeys || []).some((/** @type {any} */ k) => sameMac(hmac(k, canonical({ type: it.e.type, subject: it.e.subject, data: it.core, seq: it.e.seq, prev: it.e.prev })), it.mac));
          if (good) { apply(it.e, it.core); legacyCount++; }
        }
      }
      // 3b. The new chain: only the event that is exactly next (its number, and the hash of the seal before it) is taken; replays and gaps are skipped.
      const started = items.indexOf(snap);
      for (const it of items.slice(snap ? started + 1 : 0)) {
        if (!ok.has(it) || it.e.type === "grants.snapshot" || it.n !== nextN || it.prev !== nextPrev) continue;
        apply(it.e, it.core);
        nextN++; nextPrev = sha256(it.mac);
      }
      gseq = nextN - 1; gprev = nextPrev;
      // 4. Migration: legacy events were read, so write the state under the new seal; the old key is not needed again.
      let migrated = false;
      if (legacyCount > 0 && !snap) { await api.snapshot(); migrated = true; }
      return { legacy: legacyCount, migrated };
    },
  };

  // One pattern for every state-changing call (reviewer-2's R4): the calls run one at a time, and a call that fails while writing its sealed event (the sealing process died,
  // the log refused) restores the store from the log, which is the durable copy, so memory never shows a change the log does not hold, and the caller is told it failed.
  // A refusal the call itself makes before changing anything (a KernelError) needs no restore.
  let lock = Promise.resolve();
  for (const name of ["create", "revoke", "narrow", "setRole", "transferOwner", "removeMember", "addActor", "offer", "unoffer", "inviteCreate", "inviteConfirm", "inviteAccept", "sweep", "installModule", "chatCreate", "chatChange"]) {
    const f = /** @type {(...a: any[]) => Promise<any>} */ (/** @type {any} */ (api)[name]);
    /** @type {any} */ (api)[name] = (/** @type {any[]} */ ...a) => {
      const run = async () => { try { return await f(...a); } catch (e) { if (!(e instanceof KernelError)) await api.rebuild().catch(() => {}); throw e; } };
      const p = lock.then(run, run);
      lock = p.then(() => {}, () => {});
      return p;
    };
  }

  return Object.freeze({
    ...api, provider, members, isAdmin, roleOf,
    /** Called once by the gateway, with the authorizer it built from `provider` and `members`. */
    bind(/** @type {{ authorizer: any, registry: () => Map<string, any>, enforce?: (chain: any, d: any) => void }} */ b) { bound = { ...createGate({ authorizer: b.authorizer, log: cfg.log, enforce: b.enforce }), registry: b.registry }; },
  });
}
