// kernel/core/authorize.js: the one decision point (contract 6.3; invariants 1 to 4). Pure over what it is given:
// the chain (kernel-built), the action registry, the grants and memberships, and a clock. Deny by default.
// Steps: space check, candidates per hop, effective grant per hop, narrowing, policy obligations, sealed, return.
// K1 stops at the decision; sealing placeholders, presence signatures and approvals are enforced by K3/K4 against
// the obligations returned here.
import { isChain, hasKind, isExactlyPerson } from "./chain.js";
import { mintId } from "./ids.js";
import { segments, covers, containedPrefix, spaceOf } from "./urn.js";
import { KernelError } from "./errors.js";
import { TRUST_ORDER } from "../contracts/index.js";

const OUTWARD = new Set(["outward.send", "outward.pay", "outward.publish", "outward.delete", "outward.share"]);
const PRESENCE_RANK = { none: 0, session: 1, fresh: 2 };
const maxPresence = (/** @type {string} */ a, /** @type {string} */ b) => (PRESENCE_RANK[/** @type {'none'} */ (a)] >= PRESENCE_RANK[/** @type {'none'} */ (b)] ? a : b);
// An obligation the kernel cannot recognise is never silently met: it makes the effect an ask (K1 item 8c).
const KNOWN_OBLIGATIONS = new Set(["audit", "presence", "ask", "meter", "rate", "placeholders", "fields", "once"]);
const REASON_RANK = ["no_grant", "wrong_node", "pattern_not_covered", "not_contained", "revoked", "expired"];

/** Does an action pattern (`crm.update`, `crm.*`, `*.read`, `*`) cover `action`, for a grant made against action-set `version`? */
export function patternCovers(pattern, action, since = 0, version = undefined, risk = undefined) {
  const a = action.split("."), p = pattern.split(".");
  const ok = pattern === "*" || (p.length === 2 && a.length === 2 && p.every((s, i) => s === "*" || s === a[i]));
  if (!ok) return null;
  if (pattern === action) return "covered";
  // A wildcard covers only read and write actions, and only those that existed when the grant was made (6.1). Admin,
  // grant and outward actions must be named; a grant with no action-set version covers no wildcard action at all.
  if (risk !== "read" && risk !== "write") return "pattern_not_covered";
  if (!Number.isInteger(version) || since > version) return "pattern_not_covered";
  return "covered";
}

/**
 * Structural containment (6.3 step 4): can `child` be proven to grant no more than `parent`? Anything the engine
 * cannot prove is "not contained", which fails closed.
 * @param {any} parent @param {any} child @param {(a: string) => number} [since]
 */
export function contains(parent, child, since = () => 0, riskOf = () => undefined) {
  if (parent.space !== child.space) return false;
  for (const ca of child.actions) {
    const ok = parent.actions.some((/** @type {string} */ pa) => pa === ca
      || (!ca.includes("*") && patternCovers(pa, ca, since(ca), parent.action_set_version, riskOf(ca)) === "covered")
      // A child pattern is inside a parent pattern only when the parent's wildcard is versioned and covers it.
      || (ca.includes("*") && Number.isInteger(parent.action_set_version) && Number.isInteger(child.action_set_version) && child.action_set_version >= parent.action_set_version && (pa === "*" || (pa.endsWith(".*") && ca.startsWith(pa.slice(0, -1))))));
    if (!ok) return false;
  }
  if (!containedPrefix(child.resource.prefix, parent.resource.prefix)) return false;
  for (const pp of parent.resource.where || []) {
    if (!(child.resource.where || []).some((/** @type {any} */ cp) => cp.attr === pp.attr && cp.op === pp.op && JSON.stringify(cp.value) === JSON.stringify(pp.value))) return false;
  }
  const pe = parent.conditions?.when?.expires, ce = child.conditions?.when?.expires;
  if (pe !== undefined && (ce === undefined || ce > pe)) return false;
  const pd = parent.conditions?.delegate;
  if (!pd || !pd.allowed) return false;
  const cd = child.conditions?.delegate;
  if (cd && cd.allowed && cd.max_depth >= pd.max_depth) return false;
  return true;
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
 * @property {(i: { id: string, chain: any, action: string, resource: string }) => boolean | Promise<boolean>} [approvedAct] does this approval (an approved held-act task) cover exactly this act by this chain? Pure: the use is counted once by the gateway (an obligation).
 * @property {(proof: any, ctx: any) => boolean | Promise<boolean>} [verifyPresence] the hardware-signer check (core/presence.js); default none
 * @property {(chain: any) => boolean} [hasPresenceSession]
 * @property {number} [policy_version]
 * @property {() => number} [clock]
 */

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
    const done = (/** @type {string} */ effect, /** @type {string} */ reason, grants = [], obligations = []) => {
      const obs = [...obligations];
      if (effect === "deny") obs.push({ type: "audit", class: "deny" });
      else if (effect === "ask") obs.push({ type: "audit", class: OUTWARD.has(reg.get(input?.action)?.risk) ? "outward" : "ask" });
      else if (OUTWARD.has(reg.get(input?.action)?.risk)) obs.push({ type: "audit", class: "outward" });
      return Object.freeze({ effect, reason, grants: Object.freeze([...grants]), obligations: Object.freeze(obs.map(o => Object.freeze(o))), decision, policy_version: policyVersion });
    };
    const deny = (/** @type {string} */ reason) => done("deny", reason);
    try {
      if (!input || !isChain(input.chain) || !input.chain.hops.length) return deny("bad_input");
      const { chain, action, resource } = input;
      const def = reg.get(action);
      if (!def) return deny("unknown_action");
      // 1. Space check.
      if (chain.space !== cfg.space || spaceOf(resource) !== cfg.space || !segments(resource)) return deny("wrong_space");
      for (const h of chain.hops) if (h.actor.space !== cfg.space) return deny("wrong_space");
      const attrs = (cfg.attrs && cfg.attrs(resource)) || {};
      if (attrs.space !== undefined && attrs.space !== cfg.space) return deny("wrong_space");
      const risk = def.risk;
      // Taint (6.3 step 5, invariant 9): what the chain consumed limits what it may drive.
      // An unknown trust value is the most restrictive, never trusted (invariant 9).
      const trust = TRUST_ORDER.includes(chain.labels.trust) ? chain.labels.trust : "untrusted";
      if (trust === "untrusted" && risk !== "read") return deny("tainted");
      // A grant is a person's act: never from a chain that holds a model, whatever it was lent (invariants 2 and 4).
      if (risk === "grant" && hasKind(chain, "agent")) return deny("model_chain");

      // 2 and 3. Candidates and the effective grant per hop; the chain's authority is the intersection.
      const used = [];
      /** @type {any[]} */ const obligations = [];
      let presence = "none";
      let unknownObligation = false;
      let approver = null;
      for (const h of chain.hops) {
        const actor = h.actor;
        if (!cfg.members.has(actor)) {
          // A standing service reads without a person in the chain; it never writes (4.3).
          if (!(actor.kind === "service" && risk === "read" && cfg.standing && cfg.standing(actor.id, action, resource))) return deny("not_a_member");
          continue;
        }
        if (actor.kind === "service" && risk === "read" && cfg.standing && cfg.standing(actor.id, action, resource) && !(await cfg.grants.forSubject(actor, h, input)).length) continue;
        const ms = cfg.members.membership ? cfg.members.membership(actor) : undefined;
        if (ms && ms.role === "temp") {
          if (ms.expires === undefined || ms.expires <= now) return deny("expired");
          if (!(ms.scope || []).some((/** @type {string} */ s) => covers(s, resource))) return deny("no_grant");
        }
        const candidates = (await cfg.grants.forSubject(actor, h, input)).filter(g => g.status === "active" && g.space === cfg.space).sort((a, b) => (a.id < b.id ? -1 : 1));
        let best = "no_grant", chosen = null, chosenObs = [];
        for (const g of candidates) {
          const r = await evaluate(g, h, ms, chain, action, resource, attrs, now, 0, input.probe === true);
          if (r.ok) { chosen = g; chosenObs = r.obligations; break; }
          if (REASON_RANK.indexOf(r.reason) > REASON_RANK.indexOf(best)) best = r.reason;
        }
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
      if (risk === "admin") presence = maxPresence(presence, "session");
      if (attrs.sensitivity === "privileged") presence = presence === "none" ? "session" : maxPresence(presence, "fresh");
      // Tainted context (invariant 9): foreign content may not quietly drive grants, admin or more than a read across Spaces.
      let tainted = false;
      if (trust === "external" && (risk === "grant" || risk === "admin")) tainted = true;
      if (chain.labels.source_spaces.length > 1 && risk !== "read") tainted = true;
      if (tainted && !ask) ask = { kind: risk, approver: "owner" };
      if (unknownObligation && !ask) ask = { kind: risk, approver: "owner" };

      // 6. Sealed fields go to a model as placeholders; a property of the destination and the chain.
      if (hasKind(chain, "agent") && cfg.sealedFields) {
        const fields = cfg.sealedFields(resource);
        if (fields && fields.length) obligations.push({ type: "placeholders", fields: [...fields] });
      }

      // A held act the person approved (a task, by id) is the evidence that satisfies the outward ask for exactly that act by exactly that chain, once. The
      // approval stands in for the person's confirmation too: they gave it when they approved. Nothing else is waived (a deny stays a deny).
      if (ask && OUTWARD.has(risk) && typeof input.approval === "string" && cfg.approvedAct && await cfg.approvedAct({ id: input.approval, chain, action, resource }) === true) {
        ask = null; presence = "none"; obligations.push({ type: "once", grant: `approval:${input.approval}` });
      }

      // Is each obligation met by evidence the kernel holds? An unmet one makes the effect ask, not allow.
      // Binding evidence: the proof must cover the canonical input, so it is not reusable for another payload (K4 supplies the hash).
      const ctxEvidence = { decision, chain, action, resource, input_hash: input.input_hash };
      // A session stands for presence on admin and grant only when the chain is exactly one person: an assistant in the chain never inherits it.
      const sessionOk = !(risk === "admin" || risk === "grant") || isExactlyPerson(chain);
      const presenceMet = presence === "none" || (presence === "session" && sessionOk && (cfg.hasPresenceSession ? cfg.hasPresenceSession(chain) : false))
        || (input.presence && cfg.verifyPresence ? await cfg.verifyPresence(input.presence, ctxEvidence) === true : false);
      const out = [...obligations];
      if (presence !== "none") out.push({ type: "presence", method: presence });
      if (ask) out.push({ type: "ask", kind: ask.kind, approver: ask.approver, checker_must_be_person: true });
      // 7. Return. Approvals are K4's: an ask stays an ask until the kernel's task machinery records the approval.
      if (ask) return done("ask", tainted && !OUTWARD.has(risk) ? "tainted" : "needs_approval", used, out);
      if (!presenceMet) return done("ask", "needs_presence", used, out);
      return done("allow", "ok", used, out);
    } catch (e) {
      // Fail closed on anything unexpected: a deny that says only why in the log (invariant 1).
      if (e instanceof KernelError) return deny(e.code === "not_a_member" ? "not_a_member" : "bad_input");
      return deny("bad_input");
    }
  }

  /** One candidate grant against one hop: coverage, selector, kernel attributes, conditions, narrowing. */
  async function evaluate(/** @type {any} */ g, /** @type {any} */ h, /** @type {any} */ ms, /** @type {any} */ chain, /** @type {string} */ action, /** @type {string} */ resource, /** @type {any} */ attrs, /** @type {number} */ now, depth = 0, probe = false) {
    const subj = g.subject;
    const subjectOk = subj.kind === "actor" ? subj.actor.kind === h.actor.kind && subj.actor.id === h.actor.id && subj.actor.space === h.actor.space
      : subj.kind === "role" ? Boolean(ms && ms.role === subj.name) : false;
    if (!subjectOk) return { ok: false, reason: "no_grant" };
    let cov = null;
    for (const p of g.actions) { const c = patternCovers(p, action, since(action), g.action_set_version, riskOf(action)); if (c === "covered") { cov = c; break; } if (c) cov = c; }
    if (cov === null) return { ok: false, reason: "no_grant" };
    if (cov !== "covered") return { ok: false, reason: "pattern_not_covered" };
    if (!covers(g.resource.prefix, resource)) return { ok: false, reason: "no_grant" };
    // A type-level probe (input.probe) asks only what a grant carries for the type, to learn its field limits: row predicates are skipped, and the
    // answer is never an access decision for any row.
    for (const pr of probe ? [] : g.resource.where || []) {
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
      if (c.when.expires !== undefined && c.when.expires <= now) return { ok: false, reason: "expired" };
      if (c.when.not_before !== undefined && now < c.when.not_before) return { ok: false, reason: "no_grant" };
    }
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
      const pr = await evaluate({ ...parent, subject: subj }, h, ms, chain, action, resource, attrs, now, depth + 1, probe);
      if (!pr.ok) return pr;
      obs.push(...pr.obligations);
    }
    return { ok: true, obligations: obs };
  }

  return Object.freeze({ authorize, actions: reg });
}
