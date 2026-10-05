// @ts-check
// deck/ui/mock-store: an in-memory Store (contracts.js) for the Deck's generated screens, the lab and the tests, until the real gateway adapter lands
// (ui/store.js is the one switch). It speaks the kernel's shapes and enforces the kernel's rules, so what the screens read now is what the gateway will give them:
//
//   records   GatewayRecord { type, id, urn, version, data, created_at, updated_at, labels }; the id is a UUID, the urn is vyre://<space>/<type>/<id>; update() takes the
//             version the caller read and refuses a stale one with code "version_conflict"; a sealed field holds a SealedRefValue and NEVER plaintext
//   sealed    plaintext lives in a separate in-memory vault keyed by ref, read only by reveal() (and written only by putSealed()); no record, event or snapshot holds it
//   tasks     the kernel's Task: doer, checker and assigned_by are Actors, record is a urn, state is one of TASK_STATES, and every change of state goes through
//             tasks.js whyNot(), which reads TASK_TRANSITIONS and its `by` column; transitions() lists every move made
//   events    EventEnvelope: noun.past-verb types, a subject urn, an actor "<kind>:<id>@<space>", a data bag with the sentence the Deck prints (data.what, data.why);
//             the hashes are stand-ins (the mock keeps no chain). Record events say what changed, never a value
//
// Worlds: "morning" (the morning after a payment: spaces Mine and Juniper Studio, Alex Rivera, Chris Park, juno, kit, Research, Intake, Drafting, Jane Doe and
// the rest, tasks k1..k28 from the approved prototype), "payday" (the same without Doe estate plan, so the "client pays" scenario can play on top of it),
// and "empty" (spaces, people and types only).
import { advanceStage, approve, evidenceOf, isProof, makeStuck, move as moveTask, ownerOf, reassign as reassignTask, reject, spawnStage, startsItself, unblock, whyNot, withEvidence,
  stageDone as _stageDone } from "./tasks.js";
import { SPACE, WHO, aliasUrn, digest, minted, parseUrn, seeded, urnOf } from "./mock-ids.js";
import { actorValue, addr, file, money, ref } from "./mock-values.js";
import { MATTER_STAGES, types as sampleTypes } from "./types.js";
import { viewDefOf } from "./view-defs.js";
import { REVEAL_MS as REVEAL, aid, signerWords, spaceOfUrn, stageFieldOf, stageNames } from "./kernel-view.js";

/** @typedef {import("./contracts.js").Store} Store */
/** @typedef {import("./contracts.js").DeckTask} Task */
/** @typedef {import("./contracts.js").GatewayRecord} GatewayRecord */
/** @typedef {import("./contracts.js").TypeDefinition} TypeDefinition */
/** @typedef {import("./contracts.js").FieldDefinition} FieldDefinition */
/** @typedef {import("./contracts.js").FieldValue} FieldValue */
/** @typedef {import("./contracts.js").Who} Who */
/** @typedef {import("./contracts.js").Actor} Actor */
/** @typedef {import("./contracts.js").EventEnvelope} EventEnvelope */
/** @typedef {import("./contracts.js").SealedRefValue} SealedRefValue */

export const REVEAL_MS = REVEAL;
void _stageDone;

/** @type {import("./contracts.js").Space[]} */
const SPACES = [
  { id: SPACE.mine, name: "Mine", kind: "mine", accent: "violet" },
  { id: SPACE.harlow, name: "Juniper Studio", kind: "team", accent: "amber", density: "compact" },
];

/** @type {Who[]} */
const ACTORS = [
  { id: WHO.alex, family: "person", name: "Alex Rivera", role: "Attorney", seed: "alex-rivera" },
  { id: WHO.chris, family: "person", name: "Chris Park", role: "Attorney", seed: "chris-park" },
  { id: WHO.juno, family: "assistant", name: "juno", role: "Assistant", seed: "juno", owner: WHO.alex },
  { id: WHO.kit, family: "assistant", name: "kit", role: "Assistant", seed: "kit", owner: WHO.alex },
  { id: WHO.iris, family: "assistant", name: "iris", role: "Assistant", seed: "iris", owner: WHO.chris },
  { id: WHO.rev, family: "assistant", name: "rev", role: "Assistant", seed: "rev", owner: WHO.alex },
  { id: WHO.research, family: "teammate", name: "Research", role: "Teammate, Juniper Studio", seed: "research-harlow", owner: WHO.alex },
  { id: WHO.intake, family: "teammate", name: "Intake", role: "Teammate, Juniper Studio", seed: "intake-harlow", owner: WHO.alex },
  { id: WHO.drafting, family: "teammate", name: "Drafting", role: "Teammate, Juniper Studio", seed: "drafting-harlow", owner: WHO.alex },
  { id: WHO.vyre, family: "service", name: "Vyre", role: "The Kit and its Flows", seed: "vyre" },
];

/** The kernel's actor kind for a person-like family. @param {Who["family"]} f @returns {Actor["kind"]} */
const kindOf = f => (f === "person" ? "person" : f === "service" ? "service" : "agent");

/** Which space each type is listed under (the Deck merges Mine and the team's spaces on the device). */
const TYPE_SPACE = /** @type {Record<string, string>} */ ({ contact: SPACE.harlow, matter: SPACE.harlow, project: SPACE.mine, trip: SPACE.mine, template: SPACE.harlow });

/** What the made-up world's types hold beyond the sample definitions, because the scenario writes them. */
const EXTRAS = /** @type {Record<string, FieldDefinition[]>} */ ({
  matter: [{ name: "research", label: "Research notes", kind: "rich_text" }, { name: "signing", label: "Signing date", kind: "date" }],
  template: [{ name: "subject", label: "Subject", kind: "text" }],
});

/** The Kit that makes a matter's tasks, by name (the stages hold the task templates). */
export const ESTATE_KIT = { id: "estate", name: "Estate planning matter", type: "matter" };

const blank = (/** @type {any} */ v) => v === undefined || v === null || v === "";
const clone = (/** @type {any} */ v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const lc = (/** @type {string} */ s) => s.toLowerCase();

/** An Error with a StoreError code. @param {string} code @param {string} message */
const refuse = (code, message) => Object.assign(new Error(message), { code });

/** A sealed class's format check: only the Social Security number has one in the made-up world. @param {string} cls @param {string} v */
const validFormat = (cls, v) => (cls === "us-ssn" ? /^\d{3}-?\d{2}-?\d{4}$/.test(v) : true);

/**
 * @param {{ world?: "morning"|"payday"|"empty", now?: () => number, me?: string }} [opts]
 * @returns {Store & { kit: typeof ESTATE_KIT, world: string, transitions(): { task: string, from: string, to: string, by: string }[], snapshot(): any }}
 */
export function createMockStore(opts = {}) {
  const world = opts.world || "morning";
  const clock = opts.now || (() => Date.now());
  const meId = /** @type {Record<string, string>} */ (WHO)[opts.me || "alex"] || opts.me || WHO.alex;
  /** @type {Map<string, { type: string, id: string, version: number, data: Record<string, any>, created_at: number, updated_at: number }>} keyed by urn */
  const records = new Map();
  /** @type {Map<string, Task>} */
  const tasks = new Map();
  /** @type {EventEnvelope[]} */
  const events = [];
  /** @type {Set<() => void>} */
  const subs = new Set();
  /** The sealed vault: ref -> plaintext. Read only by reveal(), never returned, never in a record, an event or a snapshot. @type {Map<string, string>} */
  const vault = new Map();
  /** @type {{ task: string, from: string, to: string, by: string }[]} */
  const moves = [];
  let nTask = 0, nRec = 0, nSeal = 0, prevHash = "genesis", seeding = true;
  /** @type {TypeDefinition[]} */
  const types = clone(sampleTypes);
  for (const t of types) for (const f of EXTRAS[t.name] || []) if (!t.fields.some(x => x.name === f.name)) /** @type {FieldDefinition[]} */ (/** @type {any} */ (t.fields)).push(f);

  const typeOf = (/** @type {string} */ name) => types.find(t => t.name === name);
  const notify = () => { for (const f of [...subs]) { try { f(); } catch (e) { console.error(e); } } };
  const who = (/** @type {string|undefined} */ id) => ACTORS.find(a => a.id === id);
  const nameOf = (/** @type {string|undefined} */ id) => who(id)?.name || id || "Someone";
  /** The kernel Actor for a directory id in a space. @param {string} id @param {string} space @returns {Actor} */
  const actor = (id, space) => ({ kind: kindOf(who(id)?.family || "service"), id, space });
  /** A doer or checker named by a reference in a stage's task template: "teammate:research", "person:alex", "agent:rev". @param {string} refStr @param {string} space @returns {Actor} */
  function actorFromRef(refStr, space) {
    const [k, n] = refStr.includes(":") ? refStr.split(":") : ["", refStr];
    const id = k === "person" ? /** @type {Record<string, string>} */ (WHO)[n] || n : k === "teammate" || k === "agent" ? n : /** @type {Record<string, string>} */ (WHO)[n] || n;
    return actor(id, space);
  }
  const sealedNames = (/** @type {TypeDefinition|undefined} */ t) => (t ? t.fields.filter(f => f.kind === "sealed" || f.seal).map(f => f.name) : []);
  const titleOf = (/** @type {string} */ urn) => { const r = records.get(urn); const t = r && typeOf(r.type); return r && t ? String(r.data[viewDefOf(t).titleField] ?? r.id) : ""; };

  /** @param {typeof records extends Map<any, infer V> ? V : never} r @param {string} urn @returns {GatewayRecord} */
  function shaped(r, urn) {
    const space = spaceOfUrn(urn);
    return clone({ type: r.type, id: r.id, urn, version: r.version, data: r.data, created_at: r.created_at, updated_at: r.updated_at,
      labels: { trust: "member", red: r.type === "contact" ? "pii" : "internal", source_spaces: [space] } });
  }

  /** One event, in the kernel's envelope. `what` and `why` are the Deck's sentence (data.what, data.why); a record event carries what changed, never a value. @param {{ type: string, subject: string, actor: string, what: string, why?: string, record?: string, task?: string, at?: number, data?: Record<string, any> }} e */
  function log(e) {
    const t = e.at ?? clock(), seq = events.length + 1, space = spaceOfUrn(e.subject) || SPACE.harlow, a = actor(e.actor, space);
    const body = { what: e.what, ...(e.why ? { why: e.why } : {}), ...(e.record ? { record: e.record } : {}), ...(e.task ? { task: e.task } : {}), ...(e.data || {}) };
    const commit = digest(JSON.stringify(body)), hash = digest(`${prevHash}|${seq}|${e.type}|${commit}`);
    /** @type {EventEnvelope} */
    const env = { v: 1, id: minted(t, seq), seq, space, type: e.type, sv: 1, time: t, received_at: t, actor: `${a.kind}:${a.id}@${space}`, chain: [{ actor: a, entered_by: "surface" }],
      subject: e.subject, trust: "member", source_spaces: [space], vis: "space", red: "internal", data: body, commit, prev: prevHash, hash };
    prevHash = hash;
    events.push(env);
    return env;
  }

  /** @param {string} type @param {string} space @param {Record<string, any>} data @param {string} [alias] a seeded record's alias @returns {string} the urn */
  function put(type, space, data, alias) {
    const id = alias ? seeded(alias) : minted(clock(), ++nRec), t = clock(), urn = urnOf(space, type, id);
    records.set(urn, { type, id, version: 1, data: { ...data }, created_at: t, updated_at: t });
    return urn;
  }

  /** Seal a value in the vault and return the reference a record holds in its place. @param {string} plaintext @param {FieldDefinition} def @returns {SealedRefValue} */
  function seal(plaintext, def) {
    const cls = def.seal?.class || "free", ref = `seal_${seeded(`vault:${++nSeal}:${cls}`).slice(0, 18)}`;
    vault.set(ref, plaintext);
    const hint = def.seal?.hint_allowed ? plaintext.slice(-4) : undefined;
    return { sealed: cls, ref, present: true, valid_format: validFormat(cls, plaintext), set_at: clock(), ...(hint ? { hint } : {}) };
  }

  /** A task id: the seeded ones are k1.., the rest are minted from the clock. */
  const newTaskId = () => (seeding ? seeded(`k${++nTask}`) : minted(clock(), ++nTask));

  /** The state machine's one door. Every change of a task's state goes through here: the table says whether it is allowed, and the move is written down. @param {Task} task @param {string} to @param {import("./tasks.js").MoveCtx} ctx @returns {Task} */
  function applyMove(task, to, ctx) {
    const next = moveTask(task, /** @type {any} */ (to), { actors: ACTORS, record: records.has(task.record || "") ? shaped(/** @type {any} */ (records.get(task.record || "")), task.record || "") : null, ...ctx });
    moves.push({ task: task.id, from: task.state, to, by: ctx.by || (ctx.kernel ? "kernel" : "") });
    const stamped = { ...next, updated_at: clock() };
    tasks.set(task.id, stamped);
    return stamped;
  }

  const tasksOf = (/** @type {string} */ recordUrn) => [...tasks.values()].filter(t => t.record === recordUrn);

  /** After a change: unblock what waits (the kernel), start an assistant's ready tasks (the doer), then move the record's stage on if its required tasks are done, spawning the next stage's tasks. Repeats until stable. */
  function settle(/** @type {string} */ recordUrn, /** @type {string} */ by) {
    const rec = records.get(recordUrn);
    const def = rec && typeOf(rec.type);
    if (!rec || !def) return;
    const sf = stageFieldOf(def), stages = sf ? stageNames(def, sf) : [];
    for (let guard = 0; guard < 12; guard++) {
      for (const id of unblock(tasksOf(recordUrn)).started) applyMove(/** @type {Task} */ (tasks.get(id)), "ready", { kernel: true });
      for (const t of tasksOf(recordUrn)) if (startsItself(t, ACTORS)) {
        const started = applyMove(t, "working", { by: aid(t.doer) });
        log({ type: "task.started", subject: urnOf(spaceOfUrn(recordUrn), "task", t.id), actor: aid(t.doer), record: recordUrn, task: t.id, what: `started ${started.title}`, data: { from: "ready", to: "working" } });
      }
      if (!sf || !rec.data[sf.name]) return;
      const adv = advanceStage(stages, String(rec.data[sf.name]), tasksOf(recordUrn));
      if (!adv.moved) return;
      rec.data[sf.name] = adv.stage; rec.version++; rec.updated_at = clock();
      log({ type: "record.stage-moved", subject: recordUrn, actor: WHO.vyre, what: `moved ${titleOf(recordUrn)} to ${adv.stage} by itself`, why: "The required tasks were done.", data: { changed: [sf.name] } });
      enterStage(recordUrn, by);
    }
  }

  /** Entering a stage creates its tasks from the type's stage definition (the Kit; DESIGN-tasks.md, idea 5). */
  function enterStage(/** @type {string} */ recordUrn, /** @type {string} */ by) {
    const rec = records.get(recordUrn), def = rec && typeOf(rec.type);
    const sf = def && stageFieldOf(def), stage = rec && sf ? String(rec.data[sf.name] || "") : "";
    const tpls = def?.stages?.find(s => s.name === stage)?.tasks;
    if (!rec || !tpls?.length) return;
    const space = spaceOfUrn(recordUrn);
    const client = records.get(String(rec.data.client?.urn || ""));
    const made = spawnStage(tpls, { record: recordUrn, space, stage, vars: { client: client ? String(client.data.name) : "the client" }, now: clock(), assignedBy: actor(by, space),
      newId: newTaskId, actor: ref0 => actorFromRef(ref0, space), existing: tasksOf(recordUrn),
      templateUrn: name => [...records.entries()].find(([, r]) => r.type === "template" && lc(String(r.data.name)) === lc(name))?.[0] });
    for (const t of made) tasks.set(t.id, t);
    if (made.length) log({ type: "task.created", subject: recordUrn, actor: WHO.vyre, record: recordUrn, what: `made ${made.length} task${made.length === 1 ? "" : "s"} for ${stage}` });
  }

  /** Who may change a task's output or its words: the doer, the checker, a helper, or the doer's owner. @param {Task} t @param {string} by */
  const mayChange = (t, by) => by === aid(t.doer) || by === aid(t.checker) || (t.helpers || []).some(h => h.id === by) || ownerOf(aid(t.doer), ACTORS) === by;
  const gone = () => refuse("not_found", "That task does not exist.");
  const taskOf = (/** @type {string} */ id) => { const t = tasks.get(id); if (!t) throw gone(); return t; };

  /** @type {ReturnType<typeof createMockStore>} */
  const store = {
    kit: ESTATE_KIT, world,
    async spaces() { return clone(SPACES); },
    async actors() { return clone(ACTORS); },
    async types(space) { return clone(space ? types.filter(t => TYPE_SPACE[t.name] === space) : types); },
    async list(type, q = {}) {
      let rows = [...records.entries()].filter(([urn, r]) => r.type === type && (!q.space || spaceOfUrn(urn) === q.space));
      const flt = q.filter;
      if (flt) rows = rows.filter(([, r]) => matchFilter(r.data, flt));
      if (q.sort?.length) rows.sort(([, a], [, b]) => { for (const s of /** @type {any[]} */ (q.sort)) { const c = cmp(a.data[s.field], b.data[s.field]) * (s.dir === "desc" ? -1 : 1); if (c) return c; } return 0; });
      return rows.map(([urn, r]) => shaped(r, urn));
    },
    async get(urn) { const r = records.get(urn); return r ? shaped(r, urn) : null; },
    async create(type, data, o = {}) {
      const t = typeOf(type);
      if (!t) throw refuse("unknown_type", `There is no record type "${type}".`);
      const by = o.by || meId;
      if (Object.keys(data).some(k => sealedNames(t).includes(k) && (data[k] !== null && data[k] !== undefined))) throw refuse("sealed_value_refused", "An assistant cannot write a sealed field. A person seals a value with putSealed.");
      const sf = stageFieldOf(t), stages = sf ? stageNames(t, sf) : [];
      const body = { ...data };
      if (sf && !body[sf.name]) body[sf.name] = stages[0];
      const space = o.space || TYPE_SPACE[type] || SPACE.harlow;
      const urn = put(type, space, body);
      log({ type: "record.created", subject: urn, actor: by, what: `created ${titleOf(urn)}${t.stages?.some(s => s.tasks?.length) ? ` from the Kit ${ESTATE_KIT.name}` : ""}`, why: o.why, data: { changed: Object.keys(body) } });
      if (t.stages?.some(s => s.tasks?.length)) { enterStage(urn, by); settle(urn, by); }
      notify();
      return shaped(/** @type {any} */ (records.get(urn)), urn);
    },
    async update(urn, patch, base_version, by = meId) {
      const rec = records.get(urn);
      if (!rec) throw refuse("not_found", "That record does not exist.");
      if (base_version !== rec.version) throw refuse("version_conflict", "This record changed since you opened it. Open it again and redo the change.");
      const t = typeOf(rec.type), sealed = new Set(sealedNames(t));
      for (const [k, v] of Object.entries(patch)) {
        if (!t?.fields.some(f => f.name === k)) throw refuse("unknown_field", `${rec.type} has no field "${k}".`);
        const f = t.fields.find(x => x.name === k);
        if (f?.kind === "sealed" || (v && typeof v === "object" && !Array.isArray(v) && typeof /** @type {any} */ (v).sealed === "string"))
          throw refuse("sealed_value_refused", "A sealed value goes through seal.put, never a record update.");
        if (who(by)?.family !== "person" && sealed.has(k)) throw refuse("sealed_value_refused", "An assistant cannot write a sealed field.");
      }
      const keys = Object.keys(patch);
      Object.assign(rec.data, clone(patch));
      rec.version++; rec.updated_at = clock();
      const labels = keys.map(k => t?.fields.find(f => f.name === k)?.label || k);
      if (labels.length) log({ type: "record.updated", subject: urn, actor: by, what: `filled ${labels.length} field${labels.length === 1 ? "" : "s"} on ${titleOf(urn)}: ${labels.join(", ")}`, data: { changed: keys } });
      notify();
      return shaped(rec, urn);
    },
    async putSealed(urn, field, value, by = meId) {
      const rec = records.get(urn);
      if (!rec) throw refuse("not_found", "That record does not exist.");
      const def = typeOf(rec.type)?.fields.find(f => f.name === field);
      if (!def || def.kind !== "sealed") throw refuse("invalid", "That field is not sealed.");
      if (who(by)?.family !== "person") throw refuse("sealed_value_refused", "An assistant cannot write a sealed field.");
      rec.data[field] = seal(String(value), def);
      rec.version++; rec.updated_at = clock();
      log({ type: "record.updated", subject: urn, actor: by, what: `sealed ${def.label} on ${titleOf(urn)}`, data: { changed: [field] } });
      notify();
      return shaped(rec, urn);
    },
    async reveal(urn, field, purpose, proof) {
      const rec = records.get(urn);
      if (!rec) throw refuse("not_found", "That record does not exist.");
      const def = typeOf(rec.type)?.fields.find(f => f.name === field);
      if (def?.kind !== "sealed") throw refuse("invalid", "That field is not sealed.");
      if (!isProof(proof)) throw refuse("invalid", "Reveal needs Face ID, Touch ID or a passkey.");
      const held = /** @type {SealedRefValue|undefined} */ (rec.data[field]);
      const plain = held?.ref ? vault.get(held.ref) : undefined;
      if (plain === undefined) throw refuse("invalid", "That field has no value.");
      log({ type: "seal.revealed", subject: urn, actor: meId, what: `revealed ${def.label} on ${titleOf(urn)} for 30 seconds`, why: purpose, data: { field, signer: proof.signer } });
      notify();
      return { value: plain, expires_in_ms: REVEAL_MS };
    },
    async seesAs(urn, who_) {
      const rec = records.get(urn);
      if (!rec) throw refuse("not_found", "That record does not exist.");
      const t = typeOf(rec.type), sealed = new Set(sealedNames(t)), out = /** @type {Record<string, FieldValue>} */ ({});
      for (const [k, v] of Object.entries(rec.data)) {
        if (who_ === "person" || !sealed.has(k)) { out[k] = clone(v); continue; }
        // A model reads a placeholder: no ref, nothing to reveal.
        const f = t?.fields.find(x => x.name === k), held = /** @type {any} */ (v);
        out[k] = { sealed: f?.seal?.class || "free", present: held?.present ?? !blank(v), valid_format: held?.valid_format ?? true };
      }
      return out;
    },
    async tasks(q = {}) {
      return clone([...tasks.values()].filter(t => (!q.record || t.record === q.record) && (!q.doer || aid(t.doer) === q.doer) && (!q.checker || aid(t.checker) === q.checker)
        && (!q.state || q.state.includes(t.state)) && (!q.space || t.space === q.space)));
    },
    async task(id) { const t = tasks.get(id); return t ? clone(t) : null; },
    async request(input, by = meId) {
      const rec = input.record ? records.get(input.record) : null;
      if (!rec) throw refuse("not_found", "That record does not exist.");
      const space = spaceOfUrn(input.record || ""), { doer, checker, helpers, state, ext, ...rest } = /** @type {any} */ (clone(input));
      const dep = (input.depends_on || []).length > 0;
      const id = newTaskId(), t = clock();
      /** @type {Task} */
      const task = { ...rest, id, space, doer: actor(doer, space), ...(checker ? { checker: actor(checker, space) } : {}), ...(helpers?.length ? { helpers: helpers.map((/** @type {string} */ h) => actor(h, space)) } : {}),
        output: input.output || { kind: "file" }, state: state || (dep ? "waiting" : "ready"), assigned_by: actor(by, space), labels: { trust: "member", red: "internal", source_spaces: [space] },
        created_at: t, updated_at: t, ...(ext ? { ext } : {}) };
      tasks.set(id, task);
      log({ type: "task.created", subject: urnOf(space, "task", id), actor: by, record: input.record, task: id, what: `made the task ${task.title}` });
      settle(/** @type {string} */ (input.record), by);
      notify();
      return clone(tasks.get(id));
    },
    async decide(id, approval) {
      const cur = taskOf(id), recordUrn = cur.record || "";
      const rec = records.get(recordUrn), space = cur.space, at = clock();
      const shape = rec ? shaped(rec, recordUrn) : null;
      if (approval.outcome === "rejected") {
        const back = reject(cur, approval.reason || "", approval.proof, { by: meId, now: at, actors: ACTORS });
        moves.push({ task: id, from: "needs_check", to: "ready", by: meId });
        tasks.set(id, back);
        log({ type: "task.rejected", subject: urnOf(space, "task", id), actor: meId, record: recordUrn, task: id, what: `sent ${cur.title} back`, why: approval.reason, data: { from: "needs_check", to: "ready" } });
        settle(recordUrn, meId); notify();
        return clone(tasks.get(id));
      }
      const done = approve(cur, approval.proof, { by: meId, now: at, record: shape, actors: ACTORS });
      moves.push({ task: id, from: "needs_check", to: "done", by: meId });
      tasks.set(id, done);
      const sent = cur.output.kind === "sent";
      log({ type: "task.approved", subject: urnOf(space, "task", id), actor: meId, record: recordUrn, task: id,
        what: sent ? `approved and sent ${typeof cur.output.target === "string" ? cur.output.target : cur.title}` : `approved ${cur.title}`,
        why: `With ${signerWords(approval.proof)}. The checker's approval is the Gate approval.`, data: { from: "needs_check", to: "done" } });
      settle(recordUrn, meId); notify();
      return clone(tasks.get(id));
    },
    async submit(id, evidence, by = meId) {
      const cur = taskOf(id), recordUrn = cur.record || "";
      if (!mayChange(cur, by)) throw refuse("invalid", "Only the doer, the checker or the doer's owner can change this task.");
      if (cur.state !== "ready" && cur.state !== "working") throw refuse("invalid", `A task that is ${lc(cur.state === "needs_check" ? "waiting for a check" : cur.state)} cannot take output.`);
      const rec = records.get(recordUrn), shape = rec ? shaped(rec, recordUrn) : null;
      // The doer starts a ready task (the table: ready to working, by the doer), hands in the output, and Vyre checks it and moves the task.
      /** @type {Task} */
      let next = cur;
      /** @type {{ from: string, to: string, by: string }[]} */
      const steps = [];
      const step = (/** @type {string} */ to, /** @type {import("./tasks.js").MoveCtx} */ ctx) => { const from = next.state; next = moveTask(next, /** @type {any} */ (to), { actors: ACTORS, record: shape, ...ctx }); steps.push({ from, to, by: ctx.by || "kernel" }); };
      if (next.state === "ready") step("working", { by: aid(cur.doer) });
      next = withEvidence(next, evidence);
      const guarded = !!next.checker || next.output.kind === "sent";
      step(guarded ? "needs_check" : "done", { kernel: true });
      next = { ...next, updated_at: clock() };
      tasks.set(id, next);
      for (const s of steps) moves.push({ task: id, ...s });
      log({ type: "task.moved", subject: urnOf(cur.space, "task", id), actor: by, record: recordUrn, task: id,
        what: next.state === "needs_check" ? `finished ${next.title}, ready for ${nameOf(aid(next.checker))}'s check` : `finished ${next.title}`, data: { from: cur.state, to: next.state } });
      settle(recordUrn, by); notify();
      return clone(tasks.get(id));
    },
    async move(id, to, by = meId, o = {}) {
      const cur = taskOf(id), recordUrn = cur.record || "";
      if (!mayChange(cur, by) && to !== "skipped") throw refuse("invalid", "Only the doer, the checker or the doer's owner can change this task.");
      const before = cur.state;
      let next;
      if (to === "stuck") {
        next = makeStuck(cur, o.reason || "", o.suggested_fix || "", clock(), { by, actors: ACTORS });
        moves.push({ task: id, from: before, to, by });
        tasks.set(id, { ...next, updated_at: clock() });
      } else next = applyMove(cur, to, { by, actors: ACTORS });
      log({ type: "task.moved", subject: urnOf(cur.space, "task", id), actor: by, record: recordUrn, task: id,
        what: to === "stuck" ? `could not continue ${cur.title}` : `moved ${cur.title} to ${to}`, why: to === "stuck" ? next.stuck?.reason : undefined, data: { from: before, to } });
      settle(recordUrn, by); notify();
      return clone(tasks.get(id));
    },
    async reassign(id, doer, by = meId) {
      const cur = taskOf(id);
      if (!ACTORS.some(a => a.id === doer && a.family !== "service")) throw refuse("invalid", "That is not someone who can take a task.");
      const next = reassignTask(cur, actor(doer, cur.space), { by, actors: ACTORS });
      moves.push({ task: id, from: cur.state, to: "ready", by });
      tasks.set(id, { ...next, updated_at: clock() });
      log({ type: "task.reassigned", subject: urnOf(cur.space, "task", id), actor: by, record: cur.record, task: id, what: `gave ${cur.title} to ${nameOf(doer)}`, data: { from: cur.state, to: "ready" } });
      settle(cur.record || "", by); notify();
      return clone(tasks.get(id));
    },
    async editTask(id, patch, by = meId) {
      const cur = taskOf(id);
      if (!mayChange(cur, by)) throw refuse("invalid", "Only the doer, the checker or the doer's owner can change this task.");
      const { draft, ...plain } = /** @type {any} */ (patch);
      /** @type {Task} */
      let next = { ...cur, ...clone(plain) };
      if (draft) next = { ...next, ext: { ...(next.ext || {}), result: { ...evidenceOf(cur), draft: clone(draft) } } };
      tasks.set(id, { ...next, updated_at: clock() });
      notify();
      return clone(tasks.get(id));
    },
    async events(q = {}) {
      const rows = events.filter(e => (!q.record || e.subject === q.record || /** @type {any} */ (e.data).record === q.record) && (!q.task || /** @type {any} */ (e.data).task === q.task)).sort((a, b) => b.time - a.time || b.seq - a.seq);
      return clone(q.limit ? rows.slice(0, q.limit) : rows);
    },
    async define(diff) {
      /** @type {string[]} */
      const changes = [];
      for (const t of diff.add_types || []) if (!typeOf(t.name)) { types.push(clone(t)); changes.push(`added ${t.name}`); }
      for (const t of diff.change_types || []) { const i = types.findIndex(x => x.name === t.name); if (i >= 0 && JSON.stringify(types[i]) !== JSON.stringify(t)) { types[i] = clone(t); changes.push(`changed ${t.name}`); } }
      for (const n of diff.remove_types || []) { const i = types.findIndex(x => x.name === n); if (i >= 0) { types.splice(i, 1); changes.push(`removed ${n}`); } }
      if (changes.length) notify();
      return { applied: changes.length > 0, changes };
    },
    async addField(typeName, spec) {
      const t = typeOf(typeName);
      if (!t) throw refuse("unknown_type", `There is no record type "${typeName}".`);
      let name = lc(spec.label).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
      const base = name; let n = 2;
      while (t.fields.some(f => f.name === name)) name = `${base}_${n++}`;
      /** @type {FieldDefinition} */
      const f = { name, label: spec.label, kind: spec.kind, ...(spec.to ? { to: spec.to } : {}),
        ...(spec.kind === "choice" || spec.kind === "multi_choice" ? { options: spec.options || ["Option A", "Option B"] } : spec.kind === "stage" ? { options: spec.options || ["Start", "Middle", "Done"] } : {}),
        ...(spec.kind === "sealed" ? { seal: { level: "ai", class: "free" } } : {}) };
      /** @type {FieldDefinition[]} */ (/** @type {any} */ (t.fields)).push(f);
      notify();
      return clone(f);
    },
    async sealField(typeName, field) {
      const f = typeOf(typeName)?.fields.find(x => x.name === field);
      if (!f) return undefined;
      /** @type {any} */ (f).seal = f.seal || { level: "ai", class: "free" };
      notify();
      return clone(f);
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    async me() { return meId; },
    async calendar() {
      const d = new Date(clock()); d.setHours(0, 0, 0, 0);
      const at = (/** @type {number} */ h, /** @type {number} */ m) => d.getTime() + (h * 60 + m) * 60_000;
      return [
        { id: "cal1", at: at(10, 0), title: "Call with Marcus Doe", sub: "Doe trust, Marcus", record: aliasUrn("m4") },
        { id: "cal2", at: at(11, 30), title: "Signing, Ortiz power of attorney", sub: "Ortiz power of attorney", record: aliasUrn("m5") },
        { id: "cal3", at: at(14, 0), title: "Intake call with Priya Shah", sub: "Shah will update", record: aliasUrn("m3") },
      ];
    },
    transitions() { return moves.map(m => ({ ...m })); },
    /** Everything the store holds except the vault, for a test to look for plaintext in. */
    snapshot() { return clone({ records: [...records.entries()], tasks: [...tasks.values()], events, types }); },
  };

  // ---- the world ---------------------------------------------------------------------------
  function seed() {
    const day = new Date(clock()); day.setHours(0, 0, 0, 0);
    const today = (/** @type {number} */ h, /** @type {number} */ m) => day.getTime() + (h * 60 + m) * 60_000;
    const H = SPACE.harlow, M = SPACE.mine;
    const urn = aliasUrn;
    const own = (/** @type {string} */ id, /** @type {string} */ space) => actorValue(actor(id, space));
    const contactDef = /** @type {TypeDefinition} */ (typeOf("contact"));
    const sealedDef = (/** @type {string} */ n) => /** @type {FieldDefinition} */ (contactDef.fields.find(f => f.name === n));
    const c = (/** @type {string} */ alias, /** @type {any} */ v) => {
      const { ssn, email, phone, ...rest } = v;
      const u = put("contact", H, { ...rest, ...(email ? { email: [email] } : {}), ...(phone ? { phone: [phone] } : {}) }, alias);
      if (ssn) /** @type {any} */ (records.get(u)).data.ssn = seal(ssn, sealedDef("ssn"));
    };
    c("c1", { name: "Jane Doe", role: "Client", email: "jane.doe@example.com", phone: "+1 415 555 0142", dob: "1961-04-12", ssn: "412-55-6789", notes: "Widowed, two adult children. Wants the trust funded before the house sale in November." });
    c("c2", { name: "John Roe", role: "Client", email: "j.roe@example.com", phone: "+1 415 555 0177", dob: "1958-09-30", ssn: "530-21-1144", notes: "Owns a bakery. Needs a succession plan before he steps back in spring." });
    c("c3", { name: "Marcus Doe", role: "Client", email: "marcus.doe@example.com", phone: "+1 415 555 0119", dob: "1988-02-03", ssn: "611-72-0098", notes: "Jane Doe's son. Successor trustee." });
    c("c4", { name: "Priya Shah", role: "Client", email: "priya.shah@example.com", phone: "+1 510 555 0164", dob: "1979-11-21", ssn: "544-90-3321", notes: "Updating a will after a move." });
    c("c5", { name: "Lena Ortiz", role: "Vendor", email: "lena@ortiznotary.example.com", phone: "+1 415 555 0123", notes: "Mobile notary. Signs same day." });
    c("c6", { name: "Dana Reyes", role: "Client", email: "dana.reyes@example.com", phone: "+1 415 555 0190", notes: "Site rebuild client contact." });
    put("template", H, { name: "Welcome", kind: "Email", subject: "Welcome to Juniper Studio, [Client first name]",
      body: "Hi [Client first name],\n\nThank you for choosing Juniper Studio. [Tailored paragraph]\n\nYour matter is [Matter title], and [Attorney name] is your attorney. Next we will send your engagement letter.\n\n[Firm signature]" }, "tpl1");
    put("template", H, { name: "Engagement letter", kind: "Document", subject: "Engagement letter, [Matter title]",
      body: "Client: [Client name]\nSocial Security number: [SSN]\nMatter: [Matter title]\nFee: [Fee]\n\nThis letter confirms that Juniper Studio will act for you in this matter.\n\n[Firm signature]" }, "tpl2");
    log({ type: "member.joined", subject: urnOf(H, "space", H), actor: WHO.chris, what: "joined Juniper Studio", at: today(10, 20) });
    if (world === "empty") return;

    const m = (/** @type {string} */ alias, /** @type {any} */ v, /** @type {string} */ stage) => {
      const { client, fee, owner, ...rest } = v;
      put("matter", H, { ...rest, client: ref(urn(client)), fee: money(fee), owner: own(owner, H), stage }, alias);
    };
    if (world === "morning") {
      m("m1", { title: "Doe estate plan", client: "c1", plan: "Both", fee: 4800, owner: WHO.alex, situation: "Widowed, two adult children", assets: "House at 18 Larkin St, sale in November", pressure: "Fund the trust before the sale",
        research: "Sources: intake form (8 Sep), county property record, her first message. Wants the trust funded before the house sale in November. Two adult children, Marcus is the likely successor trustee.", closing: "2026-10-28" }, "Engagement");
    }
    m("m2", { title: "Roe succession plan", client: "c2", plan: "Trust", fee: 6500, owner: WHO.kit, closing: "2026-11-14" }, "Engagement");
    m("m3", { title: "Shah will update", client: "c4", plan: "Will", fee: 1200, owner: WHO.kit, closing: "2026-10-20" }, "Intake");
    m("m4", { title: "Doe trust, Marcus", client: "c3", plan: "Trust", fee: 3900, owner: WHO.chris, closing: "2026-10-09" }, "Signing");
    m("m5", { title: "Ortiz power of attorney", client: "c5", plan: "Will", fee: 800, owner: WHO.alex, closing: "2026-10-05" }, "Funding");
    const p = (/** @type {string} */ alias, /** @type {string} */ space, /** @type {any} */ v) => { const { owner, brief, ...rest } = v; put("project", space, { ...rest, owner: own(owner, space), brief: file(brief) }, alias); };
    p("p1", H, { title: "Site rebuild", owner: WHO.kit, due: "2026-10-30", brief: "Site rebuild brief.docx" });
    p("p2", H, { title: "Northwind Bakery bookkeeping", owner: WHO.iris, due: "2026-10-15", brief: "Invoice matching notes.pdf" });
    p("p3", M, { title: "Vyre site", owner: WHO.juno, due: "2026-11-05", brief: "Wink page outline.md" });
    p("p4", M, { title: "Passport renewal", owner: WHO.juno, due: "2026-10-20", brief: "Renewal checklist.pdf" });
    put("trip", M, { title: "Lisbon in November", where: addr("", "Lisbon", "", "", "Portugal"), leaves: "2026-11-14", budget: money(2400), stage: "Booked" }, "t1");
    put("trip", M, { title: "Hike weekend", where: addr("", "Point Reyes", "CA"), leaves: "2026-10-10", budget: money(200), stage: "Dreaming" }, "t2");

    /** A task, in the shape the first sketch used; this turns it into the kernel's Task. `doer`, `checker` and `madeBy` are directory ids; `template` and `dependsOn` are aliases or ids. @param {string} recAlias @param {any} t */
    const k = (recAlias, t) => {
      const recordUrn = urn(recAlias), space = spaceOfUrn(recordUrn), id = newTaskId();
      const { doer, checker, madeBy, template, dependsOn, output, stuck, result, now, say, note, required, source, due, state, how, stage, title } = t;
      const outKind = output.kind, target = outKind === "fields" ? output.fields : output.target;
      /** @type {Record<string, any>} */
      const res = {};
      if (result?.draft) res.draft = result.draft;
      if (result?.note) res.note = result.note;
      if (result?.file) res.file = result.file;
      const ext = { ...(now ? { now } : {}), ...(say ? { say } : {}), ...(note ? { note } : {}), ...(required === false ? { required: false } : {}), ...(Object.keys(res).length ? { result: res } : {}) };
      const stamp = today(13, 0);
      /** @type {Task} */
      const task = { id, space, title, record: recordUrn, ...(stage ? { stage } : {}), ...(source ? { source } : {}), doer: actor(doer, space), ...(checker ? { checker: actor(checker, space) } : {}),
        output: { kind: outKind, ...(target !== undefined ? { target } : {}) }, ...(how ? { how } : {}), ...(template ? { template: urn(template) } : {}), depends_on: dependsOn || [], ...(due ? { due } : {}), state,
        ...(stuck ? { stuck: { reason: stuck.reason, since: stuck.since, suggested_fix: { text: stuck.suggestedFix } } } : {}),
        ...(state === "done" && outKind === "sent" ? { outcome: "approved", payload: { payload_hash: "preview", decision: "preview" } } : {}),
        assigned_by: actor(madeBy || doer, space), labels: { trust: "member", red: "internal", source_spaces: [space] }, created_at: stamp, updated_at: stamp, ...(Object.keys(ext).length ? { ext } : {}) };
      tasks.set(id, task);
      return task;
    };
    const dayMs = 86_400_000;
    if (world === "morning") {
      const k1 = k("m1", { title: "Research the client", doer: WHO.research, stage: "Intake", state: "done", output: { kind: "fields", fields: ["situation", "assets", "pressure", "research"] }, how: "assistant",
        result: { note: { text: "Wants the trust funded before the house sale in November.", sources: ["Intake form, 8 Sep", "County property record", "Her first message"] } } });
      k("m1", { title: "Welcome email for Jane Doe", doer: WHO.intake, checker: WHO.alex, stage: "Intake", state: "done", output: { kind: "sent", target: "Email to Jane Doe" }, how: "tailor", template: "tpl1", dependsOn: [k1.id],
        result: { draft: { subject: "Welcome to Juniper Studio, Jane", body: "Hi Jane,\n\nThank you for choosing Juniper Studio. I read that you want the trust funded before the house sale in November, so we will start there.\n\nJuniper Studio", sources: 3 } } });
      const k3 = k("m1", { title: "Engagement letter", doer: WHO.drafting, checker: WHO.alex, stage: "Engagement", state: "working", output: { kind: "sent", target: "Letter for signature" }, how: "tailor", template: "tpl2", due: today(12, 0) + dayMs, now: "is drafting the engagement letter" });
      k("m1", { title: "Review the draft with Jane Doe", doer: WHO.alex, stage: "Engagement", state: "ready", output: { kind: "decision", target: "Approved or changes" }, how: "person", dependsOn: [k3.id], madeBy: WHO.chris, note: "Assigned by Chris", due: today(12, 0) + 3 * dayMs });
    }
    k("m2", { title: "Engagement letter for John Roe", doer: WHO.drafting, checker: WHO.alex, stage: "Engagement", state: "working", output: { kind: "sent", target: "Letter for signature" }, how: "tailor", template: "tpl2", now: "is filling Engagement letter with John's notes" });
    k("m2", { title: "Check the court docket", doer: WHO.juno, stage: "Engagement", state: "stuck", output: { kind: "note", target: "Docket note" }, how: "assistant", madeBy: WHO.juno, note: "juno stopped",
      say: "juno could not log in to the court portal", stuck: { reason: "The password changed.", since: today(8, 40), suggestedFix: "Update the password in the Vault, or reassign to Chris." } });
    const k7 = k("m3", { title: "Research the client", doer: WHO.research, stage: "Intake", state: "working", output: { kind: "fields", fields: ["situation", "assets", "pressure", "research"] }, how: "assistant", now: "is reading Priya Shah's intake form" });
    k("m3", { title: "Welcome email for Priya Shah", doer: WHO.intake, checker: WHO.alex, stage: "Intake", state: "waiting", output: { kind: "sent", target: "Email to Priya Shah" }, how: "tailor", template: "tpl1", dependsOn: [k7.id] });
    k("m3", { title: "Approve a $720 refund for Priya Shah", doer: WHO.alex, stage: "Intake", state: "ready", output: { kind: "decision", target: "Refund or not" }, how: "person", note: "Flow: Large refunds", madeBy: WHO.vyre, required: false,
      source: "flow_step", say: "Approve a $720 refund for Priya Shah" });
    const k10 = k("m4", { title: "Signing date", doer: WHO.alex, stage: "Signing", state: "ready", output: { kind: "fields", fields: ["signing"] }, how: "person", madeBy: WHO.kit, note: "kit asked", source: "assistant_request",
      say: "kit needs the client's signing date to continue" });
    k("m4", { title: "Collect signatures", doer: WHO.alex, stage: "Signing", state: "waiting", dependsOn: [k10.id], output: { kind: "file", target: "Signed documents" }, how: "person" });
    k("m5", { title: "Record the document", doer: WHO.rev, stage: "Funding", state: "working", output: { kind: "file", target: "Recorded deed" }, how: "assistant", now: "is recording the deed with the county" });
    k("p1", { title: "Send the Q3 report to Dana Reyes", doer: WHO.kit, checker: WHO.alex, state: "needs_check", output: { kind: "sent", target: "Email to Dana Reyes" }, how: "assistant", note: "Needs your approval",
      say: "Email to Dana is waiting for approval", result: { draft: { subject: "Q3 report, the short version", body: "Hi Dana,\n\nThe short version: leads are up 18% and the intake form now converts 31% better on mobile. The full report is attached.\n\nAlex" } } });
    const k14 = k("p1", { title: "Fix the intake form label", doer: WHO.kit, state: "working", output: { kind: "file", target: "Intake form" }, how: "assistant", now: "is running the intake form tests" });
    k("p1", { title: "Review the pricing page copy", doer: WHO.juno, state: "working", output: { kind: "note", target: "Review note" }, how: "assistant", now: "is reading the pricing page" });
    k("p1", { title: "Plan the launch checklist", doer: WHO.alex, state: "waiting", dependsOn: [k14.id], output: { kind: "file", target: "Checklist" }, how: "person" });
    k("p2", { title: "Match this week's invoices", doer: WHO.iris, state: "working", output: { kind: "fields", fields: ["matched"] }, how: "assistant", now: "is matching 14 invoices" });
    k("p2", { title: "Pay the supplier invoice", doer: WHO.iris, checker: WHO.alex, state: "stuck", output: { kind: "sent", target: "Payment of $320" }, how: "assistant", say: "iris could not reach the bank",
      stuck: { reason: "The sign-in expired.", since: today(7, 55), suggestedFix: "Chris can sign iris in again." } });
    const k19 = k("p3", { title: "Write the Wink page", doer: WHO.juno, state: "working", output: { kind: "file", target: "Wink page" }, how: "assistant", now: "is writing the Wink page" });
    const k20 = k("p3", { title: "Pick the hero image", doer: WHO.alex, state: "waiting", dependsOn: [k19.id], output: { kind: "file", target: "Hero image" }, how: "person" });
    k("p3", { title: "Publish the preview", doer: WHO.kit, state: "waiting", dependsOn: [k20.id], output: { kind: "sent", target: "Preview" }, how: "assistant" });
    const k22 = k("p4", { title: "Add a signature photo", doer: WHO.alex, state: "ready", output: { kind: "file", target: "Signature photo" }, how: "person", madeBy: WHO.juno, note: "juno asked", source: "assistant_request", say: "Passport renewal needs your signature photo" });
    k("p4", { title: "Submit the form", doer: WHO.juno, checker: WHO.alex, state: "waiting", dependsOn: [k22.id], output: { kind: "sent", target: "Form to the passport office" }, how: "assistant" });
    const k24 = k("t1", { title: "Book the flights", doer: WHO.juno, state: "working", output: { kind: "decision", target: "Which flight" }, how: "assistant", now: "is comparing three flights" });
    k("t1", { title: "Reserve the hotel", doer: WHO.juno, checker: WHO.alex, state: "waiting", dependsOn: [k24.id], output: { kind: "sent", target: "Booking" }, how: "assistant" });
    k("t1", { title: "Pack", doer: WHO.alex, state: "waiting", output: { kind: "file", target: "List" }, how: "person" });
    k("t2", { title: "Pick a trail", doer: WHO.alex, state: "done", output: { kind: "decision", target: "Trail" }, how: "person" });
    k("t2", { title: "Reply to Sam about Saturday", doer: WHO.juno, checker: WHO.alex, state: "needs_check", output: { kind: "sent", target: "Message to Sam Okafor" }, how: "assistant", note: "Needs your approval",
      say: "Reply to Sam about Saturday", result: { draft: { subject: "Saturday", body: "Yes, 8 am at the trailhead. I will bring the trail map." } } });

    if (world === "morning") log({ type: "record.created", subject: urn("m1"), actor: WHO.vyre, what: "created Doe estate plan from the Kit Estate planning matter", why: "Flow On payment: Jane Doe paid $1,500.", at: today(9, 0) });
    log({ type: "message.sent", subject: urnOf(H, "message", seeded("juno-friday-report")), actor: WHO.juno, what: "sent the Friday report draft to you", at: today(11, 48) });
    log({ type: "record.updated", subject: urn("p1"), actor: WHO.kit, what: "fixed the intake form label", at: today(12, 6), data: { changed: ["title"] } });
  }
  seed();
  seeding = false;
  void MATTER_STAGES; void parseUrn;
  return store;
}

/** A kernel Filter against a record's data, for what the screens ask (eq, ne, in, contains, is_null, and, or, not). @param {Record<string, any>} data @param {import("./contracts.js").Filter} f @returns {boolean} */
function matchFilter(data, f) {
  if ("and" in f) return f.and.every(x => matchFilter(data, x));
  if ("or" in f) return f.or.some(x => matchFilter(data, x));
  if ("not" in f) return !matchFilter(data, f.not);
  const v = flat(data[f.field]), want = Array.isArray(f.value) ? f.value.map(flat) : flat(f.value);
  switch (f.op) {
    case "eq": return v === want;
    case "ne": return v !== want;
    case "in": return Array.isArray(want) && want.includes(v);
    case "contains": return String(v).toLowerCase().includes(String(want).toLowerCase());
    case "is_null": return v === "" || v === null || v === undefined;
    case "lt": return v < /** @type {any} */ (want);
    case "lte": return v <= /** @type {any} */ (want);
    case "gt": return v > /** @type {any} */ (want);
    case "gte": return v >= /** @type {any} */ (want);
    default: return false;
  }
}
/** A comparable scalar for a field value. @param {any} v */
function flat(v) { return v && typeof v === "object" ? ("amount" in v ? v.amount : "urn" in v ? v.urn : "actor" in v ? v.actor.id : "name" in v ? v.name : JSON.stringify(v)) : v ?? ""; }
/** @param {any} a @param {any} b */
const cmp = (a, b) => (typeof flat(a) === "number" && typeof flat(b) === "number" ? flat(a) - flat(b) : String(flat(a)).localeCompare(String(flat(b))));
