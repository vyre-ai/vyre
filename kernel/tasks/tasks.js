// kernel/tasks/tasks.js: tasks with approval (contract 9.4, DESIGN-tasks.md; invariant 4). A task has one doer and an
// optional checker; the kernel owns every transition (the table is data in the contracts) and every field that carries
// approval truth. The doer's words are never authority: a task is moved only by the actor its rule names, an output is
// checked by the kernel before anything advances, and an approval is accepted only from a chain that is exactly one
// person, with a hardware-signer proof over the exact payload, the decision and the chain, once.
import { canonical, sha256 } from "../core/canonical.js";
import { mintUuid } from "../core/ids.js";
import { isChain, isExactlyPerson, actsAsPerson } from "../core/chain.js";
import { isStaffRole } from "../../lib/roles/staff.js";
import { createGate } from "../core/gate.js";
import { KernelError } from "../core/errors.js";
import { TASK_TRANSITIONS, TASK_REOPENS, ACTOR_KINDS } from "../contracts/index.js";
import { buildCard } from "./card.js";
import { createScrub } from "./scrub.js";
import { createIdem } from "../core/idem.js";
import { TASK } from "../../records/core-types.js";

/** The fields a task's own calls set (and `records.update` routes through `tasks.edit`); every other field of the type is the person's, custom, and plain. */
const TASK_PERSON_FIELDS = Object.freeze(["title", "note", "due", "parent", "project"]);
import { createMemoryStore } from "../store/memory.js";
import { requestedFor } from "../../lib/chain-person.js";

/** The actions task calls register with the authorizer (contract 6.1). */
export const TASK_ACTIONS = Object.freeze([
  { action: "tasks.request", resource_type: "task", risk: "write", label: "give someone a task", gloss: "Assign work to a person or an assistant." },
  { action: "tasks.read", resource_type: "task", risk: "read", label: "see tasks", gloss: "Open tasks." },
  { action: "tasks.work", resource_type: "task", risk: "write", label: "work on tasks", gloss: "Start, finish or flag a task you were given." },
  { action: "tasks.decide", resource_type: "task", risk: "write", label: "approve or reject", gloss: "Decide a task waiting for your check." },
  { action: "tasks.withdraw", resource_type: "task", risk: "write", label: "withdraw a task past its due time", gloss: "The Flows service ends a task its step gave when the step's due time has passed." },
].map(a => Object.freeze(a)));

const REQUEST_KEYS = new Set(["fields", "project", "parent", "title", "record", "stage", "source", "doer", "helpers", "checker", "approver", "reviewer", "quorum", "output", "how", "template", "inputs", "depends_on", "due", "escalate_after", "escalate_to", "required", "note", "session", "flow", "form", "instructions", "skills", "space_skills", "reviewer_quorum"]);
const SOURCES = new Set(["manual", "assistant_request", "flow_step"]);
/** Sources only a service chain may name (the kernel's own modules and Flows, never a person or a model): the task is the continuation of a session in a Space. */
const SERVICE_SOURCES = new Set(["continue_in_space"]);
const OUTPUTS = new Set(["fields", "note", "draft", "sent", "decision", "file"]);
const FIX_CAP = 400;
const GUIDES_MAX = 65536;   // a task's instructions and pinned checklists together, in canonical JSON
const COOL_DOWN_MS = 7 * 24 * 3600_000;
const DENIALS_TO_STUCK = 3;

/** The kernel's own read of a record's stage tasks (the gateway's stage gate). Held beside the public api, not on it: a surface cannot reach it. */
const VIEWS = new WeakMap();
/** @param {any} api @param {string} record @param {string} stage @returns {{ title: string, state: string, required: boolean }[]} */
/** Whether a task is still open (not done or skipped). A task the kernel does not hold counts as CLOSED: a grant lent for a task nobody can find holds nothing (fail closed). Held beside the public api like the stage view. */
const LIVE = new WeakMap();
/** @param {any} api @param {string} id */
export const taskOpen = (api, id) => { const v = LIVE.get(api); return v ? v(id) : false; };
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
 *   skills?: { pin(id: string, chain: any, spaceOnly?: boolean): Promise<{ hash: string, checklist: string[] } | null> },   // a Space skill by id: its content hash and checklist now, for a slot to pin
 *   facts?: { record?: (urn: string) => Promise<any>, exists?: (urn: string) => Promise<boolean> },
 *   release?: (task: any, payload: any, by: { person: string, key_id: string }) => void | Promise<void>, chains: any, clock?: () => number }} cfg
 *   chains: the kernel's chain builder (for events the kernel itself writes, such as stuck detection); release: the held act's egress, run only after a verified approval.
 */
/** The refusal for a proof that did not stand: the code is needs_presence, and `detail.reason` is the verifier's stable code for why (expired, replayed, wrong_decision, wrong_payload, unknown_key, software_key, ...). The caller made the proof, so the reason tells it nothing it did not send; the message stays our own text. @param {string} message @param {string} reason */
const needsPresence = (message, reason) => Object.assign(new KernelError("needs_presence", message), { detail: { reason: /^[a-z][a-z0-9_]{1,40}$/.test(String(reason)) ? String(reason) : "refused" } });

export function createTasks(cfg) {
  const clock = cfg.clock || Date.now;
  /** A person id as the Space knows them now: the owner an adoption replaced is the identity that replaced them, so a task keyed by the old id is still its person's. */
  const canon = (/** @type {string} */ id) => (typeof cfg.canonicalPerson === "function" ? cfg.canonicalPerson(id) : id);
  const same = (/** @type {any} */ a, /** @type {any} */ b) => Boolean(a && b) && a.kind === b.kind && (a.kind === "person" ? canon(a.id) === canon(b.id) : a.id === b.id);
  const { gate } = createGate({ authorizer: cfg.authorizer, log: cfg.log, enforce: cfg.enforce });
  const roleHolders = cfg.roleHolders || (() => []);
  /** @type {Map<string, any>} */ const tasks = new Map();
  /** @type {Map<string, any>} */ const bodies = new Map();
  /** The task store for free text: durable when the kernel gives one (`cfg.texts`), else memory (a test rig). */
  const texts = cfg.texts || (() => { /** @type {Map<string, any>} */ const m = new Map(); return { get: (/** @type {string} */ id) => m.get(id), set: (/** @type {string} */ id, /** @type {any} */ v) => { if (v === undefined) m.delete(id); else m.set(id, v); }, drop: (/** @type {string} */ id) => { m.delete(id); }, all: () => [...m.entries()] }; })();
  /** A standing always-ask rule names who must approve: that person, or someone who holds that role now. No rule: any approval stands. @param {{ approver?: { person?: string, role?: string } } | undefined} rule @param {{ approver_chain: any } | undefined} by */
  const approverOk = (rule, by) => {
    if (!rule || !rule.approver) return true;
    const h = by && by.approver_chain && by.approver_chain.hops && by.approver_chain.hops.length === 1 ? by.approver_chain.hops[0].actor : null;
    if (!h || h.kind !== "person") return false;
    if (rule.approver.person !== undefined) return canon(h.id) === canon(rule.approver.person);
    return Boolean(cfg.members && typeof cfg.members.roleOf === "function" && cfg.members.roleOf(h) === rule.approver.role);
  };
  /** AT-1: an approval is spent only while the person who gave it still holds the right to: still a member of the Space, and not demoted to a role that cannot decide a task (a temp). A removed approver's yes does not pass inside the day it is good for. */
  const approverStands = (/** @type {any} */ by) => {
    const h = by && by.approver_chain && by.approver_chain.hops && by.approver_chain.hops.length >= 1 ? by.approver_chain.hops[0].actor : null;
    if (!h || h.kind !== "person") return false;
    // a members port with no `has` cannot say the approver still stands: fail closed (the real grants store always has one)
    if (!cfg.members || typeof cfg.members.has !== "function" || !cfg.members.has(h)) return false;
    const role = typeof cfg.members.roleOf === "function" ? cfg.members.roleOf(h) : null;
    return role !== "temp";
  };
  /** @type {Map<string, { approver_chain: any, use_proof: any }>} who approved a task and the sealed-use proof they signed with it (the sealing process verifies that proof itself) */ const approvedBy = new Map();
  /** @type {Map<string, string>} proposal id -> the task it proposes to skip */ const proposals = new Map();
  /** @type {Map<string, number>} */ const denials = new Map();
  const idem = createIdem({ clock });
  /** @type {Set<string>} approvals already spent on an act */ const usedApprovals = new Set();
  /** @type {Set<string>} tasks being decided right now: a second decide on one is refused before it can release again */ const deciding = new Set();
  /** @type {Map<string, number>} */ const coolDown = new Map();

  // ---- The task record (DESIGN-tasks-records) -----------------------------------------------------------------------------------------------------------------------------------------------
  // With a record port (`cfg.records`, the Space's store) a task's title, note, due time, parent, project and every custom field live in its `task` record, the source of truth; what the kernel
  // keeps is what decides who may act. `status` on the record mirrors the kernel's state and is written only here. Reads lay the record's fields over the kernel's task.
  // The Space's store (the kernel hands it in); a bare caller (a test rig) gets a memory store with the type defined.
  const recs = cfg.records || createMemoryStore({ clock: cfg.clock });
  const recsReady = cfg.records ? Promise.resolve() : Promise.resolve(recs.define({ add_types: [TASK] }));
  const RESERVED = new Set([...TASK_PERSON_FIELDS, "status", "stage", "record"]);
  const CACHE_MS = 5000;
  /** @type {Set<string>} tasks whose status the record has not been told yet */ const dirty = new Set();
  /** @type {Map<string, { at: number, rec: any }>} */ const recCache = new Map();
  const isoOf = (/** @type {number} */ ms) => new Date(ms).toISOString();
  async function recGet(/** @type {string} */ id, /** @type {boolean} */ fresh = false) {
    const c = recCache.get(id);
    if (!fresh && c && Date.now() - c.at < CACHE_MS) return c.rec;
    await recsReady;
    const rec = await recs.get("task", id);
    recCache.set(id, { at: Date.now(), rec });
    return rec;
  }
  /** A link field holds a reference, { urn } (the contract's shape); the kernel keeps a task's parent as an id and its project and record as urns. */
  const link = (/** @type {string} */ urn) => ({ urn });
  const urnIn = (/** @type {any} */ v) => (v && typeof v.urn === "string" ? v.urn : undefined);
  const parentIn = (/** @type {any} */ v) => { const u = urnIn(v); return u ? u.split("/").pop() : undefined; };
  /** The record's person-facing fields from a task: only what is there. */
  const recFieldsOf = (/** @type {any} */ t) => ({ title: t.title, ...(t.note !== undefined ? { note: t.note } : {}), ...(t.due !== undefined ? { due: isoOf(t.due) } : {}), status: t.state, ...(t.parent ? { parent: link(`vyre://${cfg.space}/task/${t.parent}`) } : {}), ...(t.project ? { project: link(t.project) } : {}), ...(t.stage ? { stage: t.stage } : {}), ...(t.record && String(t.record).startsWith("vyre://") ? { record: link(t.record) } : {}) });
  /** The task as a reader sees it: the kernel's task with the record's title, note, due, parent and project laid over it. A task whose record is not there yet reads as the kernel has it. */
  async function overlay(/** @type {any} */ t) {
    let r = null;
    try { r = await recGet(t.id); } catch { r = null; }
    if (!r) return t;
    const d = r.data || {};
    const { note: _n, due: _d, parent: _p, project: _pr, ...rest } = t;
    return freeze({ ...rest, title: d.title ?? t.title, ...(d.note !== undefined && d.note !== null ? { note: d.note } : {}), ...(d.due ? { due: Date.parse(d.due) } : {}), ...(parentIn(d.parent) ? { parent: parentIn(d.parent) } : {}), ...(urnIn(d.project) ? { project: urnIn(d.project) } : {}) });
  }
  async function recUpdate(/** @type {string} */ id, /** @type {any} */ patch) {
    for (let i = 0; i < 3; i++) {
      const cur = await recGet(id, true);
      if (!cur) throw new KernelError("unavailable", "the task's record is not there");
      try { const n = await recs.update("task", id, patch, cur.version); recCache.set(id, { at: Date.now(), rec: n }); return n; }
      catch (e) { if (!e || /** @type {any} */ (e).code !== "version_conflict") throw e; }
    }
    throw new KernelError("version_conflict", "the task's record kept changing");
  }
  /** Tell the record about every state change since last time. A record that cannot be reached keeps the change for the next call: the kernel's state is the truth either way. */
  async function mirrorAll() {
    for (const id of [...dirty]) {
      const t = tasks.get(id);
      dirty.delete(id);
      if (!t) continue;
      try {
        const cur = await recGet(id, true);
        if (cur && cur.data.status !== t.state) await recUpdate(id, { status: t.state });
      } catch { dirty.add(id); }
    }
  }

  /** A task names its project as a link to the Project record of THIS Space, one the chain may read: a link to another Space or to a record it cannot see names nothing. */
  async function checkProject(/** @type {any} */ chain, /** @type {any} */ project) {
    const m = typeof project === "string" ? /^vyre:\/\/([^/\s]+)\/project\/([A-Za-z0-9_-]{1,64})$/.exec(project) : null;
    if (!m || m[1] !== cfg.space) throw new KernelError("bad_input", "a task's project is a Project record of this Space");
    try { await gate(chain, "records.read", project); } catch (e) { if (e instanceof KernelError && e.code === "not_found") throw new KernelError("bad_input", "no such project"); throw e; }
    if (typeof cfg.projectExists === "function" && !(await cfg.projectExists(project))) throw new KernelError("bad_input", "no such project");
  }
  const get_ = (/** @type {string} */ id) => { const t = tasks.get(id); if (!t) throw new KernelError("not_found", "no such task"); return t; };
  // A task changes in memory and then its event is written; if the write fails the task goes back to what it was, so memory never shows a change the log does not hold (an approval
  // that was refused by the log must not stay live). `pending` keeps the state before the first change since the last event; `note` clears it on success and restores it on failure.
  /** @type {Map<string, any>} */ const pending = new Map();
  /** @type {Set<string>} task|payload pairs already released (sent) whose approval event may not have been written yet */ const sent = new Set();
  const stage = (/** @type {string} */ id, /** @type {any} */ next) => { if (!pending.has(id)) pending.set(id, tasks.get(id)); tasks.set(id, next); dirty.add(id); return next; };
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
  // FREE TEXT NEVER GOES INTO THE LOG IN THE CLEAR (lead's ruling on reviewer-2's TR-1): a title, a note, an answer, a form, a reason or a draft is what a person or an assistant typed, and the append-only,
  // hash-chained log cannot forget it. The log carries the task without that text plus the hash of it (`text_hash`) and, in an event's own data, `<key>_hash` for a reason, answer or evidence; the text
  // itself lives in the task store (`cfg.texts`, durable), which a scrub can empty when a record is forgotten or a field is sealed late. A restart reads the text back from the store and keeps it only
  // if it hashes to what the log recorded.
  const TEXT_KEYS = ["reason", "answer", "evidence", "note", "title"];
  // A task's title and note are the record's, not the text store's: only what the kernel itself holds as free text (the doer's answer, a Flow's form, a block's reason) is kept here.
  const textOf = (/** @type {any} */ t) => ({ ...(t.declined_reason !== undefined ? { declined_reason: t.declined_reason } : {}), ...(t.guides !== undefined ? { guides: t.guides } : {}), ...(t.details !== undefined ? { details: t.details } : {}), ...(t.activity !== undefined ? { activity: t.activity } : {}), ...(t.review_note !== undefined ? { review_note: t.review_note } : {}), ...(t.answer !== undefined ? { answer: t.answer } : {}), ...(t.form !== undefined ? { form: t.form } : {}), ...(t.stuck ? { stuck: { reason: t.stuck.reason, suggested_fix: t.stuck.suggested_fix } } : {}) });
  const withoutText = (/** @type {any} */ t) => { const { note: _n, declined_reason: _dr, guides: _g, details: _dt, activity: _ac, review_note: _rn, answer: _a, form: _f, due: _d, parent: _p, project: _pr, ...rest } = t; const out = { ...rest, title: "" }; if (t.stuck) { const { reason: _r, suggested_fix: _s, ...st } = t.stuck; out.stuck = st; } return out; };
  const withText = (/** @type {any} */ t, /** @type {any} */ x) => { const o = { ...t, title: x.title ?? "" }; for (const k of ["note", "answer", "form", "review_note", "details", "activity", "guides", "declined_reason"]) if (x[k] !== undefined) o[k] = x[k]; if (t.stuck && x.stuck) o.stuck = { ...t.stuck, ...x.stuck }; return o; };
  const textHash = (/** @type {any} */ t) => sha256(canonical(textOf(t)));
  const note = (/** @type {any} */ chain, /** @type {string} */ type, /** @type {any} */ t, /** @type {any} */ data, /** @type {any} */ decision) => {
    const now = tasks.get(t.id) || t;
    const prior = texts.get(t.id);
    try {
      const logged = { ...data };
      for (const k of TEXT_KEYS) if (logged[k] !== undefined) { logged[`${k}_hash`] = sha256(canonical(logged[k])); delete logged[k]; }
      // the store first (a stale value after a failed append is put back below); then the event, which names the text only by its hash
      texts.set(t.id, { ...textOf(now), ...(bodies.has(t.id) ? { body: bodies.get(t.id) } : {}) });
      const e = cfg.log.append(chain, { type, sv: 1, subject: urnOf(cfg.space, t.id), data: { ...logged, state: t.state, task: { ...withoutText(now), text_hash: textHash(now) } } }, decision ? { decision } : {});
      pending.delete(t.id); return e;
    } catch (e) { try { texts.set(t.id, prior); } catch { /* the store is whatever it was */ } unstage(t.id); throw e; }
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
    // The person, or their default assistant acting AS them (chain.via === "assistant"): a to-do the assistant made for the person is the person's own act. A space or project agent is neither.
    if (t.doer.kind === "person") return actsAsPerson(chain) && same(chain.hops[0].actor, t.doer);
    const a = acting(chain);
    if (!same(a, t.doer)) return false;
    // A task an assistant works carries its assigner in the chain, so an assigner cannot borrow a broader teammate (R6-9).
    if (t.doer.kind === "agent") return chain.hops.length >= 2 && same(chain.hops[0].actor, t.assigned_by);
    return true;
  };
  // A role is resolved to the PEOPLE who hold it. A checker named directly is a person or, for an internal check only, an agent (rc1-d, 13 Oct): never the doer, and never for a send or a stage hold (see request).
  const checkersOf = (/** @type {any} */ t) => {
    const c = t.checker;
    if (!c) return [];
    if (c.role) return roleHolders(c.role).filter((/** @type {any} */ a) => a && a.kind === "person" && !same(a, t.doer));
    return [c].filter((/** @type {any} */ a) => a && (a.kind === "person" || a.kind === "agent") && !same(a, t.doer));
  };
  /** One line of a task's activity: who did what and when; a progress note rides as text (kept in the task store, hashed in the log). Capped at 100 lines. */
  const ACTIVITY_MAX = 100;
  const moreActivity = (/** @type {any} */ t, /** @type {any} */ who, /** @type {string} */ what, /** @type {string | undefined} */ text) =>
    deepFreeze([...(t.activity || []), { who: { kind: who.kind, id: who.id }, what, at: clock(), ...(text ? { note: text } : {}) }].slice(-ACTIVITY_MAX));
  /**
   * The reviewer slot (tasks v2): a person, an agent or a role, resolved to who may review NOW. Never the doer or a helper; a role is read live each time, so a person removed from it stops being a reviewer
   * at once. Whether the call itself comes through the doer is the chain check in `review`.
   */
  const reviewersOf = (/** @type {any} */ t) => {
    const r = t.reviewer;
    if (!r) return [];
    const out = r.role ? roleHolders(r.role).filter((/** @type {any} */ a) => a && a.kind === "person") : [r].filter((/** @type {any} */ a) => a && (a.kind === "person" || a.kind === "agent"));
    return out.filter((/** @type {any} */ a) => !same(a, t.doer) && !(t.helpers || []).some((/** @type {any} */ h) => same(h, a)));
  };
  /** Everyone who may read a task because of a slot they hold: its checkers and its reviewers. */
  const holdersOf = (/** @type {any} */ t) => [...checkersOf(t), ...reviewersOf(t)];
  /**
   * What an approval after a review also covers (DESIGN-tasks-v2 rule 7): the review result, its checklist and its note by hash. Null when the task was not reviewed. The approver's proof is over this
   * as well, so a review that changed after the card was shown, or no review where one was passed, does not match what was signed.
   */
  const reviewHashOf = (/** @type {any} */ t) => (t.review ? sha256(canonical({ review: t.review, note: t.review_note !== undefined ? sha256(canonical(t.review_note)) : null })) : null);
  /** The slots' instructions and pinned skills (id, content hash, checklist) by hash, for the body an approval covers; nothing when the task has none. They cannot change after the request, so no later edit can undo what was signed. @param {any} t */
  const guideHash = (t) => (t.guides !== undefined ? { guide_hash: sha256(canonical(t.guides)) } : {});
  /** The reviewer's pinned checklist as the items a pass must answer, and the hash of what it was judged against. @param {any} t */
  const pinnedItems = (t) => ((t.guides && t.guides.skills && t.guides.skills.reviewer) || []).flatMap((/** @type {any} */ k) => k.checklist.map((/** @type {string} */ item) => ({ skill: k.id, item })));
  /** The details and outputs the doer gave with tasks.update, by hash, for the body an approval covers (nothing when there are none: a task never updated signs what it always did). @param {any} t */
  const taskDataHash = (t) => (t.details !== undefined || t.outputs !== undefined ? { task_data_hash: sha256(canonical({ details: t.details ?? null, outputs: t.outputs ?? [] })) } : {});
  /**
   * The skills a slot is held to are the ones pinned when the task was made. Before the holder works, reviews or approves, each is asked for again as the holder's own chain: a skill that changed since, or that the
   * holder may not read, stops the step (the holder would follow text the hash does not cover). One refusal for both, so it says nothing about what the holder cannot read.
   * @param {any} chain @param {any} t @param {"doer" | "reviewer" | "approver"} slot
   */
  const pinsHold = async (chain, t, slot) => {
    for (const k of (t.guides && t.guides.skills && t.guides.skills[slot]) || []) {
      const now = cfg.skills ? await cfg.skills.pin(k.id, chain) : null;
      if (!now || now.hash !== k.hash) throw new KernelError("bad_state", `skill ${k.id.slice(0, 80)} changed since this task was made, or you may not use it`);
    }
  };
  const personOf = (/** @type {any} */ chain) => (actsAsPerson(chain) ? chain.hops[0].actor : null);
  /** The ownership rule for a task write (kernel/gateway/ownership.js), the same one the records write path applies: a person who is not the doer, the giver or on the task's project does not change it, move it into a project she is not on, or skip it. @param {any} chain @param {any} t the task, or null for a new one @param {any} patch @param {"create"|"update"|"remove"} op */
  const ownsWrite = async (chain, t, patch, op = "update", doer = undefined) => { if (typeof cfg.mayWriteTask === "function") await cfg.mayWriteTask(chain, t, patch, op, doer); };
  const promote = (/** @type {any} */ chain) => {
    for (const t of [...tasks.values()]) {
      if (t.state !== "waiting") continue;
      if ((t.depends_on || []).every((/** @type {string} */ d) => { const x = tasks.get(d); return x && (x.state === "done" || (x.state === "skipped" && !x.required)); })) {
        rule(t, "ready", "dependencies_met");
        note(chain, "task.readied", put(t, { state: "ready" }), { why: "dependencies met" });
      }
    }
  };

  /**
   * May this agent check work: only while the person who made it is an owner or an admin, read live each time (a demoted maker's agent stops approving), and never when that cannot be told:
   * no way to ask, no maker, or no role. rc1-d term 6, until "made by" is everywhere.
   * @param {string} agentId
   */
  const agentMakerIsStaff = async (agentId) => {
    if (typeof cfg.agentMaker !== "function") return false;
    const maker = await Promise.resolve(cfg.agentMaker(agentId)).catch(() => null);
    if (typeof maker !== "string" || !maker) return false;
    const role = await Promise.resolve((cfg.makerRole || cfg.members.roleOf)({ kind: "person", id: maker, space: cfg.space })).catch(() => null);
    return isStaffRole(role);
  };
  /**
   * An agent checks another agent's work, under its own chain and reach (rc1-d, 13 Oct): only when the task names it as its checker, never the doer or anything running under the doer, only an
   * internal output (nothing outward, no payload, no stage), and only a record it can read. The audit says an agent approved. No presence proof: nothing an agent approves leaves.
   */
  const agentDecide = async (/** @type {any} */ chain, /** @type {string} */ id, /** @type {any} */ a) => {
    const agent = acting(chain);
    const t0 = get_(id);
    // Only the agent a task names as its checker may decide it; for every other agent this stays a person's act.
    if (!t0.checker || t0.checker.kind !== "agent" || !same(t0.checker, agent)) throw new KernelError("chain_not_person", "only a person on their own can decide this task");
    const d = await gate(chain, "tasks.decide", urnOf(cfg.space, id));
    const t = get_(id);
    if (t.state !== "needs_check") throw new KernelError("bad_state", "that task is not waiting for a check");
    if (same(agent, t.doer) || chain.hops.some((/** @type {any} */ h) => same(h.actor, t.doer))) throw new KernelError("not_allowed", "an agent cannot check its own work");
    if (outward(t) || t.stage) throw new KernelError("not_allowed", "an agent's approval is for the internal check only: a person says yes to anything that leaves or holds a stage");
    if (!(await agentMakerIsStaff(agent.id))) throw new KernelError("not_allowed", "this agent may not check work: the person who made it is not an owner or an admin");
    if (cfg.mayReadTask && !(await cfg.mayReadTask(chain, t, holdersOf(t)))) throw new KernelError("not_found", "no such task");
    if (a.outcome === "rejected") {
      if (typeof a.reason !== "string" || !a.reason.trim()) throw new KernelError("bad_input", "a rejection needs a reason");
      rule(t, "ready", "checker");
      const { payload: _p, ...rest } = t;
      stage(id, freeze({ ...rest, state: "ready", outcome: "rejected", updated_at: clock() }));
      note(chain, "task.rejected", tasks.get(id), { reason: a.reason.slice(0, 400), by: { kind: "agent", id: agent.id } }, d.decision);
      bodies.delete(id);
      return tasks.get(id);
    }
    if (a.outcome !== "approved") throw new KernelError("bad_input", "decide approves or rejects");
    rule(t, "done", "agent_checker_approval");
    const body = bodies.get(id);
    const answer = body && body.evidence !== undefined ? answerOf(t, body.evidence) : undefined;
    const n = put(t, { state: "done", outcome: "approved", approved_by: freeze({ kind: "agent", id: agent.id, space: cfg.space }), ...(answer !== undefined ? { answer } : {}) });
    note(chain, "task.approved", n, { approved_by: { kind: "agent", id: agent.id }, ...(n.answer !== undefined ? { answer: n.answer } : {}) }, d.decision);
    promote(chain);
    return n;
  };

  /** @type {any} */ let api;
  const decideOnce = (/** @type {any} */ c, /** @type {string} */ i, /** @type {any} */ a) => api._decideOnce(c, i, a);
  const requestOnce = (/** @type {any} */ c, /** @type {any} */ s) => api._requestOnce(c, s);
  api = {
    /** A task's doer, giver and project for the ownership rule: no gate, for the gateway's own use. @param {string} id */
    facts(id) { const t = tasks.get(id); return t ? { doer: t.doer ?? null, assigned_by: t.assigned_by ?? null, project: t.project ? String(t.project) : null, checkers: checkersOf(t) } : null; },
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
      if (spec.approver !== undefined && spec.checker !== undefined) throw new KernelError("bad_input", "a task has one approver: give approver, or checker (the old name), not both");
      let checker = spec.approver !== undefined ? spec.approver : spec.checker;
      if (spec.quorum !== undefined && (!["any", "all"].includes(spec.quorum) || (spec.quorum === "all" && !(checker && checker.role)))) throw new KernelError("bad_input", "quorum is any, or all for an approver that is a role");
      if (spec.reviewer_quorum !== undefined && (!["any", "all"].includes(spec.reviewer_quorum) || (spec.reviewer_quorum === "all" && !(spec.reviewer && spec.reviewer.role)))) throw new KernelError("bad_input", "reviewer_quorum is any, or all for a reviewer that is a role");
      // The reviewer slot: a person, an agent or a role. An agent reviewer must be another agent than the doer (compared by uid), and a reviewer who could only be the doer's own person is skipped in a Space with no one else.
      let reviewer = spec.reviewer, reviewSkipped = false, reviewMembers = 0;
      if (reviewer !== undefined) {
        const okSlot = reviewer && typeof reviewer === "object" && (typeof reviewer.role === "string" ? Object.keys(reviewer).every(k => k === "role") : ["person", "agent"].includes(reviewer.kind) && typeof reviewer.id === "string" && reviewer.space === cfg.space);
        if (!okSlot) throw new KernelError("bad_input", "a reviewer is a person or an agent of this space, or a role");
        if (reviewer.kind && !cfg.members.has(reviewer)) throw new KernelError("not_a_member", "the reviewer is not a member of this space");
        if (reviewer.kind === "agent" && !(await agentMakerIsStaff(reviewer.id))) throw new KernelError("not_allowed", "this agent may not review work: the person who made it is not an owner or an admin");
        if (!reviewersOf({ doer, helpers: spec.helpers, reviewer }).length) {
          // Skipped only when nobody but the doer's own person could hold the slot (the single-person Space); anyone else eligible who is missing is an error.
          // The Space's own people who could hold it: anyone but the doer, a helper or a viewer. Skipped only when there is no one (a port that cannot say counts as someone: fail closed).
          const others = typeof cfg.members.people === "function" ? cfg.members.people().filter((/** @type {any} */ p) => !same(p, doer) && !(spec.helpers || []).some((/** @type {any} */ h) => same(h, p))) : [{}];
          if (others.length === 0) { reviewSkipped = true; reviewMembers = (typeof cfg.members.people === "function" ? cfg.members.people().length : 0); }
          else throw new KernelError(reviewer.role ? "no_checker" : "same_actor", reviewer.role ? "no person other than the doer holds that role" : "the reviewer must be someone other than the doer");
        }
      }
      // Per-slot instructions (plain text, at most 2000 characters each) and Space skills (up to 10 ids), pinned now by content hash with their checklists: a later edit to a skill does not change this task.
      let guides;
      if (spec.instructions !== undefined || spec.skills !== undefined) {
        const SLOTS = ["doer", "reviewer", "approver"];
        const ins = spec.instructions === undefined ? {} : spec.instructions, sk = spec.skills === undefined ? {} : spec.skills;
        const plain = (/** @type {any} */ o) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).every(k => SLOTS.includes(k));
        if (!plain(ins) || !plain(sk)) throw new KernelError("bad_input", "instructions and skills are given per slot: doer, reviewer or approver");
        if (Object.entries(ins).some(([k, v]) => typeof v !== "string" || v.length > 2000 || (k === "reviewer" && !reviewer) || (k === "approver" && !checker))) throw new KernelError("bad_input", "an instruction is text of at most 2000 characters, for a slot the task has");
        const pinned = /** @type {any} */ ({});
        for (const [k, ids] of Object.entries(sk)) {
          if ((k === "reviewer" && !reviewer) || (k === "approver" && !checker) || !Array.isArray(ids) || ids.length > 10 || ids.some((/** @type {any} */ i) => typeof i !== "string" || !i || i.length > 80) || new Set(ids).size !== ids.length) throw new KernelError("bad_input", "skills are up to 10 different Space skill ids, for a slot the task has");
          pinned[k] = [];
          for (const i of ids) {
            const found = cfg.skills ? await cfg.skills.pin(i, chain, spec.space_skills === true) : null;
            if (!found || typeof found.hash !== "string" || !Array.isArray(found.checklist) || found.checklist.length > 60) throw new KernelError("bad_input", `skill ${i} is not one of this Space's skills`);
            pinned[k].push(freeze({ id: i, ...(typeof found.name === "string" && found.name ? { name: found.name.slice(0, 80) } : {}), hash: found.hash, checklist: freeze(found.checklist.map((/** @type {any} */ c) => String(c).slice(0, 200))) }));
          }
          pinned[k] = freeze(pinned[k]);
        }
        // a review answers every pinned item, and a review holds at most 60 answers: more than that could never be reviewed
        if (((pinned.reviewer || []).reduce((n, k) => n + k.checklist.length, 0)) > 60) throw new KernelError("bad_input", "the reviewer's skills together have more than 60 checklist items: use fewer or shorter checklists");
        guides = deepFreeze({ instructions: structuredClone(ins), skills: pinned });
        if (canonical(guides).length > GUIDES_MAX) throw new KernelError("bad_input", "instructions and skills are too long together: keep them under 64 KB");
      }
      const out = spec.output.kind === "sent";
      if (!checker && out) checker = cfg.approver ? cfg.approver(chain) : undefined;
      if (out && !checker) throw new KernelError("no_checker", "a send needs a checker and none could be assigned");
      // An agent may check another agent's internal work, and nothing that leaves or holds a stage: a send, a presence-gated act and a stage hold always wait for a person's yes.
      if (checker && checker.kind === "agent" && !(await agentMakerIsStaff(checker.id))) throw new KernelError("not_allowed", "this agent may not check work: the person who made it is not an owner or an admin");
      if (checker && checker.kind === "agent" && (out || spec.stage || spec.required)) throw new KernelError("not_allowed", "an agent cannot be the checker of a send or of a stage's task: a person says yes to those");
      const probe = { doer, checker };
      const persons = checkersOf(/** @type {any} */ probe);
      if (checker && !persons.length) throw new KernelError(checker.role ? "no_checker" : "same_actor", checker.role ? "no person holds that role" : "the checker must be a person other than the doer");
      for (const d of spec.depends_on || []) if (!tasks.has(d)) throw new KernelError("bad_input", "a dependency does not exist");
      if (spec.fields !== undefined) {
        if (!spec.fields || typeof spec.fields !== "object" || Array.isArray(spec.fields) || Object.keys(spec.fields).some(k => RESERVED.has(k))) throw new KernelError("bad_input", "fields are the type's own custom fields, not title, note, due, status, parent or project");
      }
      if (spec.project !== undefined) await checkProject(chain, spec.project);
      if (spec.project) await ownsWrite(chain, null, { project: { urn: spec.project } }, "create", spec.doer);
      if (spec.parent !== undefined && (typeof spec.parent !== "string" || !tasks.has(spec.parent))) throw new KernelError("bad_input", "a parent task does not exist");
      const waiting = (spec.depends_on || []).some((/** @type {string} */ d) => { const x = tasks.get(d); return !(x.state === "done" || (x.state === "skipped" && !x.required)); });
      const id = mintUuid(clock());
      const t = freeze({
        id, space: cfg.space, title: spec.title.trim().slice(0, 200), ...(spec.record ? { record: spec.record } : {}), ...(spec.stage ? { stage: spec.stage } : {}),
        source: spec.source || "manual", doer: freeze({ ...doer }), ...(spec.helpers ? { helpers: freeze([...spec.helpers]) } : {}),
        ...(checker ? { checker: freeze({ ...checker }) } : {}), ...(reviewer && !reviewSkipped ? { reviewer: freeze({ ...reviewer }) } : {}), ...(spec.reviewer_quorum === "all" && reviewer && !reviewSkipped ? { reviewer_quorum: "all" } : {}), ...(spec.quorum === "all" ? { approver_quorum: "all" } : {}), ...(reviewSkipped ? { review_skipped: freeze({ why: "No one else to check this", members: reviewMembers }) } : {}), output: freeze({ ...spec.output }),
        ...(spec.how ? { how: spec.how } : {}), ...(spec.template ? { template: spec.template } : {}), ...(spec.inputs ? { inputs: freeze([...spec.inputs]) } : {}),
        ...(spec.depends_on ? { depends_on: freeze([...spec.depends_on]) } : {}), ...(spec.due ? { due: spec.due } : {}), ...(spec.required ? { required: true } : {}), ...(spec.note ? { note: String(spec.note).slice(0, FIX_CAP) } : {}),
        ...(spec.parent ? { parent: spec.parent } : {}), ...(spec.project ? { project: spec.project } : {}), ...(spec.flow !== undefined ? { flow: String(spec.flow).slice(0, 200) } : {}), ...(spec.form !== undefined ? { form: opaque(spec.form) } : {}),
        ...(guides ? { guides } : {}), ...(spec.session ? { session: spec.session } : {}), ...(spec.escalate_after ? { escalate_after: spec.escalate_after } : {}), ...(spec.escalate_to ? { escalate_to: spec.escalate_to } : {}),
        state: waiting ? "waiting" : "ready", assigned_by: freeze({ ...chain.hops[0].actor }), ...(requestedFor(chain) ? { requested_for: requestedFor(chain) } : {}),
        labels: freeze({ trust: chain.labels.trust, red: chain.labels.red, source_spaces: freeze([...chain.labels.source_spaces]) }),
        created_at: clock(), updated_at: clock(),
      });
      let made = null;
      await recsReady;
      made = await recs.create("task", id, { ...recFieldsOf(t), ...(spec.fields || {}) });
      recCache.set(id, { at: Date.now(), rec: made });
      try {
        stage(id, t);
        note(chain, "task.created", t, { doer: `${doer.kind}:${doer.id}`, output: t.output.kind, checkers: persons.length, ...(t.reviewer ? { reviewers: reviewersOf(t).length } : {}), ...(reviewSkipped ? { review_skipped: "No one else to check this", members: reviewMembers } : {}) });
      } catch (e) { if (made) await recs.remove("task", id, made.version).catch(() => {}); recCache.delete(id); throw e; }
      dirty.delete(id);
      return t;
    },

    async get(/** @type {any} */ chain, /** @type {string} */ id) {
      try { await gate(chain, "tasks.read", urnOf(cfg.space, id)); } catch (e) { if (e instanceof KernelError && e.code === "not_found") return null; throw e; }
      const t = tasks.get(id);
      if (!t) return null;
      const v = await overlay(t);
      return !cfg.mayReadTask || await cfg.mayReadTask(chain, v, holdersOf(t)) ? v : null;
    },

    /**
     * The tasks this chain may read, filtered: by record, doer id, checker id (a named checker or one of the persons a role resolves to) and state. Each task goes through the same `tasks.read`
     * gate `get` uses, so a task the chain may not read is absent, never marked. Oldest first.
     * @param {any} chain @param {{ record?: string, doer?: string, checker?: string, approver?: string, reviewer?: string, mine?: string, state?: string[] }} [q]
     */
    async list(chain, q = {}) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      const out = [];
      if (q.mine !== undefined && !["assigned", "reviewing", "approving"].includes(q.mine)) throw new KernelError("bad_input", "mine is assigned, reviewing or approving");
      // "mine" is the caller's own slots, read from the chain and never from input: the person, the assistant acting now, and every role either holds (read live).
      const me = q.mine ? [chain.hops[0].actor, acting(chain)].filter((/** @type {any} */ a, /** @type {number} */ i, /** @type {any[]} */ l) => a && l.findIndex((/** @type {any} */ b) => same(a, b)) === i) : [];
      const isMe = (/** @type {any} */ a) => me.some((/** @type {any} */ m) => same(m, a));
      const holds = (/** @type {any} */ slot) => Boolean(slot) && (slot.role ? roleHolders(slot.role).some(isMe) : isMe(slot));
      for (const t of [...tasks.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (q.record && t.record !== q.record) continue;
        if (q.mine === "assigned" && !holds(t.doer)) continue;
        if (q.mine === "reviewing" && !reviewersOf(t).some(isMe)) continue;
        if (q.mine === "approving" && !checkersOf(t).some(isMe)) continue;
        if (q.project !== undefined || q.parent !== undefined) {
          const v = await overlay(t);
          if (q.project !== undefined && (v.project || null) !== q.project) continue;
          if (q.parent !== undefined && (v.parent || null) !== q.parent) continue;
        }
        if (q.doer && canon(t.doer.id) !== canon(q.doer)) continue;
        if ((q.checker || q.approver) && !checkersOf(t).some((/** @type {any} */ c) => canon(c.id) === canon(q.checker || q.approver))) continue;
        if (q.reviewer && !reviewersOf(t).some((/** @type {any} */ c) => canon(c.id) === canon(q.reviewer))) continue;
        if (Array.isArray(q.state) && q.state.length && !q.state.includes(t.state)) continue;
        try { await gate(chain, "tasks.read", urnOf(cfg.space, t.id)); } catch (e) { if (e instanceof KernelError && e.code === "not_found") continue; throw e; }
        const v = await overlay(t);
        if (cfg.mayReadTask && !(await cfg.mayReadTask(chain, v, holdersOf(t)))) continue;   // a task is for its doer, its giver, its checkers, its project's people and staff
        out.push(v);
      }
      return out;
    },

    async start(/** @type {any} */ chain, /** @type {string} */ id) {
      await gate(chain, "tasks.work", urnOf(cfg.space, id));
      const t = get_(id);
      if (t.kernel || !isDoer(chain, t)) throw new KernelError("not_allowed", "only the doer starts a task");
      await pinsHold(chain, t, "doer");
      rule(t, "working", "doer");
      const n = put(t, { state: "working" });
      note(chain, "task.started", n, {});
      return n;
    },

    async complete(/** @type {any} */ chain, /** @type {string} */ id, /** @type {any} */ evidence) {
      const d = await gate(chain, "tasks.work", urnOf(cfg.space, id));
      const t = get_(id);
      if (t.kernel || !isDoer(chain, t)) throw new KernelError("not_allowed", "only the doer finishes a task");
      await pinsHold(chain, t, "doer");
      // The kernel checks the declared output before anything moves: an assistant cannot mark a task done while the check fails.
      const to = t.reviewer ? "in_review" : needsCheck(t) ? "needs_check" : "done";
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
        // PR-2: the form a Flow sent with the task (a proposal's diff, a Kit card) is part of what the checker approves: its hash is in the body the proof covers.
        body = deepFreeze({ action: ev.action, resource: ev.resource, payload: ev.payload, facts, ...(t.form !== undefined ? { form_hash: sha256(canonical(t.form)) } : {}), ...taskDataHash(t), ...guideHash(t) });
      } else body = deepFreeze({ task: id, kind: t.output.kind, evidence: deepFreeze(structuredClone(evidence)), ...(t.form !== undefined ? { form_hash: sha256(canonical(t.form)) } : {}), ...taskDataHash(t), ...guideHash(t) });
      const payload = freeze({ payload_hash: sha256(canonical(body)), decision, draft_hash: sha256(canonical(evidence)), ...(t.form !== undefined ? { form_hash: sha256(canonical(t.form)) } : {}) });
      bodies.set(id, body);
      // A review belongs to one hand-in: coming back In review drops the last result and its note from the task (they stay in the log), so no card or approver sees a stale pass.
      const { review: _rv, review_note: _rvn, review_passes: _rps, approvals: _aps, ...kept } = t;
      const n = to === "in_review" ? stage(id, freeze({ ...kept, state: to, payload, activity: moreActivity(t, acting(chain), "submit"), updated_at: clock() })) : put(t, { state: to, payload, approvals: freeze([]) });
      note(chain, to === "in_review" ? "task.in-review" : "task.needs-check", n, { payload_hash: payload.payload_hash, decision });
      return n;
    },

    /**
     * The doer's (or a helper's) work in progress, for an agent or a person: details (plain data), a progress note and references to what was made (tasks v2). Only while the task is ready, working
     * or changes_requested, so nothing changes under a reviewer or an approver; every call adds a line to the activity. Rechecked against the caller's hold on every write.
     * @param {any} chain @param {string} id @param {{ details?: any, note?: string, outputs?: string[] }} a
     */
    async update(chain, id, a) {
      const d = await gate(chain, "tasks.work", urnOf(cfg.space, id));
      const t = get_(id);
      const who = acting(chain);
      const helper = (t.helpers || []).some((/** @type {any} */ h) => same(h, who));
      if (t.kernel || !(isDoer(chain, t) || helper)) throw new KernelError("not_allowed", "only the doer or a helper updates a task");
      if (!["ready", "working", "changes_requested"].includes(t.state)) throw new KernelError("bad_state", `a task that is ${t.state} cannot be updated: it is with a reviewer or an approver, or finished`);
      if (!a || typeof a !== "object" || (a.details === undefined && a.note === undefined && a.outputs === undefined)) throw new KernelError("bad_input", "update details, a progress note or outputs");
      await pinsHold(chain, t, "doer");
      const patch = /** @type {any} */ ({});
      const did = [];
      if (a.details !== undefined) { patch.details = opaque(a.details); did.push("details"); }
      if (a.outputs !== undefined) {
        if (!Array.isArray(a.outputs) || a.outputs.length > 20 || a.outputs.some((/** @type {any} */ o) => typeof o !== "string" || !o || o.length > 300)) throw new KernelError("bad_input", "outputs are up to 20 references to what was made");
        patch.outputs = freeze([...a.outputs]); did.push("outputs");
      }
      const text = a.note === undefined ? "" : String(a.note).slice(0, FIX_CAP);
      if (a.note !== undefined && !text.trim()) throw new KernelError("bad_input", "a progress note has words");
      if (text) did.push("note");
      patch.activity = moreActivity(t, who, did.join(","), text);
      const n = put(t, patch);
      note(chain, "task.updated", n, { by: { kind: who.kind, id: who.id }, did: did.join(","), ...(text ? { note: text } : {}) }, d.decision);
      return n;
    },

    /**
     * The reviewer's pass or request for changes (tasks v2). Only the reviewer slot's holder, only while the task is In review, never the doer, a helper or anyone reached through the doer's chain. A pass never
     * frees an outward output and never satisfies the approval: it moves the task to the approver, or to done when the task has none and nothing leaves. The result is stored on the task and bound by hash.
     * @param {any} chain @param {string} id @param {{ result: "pass" | "changes", checklist?: { skill: string, item: string, ok: boolean }[], note?: string }} a
     */
    async review(chain, id, a) {
      const d = await gate(chain, "tasks.work", urnOf(cfg.space, id));
      const t = get_(id);
      if (t.kernel || !t.reviewer) throw new KernelError("not_allowed", "this task has no reviewer");
      if (t.state !== "in_review") throw new KernelError("bad_state", "that task is not waiting for a review");
      const who = acting(chain);
      if (!a || (a.result !== "pass" && a.result !== "changes")) throw new KernelError("bad_input", "a review passes the work or asks for changes");
      // never the doer, a helper, or anything that acts under the doer (a person's own assistant cannot review that person's work); an agent reviewer is another agent by uid
      if (chain.hops.some((/** @type {any} */ h) => same(h.actor, t.doer) || (t.helpers || []).some((/** @type {any} */ x) => same(x, h.actor)))) throw new KernelError("not_allowed", "nobody reviews their own work");
      if (!reviewersOf(t).some((/** @type {any} */ r) => same(r, who))) throw new KernelError("not_allowed", "you are not this task's reviewer");
      await pinsHold(chain, t, "reviewer");
      if (cfg.mayReadTask && !(await cfg.mayReadTask(chain, t, holdersOf(t)))) throw new KernelError("not_found", "no such task");
      const text = a.note === undefined ? "" : String(a.note).slice(0, FIX_CAP);
      if (a.result === "changes" && !text.trim()) throw new KernelError("bad_input", "asking for changes needs a note saying what to change");
      const items = Array.isArray(a.checklist) ? a.checklist : [];
      if (items.length > 60 || items.some((/** @type {any} */ x) => !x || typeof x.skill !== "string" || typeof x.item !== "string" || typeof x.ok !== "boolean")) throw new KernelError("bad_input", "a checklist is a list of { skill, item, ok }");
      // A task with pinned reviewer skills is judged against exactly those items: each answered once, none made up. The hash of what it was judged against rides in the result.
      const want = pinnedItems(t);
      if (want.length && (items.length !== want.length || want.some((/** @type {any} */ w) => items.filter((/** @type {any} */ x) => x.skill === w.skill && x.item === w.item).length !== 1))) throw new KernelError("bad_input", "answer every item of the reviewer's skills, once each, and no others");
      if (a.result === "pass" && items.some((/** @type {any} */ x) => !x.ok) && !text.trim()) throw new KernelError("bad_input", "a pass with an item that failed needs a note saying why it is acceptable");
      const review = freeze({ by: freeze({ kind: who.kind, id: who.id }), type: who.kind === "agent" ? "agent" : "person", result: a.result, ...(want.length ? { checklist_hash: sha256(canonical({ skills: t.guides.skills.reviewer.map((/** @type {any} */ k) => ({ id: k.id, hash: k.hash })), items: want })) } : {}), checklist: freeze(items.map((/** @type {any} */ x) => freeze({ skill: x.skill.slice(0, 80), item: x.item.slice(0, 200), ok: x.ok }))), ...(text ? { note_hash: sha256(canonical(text)) } : {}), at: clock() });
      if (a.result === "changes") {
        rule(t, "changes_requested", "reviewer");
        const n = put(t, { state: "changes_requested", review, ...(text ? { review_note: text } : {}), activity: moreActivity(t, who, "review:changes") });
        note(chain, "task.changes-requested", n, { by: { kind: who.kind, id: who.id }, note: text, checklist: review.checklist.length }, d.decision);
        return n;
      }
      // Quorum "all" on a role: every person who holds the role now must pass; one pass is kept per person, and the last pass completes the review with the others recorded beside it. A person taken out of the role is no longer waited for.
      let reviewOut = review;
      if (t.reviewer_quorum === "all") {
        const passes = [...(t.review_passes || []).filter((/** @type {any} */ p) => !same(p.by, who)), freeze({ by: review.by, review })];
        const waiting = reviewersOf(t).filter((/** @type {any} */ h) => !passes.some((/** @type {any} */ p) => same(p.by, h)));
        if (waiting.length) {
          const n = put(t, { review_passes: freeze(passes), activity: moreActivity(t, who, "review:pass") });
          note(chain, "task.review-pass-kept", n, { by: { kind: who.kind, id: who.id }, waiting: waiting.length }, d.decision);
          return n;
        }
        reviewOut = freeze({ ...review, also: freeze(passes.filter((/** @type {any} */ p) => !same(p.by, who)).map((/** @type {any} */ p) => p.review)) });
      }
      const to = needsCheck(t) ? "needs_check" : "done";
      rule(t, to, "reviewer_pass");
      if (to === "done") {
        const body = bodies.get(id);
        const answer = body && body.evidence !== undefined ? answerOf(t, body.evidence) : undefined;
        const n = put(t, { state: "done", review: reviewOut, review_passes: freeze([]), ...(text ? { review_note: text } : {}), activity: moreActivity(t, who, "review:pass"), ...(answer !== undefined ? { answer } : {}) });
        note(chain, "task.completed", n, { reviewed_by: { kind: who.kind, id: who.id }, output: t.output.kind, ...(answer !== undefined ? { answer } : {}) }, d.decision);
        promote(chain);
        return n;
      }
      const n = put(t, { state: "needs_check", review: reviewOut, review_passes: freeze([]), ...(text ? { review_note: text } : {}), activity: moreActivity(t, who, "review:pass") });
      note(chain, "task.review-passed", n, { by: { kind: who.kind, id: who.id }, note: text, checklist: review.checklist.length }, d.decision);
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
      const { payload: _p, approvals: _aps, ...rest } = t;
      stage(id, freeze({ ...rest, state: "ready", updated_at: clock() }));
      note(chain, "task.voided", tasks.get(id), { reason: String(reason || "").slice(0, 200) });
      bodies.delete(id);
      return tasks.get(id);
    },

    /** Human-only: exactly one person, a checker of this task and not its doer, with a signer's proof over this payload, once. */
    async decide(/** @type {any} */ chain, /** @type {string} */ id, /** @type {{ outcome: "approved" | "rejected" | "declined", reason?: string, proof?: any, proofs?: { use?: any } }} */ a) {
      // Taken before any await: a second decide on this task, with the same proof or another, is refused while one is running (K4 item 1).
      if (deciding.has(id)) throw new KernelError("bad_state", "that task is being decided");
      deciding.add(id);
      try { return await decideOnce(chain, id, a); } finally { deciding.delete(id); }
    },

    async _decideOnce(/** @type {any} */ chain, /** @type {string} */ id, /** @type {any} */ a) {
      if (!isChain(chain)) throw new KernelError("bad_input", "a call needs a kernel-built chain");
      if (acting(chain).kind === "agent") return agentDecide(chain, id, a);
      if (!isExactlyPerson(chain)) throw new KernelError("chain_not_person", "only a person on their own can decide a task");
      const person = chain.hops[0].actor;
      const d = await gate(chain, "tasks.decide", urnOf(cfg.space, id));
      const t = get_(id);
      if (t.state !== "needs_check") throw new KernelError("bad_state", "that task is not waiting for a check");
      // The checker is resolved to people when the task is made and again now; an assistant that holds the role is filtered out.
      if (!checkersOf(t).some((/** @type {any} */ c) => same(c, person)) || same(person, t.doer)) throw new KernelError("not_allowed", "you are not this task's checker");
      if (a.outcome === "approved") await pinsHold(chain, t, "approver");
      if (a.outcome === "rejected") {
        if (typeof a.reason !== "string" || !a.reason.trim()) throw new KernelError("bad_input", "a rejection needs a reason");
        rule(t, "ready", "checker");
        const { payload: _p, approvals: _aps, ...rest } = t;
        stage(id, freeze({ ...rest, state: "ready", outcome: "rejected", updated_at: clock() }));
        note(chain, "task.rejected", tasks.get(id), { reason: a.reason.slice(0, 400) }, d.decision);
        bodies.delete(id);
        return tasks.get(id);
      }
      if (a.outcome === "declined") {
        const text = String(a.reason ?? "").slice(0, FIX_CAP);
        if (!text.trim()) throw new KernelError("bad_input", "declining a task needs a reason");
        rule(t, "declined", "checker");
        const { payload: _p, approvals: _aps, ...rest } = t;
        stage(id, freeze({ ...rest, state: "declined", declined_reason: text, declined_by: freeze({ kind: "person", id: person.id }), updated_at: clock() }));
        note(chain, "task.declined", tasks.get(id), { by: { kind: "person", id: person.id }, reason: text }, d.decision);
        bodies.delete(id);
        return tasks.get(id);
      }
      if (a.outcome !== "approved") throw new KernelError("bad_input", "decide approves, rejects or declines");
      // The sealed-use proof is checked by the sealing process when it is used; here only its shape and window, so a garbage or expired one is
      // refused now and the approver is not told a complete approval is one that cannot be used (K4 item 12).
      const up = a.proofs && a.proofs.use;
      if (up !== undefined && up !== null && !(typeof up === "object" && typeof up.signature === "string" && typeof up.key_id === "string" && typeof up.nonce === "string" && Number.isFinite(up.issued_at) && up.expires_at > clock())) throw new KernelError("bad_input", "the sealed-use confirmation is malformed or already expired");
      const body = bodies.get(id);
      const p = a.proof;
      // The approval covers the canonical payload as the kernel stored it, recomputed now, never the doer's description.
      if (!t.payload || !body || sha256(canonical(body)) !== t.payload.payload_hash) throw new KernelError("needs_presence", "this task has no approvable payload");
      // One verifier: the sealing process's. The signed fields are the task, the canonical payload hash and the decision it is bound to.
      const why = p ? await cfg.presence.check({ chain, op: "task.decide", fields: { task: id, payload_hash: t.payload.payload_hash, decision: t.payload.decision, ...(reviewHashOf(t) ? { review_hash: reviewHashOf(t) } : {}) }, proof: p }) : "no_proof";
      if (why) throw needsPresence("approving needs your confirmation on this device, over exactly this", why);
      // Quorum "all" on a role: each holder's own yes, each with their own presence proof over this same payload, is kept; the last one completes the approval. A holder taken out of the role is no longer waited for.
      if (t.approver_quorum === "all") {
        const votes = [...(t.approvals || []).filter((/** @type {any} */ v) => !same(v.by, person)), freeze({ by: freeze({ kind: "person", id: person.id }), key_id: p.key_id })];
        const waiting = checkersOf(t).filter((/** @type {any} */ c) => !votes.some((/** @type {any} */ v) => same(v.by, c)));
        if (waiting.length) {
          const kept = put(t, { approvals: freeze(votes) });
          note(chain, "task.approval-kept", kept, { payload_hash: t.payload.payload_hash, key_id: p.key_id, waiting: waiting.length }, d.decision);
          return kept;
        }
      }
      rule(t, "done", "checker_approval");
      if (outward(t) && cfg.release) {
        // WF-2: the send happens before the event is written. If the event is refused the task goes back to waiting, and a second approval must not send again: the send is made once per
        // task and payload (`sent`), and the release is told the same key so an egress can refuse a repeat too.
        const idem = `${id}|${t.payload.payload_hash}`;
        try { if (!sent.has(idem)) { await cfg.release(t, body, { person: person.id, key_id: p.key_id, idem }); sent.add(idem); } } catch (e) { throw new KernelError("unavailable", "it could not be sent, so it was not approved as sent", String(e && /** @type {any} */ (e).message)); }
      }
      const answer = !outward(t) && body && body.evidence !== undefined ? answerOf(t, body.evidence) : undefined;
      const n = put(t, { state: "done", outcome: "approved", ...(answer !== undefined ? { answer } : {}) });
      note(chain, "task.approved", n, { payload_hash: t.payload.payload_hash, key_id: p.key_id, ...(n.answer !== undefined ? { answer: n.answer } : {}) }, d.decision);
      sent.delete(`${id}|${t.payload.payload_hash}`);
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
      await ownsWrite(chain, t, o.reassign_to ? { reassign_to: o.reassign_to } : {});
      const responsible = cfg.responsible ? cfg.responsible(person, t.doer) : false;
      if (!responsible) {
        const why = o.proof ? await cfg.presence.check({ chain, op: "task.unblock", fields: { task: id, reassign_to: o.reassign_to || null }, proof: o.proof }) : "no_proof";
        if (why) throw needsPresence("you are not responsible for this doer: unblocking needs your confirmation on this device", why);
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
    /**
     * Change a task's words, note, due time, form or parent. Whoever may do the same to their own work: the doer (an assistant doer only as the assistant its assigner gave it to), a person, or the
     * chain whose first hop assigned it (a service that made it for someone). Not a task another actor was given, not a kernel proposal, not one waiting for its checker (its draft is bound). The
     * log carries the change and the text's hash, like any other.
     * @param {any} chain @param {string} id @param {{ title?: string, note?: string | null, due?: number | null, form?: any, parent?: string | null }} patch
     */
    async edit(chain, id, patch) {
      await gate(chain, "tasks.work", urnOf(cfg.space, id));
      const t = get_(id);
      if (t.kernel) throw new KernelError("not_allowed", "a kernel task is not edited");
      if (!isDoer(chain, t) && !personOf(chain) && !same(chain.hops[0].actor, t.assigned_by)) throw new KernelError("not_allowed", "only the doer, a person or whoever assigned the task edits it");
      await ownsWrite(chain, t, { ...(patch && patch.project !== undefined ? { project: patch.project === null ? null : { urn: patch.project } } : {}) });
      if (t.state === "needs_check") throw new KernelError("bad_state", "a task waiting for its check is not edited");
      for (const k of Object.keys(patch || {})) if (!["title", "note", "due", "form", "parent", "project"].includes(k)) throw new KernelError("bad_input", `${k} is not something a task's edit changes`);
      const next = { ...t };
      if (patch.title !== undefined) { if (typeof patch.title !== "string" || !patch.title.trim()) throw new KernelError("bad_input", "a task needs a title"); next.title = patch.title.trim().slice(0, 200); }
      if (patch.note !== undefined) { if (patch.note === null || patch.note === "") delete next.note; else next.note = String(patch.note).slice(0, FIX_CAP); }
      if (patch.due !== undefined) { if (patch.due === null) delete next.due; else if (Number.isFinite(patch.due)) next.due = patch.due; else throw new KernelError("bad_input", "due is a time in ms"); }
      if (patch.form !== undefined) { if (patch.form === null) delete next.form; else next.form = opaque(patch.form); }
      if (patch.project !== undefined) { if (patch.project === null) delete next.project; else { await checkProject(chain, patch.project); next.project = patch.project; } }
      if (patch.parent !== undefined) {
        if (patch.parent === null) delete next.parent;
        else {
          if (typeof patch.parent !== "string" || !tasks.has(patch.parent) || patch.parent === id) throw new KernelError("bad_input", "a parent task does not exist");
          for (let cur = patch.parent, hops = 0; cur && hops < 200; hops++) {
            if (cur === id) throw new KernelError("bad_input", "a task cannot sit under its own sub-task");
            const up = tasks.get(cur);
            cur = up ? (await overlay(up)).parent : undefined;
          }
          next.parent = patch.parent;
        }
      }
      {
        // The record is the source of truth for these fields: it is written first, and a refusal there leaves the task as it was.
        const rp = {};
        for (const k of Object.keys(patch)) {
          if (k === "title") rp.title = next.title;
          else if (k === "note") rp.note = patch.note === null || patch.note === "" ? null : next.note;
          else if (k === "due") rp.due = patch.due === null ? null : isoOf(next.due);
          else if (k === "parent") rp.parent = patch.parent === null ? null : link(`vyre://${cfg.space}/task/${next.parent}`);
          else if (k === "project") rp.project = patch.project === null ? null : link(next.project);
        }
        if (Object.keys(rp).length) await recUpdate(id, rp);
      }
      const n = stage(id, freeze({ ...next, updated_at: clock() }));
      note(chain, "task.edited", n, { fields: Object.keys(patch) });
      return n;
    },

    /** Open a finished or skipped task again (a to-do ticked by mistake). Its doer, a person, or whoever assigned it; never a task with a checker or an outward act, which is made again. @param {any} chain @param {string} id */
    async decline(chain, id, reason) {
      const d = await gate(chain, "tasks.work", urnOf(cfg.space, id));
      const t = get_(id);
      if (t.kernel || !isDoer(chain, t)) throw new KernelError("not_allowed", "only the doer declines a task");
      const text = String(reason ?? "").slice(0, FIX_CAP);
      if (!text.trim()) throw new KernelError("bad_input", "declining a task needs a reason");
      rule(t, "declined", "doer");
      const n = put(t, { state: "declined", declined_reason: text, declined_by: freeze({ kind: acting(chain).kind, id: acting(chain).id }), activity: moreActivity(t, acting(chain), "declined") });
      note(chain, "task.declined", n, { by: { kind: acting(chain).kind, id: acting(chain).id }, reason: text }, d.decision);
      return n;
    },

    /** Reopening a finished, skipped or declined task. */
    async reopen(chain, id) {
      await gate(chain, "tasks.work", urnOf(cfg.space, id));
      const t = get_(id);
      if (t.kernel) throw new KernelError("not_allowed", "a kernel task is not reopened");
      if (!isDoer(chain, t) && !personOf(chain) && !same(chain.hops[0].actor, t.assigned_by)) throw new KernelError("not_allowed", "only the doer, a person or whoever assigned the task reopens it");
      await ownsWrite(chain, t, {});
      if (t.withdrawn) throw new KernelError("bad_state", "a task withdrawn at its due time is not reopened: make a new task");
      if (needsCheck(t) && t.state !== "declined") throw new KernelError("bad_state", "a task with a checker or an outward act is made again, not reopened");
      if (!TASK_REOPENS.some(x => x.from === t.state && x.to === "ready")) throw new KernelError("bad_state", `a task that is ${t.state} is not reopened`);
      const { answer: _a, declined_reason: _dr, declined_by: _db, payload: _pl, ...rest } = t;
      const n = stage(id, freeze({ ...rest, state: "ready", updated_at: clock() }));
      note(chain, "task.reopened", n, {});
      bodies.delete(id);
      return n;
    },

    /**
     * The Flows service ends a task its step gave once the step's due time has passed (R051-03). Only the Flows service may: its chain's acting hop is service `flows` and the grant `tasks.withdraw` is in its
     * manifest, never in a role. The task ends as skipped with `withdrawn: { reason, at }` in ONE write, whatever state it is in (a doer working on it too), so every later start, hand-in, move or check by anyone
     * is refused (bad_state); the lend of the task to an agent is then ended from the durable `task.withdrawn` event, and a repeat of the call is harmless (an ended task is refused, nothing else changes).
     * A required stage task stays required: dependants that wait for it keep waiting (skipped and required does not release them).
     */
    async withdraw(/** @type {any} */ chain, /** @type {string} */ id, /** @type {{ reason?: string }} */ o = {}) {
      await gate(chain, "tasks.withdraw", urnOf(cfg.space, id));
      const a = acting(chain);
      if (!a || a.kind !== "service" || a.id !== "flows") throw new KernelError("not_allowed", "only the Flows service withdraws a task");
      const t = get_(id);
      if (t.kernel) throw new KernelError("not_allowed", "a kernel task is not withdrawn");
      rule(t, "skipped", "flow_deadline");
      const withdrawn = freeze({ reason: "timeout", at: clock() });
      const n = put(t, { state: "skipped", withdrawn });
      note(chain, "task.withdrawn", n, { reason: String((o && o.reason) || "the due time passed").slice(0, 200), withdrawn_reason: "timeout" });
      return n;
    },

    async skip(/** @type {any} */ chain, /** @type {string} */ id, /** @type {string} */ reason) {
      await gate(chain, "tasks.work", urnOf(cfg.space, id));
      const t = get_(id);
      if (!guarded(t)) {
        if (!isDoer(chain, t) && !personOf(chain)) throw new KernelError("not_allowed", "only the doer or a person skips a task");
        await ownsWrite(chain, t, {});
        rule(t, "skipped", "doer_or_person");
        const n = put(t, { state: "skipped" });
        note(chain, "task.skipped", n, { reason: String(reason || "").slice(0, 200) });
        promote(chain);
        return n;
      }
      await ownsWrite(chain, t, {});   // a skip that waits for a yes is still a change to this task: only its doer, whoever gave it, or its project's owner or team may ask for it
      rule(t, "skipped", "proposal_for_person_with_presence");
      const who = cfg.responsibleFor ? cfg.responsibleFor(t.doer) : t.assigned_by;
      if (!who || who.kind !== "person") throw new KernelError("no_checker", "no person to decide a skip");
      const shown = (await overlay(t)).title || "";
      const body = deepFreeze({ op: "skip", task: id, title: shown.slice(0, 80), reason: String(reason || "").slice(0, 200) });
      const pid = mintUuid(clock());
      const decision = (await cfg.authorizer.authorize({ chain, action: "tasks.work", resource: urnOf(cfg.space, id) })).decision;
      const proposal = freeze({
        id: pid, space: cfg.space, title: `Skip "${shown.slice(0, 80)}"?`, source: "manual", kernel: true, doer: SYSTEM, checker: freeze({ ...who }),
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
      const mine = [...tasks.values()].filter(t =>
        (t.state === "needs_check" && checkersOf(t).some((/** @type {any} */ c) => same(c, person)))
        || (t.state === "in_review" && reviewersOf(t).some((/** @type {any} */ c) => same(c, person)))
        || (t.state === "changes_requested" && same(t.doer, person))
        || (t.state === "ready" && same(t.doer, person))
        || (t.state === "stuck" && (same(t.doer, person) || (cfg.responsible ? cfg.responsible(person, t.doer) : false)))).sort((a, b) => (a.id < b.id ? -1 : 1));
      return Promise.all(mine.map(t => overlay(t)));
    },

    /** The card the checker sees, built from the canonical payload. */
    async card(/** @type {any} */ chain, /** @type {string} */ id) {
      await gate(chain, "tasks.read", urnOf(cfg.space, id));
      const t = await overlay(get_(id));
      if (cfg.mayReadTask && !(await cfg.mayReadTask(chain, t, checkersOf(get_(id))))) throw new KernelError("not_found", "no such task");
      const b = bodies.get(id);
      return buildCard(t, b, { review_hash: reviewHashOf(get_(id)), action_label: b && b.action && cfg.authorizer.actions && cfg.authorizer.actions.get(b.action) ? cfg.authorizer.actions.get(b.action).label : undefined });
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
     * What a Kit install needs to know about an approved task (kernel/tasks/kit-apply.js): its form, the payload the checker's proof covered, the approver's own chain and when it was approved.
     * Null unless a person approved it (done, approved, the body it was approved with still the one hashed).
     * @param {string} id
     */
    kitApproval(id) {
      const t = tasks.get(id), a = api.approvalFor(id);
      if (!t || !a || t.form === undefined) return null;
      return { form: t.form, payload: t.payload, approver: a.approver_chain, at: t.updated_at };
    },

    /**
     * Does this approved held-act task cover exactly this act by this chain? Pure (it consumes nothing: the gateway counts the use once). The chain's acting actor must
     * be the task's doer, and the approved body's action and resource must be the ones asked.
     * @param {{ id: string, chain: any, action: string, resource: string, bind?: string, outward?: boolean }} q
     */
    approvedAct(q) {
      const a = api.approvalFor(q.id), t = tasks.get(q.id);
      // The bind: when the approval recorded the bind of exactly what the person saw (form.bind, a digest of the request as it would be sent), the request being sent must carry that same one: a different
      // request, or one that states none, is a different act and is refused (the connectors' calendar sync checks it for itself; this makes it universal for every outward act). A task approved for an outward act always records one (a Flow's held act, the calendar sync, the vault's held request).
      const recorded = t && t.form && typeof /** @type {any} */ (t.form).bind === "string" ? /** @type {any} */ (t.form).bind : null;
      const asked = typeof q.bind === "string" && q.bind ? q.bind : null;
      // One rule, no older looser path: an OUTWARD approval that recorded no bind covers nothing, since it could be spent on any act of that kind.
      if (q.outward === true && recorded === null) return false;
      if (recorded !== null && recorded !== asked) return false;
      // What the approval covers: the act the approved body names (a draft task's evidence) or, for a Flow's or a connector's held act, the act the task's own form names (kind held_act: action, resource, bind),
      // which the checker was shown and which is frozen with the task. Nothing else is covered.
      const form = t && t.form && /** @type {any} */ (t.form).kind === "held_act" ? /** @type {any} */ (t.form) : null;
      const coveredAction = a && a.body.action !== undefined ? a.body.action : form && form.action, coveredResource = a && a.body.resource !== undefined ? a.body.resource : form && form.resource;
      return Boolean(a && t && !usedApprovals.has(q.id) && clock() - t.updated_at <= APPROVAL_MAX_AGE && coveredAction === q.action && coveredResource === q.resource && same(acting(q.chain), t.doer) && approverOk(q.rule, approvedBy.get(q.id)) && approverStands(approvedBy.get(q.id)));
    },
    /** The same check, and when it holds the approval is spent in the same step: what `authorize` calls, so a held act is allowed once, within a day, by its doer. */
    useApproval(q) {
      if (!api.approvedAct(q)) return false;
      usedApprovals.add(q.id);
      return true;
    },

    /** Take free text out of the task store (kernel/tasks/scrub.js). */
    scrubTexts: createScrub({ tasks, bodies, texts, recs, recUpdate, withoutText, deepFreeze }),
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
  try {
    const f = { type: "task.*" };
    const evs = cfg.log && typeof cfg.log.read === "function" ? (cfg.log.iterate ? [...cfg.log.iterate(f)] : cfg.log.read(f)) : [];
    for (const e of evs) {
      const d = e && e.data;
      if (!d || !d.task || typeof d.task.id !== "string" || d.task.space !== cfg.space) continue;
      tasks.set(d.task.id, deepFreeze(structuredClone(d.task))); // text restored below
      if (e.type === "task.created" && typeof d.proposal_for === "string") proposals.set(d.task.id, d.proposal_for);
    }
    // The text comes back from the task store, and only if it hashes to what the log recorded; a task whose text is gone keeps its structure with a plain title.
    for (const [id, t] of [...tasks]) {
      const logged = /** @type {any} */ (t).text_hash, { text_hash: _h, ...rest } = /** @type {any} */ (t);
      const x = texts.get(id);
      const restored = x && typeof x === "object" ? withText(rest, x) : null;
      // A task logged before its title and note moved to the record hashed them too: that form still verifies, and the move onto records (`migrate`) takes the words from it.
      if (restored && (sha256(canonical(textOf(restored))) === logged || sha256(canonical({ title: restored.title, ...(restored.note !== undefined ? { note: restored.note } : {}), ...textOf(restored) })) === logged)) {
        tasks.set(id, deepFreeze(restored));
        if (t.state === "needs_check" && x.body && t.payload && sha256(canonical(x.body)) === t.payload.payload_hash) bodies.set(id, deepFreeze(structuredClone(x.body)));
      } else tasks.set(id, deepFreeze({ ...rest, title: "(the text of this task is no longer available)" }));
    }
    for (const [id, t] of tasks) if (t.state === "needs_check" && !bodies.has(id)) { const { payload, ...rest } = t; tasks.set(id, deepFreeze({ ...rest, state: "ready" })); }
  } catch { /* a log that cannot be read leaves no tasks, never a half set */ tasks.clear(); bodies.clear(); proposals.clear(); }
  {
    /**
     * Make a `task` record for every task the kernel holds that has none (the one-time move onto records, safe to run again: the task's id is the record's, so a task that has a record is skipped and a
     * crash in the middle is finished by the next run). One `tasks.migrated` event says how many were made.
     */
    api.migrate = async () => {
      let created = 0, existing = 0;
      for (const [id, t] of [...tasks]) {
        const have = await recs.get("task", id);
        if (have) { existing++; continue; }
        const made = await recs.create("task", id, recFieldsOf(t));
        recCache.set(id, { at: Date.now(), rec: made });
        created++;
      }
      if (created) { try { cfg.log.append(cfg.chains.fromFacts({ kind: "module", module: "tasks", first_party: true }), { type: "tasks.migrated", sv: 1, subject: urnOf(cfg.space, "all"), data: { created, existing } }); } catch { /* the records are the record of it */ } }
      return { created, existing };
    };
    // Every call that can change a task's state tells the record afterwards; the kernel's state is the truth if the record cannot be reached.
    for (const m of ["request", "start", "complete", "revise", "decide", "stuck", "observeDenial", "declineFix", "unblock", "skip", "edit", "reopen"]) {
      const f = api[m];
      api[m] = async (/** @type {any[]} */ ...a) => { try { return await f.apply(api, a); } finally { await mirrorAll(); } };
    }
  }
  const { _decideOnce, _requestOnce, ...pub } = api;
  const frozen = Object.freeze(pub);
  LIVE.set(frozen, (/** @type {string} */ id) => { const t = tasks.get(id); return Boolean(t) && !["done", "skipped"].includes(t.state); });
  VIEWS.set(frozen, (/** @type {string} */ record, /** @type {string} */ stage) => [...tasks.values()].filter(t => t.record === record && t.stage === stage).map(t => ({ title: t.title, state: t.state, required: Boolean(t.required) })));
  return frozen;
}
