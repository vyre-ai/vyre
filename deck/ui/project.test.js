// @ts-check
// The project page (views/ui-project.js, ui/project.js): the tasks of each stage, the stage that moves by itself, the team with its "doing now" line, and a stuck
// task's reason. The screen runs on the mock store in the fake DOM, as the Deck would draw it.
import test from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "../test/fake-dom.js";

const document = install();
/** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
/** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
/** @type {any} */ (document).createElementNS = (/** @type {string} */ _ns, /** @type {string} */ tag) => document.createElement(tag);
const { createMockStore } = await import("./mock-store.js");
const { setStore } = await import("./store.js");
const { stageGroups, teamOf, teamLine, liveLine, createdLine, stateWord } = await import("./project.js");
const { default: screen } = await import("../views/ui-project.js");

const NOW = Date.parse("2026-10-01T13:00:00");
const tick = (/** @type {number} */ ms = 30) => new Promise(r => setTimeout(r, ms));
/** @param {string} id @param {"morning"|"payday"|"empty"} [world] */
async function open(id, world = "morning", extra = {}) {
  const store = createMockStore({ world, now: () => NOW });
  setStore(store);
  const root = document.createElement("div");
  document.body.append(root);
  /** @type {(() => void)[]} */
  const cleanups = [];
  await screen({ root, params: { screen: "project", a: id }, cleanup: (/** @type {() => void} */ f) => cleanups.push(f), ...extra });
  return { store, root, done: () => cleanups.forEach(f => f()) };
}
const stages = (/** @type {any} */ root) => /** @type {any[]} */ ([...$$(root, ".up-stage")]);
const stageNamed = (/** @type {any} */ root, /** @type {string} */ n) => stages(root).find(s => s.getAttribute("data-stage") === n);
const taskTitles = (/** @type {any} */ sec) => /** @type {any[]} */ ([...$$(sec, ".up-task")]).map(t => text($(t, ".up-task-t b")));

test("tasks group under their stages, the current stage open and the others collapsed with n of m done", async () => {
  const { root, done } = await open("m1");
  assert.deepEqual(stages(root).map(s => s.getAttribute("data-stage")), ["Intake", "Engagement"], "only stages that have tasks, plus the current one");
  const intake = stageNamed(root, "Intake"), eng = stageNamed(root, "Engagement");
  assert.equal($(intake, ".up-stage-h").getAttribute("aria-expanded"), "false");
  assert.equal($$(intake, ".up-task").length, 0, "collapsed: its tasks are not drawn");
  assert.match(text($(intake, ".up-stage-n")), /2 of 2 done/);
  assert.equal($(eng, ".up-stage-h").getAttribute("aria-expanded"), "true");
  assert.deepEqual(taskTitles(eng), ["Engagement letter", "Review the draft with Jane Doe"]);
  assert.match(text($(eng, ".up-stage-n")), /0 of 2 done/);
  assert.deepEqual([...$$(eng, ".up-task")].map(t => t.getAttribute("data-state")), ["working", "ready"]);
  assert.match(text($(eng, '.up-task[data-state="working"]')), /Working/);
  $(intake, ".up-stage-h").click();
  assert.deepEqual(taskTitles(stageNamed(root, "Intake")), ["Research the client", "Welcome email for Jane Doe"], "a click opens a collapsed stage");
  assert.match(text(stageNamed(root, "Intake")), /Checked by Alex Rivera/);
  done();
});

test("stageGroups: stage order, required counts, and tasks with no stage in one group", () => {
  const t = (/** @type {string} */ id, /** @type {any} */ o) => ({ id, title: id, record: "r", doer: "alex", state: "ready", output: { kind: "file" }, ...o });
  const tasks = /** @type {any[]} */ ([t("a", { stage: "Two", state: "done" }), t("b", { stage: "One", state: "done" }), t("c", { stage: "Two", required: false }), t("d", {})]);
  const g = stageGroups(tasks, ["One", "Two", "Three"], "Two");
  assert.deepEqual(g.map(x => [x.label, x.done, x.total, x.current, x.complete]), [["One", 1, 1, false, true], ["Two", 1, 1, true, true], ["Tasks", 0, 1, false, false]]);
  assert.deepEqual(stageGroups(tasks.slice(3), [], undefined).map(x => [x.label, x.current]), [["Tasks", true]], "a type with no stages is one open list");
  assert.deepEqual(stageGroups([], ["One", "Two"], "Two").map(x => x.label), ["Two"], "the current stage shows even when it has no tasks yet");
});

test("the stage advances when the last required task is done: the strip, the open stage and a toast", async () => {
  const { store, root, done } = await open("m1");
  assert.equal(text($(root, ".ui-stage.is-current")), "Engagement");
  const [letter, review] = (await store.tasks({ record: "m1" })).filter(t => t.stage === "Engagement");
  await store.updateTask(letter.id, { result: { draft: { subject: "Engagement letter", body: "Client: Jane Doe", sources: 1 } }, state: "needs_check" }, "drafting");
  await store.approveTask(letter.id, { method: "face_id" });
  await tick();
  assert.equal(text($(root, ".ui-stage.is-current")), "Engagement", "one required task is still open");
  assert.match(text(stageNamed(root, "Engagement")), /1 of 2 done/);
  await store.updateTask(review.id, { result: { decision: { answer: "yes", reason: "Approved as written." } }, state: "done" }, "alex");
  await tick();
  assert.equal(text($(root, ".ui-stage.is-current")), "Drafting", "the record moved on by itself");
  assert.equal($(stageNamed(root, "Drafting"), ".up-stage-h").getAttribute("aria-expanded"), "true", "the new stage opens");
  assert.equal($(stageNamed(root, "Engagement"), ".up-stage-h").getAttribute("aria-expanded"), "false", "the finished one collapses");
  assert.deepEqual(taskTitles(stageNamed(root, "Drafting")), ["Draft the trust and will"], "entering the stage made its tasks");
  assert.match(text(document.body), /Doe estate plan moved to Drafting\./, "the toast says so");
  assert.ok($(root, ".ui-stages").classList.contains("up-moved"), "the strip animates");
  done();
});

test("the team shows each teammate's doing-now line and updates when the store changes", async () => {
  const { store, root, done } = await open("m1");
  const lines = () => /** @type {any[]} */ ([...$$(root, ".uv-mem")]).map(m => [text($(m, "b")), text($(m, ".uv-hint"))]);
  assert.deepEqual(lines(), [["Alex Rivera", "Owner"], ["Research", "Research wrote 3 fields and a note with 3 sources"], ["Intake", "Intake sent the Welcome email"], ["Drafting", "Drafting is drafting the engagement letter"]]);
  assert.match(text($(root, ".uv-doing")), /Drafting is drafting the engagement letter/, "the live line under the strip");
  const letter = (await store.tasks({ record: "m1" })).find(t => t.title === "Engagement letter");
  await store.updateTask(/** @type {any} */ (letter).id, { now: "is checking the fee against the Kit" }, "drafting");
  await tick();
  assert.equal(lines()[3][1], "Drafting is checking the fee against the Kit");
  assert.match(text($(root, ".uv-doing")), /Drafting is checking the fee against the Kit/);
  assert.match(text($(stageNamed(root, "Engagement"), ".up-now")), /Drafting is checking the fee against the Kit/, "and on the task itself");
  done();
});

test("teamLine: a working task, then the actor's doing field, then what it finished, then its role", () => {
  const actors = /** @type {any[]} */ ([{ id: "a", kind: "teammate", name: "Research", role: "Teammate" }, { id: "b", kind: "teammate", name: "Intake", role: "Teammate", doing: "Intake is waiting for the form" }, { id: "alex", kind: "person", name: "Alex", role: "Attorney" }]);
  const w = /** @type {any} */ ({ id: "1", title: "Look up the client", doer: "a", state: "working", output: { kind: "note" }, now: "is reading harlowlegal.com" });
  assert.equal(teamLine("a", { tasks: [w], actors }), "Research is reading harlowlegal.com");
  assert.equal(teamLine("a", { tasks: [{ ...w, now: undefined }], actors }), "Research is working on look up the client");
  assert.equal(teamLine("b", { tasks: [], actors }), "Intake is waiting for the form");
  assert.equal(teamLine("a", { tasks: [{ ...w, state: "done", result: { note: { text: "x", sources: ["s"] } } }], actors }), "Research wrote a note with 1 source");
  assert.equal(teamLine("a", { tasks: [], actors }), "Teammate");
  assert.deepEqual(teamOf({ tasks: [w], actors, owner: "alex" }).map(m => [m.id, m.doing]), [["alex", "Owner"], ["a", "Research is reading harlowlegal.com"]]);
  assert.equal(liveLine([w], actors), "Research is reading harlowlegal.com");
  assert.equal(liveLine([], actors), null);
});

test("a stuck task shows its reason on the page, and the team says the assistant is stuck", async () => {
  const { root, done } = await open("m2");
  const stuck = $(stageNamed(root, "Engagement"), '.up-task[data-state="stuck"]');
  assert.ok(stuck, "the court docket task is stuck");
  assert.match(text($(stuck, ".up-why")), /The password changed\./);
  assert.match(text(stuck), /Stuck/);
  assert.match(text(root), /juno is stuck\. The password changed\./, "in the team line too");
  done();
});

test("a task opens its card in place, and a check waiting on me says so", async () => {
  /** @type {any[]} */
  const opened = [];
  const { root, done } = await open("m1", "morning", { openTask: (/** @type {any} */ t) => opened.push(t.title) });
  assert.equal(stateWord(/** @type {any} */ ({ state: "needs_check", checker: "alex" }), "alex"), "Needs your check");
  assert.equal(stateWord(/** @type {any} */ ({ state: "needs_check", checker: "chris" }), "alex"), "Needs a check");
  $(stageNamed(root, "Engagement"), '.up-task[data-state="ready"]').click();
  assert.deepEqual(opened, ["Review the draft with Jane Doe"]);
  done();
});

test("created from the Kit: the first event says who made it, from what and why", async () => {
  const { store, root, done } = await open("m1");
  assert.match(text($(root, ".up-created")), /Created by Vyre from the Kit Estate planning matter, .*Flow On payment: Jane Doe paid \$1,500\./);
  const actors = await store.actors();
  assert.equal(createdLine([], actors), null);
  assert.match(String(createdLine([{ id: "e", actor: "alex", what: "created Trip", at: 1 }], actors)), /^Created by Alex Rivera, .+\.$/);
  done();
});

test("a project that was just paid for: Research done, the Welcome email waiting for one tap", async () => {
  const { runClientPays } = await import("./scenario.js");
  const store = createMockStore({ world: "payday", now: () => NOW });
  setStore(store);
  const made = await runClientPays(store, {});
  const root = document.createElement("div");
  document.body.append(root);
  await screen({ root, params: { screen: "project", a: made.matter }, cleanup() {} });
  const intake = stageNamed(root, "Intake");
  assert.deepEqual([...$$(intake, ".up-task")].map(t => t.getAttribute("data-state")), ["done", "needs_check"]);
  assert.match(text(intake), /Needs your check/);
  assert.match(text(root), /Intake drafted the welcome email for Jane Doe\. It waits for Alex Rivera\.|Intake drafted the welcome email\. It waits for Alex Rivera\./);
});

test("Projects lists every record of a type that holds work, with its stage, owner and tasks", async () => {
  const { default: projects } = await import("../views/ui-projects.js");
  setStore(createMockStore({ world: "morning", now: () => NOW }));
  const root = document.createElement("div");
  document.body.append(root);
  await projects({ root, params: { screen: "projects" }, cleanup() {} });
  const rows = /** @type {any[]} */ ([...$$(root, ".ui-tr")]).slice(1);
  assert.equal(rows.length, 11, "5 matters, 4 projects, 2 trips; contacts and templates hold no work");
  assert.deepEqual([...$$(root, ".ui-th .ui-td")].map(c => text(c)), ["Name", "Type", "Stage", "Owner", "Tasks"]);
  assert.match(text(rows[0]), /Doe estate plan.*Harlow Legal.*Matter.*Engagement.*Alex Rivera.*2 of 4 tasks/);
  assert.deepEqual([...$$(root, ".un-pills")[1].querySelectorAll(".un-pill")].map(b => text(b)), ["All", "Matters", "Projects", "Trips"]);
  [...$$(root, ".un-pills")[1].querySelectorAll(".un-pill")][3].click();
  await tick();
  assert.equal([...$$(root, ".ui-tr")].length - 1, 2, "the Trips chip narrows it");
});
