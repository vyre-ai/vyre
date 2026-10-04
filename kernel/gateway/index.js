// kernel/gateway/index.js: assembles the K2 gateway: authorize, records, grants-lite, events and audit over one store.
import { createAuthorizer } from "../core/authorize.js";
import { createRecords, RECORD_ACTIONS } from "./records.js";
import { createSealing } from "./sealing.js";
import { ACTIONS as SEAL_ACTIONS } from "../seal/uses.js";
import { CHECKPOINT_ACTIONS } from "./checkpoints.js";
import { TASK_ACTIONS } from "../tasks/tasks.js";
import { createApprovals } from "../tasks/approvals.js";
import { createGate } from "../core/gate.js";
import { roomedAuthorizer } from "../core/room.js";
import { GRANT_ACTIONS } from "../grants/index.js";
import { createLimits } from "../core/limits.js";
import { verifyLog } from "../audit/index.js";
import { createLeases } from "./leases.js";
import { createDriveGateway } from "./drive.js";
import { grantProofVerifier } from "../core/presence.js";
import { isChain, actorString, isExactlyPerson } from "../core/chain.js";
import { KernelError } from "../core/errors.js";

/**
 * @param {{ expr?: any, stageTasks?: any, onStageEnter?: any, limits?: any, grantsStore?: any, presence?: any, tasks?: any, sealer?: any, door?: any, approvals?: any, templates?: any, destinations?: any, owner?: string, space: string, store: any, log: any, chains: any, grants: any, members: any, actions?: any[], attrs?: any, sealedFields?: any,
 *   sinks?: Set<string>, standing?: any, verifyPresence?: any, hasPresenceSession?: any, clock?: () => number, policy_version?: number }} cfg
 */
export function createGateway(cfg) {
  if (cfg.door && cfg.door.usesKernelChain !== true) throw new KernelError("bad_input", "the door must be built with the kernel's own isChain");
  const limits = cfg.limits || createLimits({ space: cfg.space, log: cfg.log, clock: cfg.clock });
  const enforce = (/** @type {any} */ chain, /** @type {any} */ d) => limits.enforce(chain, d);
  /** @type {any} */ let records;
  // Kernel attributes come from the gateway's own index (K2-7); a caller-supplied resolver only fills what the gateway does not hold.
  const attrs = (/** @type {string} */ u) => ({ ...((cfg.attrs && cfg.attrs(u)) || {}), ...((records && records.attrsOf(u)) || {}) });
  // `authorize` reads grants and members from the kernel's grants store when one is given; otherwise from the caller (the retrofit path).
  const gs = cfg.grantsStore;
  const wiring = gs ? { grants: gs.provider, members: gs.members, rules: { match: ({ chain, action, resource }) => gs.rulesFor(chain, action, resource), touches: (chain, action) => gs.rulesTouch(chain, action) }, ...(cfg.presence ? { verifyPresence: grantProofVerifier(cfg.presence) } : {}) } : {};
  const rawAuthorizer = createAuthorizer({ ...cfg, ...wiring, attrs, actions: [...RECORD_ACTIONS, ...SEAL_ACTIONS, ...TASK_ACTIONS, ...GRANT_ACTIONS, ...CHECKPOINT_ACTIONS, ...(cfg.actions || [])] });
  // A group session's reads are the room's: every gated read below goes through this (kernel/core/room.js roomedAuthorizer).
  const authorizer = cfg.room && cfg.chains ? roomedAuthorizer(rawAuthorizer, cfg.room, cfg.chains) : rawAuthorizer;
  if (gs) gs.bind({ enforce, authorizer, registry: () => authorizer.actions });
  records = createRecords({ room: cfg.room, expr: cfg.expr, stageTasks: cfg.stageTasks, onStageEnter: cfg.onStageEnter, enforce, members: wiring.members || cfg.members, space: cfg.space, store: cfg.store, authorizer, log: cfg.log, chains: cfg.chains, clock: cfg.clock, sinks: cfg.sinks, unit: cfg.unit, kitApply: cfg.kitApply });
  const { allowed, gate } = createGate({ authorizer, log: cfg.log, enforce });

  /** May this chain see this event? `events.read` on the subject, then the event's own `vis` (contract 7.4). Anything unknown is no. */
  async function canSee(/** @type {any} */ chain, /** @type {any} */ e) {
    if (!(await allowed(chain, "events.read", e.subject))) return false;
    const vis = e.vis;
    if (vis === "space") return true;
    if (vis === "subject") return allowed(chain, "records.read", e.subject);
    const mem = wiring.members || cfg.members;
    const owner = isExactlyPerson(chain) && cfg.owner !== undefined && chain.hops[0].actor.id === cfg.owner;
    if (vis === "owner") return owner;
    if (vis === "actor") return owner || chain.hops.some((/** @type {any} */ h) => actorString(h.actor) === e.actor);
    if (typeof vis === "string" && vis.startsWith("members:")) {
      const role = vis.slice(8);
      return chain.hops.some((/** @type {any} */ h) => h.actor.kind === "person" && mem.membership && mem.membership(h.actor)?.role === role);
    }
    return false;
  }

  /** A group session sees an event only when every person in its room may (the asker's own `canSee` has already passed). */
  async function roomSees(/** @type {any} */ chain, /** @type {any} */ e) {
    let people = null;
    try { people = cfg.room ? cfg.room.peopleOf(chain) : null; } catch { return false; }
    if (!people) return true;
    for (const person of people) if (!(await canSee(await cfg.chains.fromFacts({ kind: "viewer", person, vouched: true }), e))) return false;
    return true;
  }

  /** The log through `authorize`: events the chain may not read are absent, never marked. */
  async function read(/** @type {any} */ chain, /** @type {any} */ filter = {}) {
    if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
    const { limit, ...rest } = filter;
    const out = [];
    for (const e of (cfg.log.iterate ? cfg.log.iterate(rest) : cfg.log.read(rest))) { if ((await canSee(chain, e)) && (await roomSees(chain, e))) out.push(await records.viewEvent(chain, e)); if (limit && out.length >= limit) break; }
    return out;
  }

  /** A consumer name belongs to the actor that first used it; every delivered event is checked the way `read` checks it. */
  function subscribe(/** @type {any} */ chain, /** @type {string} */ consumer, /** @type {any} */ filter, /** @type {(e: any) => any} */ onEvent) {
    if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
    const name = `${actorString(chain.hops[chain.hops.length - 1].actor)}:${consumer}`;
    return cfg.log.subscribe(name, filter, async (/** @type {any} */ e) => { if ((await canSee(chain, e)) && (await roomSees(chain, e))) await onEvent(await records.viewEvent(chain, e)); });
  }

  /** The tasks as the room sees them: `get` and `card` are gated reads (the roomed authorizer), and a listing of the asker's own tasks keeps only those every person in the room may read. */
  function groupTasks(/** @type {any} */ t) {
    if (!cfg.room || !t) return t;
    return { ...t, needsYou: async (/** @type {any} */ chain) => {
      const mine = await t.needsYou(chain);
      let people = null;
      try { people = cfg.room.peopleOf(chain); } catch { return []; }
      if (!people || !Array.isArray(mine)) return mine;
      const vs = await Promise.all(people.map(async (/** @type {string} */ person) => cfg.chains.fromFacts({ kind: "viewer", person, vouched: true })));
      const out = [];
      for (const x of mine) { let ok = true; for (const v of vs) { try { if (!(await t.get(v, x.id))) ok = false; } catch { ok = false; } } if (ok) out.push(x); }
      return out;
    } };
  }

  const seal = cfg.sealer ? createSealing({ enforce, clock: cfg.clock, approval_max_age: cfg.approval_max_age, space: cfg.space, sealer: cfg.sealer, authorizer, log: cfg.log, door: cfg.door, approvals: cfg.approvals || (cfg.tasks ? createApprovals({ tasks: cfg.tasks }) : undefined), templates: cfg.templates, destinations: cfg.destinations }) : undefined;


  const drive = cfg.drive ? createDriveGateway({ space: cfg.space, drive: cfg.drive, authorizer, log: cfg.log, enforce }) : undefined;
  const leases = cfg.sealer && gs && cfg.sealer.lease ? createLeases({ space: cfg.space, sealer: cfg.sealer, grantsStore: gs, authorize: authorizer.authorize, enforce, ...(drive ? { drive } : {}), log: cfg.log, chains: cfg.chains, resolve: cfg.resolveCredential, forward: cfg.forwardCredential, routeAction: cfg.routeAction }) : undefined;


  /**
   * Seal a field that already holds plain values. A kind cannot change under data, so the values move into a new sealed field (`<field>_sealed`): each goes
   * through `seal.put` and its reference is written (the change events keep no plaintext), the plain field is emptied and then removed softly, and the old values
   * are scrubbed from where this side keeps them: the change log, snapshots and the event log (an event that held one keeps its envelope and loses its data,
   * so the chain still verifies). The caller's chain needs `records.define`, `records.update` on every record and `seal.put`; it stops at the first refusal.
   * Records in the bin are brought back for the write and put back. Twenty's own history is purged by the store (`scrub`); a database that has already written
   * the old values to disk keeps dead pages until it is vacuumed, which is the Space operator's job.
   */
  async function sealField(/** @type {any} */ chain, /** @type {{ type: string, field: string, class: string, level?: "ai" | "human", name?: string, scrub_history?: boolean }} */ i) {
    if (!seal) throw new KernelError("unavailable", "sealing is not wired");
    if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
    const dec = await gate(chain, "records.define", `vyre://${cfg.space}/definition/types`);
    let defs; try { defs = await cfg.store.types(); } catch (e) { throw new KernelError("unavailable", "the store could not list its types"); }
    const def = defs.find((/** @type {any} */ t) => t.name === i.type);
    const f = def && def.fields.find((/** @type {any} */ x) => x.name === i.field);
    if (!def || !f) throw new KernelError("not_found", "no such field");
    if (!["text", "rich_text", "url"].includes(f.kind) || f.unique || f.computed || f.hidden) throw new KernelError("bad_input", `${i.field} cannot be sealed in place: it must be a plain text field that is not unique, computed or removed`);
    const name = i.name || `${i.field}_sealed`;
    if (def.fields.some((/** @type {any} */ x) => x.name === name)) throw new KernelError("bad_input", `${i.type} already has a field ${name}`);
    if (!(await allowed(chain, "seal.put", `vyre://${cfg.space}/${i.type}/*`))) throw new KernelError("not_allowed", "this chain cannot seal values");
    const withField = { ...def, fields: [...def.fields.map((/** @type {any} */ x) => (x.name === i.field && x.required ? { ...x, required: false } : x)), { name, kind: "sealed", label: f.label, seal: { level: i.level || "ai", class: i.class } }] };
    await records.define(chain, { change_types: [withField] });
    // every row of the type, the bin included, read from the store itself: the caller's reads may not reach all of them and none may keep a plain value
    const all = async () => { const out = []; let cursor; do { const p = await cfg.store.query(i.type, { include_deleted: true, page: { limit: 200, ...(cursor ? { cursor } : {}) } }); out.push(...p.rows); cursor = p.next_cursor; } while (cursor); return out; };
    const has = (/** @type {any} */ v) => typeof v === "string" && v.length > 0;
    let moved = 0;
    /** @type {Set<string>} the plain values that move: what the task texts are searched for afterwards */ const plain = new Set();
    for (const row of await all()) {
      if (!has(row.data[i.field])) continue;
      plain.add(row.data[i.field]);
      const u = `vyre://${cfg.space}/${i.type}/${row.id}`;
      const binned = Boolean(row.deleted_at);
      let version = row.version;
      if (binned) version = (await records.restore(chain, i.type, row.id)).version;
      const put = await seal.put(chain, { record: u, field: name, class: i.class, value: row.data[i.field] });
      await records.update(chain, i.type, row.id, { [name]: put.ref, [i.field]: null }, version, { redact: [i.field] });
      if (binned) { const cur = await cfg.store.get(i.type, row.id); await records.remove(chain, i.type, row.id, cur.version); }
      moved++;
    }
    const left = (await all()).filter((/** @type {any} */ r) => has(r.data[i.field])).length;
    if (left) throw new KernelError("unavailable", `${left} records still hold the plain value; nothing was hidden`);
    await records.define(chain, { change_types: [{ ...withField, fields: withField.fields.map((/** @type {any} */ x) => (x.name === i.field ? { ...x, hidden: true, required: false } : x)) }] });
    let erased = 0;
    if (i.scrub_history !== false) {
      // Free text a task kept (a form, a draft, an answer) may quote a value: it is cleared BEFORE the store's scrub, whose last step rewrites the file, so nothing survives in free pages.
      if (plain.size && cfg.tasks && typeof cfg.tasks.scrubTexts === "function") await cfg.tasks.scrubTexts({ values: [...plain] });
      if (typeof cfg.store.scrub === "function") await cfg.store.scrub(i.type, [i.field]);
      const prefix = `vyre://${cfg.space}/${i.type}/`;
      for (const e of cfg.log.read()) {
        const d = e.data;
        if (!e.subject || !e.subject.startsWith(prefix) || !d || typeof d !== "object" || d.erased === true) continue;
        const held = (/** @type {any} */ o) => o && typeof o === "object" && has(o[i.field]);
        if (held(d.before) || held(d.after)) { cfg.log.erase(e.seq); erased++; }
      }
    }
    cfg.log.append(chain, { type: "records.field-sealed", sv: 1, subject: `vyre://${cfg.space}/definition/types`, data: { type: i.type, field: i.field, sealed_field: name, moved, erased_events: erased } }, { decision: dec.decision });
    return { sealed_field: name, moved, erased_events: erased };
  }

  return Object.freeze({
    authorize: authorizer.authorize,
    /** An approved Kit install: `kits.begin({ chain, task, kit })` gives the waiver `records.define(chain, diff, { waiver })` takes, `kits.end(waiver)` ends it (kernel/tasks/kit-apply.js). */
    ...(cfg.kitApply ? { kits: Object.freeze({ begin: cfg.kitApply.begin, end: cfg.kitApply.end }) } : {}),
    ...(drive ? { drive } : {}),
    ...(leases ? { leases } : {}),
    /** The action registry as the authorizer holds it (a Map of ActionDef): tasks read the risk of an action from here. */
    registry: authorizer.actions,
    limits,
    ...(seal ? { seal } : {}),
    ...(gs ? { grants: Object.freeze({ create: gs.create, revoke: gs.revoke, narrow: gs.narrow, list: gs.list, setRole: gs.setRole, removeMember: gs.removeMember, transferOwner: gs.transferOwner, rules: Object.freeze({ list: gs.rulesList, get: gs.ruleGet, test: gs.ruleTest, enable: gs.ruleEnable, disable: gs.ruleDisable, set: gs.ruleSet, remove: gs.ruleRemove, propose: gs.rulePropose, accept: gs.ruleAccept, dismiss: gs.ruleDismiss }), addActor: gs.addActor, removeActor: gs.removeActor, sweep: gs.sweep, members: Object.freeze({ list: gs.membersList, get: gs.membersGet }), invites: Object.freeze({ create: gs.inviteCreate, confirm: gs.inviteConfirm, accept: gs.inviteAccept, get: gs.invitesGet, revoke: (/** @type {any} */ chain, /** @type {string} */ id, /** @type {any} */ proof) => gs.inviteRevoke(chain, id, { presence: proof }), list: gs.inviteList }), rebuild: gs.rebuild, defaultAssistant: Object.freeze({ present: gs.hasDefaultAssistant, add: (chain, o) => gs.addActor(chain, { kind: "agent", id: "assistant", space: cfg.space }, o), remove: (chain, o) => gs.removeActor(chain, { kind: "agent", id: "assistant", space: cfg.space }, o) }), chats: Object.freeze({ create: gs.chatCreate, change: gs.chatChange, read: gs.chatRead }), offers: Object.freeze({ offer: gs.offer, unoffer: gs.unoffer, lend: gs.lend, unlend: gs.unlend, active: gs.active, find: gs.find, onRevoke: gs.onRevoke }) }) } : {}),
    /** The Space's type definitions, read through authorize like any record read (the tool surface and Customize list from here). */
    async definitions(chain) {
      await gate(chain, "records.read", `vyre://${cfg.space}/definition/types`);
      try { return await cfg.store.types(); } catch (e) { throw new KernelError("unavailable", "the store could not list its types", String(e && e.message)); }
    },
    /** The action registry: what each action is and how risky (ActionDef). */
    actions: () => [...authorizer.actions.values()],
    members: Object.freeze({
      /** The role a member holds in this Space, or null. A role is read from the membership the kernel holds, never from the caller. */
      roleOf: (/** @type {any} */ a) => ((wiring.members || cfg.members).has(a) && (wiring.members || cfg.members).membership ? (wiring.members || cfg.members).membership(a)?.role ?? null : null),
      isAdmin: (/** @type {any} */ a) => { const m = wiring.members || cfg.members; const r = m.has(a) && m.membership ? m.membership(a)?.role : null; return r === "owner" || r === "admin"; },
    }),
    /** A service chain for the kernel's own module (memory, hooks): first-party, built by the kernel, never by a caller. */
    serviceChain: (/** @type {string} */ name) => cfg.chains.fromFacts({ kind: "module", module: String(name), first_party: true }),
    ...(cfg.tasks ? { tasks: Object.freeze({ list: (/** @type {any} */ chain) => cfg.tasks.needsYou(chain) }), ask: groupTasks(cfg.tasks) } : {}),
    ...(cfg.door ? { model: Object.freeze({ call: (/** @type {any} */ i) => cfg.door.call(i) }) } : {}),
    records,
    migrate: Object.freeze({ sealField }),
    events: Object.freeze({ read, latestSeq: cfg.log.latestSeq, subscribe }),
    audit: Object.freeze({
      verify: async () => {
        const v = cfg.log.verify();
        // Every event that still holds its data must also match its salted commitment (K1 item 9b); an erased event keeps only its envelope.
        let bad = null;
        if (v.ok) for (const e of (cfg.log.iterate ? cfg.log.iterate({}) : cfg.log.read())) if (!(e.data && e.data.erased === true) && !cfg.log.proves(e.seq)) { bad = e.seq; break; }
        // With the Space's public key, every signed checkpoint is checked too (K5): signatures, and that the event each names is in the log as signed.
        const cps = v.ok && cfg.checkpointKey ? verifyLog({ space: cfg.space, log: cfg.log, publicKey: cfg.checkpointKey }) : null;
        const ok = v.ok && bad === null && (!cps || cps.ok);
        return { ok, events: cfg.log.latestSeq(), open_intents: records.openIntents(), ...(cps ? { checkpoints: cps.checkpoints } : {}), ...(ok ? {} : { detail: v.ok ? (bad !== null ? `event ${bad} does not match its commitment` : cps && cps.problems[0].why) : v.why }) };
      },
    }),
    async health() {
      const h = await cfg.store.health().catch((/** @type {any} */ e) => ({ ok: false, detail: String(e && e.message) }));
      const v = await cfg.store.version().catch(() => ({ store: "unknown", version: "?" }));
      return { ok: Boolean(h.ok), versions: { [v.store]: v.version } };
    },
  });
}
export { RECORD_ACTIONS };
