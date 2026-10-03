// @ts-check
// deck/ui/mock-store: an in-memory Store (contracts.js) for the Deck's generated screens, the lab and the tests, until the real gateway adapter lands
// (ui/store.js is the one switch). It enforces the same rules the kernel will: a task moves by tasks.js alone, a sealed field never leaves in a read, an
// assistant's view never holds a sealed value, Reveal returns a value for 30 seconds, and approving a task records an event and sends nothing.
//
// Worlds: "morning" (the morning after a payment: spaces Mine and Harlow Legal, Alex Rivera, Chris Park, juno, kit, Research, Intake, Drafting, Jane Doe and
// the rest, tasks k1..k28 from the approved prototype), "payday" (the same without Doe estate plan, so the "client pays" scenario can play on top of it),
// and "empty" (spaces, people and types only).
import { advanceStage, approve, makeStuck, move, ownerOf, reassign, spawnStage, startState, unblock, whyNot } from "./tasks.js";

/** @typedef {import("./contracts.js").Store} Store */
/** @typedef {import("./contracts.js").Task} Task */
/** @typedef {import("./contracts.js").RecordRow} RecordRow */
/** @typedef {import("./contracts.js").TypeDef} TypeDef */
/** @typedef {import("./contracts.js").Actor} Actor */
/** @typedef {import("./contracts.js").VyreEvent} VyreEvent */

export const REVEAL_MS = 30_000;
const PROOFS = ["face_id", "touch_id", "passkey"];
const STAGES = ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"];

/** @type {import("./contracts.js").Space[]} */
const SPACES = [
  { id: "mine", name: "Mine", kind: "mine", accent: "violet" },
  { id: "harlow", name: "Harlow Legal", kind: "team", accent: "amber", density: "compact" },
];

/** @type {Actor[]} */
const ACTORS = [
  { id: "alex", kind: "person", name: "Alex Rivera", role: "Attorney", seed: "alex-rivera" },
  { id: "chris", kind: "person", name: "Chris Park", role: "Attorney", seed: "chris-park" },
  { id: "juno", kind: "assistant", name: "juno", role: "Assistant", seed: "juno", owner: "alex" },
  { id: "kit", kind: "assistant", name: "kit", role: "Assistant", seed: "kit", owner: "alex" },
  { id: "iris", kind: "assistant", name: "iris", role: "Assistant", seed: "iris", owner: "chris" },
  { id: "rev", kind: "assistant", name: "rev", role: "Assistant", seed: "rev", owner: "alex" },
  { id: "research", kind: "teammate", name: "Research", role: "Teammate, Harlow Legal", seed: "research-harlow", owner: "alex" },
  { id: "intake", kind: "teammate", name: "Intake", role: "Teammate, Harlow Legal", seed: "intake-harlow", owner: "alex" },
  { id: "drafting", kind: "teammate", name: "Drafting", role: "Teammate, Harlow Legal", seed: "drafting-harlow", owner: "alex" },
  { id: "vyre", kind: "device", name: "Vyre", role: "The Kit and its Flows", seed: "vyre" },
];

/** @type {TypeDef[]} */
const FALLBACK_TYPES = [
  { id: "contact", name: "Contact", plural: "Contacts", icon: "contacts", space: "harlow", titleKey: "name", views: { list: { columns: ["role", "email", "phone"] } }, fields: [
    { key: "name", label: "Name", kind: "text", required: true }, { key: "role", label: "Role", kind: "choice", options: ["Client", "Vendor", "Referrer", "Friend"] },
    { key: "email", label: "Email", kind: "email" }, { key: "phone", label: "Phone", kind: "phone" },
    { key: "dob", label: "Date of birth", kind: "date", sealed: true }, { key: "ssn", label: "SSN", kind: "sealed", sealed: true }, { key: "notes", label: "Notes", kind: "richText" }] },
  { id: "matter", name: "Matter", plural: "Matters", icon: "records", space: "harlow", titleKey: "title", holdsWork: true,
    views: { list: { columns: ["client", "stage", "fee", "owner"] }, board: { groupBy: "stage", card: ["title", "client", "fee", "owner"] } }, fields: [
      { key: "title", label: "Title", kind: "text", required: true }, { key: "client", label: "Client", kind: "link", link: "contact" },
      { key: "plan", label: "Plan", kind: "choice", options: ["Will", "Trust", "Both"] }, { key: "situation", label: "Family situation", kind: "text" },
      { key: "assets", label: "Assets in play", kind: "text" }, { key: "pressure", label: "Time pressure", kind: "text" },
      { key: "research", label: "Research notes", kind: "richText" }, { key: "fee", label: "Fee", kind: "money", currency: "USD" },
      { key: "stage", label: "Stage", kind: "stage", stages: STAGES }, { key: "owner", label: "Owner", kind: "actor" },
      { key: "signing", label: "Signing date", kind: "date" }, { key: "closing", label: "Closing date", kind: "date" }] },
  { id: "project", name: "Project", plural: "Projects", icon: "projects", space: "harlow", titleKey: "title", holdsWork: true, views: { list: { columns: ["owner", "due"] } }, fields: [
    { key: "title", label: "Title", kind: "text", required: true }, { key: "owner", label: "Owner", kind: "actor" }, { key: "due", label: "Due", kind: "date" },
    { key: "brief", label: "Brief", kind: "richText" }] },
  { id: "trip", name: "Trip", plural: "Trips", icon: "projects", space: "mine", titleKey: "title", holdsWork: true, views: { list: { columns: ["dest", "dates", "stage"] } }, fields: [
    { key: "title", label: "Title", kind: "text", required: true }, { key: "dest", label: "Destination", kind: "text" }, { key: "dates", label: "Dates", kind: "date" },
    { key: "budget", label: "Budget", kind: "money", currency: "USD" }, { key: "stage", label: "Stage", kind: "stage", stages: ["Dreaming", "Booked", "Packed"] }] },
  { id: "template", name: "Template", plural: "Templates", icon: "file", space: "harlow", titleKey: "name", views: { list: { columns: ["kind", "subject"] } }, fields: [
    { key: "name", label: "Name", kind: "text", required: true }, { key: "kind", label: "Kind", kind: "choice", options: ["Email", "Letter", "Document"] },
    { key: "subject", label: "Subject", kind: "text" }, { key: "body", label: "Body", kind: "richText" }] },
];

/** The Kit "Estate planning matter": the tasks each stage makes (DESIGN-tasks.md, idea 5). Titles may hold {client}. */
export const ESTATE_KIT = {
  id: "estate", name: "Estate planning matter", type: "matter",
  /** @type {Record<string, import("./tasks.js").TaskTemplate[]>} */
  stageTasks: {
    Intake: [
      { title: "Research the client", doer: "research", output: { kind: "fields", target: "Family situation, Assets in play, Time pressure, Research notes", fields: ["situation", "assets", "pressure", "research"] }, how: "assistant", dueInDays: 0 },
      { title: "Welcome email for {client}", doer: "intake", checker: "alex", output: { kind: "sent", target: "Email to {client}" }, how: "tailor", template: "tpl1", dependsOn: ["Research the client"], dueInDays: 0 },
    ],
    Engagement: [
      { title: "Engagement letter", doer: "drafting", checker: "alex", output: { kind: "sent", target: "Letter for signature" }, how: "tailor", template: "tpl2", dueInDays: 1 },
      { title: "Review the draft with {client}", doer: "alex", output: { kind: "decision", target: "Approved or changes" }, how: "person", dependsOn: ["Engagement letter"], dueInDays: 3 },
    ],
    Drafting: [{ title: "Draft the trust and will", doer: "drafting", checker: "chris", output: { kind: "file", target: "Trust and will" }, how: "assistant", dueInDays: 5 }],
    Signing: [
      { title: "Signing date", doer: "alex", output: { kind: "fields", target: "Signing date", fields: ["signing"] }, how: "person" },
      { title: "Collect signatures", doer: "alex", output: { kind: "file", target: "Signed documents" }, how: "person", dependsOn: ["Signing date"] },
    ],
    Funding: [{ title: "Fund the trust and record the deed", doer: "rev", checker: "chris", output: { kind: "file", target: "Recorded deed" }, how: "assistant" }],
  },
};

const blank = (/** @type {any} */ v) => v === undefined || v === null || v === "";
const clone = (/** @type {any} */ v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Types: the ones deck/ui/types.js defines (another agent writes it), with this file's minimal copy behind them for any it lacks. */
async function loadTypes() {
  /** @type {any[]} */
  let loaded = [];
  try {
    const m = /** @type {any} */ (await import("./types.js"));
    const v = m.types ?? m.TYPES ?? m.sampleTypes ?? m.default;
    loaded = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [];
  } catch { loaded = []; }
  const byId = new Map(FALLBACK_TYPES.map(t => [t.id, clone(t)]));
  for (const t of loaded) {
    if (!t || !t.id) continue;
    const mine = byId.get(t.id);
    const def = clone(t);
    // The scenario writes these fields on a matter; a type from types.js that lacks one gets it from the minimal copy.
    if (mine) for (const f of mine.fields) if (!def.fields.some((/** @type {any} */ x) => x.key === f.key)) def.fields.push(f);
    byId.set(t.id, def);
  }
  return [...byId.values()];
}

/**
 * @param {{ world?: "morning"|"payday"|"empty", now?: () => number, me?: string }} [opts]
 * @returns {Store & { kit: typeof ESTATE_KIT, world: string }}
 */
export function createMockStore(opts = {}) {
  const world = opts.world || "morning";
  const clock = opts.now || (() => Date.now());
  const meId = opts.me || "alex";
  /** @type {Map<string, RecordRow>} raw values, sealed ones included: never returned by a read */
  const records = new Map();
  /** @type {Map<string, Task>} */
  const tasks = new Map();
  /** @type {VyreEvent[]} */
  const events = [];
  /** @type {Set<() => void>} */
  const subs = new Set();
  /** @type {Map<string, { value: string, until: number }>} */
  const reveals = new Map();
  let nTask = 0, nEvent = 0;
  /** @type {Record<string, number>} */
  const nRec = {};
  /** @type {TypeDef[]} */
  let types = [];
  const ready = loadTypes().then(t => { types = t; seed(); });

  const actorList = () => ACTORS;
  const nameOf = (/** @type {string|undefined} */ id) => ACTORS.find(a => a.id === id)?.name || id || "Someone";
  const typeOf = (/** @type {string} */ id) => types.find(t => t.id === id);
  const sealedKeys = (/** @type {TypeDef|undefined} */ t) => (t ? t.fields.filter(f => f.sealed || f.kind === "sealed").map(f => f.key) : []);
  const titleOf = (/** @type {RecordRow|null|undefined} */ r) => (r ? String(r.values[typeOf(r.type)?.titleKey || "title"] ?? r.id) : "");
  const notify = () => { for (const f of [...subs]) { try { f(); } catch (e) { console.error(e); } } };

  /** @param {Omit<VyreEvent, "id"|"at"> & { at?: number }} e */
  function log(e) { const ev = { id: `e${++nEvent}`, at: clock(), ...e }; events.push(ev); return ev; }

  /** A record as a read returns it: sealed values replaced by { sealed: true, last4? }. @param {RecordRow} r @returns {RecordRow} */
  function masked(r) {
    const t = typeOf(r.type), sealed = new Set(sealedKeys(t)), values = clone(r.values);
    for (const k of sealed) {
      if (blank(r.values[k])) { delete values[k]; continue; }
      const def = t?.fields.find(f => f.key === k);
      values[k] = def?.showLast4 ? { sealed: true, last4: String(r.values[k]).slice(-4) } : { sealed: true };
    }
    return { ...r, values };
  }

  /** @param {string} type @param {string} space @param {Record<string, any>} values @param {string} [stage] @param {string} [id] */
  function put(type, space, values, stage, id) {
    const rid = id || `${type[0]}${(nRec[type] = (nRec[type] || 0) + 1)}`;
    const t = clock();
    const row = { id: rid, type, space, values: { ...values }, ...(stage ? { stage } : {}), createdAt: t, updatedAt: t };
    records.set(rid, /** @type {RecordRow} */ (row));
    return /** @type {RecordRow} */ (row);
  }

  /** Create a task with the next id. @param {Partial<Task> & { title: string, record: string, doer: string }} t */
  function addTask(t) {
    const id = t.id || `k${++nTask}`;
    const task = /** @type {Task} */ ({ checker: null, helpers: [], output: { kind: "file" }, inputs: [], dependsOn: [], due: null, state: "ready", stuck: null, session: null, ...t, id });
    tasks.set(id, task);
    return task;
  }

  const tasksOf = (/** @type {string} */ recordId) => [...tasks.values()].filter(t => t.record === recordId);

  /** After a change: unblock what waits, then move the record's stage on if its required tasks are done, spawning the next stage's tasks. Repeats until stable. */
  function settle(/** @type {string} */ recordId, /** @type {string} */ by) {
    const rec = records.get(recordId);
    if (!rec) return;
    const stagesOf = typeOf(rec.type)?.fields.find(f => f.kind === "stage")?.stages;
    for (let guard = 0; guard < 12; guard++) {
      const un = unblock(tasksOf(recordId), actorList());
      for (const t of un.tasks) if (tasks.get(t.id) !== t) tasks.set(t.id, t);
      for (const id of un.started) { const t = tasks.get(id); if (t && t.state === "working") log({ record: recordId, task: id, actor: t.doer, what: `started ${t.title}` }); }
      if (!stagesOf || !rec.stage) return;
      const adv = advanceStage(stagesOf, rec.stage, tasksOf(recordId));
      if (!adv.moved) return;
      rec.stage = /** @type {string} */ (adv.stage); rec.updatedAt = clock();
      log({ record: recordId, actor: "vyre", what: `moved ${titleOf(rec)} to ${rec.stage} by itself`, why: "The required tasks were done." });
      enterStage(rec, by);
    }
  }

  /** Entering a stage creates its tasks from the Kit (DESIGN-tasks.md, idea 5). */
  function enterStage(/** @type {RecordRow} */ rec, /** @type {string} */ by) {
    if (rec.type !== ESTATE_KIT.type || !rec.stage) return;
    const tpls = ESTATE_KIT.stageTasks[rec.stage];
    if (!tpls) return;
    const client = records.get(String(rec.values.client || ""));
    const made = spawnStage(tpls, { record: rec.id, stage: rec.stage, vars: { client: client ? String(client.values.name) : "the client" }, now: clock(), madeBy: by,
      newId: () => `k${++nTask}`, actors: actorList(), existing: tasksOf(rec.id) });
    for (const t of made) tasks.set(t.id, t);
    if (made.length) log({ record: rec.id, actor: "vyre", what: `made ${made.length} task${made.length === 1 ? "" : "s"} for ${rec.stage}` });
  }

  function mayChange(/** @type {Task} */ t, /** @type {string} */ by) {
    return by === t.doer || by === t.checker || (t.helpers || []).includes(by) || ownerOf(t.doer, ACTORS) === by;
  }

  /** @type {Store & { kit: typeof ESTATE_KIT, world: string }} */
  const store = {
    kit: ESTATE_KIT, world,
    async spaces() { await ready; return clone(SPACES); },
    async actors() { await ready; return clone(ACTORS); },
    async types(space) { await ready; return clone(space ? types.filter(t => t.space === space) : types); },
    async list(typeId, q = {}) {
      await ready;
      let rows = [...records.values()].filter(r => r.type === typeId && (!q.space || r.space === q.space));
      for (const [k, v] of Object.entries(q.where || {})) rows = rows.filter(r => (k === "stage" ? r.stage : r.values[k]) === v);
      if (q.sort) { const k = q.sort.replace(/^-/, ""), dir = q.sort.startsWith("-") ? -1 : 1; rows.sort((a, b) => String(a.values[k] ?? "").localeCompare(String(b.values[k] ?? "")) * dir); }
      return rows.map(masked);
    },
    async get(id) { await ready; const r = records.get(id); return r ? masked(r) : null; },
    async create(typeId, values, o = {}) {
      await ready;
      const t = typeOf(typeId);
      if (!t) throw new Error(`There is no record type "${typeId}".`);
      const by = o.by || meId;
      const sealed = sealedKeys(t);
      if (ACTORS.find(a => a.id === by)?.kind !== "person" && sealed.some(k => k in values)) throw new Error("An assistant cannot write a sealed field.");
      const stageField = t.fields.find(f => f.kind === "stage");
      const { stage: given, ...rest } = values;
      const stage = given || stageField?.stages?.[0];
      const rec = put(typeId, t.space === "mine" ? "mine" : "harlow", rest, stageField ? stage : undefined);
      log({ record: rec.id, actor: by, what: `created ${titleOf(rec)}${typeId === ESTATE_KIT.type ? ` from the Kit ${ESTATE_KIT.name}` : ""}`, why: o.why });
      if (typeId === ESTATE_KIT.type) { enterStage(rec, by); settle(rec.id, by); }
      notify();
      return masked(rec);
    },
    async update(id, patch, by = meId) {
      await ready;
      const rec = records.get(id);
      if (!rec) throw new Error("That record does not exist.");
      const t = typeOf(rec.type);
      const sealed = new Set(sealedKeys(t));
      const isPerson = ACTORS.find(a => a.id === by)?.kind === "person";
      const keys = Object.keys(patch).filter(k => k !== "stage");
      if (!isPerson && keys.some(k => sealed.has(k))) throw new Error("An assistant cannot write a sealed field.");
      for (const k of keys) rec.values[k] = patch[k];
      if ("stage" in patch) rec.stage = patch.stage;
      rec.updatedAt = clock();
      const labels = keys.map(k => t?.fields.find(f => f.key === k)?.label || k);
      if (labels.length) log({ record: id, actor: by, what: `filled ${labels.length} field${labels.length === 1 ? "" : "s"} on ${titleOf(rec)}: ${labels.join(", ")}` });
      notify();
      return masked(rec);
    },
    async tasks(q = {}) {
      await ready;
      return clone([...tasks.values()].filter(t => (!q.record || t.record === q.record) && (!q.doer || t.doer === q.doer) && (!q.checker || t.checker === q.checker)
        && (!q.state || q.state.includes(t.state)) && (!q.space || records.get(t.record)?.space === q.space)));
    },
    async task(id) { await ready; const t = tasks.get(id); return t ? clone(t) : null; },
    async createTask(input, by = meId) {
      await ready;
      if (!records.has(input.record)) throw new Error("That record does not exist.");
      const dep = (input.dependsOn || []).length > 0;
      const t = addTask(/** @type {any} */ ({ ...clone(input), state: input.state || (dep ? "waiting" : startState(/** @type {any} */ (input), actorList())), madeBy: input.madeBy || by }));
      log({ record: t.record, task: t.id, actor: by, what: `made the task ${t.title}` });
      settle(t.record, by);
      notify();
      return clone(tasks.get(t.id));
    },
    async updateTask(id, patch, by = meId) {
      await ready;
      const cur = tasks.get(id);
      if (!cur) throw new Error("That task does not exist.");
      if (!mayChange(cur, by)) throw new Error("Only the doer, the checker or the doer's owner can change this task.");
      const rec = records.get(cur.record);
      const { state, stuck, result, ...rest } = /** @type {any} */ (patch);
      /** @type {Task} */
      let next = { ...cur, ...clone(rest) };
      if (result) next = { ...next, result: { ...(cur.result || {}), ...clone(result) } };
      if (state && state !== cur.state) {
        if (state === "stuck") {
          next = makeStuck({ ...next, state: cur.state }, stuck?.reason, stuck?.suggestedFix, clock());
        } else {
          const why = whyNot({ ...next, state: cur.state }, state, { by, record: rec, actors: ACTORS });
          if (why) throw new Error(why);
          next = move({ ...next, state: cur.state }, state, { by, record: rec, actors: ACTORS });
        }
        tasks.set(id, next);
        const who = nameOf(by);
        log({ record: cur.record, task: id, actor: by, what: state === "needs_check" ? `finished ${next.title}, ready for ${nameOf(next.checker || "")}'s check` : state === "done" ? `finished ${next.title}` : state === "stuck" ? `could not continue ${next.title}` : `moved ${next.title} to ${state}`,
          why: state === "stuck" ? next.stuck?.reason : undefined });
        void who;
        settle(cur.record, by);
      } else tasks.set(id, next);
      notify();
      return clone(tasks.get(id));
    },
    async approveTask(id, proof) {
      await ready;
      const cur = tasks.get(id);
      if (!cur) throw new Error("That task does not exist.");
      const done = approve(cur, proof, { by: meId, now: clock(), record: records.get(cur.record) });
      tasks.set(id, done);
      const sent = cur.output.kind === "sent";
      log({ record: cur.record, task: id, actor: meId, what: sent ? `approved and sent ${cur.output.target || cur.title}` : `approved ${cur.title}`,
        why: `With ${proof.method === "face_id" ? "Face ID" : proof.method === "touch_id" ? "Touch ID" : "a passkey"}. The checker's approval is the Gate approval.` });
      settle(cur.record, meId);
      notify();
      return clone(tasks.get(id));
    },
    async reassignTask(id, doer) {
      await ready;
      const cur = tasks.get(id);
      if (!cur) throw new Error("That task does not exist.");
      if (!ACTORS.some(a => a.id === doer && a.kind !== "device")) throw new Error("That is not someone who can take a task.");
      const next = reassign(cur, doer, actorList());
      tasks.set(id, next);
      log({ record: cur.record, task: id, actor: meId, what: `gave ${next.title} to ${nameOf(doer)}` });
      settle(cur.record, meId);
      notify();
      return clone(tasks.get(id));
    },
    async events(q = {}) {
      await ready;
      const rows = events.filter(e => (!q.record || e.record === q.record) && (!q.task || e.task === q.task)).sort((a, b) => b.at - a.at || Number(b.id.slice(1)) - Number(a.id.slice(1)));
      return clone(q.limit ? rows.slice(0, q.limit) : rows);
    },
    async reveal(recordId, key, proof) {
      await ready;
      const rec = records.get(recordId);
      if (!rec) throw new Error("That record does not exist.");
      if (!sealedKeys(typeOf(rec.type)).includes(key)) throw new Error("That field is not sealed.");
      if (!proof || !PROOFS.includes(proof.method)) throw new Error("Reveal needs Face ID, Touch ID or a passkey.");
      const value = rec.values[key];
      if (blank(value)) throw new Error("That field has no value.");
      const out = { value: String(value), until: clock() + REVEAL_MS };
      reveals.set(`${recordId}:${key}`, out);
      log({ record: recordId, actor: meId, what: `revealed ${typeOf(rec.type)?.fields.find(f => f.key === key)?.label || key} on ${titleOf(rec)} for 30 seconds` });
      notify();
      return out;
    },
    async seesAs(recordId, who) {
      await ready;
      const rec = records.get(recordId);
      if (!rec) throw new Error("That record does not exist.");
      const t = typeOf(rec.type), sealed = new Set(sealedKeys(t)), out = /** @type {Record<string, any>} */ ({});
      for (const [k, v] of Object.entries(rec.values)) {
        if (!sealed.has(k)) { out[k] = clone(v); continue; }
        if (blank(v)) continue;
        const def = t?.fields.find(f => f.key === k);
        out[k] = who === "assistant" ? { sealed: true, note: `${def?.label || k} on file, sealed` } : def?.showLast4 ? { sealed: true, last4: String(v).slice(-4) } : { sealed: true };
      }
      return out;
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    async me() { return meId; },
    async calendar() {
      await ready;
      const d = new Date(clock()); d.setHours(0, 0, 0, 0);
      const at = (/** @type {number} */ h, /** @type {number} */ m) => d.getTime() + (h * 60 + m) * 60_000;
      return [
        { id: "cal1", at: at(10, 0), title: "Call with Marcus Doe", sub: "Doe trust, Marcus", record: "m4" },
        { id: "cal2", at: at(11, 30), title: "Signing, Ortiz power of attorney", sub: "Ortiz power of attorney", record: "m5" },
        { id: "cal3", at: at(14, 0), title: "Intake call with Priya Shah", sub: "Shah will update", record: "m3" },
      ];
    },
  };

  // ---- the world ---------------------------------------------------------------------------
  function seed() {
    const day = new Date(clock()); day.setHours(0, 0, 0, 0);
    const today = (/** @type {number} */ h, /** @type {number} */ m) => day.getTime() + (h * 60 + m) * 60_000;
    const c = (/** @type {string} */ id, /** @type {any} */ v) => put("contact", "harlow", v, undefined, id);
    c("c1", { name: "Jane Doe", role: "Client", email: "jane.doe@example.com", phone: "+1 415 555 0142", dob: "1961-04-12", ssn: "412-55-6789", notes: "Widowed, two adult children. Wants the trust funded before the house sale." });
    c("c2", { name: "John Roe", role: "Client", email: "j.roe@example.com", phone: "+1 415 555 0177", dob: "1958-09-30", ssn: "530-21-1144", notes: "Owns a bakery. Needs a succession plan before he steps back in spring." });
    c("c3", { name: "Marcus Doe", role: "Client", email: "marcus.doe@example.com", phone: "+1 415 555 0119", dob: "1988-02-03", ssn: "611-72-0098", notes: "Jane Doe's son. Successor trustee." });
    c("c4", { name: "Priya Shah", role: "Client", email: "priya.shah@example.com", phone: "+1 510 555 0164", dob: "1979-11-21", ssn: "544-90-3321", notes: "Updating a will after a move." });
    c("c5", { name: "Lena Ortiz", role: "Vendor", email: "lena@ortiznotary.example.com", phone: "+1 415 555 0123", notes: "Mobile notary. Signs same day." });
    c("c6", { name: "Dana Reyes", role: "Client", email: "dana.reyes@example.com", phone: "+1 415 555 0190", notes: "Site rebuild client contact." });
    nRec.contact = 6;
    put("template", "harlow", { name: "Welcome", kind: "Email", subject: "Welcome to Harlow Legal, [Client first name]",
      body: "Hi [Client first name],\n\nThank you for choosing Harlow Legal. [Tailored paragraph]\n\nYour matter is [Matter title], and [Attorney name] is your attorney. Next we will send your engagement letter.\n\n[Firm signature]" }, undefined, "tpl1");
    put("template", "harlow", { name: "Engagement letter", kind: "Document", subject: "Engagement letter, [Matter title]",
      body: "Client: [Client name]\nSocial Security number: [SSN]\nMatter: [Matter title]\nFee: [Fee]\n\nThis letter confirms that Harlow Legal will act for you in this matter.\n\n[Firm signature]" }, undefined, "tpl2");
    log({ actor: "chris", what: "joined Harlow Legal", at: today(10, 20) });
    if (world === "empty") return;

    const m = (/** @type {string} */ id, /** @type {any} */ v, /** @type {string} */ stage) => put("matter", "harlow", v, stage, id);
    if (world === "morning") {
      m("m1", { title: "Doe estate plan", client: "c1", plan: "Both", fee: 4800, owner: "alex", situation: "Widowed, two adult children", assets: "House at 18 Larkin St, sale in November", pressure: "Fund the trust before the sale",
        research: "Sources: intake form (8 Sep), county property record, her first message. Wants the trust funded before the house sale in November. Two adult children, Marcus is the likely successor trustee.", closing: "2026-10-28" }, "Engagement");
    }
    m("m2", { title: "Roe succession plan", client: "c2", plan: "Trust", fee: 6500, owner: "kit", closing: "2026-11-14" }, "Engagement");
    m("m3", { title: "Shah will update", client: "c4", plan: "Will", fee: 1200, owner: "kit", closing: "2026-10-20" }, "Intake");
    m("m4", { title: "Doe trust, Marcus", client: "c3", plan: "Trust", fee: 3900, owner: "chris", closing: "2026-10-09" }, "Signing");
    m("m5", { title: "Ortiz power of attorney", client: "c5", plan: "Will", fee: 800, owner: "alex", closing: "2026-10-05" }, "Funding");
    nRec.matter = 5;
    const p = (/** @type {string} */ id, /** @type {string} */ space, /** @type {any} */ v) => put("project", space, v, undefined, id);
    p("p1", "harlow", { title: "Site rebuild", owner: "kit", due: "2026-10-30", brief: "Rebuild the intake form and the pricing page. Dana Reyes is the client contact." });
    p("p2", "harlow", { title: "Northwind Bakery bookkeeping", owner: "iris", due: "2026-10-15", brief: "Match supplier invoices every week." });
    p("p3", "mine", { title: "Vyre site", owner: "juno", due: "2026-11-05", brief: "Launch with the Wink page first." });
    p("p4", "mine", { title: "Passport renewal", owner: "juno", due: "2026-10-20", brief: "Renew before the Lisbon trip." });
    nRec.project = 4;
    put("trip", "mine", { title: "Lisbon in November", dest: "Lisbon", dates: "2026-11-14", budget: 2400 }, "Booked", "t1");
    put("trip", "mine", { title: "Hike weekend", dest: "Point Reyes", dates: "2026-10-10", budget: 200 }, "Dreaming", "t2");
    nRec.trip = 2;

    /** @param {string} record @param {Partial<Task> & { title: string, doer: string }} t */
    const k = (record, t) => addTask({ ...t, record, madeBy: t.madeBy });
    const fieldsOut = { kind: /** @type {const} */ ("fields"), target: "Family situation, Assets in play, Time pressure, Research notes", fields: ["situation", "assets", "pressure", "research"] };
    const dayMs = 86_400_000;
    if (world === "morning") {
      const k1 = k("m1", { title: "Research the client", doer: "research", stage: "Intake", state: "done", output: fieldsOut, how: "assistant",
        result: { note: { text: "Wants the trust funded before the house sale in November.", sources: ["Intake form, 8 Sep", "County property record", "Her first message"] } } });
      const k2 = k("m1", { title: "Welcome email for Jane Doe", doer: "intake", checker: "alex", stage: "Intake", state: "done", output: { kind: "sent", target: "Email to Jane Doe" }, how: "tailor", template: "tpl1", dependsOn: [k1.id],
        result: { draft: { subject: "Welcome to Harlow Legal, Jane", body: "Hi Jane,\n\nThank you for choosing Harlow Legal. I read that you want the trust funded before the house sale in November, so we will start there.\n\nHarlow Legal", sources: 3 }, sent: { at: today(9, 12), by: "alex", method: "face_id" }, approved: { at: today(9, 12), by: "alex", method: "face_id" } } });
      const k3 = k("m1", { title: "Engagement letter", doer: "drafting", checker: "alex", stage: "Engagement", state: "working", output: { kind: "sent", target: "Letter for signature" }, how: "tailor", template: "tpl2", due: today(12, 0) + dayMs, now: "is drafting the engagement letter from Engagement letter" });
      k("m1", { title: "Review the draft with Jane Doe", doer: "alex", stage: "Engagement", state: "ready", output: { kind: "decision", target: "Approved or changes" }, how: "person", dependsOn: [k3.id], madeBy: "chris", note: "Assigned by Chris", due: today(12, 0) + 3 * dayMs });
      void k2;
    }
    const k5 = k("m2", { title: "Engagement letter for John Roe", doer: "drafting", checker: "alex", stage: "Engagement", state: "working", output: { kind: "sent", target: "Letter for signature" }, how: "tailor", template: "tpl2", now: "is filling Engagement letter with John's notes" });
    k("m2", { title: "Check the court docket", doer: "juno", stage: "Engagement", state: "stuck", output: { kind: "note", target: "Docket note" }, how: "assistant", madeBy: "juno", note: "juno stopped",
      say: "juno could not log in to the court portal", stuck: { reason: "The password changed.", since: today(8, 40), suggestedFix: "Update the password in the Vault, or reassign to Chris." } });
    void k5;
    const k7 = k("m3", { title: "Research the client", doer: "research", stage: "Intake", state: "working", output: fieldsOut, how: "assistant", now: "is reading Priya Shah's intake form" });
    k("m3", { title: "Welcome email for Priya Shah", doer: "intake", checker: "alex", stage: "Intake", state: "waiting", output: { kind: "sent", target: "Email to Priya Shah" }, how: "tailor", template: "tpl1", dependsOn: [k7.id] });
    k("m3", { title: "Approve a $720 refund for Priya Shah", doer: "alex", stage: "Intake", state: "ready", output: { kind: "decision", target: "Refund or not" }, how: "person", note: "Flow: Large refunds", madeBy: "vyre", required: false,
      say: "Approve a $720 refund for Priya Shah" });
    const k10 = k("m4", { title: "Signing date", doer: "alex", stage: "Signing", state: "ready", output: { kind: "fields", target: "Signing date", fields: ["signing"] }, how: "person", madeBy: "kit", note: "kit asked",
      say: "kit needs the client's signing date to continue" });
    k("m4", { title: "Collect signatures", doer: "alex", stage: "Signing", state: "waiting", dependsOn: [k10.id], output: { kind: "file", target: "Signed documents" }, how: "person" });
    k("m5", { title: "Record the document", doer: "rev", stage: "Funding", state: "working", output: { kind: "file", target: "Recorded deed" }, how: "assistant", now: "is recording the deed with the county" });
    k("p1", { title: "Send the Q3 report to Dana Reyes", doer: "kit", checker: "alex", state: "needs_check", output: { kind: "sent", target: "Email to Dana Reyes" }, how: "assistant", note: "Needs your approval",
      say: "Email to Dana is waiting for approval", result: { draft: { subject: "Q3 report, the short version", body: "Hi Dana,\n\nThe short version: leads are up 18% and the intake form now converts 31% better on mobile. The full report is attached.\n\nAlex" } } });
    const k14 = k("p1", { title: "Fix the intake form label", doer: "kit", state: "working", output: { kind: "file", target: "Intake form" }, how: "assistant", now: "is running the intake form tests" });
    k("p1", { title: "Review the pricing page copy", doer: "juno", state: "working", output: { kind: "note", target: "Review note" }, how: "assistant", now: "is reading the pricing page" });
    k("p1", { title: "Plan the launch checklist", doer: "alex", state: "waiting", dependsOn: [k14.id], output: { kind: "file", target: "Checklist" }, how: "person" });
    k("p2", { title: "Match this week's invoices", doer: "iris", state: "working", output: { kind: "fields", target: "Matched", fields: ["matched"] }, how: "assistant", now: "is matching 14 invoices" });
    k("p2", { title: "Pay the supplier invoice", doer: "iris", checker: "alex", state: "stuck", output: { kind: "sent", target: "Payment of $320" }, how: "assistant", say: "iris could not reach the bank",
      stuck: { reason: "The sign-in expired.", since: today(7, 55), suggestedFix: "Chris can sign iris in again." } });
    const k19 = k("p3", { title: "Write the Wink page", doer: "juno", state: "working", output: { kind: "file", target: "Wink page" }, how: "assistant", now: "is writing the Wink page" });
    const k20 = k("p3", { title: "Pick the hero image", doer: "alex", state: "waiting", dependsOn: [k19.id], output: { kind: "file", target: "Hero image" }, how: "person" });
    k("p3", { title: "Publish the preview", doer: "kit", state: "waiting", dependsOn: [k20.id], output: { kind: "sent", target: "Preview" }, how: "assistant" });
    const k22 = k("p4", { title: "Add a signature photo", doer: "alex", state: "ready", output: { kind: "file", target: "Signature photo" }, how: "person", madeBy: "juno", note: "juno asked", say: "Passport renewal needs your signature photo" });
    k("p4", { title: "Submit the form", doer: "juno", checker: "alex", state: "waiting", dependsOn: [k22.id], output: { kind: "sent", target: "Form to the passport office" }, how: "assistant" });
    const k24 = k("t1", { title: "Book the flights", doer: "juno", state: "working", output: { kind: "decision", target: "Which flight" }, how: "assistant", now: "is comparing three flights" });
    k("t1", { title: "Reserve the hotel", doer: "juno", checker: "alex", state: "waiting", dependsOn: [k24.id], output: { kind: "sent", target: "Booking" }, how: "assistant" });
    k("t1", { title: "Pack", doer: "alex", state: "waiting", output: { kind: "file", target: "List" }, how: "person" });
    k("t2", { title: "Pick a trail", doer: "alex", state: "done", output: { kind: "decision", target: "Trail" }, how: "person" });
    k("t2", { title: "Reply to Sam about Saturday", doer: "juno", checker: "alex", state: "needs_check", output: { kind: "sent", target: "Message to Sam Okafor" }, how: "assistant", note: "Needs your approval",
      say: "Reply to Sam about Saturday", result: { draft: { subject: "Saturday", body: "Yes, 8 am at the trailhead. I will bring the trail map." } } });

    if (world === "morning") log({ record: "m1", actor: "vyre", what: "created Doe estate plan from the Kit Estate planning matter", why: "Flow On payment: Jane Doe paid $1,500.", at: today(9, 0) });
    log({ actor: "juno", what: "sent the Friday report draft to you", at: today(11, 48) });
    log({ actor: "kit", what: "fixed the intake form label", at: today(12, 6), record: "p1" });
  }

  return store;
}
