// kernel/core/authorize.js: the one decision point (contract 6.3; invariants 1 to 4). Pure over what it is given:
// the chain (kernel-built), the action registry, the grants and memberships, and a clock. Deny by default.
// Steps: space check, candidates per hop, effective grant per hop, narrowing, policy obligations, sealed, return.
// K1 stops at the decision; sealing placeholders, presence signatures and approvals are enforced by K3/K4 against
// the obligations returned here.
import { isChain, hasKind, isExactlyPerson } from "./chain.js";
const DEFAULT_ASSISTANT = "assistant";
/** A model slot (`model:<provider>/<model>#<n>`, the Switchboard's) beside a person: it is the person's own authority, narrowed, and holds nothing of its own, so it is no member and needs no grant. Without a person it is nothing. */
const isSlot = (/** @type {any} */ actor, /** @type {any} */ chain) => actor.kind === "agent" && String(actor.id).startsWith("model:") && chain.hops.some((/** @type {any} */ x) => x.actor.kind === "person");
import { mintId } from "./ids.js";
import { segments, covers, containedPrefix, spaceOf } from "./urn.js";
import { KernelError } from "./errors.js";
import { TRUST_ORDER } from "../contracts/index.js";

const OUTWARD = new Set(["outward.send", "outward.pay", "outward.publish", "outward.delete", "outward.share"]);
const PRESENCE_RANK = { none: 0, session: 1, fresh: 2 };
const maxPresence = (/** @type {string} */ a, /** @type {string} */ b) => (PRESENCE_RANK[/** @type {'none'} */ (a)] >= PRESENCE_RANK[/** @type {'none'} */ (b)] ? a : b);
// An obligation the kernel cannot recognise is never silently met: it makes the effect an ask (K1 item 8c).
const KNOWN_OBLIGATIONS = new Set(["audit", "presence", "ask", "meter", "rate", "placeholders", "fields", "once", "draft_only"]);
const REASON_RANK = ["no_grant", "wrong_node", "pattern_not_covered", "not_contained", "revoked", "expired"];

/** Does an action pattern (`crm.update`, `crm.*`, `*.read`, `*`) cover `action`, for a grant made against action-set `version`? */
/** Actions only a Flow run may ask (see `byRunner`). */
const RUNNER_ONLY = new Set(["fn.run", "model.call"]);
/** Actions only a grant that names them covers, whatever their risk: no wildcard (an owner's `*`) reaches them, so the limits on the grant that does is the only way in. */
const NAMED_ONLY = new Set(["flows.act-standing"]);
export function patternCovers(pattern, action, since = 0, version = undefined, risk = undefined) {
  const a = action.split("."), p = pattern.split(".");
  const ok = pattern === "*" || (p.length === 2 && a.length === 2 && p.every((s, i) => s === "*" || s === a[i]));
  if (!ok) return null;
  if (pattern === action) return "covered";
  if (NAMED_ONLY.has(action)) return null;
  // A wildcard covers only read and write actions, and only those that existed when the grant was made (6.1). Admin,
  // grant and outward actions must be named; a grant with no action-set version covers no wildcard action at all.
  if (risk !== "read" && risk !== "write") return "pattern_not_covered";
  if (!Number.isInteger(version) || since > version) return "pattern_not_covered";
  return "covered";
}

// The dimensions a grant has, and the keys each may carry. A dimension or a key this file does not list is NOT known, and an unknown one makes containment fail: a field added to
// grants later refuses delegation until `contains` and `clampTo` learn it, never passes by being ignored.
const GRANT_KEYS = new Set(["id", "space", "subject", "actions", "action_set_version", "resource", "conditions", "issuer", "source", "parent", "status", "created_at", "revoked_at", "reason"]);
/** Resource types only the person they belong to may read (the `owner` attribute names them): a session's lines. */
export const OWNER_SCOPED_TYPES = new Set(["session"]);
const RESOURCE_KEYS = new Set(["prefix", "where", "fields"]);
const COND_KEYS = new Set(["where", "when", "how", "audience", "delegate", "budget", "rate", "once"]);
const sameJson = (/** @type {any} */ a, /** @type {any} */ b) => JSON.stringify(a) === JSON.stringify(b);
/** Is every member of `child` in `parent`? An absent child list is "no limit", which is wider than any parent list. @param {any[] | undefined} parent @param {any[] | undefined} child */
const subsetOf = (parent, child) => parent === undefined || (Array.isArray(child) && Array.isArray(parent) && child.every(x => parent.includes(x)));
const onlyKeys = (/** @type {any} */ o, /** @type {Set<string>} */ allowed) => !o || (typeof o === "object" && Object.keys(o).every(k => allowed.has(k)));

/**
 * Structural containment (6.3 step 4): can `child` be proven to grant no more than `parent`, on EVERY dimension a grant has: actions, the resource prefix, row predicates, the field
 * list, where it may be used (surfaces, nodes, residency), when (start, expiry, schedule), how (presence, approval), budget, rate, once, who may use it (audience), and the
 * delegation depth. For each, equal passes, tighter passes, looser fails, and anything this function cannot compare fails. This is the part that does not depend on delegation
 * (a grant narrowed in place is held to it too); `contains` adds the delegation rule.
 * @param {any} parent @param {any} child @param {(a: string) => number} [since]
 */
export function containsDims(parent, child, since = () => 0, riskOf = () => undefined) {
  if (!parent || !child || parent.space !== child.space) return false;
  if (!onlyKeys(parent, GRANT_KEYS) || !onlyKeys(child, GRANT_KEYS)) return false;
  if (!onlyKeys(parent.resource, RESOURCE_KEYS) || !onlyKeys(child.resource, RESOURCE_KEYS)) return false;
  const pc = parent.conditions || {}, cc = child.conditions || {};
  if (!onlyKeys(pc, COND_KEYS) || !onlyKeys(cc, COND_KEYS)) return false;
  // actions
  for (const ca of child.actions) {
    const ok = parent.actions.some((/** @type {string} */ pa) => pa === ca
      || (!ca.includes("*") && patternCovers(pa, ca, since(ca), parent.action_set_version, riskOf(ca)) === "covered")
      // A child pattern is inside a parent pattern only when the parent's wildcard is versioned and covers it.
      || (ca.includes("*") && Number.isInteger(parent.action_set_version) && Number.isInteger(child.action_set_version) && child.action_set_version >= parent.action_set_version && (pa === "*" || (pa.endsWith(".*") && ca.startsWith(pa.slice(0, -1))))));
    if (!ok) return false;
  }
  // resource: prefix, row predicates (every one of the parent's, unchanged), the field list
  if (!containedPrefix(child.resource.prefix, parent.resource.prefix)) return false;
  for (const pp of parent.resource.where || []) if (!(child.resource.where || []).some((/** @type {any} */ cp) => cp.attr === pp.attr && cp.op === pp.op && sameJson(cp.value, pp.value))) return false;
  if (parent.resource.fields !== undefined && !subsetOf(parent.resource.fields, child.resource.fields)) return false;
  // where it may be used
  if (!onlyKeys(pc.where, new Set(["nodes", "residency", "surfaces", "origins"])) || !onlyKeys(cc.where, new Set(["nodes", "residency", "surfaces", "origins"]))) return false;
  for (const k of ["nodes", "residency", "surfaces", "origins"]) if (pc.where && pc.where[k] !== undefined && !subsetOf(pc.where[k], cc.where && cc.where[k])) return false;
  // when: start no earlier, expiry no later, the schedule unchanged (a schedule is opaque here: only the same one is provably inside itself)
  if (!onlyKeys(pc.when, new Set(["not_before", "expires", "schedule"])) || !onlyKeys(cc.when, new Set(["not_before", "expires", "schedule"]))) return false;
  const pw = pc.when || {}, cw = cc.when || {};
  if (pw.not_before !== undefined && (cw.not_before === undefined || cw.not_before < pw.not_before)) return false;
  if (pw.expires !== undefined && (cw.expires === undefined || cw.expires > pw.expires)) return false;
  if (pw.schedule !== undefined && !sameJson(cw.schedule, pw.schedule)) return false;
  // how: presence at least as strict, the same approver and, if the parent says once, once
  if (!onlyKeys(pc.how, new Set(["presence", "approval"])) || !onlyKeys(cc.how, new Set(["presence", "approval"]))) return false;
  const rank = (/** @type {any} */ x) => (x === undefined ? 0 : PRESENCE_RANK[/** @type {'none'} */ (x)]);
  const pPres = pc.how && pc.how.presence, cPres = cc.how && cc.how.presence;
  if (pPres !== undefined && !(pPres in PRESENCE_RANK)) return false;
  if (cPres !== undefined && !(cPres in PRESENCE_RANK)) return false;
  if (rank(cPres) < rank(pPres)) return false;
  const pa = pc.how && pc.how.approval, ca = cc.how && cc.how.approval;
  if (pa) {
    if (!ca || typeof pa !== "object" || typeof ca !== "object" || !onlyKeys(pa, new Set(["by", "once"])) || !onlyKeys(ca, new Set(["by", "once"]))) return false;
    if (ca.by !== pa.by) return false;
    if (pa.once === true && ca.once !== true) return false;
  }
  if (pc.once === true && cc.once !== true) return false;
  // budget and rate: the child's limit no larger than the parent's, over a window no shorter
  if (pc.budget) {
    if (!cc.budget || cc.budget.meter !== pc.budget.meter || !(cc.budget.limit <= pc.budget.limit) || !onlyKeys(pc.budget, new Set(["meter", "limit"])) || !onlyKeys(cc.budget, new Set(["meter", "limit"]))) return false;
  }
  if (pc.rate) {
    if (!cc.rate || !(cc.rate.n <= pc.rate.n) || !(cc.rate.per_seconds >= pc.rate.per_seconds) || !onlyKeys(pc.rate, new Set(["n", "per_seconds"])) || !onlyKeys(cc.rate, new Set(["n", "per_seconds"]))) return false;
  }
  // who may use it
  if (pc.audience !== undefined && !subsetOf(pc.audience, cc.audience)) return false;
  return true;
}

/**
 * Containment for a DELEGATED grant: every dimension (`containsDims`) and the delegation rule: the parent may delegate, and the child may delegate only to a shallower depth.
 * @param {any} parent @param {any} child @param {(a: string) => number} [since]
 */
export function contains(parent, child, since = () => 0, riskOf = () => undefined) {
  if (!containsDims(parent, child, since, riskOf)) return false;
  const pd = parent.conditions?.delegate;
  if (!pd || !pd.allowed || !onlyKeys(pd, new Set(["allowed", "max_depth"]))) return false;
  const cd = child.conditions?.delegate;
  if (cd && (!onlyKeys(cd, new Set(["allowed", "max_depth"])) || (cd.allowed && !(cd.max_depth < pd.max_depth)))) return false;
  return true;
}

/**
 * The most a stored child may hold under its parent: the child's own grant cut down, dimension by dimension, to what `containsDims` accepts. Used when a grant already on disk is
 * found wider than its parent (it was made before containment checked every dimension): it keeps what it was inside and loses the rest. Returns null if it cannot be brought inside.
 * @param {any} parent @param {any} child @param {(a: string) => number} [since]
 */
export function clampTo(parent, child, since = () => 0, riskOf = () => undefined) {
  const pc = parent.conditions || {}, cc = child.conditions || {};
  const pw = pc.when || {}, cw = cc.when || {};
  /** @type {any} */ const cond = {};
  const where = {};
  for (const k of ["nodes", "residency", "surfaces", "origins"]) {
    const p = pc.where && pc.where[k], c = cc.where && cc.where[k];
    if (p !== undefined) /** @type {any} */ (where)[k] = Array.isArray(c) ? c.filter((/** @type {any} */ x) => p.includes(x)) : [...p];
    else if (c !== undefined) /** @type {any} */ (where)[k] = c;
  }
  if (Object.keys(where).length) cond.where = where;
  const when = { ...(cw.not_before !== undefined || pw.not_before !== undefined ? { not_before: Math.max(cw.not_before ?? -Infinity, pw.not_before ?? -Infinity) } : {}), ...(cw.expires !== undefined || pw.expires !== undefined ? { expires: Math.min(cw.expires ?? Infinity, pw.expires ?? Infinity) } : {}), ...(pw.schedule !== undefined ? { schedule: pw.schedule } : cw.schedule !== undefined ? { schedule: cw.schedule } : {}) };
  if (Object.keys(when).length) cond.when = when;
  const pPres = pc.how && pc.how.presence, cPres = cc.how && cc.how.presence;
  const how = { ...(pPres || cPres ? { presence: (PRESENCE_RANK[/** @type {'none'} */ (cPres || "none")] ?? 2) >= (PRESENCE_RANK[/** @type {'none'} */ (pPres || "none")] ?? 2) ? (cPres || "none") : pPres } : {}), ...(pc.how && pc.how.approval ? { approval: { ...pc.how.approval } } : cc.how && cc.how.approval ? { approval: { ...cc.how.approval } } : {}) };
  if (Object.keys(how).length) cond.how = how;
  if (pc.budget) cond.budget = { meter: pc.budget.meter, limit: Math.min(cc.budget && cc.budget.meter === pc.budget.meter ? cc.budget.limit : Infinity, pc.budget.limit) }; else if (cc.budget) cond.budget = { ...cc.budget };
  if (pc.rate) cond.rate = cc.rate && cc.rate.n <= pc.rate.n && cc.rate.per_seconds >= pc.rate.per_seconds ? { ...cc.rate } : { ...pc.rate }; else if (cc.rate) cond.rate = { ...cc.rate };
  if (pc.audience !== undefined) cond.audience = Array.isArray(cc.audience) ? cc.audience.filter((/** @type {any} */ x) => pc.audience.includes(x)) : [...pc.audience]; else if (cc.audience !== undefined) cond.audience = cc.audience;
  if (pc.once === true || cc.once === true) cond.once = true;
  if (cc.delegate || pc.delegate) { const pd = pc.delegate; cond.delegate = cc.delegate && cc.delegate.allowed && pd && pd.allowed && cc.delegate.max_depth < pd.max_depth ? { allowed: true, max_depth: cc.delegate.max_depth } : { allowed: false, max_depth: 0 }; }
  const resource = {
    prefix: containedPrefix(child.resource.prefix, parent.resource.prefix) ? child.resource.prefix : parent.resource.prefix,
    where: [...(parent.resource.where || []), ...(child.resource.where || []).filter((/** @type {any} */ cp) => !(parent.resource.where || []).some((/** @type {any} */ pp) => pp.attr === cp.attr && pp.op === cp.op && sameJson(pp.value, cp.value)))],
    ...(parent.resource.fields !== undefined ? { fields: Array.isArray(child.resource.fields) ? child.resource.fields.filter((/** @type {any} */ f) => parent.resource.fields.includes(f)) : [...parent.resource.fields] } : child.resource.fields !== undefined ? { fields: child.resource.fields } : {}),
  };
  if (!resource.where.length) delete /** @type {any} */ (resource).where;
  const actions = child.actions.filter((/** @type {string} */ ca) => containsDims(parent, { ...child, actions: [ca], resource: parent.resource, conditions: pc }, since, riskOf));
  const out = { ...child, actions, resource, conditions: cond };
  return actions.length && containsDims(parent, out, since, riskOf) ? out : null;
}

/**
 * @typedef {object} AuthorizerConfig
 * @property {string} space the evaluating Space
 * @property {Iterable<any>} actions ActionDef entries (`since` optional: the action-set version it appeared in)
 * @property {{ forSubject(actor: any, hop?: any, req?: any): any[] | Promise<any[]>, get(id: string): any | Promise<any> }} grants the provider may compile grants on demand from the hop and the request (the legacy retrofit does)
 * @property {{ has(actor: any): boolean, membership?(actor: any): any }} members
 * @property {(urn: string) => any} [attrs] kernel attributes of a resource: space, owner, sensitivity, project, created_by
 * @property {(urn: string) => string[]} [sealedFields]
 * @property {(service: string, action: string, resource: string) => boolean} [standing] whether a service declared a standing read of this family of resources; a service with no declaration gets nothing
 * @property {(i: { id: string, chain: any, action: string, resource: string, bind?: string, outward?: boolean }) => boolean | Promise<boolean>} [approvedPeek] the same check as approvedAct that spends nothing: an approval is a single-use authority for exactly its act, for the task's doer
 * @property {(i: { id: string, chain: any, action: string, resource: string, bind?: string }) => boolean | Promise<boolean>} [approvedAct] does this approval (an approved held-act task) cover exactly this act by this chain? It is USED here: the hook marks it spent atomically as it answers yes, so an approval is one decision, whoever calls `authorize` (the gate or a Flow runner), and cannot be replayed for a second act.
 * @property {{ match(i: { chain: any, action: string, resource: string }): any[] | Promise<any[]> }} [rules] the Space's standing rules (kernel/grants): asked BEFORE grants; a rule only tightens (never, always ask, draft only) and never allows
 * @property {(waiver: any, q: { chain: any, action: string, resource: string }) => boolean} [waives] does a live Kit-install waiver stand for presence on this act
 * @property {(proof: any, ctx: any) => boolean | { ok: boolean, reason?: string } | Promise<boolean | { ok: boolean, reason?: string }>} [verifyPresence] the hardware-signer check (core/presence.js); default none
 * @property {(chain: any) => boolean} [hasPresenceSession]
 * @property {number} [policy_version]
 * @property {() => number} [clock]
 */

/**
 * Does one grant cover one action on one resource right now, by its own words and nothing else: the action list, the selector (prefix and row predicates over the kernel's attributes), the
 * time it is good for and, for a login, the origins. Pure: no store, no chain, no clock of its own. The authorizer's `evaluate` and every other home of grants (the vault's own store in vyre-core)
 * ask this one function. `probe` skips row predicates (a type-level question). @param {any} g @param {string} action @param {string} resource @param {{ attrs?: any, now: number, probe?: boolean, origin?: string, since?: number, risk?: string }} o
 */
export function matchGrant(g, action, resource, o) {
  const attrs = o.attrs || {};
  let cov = null;
  for (const p of g.actions) { const c = patternCovers(p, action, o.since ?? 0, g.action_set_version, o.risk); if (c === "covered") { cov = c; break; } if (c) cov = c; }
  if (cov === null) return { ok: false, reason: "no_grant" };
  if (cov !== "covered") return { ok: false, reason: "pattern_not_covered" };
  if (!covers(g.resource.prefix, resource)) return { ok: false, reason: "no_grant" };
  // A type-level probe (input.probe) asks only what a grant carries for the type, to learn its field limits: row predicates are skipped, and the
  // answer is never an access decision for any row.
  for (const pr of o.probe ? [] : g.resource.where || []) {
    // A predicate on an absent attribute matches nothing, for every op; an unknown op denies.
    if (!Object.hasOwn(attrs, pr.attr) || attrs[pr.attr] === undefined || attrs[pr.attr] === null) return { ok: false, reason: "no_grant" };
    const v = attrs[pr.attr];
    const want = pr.value;
    if (!["eq", "ne", "in"].includes(pr.op)) return { ok: false, reason: "no_grant" };
    const hit = pr.op === "eq" ? v === want : pr.op === "ne" ? v !== want : Array.isArray(want) && want.includes(v);
    if (!hit) return { ok: false, reason: "no_grant" };
  }
  const c = g.conditions || {};
  if (c.when) {
    if (c.when.expires !== undefined && c.when.expires <= o.now) return { ok: false, reason: "expired" };
    if (c.when.not_before !== undefined && o.now < c.when.not_before) return { ok: false, reason: "no_grant" };
  }
  if (c.where && c.where.origins && !(typeof o.origin === "string" && c.where.origins.includes(o.origin))) return { ok: false, reason: "wrong_node" };
  return { ok: true };
}

/** @param {AuthorizerConfig} cfg */
export function createAuthorizer(cfg) {
  const clock = cfg.clock || Date.now;
  const reg = new Map([...cfg.actions].map(d => [d.action, d]));
  const since = (/** @type {string} */ a) => (reg.get(a) && reg.get(a).since) || 0;
  const riskOf = (/** @type {string} */ a) => reg.get(a)?.risk;
  const policyVersion = cfg.policy_version ?? 1;

  /** @param {any} input */
  async function authorize(input) {
    const now = clock();
    const decision = mintId("dec", now);
    /** @type {any} */ let ruleOf = null;
    const done = (/** @type {string} */ effect, /** @type {string} */ reason, grants = [], obligations = []) => {
      const obs = [...obligations];
      if (effect === "deny") obs.push({ type: "audit", class: "deny" });
      else if (effect === "ask") obs.push({ type: "audit", class: OUTWARD.has(reg.get(input?.action)?.risk) ? "outward" : "ask" });
      else if (OUTWARD.has(reg.get(input?.action)?.risk)) obs.push({ type: "audit", class: "outward" });
      return Object.freeze({ effect, reason, grants: Object.freeze([...grants]), obligations: Object.freeze(obs.map(o => Object.freeze(o))), decision, policy_version: policyVersion, ...(ruleOf ? { rule: Object.freeze({ id: ruleOf.id, kind: ruleOf.kind, label: ruleOf.label }) } : {}) });
    };
    const deny = (/** @type {string} */ reason) => done("deny", reason);
    try {
      if (!input || !isChain(input.chain) || !input.chain.hops.length) return deny("bad_input");
      const { chain, action, resource } = input;
      const def = reg.get(action);
      if (!def) return deny("unknown_action");
      // Running a Code step and asking a model are what a Flow RUN does, never what a person does directly: only a chain that carries a run's automation hop may ask, and what it needs from its
      // approver is the right to run Flows (so a member cannot run arbitrary code or spend AI by calling these themselves).
      const byRunner = typeof chain.job === "string" && chain.hops.some((/** @type {any} */ x) => x.actor.kind === "automation");
      if (RUNNER_ONLY.has(action) && !byRunner) return deny("runner_only");
      if (action === "flows.act-standing" && !byRunner) return deny("runner_only");
      const grantAction = RUNNER_ONLY.has(action) ? "flows.run" : action;
      // 1. Space check.
      if (chain.space !== cfg.space || spaceOf(resource) !== cfg.space || !segments(resource)) return deny("wrong_space");
      for (const h of chain.hops) if (h.actor.space !== cfg.space) return deny("wrong_space");
      const attrs = (cfg.attrs && cfg.attrs(resource)) || {};
      if (attrs.space !== undefined && attrs.space !== cfg.space) return deny("wrong_space");
      // A model slot is the person's authority narrowed to its chat's Project: another Project's resource is not its to read or touch, whatever the person holds. A resource that belongs to no Project is judged as before.
      // MS-1: a model slot reads only its own chat's record: another chat's record is not its to read, whoever its person is in.
      if (chain.room && typeof chain.room.chat === "string" && chain.hops.some((/** @type {any} */ x) => x.actor.kind === "agent" && String(x.actor.id).startsWith("model:"))) {
        const seg = segments(resource);
        if (seg && seg[1] === "chat" && seg[2] !== undefined && seg[2] !== chain.room.chat) return deny("outside_chat");
      }
      if (typeof chain.project === "string" && chain.hops.some((/** @type {any} */ x) => x.actor.kind === "agent" && String(x.actor.id).startsWith("model:")) && attrs.project !== undefined && attrs.project !== chain.project) return deny("outside_project");
      // A session's lines are its person's own (reviewer-2's KW-1): reading one needs the session's owner attribute to name the person asking, whatever role or `*/*` grant they hold. A session
      // with no owner attribute is read by nobody (fail closed), so a capture that does not say whose session it is leaks nothing. The Space's owner reads their own, like anyone.
      const segs = segments(resource);
      // A person's Personal project (R031-03) is theirs alone: a project record made with an owner attribute is read and written only by that person and their assistants. A chain with no person is refused
      // too, except the one module that made the row and keeps it (its `created_by` is that same service): no other module, admin or assistant reads it unless it relays the person.
      const lastHop = chain.hops[chain.hops.length - 1].actor;
      const privateProject = Boolean(segs && segs[1] === "project" && typeof attrs.owner === "string" && !(lastHop.kind === "service" && attrs.created_by === `service:${lastHop.id}` && !chain.hops.some((/** @type {any} */ x) => x.actor.kind === "person")));
      if (segs && ((OWNER_SCOPED_TYPES.has(segs[1]) && def.risk === "read") || privateProject)) {
        const asker = chain.hops[0] && chain.hops[0].actor && chain.hops[0].actor.kind === "person" ? chain.hops[0].actor.id : null;
        const canon = (/** @type {string} */ id) => (typeof cfg.canonicalPerson === "function" ? cfg.canonicalPerson(id) : id);
        if (!asker || typeof attrs.owner !== "string" || canon(attrs.owner) !== canon(asker)) return deny("not_yours");
      }
      const risk = def.risk;
      // Taint (6.3 step 5, invariant 9): what the chain consumed limits what it may drive.
      // An unknown trust value is the most restrictive, never trusted (invariant 9).
      const trust = TRUST_ORDER.includes(chain.labels.trust) ? chain.labels.trust : "untrusted";
      if (trust === "untrusted" && risk !== "read") return deny("tainted");
      // A viewer chain (one person in the room an assistant writes for) reads and does nothing else.
      if (chain.viewer === true && risk !== "read") return deny("viewer_chain");
      // A grant is a person's act: never from a chain that holds a model, whatever it was lent (invariants 2 and 4).
      if (risk === "grant" && hasKind(chain, "agent")) return deny("model_chain");

      // Standing rules of the Space, BEFORE any grant: a rule's refusal wins, and a rule can only tighten. `never` refuses here; `always_ask` and `draft_only` shape the decision below.
      /** @type {any[]} */ const ruled = cfg.rules ? await cfg.rules.match({ chain, action, resource }) : [];
      const neverRule = ruled.find(r => r.kind === "never");
      if (neverRule) { ruleOf = neverRule; return deny("rule_never"); }
      const askRule = ruled.find(r => r.kind === "always_ask"), draftRule = ruled.find(r => r.kind === "draft_only");
      ruleOf = askRule || draftRule || null;
      // Fail closed: a draft-only rule on an action whose door does not prepare a draft would be a rule that does nothing, so the act is refused instead.
      if (draftRule && !def.draftable) { ruleOf = draftRule; return deny("rule_draft_unsupported"); }

      // An approval is a single-use authority for EXACTLY the bound act, given to the task's doer (the approval queue's own token, no new permission): when the doer presents an approved task whose decision was
      // signed by the right person, with the same bind, not expired and not spent, the act needs no standing grant of its own. It is only looked at here (nothing is spent); the one use is counted below.
      const heldApproval = typeof input.approval === "string" && OUTWARD.has(risk) && typeof cfg.approvedPeek === "function"
        && await cfg.approvedPeek({ id: input.approval, chain, action, resource, outward: true, ...(typeof input.bind === "string" ? { bind: input.bind } : {}) }) === true;
      // 2 and 3. Candidates and the effective grant per hop; the chain's authority is the intersection.
      const used = [];
      /** @type {any[]} */ const obligations = [];
      let presence = "none";
      let unknownObligation = false;
      let approver = null;
      for (const h of chain.hops) {
        const actor = h.actor;
        // A Flow run's automation hop is a job label under its approving person (kernel/core/chain.js forFlow: only the builder makes one, and only from a person's chain): it adds no
        // grants and takes none away, so the run can do exactly what its approver can, narrowed further by the runner's declared caps. Without a person in the chain it is nothing.
        if (actor.kind === "automation" && typeof chain.job === "string" && chain.hops.some((/** @type {any} */ x) => x.actor.kind === "person")) continue;
        if (isSlot(actor, chain)) continue;
        if (!cfg.members.has(actor)) {
          // A standing service reads without a person in the chain; it never writes (4.3).
          if (heldApproval) continue;
          if (!(actor.kind === "service" && risk === "read" && cfg.standing && cfg.standing(actor.id, action, resource))) return deny("not_a_member");
          continue;
        }
        if (actor.kind === "service" && risk === "read" && cfg.standing && cfg.standing(actor.id, action, resource) && !(await cfg.grants.forSubject(actor, h, input)).length) continue;
        // The default assistant is a delegate: acting for a person (that person is in the chain) it adds no grants of its own and takes none away, so the chain's authority is the
        // person's. Alone, or with no person beside it, it is an ordinary actor with no grants and can do nothing. Named assistants are never delegates: their own grants narrow them.
        if (actor.kind === "agent" && (actor.id === DEFAULT_ASSISTANT || String(actor.id).startsWith("model:")) && chain.hops.some((/** @type {any} */ x) => x.actor.kind === "person")) continue;
        const ms = cfg.members.membership ? cfg.members.membership(actor) : undefined;
        if (ms && ms.role === "temp") {
          if (ms.expires === undefined || ms.expires <= now) return deny("expired");
          if (!(ms.scope || []).some((/** @type {string} */ s) => covers(s, resource))) return deny("no_grant");
        }
        const candidates = (await cfg.grants.forSubject(actor, h, input)).filter(g => g.status === "active" && g.space === cfg.space).sort((a, b) => (a.id < b.id ? -1 : 1));
        let best = "no_grant", chosen = null, chosenObs = [];
        for (const g of candidates) {
          const r = await evaluate(g, h, ms, chain, grantAction, resource, attrs, now, 0, input.probe === true, input.origin);
          if (r.ok) { chosen = g; chosenObs = r.obligations; break; }
          if (REASON_RANK.indexOf(r.reason) > REASON_RANK.indexOf(best)) best = r.reason;
        }
        if (!chosen && heldApproval) continue; // the approval stands for the act; the use below counts it
        if (!chosen) return deny(best);
        used.push(chosen.id);
        for (const o of chosenObs) {
          if (o.type === "presence") presence = maxPresence(presence, o.method);
          else if (o.type === "ask") approver = approver || o.approver;
          else { obligations.push(o); if (!KNOWN_OBLIGATIONS.has(o.type)) unknownObligation = true; }
        }
      }

      // 5. Policy by risk class and sensitivity; the strictest wins.
      let ask = null;
      if (OUTWARD.has(risk)) { presence = maxPresence(presence, "fresh"); ask = { kind: risk, approver: approver || "owner" }; }
      else if (approver) ask = { kind: risk, approver };
      if (risk === "grant") presence = maxPresence(presence, "fresh");
      // ONE permission rule (lead ruling c328cd1): a person caller (a paired device, the terminal, the Capsule, the app: a chain of exactly one person) does admin acts with no presence; the yes is asked at
      // pairing a device, a vault secret and an outward act (below and in the vault), not here. An agent or a chain with an assistant in it still needs the person's session.
      if (risk === "admin" && !isExactlyPerson(chain)) presence = maxPresence(presence, "session");
      if (attrs.sensitivity === "privileged") presence = presence === "none" ? "session" : maxPresence(presence, "fresh");
      // Tainted context (invariant 9): foreign content may not quietly drive grants, admin or more than a read across Spaces.
      let tainted = false;
      if (trust === "external" && (risk === "grant" || risk === "admin")) tainted = true;
      if (chain.labels.source_spaces.length > 1 && risk !== "read") tainted = true;
      if (tainted && !ask) ask = { kind: risk, approver: "owner" };
      // An always-ask rule: approval every time by the named person or role, whatever any grant says (no grant can waive it; nothing here lowers it).
      if (askRule) ask = { kind: risk, approver: askRule.approver, rule: askRule.id };
      // A draft-only rule: the act may be done only as a draft in the outside system; the executor must never send, even after an approval.
      if (draftRule) obligations.push({ type: "draft_only", rule: draftRule.id });
      if (unknownObligation && !ask) ask = { kind: risk, approver: "owner" };

      // 6. Sealed fields go to a model as placeholders; a property of the destination and the chain.
      if (hasKind(chain, "agent") && cfg.sealedFields) {
        const fields = cfg.sealedFields(resource);
        if (fields && fields.length) obligations.push({ type: "placeholders", fields: [...fields] });
      }

      // A held act the person approved (a task, by id) is the evidence that satisfies the outward ask for exactly that act by exactly that chain, once. The
      // approval stands in for the person's confirmation too: they gave it when they approved. Nothing else is waived (a deny stays a deny).
      if (ask && (OUTWARD.has(risk) || askRule) && typeof input.approval === "string" && cfg.approvedAct && await (input.peek === true && cfg.approvedPeek ? cfg.approvedPeek : cfg.approvedAct)({ id: input.approval, chain, action, resource, ...(OUTWARD.has(risk) ? { outward: true } : {}), ...(typeof input.bind === "string" ? { bind: input.bind } : {}), ...(askRule ? { rule: { id: askRule.id, approver: askRule.approver } } : {}) }) === true) {
        ask = null; presence = "none";
      }

      // Is each obligation met by evidence the kernel holds? An unmet one makes the effect ask, not allow.
      // Binding evidence: the proof must cover the canonical input, so it is not reusable for another payload (K4 supplies the hash).
      const ctxEvidence = { decision, chain, action, resource, input_hash: input.input_hash };
      // A session stands for presence on admin and grant only when the chain is exactly one person: an assistant in the chain never inherits it.
      const sessionOk = !(risk === "admin" || risk === "grant") || isExactlyPerson(chain);
      /** @type {string | null} the verifier's stable reason when it refused a proof (a verifier that answers { ok, reason }), for the caller to read beside needs_presence */ let presenceWhy = null;
      const presenceMet = presence === "none" || (presence === "session" && sessionOk && (cfg.hasPresenceSession ? cfg.hasPresenceSession(chain) : false))
        || (input.presence && cfg.verifyPresence ? await (async () => { const r = await cfg.verifyPresence(input.presence, ctxEvidence); if (r && typeof r === "object") { presenceWhy = r.ok === true ? null : String(r.reason || "refused"); return r.ok === true; } return r === true; })() : false)
        // The owner's approval of a Kit's install card, held by the kernel as a waiver only it can make (kernel/tasks/kit-apply.js): presence for that install and no other act.
        || (input.waiver !== undefined && typeof cfg.waives === "function" ? cfg.waives(input.waiver, { chain, action, resource }) === true : false);
      // The same obligation reached by two grants of a delegation chain (a child and the parent it came from) is one obligation.
      const out = obligations.filter((o, i) => obligations.findIndex(x => JSON.stringify(x) === JSON.stringify(o)) === i);
      if (presence !== "none") out.push({ type: "presence", method: presence });
      if (ask) out.push({ type: "ask", kind: ask.kind, approver: ask.approver, checker_must_be_person: true, ...(askRule ? { rule: askRule.id, waivable: false } : {}) });
      // 7. Return. Approvals are K4's: an ask stays an ask until the kernel's task machinery records the approval.
      if (ask) return done("ask", tainted && !OUTWARD.has(risk) ? "tainted" : "needs_approval", used, out);
      if (!presenceMet) return Object.freeze({ ...done("ask", "needs_presence", used, out), ...(presenceWhy ? { presence_reason: presenceWhy } : {}) });
      return done("allow", "ok", used, out);
    } catch (e) {
      // Fail closed on anything unexpected: a deny that says only why in the log (invariant 1).
      if (e instanceof KernelError) return deny(e.code === "not_a_member" ? "not_a_member" : "bad_input");
      return deny("bad_input");
    }
  }

  /** One candidate grant against one hop: coverage, selector, kernel attributes, conditions, narrowing. */
  async function evaluate(/** @type {any} */ g, /** @type {any} */ h, /** @type {any} */ ms, /** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ resource, /** @type {any} */ attrs, /** @type {number} */ now, depth = 0, probe = false, origin = undefined) {
    const subj = g.subject;
    const subjectOk = subj.kind === "actor" ? subj.actor.kind === h.actor.kind && subj.actor.id === h.actor.id && subj.actor.space === h.actor.space
      : subj.kind === "role" ? Boolean(ms && ms.role === subj.name)
      : subj.kind === "group" ? Boolean(cfg.groups && cfg.groups.has(subj.id, h.actor, chain)) : false;
    if (!subjectOk) return { ok: false, reason: "no_grant" };
    // An assistant reaches a team's grant only by association with a person in the team, and by it holds use and nothing that changes who has access or shows a value: no admin, grant or sharing act.
    if (subj.kind === "group" && h.actor.kind === "agent" && ["admin", "grant", "outward.share", "outward.delete"].includes(String((reg.get(action) || {}).risk))) return { ok: false, reason: "no_grant" };
    const m = matchGrant(g, action, resource, { attrs, now, probe, origin, since: since(action), risk: riskOf(action) });
    if (!m.ok) return m;
    const c = g.conditions || {};
    let obsUnknownSchedule = false;
    // A schedule is stored but not evaluated here: a grant that carries one cannot be proven to apply now, so it is never met silently (it makes the effect an ask).
    if (c.when && c.when.schedule !== undefined) obsUnknownSchedule = true;
    if (c.where) {
      if (c.where.surfaces && !(h.via && c.where.surfaces.includes(h.via.surface))) return { ok: false, reason: "wrong_node" };
      if (c.where.nodes && !(h.via && c.where.nodes.includes(h.via.node))) return { ok: false, reason: "wrong_node" };
    }
    if (c.audience && chain.hops.some((/** @type {any} */ x) => x.actor.kind === "service" && !c.audience.includes(x.actor.id))) return { ok: false, reason: "no_grant" };
    /** @type {any[]} */ const obs = [];
    if (c.how && c.how.presence && c.how.presence !== "none") obs.push({ type: "presence", method: c.how.presence });
    if (c.how && c.how.approval) obs.push({ type: "ask", kind: reg.get(action).risk, approver: c.how.approval.by, checker_must_be_person: true });
    // A field allow-list on the selector: the gateway omits other fields on read and refuses writes to them (the narrowest hop wins).
    if (Array.isArray(g.resource.fields)) obs.push({ type: "fields", allow: [...g.resource.fields] });
    // These three are counted by the gateway (kernel/core/limits.js): authorize only says the grant carries them.
    if (c.budget) obs.push({ type: "meter", meter: c.budget.meter, limit: c.budget.limit, amount: 1, grant: g.id });
    if (c.rate) obs.push({ type: "rate", n: c.rate.n, per_seconds: c.rate.per_seconds, grant: g.id });
    if (c.once === true || (c.how && c.how.approval && c.how.approval.once === true)) obs.push({ type: "once", grant: g.id });
    for (const k of Object.keys(c)) if (!["when", "where", "how", "audience", "delegate", "budget", "rate", "once"].includes(k)) obs.push({ type: `unknown:${k}` });
    if (obsUnknownSchedule) obs.push({ type: "unknown:schedule" });
    // Narrowing: a delegated grant is contained in its parent, the parent is rechecked now, and its presence and
    // approval conditions come along as obligations (R6-8); revoking a parent kills every child.
    if (g.parent) {
      if (depth >= 3) return { ok: false, reason: "not_contained" };
      const parent = await cfg.grants.get(g.parent);
      if (!parent || parent.status !== "active") return { ok: false, reason: "revoked" };
      if (!contains(parent, g, since, riskOf)) return { ok: false, reason: "not_contained" };
      // The adder must still be a member, unexpired and in scope: a child grant dies with its maker's standing (R6-8).
      if (parent.subject.kind === "actor") {
        const pa = parent.subject.actor;
        if (!cfg.members.has(pa)) return { ok: false, reason: "revoked" };
        const pms = cfg.members.membership ? cfg.members.membership(pa) : undefined;
        if (pms && pms.role === "temp" && (pms.expires === undefined || pms.expires <= now || !(pms.scope || []).some((/** @type {string} */ s) => covers(s, resource)))) return { ok: false, reason: "expired" };
      }
      const pr = await evaluate({ ...parent, subject: subj }, h, ms, chain, action, resource, attrs, now, depth + 1, probe, origin);
      if (!pr.ok) return pr;
      obs.push(...pr.obligations);
    }
    return { ok: true, obligations: obs };
  }

  /**
   * Does this chain get the SAME answer for every record of one type? True only when it can be proven from the grants alone, and it is deliberately narrow: every grant of every hop that
   * could reach the type covers the whole type, none carries a row predicate or a delegation parent, no standing rule touches the action, no hop is a temporary member or a bare
   * service. When it is true the type-level decision (a probe) is the decision for every row, so a store may total rows without asking row by row. Anything else is false.
   * @param {{ chain: any, action: string, type: string }} input
   */
  async function rowUniform(input) {
    try {
      const { chain, action, type } = input;
      if (!input || !isChain(chain) || !chain.hops.length || !reg.get(action)) return false;
      if (chain.space !== cfg.space || !/^[a-z][a-z0-9_]{0,63}$/.test(type)) return false;
      if (cfg.rules && cfg.rules.touches ? cfg.rules.touches(chain, action) : Boolean(cfg.rules)) return false;
      if (type === "project") return false; // a Personal project tells its rows apart (the owner rule above)
      const proto = `vyre://${cfg.space}/${type}/x`;
      for (const h of chain.hops) {
        const actor = h.actor;
        if (isSlot(actor, chain)) continue;
        if (!cfg.members.has(actor) || actor.kind === "service") return false;
        if (actor.kind === "agent" && (actor.id === DEFAULT_ASSISTANT || String(actor.id).startsWith("model:")) && chain.hops.some((/** @type {any} */ x) => x.actor.kind === "person")) continue;
        const ms = cfg.members.membership ? cfg.members.membership(actor) : undefined;
        if (ms && ms.role === "temp") return false;
        let wholeCover = false;
        for (const g of await cfg.grants.forSubject(actor, h, { chain, action, resource: proto, probe: true })) {
          if (g.status !== "active" || g.space !== cfg.space) continue;
          const p = segments(g.resource.prefix);
          if (!p) return false;
          const reaches = p.length <= 2 ? p.every((seg, i) => seg === "*" || seg === [cfg.space, type][i]) : p.slice(0, 2).every((seg, i) => seg === "*" || seg === [cfg.space, type][i]);
          if (!reaches) continue;
          const whole = p.length <= 2 || p[2] === "*" && p.length === 3;
          if (!whole || (g.resource.where && g.resource.where.length) || g.parent) return false;
          wholeCover = true;
        }
        // Uniform means every hop has a grant that reaches the whole type. No grant at all is a refusal for every row, which a total must not be the first to find out: not uniform.
        if (!wholeCover) return false;
      }
      return true;
    } catch { return false; }
  }

  /** The kernel attributes a store can filter on from its own attribute table (the ones the gateway writes with a record). */
  const PUSH_ATTRS = new Set(["owner", "project", "sensitivity", "created_by"]);
  /**
   * For a caller whose answer is NOT the same for every row, can the answer be said as a predicate on stored attributes alone? True only for the plain case: one person (and the default
   * assistant acting for them), no rule on the action, no temp member, and every grant that carries the action over the type is whole-type with no parent and no condition, carrying at most
   * `where` terms of the form `attr eq "text"` on a stored attribute. The answer is `{ any: [ { attr: value, ... }, ... ] }`: a row is allowed when its attributes equal ALL the terms of ANY
   * one alternative (a missing attribute matches nothing, as in `evaluate`). `{ any: [] }` allows no row. Null: not expressible here (uniform callers, and everything with anything more
   * in it) and the caller is totalled row by row. Two restricted hops are not combined: that is null too.
   * @param {{ chain: any, action: string, type: string }} input @returns {Promise<{ any: Record<string, string>[] } | null>}
   */
  async function rowPredicate(input) {
    try {
      const { chain, action, type } = input;
      if (!input || !isChain(chain) || !chain.hops.length || !reg.get(action)) return null;
      if (chain.space !== cfg.space || !/^[a-z][a-z0-9_]{0,63}$/.test(type)) return null;
      if (cfg.rules && cfg.rules.touches ? cfg.rules.touches(chain, action) : Boolean(cfg.rules)) return null;
      const proto = `vyre://${cfg.space}/${type}/x`;
      /** @type {Record<string, string>[] | null} */ let result = null;
      for (const h of chain.hops) {
        const actor = h.actor;
        if (isSlot(actor, chain)) continue;
        if (!cfg.members.has(actor) || actor.kind === "service") return null;
        if (actor.kind === "agent" && (actor.id === DEFAULT_ASSISTANT || String(actor.id).startsWith("model:")) && chain.hops.some((/** @type {any} */ x) => x.actor.kind === "person")) continue;
        const ms = cfg.members.membership ? cfg.members.membership(actor) : undefined;
        if (ms && ms.role === "temp") return null;
        let whole = false;
        /** @type {Record<string, string>[]} */ const alts = [];
        for (const g of await cfg.grants.forSubject(actor, h, { chain, action, resource: proto, probe: true })) {
          if (g.status !== "active" || g.space !== cfg.space) continue;
          const p = segments(g.resource.prefix);
          if (!p) return null;
          const reaches = p.length <= 2 ? p.every((seg, i) => seg === "*" || seg === [cfg.space, type][i]) : p.slice(0, 2).every((seg, i) => seg === "*" || seg === [cfg.space, type][i]);
          if (!reaches) continue;
          let cov = null;
          for (const pa of g.actions) { const c = patternCovers(pa, action, since(action), g.action_set_version, riskOf(action)); if (c === "covered") { cov = c; break; } if (c) cov = c; }
          if (cov === null) continue;
          if (cov !== "covered") return null;
          if (g.parent || (g.conditions && Object.keys(g.conditions).length)) return null;
          if (!(p.length <= 2 || (p[2] === "*" && p.length === 3))) return null;
          const where = g.resource.where || [];
          if (!where.length) { whole = true; break; }
          /** @type {Record<string, string>} */ const alt = {};
          let never = false;
          for (const w of where) {
            if (!w || w.op !== "eq" || typeof w.value !== "string" || !PUSH_ATTRS.has(w.attr)) return null;
            if (Object.hasOwn(alt, w.attr) && alt[w.attr] !== w.value) never = true;
            alt[w.attr] = w.value;
          }
          if (!never) alts.push(alt);
        }
        if (whole) continue;
        if (result !== null) return null;
        result = alts;
      }
      return result === null ? null : { any: result };
    } catch { return null; }
  }

  return Object.freeze({ authorize, rowUniform, rowPredicate, actions: reg });
}
