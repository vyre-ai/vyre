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

import { holds, stagesFor } from "../../lib/expr/conditions.js";

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
 * }} o
 */
export function createStages(o) {
  const now = o.clock || Date.now;
  const emit = o.emit || (() => {});
  /** @type {Map<string, { key: string, urn: string, type: string, id: string, stage: string, tasks: { title: string, id: string, required: boolean, state?: string }[], advanced: boolean }>} */
  const entries = new Map();
  /** @type {Map<string, string>} task id -> entry key */
  const taskEntry = new Map();
  /** The latest entry per record and stage, so a late task event finds its entry. @type {Map<string, string>} */
  const latest = new Map();
  /** @type {Promise<void>} */ let queue = Promise.resolve();
  const serial = (/** @type {() => Promise<void>} */ fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  /** The record's values, or undefined when it cannot be read. @param {string} type @param {string} id */
  const recordData = async (type, id) => { try { const r = await o.kernel.records.get(o.chain(), type, id); return r && r.data; } catch { return undefined; } };
  /** The stages one record follows: its stage set (the first whose `when` holds for its values) or the type's default stages. @param {string} type @param {any} [data] */
  const stagesOfRecord = async (type, data) => { const c = await o.catalog(); const t = c.types && c.types[type]; if (!t) return []; return t.stage_sets && t.stage_sets.length && data ? stagesFor(t, data).stages : t.stages || []; };

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
    const owner = stage && stage.owner ? await actorFor(stage.owner, space, { record: e.urn, type: e.type, stage: e.stage }) : null;
    /** @type {Map<string, string>} */ const made = new Map();
    for (const t of templates) {
      const doer = await actorFor(t.doer, space, { record: e.urn, type: e.type, stage: e.stage, task: t });
      if (!doer) { emit("stage.error", { record: e.urn, stage: e.stage, task: t.title, why: `nobody can do ${t.doer}` }); continue; }
      const deps = [];
      for (const d of t.depends_on || []) { const id = made.get(d); if (id) deps.push(id); else emit("stage.error", { record: e.urn, stage: e.stage, task: t.title, why: `depends on ${d}, which was not made` }); }
      const spec = {
        title: t.title, record: e.urn, stage: e.stage, doer,
        ...(checkerFor(t.checker, space) ? { checker: checkerFor(t.checker, space) } : {}),
        output: { kind: t.output.kind, ...(t.output.target !== undefined ? { target: t.output.target } : {}) },
        ...(t.how ? { how: t.how } : {}),
        ...(t.template ? { template: `vyre://${space}/template/${t.template}` } : {}),
        ...(deps.length ? { depends_on: deps } : {}),
        ...(t.due_offset_ms ? { due: now() + t.due_offset_ms } : {}),
        ...(owner && t.due_offset_ms && owner.id !== doer.id ? { escalate_after: t.due_offset_ms, escalate_to: owner } : {}),
        // The kernel treats `required` as guarded (completion needs a check). A required task with no checker would wait for nobody, so the flag
        // goes to the kernel only where a checker or an outward send already guards the task; the module keeps its own required list either way.
        ...(t.required !== false && (t.checker || t.output.kind === "sent") ? { required: true } : {}),
      };
      const task = await o.kernel.ask.request(chain, spec, { idem: `stage:${key}:${t.title}` });
      made.set(t.title, task.id);
      ent.tasks.push({ title: t.title, id: task.id, required: t.required !== false });
      taskEntry.set(task.id, key);
    }
    emit("stage.tasks-made", { record: e.urn, stage: e.stage, tasks: ent.tasks.map(t => t.id) });
  }

  /** Is the entry's stage done? If so, move the record on, once. @param {string} key */
  async function settle(key) {
    const ent = entries.get(key);
    if (!ent || ent.advanced || !ent.tasks.length) return;
    const chain = o.chain();
    const rows = [];
    for (const t of ent.tasks) { const row = await o.kernel.ask.get(chain, t.id); if (!row) return; t.state = row.state; rows.push({ ...t, state: row.state }); }
    const required = rows.filter(r => r.required);
    const ok = required.length ? required.every(r => DONE.has(r.state)) : rows.every(r => FINISHED.has(r.state));
    if (!ok) { if (rows.some(r => r.state === "stuck")) emit("stage.blocked", { record: ent.urn, stage: ent.stage, tasks: rows.filter(r => r.state === "stuck").map(r => r.id) }); return; }
    const cur = await o.kernel.records.get(chain, ent.type, ent.id);
    // The stages this record follows: its stage set when the type has sets, else the type's own list.
    if (!cur) { ent.advanced = true; emit("stage.left-alone", { record: ent.urn, stage: ent.stage, now: undefined }); return; }
    const stages = await stagesOfRecord(ent.type, cur.data);
    const at = stages.findIndex((/** @type {any} */ s) => s.name === ent.stage);
    const next = stages[at + 1];
    if (at < 0) { ent.advanced = true; emit("stage.left-alone", { record: ent.urn, stage: ent.stage, now: cur.data.stage, why: "the stage is not in the set this record follows now" }); return; }
    // The next stage has an entry condition the record does not meet yet: it stays where it is, and the gateway would refuse the move anyway.
    if (next && typeof next.enter_if === "string" && !holds(next.enter_if, cur.data)) { emit("stage.blocked", { record: ent.urn, stage: ent.stage, why: `${next.name} cannot be entered yet: ${next.enter_if}` }); return; }
    ent.advanced = true;
    if (!next) { emit("stage.finished", { record: ent.urn, stage: ent.stage }); return; }
    // The record was moved by hand (or removed) while the tasks were open: leave it where the person put it.
    if (cur.data.stage !== ent.stage) { emit("stage.left-alone", { record: ent.urn, stage: ent.stage, now: cur.data.stage }); return; }
    try { await o.kernel.records.update(chain, ent.type, ent.id, { stage: next.name }, cur.version, { idem: `advance:${key}` }); }
    catch (e) { ent.advanced = false; throw e; }
    emit("stage.advanced", { record: ent.urn, from: ent.stage, to: next.name });
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

  return { onEvent, onStageEnter, stageTasks, idle: () => queue, enter: (/** @type {any} */ e) => serial(() => enter(e)), settle: (/** @type {string} */ k) => serial(() => settle(k)), entries: () => [...entries.values()] };
}
