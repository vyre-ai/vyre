// kernel/tasks/tasks.js: tasks with approval (contract 9.4, DESIGN-tasks.md; invariant 4). A task has one doer and an
// optional checker; the kernel owns every transition (the table is data in the contracts) and every field that carries
// approval truth. The doer's words are never authority: a task is moved only by the actor its rule names, an output is
// checked by the kernel before anything advances, and an approval is accepted only from a chain that is exactly one
// person, with a hardware-signer proof over the exact payload, the decision and the chain, once.
import { canonical, sha256 } from "../core/canonical.js";
import { mintUuid } from "../core/ids.js";
import { isChain, isExactlyPerson } from "../core/chain.js";
import { createGate } from "../core/gate.js";
import { KernelError } from "../core/errors.js";
import { TASK_TRANSITIONS, ACTOR_KINDS } from "../contracts/index.js";
import { buildCard } from "./card.js";
import { createIdem } from "../core/idem.js";

/** The actions task calls register with the authorizer (contract 6.1). */
export const TASK_ACTIONS = Object.freeze([
  { action: "tasks.request", resource_type: "task", risk: "write", label: "give someone a task", gloss: "Assign work to a person or an assistant." },
  { action: "tasks.read", resource_type: "task", risk: "read", label: "see tasks", gloss: "Open tasks." },
  { action: "tasks.work", resource_type: "task", risk: "write", label: "work on tasks", gloss: "Start, finish or flag a task you were given." },
  { action: "tasks.decide", resource_type: "task", risk: "write", label: "approve or reject", gloss: "Decide a task waiting for your check." },
].map(a => Object.freeze(a)));

const REQUEST_KEYS = new Set(["title", "record", "stage", "source", "doer", "helpers", "checker", "output", "how", "template", "inputs", "depends_on", "due", "escalate_after", "escalate_to", "required", "note", "session", "flow", "form"]);
const SOURCES = new Set(["manual", "assistant_request", "flow_step"]);
/** Sources only a service chain may name (the kernel's own modules and Flows, never a person or a model): the task is the continuation of a session in a Space. */
const SERVICE_SOURCES = new Set(["continue_in_space"]);
const OUTPUTS = new Set(["fields", "note", "draft", "sent", "decision", "file"]);
const FIX_CAP = 400;
const COOL_DOWN_MS = 7 * 24 * 3600_000;
const DENIALS_TO_STUCK = 3;

/** The kernel's own read of a record's stage tasks (the gateway's stage gate). Held beside the public api, not on it: a surface cannot reach it. */
const VIEWS = new WeakMap();
/** @param {any} api @param {string} record @param {string} stage @returns {{ title: string, state: string, required: boolean }[]} */
export const stageTasks = (api, record, stage) => { const v = VIEWS.get(api); return v ? v(record, stage) : []; };

const urnOf = (/** @type {string} */ space, /** @type {string} */ id) => `vyre://${space}/task/${id}`;
const same = (/** @type {any} */ a, /** @type {any} */ b) => Boolean(a && b) && a.kind === b.kind && a.id === b.id;
const acting = (/** @type {any} */ chain) => chain.hops[chain.hops.length - 1].actor;
const freeze = (/** @type {any} */ o) => Object.freeze(o);
const deepFreeze = (/** @type {any} */ o) => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
/** Opaque, kernel-quoted data a Flow sends with a task (a card form): plain JSON, capped, frozen; never read as an instruction. */
const opaque = (/** @type {any} */ v) => { const s = JSON.stringify(v); if (s === undefined || s.length > 8192) throw new KernelError("bad_input", "a form is plain data of at most 8 KB"); return deepFreeze(JSON.parse(s)); };
const SYSTEM = freeze({ kind: "service", id: "kernel" });
const APPROVAL_MAX_AGE = 24 * 3600_000;

/**
 * The kernel's output check: the declared kind decides what evidence is enough (contract 9.4 table). These are format
 * checks, not truth: a task that gates a stage, a send or a payment needs a human checker (R6-5).
 * @param {any} task @param {any} evidence @param {{ record?: (urn: string) => Promise<any>, exists?: (urn: string) => Promise<boolean> }} facts
 */
export async function checkOutput(task, evidence, facts) {
  const e = evidence && typeof evidence === "object" ? evidence : {};
  switch (task.output.kind) {
    case "fields": {
      const names = [].concat(task.output.target || []);
      const rec = task.record && facts.record ? await facts.record(task.record) : null;
      if (!rec || !names.length) return { ok: false, why: "the record or the fields to fill are missing" };
      const empty = names.filter(n => rec.data[n] === undefined || rec.data[n] === null || rec.data[n] === "");
      return empty.length ? { ok: false, why: `not filled: ${empty.join(", ")}` } : { ok: true };
    }
    case "note": return Array.isArray(e.sources) && e.sources.length >= 1 && typeof e.note === "string" && e.note.trim() ? { ok: true } : { ok: false, why: "a note needs text and at least one source" };
    case "draft": return typeof e.draft === "string" && facts.exists && (await facts.exists(e.draft)) ? { ok: true } : { ok: false, why: "no draft exists to check" };
    case "sent": return e.payload && typeof e.payload === "object" && typeof e.action === "string" && typeof e.resource === "string" ? { ok: true } : { ok: false, why: "a send needs its canonical payload, action and resource" };
    case "decision": return (e.answer === "yes" || e.answer === "no") && typeof e.reason === "string" && e.reason.trim() ? { ok: true } : { ok: false, why: "a decision needs yes or no and a reason" };
    case "file": return typeof e.file === "string" && facts.exists && (await facts.exists(e.file)) ? { ok: true } : { ok: false, why: "no file was produced" };
    default: return { ok: false, why: "unknown output kind" };
  }
}

/**
 * @param {{ enforce?: (chain: any, d: any) => void, space: string, authorizer: any, log: any, presence: import("../core/presence.js").PresenceVerifier,
 *   members: { has(actor: any): boolean }, roleHolders?: (role: string) => any[], approver?: (chain: any) => any,
 *   responsible?: (person: any, doer: any) => boolean, responsibleFor?: (doer: any) => any,
 *   resolve?: { template?: (id: string, version: number) => Promise<{ body: string } | null>, contact?: (record: string, address: string) => Promise<boolean>, sealed?: (ref: string) => Promise<{ class: string, record?: string } | null> },
 *   facts?: { record?: (urn: string) => Promise<any>, exists?: (urn: string) => Promise<boolean> },
 *   release?: (task: any, payload: any, by: { person: string, key_id: string }) => void | Promise<void>, chains: any, clock?: () => number }} cfg
 *   chains: the kernel's chain builder (for events the kernel itself writes, such as stuck detection); release: the held act's egress, run only after a verified approval.
 */
export function createTasks(cfg) {
  const clock = cfg.clock || Date.now;
  /** A person id as the Space knows them now: the owner an adoption replaced is the identity that replaced them, so a task keyed by the old id is still its person's. */
  const canon = (/** @type {string} */ id) => (typeof cfg.canonicalPerson === "function" ? cfg.canonicalPerson(id) : id);
  const same = (/** @type {any} */ a, /** @type {any} */ b) => Boolean(a && b) && a.kind === b.kind && (a.kind === "person" ? canon(a.id) === canon(b.id) : a.id === b.id);
  const { gate } = createGate({ authorizer: cfg.authorizer, log: cfg.log, enforce: cfg.enforce });
  const roleHolders = cfg.roleHolders || (() => []);
  /** @type {Map<string, any>} */ const tasks = new Map();
  /** @type {Map<string, any>} */ const bodies = new Map();
  /** A standing always-ask rule names who must approve: that person, or someone who holds that role now. No rule: any approval stands. @param {{ approver?: { person?: string, role?: string } } | undefined} rule @param {{ approver_chain: any } | undefined} by */
  const approverOk = (rule, by) => {
    if (!rule || !rule.approver) return true;
    const h = by && by.approver_chain && by.approver_chain.hops && by.approver_chain.hops.length === 1 ? by.approver_chain.hops[0].actor : null;
    if (!h || h.kind !== "person") return false;
    if (rule.approver.person !== undefined) return canon(h.id) === canon(rule.approver.person);
    return Boolean(cfg.members && typeof cfg.members.roleOf === "function" && cfg.members.roleOf(h) === rule.approver.role);
  };
  /** @type {Map<string, { approver_chain: any, use_proof: any }>} who approved a task and the sealed-use proof they signed with it (the sealing process verifies that proof itself) */ const approvedBy = new Map();
  /** @type {Map<string, string>} proposal id -> the task it proposes to skip */ const proposals = new Map();
  /** @type {Map<string, number>} */ const denials = new Map();
  const idem = createIdem({ clock });
  /** @type {Set<string>} approvals already spent on an act */ const usedApprovals = new Set();
  /** @type {Set<string>} tasks being decided right now: a second decide on one is refused before it can release again */ const deciding = new Set();
  /** @type {Map<string, number>} */ const coolDown = new Map();

  const get_ = (/** @type {string} */ id) => { const t = tasks.get(id); if (!t) throw new KernelError("not_found", "no such task"); return t; };
  // A task changes in memory and then its event is written; if the write fails the task goes back to what it was, so memory never shows a change the log does not hold (an approval
  // that was refused by the log must not stay live). `pending` keeps the state before the first change since the last event; `note` clears it on success and restores it on failure.
  /** @type {Map<string, any>} */ const pending = new Map();
  const stage = (/** @type {string} */ id, /** @type {any} */ next) => { if (!pending.has(id)) pending.set(id, tasks.get(id)); tasks.set(id, next); return next; };
  const put = (/** @type {any} */ t, /** @type {any} */ patch) => stage(t.id, freeze({ ...t, ...patch, updated_at: clock() }));
  const unstage = (/** @type {string} */ id) => {
    const prev = pending.get(id); pending.delete(id);
    if (prev === undefined) { tasks.delete(id); bodies.delete(id); proposals.delete(id); approvedBy.delete(id); } else tasks.set(id, prev);
  };
  const outward = (/** @type {any} */ t) => t.output.kind === "sent";
  /** The doer's answer for the output kinds a waiter reads back (a decision's yes or no and why, the values of a `fields` output, a note): plain data of at most 8 KB, frozen, kept on the task and carried on `task.completed` (sealed values stay references). Anything else keeps none. */
  const answerOf = (/** @type {any} */ t, /** @type {any} */ evidence) => {
    if (!["decision", "fields", "note"].includes(t.output.kind) || evidence === undefined || evidence === null) return undefined;
    let text; try { text = JSON.stringify(evidence); } catch { return undefined; }
    if (text === undefined || text.length > 8192) throw new KernelError("bad_input", "an answer is plain data of at most 8 KB");
    return deepFreeze(JSON.parse(text));
  };
  /** @param {any} ev */
  async function resolveFacts(ev) {
    const recipients = [];
    for (const r of Array.isArray(ev.payload.recipients) ? ev.payload.recipients : []) {
      let verified = false;
      try { verified = cfg.resolve && cfg.resolve.contact ? (await cfg.resolve.contact(r.record, String(r.address))) === true : false; } catch { verified = false; }
      recipients.push({ address: String(r.address), record: r.record || null, verified });
    }
    const sealed = [];
    for (const s of Array.isArray(ev.payload.sealed_slots) ? ev.payload.sealed_slots : []) {
      let meta = null;
      try { meta = cfg.resolve && cfg.resolve.sealed ? await cfg.resolve.sealed(s.ref) : null; } catch { meta = null; }
      // The ref's own record, from the vault: a slot that names another record than its ref belongs to is refused (N2).
      if (meta && typeof meta.record === "string" && meta.record !== s.record) throw new KernelError("bad_input", "a sealed slot names a record its reference does not belong to");
      sealed.push({ slot: String(s.slot), ref: String(s.ref), record: s.record || null, class: meta && typeof meta.class === "string" ? meta.class : "unknown" });
    }
    let template = null;
    if (ev.payload.template && typeof ev.payload.template.id === "string") {
      let t = null;
      try { t = cfg.resolve && cfg.resolve.template ? await cfg.resolve.template(ev.payload.template.id, Number(ev.payload.template.version)) : null; } catch { t = null; }
      template = { id: String(ev.payload.template.id), version: Number(ev.payload.template.version), hash: t && typeof t.body === "string" ? sha256(t.body) : null };
    }
    return { recipients, sealed, template };
  }
  // `required` makes only a SKIP a proposal for a person; a task needs a check to complete only when it has a checker or an outward output. A required task
  // with no checker completes on the kernel's output check (it used to wait for a checker nobody had).
  const needsCheck = (/** @type {any} */ t) => Boolean(t.checker) || outward(t);
  const guardedSkip = (/** @type {any} */ t) => needsCheck(t) || Boolean(t.required);
  const guarded = guardedSkip;
  const appendOrUndo = (/** @type {string} */ id, /** @type {any} */ chain, /** @type {any} */ ev, /** @type {any} */ opt) => { try { const e = cfg.log.append(chain, ev, opt); pending.delete(id); return e; } catch (e) { unstage(id); throw e; } };
  const note = (/** @type {any} */ chain, /** @type {string} */ type, /** @type {any} */ t, /** @type {any} */ data, /** @type {any} */ decision) => {
    // The event carries the task as it stands after the change (never the canonical body: that holds the draft, which the log must not), so the log alone rebuilds every task at the next start (`rebuild` below): tasks used to live in memory only.
    try { const now = tasks.get(t.id) || t; const e = cfg.log.append(chain, { type, sv: 1, subject: urnOf(cfg.space, t.id), data: { ...data, state: t.state, task: now } }, decision ? { decision } : {}); pending.delete(t.id); return e; } catch (e) { unstage(t.id); throw e; }
  };

  /** The transition table is the one source: ask it which rule applies, and check the caller's role is the rule's. */
  function rule(/** @type {any} */ t, /** @type {string} */ to, /** @type {string} */ by) {
    const g = to === "skipped" ? guardedSkip(t) : needsCheck(t);
    const rows = TASK_TRANSITIONS.filter(x => x.from === t.state && x.to === to && (x.guarded === undefined || x.guarded === g));
    if (!rows.length) throw new KernelError("bad_state", `a task that is ${t.state} cannot go to ${to}`);
    const r = rows.find(x => x.by === by);
    if (!r) throw new KernelError("not_allowed", `${to} is not ${by}'s to do`);
    return r;
  }
  const isDoer = (/** @type {any} */ chain, /** @type {any} */ t) => {
    const a = acting(chain);
    if (!same(a, t.doer)) return false;
    // A task an assistant works carries its assigner in the chain, so an assigner cannot borrow a broader teammate (R6-9).
    if (t.doer.kind === "agent") return chain.hops.length >= 2 && same(chain.hops[0].actor, t.assigned_by);
    if (t.doer.kind === "person") return isExactlyPerson(chain);
    return true;
  };
  const checkersOf = (/** @type {any} */ t) => {
    const c = t.checker;
    const list = !c ? [] : c.role ? roleHolders(c.role) : [c];
    return list.filter((/** @type {any} */ a) => a && a.kind === "person" && !same(a, t.doer));
  };
  const personOf = (/** @type {any} */ chain) => (isExactlyPerson(chain) ? chain.hops[0].actor : null);
  const promote = (/** @type {any} */ chain) => {
    for (const t of [...tasks.values()]) {
      if (t.state !== "waiting") continue;
      if ((t.depends_on || []).every((/** @type {string} */ d) => { const x = tasks.get(d); return x && (x.state === "done" || (x.state === "skipped" && !x.required)); })) {
        rule(t, "ready", "dependencies_met");
        note(chain, "task.readied", put(t, { state: "ready" }), { why: "dependencies met" });
      }
    }
  };

  /** @type {any} */ let api;
  const decideOnce = (/** @type {any} */ c, /** @type {string} */ i, /** @type {any} */ a) => api._decideOnce(c, i, a);
  const requestOnce = (/** @type {any} */ c, /** @type {any} */ s) => api._requestOnce(c, s);
  api = {
    async request(/** @type {any} */ chain, /** @type {any} */ spec, /** @type {{ idem?: string }} */ opts = {}) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      return idem.once(chain, "request", opts.idem, spec, () => requestOnce(chain, spec));
    },

    async _requestOnce(/** @type {any} */ chain, /** @type {any} */ spec) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      await gate(chain, "tasks.request", urnOf(cfg.space, "new"));
      for (const k of Object.keys(spec || {})) if (!REQUEST_KEYS.has(k)) throw new KernelError("bad_input", `a task cannot be given ${k}: the kernel writes it`);
      if (typeof spec.title !== "string" || !spec.title.trim()) throw new KernelError("bad_input", "a task needs a title");
      if (!spec.output || !OUTPUTS.has(spec.output.kind)) throw new KernelError("bad_input", "a task needs a declared output");
      if (spec.source !== undefined && !SOURCES.has(spec.source) && !(SERVICE_SOURCES.has(spec.source) && chain.hops[chain.hops.length - 1].actor.kind === "service")) throw new KernelError("bad_input", "that source is the kernel's");
      const doer = spec.doer;
      if (!doer || !ACTOR_KINDS.includes(doer.kind) || typeof doer.id !== "string" || doer.space !== cfg.space) throw new KernelError("bad_input", "a task needs one doer in this space");
      if (!cfg.members.has(doer)) throw new KernelError("not_a_member", "the doer is not a member of this space");
      let checker = spec.checker;
      const out = spec.output.kind === "sent";
      if (!checker && out) checker = cfg.approver ? cfg.approver(chain) : undefined;
      if (out && !checker) throw new KernelError("no_checker", "a send needs a checker and none could be assigned");
      const probe = { doer, checker };
      const persons = checkersOf(/** @type {any} */ probe);
      if (checker && !persons.length) throw new KernelError(checker.role ? "no_checker" : "same_actor", checker.role ? "no person holds that role" : "the checker must be a person other than the doer");
      for (const d of spec.depends_on || []) if (!tasks.has(d)) throw new KernelError("bad_input", "a dependency does not exist");
      const waiting = (spec.depends_on || []).some((/** @type {string} */ d) => { const x = tasks.get(d); return !(x.state === "done" || (x.state === "skipped" && !x.required)); });
      const id = mintUuid(clock());
      const t = freeze({
        id, space: cfg.space, title: spec.title.trim().slice(0, 200), ...(spec.record ? { record: spec.record } : {}), ...(spec.stage ? { stage: spec.stage } : {}),
        source: spec.source || "manual", doer: freeze({ ...doer }), ...(spec.helpers ? { helpers: freeze([...spec.helpers]) } : {}),
        ...(checker ? { checker: freeze({ ...checker }) } : {}), output: freeze({ ...spec.output }),
        ...(spec.how ? { how: spec.how } : {}), ...(spec.template ? { template: spec.template } : {}), ...(spec.inputs ? { inputs: freeze([...spec.inputs]) } : {}),
        ...(spec.depends_on ? { depends_on: freeze([...spec.depends_on]) } : {}), ...(spec.due ? { due: spec.due } : {}), ...(spec.required ? { required: true } : {}), ...(spec.note ? { note: String(spec.note).slice(0, FIX_CAP) } : {}),
        ...(spec.flow !== undefined ? { flow: String(spec.flow).slice(0, 200) } : {}), ...(spec.form !== undefined ? { form: opaque(spec.form) } : {}),
        ...(spec.session ? { session: spec.session } : {}), ...(spec.escalate_after ? { escalate_after: spec.escalate_after } : {}), ...(spec.escalate_to ? { escalate_to: spec.escalate_to } : {}),
        state: waiting ? "waiting" : "ready", assigned_by: freeze({ ...chain.hops[0].actor }),
        labels: freeze({ trust: chain.labels.trust, red: chain.labels.red, source_spaces: freeze([...chain.labels.source_spaces]) }),
        created_at: clock(), updated_at: clock(),
      });
      stage(id, t);
      note(chain, "task.created", t, { doer: `${doer.kind}:${doer.id}`, output: t.output.kind, checkers: persons.length });
      return t;
    },

    async get(/** @type {any} */ chain, /** @type {string} */ id) {
      try { await gate(chain, "tasks.read", urnOf(cfg.space, id)); } catch (e) { if (e instanceof KernelError && e.code === "not_found") return null; throw e; }
      return tasks.get(id) || null;
    },

    /**
     * The tasks this chain may read, filtered: by record, doer id, checker id (a named checker or one of the persons a role resolves to) and state. Each task goes through the same `tasks.read`
     * gate `get` uses, so a task the chain may not read is absent, never marked. Oldest first.
     * @param {any} chain @param {{ record?: string, doer?: string, checker?: string, state?: string[] }} [q]
     */
    async list(chain, q = {}) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      const out = [];
      for (const t of [...tasks.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (q.record && t.record !== q.record) continue;
        if (q.doer && canon(t.doer.id) !== canon(q.doer)) continue;
        if (q.checker && !checkersOf(t).some((/** @type {any} */ c) => canon(c.id) === canon(q.checker))) continue;
        if (Array.isArray(q.state) && q.state.length && !q.state.includes(t.state)) continue;
        try { await gate(chain, "tasks.read", urnOf(cfg.space, t.id)); } catch (e) { if (e instanceof KernelError && e.code === "not_found") continue; throw e; }
        out.push(t);
      }
      return out;
    },

    async start(/** @type {any} */ chain, /** @type {string} */ id) {
      await gate(chain, "tasks.work", urnOf(cfg.space, id));
      const t = get_(id);
      if (t.kernel || !isDoer(chain, t)) throw new KernelError("not_allowed", "only the doer starts a task");
      rule(t, "working", "doer");
      const n = put(t, { state: "working" });
      note(chain, "task.started", n, {});
      return n;
    },

    async complete(/** @type {any} */ chain, /** @type {string} */ id, /** @type {any} */ evidence) {
      const d = await gate(chain, "tasks.work", urnOf(cfg.space, id));
      const t = get_(id);
      if (t.kernel || !isDoer(chain, t)) throw new KernelError("not_allowed", "only the doer finishes a task");
      // The kernel checks the declared output before anything moves: an assistant cannot mark a task done while the check fails.
      const to = needsCheck(t) ? "needs_check" : "done";
      rule(t, to, "kernel_after_output_check");
      const check = await checkOutput(t, evidence, cfg.facts || {});
      if (!check.ok) throw new KernelError("output_check_failed", check.why || "the output is not there yet");
      if (to === "done") {
        const answer = answerOf(t, evidence);
        const n = put(t, { state: "done", ...(answer !== undefined ? { answer } : {}) });
        note(chain, "task.completed", n, { output: t.output.kind, ...(answer !== undefined ? { answer } : {}) });
        promote(chain);
        return n;
      }
      // Guarded: build what the approval will cover. The decision it binds to is the outward action's own, when there is one.
      let body;
      let decision = d.decision;
      if (outward(t)) {
        // Cloned and frozen now: what is hashed is exactly what the checker will see and what is released (K4 item 5).
        const ev = deepFreeze(structuredClone(evidence));
        const risk = cfg.authorizer.actions && cfg.authorizer.actions.get(ev.action) && cfg.authorizer.actions.get(ev.action).risk;
        if (!risk || !String(risk).startsWith("outward")) throw new KernelError("bad_input", "a send must name an outward action");
        for (const s of ev.payload.sealed_slots || []) if (t.record && s.record !== t.record) throw new KernelError("bad_input", "a sealed slot names a record other than the task's");
        // The delivery the approver is shown is the sink and the recipients on the card, and nothing else: a hidden `to` is refused (N1).
        const dl = ev.payload.delivery;
        if (dl !== undefined) {
          const addrs = (Array.isArray(ev.payload.recipients) ? ev.payload.recipients : []).map((/** @type {any} */ r) => String(r.address).trim().toLowerCase());
          if (typeof dl !== "object" || dl === null || typeof dl.sink !== "string" || Object.keys(dl).some(k => k !== "sink" && k !== "to") || (dl.to !== undefined && (!Array.isArray(dl.to) || dl.to.some((/** @type {any} */ x) => !addrs.includes(String(x).trim().toLowerCase()))))) throw new KernelError("bad_input", "a delivery names a sink and only the recipients shown");
        }
        const o = await cfg.authorizer.authorize({ chain, action: ev.action, resource: ev.resource });
        if (o.effect === "deny") throw new KernelError("not_found", "no such action", o.reason);
        decision = o.decision;
        // The facts the card shows are the kernel's: recipients checked against the record's own contact points, slot classes read from the vault. Whatever cannot be resolved shows as unverified.
        const facts = await resolveFacts(ev);
        body = deepFreeze({ action: ev.action, resource: ev.resource, payload: ev.payload, facts });
      } else body = deepFreeze({ task: id, kind: t.output.kind, evidence: deepFreeze(structuredClone(evidence)) });
      const payload = freeze({ payload_hash: sha256(canonical(body)), decision, draft_hash: sha256(canonical(evidence)) });
      bodies.set(id, body);
      const n = put(t, { state: "needs_check", payload });
      note(chain, "task.needs-check", n, { payload_hash: payload.payload_hash, decision, ...(["decision", "fields", "note"].includes(t.output.kind) ? { evidence: body.evidence } : {}) });
      return n;
    },

    /** A change to a draft that is waiting for its checker voids the approval and puts the task back to ready (R6-3). */
    async revise(/** @type {any} */ chain, /** @type {string} */ id, /** @type {string} */ reason) {
      await gate(chain, "tasks.work", urnOf(cfg.space, id));
      const t = get_(id);
      if (t.kernel || !isDoer(chain, t)) throw new KernelError("not_allowed", "only the doer changes a draft");
      if (t.state !== "needs_check") throw new KernelError("bad_state", "there is nothing waiting for a check");
      if (deciding.has(id)) throw new KernelError("bad_state", "that task is being decided");
      rule(t, "ready", "doer");
      const { payload: _p, ...rest } = t;
      stage(id, freeze({ ...rest, state: "ready", updated_at: clock() }));
      note(chain, "task.voided", tasks.get(id), { reason: String(reason || "").slice(0, 200) });
      bodies.delete(id);
      return tasks.get(id);
    },

    /** Human-only: exactly one person, a checker of this task and not its doer, with a signer's proof over this payload, once. */
    async decide(/** @type {any} */ chain, /** @type {string} */ id, /** @type {{ outcome: "approved" | "rejected", reason?: string, proof?: any, proofs?: { use?: any } }} */ a) {
      // Taken before any await: a second decide on this task, with the same proof or another, is refused while one is running (K4 item 1).
      if (deciding.has(id)) throw new KernelError("bad_state", "that task is being decided");
      deciding.add(id);
      try { return await decideOnce(chain, id, a); } finally { deciding.delete(id); }
    },

    async _decideOnce(/** @type {any} */ chain, /** @type {string} */ id, /** @type {any} */ a) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      if (!isExactlyPerson(chain)) throw new KernelError("chain_not_person", "only a person on their own can decide a task");
      const person = chain.hops[0].actor;
      const d = await gate(chain, "tasks.decide", urnOf(cfg.space, id));
      const t = get_(id);
      if (t.state !== "needs_check") throw new KernelError("bad_state", "that task is not waiting for a check");
      // The checker is resolved to people when the task is made and again now; an assistant that holds the role is filtered out.
      if (!checkersOf(t).some((/** @type {any} */ c) => same(c, person)) || same(person, t.doer)) throw new KernelError("not_allowed", "you are not this task's checker");
      if (a.outcome === "rejected") {
        if (typeof a.reason !== "string" || !a.reason.trim()) throw new KernelError("bad_input", "a rejection needs a reason");
        rule(t, "ready", "checker");
        const { payload: _p, ...rest } = t;
        stage(id, freeze({ ...rest, state: "ready", outcome: "rejected", updated_at: clock() }));
        note(chain, "task.rejected", tasks.get(id), { reason: a.reason.slice(0, 400) }, d.decision);
        bodies.delete(id);
        return tasks.get(id);
      }
      if (a.outcome !== "approved") throw new KernelError("bad_input", "decide approves or rejects");
      // The sealed-use proof is checked by the sealing process when it is used; here only its shape and window, so a garbage or expired one is
      // refused now and the approver is not told a complete approval is one that cannot be used (K4 item 12).
      const up = a.proofs && a.proofs.use;
      if (up !== undefined && up !== null && !(typeof up === "object" && typeof up.signature === "string" && typeof up.key_id === "string" && typeof up.nonce === "string" && Number.isFinite(up.issued_at) && up.expires_at > clock())) throw new KernelError("bad_input", "the sealed-use confirmation is malformed or already expired");
      const body = bodies.get(id);
      const p = a.proof;
      // The approval covers the canonical payload as the kernel stored it, recomputed now, never the doer's description.
      if (!t.payload || !body || sha256(canonical(body)) !== t.payload.payload_hash) throw new KernelError("needs_presence", "this task has no approvable payload");
      // One verifier: the sealing process's. The signed fields are the task, the canonical payload hash and the decision it is bound to.
      if (!p || await cfg.presence.check({ chain, op: "task.decide", fields: { task: id, payload_hash: t.payload.payload_hash, decision: t.payload.decision }, proof: p })) throw new KernelError("needs_presence", "approving needs your confirmation on this device, over exactly this");
      rule(t, "done", "checker_approval");
      if (outward(t) && cfg.release) {
        try { await cfg.release(t, body, { person: person.id, key_id: p.key_id }); } catch (e) { throw new KernelError("unavailable", "it could not be sent, so it was not approved as sent", String(e && /** @type {any} */ (e).message)); }
      }
      const answer = !outward(t) && body && body.evidence !== undefined ? answerOf(t, body.evidence) : undefined;
      const n = put(t, { state: "done", outcome: "approved", ...(answer !== undefined ? { answer } : {}) });
      note(chain, "task.approved", n, { payload_hash: t.payload.payload_hash, key_id: p.key_id, ...(n.answer !== undefined ? { answer: n.answer } : {}) }, d.decision);
      approvedBy.set(id, { approver_chain: chain, use_proof: a.proofs && a.proofs.use ? a.proofs.use : null });
      const proposed = proposals.get(id);
      if (proposed) { const pt = tasks.get(proposed); if (pt && (pt.state === "ready" || pt.state === "stuck")) { rule(pt, "skipped", "proposal_for_person_with_presence"); note(chain, "task.skipped", put(pt, { state: "skipped" }), { by: "approved proposal" }); } }
      promote(chain);
      return n;
    },

    /** The doer cannot go on. Its fix is quoted text with no power; a one-tap fix comes only from what the kernel observed. */
    async stuck(/** @type {any} */ chain, /** @type {string} */ id, /** @type {{ reason: string, suggested_fix?: string }} */ info) {
      await gate(chain, "tasks.work", urnOf(cfg.space, id));
      const t = get_(id);
      if (!isDoer(chain, t)) throw new KernelError("not_allowed", "only the doer flags its task as stuck");
      rule(t, "stuck", "assistant_or_detection");
      const n = put(t, { state: "stuck", stuck: freeze({ reason: String(info.reason || "").slice(0, FIX_CAP), since: clock(), ...(info.suggested_fix ? { suggested_fix: freeze({ text: String(info.suggested_fix).slice(0, FIX_CAP) }) } : {}) }) });
      note(chain, "task.stuck", n, { reason: n.stuck.reason });
      return n;
    },

    /** Kernel detection: the same permission refused three times in a task makes it stuck with a fix built from the denials (R6-7). */
    async observeDenial(/** @type {any} */ chain, /** @type {string} */ id, /** @type {{ action: string, resource: string }} */ d) {
      // Only the kernel's own module chain reports a denial: a caller with the object cannot force a task to stuck (K4 item 10).
      if (!isChain(chain) || chain.hops.length !== 1 || chain.hops[0].actor.kind !== "service" || !["tasks", "gateway", "kernel"].includes(chain.hops[0].actor.id)) throw new KernelError("not_allowed", "only the kernel reports a denial");
      const t = get_(id);
      if (t.state !== "working" && t.state !== "ready") return t;
      const k = `${id}|${d.action}|${d.resource}`;
      const n = (denials.get(k) || 0) + 1;
      denials.set(k, n);
      if (n < DENIALS_TO_STUCK) return t;
      const key = `${t.doer.kind}:${t.doer.id}|${d.action}|${d.resource}`;
      const cooling = (coolDown.get(key) || 0) > clock();
      rule(t, "stuck", "assistant_or_detection");
      const out = put(t, { state: "stuck", stuck: freeze({ reason: `${d.action} was refused ${n} times`, since: clock(),
        ...(cooling ? {} : { suggested_fix: freeze({ text: `Allow ${t.doer.id} to ${d.action} on ${d.resource}, or reassign.`, action: freeze({ kind: "grant_request", resource: d.resource, action_name: d.action }) }) }) }) });
      appendOrUndo(id, cfg.chains.fromFacts({ kind: "module", module: "tasks", first_party: true }), { type: "task.stuck", sv: 1, subject: urnOf(cfg.space, id), data: { reason: out.stuck.reason, detected: true, state: "stuck" } });
      return out;
    },

    /** A person declines a kernel-built fix: it is not offered again for the same action and resource for 7 days. */
    async declineFix(/** @type {any} */ chain, /** @type {string} */ id) {
      if (!isExactlyPerson(chain)) throw new KernelError("chain_not_person", "only a person declines a fix");
      await gate(chain, "tasks.decide", urnOf(cfg.space, id));
      const t = get_(id);
      const a = t.stuck && t.stuck.suggested_fix && t.stuck.suggested_fix.action;
      if (a) coolDown.set(`${t.doer.kind}:${t.doer.id}|${a.action_name}|${a.resource}`, clock() + COOL_DOWN_MS);
      return t;
    },

    /** Unblock or reassign: the person responsible for the doer, or a person with presence. Never the doer. */
    async unblock(/** @type {any} */ chain, /** @type {string} */ id, /** @type {{ reassign_to?: any, proof?: any }} */ o = {}) {
      if (!isExactlyPerson(chain)) throw new KernelError("chain_not_person", "only a person unblocks a task");
      const person = chain.hops[0].actor;
      await gate(chain, "tasks.work", urnOf(cfg.space, id));
      const t = get_(id);
      if (same(person, t.doer)) throw new KernelError("not_allowed", "a doer cannot unblock its own task");
      rule(t, "ready", "responsible_person_or_person_with_presence");
      const responsible = cfg.responsible ? cfg.responsible(person, t.doer) : false;
      if (!responsible) {
        if (!o.proof || await cfg.presence.check({ chain, op: "task.unblock", fields: { task: id, reassign_to: o.reassign_to || null }, proof: o.proof })) throw new KernelError("needs_presence", "you are not responsible for this doer: unblocking needs your confirmation on this device");
      }
      let doer = t.doer;
      if (o.reassign_to) {
        if (!cfg.members.has(o.reassign_to) || o.reassign_to.space !== cfg.space) throw new KernelError("not_a_member", "that doer is not a member of this space");
        if (checkersOf({ doer: o.reassign_to, checker: t.checker }).length === 0 && t.checker) throw new KernelError("same_actor", "the new doer would be the only checker");
        doer = freeze({ ...o.reassign_to });
      }
      const { stuck: _s, ...rest } = t;
      stage(id, freeze({ ...rest, doer, state: "ready", updated_at: clock() }));
      note(chain, "task.unblocked", tasks.get(id), { reassigned: Boolean(o.reassign_to) });
      return tasks.get(id);
    },

    /** Skip: the doer's or a person's act for an unguarded task; for a guarded one it raises a proposal a person with presence decides. */
    async skip(/** @type {any} */ chain, /** @type {string} */ id, /** @type {string} */ reason) {
      await gate(chain, "tasks.work", urnOf(cfg.space, id));
      const t = get_(id);
      if (!guarded(t)) {
        if (!isDoer(chain, t) && !personOf(chain)) throw new KernelError("not_allowed", "only the doer or a person skips a task");
        rule(t, "skipped", "doer_or_person");
        const n = put(t, { state: "skipped" });
        note(chain, "task.skipped", n, { reason: String(reason || "").slice(0, 200) });
        promote(chain);
        return n;
      }
      rule(t, "skipped", "proposal_for_person_with_presence");
      const who = cfg.responsibleFor ? cfg.responsibleFor(t.doer) : t.assigned_by;
      if (!who || who.kind !== "person") throw new KernelError("no_checker", "no person to decide a skip");
      const body = deepFreeze({ op: "skip", task: id, title: t.title.slice(0, 80), reason: String(reason || "").slice(0, 200) });
      const pid = mintUuid(clock());
      const decision = (await cfg.authorizer.authorize({ chain, action: "tasks.work", resource: urnOf(cfg.space, id) })).decision;
      const proposal = freeze({
        id: pid, space: cfg.space, title: `Skip "${t.title.slice(0, 80)}"?`, source: "manual", kernel: true, doer: SYSTEM, checker: freeze({ ...who }),
        output: freeze({ kind: "decision" }), state: "needs_check", assigned_by: freeze({ ...chain.hops[0].actor }),
        payload: freeze({ payload_hash: sha256(canonical(body)), decision }), labels: freeze({ trust: chain.labels.trust, red: chain.labels.red, source_spaces: freeze([...chain.labels.source_spaces]) }), created_at: clock(), updated_at: clock(),
      });
      stage(pid, proposal); bodies.set(pid, body); proposals.set(pid, id);
      note(chain, "task.created", proposal, { proposal_for: id });
      return { proposal };
    },

    async needsYou(/** @type {any} */ chain) {
      const person = personOf(chain);
      if (!person) return [];
      await gate(chain, "tasks.read", urnOf(cfg.space, "mine"));
      return [...tasks.values()].filter(t =>
        (t.state === "needs_check" && checkersOf(t).some((/** @type {any} */ c) => same(c, person)))
        || (t.state === "ready" && same(t.doer, person))
        || (t.state === "stuck" && (same(t.doer, person) || (cfg.responsible ? cfg.responsible(person, t.doer) : false)))).sort((a, b) => (a.id < b.id ? -1 : 1));
    },

    /** The card the checker sees, built from the canonical payload. */
    async card(/** @type {any} */ chain, /** @type {string} */ id) {
      await gate(chain, "tasks.read", urnOf(cfg.space, id));
      const t = get_(id);
      const b = bodies.get(id);
      return buildCard(t, b, { action_label: b && b.action && cfg.authorizer.actions && cfg.authorizer.actions.get(b.action) ? cfg.authorizer.actions.get(b.action).label : undefined });
    },

    /**
     * What an approved task lets the sealing step do: the approver's own chain, the sealed-use proof they signed, and the canonical
     * body the approval covered (so the refs, slots, template and record are the ones the person saw). Null until approved.
     */
    approvalFor(/** @type {string} */ id) {
      const t = tasks.get(id), who = approvedBy.get(id), body = bodies.get(id);
      if (!t || t.state !== "done" || t.outcome !== "approved" || !who || !body || sha256(canonical(body)) !== t.payload.payload_hash) return null;
      return { approver_chain: who.approver_chain, use_proof: who.use_proof, body, payload_hash: t.payload.payload_hash, doer: t.doer, approved_at: t.updated_at };
    },

    /**
     * Does this approved held-act task cover exactly this act by this chain? Pure (it consumes nothing: the gateway counts the use once). The chain's acting actor must
     * be the task's doer, and the approved body's action and resource must be the ones asked.
     * @param {{ id: string, chain: any, action: string, resource: string }} q
     */
    approvedAct(q) {
      const a = api.approvalFor(q.id), t = tasks.get(q.id);
      return Boolean(a && t && !usedApprovals.has(q.id) && clock() - t.updated_at <= APPROVAL_MAX_AGE && a.body.action === q.action && a.body.resource === q.resource && same(acting(q.chain), t.doer) && approverOk(q.rule, approvedBy.get(q.id)));
    },
    /** The same check, and when it holds the approval is spent in the same step: what `authorize` calls, so a held act is allowed once, within a day, by its doer. */
    useApproval(q) {
      if (!api.approvedAct(q)) return false;
      usedApprovals.add(q.id);
      return true;
    },

    /** Did a checker approve exactly this payload? Also true for a sealed use the approved payload listed by its hash. */
    approved(/** @type {string} */ id, /** @type {string} */ payload_hash) {
      const t = tasks.get(id);
      if (!t || t.state !== "done" || t.outcome !== "approved" || !t.payload) return false;
      if (t.payload.payload_hash === payload_hash) return true;
      const b = bodies.get(id);
      return Boolean(b && b.payload && Array.isArray(b.payload.sealed_slots) && b.payload.sealed_slots.some((/** @type {any} */ s) => s.use_hash === payload_hash));
    },
  };
  // The tasks the log holds, at start: the newest event of each task carries the task as it was after that change (never its canonical body, which holds the draft). A task that was waiting for a check had its draft only in memory: it goes back to `ready` so its doer makes the draft again, rather than waiting for a card nobody can open. An event from before this was written (no `task`) adds nothing.
  /** @type {Map<string, any>} */ const evidence = new Map();
  try {
    const f = { type: "task.*" };
    const evs = cfg.log && typeof cfg.log.read === "function" ? (cfg.log.iterate ? [...cfg.log.iterate(f)] : cfg.log.read(f)) : [];
    for (const e of evs) {
      const d = e && e.data;
      if (!d || !d.task || typeof d.task.id !== "string" || d.task.space !== cfg.space) continue;
      tasks.set(d.task.id, deepFreeze(structuredClone(d.task)));
      if (e.type === "task.created" && typeof d.proposal_for === "string") proposals.set(d.task.id, d.proposal_for);
      if (e.type === "task.needs-check" && d.evidence !== undefined) evidence.set(d.task.id, d.evidence);
    }
    // A decision, fields or note waiting for its check has its answer in its needs-check event (as a completed one always did): its canonical body is rebuilt from it, and used only if it hashes to what was shown.
    for (const [id, t] of tasks) if (t.state === "needs_check" && !bodies.has(id) && t.payload && evidence.has(id) && ["decision", "fields", "note"].includes(t.output.kind)) {
      const body = deepFreeze({ task: id, kind: t.output.kind, evidence: deepFreeze(structuredClone(evidence.get(id))) });
      if (sha256(canonical(body)) === t.payload.payload_hash) bodies.set(id, body);
    }
    for (const [id, t] of tasks) if (t.state === "needs_check" && !bodies.has(id)) { const { payload, ...rest } = t; tasks.set(id, deepFreeze({ ...rest, state: "ready" })); }
  } catch { /* a log that cannot be read leaves no tasks, never a half set */ tasks.clear(); bodies.clear(); proposals.clear(); }
  const { _decideOnce, _requestOnce, ...pub } = api;
  const frozen = Object.freeze(pub);
  VIEWS.set(frozen, (/** @type {string} */ record, /** @type {string} */ stage) => [...tasks.values()].filter(t => t.record === record && t.stage === stage).map(t => ({ title: t.title, state: t.state, required: Boolean(t.required) })));
  return frozen;
}
