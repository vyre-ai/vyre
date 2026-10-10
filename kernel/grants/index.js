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
import { contains, containsDims, clampTo, patternCovers } from "../core/authorize.js";
import { ROLE_IDS, ROLE_DEMOTE_TO } from "../contracts/index.js";
import { ACCESS_LEVELS, SURFACE_GROUPS } from "../seal/uses.js";
import { ROLE_ACTIONS, MAY_SET } from "./roles.js";

/** The actions the grants calls register with the authorizer. All but `list` are risk `grant`. */
export const GRANT_ACTIONS = Object.freeze([
  { action: "grants.create", resource_type: "grant", risk: "grant", label: "give access", gloss: "Give a person or an assistant access to something." },
  { action: "grants.revoke", resource_type: "grant", risk: "grant", label: "take access away", gloss: "Remove access, and everything given from it." },
  { action: "grants.narrow", resource_type: "grant", risk: "grant", label: "reduce access", gloss: "Make an existing access smaller." },
  { action: "grants.role", resource_type: "grant", risk: "grant", label: "set the owner", gloss: "Make someone an owner, or hand ownership over." },
  // Giving a role below owner and registering an actor ride on the person's own authenticated call: Touch ID is for pairing, the vault and outward acts, not for who is in the Space (lead ruling 5 Oct).
  // Only an owner or an admin does either, and an admin sets only the roles below admin (MAY_SET); making an owner stays a presence act.
  { action: "grants.member", resource_type: "grant", risk: "admin", label: "change who is in the Space", gloss: "Make someone an admin, manager, member or temp, take a member or an assistant out, add an assistant or service, or give one access." },
  { action: "grants.offer", resource_type: "offer", risk: "grant", label: "offer a computer for work", gloss: "Let a Space's work run on a member's computer, or accept that on your own." },
  // Taking access away asks for no fresh proof, only the person's live session (risk "admin" = session presence): withdrawing can only reduce what a computer may do.
  { action: "grants.unoffer", resource_type: "offer", risk: "admin", label: "stop sharing a computer", gloss: "Withdraw an offer of a computer for work." },
  { action: "grants.invite", resource_type: "invite", risk: "grant", label: "invite someone", gloss: "Invite a person to join with a role." },
  // Moving a project to another of the person's Spaces on this home (kernel/gateway/moves.js): the move is approved once, where it starts; the receiving Space asks only the role.
  { action: "project.move_out", resource_type: "project", risk: "grant", label: "move a project to another space", gloss: "Start moving a project out of this Space. You approve once, for the whole move." },
  { action: "project.move_in", resource_type: "project", risk: "admin", label: "receive a moved project", gloss: "Accept a project moved here from another of your Spaces, after the approval given there." },
  { action: "project.move_finish", resource_type: "project", risk: "admin", label: "finish moving a project", gloss: "Say a project has fully arrived (here) or that its move is done and the original may be cleared (where it started), after the approval given at the start." },
  { action: "space.upgrade", resource_type: "space", risk: "grant", label: "move this space to My Cloud", gloss: "Carry your Personal space's records, chats and memory to your own server. You approve once, for the whole move." },
  { action: "space.upgrade_finish", resource_type: "space", risk: "admin", label: "finish moving to My Cloud", gloss: "Say the move to My Cloud is done and this space now points there." },
  { action: "records.import", resource_type: "record", risk: "admin", label: "bring records in with their ids", gloss: "Receive records moved from another space of yours, keeping their ids so links and chats still point at them." },
  { action: "grants.list", resource_type: "grant", risk: "read", label: "see who has access", gloss: "List access you may see." },
  // Standing rules for a Space (DESIGN-flows-joints 5a): an owner sets them with presence; they only ever tighten.
  { action: "rules.set", resource_type: "rule", risk: "grant", label: "set a standing rule", gloss: "Make a rule the whole Space must keep: never, draft only, or always ask." },
  { action: "rules.remove", resource_type: "rule", risk: "grant", label: "remove a standing rule", gloss: "Take a standing rule away." },
  { action: "rules.accept", resource_type: "rule", risk: "grant", label: "accept a proposed rule", gloss: "Make a proposed rule a standing rule." },
  { action: "rules.dismiss", resource_type: "rule", risk: "grant", label: "turn down a proposed rule", gloss: "Dismiss a proposed rule." },
  { action: "rules.propose", resource_type: "rule", risk: "write", label: "propose a standing rule", gloss: "Suggest a rule. It does nothing until an owner accepts it." },
  { action: "rules.list", resource_type: "rule", risk: "read", label: "see the standing rules", gloss: "List the rules of the Space and the proposals." },
  // Kits (kernel/flows/kits.js): an owner or admin may ask for a Kit (an assistant acting for them too, which is how the Engineer proposes); installing and removing one are admin acts of a person.
  { action: "kits.propose", resource_type: "kit", risk: "write", label: "ask to install a Kit", gloss: "Put a Kit's install card in front of an owner or admin. Nothing changes until they say yes." },
  { action: "kits.install", resource_type: "kit", risk: "admin", label: "install a Kit", gloss: "Add the types, fields, stages and Flows of a Kit." },
  { action: "kits.remove", resource_type: "kit", risk: "admin", label: "remove a Kit", gloss: "Take a Kit's parts out. Records stay." },
  // What a Flow's steps do (kernel/flows/runner.js, compile.js STEP_ACTIONS): run a Flow by hand, give someone a task, run a Code step in the sandbox, send text to a model through the door. Registered
  // here so the real authorizer knows them (an unregistered action answers unknown_action, which the Flow harness hid by registering its own).
  // Which agents may reach a Project's data (its files, sessions, memory). A person holds it by role; an AGENT holds it only by a grant of its own on that Project record. This replaces the
  // projects module's own access table: one permission system, the kernel's.
  { action: "project.reach", resource_type: "project", risk: "read", label: "reach a project", gloss: "Read a project's files, sessions and memory." },
  { action: "flows.run", resource_type: "flow", risk: "write", label: "run a Flow", gloss: "Start a Flow by hand." },
  { action: "flows.act-standing", resource_type: "flow-act", risk: "write", label: "send as a turned-on Flow", gloss: "What a Flow the person turned on may send by itself, within the limits they approved. Only a Flow run asks for it." },
  { action: "ask.request", resource_type: "task", risk: "write", label: "ask someone", gloss: "Give a person or an assistant a task from a Flow." },
  { action: "fn.run", resource_type: "fn", risk: "write", label: "run a Code step", gloss: "Run a small piece of code a Flow carries, confined, with no network and no files." },
  { action: "model.call", resource_type: "model", risk: "read", label: "ask a model", gloss: "Send text to an AI model through the Space's inference door. Sealed values go as placeholders." },
  { action: "rules.get", resource_type: "rule", risk: "read", label: "see one standing rule", gloss: "Read one rule or proposal in plain words." },
  { action: "rules.test", resource_type: "rule", risk: "read", label: "try a standing rule", gloss: "See what the rules would do to an act, without doing it." },
  { action: "rules.enable", resource_type: "rule", risk: "grant", label: "turn a standing rule on", gloss: "Make a rule you switched off bind again." },
  { action: "rules.disable", resource_type: "rule", risk: "grant", label: "turn a standing rule off", gloss: "Stop a rule binding without deleting it." },
].map(a => Object.freeze(a)));


/** The action a grant is gated under: an owner or an admin giving an assistant, a service or a surface access is `grants.member` (no fresh proof); everything else is `grants.create`. @param {any} input */
export const grantActionOf = input => (input && !input.parent && input.subject && ((input.subject.kind === "actor" && input.subject.actor && ["agent", "service", "automation"].includes(input.subject.actor.kind)) || (input.subject.kind === "group" && String(input.subject.id).startsWith("surface:"))) ? "grants.member" : "grants.create");

/** Does a resource match a rule's pattern: equal, or the pattern ends in `/*` and the resource is under it. @param {string} pattern @param {string} resource */
const urnMatches = (pattern, resource) => (pattern.endsWith("/*") ? resource === pattern.slice(0, -2) || resource.startsWith(pattern.slice(0, -1)) : pattern === resource);
const RULE_KINDS = new Set(["never", "draft_only", "always_ask"]);

/**
 * The shape of a rule, and nothing else: a kind, who it binds, what it covers by action (and, where it matters, by a resource pattern: a connector and route are urn segments),
 * the approver for an always-ask, and a plain label. No free text drives behaviour and no rule can grant anything. Rules never cover the rules calls themselves.
 * @param {any} r
 */
function checkRule(r) {
  const bad = (/** @type {string} */ m) => new KernelError("bad_input", m);
  if (!r || typeof r !== "object" || Array.isArray(r)) throw bad("a rule is an object");
  const allowed = new Set(["kind", "binds", "covers", "approver", "label"]);
  for (const k of Object.keys(r)) if (!allowed.has(k)) throw bad(`${k} is not part of a rule`);
  if (!RULE_KINDS.has(r.kind)) throw bad("a rule is never, draft_only or always_ask");
  if (!Array.isArray(r.binds) || !r.binds.length || r.binds.some((/** @type {any} */ b) => b !== "assistants" && b !== "members")) throw bad("a rule binds assistants, members, or both");
  const c = r.covers;
  if (!c || typeof c !== "object" || Object.keys(c).some(k => k !== "actions" && k !== "resource")) throw bad("a rule covers actions, and where it matters a resource pattern");
  if (!Array.isArray(c.actions) || !c.actions.length || c.actions.length > 50 || c.actions.some((/** @type {any} */ a) => typeof a !== "string" || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(a) || a.startsWith("rules."))) throw bad("name the actions the rule covers, exactly");
  if (c.resource !== undefined && (typeof c.resource !== "string" || !segments(c.resource.replace(/\/\*$/, "")))) throw bad("a resource pattern is a urn, ending in /* to cover what is under it");
  if (r.kind === "always_ask") {
    const a = r.approver;
    if (!a || typeof a !== "object" || (("person" in a) === ("role" in a)) || ("person" in a && (typeof a.person !== "string" || !a.person)) || ("role" in a && !ROLE_IDS.includes(a.role))) throw bad("an always-ask rule names who approves: a person or a role");
  } else if (r.approver !== undefined) throw bad("only an always-ask rule has an approver");
  if (typeof r.label !== "string" || !r.label.trim() || r.label.length > 120) throw bad("a rule has a plain label of up to 120 characters");
  return { kind: r.kind, binds: [...new Set(r.binds)].sort(), covers: { actions: [...new Set(c.actions)].sort(), ...(c.resource ? { resource: c.resource } : {}) }, ...(r.kind === "always_ask" ? { approver: "person" in r.approver ? { person: r.approver.person } : { role: r.approver.role } } : {}), label: r.label.trim() };
}

/** A rule in plain words, from its structured fields only. @param {any} r */
export function describeRule(r) {
  const who = r.binds.join(" and ");
  const what = r.covers.actions.join(", ") + (r.covers.resource ? ` on ${r.covers.resource}` : "");
  const kind = r.kind === "never" ? `Never, for ${who}: ${what}` : r.kind === "draft_only" ? `Draft only, for ${who}: ${what}` : `Always ask ${r.approver && r.approver.person ? `person ${r.approver.person}` : `the ${r.approver && r.approver.role}`}, for ${who}: ${what}`;
  return kind;
}

/** @param {any} rule @param {(a: string) => any} def */
function checkDraftable(rule, def) {
  if (rule.kind !== "draft_only") return;
  // A draft-only rule is only as good as the door that enforces it: it may cover only actions whose door says it prepares a draft instead of sending (`draftable`), never one that would just run.
  for (const a of rule.covers.actions) if (!def(a) || def(a).draftable !== true) throw new KernelError("bad_input", `${a} cannot be made draft only: its door does not prepare a draft instead of sending`);
}

/** The default assistant's id: the one agent that acts as a delegate of the person it works for (kernel/core/authorize.js). */
export const DEFAULT_ASSISTANT = "assistant";
/** What `manage` on a vault is, written once in kernel/seal/uses.js ACCESS_LEVELS; read here so the store makes the owner's grant without importing the seal. */
const VAULT_MANAGE_ACTIONS = ACCESS_LEVELS.manage;
const SUBJECT_KINDS = new Set(["actor", "role", "group"]);
/** The credential acts an assistant never holds, whoever gives them (the levels reveal and manage). */
const PERSON_ONLY_CREDENTIAL = new Set(["vault.reveal", "vault.edit", "vault.delete", "vault.share", "vault.rotate", "vault.run"]);
const MAX_DEPTH = 3;
// A chat's key ring (lib/chat-keys.js) rides in the chat's own events: `chat.created` carries the first, and a `chat.changed` that adds or removes a participant carries the one `addHolders` or
// `removeHolders` made on a device that holds the key, so the room's version and the ring's epoch change in one event. The kernel keeps wrapped material only (never a key) and checks the shape and
// the epoch, not the wraps (it cannot open them).
/** @param {any} r @param {string} id */
const ringOk = (r, id) => Boolean(r && typeof r === "object" && r.v === 1 && r.id === id && Number.isInteger(r.epoch) && r.epoch >= 1 && r.epochs && typeof r.epochs === "object" && r.names && typeof r.names === "object"
  && Object.keys(r.epochs).length >= 1 && Object.keys(r.epochs).length <= 1000 && JSON.stringify(r).length <= 512 * 1024);
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
  // The lender's network limit, ranked: `provider` is the tightest, `internet` next, none stated the loosest (CAP floor, R031-95 2.3).
  const capRank = (/** @type {string | null | undefined} */ c) => (c === "provider" ? 2 : c === "internet" ? 1 : 0);
  /**
   * The floor for one computer: the tightest limit ever signed on a member's acceptance of it (active or ended), counted from the last time the lender signed a loosening. It only tightens by itself:
   * a re-lend, a restart or an acceptance that states no limit never drops it; only a lend that carries `loosen` under the member's own proof (the proof binds the flag) starts the count again.
   */
  const capFloor = (/** @type {string} */ member, /** @type {string} */ device) => {
    const mine = [...offers.values()].filter(o => o.side === "member_accepts" && o.member === member && o.device === device).sort((a, b) => (a.at || 0) - (b.at || 0));
    let from = 0; mine.forEach((o, i) => { if (o.floor_reset) from = i; });
    /** @type {string | null} */ let cap = null; for (const o of mine.slice(from)) if (capRank(o.network_cap) > capRank(cap)) cap = o.network_cap;
    return cap;
  };
  /** @type {Map<string, { prefix: string, actions: string[] }[]>} what each first-party module may mint for others: its manifest's `needs.kernel.mints`, set at install */ const mints = new Map();
  /** @type {{ from: string, to: string } | null} the owner's adoption of the claimed identity, once (`owner.adopted`) */ let adopted = null;
  /** @type {Map<string, any>} standing rules of the Space (never, draft only, always ask) */ const rules = new Map();
  /** @type {Map<string, any>} rules a Kit proposed: no effect until an owner accepts */ const proposals = new Map();
  /** @type {Map<string, any>} teams: a name and the people in it; a grant to a team (subject kind group) reaches each of them, and their assistants by association */ const teams = new Map();
  /** @type {Map<string, any>} named vaults: a name, an owner, whether it is the owner's personal one; who may use what is in it is grants on the vault's URN */ const vaults = new Map();
  /** @type {Map<string, any>} chats: the people (and assistants) in a room, which is the audience a turn in it writes for and the readers of its stream */ const chats = new Map();
  /** @type {Set<(e: { id: string, side: string, member: string, device: string | null, reason: string }) => void>} */ const revokeListeners = new Set();
  const tell = (/** @type {any} */ o, /** @type {string} */ reason, /** @type {any} */ by) => { for (const f of revokeListeners) { try { f({ id: o.id, side: o.side, member: o.member, device: o.device, reason }, by); } catch { /* a listener never blocks a change */ } } };
  /** @type {{ gate: any, allowed: any, registry: () => Map<string, any> } | null} */ let bound = null;

  // A chain with a person in it is bound by the rules that name members; a chain with an assistant (an agent or an automation) in it by the rules that name assistants; an
  // assistant acting for a person is both, so it is bound by whichever of the two is stricter, never by the weaker only.
  const chainWho = (/** @type {any} */ chain) => /** @type {[boolean, boolean]} */ ([chain.hops.some((/** @type {any} */ h) => h.actor.kind === "person"), chain.hops.some((/** @type {any} */ h) => h.actor.kind === "agent" || h.actor.kind === "automation")]);
  const bindsWho = (/** @type {any} */ r, /** @type {boolean} */ member, /** @type {boolean} */ assistant) => (member && r.binds.includes("members")) || (assistant && r.binds.includes("assistants"));
  /**
   * What an admin may not make a rule do (DESIGN-spaces-first: an admin sets policies short of ownership). A rule that binds members binds the owner acting directly too, so over the acts that
   * change who has access or owns the Space (every grants call, restoring the drive, installing or removing a Kit) it could lock an owner out; only an owner may make one.
   * @param {any} issuer @param {any} rule
   */
  const lockout = (issuer, rule) => {
    if (roleOf(issuer) === "owner") return;
    if (rule.binds.includes("members") && rule.covers.actions.some((/** @type {string} */ a) => a.startsWith("grants.") || a === "drive.restore" || a.startsWith("kits."))) throw new KernelError("not_allowed", "only an owner makes a rule that binds members over who has access to the Space");
  };
  const matching = (/** @type {boolean} */ member, /** @type {boolean} */ assistant, /** @type {string} */ action, /** @type {string} */ resource) => [...rules.values()].filter(r => r.status === "active" && bindsWho(r, member, assistant) && r.covers.actions.includes(action) && (!r.covers.resource || urnMatches(r.covers.resource, resource)));

  /** Switch a rule off (it stays, binds nothing) or on again. An owner's act with presence, like every change to the rules. */
  async function switchRule(/** @type {any} */ chain, /** @type {string} */ id, /** @type {boolean} */ on, /** @type {{ presence?: any }} */ o = {}) {
    const issuer = person(chain);
    const action = on ? "rules.enable" : "rules.disable";
    const d = await gate(chain, action, urn("rule", String(id)), { id }, o.presence);
    if (!isAdmin(issuer)) throw new KernelError("not_allowed", `only an owner or an admin turns a standing rule ${on ? "on" : "off"}`);
    const r = rules.get(String(id));
    if (!r) throw new KernelError("not_found", "no such rule");
    const status = on ? "active" : "disabled";
    if (r.status === status) return r;
    const rec = freeze({ ...structuredClone(r), status });
    rules.set(rec.id, rec);
    await note(chain, on ? "rule.enabled" : "rule.disabled", urn("rule", rec.id), { id: rec.id, by: issuer.id }, d.decision);
    return rec;
  }

  const reg = () => (bound ? bound.registry() : new Map([...(cfg.actions ? cfg.actions() : [])].map(a => [a.action, a])));
  const since = (/** @type {string} */ a) => reg().get(a)?.since || 0;
  const riskOf = (/** @type {string} */ a) => reg().get(a)?.risk;
  const urn = (/** @type {string} */ type, id = "new") => `vyre://${cfg.space}/${type}/${id}`;
  const kernelChain = () => cfg.chains.fromFacts({ kind: "module", module: "grants", first_party: true });
  // K-3: the seal is the sealing process (or, for a development kernel with no sealing process, a local key). The store holds no key of its own.
  const seal = cfg.seal || createKernelSeal({ sealer: cfg.sealer, key: cfg.key });
  // Every event this store writes is sealed (one `kernel.mac` per event) and numbered on THIS store's own chain: `gseq` counts its events and `gprev` is the hash of the
  // seal of the one before. A genuine event copied and appended again later has an old `gseq`, so rebuild skips it: a revoked grant or a removed member cannot be replayed
  // back. (The log's own position cannot be the number: another writer appends between the MAC and the append now that the MAC is a round trip to the sealing process.)
  let gseq = 0, gprev = "genesis", queue = Promise.resolve();
  /** The number of the newest snapshot: a new one is written every SNAP_EVERY events so a boot reads a snapshot and a short tail, never the whole history. */
  let snapAt = 0;
  const SNAP_EVERY = cfg.snapshot_every ?? 500;
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

  /** Who is on a project: the people and agents holding `project.reach` on its record's address (an agent given every project holds it on `project/*`). Read from the grants, so a revoke ends it at once. @param {string} id */
  const projectMembers = id => {
    const out = { people: /** @type {string[]} */ ([]), agents: /** @type {string[]} */ ([]) };
    for (const g of grants.values()) if (g.status === "active" && g.subject.kind === "actor" && g.actions.includes("project.reach")) {
      const a = g.subject.actor;
      if (g.resource.prefix === urn("project", id) || (a.kind === "agent" && g.resource.prefix === urn("project", "*"))) (a.kind === "agent" ? out.agents : out.people).push(a.id);
    }
    return out;
  };
  /**
   * Is this actor in a team? A person is when the team lists them (and they are still a member of the Space). An assistant is by association: the person it acts for is in the chain, and
   * that person is in the team. The grant is then the team's, but an assistant's own authority is still cut by its person's (the chain is the intersection of every hop's grants) and by
   * what an assistant may hold at all (use, never reveal or manage: see evaluate in core/authorize.js).
   * @param {string} id @param {any} actor @param {any} [chain]
   */
  const inTeam = (id, actor, chain) => {
    if (typeof id === "string" && id.startsWith("surface:")) return Boolean(chain && Array.isArray(chain.hops)) && chain.hops.some((/** @type {any} */ x) => x.via && (/** @type {any} */ (SURFACE_GROUPS)[id.slice(8)] || []).includes(x.via.surface));
    // A project's people and assistants are a group too (`project:<id>`): "also let this project's members use it" is one grant to it.
    if (typeof id === "string" && id.startsWith("project:")) {
      const m = projectMembers(id.slice(8));
      if (!actor) return false;
      if (actor.kind === "person") return m.people.includes(actor.id) && memberOk(actor);
      if (actor.kind === "agent") return m.agents.includes(actor.id);
      return false;
    }
    const t = teams.get(id);
    if (!t || !actor) return false;
    if (actor.kind === "person") return t.members.includes(actor.id) && memberOk(actor);
    if (actor.kind === "agent" && chain && Array.isArray(chain.hops)) return chain.hops.some((/** @type {any} */ x) => x.actor.kind === "person" && t.members.includes(x.actor.id) && memberOk(x.actor));
    return false;
  };
  const members = Object.freeze({
    has: memberOk,
    membership: (/** @type {any} */ a) => (a && a.kind === "person" ? memberships.get(a.id) : undefined),
  });
  /** What `authorize` asks: active grants for this subject, by actor or by the role the person holds. */
  const provider = Object.freeze({
    forSubject: (/** @type {any} */ a, /** @type {any} */ _h, /** @type {any} */ input) => {
      const role = roleOf(a);
      const chain = input && input.chain;
      return [...grants.values()].filter(g => g.status === "active" && ((g.subject.kind === "actor" && sameActor(g.subject.actor, a)) || (g.subject.kind === "role" && role !== null && g.subject.name === role)
        || (g.subject.kind === "group" && inTeam(g.subject.id, a, chain))));
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
    // A team named by a grant exists. An assistant is given the credential actions of `use` and no more: showing, changing, deleting, sharing and rotating a credential are a person's.
    if (s.kind === "group" && !(teams.has(String(s.id)) || /^project:[A-Za-z0-9_-]{1,80}$/.test(String(s.id)) || (String(s.id).startsWith("surface:") && Object.hasOwn(SURFACE_GROUPS, String(s.id).slice(8))))) throw new KernelError("bad_input", "a grant to a team names a team, a project of this Space or a surface");
    if (s.kind === "actor" && s.actor.kind === "agent" && i.actions.some((/** @type {string} */ a) => PERSON_ONLY_CREDENTIAL.has(a))) throw new KernelError("bad_input", "an assistant can be given use of a credential, never to show, change, delete, share or rotate it");
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

  /** Grants the vault module made and may take back: its own sources, never the maker's `manage`. */
  const vaultMade = (/** @type {string} */ src) => (src.startsWith("vault:") ? src !== "vault:create" : /^install:[a-z0-9-]+:vault$/.test(src) || src.startsWith("publish:secret:"));
  /** Revoke a grant and everything handed on from it, noting each; the revoked grants, the first being `x`. */
  const killTree = async (/** @type {any} */ chain, /** @type {any} */ x, /** @type {any} */ reason, /** @type {any} */ decision) => {
    const out = [], why = String(reason || "").slice(0, 200);
    const kill = async (/** @type {any} */ y) => {
      if (y.status === "revoked") return;
      const n = freeze({ ...y, status: "revoked", revoked_at: clock(), reason: why });
      grants.set(n.id, n); out.push(n);
      await note(chain, "grant.revoked", urn("grant", n.id), { id: n.id, reason: why, ...(n.id !== x.id ? { because: x.id } : {}) }, decision);
      for (const c of [...grants.values()]) if (c.parent === n.id) await kill(c);
    };
    await kill(x);
    return out;
  };
  /** Keep a vault; a new one also gets its maker's `manage` and the right to hand any of it on (a share is a child of this grant: provably inside it), made by the kernel as a role's grants are, not by a proof. */
  const putVault = async (/** @type {any} */ chain, /** @type {any} */ me, /** @type {any} */ rec, /** @type {boolean} */ isNew) => {
    vaults.set(rec.id, rec);
    await note(chain, "vault.set", urn("vault", rec.id), { vault: rec });
    if (!isNew) return;
    const g = freeze({ id: `gr_${mintUuid(clock())}`, space: cfg.space, subject: { kind: "actor", actor: me }, actions: [...VAULT_MANAGE_ACTIONS], action_set_version: version, resource: { prefix: urn("vault", rec.id) }, conditions: { delegate: { allowed: true, max_depth: 2 } }, issuer: { ...me }, source: "vault:create", status: "active", created_at: clock() });
    grants.set(g.id, g);
    await note(chain, "grant.created", urn("grant", g.id), { grant: g });
  };
  /** The Space owner's personal vault, made the first time it is asked for: where the vault module's own items live (a person's, by their own session, is made with `vaultSet`). */
  const personalOf = async () => {
    const o = [...memberships.values()].find(m => m.role === "owner");
    if (!o) throw new KernelError("not_found", "this Space has no owner yet");
    const me = { kind: "person", id: o.person, space: cfg.space };
    let v = [...vaults.values()].find(x => x.personal && x.owner === o.person);
    if (!v) { v = freeze({ id: `vault_${mintUuid(clock())}`, space: cfg.space, name: "Personal", personal: true, owner: o.person, created: clock() }); await putVault(kernelChain(), me, v, true); }
    return v;
  };

  const api = {
    /** @param {any} chain @param {any} input @param {{ presence?: any }} [o] */
    async create(chain, input, o = {}) {
      validateInput(input);
      const issuer = person(chain);
      if (input.subject.kind === "group" && input.subject.id.startsWith("project:") && cfg.projectExists && !(await cfg.projectExists(input.subject.id.slice(8)))) throw new KernelError("bad_input", "a grant to a team names a team or a project of this Space");
      // Giving an assistant or a service access (a Project's reach, an agent-reach grant) rides on the person's own authenticated call like adding the actor does; a grant to a person or a role, and a delegation, keep their presence.
      // A holder of `grants.create` on a resource (a vault's manage) passes it on within that resource: the act is judged against what they hold there, not against the Space's grants. Anyone else
      // is judged on the Space's grants, so only an owner or an admin gives access, as before.
      const via = input.parent ? grants.get(input.parent) : undefined;
      const scope = via && via.status === "active" && Array.isArray(via.actions) && via.actions.includes("grants.create") && !via.resource.prefix.includes("*") ? via.resource.prefix : urn("grant");
      const d = await gate(chain, grantActionOf(input), scope, input, o.presence);
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
      return (await killTree(chain, g, reason, d.decision))[0] || g;
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
      if (!inside || !containsDims(g, next, since, riskOf)) throw new KernelError("not_contained", "narrowing may only make a grant smaller");
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
      const d = await gate(chain, m.role === "owner" ? "grants.role" : "grants.member", urn("member", m.person), m, o.presence);
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
      if (!t || typeof t.to !== "string" || !t.to || t.to === issuer.id || !ROLE_DEMOTE_TO.includes(demote)) throw new KernelError("bad_input", "name the member to hand the Space to, and the role you keep (admin, manager or member: a temp role needs a scope and an end date, which a hand-over does not carry)");
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
      const d = await gate(chain, "grants.member", urn("member", m.person), { remove: m.person }, o.presence);
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
      const d = await gate(chain, "grants.member", urn("member", actor.id), { actor }, o.presence);
      if (!isAdmin(issuer)) throw new KernelError("not_allowed", "only an owner or an admin adds an actor");
      actors.add(actorKey(actor));
      await note(chain, "actor.added", urn("member", actor.id), { actor }, d.decision);
      return freeze({ ...actor });
    },

    /**
     * Take an actor (an assistant, a service) out of the Space: an owner's or admin's act with the person's presence. It stops being a member, so nothing it holds is honoured and
     * a chain that carries it is refused. For the default assistant this is the Space's off switch: unnamed chats then say plainly that no assistant is available.
     * @param {any} chain @param {{ kind: string, id: string, space: string }} actor @param {{ presence?: any }} [o]
     */
    async removeActor(chain, actor, o = {}) {
      const issuer = person(chain);
      if (!actor || !["agent", "service", "automation"].includes(actor.kind) || actor.space !== cfg.space || typeof actor.id !== "string") throw new KernelError("bad_input", "an actor needs a kind, an id and this Space");
      const d = await gate(chain, "grants.member", urn("member", actor.id), { remove_actor: actor }, o.presence);
      if (!isAdmin(issuer)) throw new KernelError("not_allowed", "only an owner or an admin removes an actor");
      if (!actors.has(actorKey(actor))) throw new KernelError("not_found", "no such actor");
      actors.delete(actorKey(actor));
      await note(chain, "actor.removed", urn("member", actor.id), { actor }, d.decision);
      return true;
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
      if (o.network_cap !== undefined && (o.side !== "member_accepts" || !["provider", "internet"].includes(o.network_cap))) throw new KernelError("bad_input", "the lender's network cap is provider or internet, on the member's own acceptance");
      const d = await gate(chain, "grants.offer", urn("offer"), o, opt.presence);
      const m = { kind: "person", id: o.member, space: cfg.space };
      if (!memberOk(m)) throw new KernelError("not_found", "no such member");
      if (o.side === "space_allows" ? !isAdmin(issuer) : issuer.id !== o.member) throw new KernelError("not_allowed", o.side === "space_allows" ? "only an owner or an admin lets the Space's work run on a member's computer" : "only the member accepts work on their own computer");
      const rec = freeze({ id: `of_${mintUuid(clock())}`, space: cfg.space, side: o.side, offer: "compute", member: o.member, device: o.device ?? null, device_key: o.device_key ?? null, ...(o.side === "member_accepts" && o.network_cap ? { network_cap: o.network_cap } : {}), status: "active", made_by: issuer.id, at: clock() });
      offers.set(rec.id, rec);
      await note(chain, "offer.created", urn("offer", rec.id), { offer: rec }, d.decision);
      return rec;
    },

    /** Withdraw an offer. An admin withdraws the Space's side; the member withdraws their own acceptance. The runner is told at once. */
    async unoffer(chain, id, opt = {}) {
      const issuer = person(chain);
      const d = await gate(chain, "grants.unoffer", urn("offer", id), { revoke: id }, opt.presence);
      const o = offers.get(id);
      if (!o || o.status !== "active") throw new KernelError("not_found", "no such offer");
      if (o.side === "space_allows" ? !isAdmin(issuer) : issuer.id !== o.member) throw new KernelError("not_allowed", "that is not yours to withdraw");
      const n = freeze({ ...o, status: "revoked", revoked_at: clock(), ended_by: issuer.id });
      offers.set(id, n);
      await note(chain, "offer.revoked", urn("offer", id), { id, by: issuer.id }, d.decision);
      tell(n, "withdrawn", chain);
      return n;
    },


    /**
     * Lend one computer to this Space in ONE act (the first lend of a device, ruled 5 Oct): the Space's side (only when the caller is an owner or admin) and the member's own side, bound to the
     * computer's key, made under ONE presence proof that is bound to this compound input (member, device, key; the sides made follow from the caller's role). The proof covers nothing else and is spent
     * once. Withdrawing is `unlend`, which needs only the live session.
     * @param {any} chain @param {{ member: string, device: string, device_key: string, network_cap?: "provider" | "internet" | null, loosen?: true }} o @param {{ presence?: any }} [opt]
     * @returns {Promise<{ offers: any[] }>}
     */
    async lend(chain, o, opt = {}) {
      const issuer = person(chain);
      if (!o || typeof o.member !== "string" || typeof o.device !== "string" || !o.device || o.device.length > 200 || typeof o.device_key !== "string" || !o.device_key || o.device_key.length > 200) throw new KernelError("bad_input", "lending needs a member, a computer and its key");
      if (issuer.id !== o.member) throw new KernelError("not_allowed", "only the member lends their own computer");
      // The lender's network limit is part of what the member signs: stated as `provider` or `internet`, or NOT stated (null), and the proof binds exactly that (reviewer-2 CAP-1).
      if (o.network_cap !== undefined && o.network_cap !== null && !["provider", "internet"].includes(o.network_cap)) throw new KernelError("bad_input", "the lender's network limit is provider or internet");
      const stated = o.network_cap ?? null;
      const both = isAdmin(issuer);
      // A computer already lent with another limit is not silently kept at the old one: the member stops lending it and lends it again with the new limit, under a new proof (CAP-3).
      // A lend that states no limit inherits the floor this computer was ever lent with; only a limit stated looser than the floor is a loosening (ruled 10 Oct).
      const floor = capFloor(o.member, o.device), cap = stated === null ? floor : stated, loosens = stated !== null && capRank(stated) < capRank(floor);
      { const had = [...offers.values()].find(x => x.status === "active" && x.side === "member_accepts" && x.member === o.member && x.device === o.device);
        if (had && (had.network_cap ?? null) !== cap) throw new KernelError("not_allowed", "this computer is already lent with a different network limit: stop lending it, then lend it again with the new limit"); }
      if (o.loosen !== undefined && o.loosen !== true) throw new KernelError("bad_input", "loosen is true or left out");
      // The floor: a lend that states a looser limit than this computer was ever lent with says so (`loosen`), and the member's own act is the approval; an assistant's lend is a pair moment and takes the one yes.
      if (loosens && o.loosen !== true) throw new KernelError("not_allowed", `this computer was lent with a tighter network limit (${floor}) before: lend it again and confirm the looser one`);
      // The member's own earlier lend of this very computer that THEY ended is still their grant: turning it on again takes the live session, not a fresh proof. Anything else that ended it (an owner's off, a
      // removal, a role change) leaves no such record, so the next lend is a first grant and takes the proof again.
      const prior = [...offers.values()].filter(x => x.side === "member_accepts" && x.status === "revoked" && x.member === o.member && x.device === o.device && x.device_key === o.device_key).sort((a, b) => (b.revoked_at || 0) - (a.revoked_at || 0))[0];
      const resume = Boolean(prior && prior.ended_by === issuer.id);   // the member's own earlier lend of this computer: their live session is enough, a loosening they state included
      const d = await gate(chain, resume ? "grants.unoffer" : "grants.offer", urn("offer", "lend"), { lend: { member: o.member, device: o.device, device_key: o.device_key, network_cap: stated, ...(o.loosen ? { loosen: true } : {}) } }, opt.presence);
      if (!memberOk({ kind: "person", id: o.member, space: cfg.space })) throw new KernelError("not_found", "no such member");
      /** @type {any[]} */ const made = [];
      for (const side of both ? ["space_allows", "member_accepts"] : ["member_accepts"]) {
        const have = [...offers.values()].find(x => x.status === "active" && x.side === side && x.member === o.member && x.device === o.device);
        if (have) { made.push(have); continue; }
        const rec = freeze({ id: `of_${mintUuid(clock())}`, space: cfg.space, side, offer: "compute", member: o.member, device: o.device, device_key: side === "member_accepts" ? o.device_key : null, ...(side === "member_accepts" && cap ? { network_cap: cap } : {}), ...(side === "member_accepts" && loosens ? { floor_reset: true } : {}), status: "active", made_by: issuer.id, at: clock() });
        offers.set(rec.id, rec);
        await note(chain, "offer.created", urn("offer", rec.id), { offer: rec }, d.decision);
        made.push(rec);
      }
      return { offers: made };
    },

    /** Stop lending a computer: withdraws the caller's own side and, for an owner or admin, the Space's side too. Needs only the person's live session. @param {any} chain @param {{ member: string, device: string }} o @param {{ presence?: any }} [opt] */
    async unlend(chain, o, opt = {}) {
      const issuer = person(chain);
      if (!o || typeof o.member !== "string" || typeof o.device !== "string") throw new KernelError("bad_input", "name the member and the computer");
      // nothing lent for that computer: nothing to take away, and nothing to ask a person for
      if (![...offers.values()].some(x => x.status === "active" && x.member === o.member && x.device === o.device)) return { withdrawn: 0 };
      const d = await gate(chain, "grants.unoffer", urn("offer", "lend"), { unlend: { member: o.member, device: o.device } }, opt.presence);
      let n = 0;
      for (const x of [...offers.values()]) {
        if (x.status !== "active" || x.member !== o.member || x.device !== o.device) continue;
        if (x.side === "space_allows" ? !isAdmin(issuer) : issuer.id !== x.member && !isAdmin(issuer)) continue;
        const r = freeze({ ...x, status: "revoked", revoked_at: clock(), ended_by: issuer.id });
        offers.set(x.id, r);
        await note(chain, "offer.revoked", urn("offer", x.id), { id: x.id, by: issuer.id }, d.decision);
        tell(r, "withdrawn", chain);
        n++;
      }
      return { withdrawn: n };
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
    /** What the lender allows this member's computer to reach (`provider` or `internet`), from the member's own active acceptance; undefined when the acceptance names none (the Space's choice stands). */
    capOf(/** @type {{ member: string, device: string }} */ q) {
      // The tightest limit across every live acceptance for that computer: `provider` is tighter than `internet`, and an acceptance that states none never loosens one that does (CAP-2).
      // The floor counts even when no acceptance stands right now, so ending a lend and lending again never drops a limit the lender signed.
      return capFloor(q.member, q.device) ?? undefined;
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
    /**
     * Stop an invite at once: the one who made it, or a manager and above. A revoked invite is refused at accept as `not_found`, like any other that is not pending. One sealed event, `invite.revoked`.
     * @param {any} chain @param {string} id @param {{ presence?: any }} [o]
     */
    async inviteRevoke(chain, id, o = {}) {
      const me = person(chain);
      const inv = invites.get(id);
      const d = await gate(chain, "grants.invite", urn("invite", String(id)), { revoke: String(id) }, o.presence);
      const mine = roleOf(me);
      if (!inv || inv.status !== "pending" || !(sameActor(inv.issuer, me) || mine === "owner" || mine === "admin" || mine === "manager")) throw new KernelError("not_found", "no such invite");
      const n = freeze({ ...inv, status: "revoked", revoked_by: me.id, revoked_at: clock() });
      invites.set(id, n);
      await note(chain, "invite.revoked", urn("invite", id), { id, by: me.id }, d.decision);
      return n;
    },
    /**
     * The invites this person may see: their own, or every one for a manager and above. Each as the join card shows it, with its status, and never the hash or a link.
     * @param {any} chain
     */
    async inviteList(chain) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      if (!isExactlyPerson(chain)) throw new KernelError("not_found", "no such invite");
      const me = chain.hops[0].actor;
      if (!memberOk(me)) throw new KernelError("not_found", "no such invite");
      const mine = roleOf(me), all = mine === "owner" || mine === "admin" || mine === "manager";
      return [...invites.values()].filter(v => all || sameActor(v.issuer, me)).map(v => {
        const status = v.status === "pending" && !(v.valid_until > clock()) ? "expired" : v.status;
        return freeze({ id: v.id, role: v.role, scope: v.scope, expires: v.expires, invitee: v.invitee, needs_confirm: v.needs_confirm, confirmed: v.confirmed, valid_until: v.valid_until, status });
      });
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
      const why = await cfg.presence.check({ chain, op: "grant.accept", fields: { invite: id, hash: inv.hash, person: me.id }, proof: a.proof });
      if (why !== null) throw Object.assign(new KernelError("needs_presence", "accepting needs your confirmation on this device"), { detail: { reason: /^[a-z][a-z0-9_]{1,40}$/.test(String(why)) ? String(why) : "refused" } });
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
      mints.set(name, Array.isArray(needs.mints) ? needs.mints.filter((/** @type {any} */ e) => e && typeof e.prefix === "string" && Array.isArray(e.actions)).map((/** @type {any} */ e) => ({ prefix: e.prefix, actions: e.actions.map(String) })) : []);
      if (!actors.has(actorKey(actor))) { actors.add(actorKey(actor)); await note(k, "actor.added", urn("member", name), { actor }); }
      // What the module is given: `needs.grants` is a list of { prefix, actions } (each prefix its own actions, so a service can be narrowed to its own types); the older `actions` with `prefixes` gives every
      // prefix the same actions. A change to either replaces the module's grants.
      const entries = (Array.isArray(needs.grants) && needs.grants.length
        ? needs.grants.map((/** @type {any} */ e) => ({ prefix: `vyre://${cfg.space}/${e.prefix}`, actions: [...e.actions].sort() }))
        : (needs.prefixes && needs.prefixes.length ? needs.prefixes : ["*/*"]).map((/** @type {string} */ p) => ({ prefix: `vyre://${cfg.space}/${p}`, actions: [...needs.actions].sort() }))).sort((x, y) => (x.prefix < y.prefix ? -1 : 1));
      const mine = [...grants.values()].filter(g => g.status === "active" && g.source === `install:${name}`);
      const want = canonical(entries);
      if (mine.length && canonical(mine.map(g => ({ prefix: g.resource.prefix, actions: [...g.actions].sort() })).sort((x, y) => (x.prefix < y.prefix ? -1 : 1))) === want) return mine[mine.length - 1];
      for (const g of mine) { const n = freeze({ ...g, status: "revoked", revoked_at: clock(), reason: "reinstalled" }); grants.set(n.id, n); await note(k, "grant.revoked", urn("grant", n.id), { id: n.id, reason: "reinstalled" }); }
      let last;
      for (const e of entries) {
        last = freeze({ id: `gr_${mintUuid(clock())}`, space: cfg.space, subject: { kind: "actor", actor }, actions: [...e.actions], action_set_version: version, resource: { prefix: e.prefix }, conditions: {}, issuer: { kind: "service", id: "grants", space: cfg.space }, source: `install:${name}`, status: "active", created_at: clock() });
        grants.set(last.id, last);
        await note(k, "grant.created", urn("grant", last.id), { grant: last });
      }
      return last;
    },
    /**
     * What the vault module lends, made by the kernel for it after the person's yes at the Vault (no proof here, and no wider than these three shapes): an agent's login (`vault.fill` on one item at one exact origin), a module's
     * release (`vault.release` on one item, for a watcher or a project when named) an outside client's pass (`vault.read` and `vault.call` on one item, until an expiry, at a rate) the same for an agent or a project (a credential's older scope, carried over once), or an agent's lease of a Connection for one task (`task`, until its expiry). A row already made (same id) is skipped. @param {string} module @param {{ id: string, kind?: string, who: string, item: string, watcher?: string, project?: string, origin?: string, expires?: number | null, rate?: number }[]} rows
     */
    async carryOver(module, rows) {
      const k = kernelChain(), made = [], pv = await personalOf(), home = urn("vault", pv.id), NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
      for (const r of rows) {
        const reason = `carried:${String(r.id)}`, rel = r.kind === "release", pass = r.kind === "pass" || r.kind === "scope" || r.kind === "lease", grp = String(r.who).startsWith("project:"), actor = { kind: rel ? "service" : "agent", id: String(r.who), space: cfg.space };
        if (!NAME.test(String(r.item)) || (r.watcher && !NAME.test(String(r.watcher))) || (r.kind === "lease" && !/^[A-Za-z0-9_.-]{1,80}$/.test(String(r.task))) || (!rel && !pass && !/^https?:\/\/[^/]+$/.test(String(r.origin))) || (r.expires != null && !(r.expires > clock())) || [...grants.values()].some(g => g.reason === reason)) continue;
        if (!grp && !actors.has(actorKey(actor))) { actors.add(actorKey(actor)); await note(k, "actor.added", urn("member", actor.id), { actor }); }
        const resource = { prefix: r.kind === "lease" ? `${home}/connection/${r.item}` : rel && r.watcher ? `${home}/watcher/${r.watcher}/item/${r.item}` : `${home}/item/${r.item}`, ...(rel && r.project ? { where: [{ attr: "project", op: "eq", value: String(r.project) }] } : {}) };
        const g = freeze({ id: `gr_${mintUuid(clock())}`, space: cfg.space, subject: grp ? { kind: "group", id: String(r.who) } : { kind: "actor", actor }, actions: pass ? ["vault.read", "vault.call"] : [rel ? "vault.release" : "vault.fill"], action_set_version: version, resource, conditions: rel ? {} : { ...(pass ? { ...(r.rate ? { rate: { n: r.rate, per_seconds: 60 } } : {}) } : { where: { origins: [r.origin] } }), ...(r.expires != null ? { when: { expires: r.expires } } : {}) }, issuer: pass ? { kind: "person", id: pv.owner, space: cfg.space } : { kind: "service", id: module, space: cfg.space }, ...(pass ? { parent: [...grants.values()].find(x => x.status === "active" && x.source === "vault:create" && x.resource.prefix === home).id } : {}), source: rel ? `install:${r.who}:vault` : r.kind === "scope" ? "vault:scope" : r.kind === "lease" ? `vault:lease:${r.task}` : pass ? `vault:pass:${r.who}` : "vault:agent", reason, status: "active", created_at: clock() });
        grants.set(g.id, g); made.push(g.id);
        await note(k, "grant.created", urn("grant", g.id), { grant: g });
      }
      return made;
    },
    /** The vault module ending what it lent (by id, or all under an address), and what was handed on from it: only grants it made (`vault:` but not the maker's own `manage`). Taking access away needs no person. @param {{ id?: string, prefix?: string, reason?: string }} q */
    async takeBack(q) {
      const out = [], why = String(q.reason || "taken back");
      for (const g of [...grants.values()]) if (vaultMade(g.source) && (q.id ? g.id === q.id : q.source ? g.source === q.source : q.prefix && (g.resource.prefix === q.prefix || g.resource.prefix.startsWith(`${q.prefix}/`)))) out.push(...await killTree(kernelChain(), g, why));
      return out;
    },
    /**
     * A first-party module making a grant for someone else (a device it paired, a deployment's secret): only for the actions and under the address prefixes its signed manifest lists in `needs.kernel.mints`,
     * from a `source` of its own name, never wider; the kernel refuses anything else. The module checks its own person's yes before it calls. @param {string} module @param {{ subject: any, actions: string[], resource: { prefix: string }, conditions?: any, source: string, reason?: string }} i
     */
    async mint(module, i) {
      const acts = Array.isArray(i.actions) ? i.actions.map(String) : [], res = i.resource && i.resource.prefix, list = mints.get(module) || [];
      if (!acts.length || typeof res !== "string" || res.includes("*") || !String(i.source).startsWith(`${module}:`) || !list.some(e => acts.every(a => e.actions.includes(a)) && containedPrefix(res, `vyre://${cfg.space}/${e.prefix}`))) throw new KernelError("not_allowed", `${module} may not make that grant`);
      if (!i.subject || !["actor", "group"].includes(i.subject.kind)) throw new KernelError("bad_input", "a made grant has an actor or a group for its subject");
      const k = kernelChain(), actor = i.subject.actor;
      if (actor && !actors.has(actorKey(actor))) { actors.add(actorKey(actor)); await note(k, "actor.added", urn("member", actor.id), { actor }); }
      const g = freeze({ id: `gr_${mintUuid(clock())}`, space: cfg.space, subject: i.subject, actions: acts, action_set_version: version, resource: i.resource, conditions: i.conditions || {}, issuer: { kind: "service", id: module, space: cfg.space }, source: i.source, ...(i.reason ? { reason: String(i.reason).slice(0, 200) } : {}), status: "active", created_at: clock() });
      grants.set(g.id, g); await note(k, "grant.created", urn("grant", g.id), { grant: g });
      return g.id;
    },
    /** A module reading, live, the grants it made whose source starts with `source`. @param {string} module @param {string} source */
    minted: (module, source) => [...grants.values()].filter(g => g.status === "active" && g.source.startsWith(`${module}:`) && g.source.startsWith(source) && !(g.conditions && g.conditions.when && g.conditions.when.expires <= clock())),
    /** A module ending grants it made (by id, or by `source`): only those whose source carries its name. @param {string} module @param {{ id?: string, source?: string, reason?: string }} q */
    async unmint(module, q) {
      const out = [];
      for (const g of [...grants.values()]) if (g.source.startsWith(`${module}:`) && (q.id ? g.id === q.id : q.source && g.source === q.source)) out.push(...await killTree(kernelChain(), g, String(q.reason || "taken back")));
      return out;
    },
    personalVault: async () => (await personalOf()).id,
    /** The vault module reading its own live grants under an address. @param {string} prefix */
    grantsOn: prefix => [...grants.values()].filter(g => g.status === "active" && vaultMade(g.source) && g.resource.prefix.startsWith(prefix)),

    /**
     * The home's claimed identity becomes THE owner, once. The Space has one owner (its first, a local id); when the person claims an identity, that identity's id takes the owner's place: the old
     * owner's grants are revoked and the owner role grants made again for the identity, each as an ordinary sealed event, so a rebuild reaches the same state. `owner.adopted` is written FIRST
     * and is the once-marker the rebuild reads (a snapshot carries it): any other `to` afterwards is refused `already_adopted`. A crash after the marker leaves the owner moved only in part; the next call
     * with the same `to` (the kernel makes it at boot) finishes the move, so the Space repairs itself. `owner.changed` closes it, naming from and to. The first adoption needs no presence (the person
     * claiming is the first person there is, and boot adoption has none to ask); a different identity later is never adopted, with or without a proof.
     * @param {string} to @returns {Promise<{ owner: string, previous: string, changed: boolean }>}
     */
    async adoptOwner(to, expectedFrom) {
      if (typeof to !== "string" || !/^per_[a-z2-7]{26}$/.test(to)) throw new KernelError("bad_input", "an owner is a person id");
      // HA-1 (reviewer-2): the call names the owner it replaces, and the Space refuses unless that is exactly its owner now: a Space someone else owns is never taken, whoever asks. A finished or
      // half-finished adoption (the `owner.adopted` marker, which is sealed in the log) is resumed by the same `to` alone.
      if (!adopted && (typeof expectedFrom !== "string" || !/^per_[a-z2-7]{26}$|^per_[a-z0-9]{1,40}$/.test(expectedFrom))) throw new KernelError("bad_input", "name the owner being replaced");
      if (adopted && adopted.to !== to) throw new KernelError("already_adopted", "this Space's owner already took the claimed identity");
      const owners = [...memberships.values()].filter(m => m.role === "owner").map(m => m.person);
      const from = adopted ? adopted.from : owners.length === 1 ? owners[0] : null;
      if (!from) throw new KernelError("not_allowed", "this Space has no single owner to replace");
      if (from === to) return { owner: to, previous: from, changed: false };
      if (adopted && memberships.get(to)?.role === "owner" && !memberships.has(from) && [...grants.values()].every(g => !(g.status === "active" && g.subject.kind === "actor" && g.subject.actor.kind === "person" && g.subject.actor.id === from))) return { owner: to, previous: from, changed: false };
      const prior = memberships.get(from);
      if (!adopted && (!prior || prior.role !== "owner")) throw new KernelError("not_allowed", "only the Space's owner can be replaced this way");
      if (!adopted && from !== expectedFrom) throw new KernelError("not_allowed", "that is not this Space's owner: it is not taken over");
      const k = kernelChain();
      if (!adopted) { await note(k, "owner.adopted", urn("member", to), { from, to }); adopted = freeze({ from, to }); }
      for (const g of [...grants.values()]) if (g.status === "active" && g.subject.kind === "actor" && g.subject.actor.kind === "person" && g.subject.actor.id === from) {
        const n = freeze({ ...g, status: "revoked", revoked_at: clock(), reason: "owner adopted the claimed identity" }); grants.set(n.id, n);
        await note(k, "grant.revoked", urn("grant", n.id), { id: n.id, reason: "owner adopted the claimed identity" });
      }
      if (memberships.has(from)) { memberships.delete(from); await note(k, "member.removed", urn("member", from), { person: from }); }
      if (memberships.get(to)?.role !== "owner") {
        const membership = freeze({ space: cfg.space, person: to, role: "owner", added_by: "kernel", added_at: clock() });
        memberships.set(to, membership);
        await note(k, "member.set", urn("member", to), { membership });
      }
      if (![...grants.values()].some(g => g.status === "active" && g.source === "role:owner" && g.subject.kind === "actor" && g.subject.actor.kind === "person" && g.subject.actor.id === to)) {
        const g = freeze({ id: `gr_${mintUuid(clock())}`, space: cfg.space, subject: { kind: "actor", actor: { kind: "person", id: to, space: cfg.space } }, actions: [...ROLE_ACTIONS.owner], action_set_version: version, resource: { prefix: `vyre://${cfg.space}/*/*` }, conditions: { delegate: { allowed: true, max_depth: 2 } }, issuer: { kind: "service", id: "grants", space: cfg.space }, source: "role:owner", status: "active", created_at: clock() });
        grants.set(g.id, g);
        await note(k, "grant.created", urn("grant", g.id), { grant: g });
      }
      // The owner's rooms: the identity takes the old id's place in each, as an ordinary chat change (a new version; messages written before it still go to the same person, see chatPeopleAt).
      for (const c of [...chats.values()]) if (c.people.includes(from)) {
        const people = [...new Set(c.people.map((/** @type {string} */ x) => (x === from ? to : x)))];
        const ver = (c.ver || 1) + 1;
        const n = freeze({ ...c, people, ver, h: [...(c.h || [{ ver: c.ver || 1, people: c.people }]), { ver, people: [...people] }].slice(-HISTORY) });
        chats.set(c.id, n);
        await note(k, "chat.changed", urn("chat", c.id), { id: c.id, people: n.people, assistants: n.assistants, ver, joined: people.includes(to) && !c.people.includes(to) ? [to] : [], left: [from] }, null);
      }
      await note(k, "owner.changed", urn("member", to), { owner_change: { op: "adopt", person: to, from, by: "kernel", space: cfg.space } }, null, "space");
      return { owner: to, previous: from, changed: true };
    },
    /** The adoption the log records, or null: `{ from, to }`. The kernel reads it at boot to take the owner from the log, and to finish a move a crash cut short. */
    adopted() { return adopted; },
    /** A person id as the Space knows them now: the owner it replaced is the identity that replaced them, so what was keyed by the old id still belongs to its person. @param {string} id */
    canonicalPerson(id) { return adopted && id === adopted.from ? adopted.to : id; },

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
      // The default assistant (user ruling 4 Oct 2026): a DELEGATE. Every session token carries a model hop, and a thread with no named assistant runs as this one. It is an actor of
      // every new Space from its start and holds NO grant of its own: alone it can do nothing, and acting for a person (a chain of that person and this agent) it may do whatever
      // that person may (kernel/core/authorize.js treats it as a pass-through hop), minus what an assistant never does: a grant or role change (model chain), anything that needs
      // presence the person has not given, and chat membership. Anything that leaves the Space raises a task. A Space that already exists gets the actor only by an owner's
      // approval with presence (`addActor`), never silently.
      const dflt = freeze({ kind: "agent", id: DEFAULT_ASSISTANT, space: cfg.space });
      actors.add(actorKey(dflt));
      await note(k, "actor.added", urn("member", dflt.id), { actor: dflt });
      return membership;
    },

    // ---- standing rules (DESIGN-flows-joints 5a) ----
    // A rule belongs to the Space, is set by an owner with a fresh presence proof, and is an event in the sealed log. It only tightens: `authorize` asks `rulesFor` BEFORE grants,
    // a `never` refuses, an `always_ask` makes the act wait for the named approver whatever any grant says, a `draft_only` allows only a draft; no rule ever allows anything.
    /** The rules that bind this chain for this action and resource, in the order they were made. @param {any} chain @param {string} action @param {string} resource */
    rulesFor(chain, action, resource) {
      if (!rules.size || !isChain(chain)) return [];
      return matching(...chainWho(chain), action, resource);
    },
    /** Is any active standing rule bound to this chain for this action, whatever resource it names? (A caller that totals rows needs to know no rule could treat two rows differently.) @param {any} chain @param {string} action */
    rulesTouch(chain, action) {
      if (!rules.size || !isChain(chain)) return false;
      const [member, assistant] = chainWho(chain);
      return [...rules.values()].some(r => r.status === "active" && bindsWho(r, member, assistant) && r.covers.actions.includes(action));
    },
    /** The rules and the proposals, for a manager and above. @param {any} chain */
    async rulesList(chain) {
      reader(chain);
      await bound.gate(chain, "rules.list", urn("rule", "*"));
      // The view an owner reads is built from the rule's structured fields (kind, who it binds, the actions, the resource, the approver), never from the label a proposer wrote.
      const viewed = (/** @type {any} */ r) => ({ ...r, view: describeRule(r) });
      return { rules: [...rules.values()].map(viewed), proposals: [...proposals.values()].map(viewed) };
    },
    /** @param {any} chain @param {any} r @param {{ presence?: any }} [o] */
    async ruleSet(chain, r, o = {}) {
      const issuer = person(chain);
      const rule = checkRule(r);
      checkDraftable(rule, a => reg().get(a));
      lockout(issuer, rule);
      const d = await gate(chain, "rules.set", urn("rule"), rule, o.presence);
      if (!isAdmin(issuer)) throw new KernelError("not_allowed", "only an owner or an admin sets a standing rule");
      const rec = freeze({ id: `rule_${mintUuid(clock())}`, space: cfg.space, ...rule, status: "active", by: issuer.id, at: clock() });
      rules.set(rec.id, rec);
      await note(chain, "rule.set", urn("rule", rec.id), { rule: rec }, d.decision);
      return rec;
    },
    /**
     * Make a team or change one (team/0.3.1/DESIGN-one-grant.md): a name and the people in it. A grant to a team (subject `{ kind: "group", id }`) reaches each person in it, and their assistants by
     * association. An owner or an admin does it, on their own session, like any change to who is in the Space. Every member of a team is a member of the Space.
     * @param {any} chain @param {{ id?: string, name?: string, members?: string[] }} t @param {{ presence?: any }} [o]
     */
    async teamSet(chain, t, o = {}) {
      const issuer = person(chain);
      if (!t || typeof t !== "object") throw new KernelError("bad_input", "a team needs a name and its people");
      const prior = t.id !== undefined ? teams.get(String(t.id)) : undefined;
      if (t.id !== undefined && !prior) throw new KernelError("not_found", "no such team");
      const d = await gate(chain, "grants.member", urn("team", prior ? prior.id : "new"), { team: t }, o.presence);
      if (!isAdmin(issuer)) throw new KernelError("not_allowed", "only an owner or an admin makes or changes a team");
      const name = String(t.name !== undefined ? t.name : prior ? prior.name : "").trim();
      if (!name || name.length > 60) throw new KernelError("bad_input", "a team has a name of up to 60 characters");
      const list = t.members !== undefined ? t.members : prior ? prior.members : [];
      if (!Array.isArray(list) || list.length > 200 || list.some((/** @type {any} */ m) => typeof m !== "string" || !memberships.has(m))) throw new KernelError("bad_input", "a team holds up to 200 people, each a member of this Space");
      if ([...teams.values()].some(x => x.name.toLowerCase() === name.toLowerCase() && (!prior || x.id !== prior.id))) throw new KernelError("exists", "a team with that name already exists");
      if (!prior && teams.size >= 200) throw new KernelError("bad_input", "a Space holds up to 200 teams");
      const rec = freeze({ id: prior ? prior.id : `team_${mintUuid(clock())}`, space: cfg.space, name, members: freeze([...new Set(list)].sort()), by: issuer.id, at: clock() });
      teams.set(rec.id, rec);
      await note(chain, "team.set", urn("team", rec.id), { team: rec }, d.decision);
      return rec;
    },
    /** Remove a team. Grants made to it stay on record and reach no one. @param {any} chain @param {string} id @param {{ presence?: any }} [o] */
    async teamRemove(chain, id, o = {}) {
      const issuer = person(chain);
      const d = await gate(chain, "grants.member", urn("team", String(id)), { remove: id }, o.presence);
      if (!isAdmin(issuer)) throw new KernelError("not_allowed", "only an owner or an admin removes a team");
      if (!teams.has(String(id))) throw new KernelError("not_found", "no such team");
      teams.delete(String(id));
      await note(chain, "team.removed", urn("team", String(id)), { id: String(id), by: issuer.id }, d.decision);
      return { removed: String(id) };
    },
    /** The teams a person may see: a manager and above all of them, anyone else only their own. @param {any} chain */
    teamList(chain) {
      const me = reader(chain);
      const r = roleOf(me);
      const all = r === "owner" || r === "admin" || r === "manager";
      return [...teams.values()].filter(t => all || t.members.includes(me.id)).sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    /**
     * Make a named vault, or rename one (team/0.3.1/DESIGN-one-grant.md): a name and an owner. Any member may make one; the maker is its owner and holds `manage` on it, with the right to
     * pass any of that on. Nobody else sees it until it is shared, and a personal vault (one per person) is not shown to anyone else, an admin included. What is inside is used through grants on
     * the vault's URN (`vyre://<space>/vault/<id>`), never through a table of its own.
     * @param {any} chain @param {{ id?: string, name?: string, personal?: boolean }} v
     */
    async vaultSet(chain, v) {
      const me = reader(chain);
      if (!v || typeof v !== "object") throw new KernelError("bad_input", "a vault needs a name");
      const prior = v.id !== undefined ? vaults.get(String(v.id)) : undefined;
      if (v.id !== undefined && !prior) throw new KernelError("not_found", "no such vault");
      if (prior && prior.owner !== me.id && !(isAdmin(me) && !prior.personal)) throw new KernelError("not_found", "no such vault");
      const name = String(v.name !== undefined ? v.name : prior ? prior.name : "").trim();
      if (!name || name.length > 60) throw new KernelError("bad_input", "a vault has a name of up to 60 characters");
      const owner = prior ? prior.owner : me.id;
      if ([...vaults.values()].some(x => x.owner === owner && x.name.toLowerCase() === name.toLowerCase() && (!prior || x.id !== prior.id))) throw new KernelError("exists", "you already have a vault with that name");
      const personal = prior ? prior.personal : v.personal === true;
      if (!prior && personal && [...vaults.values()].some(x => x.owner === owner && x.personal)) throw new KernelError("exists", "you already have a personal vault");
      if (!prior && vaults.size >= 1000) throw new KernelError("bad_input", "a Space holds up to 1000 vaults");
      const rec = freeze({ id: prior ? prior.id : `vault_${mintUuid(clock())}`, space: cfg.space, name, personal, owner, created: prior ? prior.created : clock() });
      await putVault(chain, me, rec, !prior);
      return rec;
    },
    /** Remove a vault and take back every grant on it. Its owner (or an admin, for a shared one) does it. @param {any} chain @param {string} id */
    async vaultRemove(chain, id) {
      const me = reader(chain);
      const v = vaults.get(String(id));
      if (!v || (v.owner !== me.id && !(isAdmin(me) && !v.personal))) throw new KernelError("not_found", "no such vault");
      vaults.delete(v.id);
      await note(chain, "vault.removed", urn("vault", v.id), { id: v.id, by: me.id });
      for (const g of [...grants.values()]) if (g.status === "active" && (g.resource.prefix === urn("vault", v.id) || g.resource.prefix.startsWith(`${urn("vault", v.id)}/`))) {
        const r = freeze({ ...g, status: "revoked", revoked_at: clock(), reason: "the vault was removed" });
        grants.set(g.id, r);
        await note(chain, "grant.revoked", urn("grant", g.id), { id: g.id, reason: "the vault was removed" });
      }
      return { removed: v.id };
    },
    /** The vaults this person may see: their own, and any they hold a grant on (directly or through a team). A personal vault is its owner's alone. @param {any} chain */
    vaultList(chain) {
      const me = reader(chain);
      const mine = provider.forSubject(me, undefined, { chain });
      return [...vaults.values()].filter(v => v.owner === me.id || (!v.personal && mine.some(g => g.resource.prefix === urn("vault", v.id) || g.resource.prefix.startsWith(`${urn("vault", v.id)}/`)))).sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    /** Is this actor in this team (kernel-internal: the authorizer's group check). @param {string} id @param {any} actor @param {any} [chain] */
    inTeam,
    /** @param {any} chain @param {string} id @param {{ presence?: any }} [o] */
    async ruleRemove(chain, id, o = {}) {
      const issuer = person(chain);
      const d = await gate(chain, "rules.remove", urn("rule", String(id)), { id }, o.presence);
      if (!isAdmin(issuer)) throw new KernelError("not_allowed", "only an owner or an admin removes a standing rule");
      if (!rules.has(String(id))) throw new KernelError("not_found", "no such rule");
      rules.delete(String(id));
      await note(chain, "rule.removed", urn("rule", String(id)), { id: String(id), by: issuer.id }, d.decision);
      return { removed: String(id) };
    },
    /** A Kit (or anyone holding `rules.propose`) suggests a rule: it is kept, and does nothing until an owner accepts it. @param {any} chain @param {any} r */
    async rulePropose(chain, r) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      if (!bound) throw new KernelError("unavailable", "the grants store is not bound to an authorizer");
      const rule = checkRule(r);
      checkDraftable(rule, a => reg().get(a));
      const d = await bound.gate(chain, "rules.propose", urn("rule", "new"));
      if (proposals.size >= 200) throw new KernelError("bad_input", "too many proposals wait for an owner");
      const last = chain.hops[chain.hops.length - 1].actor;
      // One proposer cannot fill the queue: a Kit or a person may have a few waiting at once.
      if ([...proposals.values()].filter(x => x.by.kind === last.kind && x.by.id === last.id).length >= 20) throw new KernelError("bad_input", "this proposer already has 20 proposals waiting for an owner");
      const rec = freeze({ id: `prop_${mintUuid(clock())}`, space: cfg.space, ...rule, by: { kind: last.kind, id: last.id }, at: clock() });
      proposals.set(rec.id, rec);
      await note(chain, "rule.proposed", urn("rule", rec.id), { proposal: rec }, d.decision);
      return rec;
    },
    /** The owner accepts a proposal, with presence: it becomes a standing rule exactly as proposed. @param {any} chain @param {string} id @param {{ presence?: any }} [o] */
    async ruleAccept(chain, id, o = {}) {
      const issuer = person(chain);
      const p = proposals.get(String(id));
      if (p) lockout(issuer, p);
      const d = await gate(chain, "rules.accept", urn("rule", String(id)), { id }, o.presence);
      if (!isAdmin(issuer)) throw new KernelError("not_allowed", "only an owner or an admin accepts a proposed rule");
      if (!p) throw new KernelError("not_found", "no such proposal");
      const { by: _by, at: _at, id: _id, space: _sp, ...rule } = p;
      const rec = freeze({ id: `rule_${mintUuid(clock())}`, space: cfg.space, ...rule, status: "active", by: issuer.id, at: clock(), proposed_by: p.by });
      proposals.delete(p.id);
      rules.set(rec.id, rec);
      await note(chain, "rule.set", urn("rule", rec.id), { rule: rec, from: p.id }, d.decision);
      return rec;
    },
    /** @param {any} chain @param {string} id @param {{ presence?: any }} [o] */
    async ruleDismiss(chain, id, o = {}) {
      const issuer = person(chain);
      const d = await gate(chain, "rules.dismiss", urn("rule", String(id)), { id }, o.presence);
      if (!isAdmin(issuer)) throw new KernelError("not_allowed", "only an owner or an admin turns down a proposed rule");
      if (!proposals.has(String(id))) throw new KernelError("not_found", "no such proposal");
      proposals.delete(String(id));
      await note(chain, "rule.dismissed", urn("rule", String(id)), { id: String(id), by: issuer.id }, d.decision);
      return { dismissed: String(id) };
    },

    /** One rule or proposal in plain words, for a manager and above. @param {any} chain @param {string} id */
    async ruleGet(chain, id) {
      reader(chain);
      await bound.gate(chain, "rules.get", urn("rule", String(id)));
      const r = rules.get(String(id)) || proposals.get(String(id));
      if (!r) throw new KernelError("not_found", "no such rule");
      return { ...r, view: describeRule(r) };
    },
    /**
     * What the rules would do to an act, without doing it. `as` is who the act is by (an assistant, a member, or an assistant acting for a member, which both kinds of rule bind),
     * `action` and `resource` the act. `id` tries one stored rule (on or off) alone; `rule` tries a rule nobody has set yet, together with the ones in force. Nothing is written.
     * The outcome is the strictest kind that binds: never, then always_ask, then draft_only, else none.
     * @param {any} chain @param {{ as?: string, action?: string, resource?: string, id?: string, rule?: any }} [probe]
     */
    async ruleTest(chain, probe = {}) {
      reader(chain);
      await bound.gate(chain, "rules.test", urn("rule", "*"));
      const p = probe || {};
      const as = p.as === undefined ? "assistant" : p.as;
      if (!["assistant", "member", "assistant_for_member"].includes(as)) throw new KernelError("bad_input", "as is assistant, member or assistant_for_member");
      if (typeof p.action !== "string" || !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(p.action)) throw new KernelError("bad_input", "name the action to try, exactly");
      if (p.resource !== undefined && (typeof p.resource !== "string" || !segments(p.resource) || spaceOf(p.resource) !== cfg.space)) throw new KernelError("bad_input", "a resource is a urn in this Space");
      if (p.id !== undefined && p.rule !== undefined) throw new KernelError("bad_input", "try a stored rule or a new one, not both");
      const member = as !== "assistant", assistant = as !== "member";
      const resource = p.resource || "";
      /** @type {any[]} */ let pool;
      if (p.id !== undefined) {
        const r = rules.get(String(p.id));
        if (!r) throw new KernelError("not_found", "no such rule");
        pool = [r];
      } else {
        pool = [...rules.values()].filter(r => r.status === "active");
        if (p.rule !== undefined) { const c = checkRule(p.rule); checkDraftable(c, a => reg().get(a)); pool.push({ ...c, id: null, status: "candidate" }); }
      }
      const hit = pool.filter(r => bindsWho(r, member, assistant) && r.covers.actions.includes(p.action) && (!r.covers.resource || (resource !== "" && urnMatches(r.covers.resource, resource))));
      const rank = { never: 3, always_ask: 2, draft_only: 1 };
      const outcome = hit.reduce((/** @type {string} */ o, r) => (rank[/** @type {"never"} */ (r.kind)] > (rank[/** @type {"never"} */ (o)] || 0) ? r.kind : o), "none");
      return { outcome, binds: hit.map(r => ({ id: r.id, kind: r.kind, label: r.label, status: r.status, view: describeRule(r) })), note: p.id !== undefined && hit.length === 0 ? "that rule does not bind this act" : undefined };
    },
    /** @param {any} chain @param {string} id @param {{ presence?: any }} [o] */
    ruleEnable(chain, id, o = {}) { return switchRule(chain, id, true, o); },
    /** @param {any} chain @param {string} id @param {{ presence?: any }} [o] */
    ruleDisable(chain, id, o = {}) { return switchRule(chain, id, false, o); },

    // ---- chats: who is in a room (the kernel's own list, never a module's) ----
    // A chat is a list of people and assistants. The kernel keeps it because three decisions depend on it and none may be a module's word: who may READ the chat's stream
    // (its participants only: an owner or admin outside it is refused; an assistant reads only chats the person it acts for is in), who is in the AUDIENCE of a turn an
    // assistant writes (every person in the room, asker included), and who may change the list (a person in it). Every call here takes a kernel-built chain.
    /** @param {any} chain @param {{ people?: string[], assistants?: string[], id?: string, ring?: any }} [o] */
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
      if (o.ring !== undefined && !ringOk(o.ring, id)) throw new KernelError("bad_input", "a chat's ring is the document the creator's device made for this chat id");
      const rec = freeze({ id, space: cfg.space, people, assistants, made_by: p.id, at: clock(), ver: 1, h: [{ ver: 1, people: [...people] }], ...(o.ring !== undefined ? { ring: structuredClone(o.ring) } : {}) });
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
      // A chat with a ring changes its people only together with its ring: someone added needs a wrap of the key, someone removed needs the key rotated to a higher epoch.
      const ring = change.ring;
      if (c.ring && (joined.length || left.length)) {
        if (!ringOk(ring, c.id)) throw new KernelError("bad_input", "adding or removing someone changes the chat's ring too: send the ring the change made");
        if (left.length && !(ring.epoch > c.ring.epoch)) throw new KernelError("bad_input", "removing someone rotates the chat's key to a new epoch");
        if (ring.epoch < c.ring.epoch) throw new KernelError("bad_input", "the ring's epoch does not go back");
      } else if (ring !== undefined) throw new KernelError("bad_input", "a ring comes with a change of people, on a chat that has one");
      const n = freeze({ ...c, people: [...people], assistants: [...assistants], ver, h: [...(c.h || [{ ver: c.ver || 1, people: c.people }]), { ver, people: [...people] }].slice(-HISTORY), ...(ring !== undefined ? { ring: structuredClone(ring) } : {}) });
      chats.set(c.id, n);
      await note(chain, "chat.changed", urn("chat", c.id), { id: c.id, people: n.people, assistants: n.assistants, ver, joined, left, ...(ring !== undefined ? { ring: structuredClone(ring) } : {}) }, null);
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
      if (!c || !shape || !memberOk(who) || !c.people.includes(who.id) || (agent && agent.id !== DEFAULT_ASSISTANT && !String(agent.id).startsWith("model:") && !c.assistants.includes(agent.id))) throw new KernelError("not_found", "no such chat");
      // MS-1: a model slot belongs to ONE chat (its token's room): it reads that chat and no other, even a chat its person is also in.
      if (agent && String(agent.id).startsWith("model:") && (!chain.room || chain.room.chat !== String(id))) throw new KernelError("not_found", "no such chat");
      return c;
    },
    /** The epoch of a chat's key ring, or 0 when it keeps its folders in the clear (no ring). Sync and kernel-internal: the Drive asks it to know a chat's files are ciphertext, and which key is the newest. @param {string} id */
    chatEpoch(id) { const c = chats.get(String(id)); return c && c.ring ? c.ring.epoch : 0; },
    /** Does this Space have the default assistant as an actor? A Space made before it existed does not, and gets it only by an owner's approval with presence (`addActor`), never silently. */
    hasDefaultAssistant() { return memberOk({ kind: "agent", id: DEFAULT_ASSISTANT, space: cfg.space }); },
    /**
     * The chats this chain may read, by the same rule as chatRead (a person in it; an assistant or a model slot acting for such a person): their ids, newest first. The one place that answers "which chats am I in",
     * so nothing else keeps a copy of the rule. @param {any} chain @returns {string[]}
     */
    chatMine(chain) {
      const out = [];
      for (const c of [...chats.values()].reverse()) { try { api.chatRead(chain, c.id); out.push(c.id); } catch (e) { if (!(e instanceof KernelError) || e.code !== "not_found") throw e; } }
      return out;
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
      return [...new Set(at.people.map((/** @type {string} */ x) => (adopted && x === adopted.from ? adopted.to : x)))];
    },
    /** The chat's assistants, for the append check. @param {string} id @returns {string[] | null} */
    chatAssistants(id) { const c = chats.get(String(id)); return c ? [...c.assistants] : null; },
    /** May this assistant act in this chat? The person's default assistant acts as the person it is for and is never listed, so only the person's own membership decides (the caller checks that); any other assistant must be listed. @param {string} id @param {string} agent */
    chatAssistantOk(id, agent) { const c = chats.get(String(id)); return Boolean(c) && (agent === DEFAULT_ASSISTANT || String(agent).startsWith("model:") || c.assistants.includes(String(agent))); },
    /**
     * Check every stored delegated grant against its parent on every dimension, and cut down any that is wider (made before containment compared every dimension, or by a bug): it keeps
     * what it was inside, the cut is written to the log as a `grant.narrowed` event saying why, and one that cannot be brought inside is revoked. Never trusts what is on disk. Run at
     * boot, once the actions are registered. @returns {Promise<{ clamped: number, revoked: number }>}
     */
    async containmentPass() {
      let clamped = 0, revoked = 0;
      const depthOf2 = (/** @type {any} */ g) => { let d = 0; for (let p = g; p && p.parent && d < 10; p = grants.get(p.parent)) d++; return d; };
      for (const g of [...grants.values()].filter(x => x.status === "active" && x.parent).sort((a, b) => depthOf2(a) - depthOf2(b))) {
        const parent = grants.get(g.parent);
        if (!parent || parent.status !== "active") continue;
        if (contains(parent, g, since, riskOf)) continue;
        const cut = clampTo(parent, g, since, riskOf);
        const k = kernelChain();
        if (cut && contains(parent, cut, since, riskOf)) {
          const n = freeze({ ...cut, reason: "cut to its parent's limits" });
          grants.set(g.id, n);
          await note(k, "grant.narrowed", urn("grant", g.id), { grant: n, why: "wider than its parent" });
          clamped++;
        } else {
          const n = freeze({ ...g, status: "revoked", revoked_at: clock(), reason: "wider than its parent and cannot be cut down" });
          grants.set(g.id, n);
          await note(k, "grant.revoked", urn("grant", g.id), { id: g.id, reason: n.reason });
          revoked++;
        }
      }
      return { clamped, revoked };
    },
    /**
     * The whole state as one sealed event: what a migration from an older key writes, and what rebuild can start from. Kernel-only.
     * A snapshot is a point the log can be read from: events before it are not needed once it exists.
     */
    /** The whole state as plain data, what a snapshot holds: a Space bundle carries it, and `adopt` puts it back. */
    state() { return { adopted, grants: [...grants.values()], memberships: [...memberships.values()], actors: [...actors], offers: [...offers.values()], invites: [...invites.values()], chats: [...chats.values()], rules: [...rules.values()], proposals: [...proposals.values()], teams: [...teams.values()], vaults: [...vaults.values()] };
    },
    /** Restore a bundle's state onto a Space that has none (its first owner only): it is loaded and written as a snapshot under THIS seal, so authority again rests on events this store sealed. Kernel-only, once. @param {any} st */
    async adopt(st) {
      if (memberships.size > 1 || !st || !Array.isArray(st.grants) || !Array.isArray(st.memberships)) throw new KernelError("bad_input", "a Space bundle's grants go onto a Space with no members but its owner");
      grants.clear(); memberships.clear(); actors.clear(); offers.clear(); invites.clear(); chats.clear(); rules.clear(); proposals.clear(); teams.clear(); vaults.clear();
      loadState(st);
      return api.snapshot();
    },
    async snapshot() {
      const state = api.state();
      await note(kernelChain(), "grants.snapshot", urn("grant", "snapshot"), { state });
      snapAt = gseq;
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
      const keep = capture();
      try { return await api.rebuildFromLog(); } catch (e) { restore(keep); throw e; }
    },
    async rebuildFromLog() {
      adopted = null;
      grants.clear(); memberships.clear(); actors.clear(); offers.clear(); invites.clear(); chats.clear(); rules.clear(); proposals.clear(); teams.clear(); vaults.clear();
      gseq = 0; gprev = "genesis";
      // Boot reads what it needs, not the whole log: the newest snapshot that verifies is the starting state, and only the grants events written after it are read, by type
      // (an index scan on a durable log). A log with no snapshot reads every grants event once, and the migration below writes one.
      const rd = (/** @type {any} */ f) => (cfg.log.iterate ? [...cfg.log.iterate(f)] : cfg.log.read(f));
      /** @param {any} e */ const toItem = (e) => { const { mac, gseq: n, gprev: pv, ...core } = e.data; return { e, mac, n, prev: pv, core, legacy: n === undefined }; };
      const snapItems = rd({ type: "grants.snapshot" }).filter((/** @type {any} */ e) => e.data && typeof e.data === "object").map(toItem).filter((/** @type {any} */ i) => !i.legacy && typeof i.mac === "string" && Number.isInteger(i.n)).sort((/** @type {any} */ a, /** @type {any} */ b) => b.n - a.n);
      /** @type {any} */ let snap = null;
      for (const c of snapItems) { // newest by its own number first (a replayed old one is older); the first that verifies is the start
        if (await seal.verify("grants-event-v1", sealed(c.e.type, c.e.subject, c.core, c.n, c.prev), c.mac)) { snap = c; break; }
      }
      const since = snap ? snap.e.seq : 0;
      /** @type {any[]} */ const tail = [];
      for (const t of ["grant.*", "member.*", "actor.*", "offer.*", "invite.*", "chat.*", "rule.*", "team.*", "vault.*", "owner.changed", "owner.adopted"]) for (const e of rd({ type: t, since })) if (e.data && typeof e.data === "object") tail.push(e);
      tail.sort((a, b) => a.seq - b.seq);
      const items = tail.map(toItem);
      // 1. Verify the new-style events after the snapshot, in pipelined batches.
      const fresh = items.filter(i => !i.legacy && typeof i.mac === "string" && Number.isInteger(i.n));
      const ok = new Set();
      for (let i = 0; i < fresh.length; i += 128) {
        const part = fresh.slice(i, i + 128);
        const res = await seal.verifyMany(part.map(x => ({ purpose: "grants-event-v1", data: sealed(x.e.type, x.e.subject, x.core, /** @type {number} */ (x.n), x.prev), mac: x.mac })));
        part.forEach((x, k) => { if (res[k]) ok.add(x); });
      }
      let nextN = 1, nextPrev = "genesis", legacyCount = 0;
      const apply = (/** @type {any} */ e, /** @type {any} */ d) => {
        if (e.type === "grant.created" && grants.has(d.grant.id)) return; // an id is made once: a second creation of it is never a resurrection
        if (e.type === "grant.created" || e.type === "grant.narrowed") grants.set(d.grant.id, freeze(structuredClone(d.grant)));
        else if (e.type === "grant.revoked") { const g = grants.get(d.id); if (g) grants.set(d.id, freeze({ ...g, status: "revoked", revoked_at: e.time, reason: d.reason })); }
        else if (e.type === "member.set") memberships.set(d.membership.person, freeze(structuredClone(d.membership)));
        else if (e.type === "member.removed") memberships.delete(d.person);
        else if (e.type === "owner.adopted") { if (!adopted && d && typeof d.from === "string" && typeof d.to === "string") adopted = freeze({ from: d.from, to: d.to }); }
        else if (e.type === "invite.created") invites.set(d.invite.id, freeze(structuredClone(d.invite)));
        else if (e.type === "invite.used") { const v = invites.get(d.id); if (v) invites.set(d.id, freeze({ ...v, status: "used", used_by: d.by })); }
        else if (e.type === "invite.confirmed") { const v = invites.get(d.id); if (v) invites.set(d.id, freeze({ ...v, confirmed: true })); }
        else if (e.type === "invite.revoked") { const v = invites.get(d.id); if (v) invites.set(d.id, freeze({ ...v, status: "revoked", revoked_by: d.by })); }
        else if (e.type === "actor.added") actors.add(actorKey(d.actor));
        else if (e.type === "actor.removed") actors.delete(actorKey(d.actor));
        else if (e.type === "offer.created") offers.set(d.offer.id, freeze(structuredClone(d.offer)));
        else if (e.type === "offer.revoked") { const o = offers.get(d.id); if (o) offers.set(d.id, freeze({ ...o, status: "revoked", revoked_at: e.time, ...(typeof d.by === "string" ? { ended_by: d.by } : {}) })); }
        else if (e.type === "rule.set") { rules.set(d.rule.id, freeze(structuredClone(d.rule))); if (d.from) proposals.delete(d.from); }
        else if (e.type === "rule.removed") rules.delete(d.id);
        else if (e.type === "rule.enabled" || e.type === "rule.disabled") { const r = rules.get(d.id); if (r) rules.set(d.id, freeze({ ...structuredClone(r), status: e.type === "rule.enabled" ? "active" : "disabled" })); }
        else if (e.type === "rule.proposed") proposals.set(d.proposal.id, freeze(structuredClone(d.proposal)));
        else if (e.type === "rule.dismissed") proposals.delete(d.id);
        else if (e.type === "team.set") teams.set(d.team.id, freeze(structuredClone(d.team)));
        else if (e.type === "team.removed") teams.delete(d.id);
        else if (e.type === "vault.set") vaults.set(d.vault.id, freeze(structuredClone(d.vault)));
        else if (e.type === "vault.removed") vaults.delete(d.id);
        else if (e.type === "chat.created") { if (!chats.has(d.chat.id)) chats.set(d.chat.id, freeze(structuredClone(d.chat))); }
        else if (e.type === "chat.changed") { const c = chats.get(d.id); if (c) chats.set(d.id, freeze({ ...c, people: [...d.people], assistants: [...d.assistants], ver: d.ver ?? (c.ver || 1) + 1, h: [...(c.h || [{ ver: c.ver || 1, people: c.people }]), { ver: d.ver ?? (c.ver || 1) + 1, people: [...d.people] }].slice(-HISTORY), ...(d.ring ? { ring: structuredClone(d.ring) } : {}) })); }
      };
      if (snap) {
        loadState(snap.core.state);
        nextN = /** @type {number} */ (snap.n) + 1; nextPrev = sha256(snap.mac);
      } else {
        // 3a. Events an older key sealed, in log order, each position-bound under a legacy key.
        for (const it of items) {
          if (!it.legacy || typeof it.mac !== "string") continue;
          const good = (cfg.legacyKeys || []).some((/** @type {any} */ k) => sameMac(hmac(k, canonical({ type: it.e.type, subject: it.e.subject, data: it.core, seq: it.e.seq, prev: it.e.prev })), it.mac));
          if (good) { apply(it.e, it.core); legacyCount++; }
        }
      }
      // 3b. The new chain: only the event that is exactly next (its number, and the hash of the seal before it) is taken; replays and gaps are skipped.
      for (const it of items) {
        if (!ok.has(it) || it.n !== nextN || it.prev !== nextPrev) continue;
        apply(it.e, it.core);
        nextN++; nextPrev = sha256(it.mac);
      }
      gseq = nextN - 1; gprev = nextPrev;
      snapAt = snap ? snap.n : 0;
      // 4. Migration: legacy events were read, so write the state under the new seal; the old key is not needed again.
      let migrated = false;
      if (legacyCount > 0 && !snap) { await api.snapshot(); migrated = true; }
      return { legacy: legacyCount, migrated };
    },
  };

  /** The whole in-memory state, by reference (every record in it is frozen), so a failed call can put it back even when the log cannot be read. */
  /** Put a state (a snapshot's, or a bundle's) into the maps. @param {any} st */
  const loadState = (st) => {
    adopted = st.adopted && typeof st.adopted.to === "string" ? freeze({ from: st.adopted.from, to: st.adopted.to }) : null;
    for (const g of st.grants) grants.set(g.id, freeze(structuredClone(g)));
    for (const m of st.memberships) memberships.set(m.person, freeze(structuredClone(m)));
    for (const a of st.actors || []) actors.add(a);
    for (const o of st.offers || []) offers.set(o.id, freeze(structuredClone(o)));
    for (const v of st.invites || []) invites.set(v.id, freeze(structuredClone(v)));
    for (const c of st.chats || []) chats.set(c.id, freeze(structuredClone(c)));
    for (const x of st.rules || []) rules.set(x.id, freeze(structuredClone(x)));
    for (const x of st.proposals || []) proposals.set(x.id, freeze(structuredClone(x)));
    for (const x of st.teams || []) teams.set(x.id, freeze(structuredClone(x)));
    for (const x of st.vaults || []) vaults.set(x.id, freeze(structuredClone(x)));
  };
  const capture = () => ({ adopted, grants: new Map(grants), memberships: new Map(memberships), actors: new Set(actors), offers: new Map(offers), invites: new Map(invites), chats: new Map(chats), rules: new Map(rules), proposals: new Map(proposals), teams: new Map(teams), vaults: new Map(vaults), gseq, gprev });
  const restore = (/** @type {any} */ c) => {
    adopted = c.adopted || null;
    grants.clear(); for (const [k, v] of c.grants) grants.set(k, v);
    memberships.clear(); for (const [k, v] of c.memberships) memberships.set(k, v);
    actors.clear(); for (const v of c.actors) actors.add(v);
    offers.clear(); for (const [k, v] of c.offers) offers.set(k, v);
    invites.clear(); for (const [k, v] of c.invites) invites.set(k, v);
    chats.clear(); for (const [k, v] of c.chats) chats.set(k, v);
    rules.clear(); for (const [k, v] of c.rules) rules.set(k, v);
    proposals.clear(); for (const [k, v] of c.proposals) proposals.set(k, v);
    teams.clear(); for (const [k, v] of c.teams || []) teams.set(k, v);
    vaults.clear(); for (const [k, v] of c.vaults || []) vaults.set(k, v);
    gseq = c.gseq; gprev = c.gprev;
  };
  // One pattern for every state-changing call (reviewer-2's R4): the calls run one at a time, and a call that fails while writing its sealed event (the sealing process died,
  // the log refused) restores the store from the log, which is the durable copy, so memory never shows a change the log does not hold, and the caller is told it failed.
  // A refusal the call itself makes before changing anything (a KernelError) needs no restore.
  let lock = Promise.resolve();
  for (const name of ["create", "revoke", "narrow", "setRole", "transferOwner", "adoptOwner", "bootstrap", "inviteRevoke", "removeMember", "addActor", "offer", "unoffer", "lend", "unlend", "inviteCreate", "inviteConfirm", "inviteAccept", "sweep", "installModule", "carryOver", "takeBack", "personalVault", "chatCreate", "chatChange", "ruleSet", "ruleRemove", "ruleAccept", "ruleDismiss", "rulePropose", "ruleEnable", "ruleDisable"]) {
    const f = /** @type {(...a: any[]) => Promise<any>} */ (/** @type {any} */ (api)[name]);
    /** @type {any} */ (api)[name] = (/** @type {any[]} */ ...a) => {
      const run = async () => {
        const before = capture(), seq0 = cfg.log.latestSeq();
        try { const r = await f(...a); if (gseq - snapAt >= SNAP_EVERY) { try { await api.snapshot(); } catch { /* the next call tries again */ } } return r; } catch (e) {
          // WF-1: memory never shows a change the log does not hold. If the log did not move, nothing was written, so memory goes back exactly to what the call started from (a refusal, or a
          // sealing process that failed under the event). If events were written before it failed (a change made of several), the log is the truth: rebuild from it, and only if it cannot be
          // read put back the state this call started from, never an empty store.
          if (cfg.log.latestSeq() === seq0) restore(before);
          else { try { await api.rebuild(); } catch { restore(before); } }
          throw e;
        }
      };
      const p = lock.then(run, run);
      lock = p.then(() => {}, () => {});
      return p;
    };
  }

  return Object.freeze({
    ...api, provider, members, groups: Object.freeze({ has: inTeam }), isAdmin, roleOf,
    /** Called once by the gateway, with the authorizer it built from `provider` and `members`. */
    bind(/** @type {{ authorizer: any, registry: () => Map<string, any>, enforce?: (chain: any, d: any) => void }} */ b) { bound = { ...createGate({ authorizer: b.authorizer, log: cfg.log, enforce: b.enforce }), registry: b.registry }; },
  });
}
