// @ts-check
// Stages made of tasks (team/0.3/DESIGN-tasks.md, idea 5). A stage in a type's definition lists task templates. When a record enters a stage
// this module creates those tasks through `ask.request`; when the stage's required tasks are done it moves the record to the next stage, once.
// It is a module over kernel events: record.stage-entered (or a record created at a stage) in, task state events in, record updates out. It
// holds no permission of its own: every call runs under the module's chain, [the person who installed the Kit, service:stages], so the tasks
// it assigns carry that person as the assigner and never exceed what they could do.
//
//   const stages = createStages({ kernel, catalog, chain, ports, clock, emit });
//   kernel events -> stages.onEvent(event)
//
// Rules, in words:
// - Entering a stage makes its tasks once per entry (key: record, stage, the entry's event, template). A redelivered event makes nothing twice.
// - A task template: title, doer ("teammate:x" or "role:x"), checker ("role:x", optional), output, how, template, depends_on (titles in the same
//   stage), due_offset_ms, required (default true). A stage may name an owner (role:x or person:x): each task with a due offset then escalates to the owner when it is not done by then.
// - The stage advances when every required task is done. If it has tasks but none is required, when all are done or skipped. A stage with no tasks
//   never advances by itself (a person moves it), and the last stage has nowhere to go.
// - A stuck or rejected task simply is not done: nothing advances, nothing is made twice. A record that was moved by hand before the tasks
//   finished is left alone. Coming back into a stage later is a new entry with new tasks.

import { createHash } from "node:crypto";
import { holds, stagesFor } from "../../lib/expr/conditions.js";
import { renderBrief, evalChecklist } from "./checklist.js";

/** The task id an event is about: the data says it, or the subject's last segment does (the kernel's own task events carry only the subject). @param {any} env */
export function taskIdOf(env) {
  const d = env && env.data;
  if (d && typeof d === "object") { if (typeof d.task === "string") return d.task; if (typeof d.id === "string") return d.id; }
  const s = env && env.subject;
  return typeof s === "string" && /\/task\/[^/]+$/.test(s) ? s.slice(s.lastIndexOf("/") + 1) : null;
}

const DONE = new Set(["done"]);
const FINISHED = new Set(["done", "skipped"]);

/**
 * @param {{
 *   kernel: any, catalog: () => any, chain: () => any,
 *   ports?: { roles?: (space: string, role: string) => any[] | Promise<any[]>, doer?: (role: string, ctx: any) => any },
 *   clock?: () => number, emit?: (type: string, data: any) => void,
 *   hook?: boolean,  // the gateway calls onStageEnter itself, so the record.stage-entered event is not a second way in
 *   gates?: { open: (g: any) => Promise<string>, mark: (id: string, key: string, patch: any, o?: any) => Promise<any>, close: (id: string, o?: any) => Promise<any>, list: () => Promise<any[]> },  the runner's stage gates (s1): each stage entry with tasks is a run there, so it is written down, shown and logged
 *   isAdmin?: (who: any) => Promise<boolean> | boolean,  who may move a record on early besides the stage owner
 * }} o
 */
export function createStages(o) {
  const now = o.clock || Date.now;
  // A project started from a template carries the template's stages, pinned at the moment it started (`template_snapshot`, JSON: { stages }), so a running project keeps the version it began with; the
  // stage it is in is `template_stage` (text, so the template's own names are its stage names). Such a record is driven by this module alone: the gateway's stage hook only sees `stage` fields.
  /** @type {Map<string, any>} */ const pins = new Map();
  /** @param {any} data @returns {{ stages: any[] } | null} */
  const snapshotOf = data => {
    const t = data && typeof data.template_snapshot === "string" ? data.template_snapshot : "";
    if (!t) return null;
    if (!pins.has(t)) { try { const j = JSON.parse(t); pins.set(t, j && Array.isArray(j.stages) ? j : null); } catch { pins.set(t, null); } }
    return pins.get(t);
  };
  /** The entry a move into the next stage makes: short and stable (a task's idempotency key is built from it, and an entry's key holds the one before). @param {string} key */
  const advEntry = key => `adv:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  /** The field a record's stage is kept in. @param {any} data */
  const fieldOf = data => (snapshotOf(data) ? "template_stage" : "stage");
  const emit = o.emit || (() => {});
  /** @type {Map<string, { key: string, urn: string, type: string, id: string, stage: string, tasks: { title: string, id: string, required: boolean, state?: string }[], advanced: boolean, waitingOn?: string, run?: string, owner?: string | null, next?: string | null }>} */
  const entries = new Map();
  /** @type {Map<string, string>} task id -> entry key */
  const taskEntry = new Map();
  /** The latest entry per record and stage, so a late task event finds its entry. @type {Map<string, string>} */
  const latest = new Map();
  /** The last events seen (type and time), for a checklist item that waits for an answer to arrive. @type {{ type: string, at: number }[]} */
  const seen = [];
  /** @type {Promise<void>} */ let queue = Promise.resolve();
  const serial = (/** @type {() => Promise<void>} */ fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  /** The record's values, or undefined when it cannot be read. @param {string} type @param {string} id */
  const recordData = async (type, id) => { try { const r = await o.kernel.records.get(o.chain(), type, id); return r && r.data; } catch { return undefined; } };
  /** The stages one record follows: its stage set (the first whose `when` holds for its values) or the type's default stages. @param {string} type @param {any} [data] */
  const stagesOfRecord = async (type, data) => { const pinned = snapshotOf(data); if (pinned) return pinned.stages; const c = await o.catalog(); const t = c.types && c.types[type]; if (!t) return []; return t.stage_sets && t.stage_sets.length && data ? stagesFor(t, data).stages : t.stages || []; };

  /** @param {string} spec @param {string} space */
  async function actorFor(spec, space, ctx) {
    const [kind, name] = String(spec).split(":");
    if (kind === "teammate") return { kind: "agent", id: name, space };
    if (kind === "person") return { kind: "person", id: name, space };
    if (kind === "role") {
      if (o.ports && o.ports.doer) { const d = await o.ports.doer(name, ctx); if (d) return d; }
      const holders = ((o.ports && o.ports.roles && (await o.ports.roles(space, name))) || []).filter((/** @type {any} */ a) => a.kind === "person");
      if (holders[0]) return holders[0];
    }
    return null;
  }
  const checkerFor = (/** @type {string|undefined} */ spec, /** @type {string} */ space) => {
    if (!spec) return undefined;
    const [kind, name] = String(spec).split(":");
    if (kind === "role") return { role: name };
    if (kind === "person") return { kind: "person", id: name, space };
    return undefined;
  };

  /** The note a task carries: its brief with the record filled in, what must hold before it is done, and the Connections it may use. @param {any} t @param {Record<string, any>} data */
  function noteOf(t, data) {
    const parts = [];
    if (t.brief) parts.push(renderBrief(t.brief, data));
    if (Array.isArray(t.checklist) && t.checklist.length) parts.push(`Before this counts as done:\n${t.checklist.map((/** @type {any} */ c) => `- ${c.say}`).join("\n")}`);
    if (Array.isArray(t.credentials) && t.credentials.length) parts.push(`Connections you may use: ${t.credentials.join(", ")}.`);
    return parts.join("\n\n");
  }

  /** A record entered a stage: make its tasks. `templates` are the ones the gateway handed over (onStageEnter); otherwise the catalog's. @param {{ urn: string, type: string, id: string, stage: string, entry: string, templates?: any[], owner?: string }} e */
  async function enter(e) {
    const stage = e.templates ? { tasks: e.templates, owner: e.owner } : (await stagesOfRecord(e.type, await recordData(e.type, e.id))).find((/** @type {any} */ s) => s.name === e.stage);
    const key = `${e.urn}|${e.stage}|${e.entry}`;
    if (entries.has(key)) return;
    const space = (await o.catalog()).space;
    const templates = (stage && stage.tasks) || [];
    const ent = { key, urn: e.urn, type: e.type, id: e.id, stage: e.stage, tasks: /** @type {any[]} */ ([]), advanced: false };
    entries.set(key, ent);
    latest.set(`${e.urn}|${e.stage}`, key);
    if (!templates.length) return;
    const chain = o.chain();
    // The stage owner (role:x or person:x) is told when one of its tasks is not done by its due offset: the task's escalate_to, read by the planner.
    const data = (await recordData(e.type, e.id)) || {};
    const owner = stage && stage.owner ? await actorFor(stage.owner, space, { record: e.urn, type: e.type, stage: e.stage }) : null;
    /** @type {Map<string, string>} */ const made = new Map();
    /** @type {{ task: string, why: string }[]} */ const skipped = [];
    for (const t of templates) {
      const doer = await actorFor(t.doer, space, { record: e.urn, type: e.type, stage: e.stage, task: t });
      if (!doer) { emit("stage.error", { record: e.urn, stage: e.stage, task: t.title, why: `nobody can do ${t.doer}` }); skipped.push({ task: t.title, why: `nobody can do ${t.doer}` }); continue; }
      const deps = [];
      for (const d of t.depends_on || []) { const id = made.get(d); if (id) deps.push(id); else emit("stage.error", { record: e.urn, stage: e.stage, task: t.title, why: `depends on ${d}, which was not made` }); }
      const spec = {
        title: t.title, record: e.urn, stage: e.stage, doer,
        ...(checkerFor(t.checker, space) ? { checker: checkerFor(t.checker, space) } : {}),
        output: { kind: t.output.kind, ...(t.output.target !== undefined ? { target: t.output.target } : {}) },
        ...(t.how ? { how: t.how } : {}),
        ...(noteOf(t, data) ? { note: noteOf(t, data) } : {}),
        ...(t.template ? { template: `vyre://${space}/template/${t.template}` } : {}),
        ...(deps.length ? { depends_on: deps } : {}),
        ...(t.due_offset_ms ? { due: now() + t.due_offset_ms } : {}),
        ...(owner && t.due_offset_ms && owner.id !== doer.id ? { escalate_after: t.due_offset_ms, escalate_to: owner } : {}),
        // The kernel treats `required` as guarded (completion needs a check). A required task with no checker would wait for nobody, so the flag
        // goes to the kernel only where a checker or an outward send already guards the task; the module keeps its own required list either way.
        ...(t.required !== false && (t.checker || t.output.kind === "sent") ? { required: true } : {}),
      };
      /** @type {any} */ let task;
      // One task the kernel refuses (its doer is not a member of the Space yet) is said so and skipped; the stage's other tasks are still made.
      try { task = await o.kernel.ask.request(chain, spec, { idem: `stage:${key}:${t.title}` }); }
      catch (err) {
        emit("stage.error", { record: e.urn, stage: e.stage, task: t.title, why: `the task could not be made: ${err instanceof Error ? err.message : String(err)}` });
        skipped.push({ task: t.title, why: err && /** @type {any} */ (err).code === "not_a_member" ? `${doer.id} is not in this space yet` : `it could not be made: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      made.set(t.title, task.id);
      ent.tasks.push({ title: t.title, id: task.id, required: t.required !== false, since: now(), ...(t.checklist && t.checklist.length ? { checklist: t.checklist } : {}) });
      taskEntry.set(task.id, key);
    }
    emit("stage.tasks-made", { record: e.urn, stage: e.stage, tasks: ent.tasks.map(t => t.id) });
    await openGate(ent, stage && stage.owner ? String(stage.owner) : null);
    return { made: ent.tasks.length, skipped };
  }

  /** The gate for this entry on the runner. A gate is a record of what happened, so a fault in it never stops the stage. @param {any} ent @param {string | null} owner */
  async function openGate(ent, owner) {
    if (!o.gates || !ent.tasks.length) return;
    try {
      const stages = await stagesOfRecord(ent.type, await recordData(ent.type, ent.id));
      const at = stages.findIndex((/** @type {any} */ s) => s.name === ent.stage);
      ent.owner = owner; ent.next = at >= 0 && stages[at + 1] ? stages[at + 1].name : null;
      ent.run = await o.gates.open({ key: ent.key, urn: ent.urn, type: ent.type, id: ent.id, stage: ent.stage, next: ent.next, owner: owner || undefined, tasks: ent.tasks.map((/** @type {any} */ t) => ({ id: t.id, title: t.title, required: t.required, ...(t.since ? { since: t.since } : {}), ...(t.checklist ? { checklist: t.checklist } : {}) })) });
    } catch (err) { emit("stage.error", { record: ent.urn, stage: ent.stage, why: `the gate could not be written: ${err instanceof Error ? err.message : String(err)}` }); }
  }

  /** Write a gate step; never throws into the stage. @param {any} ent @param {string} key @param {any} patch @param {any} [opts] */
  async function mark(ent, key, patch, opts) { if (!o.gates || !ent.run) return; try { await o.gates.mark(ent.run, key, patch, opts); } catch { /* the gate is a record, not a rule */ } }
  /** @param {any} ent @param {any} [opts] */
  async function closeGate(ent, opts) { if (!o.gates || !ent.run) return; try { await o.gates.close(ent.run, opts); } catch { /* as above */ } }

  /** Is the entry's stage done? If so, move the record on, once. @param {string} key */
  async function settle(key) {
    const ent = entries.get(key);
    if (!ent || ent.advanced || !ent.tasks.length) return;
    const chain = o.chain();
    const rows = [];
    for (const t of ent.tasks) { const row = await o.kernel.ask.get(chain, t.id); if (!row) return; t.state = row.state; rows.push({ ...t, state: row.state }); }
    // A task the kernel calls done counts only when its checklist holds (s2): the gate looks, the doer's word is not enough.
    let listed = false;
    for (const r of rows) {
      const t = ent.tasks.find(/** @param {any} x */ x => x.id === r.id);
      if (!DONE.has(r.state) || !t || !t.checklist) continue;
      const data = (await recordData(ent.type, ent.id)) || {};
      const ev = await evalChecklist(t.checklist, { data, since: t.since || 0, now: now(), seen, memo: t.memo, ...(o.gates && o.gates.read ? { read: (/** @type {any} */ spec) => /** @type {any} */ (o.gates).read(spec, o.chain()) } : {}) });
      t.memo = ev.memo; t.due = ev.due;
      if (!ev.ok) {
        r.state = "checking"; t.state = "checking"; listed = true;
        const missing = ev.results.filter(x => !x.ok);
        emit("stage.checklist-failed", { record: ent.urn, stage: ent.stage, task: t.title, missing: missing.map(x => x.say) });
        await mark(ent, `task:${t.title}`, { status: "waiting", output: { required: t.required, checklist: ev.results.map(x => ({ say: x.say, ok: x.ok })), memo: ev.memo, since: t.since } });
        r.checkedFail = true;
      } else await mark(ent, `task:${t.title}`, { status: "done", output: { required: t.required, checklist: ev.results.map(x => ({ say: x.say, ok: true })), memo: ev.memo, since: t.since } });
    }
    ent.waitingOn = listed ? "checklist" : ent.waitingOn === "checklist" ? undefined : ent.waitingOn;
    for (const r of rows) if (!r.checkedFail && !((ent.tasks.find(/** @param {any} t */ t => t.id === r.id) || {}).checklist && r.state === "done")) await mark(ent, `task:${r.title}`, DONE.has(r.state) ? { status: "done" } : r.state === "skipped" ? { status: "skipped" } : r.state === "stuck" ? { status: "failed", error: { code: "stuck", message: "the task is stuck" } } : { status: "waiting" });
    const required = rows.filter(r => r.required);
    const ok = required.length ? required.every(r => DONE.has(r.state)) : rows.every(r => FINISHED.has(r.state));
    if (!ok) { if (rows.some(r => r.state === "stuck")) { emit("stage.blocked", { record: ent.urn, stage: ent.stage, tasks: rows.filter(r => r.state === "stuck").map(r => r.id) }); await mark(ent, "tasks", { status: "waiting" }, { attention: { kind: "stuck", message: `a task of ${ent.stage} is stuck: ${rows.filter(r => r.state === "stuck").map(r => r.title).join(", ")}` } }); } return; }
    await mark(ent, "tasks", { status: "done" });
    const cur = await o.kernel.records.get(chain, ent.type, ent.id);
    // The stages this record follows: its stage set when the type has sets, else the type's own list.
    if (!cur) { ent.advanced = true; emit("stage.left-alone", { record: ent.urn, stage: ent.stage, now: undefined }); await closeGate(ent, { note: "the record is gone" }); return; }
    const stages = await stagesOfRecord(ent.type, cur.data);
    const at = stages.findIndex((/** @type {any} */ s) => s.name === ent.stage);
    const next = stages[at + 1];
    if (at < 0) { ent.advanced = true; emit("stage.left-alone", { record: ent.urn, stage: ent.stage, now: cur.data[fieldOf(cur.data)], why: "the stage is not in the set this record follows now" }); await closeGate(ent, { note: "the stage is not in the set this record follows now" }); return; }
    // The next stage has an entry condition the record does not meet yet: it stays where it is, and the gateway would refuse the move anyway.
    if (next && typeof next.enter_if === "string" && !holds(next.enter_if, cur.data)) { emit("stage.blocked", { record: ent.urn, stage: ent.stage, why: `${next.name} cannot be entered yet: ${next.enter_if}` }); ent.waitingOn = "condition"; await mark(ent, "condition", { status: "waiting", output: { say: `${next.name} cannot be entered yet: ${next.enter_if}` } }, { attention: { kind: "stale", message: `${next.name} cannot be entered yet: ${next.enter_if}` } }); return; }
    ent.waitingOn = undefined;
    if (next && typeof next.enter_if === "string") await mark(ent, "condition", { status: "done", output: { say: `${next.enter_if} holds` } });
    ent.advanced = true;
    if (!next) { emit("stage.finished", { record: ent.urn, stage: ent.stage }); await closeGate(ent, { note: "the last stage" }); return; }
    // The record was moved by hand (or removed) while the tasks were open: leave it where the person put it.
    if (cur.data[fieldOf(cur.data)] !== ent.stage) { emit("stage.left-alone", { record: ent.urn, stage: ent.stage, now: cur.data[fieldOf(cur.data)] }); await closeGate(ent, { note: `the record was moved to ${cur.data[fieldOf(cur.data)]} by hand` }); return; }
    try { await o.kernel.records.update(chain, ent.type, ent.id, { [fieldOf(cur.data)]: next.name }, cur.version, { idem: `advance:${key}` }); }
    catch (e) { ent.advanced = false; throw e; }
    emit("stage.advanced", { record: ent.urn, from: ent.stage, to: next.name });
    await mark(ent, "move", { status: "done", output: { to: next.name } });
    await closeGate(ent);
    // a template project's next stage is entered here: the gateway's hook does not see its text field
    if (fieldOf(cur.data) === "template_stage") await enter({ urn: ent.urn, type: ent.type, id: ent.id, stage: next.name, entry: advEntry(key) });
  }

  /** The gateway's onStageEnter hook: the record, the stage and the stage's task templates, handed over right after the write. Never throws into the write. @param {{ record: string, stage: string, templates: any[], owner?: string }} e */
  function onStageEnter(e) {
    const m = /^vyre:\/\/[^/]+\/([^/]+)\/([^/]+)$/.exec(e.record);
    if (!m) return Promise.resolve();
    // Not awaited: the gateway calls this inside the write, and the queue may be mid-advance on this very record (an awaited call would wait on itself).
    void serial(() => enter({ urn: e.record, type: m[1], id: m[2], stage: e.stage, entry: `gw${++entrySeq}`, templates: e.templates, owner: e.owner })).catch(err => emit("stage.error", { record: e.record, stage: e.stage, why: String(err && err.message) }));
    return Promise.resolve();
  }
  let entrySeq = 0;

  /** The gateway's stageTasks port (sync): what this record's latest entry into `stage` made, with the states last seen. Fail closed: unknown states are not done. */
  function stageTasks(/** @type {string} */ urn, /** @type {string} */ stage) {
    const key = latest.get(`${urn}|${stage}`);
    const ent = key && entries.get(key);
    return ent ? ent.tasks.map(t => ({ title: t.title, state: t.state || "ready" })) : [];
  }

  /** One kernel event in. Safe to call with every event; it reads only the ones it needs. @param {any} env */
  function onEvent(env) {
    if (env && typeof env.type === "string") { seen.push({ type: env.type, at: now() }); if (seen.length > 400) seen.splice(0, seen.length - 400); }
    return serial(async () => {
      if (!env || typeof env.type !== "string") return;
      if (env.type === "record.stage-entered" && env.data && env.data.stage) {
        if (o.hook) return;
        await enter({ urn: env.subject, type: env.data.type, id: env.data.id, stage: env.data.stage, entry: String(env.id || env.seq) });
        // an entry that has no required work left (all optional and already finished) can settle at once
        return;
      }
      if (env.type.startsWith("task.")) {
        const id = taskIdOf(env);
        const st = env.data && env.data.state;
        if (!id || !st) return;
        const key = taskEntry.get(id);
        if (key) await settle(key);
      }
    });
  }

  /** After a restart: the open gates on the runner are the entries this module lost, so it takes them back and looks at each once. */
  async function resume() {
    if (!o.gates) return 0;
    let n = 0;
    for (const run of await o.gates.list()) {
      const g = run.gate;
      if (!g || entries.has(g.key)) continue;
      const ent = { key: g.key, urn: g.urn, type: g.type, id: g.record, stage: g.stage, tasks: g.tasks.map((/** @type {any} */ t) => ({ ...t, memo: run.steps[`task:${t.title}`] && run.steps[`task:${t.title}`].output ? run.steps[`task:${t.title}`].output.memo : undefined })), advanced: false, run: run.id, owner: g.owner, next: g.next };
      entries.set(g.key, ent);
      latest.set(`${g.urn}|${g.stage}`, g.key);
      for (const t of ent.tasks) taskEntry.set(t.id, g.key);
      n++;
    }
    for (const ent of [...entries.values()]) if (ent.run && !ent.advanced) await serial(() => settle(ent.key));
    return n;
  }

  /** A gate held back by the next stage's entry condition is looked at again (nothing tells this module a record changed, so the host's tick asks). */
  function tick() { return serial(async () => { for (const ent of [...entries.values()]) if (ent.run && !ent.advanced && ent.waitingOn) await settle(ent.key); }); }

  /** Who may move a record on early: the stage's owner (a person, or anyone holding the role), or an admin. @param {any} ent @param {any} who */
  async function mayAdvance(ent, who) {
    if (ent.owner) {
      const [kind, name] = String(ent.owner).split(":");
      if (kind === "person" && name === who.id) return true;
      if (kind === "role" && o.ports && o.ports.roles) { const holders = (await o.ports.roles((await o.catalog()).space, name)) || []; if (holders.some((/** @type {any} */ a) => a.id === who.id)) return true; }
    }
    return o.isAdmin ? Boolean(await o.isAdmin(who)) : false;
  }

  /**
   * Move a record on before its tasks are done, by the person who may (the stage's owner or an admin). It is on the gate's ledger with who and why, and the move itself is the same write
   * the stage would have made, so the next stage's entry condition still holds it back. @param {string} runId @param {any} who @param {string} reason
   */
  function advance(runId, who, reason) {
    return serial(async () => {
      const ent = [...entries.values()].find(e => e.run === runId);
      const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
      if (!ent) throw fail("not_found", "no open stage gate has that id (flows.runs shows the gates)");
      if (ent.advanced) throw fail("bad_state", "that gate is already over");
      if (!ent.next) throw fail("bad_state", "this is the last stage; there is nowhere to move it");
      if (!(await mayAdvance(ent, who))) throw fail("not_allowed", "only the stage's owner or an admin moves a record on early");
      if (!reason || !String(reason).trim()) throw fail("bad_input", "reason is required: say why it moves on early");
      const chain = o.chain();
      const cur = await o.kernel.records.get(chain, ent.type, ent.id);
      if (!cur || cur.data[fieldOf(cur.data)] !== ent.stage) throw fail("bad_state", "the record is not in that stage any more");
      await o.kernel.records.update(chain, ent.type, ent.id, { [fieldOf(cur.data)]: ent.next }, cur.version, { idem: `advance:${ent.key}` });
      ent.advanced = true;
      await mark(ent, "move", { status: "done", output: { to: ent.next, early: true, by: who.id, reason: String(reason).slice(0, 300) } });
      await closeGate(ent, { note: `moved on early by ${who.id}: ${String(reason).slice(0, 120)}` });
      emit("stage.advanced-early", { record: ent.urn, from: ent.stage, to: ent.next, by: who.id, reason: String(reason).slice(0, 300) });
      if (fieldOf(cur.data) === "template_stage") await enter({ urn: ent.urn, type: ent.type, id: ent.id, stage: ent.next, entry: advEntry(ent.key) });
      return { ok: true, record: ent.urn, from: ent.stage, to: ent.next };
    });
  }

  return { resume, tick, advance, onEvent, onStageEnter, stageTasks, idle: () => queue, enter: (/** @type {any} */ e) => serial(() => enter(e)), settle: (/** @type {string} */ k) => serial(() => settle(k)), entries: () => [...entries.values()] };
}
