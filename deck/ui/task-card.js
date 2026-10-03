// @ts-check
// deck/ui/task-card: the task card (an Ask card from the base components) and what it opens (team/0.3/DESIGN-tasks.md, Now). Each card says which record it
// belongs to, who made it and how, and what one tap does. It opens in place, as a sheet: nothing to navigate. For a drafted item that leaves the space, one tap
// (Send with Face ID) is the checker's approval and the Gate approval at once: store.approveTask, never a second card.
//
//   cardModel(input)               pure: the title, the line under it, the tags and the buttons a task gets for a person (tested in task-card.test.js)
//   loadContext(store)             the actors, spaces, types, the person, and a cache of the records tasks belong to
//   taskCard(ctx, task, o)         the card. o: { showSpace, onChange }
//   openTaskSheet(ctx, task, o)    the same task in a sheet, with its facts and its draft
//   taskFacts(ctx, task, o)        the Doer / Checker / Output / How / Inputs rows, shared with the task page (views/ui-task.js)
//   askProof(o)                    the Face ID sheet: the proof is simulated by a button, like the prototype; the real proof replaces this one function
import { h, go } from "../js/dom.js";
import { button, chip, askCard, banner, row, field, openSheet, showToast, avatar } from "./components/index.js";
import { cardModel } from "./card-model.js";
import { actorOf, howSentence, OUTPUT_KINDS, HOW_LABEL, STATE_LABEL, startState, ownerOf } from "./tasks.js";
import { resolveTheme } from "./theme.js";

/** @typedef {import("./contracts.js").Store} Store */
/** @typedef {import("./contracts.js").Task} Task */
/** @typedef {import("./contracts.js").Actor} Actor */
/** @typedef {import("./contracts.js").RecordRow} RecordRow */
/** @typedef {import("./contracts.js").Space} Space */
/** @typedef {import("./contracts.js").TypeDef} TypeDef */
/** @typedef {{ store: Store, me: string, actors: Actor[], spaces: Space[], types: Map<string, TypeDef>, records: Map<string, RecordRow> }} Ctx */

export { cardModel };

// ---- context -----------------------------------------------------------------------------------

/** @param {Store} store @returns {Promise<Ctx>} */
export async function loadContext(store) {
  const [me, actors, spaces, types] = await Promise.all([store.me ? store.me() : Promise.resolve("alex"), store.actors(), store.spaces(), store.types()]);
  return { store, me, actors, spaces, types: new Map(types.map(t => [t.id, t])), records: new Map() };
}

/** Make sure the records these ids name are in the context. @param {Ctx} ctx @param {(string|undefined|null)[]} ids */
export async function loadRecords(ctx, ids) {
  const missing = [...new Set(ids.filter(/** @returns {i is string} */ i => !!i && !ctx.records.has(i)))];
  await Promise.all(missing.map(async id => { const r = await ctx.store.get(id); if (r) ctx.records.set(id, r); }));
}

/** @param {Ctx} ctx @param {RecordRow|null|undefined} r */
export function recordTitle(ctx, r) {
  if (!r) return "";
  const key = ctx.types.get(r.type)?.titleKey || "title";
  return String(r.values[key] ?? r.id);
}

/** @param {Ctx} ctx @param {string} id @returns {Actor|undefined} */
export const actorById = (ctx, id) => actorOf(id, ctx.actors);
/** @param {Ctx} ctx @param {string} id */
export const nameOf = (ctx, id) => actorById(ctx, id)?.name || id;

/**
 * Redraw a screen from the store, never from a copy: calls `draw` (once per tick) after any change, and stops when the screen is gone.
 * @param {Store} store @param {{ cleanup?: (fn: () => void) => void }} ctx @param {HTMLElement} root @param {() => void} draw
 */
export function watchStore(store, ctx, root, draw) {
  let live = true, wasHere = false, queued = false;
  const off = store.subscribe(() => {
    if (root.isConnected) wasHere = true;
    if (!live || (wasHere && !root.isConnected)) { live = false; off(); return; }
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; if (live) draw(); });
  });
  ctx.cleanup?.(() => { live = false; off(); });
}

// ---- small parts -------------------------------------------------------------------------------

/** An actor's mark, by what it is. @param {Actor|undefined} a @param {number} [size] */
export function actorAvatar(a, size = 36) {
  if (!a) return avatar("agent", "vyre", { size });
  const family = a.kind === "person" ? "person" : a.kind === "teammate" ? "teammate" : a.kind === "assistant" ? "agent" : "agent";
  return avatar(family, a.seed || a.id, { size, label: a.name, title: a.name });
}

const NS = "http://www.w3.org/2000/svg";
/** @param {string} d */
function glyph(d) {
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 16 16", "aria-hidden": "true" })) svg.setAttribute(k, v);
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", d); p.setAttribute("fill", "currentColor");
  svg.append(p);
  return svg;
}
const PERSON = "M8 3a3 3 0 100 6 3 3 0 000-6zM2.5 14c.7-3 2.8-4.5 5.5-4.5s4.8 1.5 5.5 4.5z";
const HEX = "M8 1.5l5.8 3.3v6.4L8 14.5 2.2 11.2V4.8z";

/** The space's tint, for the current scheme. @param {Space|undefined} sp */
export function tintOf(sp) {
  const scheme = typeof document !== "undefined" && document.documentElement.dataset.theme === "paper" ? "paper" : "dark";
  return resolveTheme({ space: { accent: sp?.accent, tint: "accent" }, person: { theme: scheme } }).tint;
}

/** A space's small mark: a person for a personal space, a hexagon for a team's. @param {Space|undefined} sp */
export function spaceMark(sp) {
  return h("span", { class: "un-mark", "data-kind": sp?.kind || "team", style: `--tint:${tintOf(sp)}` }, glyph(sp?.kind === "mine" ? PERSON : HEX));
}

/** A chip naming a space, in the space's tint. @param {Space|undefined} sp */
export function spaceChip(sp) {
  const c = chip([spaceMark(sp), sp?.name || ""], { tone: "space" });
  c.style.setProperty("--tint", tintOf(sp));
  return c;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const p2 = (/** @type {number} */ n) => String(n).padStart(2, "0");
/** "12:06" today, else "Mon 28 Sep". @param {number} at @param {number} now */
export function whenLabel(at, now) {
  const d = new Date(at), n = new Date(now);
  if (d.toDateString() === n.toDateString()) return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return `${DAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}
/** "Thursday, 1 October". @param {number} at */
export const dateLine = at => { const d = new Date(at); return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`; };

// ---- Face ID, simulated ------------------------------------------------------------------------

/**
 * The Face ID confirm sheet. Resolves with the proof, or null when it is closed without confirming. The proof is simulated by a button (the prototype does the
 * same); the real proof (WebAuthn, the phone's biometric) replaces this one function.
 * @param {{ title: string, what: string, confirm?: string }} o
 * @returns {Promise<{ method: "face_id" }|null>}
 */
export function askProof(o) {
  return new Promise(resolve => {
    let settled = false;
    const finish = (/** @type {{ method: "face_id" }|null} */ v) => { if (!settled) { settled = true; resolve(v); } };
    openSheet({
      title: o.title, onClose: () => finish(null),
      build(body, close, { actions }) {
        body.append(h("p", { class: "un-sheet-p" }, o.what), h("p", { class: "ui-hint" }, "Face ID confirms it is you. In this preview a button stands in for it, and nothing is sent."));
        actions.append(button({ label: "Cancel", kind: "ghost", onclick: () => close() }),
          button({ label: o.confirm || "Confirm with Face ID", kind: "primary", icon: "shield", onclick: () => { finish({ method: "face_id" }); close(); } }));
      },
    });
  });
}

// ---- facts shared by the card's sheet and the task page ----------------------------------------

/** One label and its value, the shape of a line on the task page. @param {string} label @param {...any} value */
export const factRow = (label, ...value) => h("div", { class: "un-fact" }, h("div", { class: "un-fact-l" }, label), h("div", { class: "un-fact-v" }, ...value));

/** @param {Ctx} ctx @param {string} id @param {string} [meta] */
function actorLine(ctx, id, meta) {
  const a = actorById(ctx, id);
  return h("span", { class: "un-actor" }, actorAvatar(a, 28), h("b", null, a?.name || id), meta ? h("span", { class: "un-meta" }, meta) : null);
}

/**
 * The facts of a task, as rows: Doer, Checker, Output with Done-when, How, Inputs.
 * @param {Ctx} ctx @param {Task} task @param {{ record?: RecordRow|null, how?: Node, titles?: Map<string, string> }} [o] `how` replaces the plain How line (the task page's segmented control)
 */
export function taskFacts(ctx, task, o = {}) {
  const rec = o.record ?? ctx.records.get(task.record);
  const kind = OUTPUT_KINDS[task.output?.kind] || OUTPUT_KINDS.file;
  const tpl = task.template ? ctx.records.get(task.template) : null;
  const inputs = [];
  if (rec?.values?.research && task.how === "tailor") inputs.push(`Research notes on ${recordTitle(ctx, rec)}`);
  if (tpl) inputs.push(`Template: ${recordTitle(ctx, tpl)}`);
  for (const d of task.dependsOn || []) inputs.push(`Output of ${o.titles?.get(d) || d}`);
  const checker = task.checker;
  return h("div", { class: "un-facts" },
    factRow("Doer", actorLine(ctx, task.doer, task.state === "working" && task.now ? task.now : "One doer, accountable")),
    factRow("Checker", checker ? actorLine(ctx, checker, task.output?.kind === "sent" ? "Their approval sends it" : undefined) : h("span", { class: "un-none" }, "None")),
    factRow("Output", h("b", null, kind.label), task.output?.target ? `: ${task.output.target}` : "", " ", h("span", { class: "un-meta" }, `Done when ${kind.doneWhen}`)),
    factRow("How", o.how || h("span", { class: "un-muted" }, (task.how && HOW_LABEL[task.how]) || "Done by hand")),
    factRow("Inputs", inputs.length ? h("span", { class: "un-chips" }, inputs.map(t => chip(t))) : h("span", { class: "un-none" }, "None")));
}

/** The draft block, with its one sentence. @param {Ctx} ctx @param {Task} task @param {RecordRow|null|undefined} rec */
export function draftBlock(ctx, task, rec) {
  const d = /** @type {any} */ (task).result?.draft;
  if (!d) return null;
  const tpl = task.template ? ctx.records.get(task.template) : null;
  const how = howSentence(task, { actors: ctx.actors, templateName: tpl ? recordTitle(ctx, tpl) : undefined, usedNotesOf: task.how === "tailor" && rec?.values?.research ? "Research" : undefined });
  return h("div", { class: "un-draft" }, d.subject ? h("b", { class: "un-draft-s" }, d.subject) : null, h("div", { class: "un-draft-b" }, d.body),
    h("div", { class: "un-meta" }, `${how}${d.sources ? ` ${d.sources} sources.` : ""}`));
}

// ---- actions -----------------------------------------------------------------------------------

/** @param {any} e */
const say = e => showToast({ text: String(e?.message || e || "Something went wrong.") });

/**
 * Run one of a card's buttons. Returns when it is done; the store's subscribers redraw the screen.
 * @param {Ctx} ctx @param {Task} task @param {string} id @param {{ input?: string, openSheet?: () => void }} [o]
 */
export async function runAction(ctx, task, id, o = {}) {
  const { store, me } = ctx;
  const rec = ctx.records.get(task.record);
  const rt = recordTitle(ctx, rec);
  try {
    if (id === "open") { o.openSheet?.(); return; }
    if (id === "send" || id === "approve") {
      const proof = await askProof({ title: id === "send" ? (/payment/i.test(task.output?.target || "") ? "Pay with Face ID" : "Send with Face ID") : "Approve with Face ID",
        what: id === "send" ? `${task.output?.target || task.title} for ${rt} leaves your space when you confirm.` : `${task.title} is checked and done when you confirm.` });
      if (!proof) return;
      const before = rec?.stage;
      await store.approveTask(task.id, proof);
      const after = await store.get(task.record);
      if (after) ctx.records.set(after.id, after);
      showToast({ text: `${id === "send" ? "Sent" : "Approved"}: ${task.output?.target || task.title}.${after?.stage && before && after.stage !== before ? ` ${rt} moved to ${after.stage}.` : ""}` });
      return;
    }
    if (id === "edit") { await editDraft(ctx, task); return; }
    if (id === "fix") { fixSheet(ctx, task); return; }
    if (id === "reassign") { reassignSheet(ctx, task); return; }
    if (id === "done") { await store.updateTask(task.id, { state: "done" }, me); showToast({ text: `Done: ${task.title}.` }); return; }
    if (id === "file") { fileSheet(ctx, task); return; }
    if (id === "save") {
      const key = task.output.fields?.[0];
      if (!key || !String(o.input || "").trim()) { showToast({ text: "Enter a value first." }); return; }
      await store.update(task.record, { [key]: o.input }, me);
      const rec2 = await store.get(task.record);
      if (rec2) ctx.records.set(rec2.id, rec2);
      await store.updateTask(task.id, { state: "done" }, me);
      showToast({ text: `Saved. ${task.title} is done.` });
      return;
    }
    if (id === "yes") {
      const proof = await askProof({ title: "Approve with Face ID", what: `${task.title}. This is your approval to go ahead.` });
      if (!proof) return;
      await store.updateTask(task.id, { result: { decision: { answer: "yes", reason: "Approved with Face ID." } }, state: "done" }, me);
      showToast({ text: `Approved: ${task.title}.` });
      return;
    }
    if (id === "no") {
      await store.updateTask(task.id, { result: { decision: { answer: "no", reason: "Declined." } }, state: "done" }, me);
      showToast({ text: `Declined: ${task.title}.` });
    }
  } catch (e) { say(e); }
}

/** Edit the draft in place (a sheet). @param {Ctx} ctx @param {Task} task */
function editDraft(ctx, task) {
  const d = /** @type {any} */ (task).result?.draft || { body: "" };
  return new Promise(resolve => {
    openSheet({
      title: "Edit the draft", onClose: () => resolve(undefined),
      build(body, close, { actions }) {
        const subject = field({ label: "Subject", value: d.subject || "" });
        const text = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "ui-input un-text", rows: "10", "aria-label": "Message" }, d.body));
        body.append(d.subject !== undefined ? subject : "", h("label", { class: "ui-field" }, h("span", { class: "ui-field-l" }, "Message"), text));
        actions.append(button({ label: "Cancel", kind: "ghost", onclick: () => close() }), button({ label: "Save", kind: "primary", onclick: async () => {
          try {
            await ctx.store.updateTask(task.id, { result: { draft: { ...d, subject: d.subject !== undefined ? subject.input.value : d.subject, body: text.value } } }, ctx.me);
            showToast({ text: "Draft saved." }); close();
          } catch (e) { say(e); }
        } }));
      },
    });
  });
}

/** The Fix sheet: what stopped it, what to do, and I fixed it. @param {Ctx} ctx @param {Task} task */
function fixSheet(ctx, task) {
  openSheet({
    title: "Fix what stopped it",
    build(body, close, { actions }) {
      body.append(banner({ tone: "warn", icon: "lock" }, h("b", null, `${nameOf(ctx, task.doer)} stopped on ${task.title}.`), " ", task.stuck?.reason || ""),
        h("p", { class: "un-sheet-p" }, task.stuck?.suggestedFix || "Fix it, then tell Vyre."));
      if (/vault/i.test(task.stuck?.suggestedFix || "")) actions.append(button({ label: "Open the Vault", kind: "secondary", onclick: () => { close(); go("/vault"); } }));
      actions.append(button({ label: "I fixed it", kind: "primary", onclick: async () => {
        try {
          await ctx.store.updateTask(task.id, { state: startState(task, ctx.actors) }, ctx.me);
          showToast({ text: `${nameOf(ctx, task.doer)} is on it again.` }); close();
        } catch (e) { say(e); }
      } }));
    },
  });
}

/** The Reassign sheet. @param {Ctx} ctx @param {Task} task */
function reassignSheet(ctx, task) {
  openSheet({
    title: `Reassign ${task.title}`,
    build(body, close) {
      const owner = ownerOf(task.doer, ctx.actors);
      const pool = ctx.actors.filter(a => a.kind !== "device" && a.id !== task.doer).sort((a, b) => Number(b.kind === "person") - Number(a.kind === "person") || Number(b.id === owner) - Number(a.id === owner));
      body.append(...pool.map(a => row({ lead: actorAvatar(a, 32), title: a.name, sub: a.role || (a.kind === "person" ? "Person" : "Assistant"), onclick: async () => {
        try { await ctx.store.reassignTask(task.id, a.id); showToast({ text: `${task.title} is with ${a.name}.` }); close(); } catch (e) { say(e); }
      } })));
    },
  });
}

/** The Add the file sheet: the mock names a file; the real Deck attaches one. @param {Ctx} ctx @param {Task} task */
function fileSheet(ctx, task) {
  openSheet({
    title: task.output?.target ? `Add: ${task.output.target}` : "Add the file",
    build(body, close, { actions }) {
      const name = field({ label: "File name", value: "", placeholder: task.output?.target || "File" });
      body.append(name);
      actions.append(button({ label: "Cancel", kind: "ghost", onclick: () => close() }), button({ label: "Add", kind: "primary", onclick: async () => {
        const v = name.input.value.trim();
        if (!v) { showToast({ text: "Name the file first." }); return; }
        try { await ctx.store.updateTask(task.id, { result: { file: { name: v } }, state: "done" }, ctx.me); showToast({ text: `Added ${v}.` }); close(); } catch (e) { say(e); }
      } }));
    },
  });
}

// ---- the card and its sheet --------------------------------------------------------------------

/**
 * The task card.
 * @param {Ctx} ctx @param {Task} task @param {{ showSpace?: boolean, fresh?: boolean }} [o]
 */
export function taskCard(ctx, task, o = {}) {
  const rec = ctx.records.get(task.record);
  const space = ctx.spaces.find(s => s.id === rec?.space);
  const tpl = task.template ? ctx.records.get(task.template) : null;
  const model = cardModel({ task, record: rec, recordTitle: recordTitle(ctx, rec), actors: ctx.actors, me: ctx.me, space, showSpace: o.showSpace, templateName: tpl ? recordTitle(ctx, tpl) : undefined,
    fieldDef: (/** @type {string} */ k) => ctx.types.get(rec?.type || "")?.fields.find(f => f.key === k) });
  /** @type {HTMLInputElement|null} */
  let input = null;
  const open = () => openTaskSheet(ctx, task, o);
  const tags = model.tags.map(t => t.kind === "space" ? spaceChip(space) : chip(t.text, { tone: t.tone || "plain" }));
  const recChip = tags[model.tags.findIndex(t => t.kind === "record")];
  if (recChip) { recChip.classList.add("un-chip-link"); recChip.setAttribute("role", "button"); recChip.tabIndex = 0; recChip.addEventListener("click", open); }
  const el = askCard({
    lead: actorAvatar(actorById(ctx, model.lead), 36),
    title: h("button", { type: "button", class: "un-card-t", onclick: open }, model.title),
    why: model.why, tags,
    actions: model.actions.map(a => ({ label: a.label, kind: a.kind, icon: a.icon, onclick: () => runAction(ctx, task, a.id, { input: input?.value, openSheet: open }) })),
  });
  el.dataset.task = task.id; el.dataset.state = task.state; el.classList.add("un-card");
  if (o.fresh) el.classList.add("is-new");
  if (model.inline) {
    const f = field({ kind: model.inline.fieldKind, label: model.inline.label, value: "" });
    input = f.input;
    el.querySelector(".ui-ask-acts")?.prepend(f);
  }
  return el;
}

/**
 * The same task, in a sheet: its facts, its draft, and the buttons it would have on the card.
 * @param {Ctx} ctx @param {Task} task @param {{ showSpace?: boolean }} [o]
 */
export function openTaskSheet(ctx, task, o = {}) {
  const rec = ctx.records.get(task.record);
  const tpl = task.template ? ctx.records.get(task.template) : null;
  const model = cardModel({ task, record: rec, recordTitle: recordTitle(ctx, rec), actors: ctx.actors, me: ctx.me, templateName: tpl ? recordTitle(ctx, tpl) : undefined,
    fieldDef: (/** @type {string} */ k) => ctx.types.get(rec?.type || "")?.fields.find(f => f.key === k) });
  void o;
  return openSheet({
    title: task.title,
    build(body, close, { actions }) {
      body.append(h("p", { class: "un-sheet-p" }, model.why),
        h("div", { class: "un-chips" }, chip(STATE_LABEL[task.state], { tone: task.state === "done" ? "ok" : task.state === "stuck" ? "sealed" : "accent" }), chip(recordTitle(ctx, rec))),
        taskFacts(ctx, task, { record: rec }), draftBlock(ctx, task, rec));
      actions.append(button({ label: "Open the task page", kind: "ghost", onclick: () => { close(); go(`/u/task/${task.id}`); } }));
      for (const a of model.actions.filter(x => x.id !== "open" && x.id !== "save")) {
        actions.append(button({ label: a.label, kind: a.kind, icon: a.icon, onclick: () => { close(); void runAction(ctx, task, a.id, {}); } }));
      }
    },
  });
}
