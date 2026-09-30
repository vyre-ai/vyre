// @ts-check
// A project's Team tab: teammates, their pane, and the writes. Sample world only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text, $, $$ } from "./fake-dom.js";

const doc = /** @type {any} */ (install());
doc.importNode = n => n;
doc.createDocumentFragment = () => new /** @type {any} */ (globalThis).Element("fragment");
Object.assign(globalThis, { dispatchEvent: () => true });
const { drawTeam, teammatesOf, stateWord, clip } = await import("../views/project-team.js");

const LIST = [
  { agent: "design-harlow-legal", project: "harlow-legal", role: "design", shared: false, brief: "Layouts and copy for the site", filler: { kind: "agent", agent: "kit" }, state: "working", queued: 2, current_request: "rq1", last_result: { request: "rq0", state: "done", result: "Drafted the hero.\\nTwo options." } },
  { agent: "backend-harlow-legal", project: "harlow-legal", role: "backend", shared: false, brief: "", filler: { kind: "default" }, state: "idle", queued: 0, current_request: null, last_result: { request: "rq9", state: "failed", result: "Tests failed" } }];
function world(answers = {}) {
  const calls = [], subs = [];
  const attempt = async (tool, input = {}) => { calls.push({ tool, input }); const a = typeof answers[tool] === "function" ? answers[tool](input) : answers[tool]; return a && a.$error ? { error: a.$error } : { data: a ?? {} }; };
  return { calls, subs, attempt, of: t => calls.filter(c => c.tool === t), ctx: { alive: () => true, on: (t, fn) => subs.push([t, fn]) } };
}
const click = el => el.dispatchEvent(new /** @type {any} */ (globalThis).Event("click"));
const settle = () => new Promise(r => setTimeout(r, 10));
const ANS = { "team.list": LIST, "team.default.get": { project: "harlow-legal", enabled: true }, "team.notes": { agent: "x", part: "general", text: "Uses the warm palette.", versions: [] },
  "team.charter.get": { agent: "x", charter: { version: 2, text: "Own the site's look." } }, "team.duties.list": { duties: [{ id: "d1", instruction: "Check contrast weekly", trigger: "every Monday", enabled: false, started: false }] },
  "team.status": { state: "running", position: 0 }, "agents.list": [{ name: "kit", kind: "agent" }, { name: "juno", kind: "assistant" }] };
async function mount(answers = {}) {
  const w = world({ ...ANS, ...answers });
  const el = doc.createElement("div");
  await drawTeam(el, w.ctx, { slug: "harlow-legal" }, { attempt: w.attempt });
  return { ...w, el };
}
const row = (el, agent) => $(el, `[data-teammate="${agent}"]`);

test("teammatesOf, stateWord and clip read what team.list sends", () => {
  assert.deepEqual(teammatesOf(LIST).map(t => [t.role, t.filler, t.queued]), [["design", "kit", 2], ["backend", null, 0]]);
  assert.equal(stateWord("running"), "Working");
  assert.equal(stateWord("weird"), "weird");
  assert.equal(clip("a  b\\nc", 10), "a b\\nc".replace(/\\s+/g, " "));
  assert.equal(clip("x".repeat(300), 20).length, 20);
  assert.deepEqual(teammatesOf(null), []);
});

test("the rows: role, state, who fills it, queue, brief and the last result; nothing written on open", async () => {
  const m = await mount();
  const t = text(row(m.el, "design-harlow-legal"));
  assert.match(t, /design.*Working/);
  assert.match(t, /kit fills it/);
  assert.match(t, /2 queued/);
  assert.match(t, /Layouts and copy for the site/);
  assert.match(t, /Last: Drafted the hero/);
  assert.match(text(row(m.el, "backend-harlow-legal")), /The project's helper/);
  assert.match(text(row(m.el, "backend-harlow-legal")), /Failed: Tests failed/);
  assert.deepEqual(m.calls.map(c => c.tool).sort(), ["team.default.get", "team.list"]);
});

test("Open reads the pane: now, last result, notes, charter, duties; only reads", async () => {
  const m = await mount();
  click($(row(m.el, "design-harlow-legal"), "[data-act=open]")); await settle();
  assert.deepEqual(m.of("team.status")[0].input, { request: "rq1" });
  assert.deepEqual(m.of("team.notes")[0].input, { action: "get", agent: "design-harlow-legal" });
  const t = text(row(m.el, "design-harlow-legal"));
  assert.match(t, /Working, position 0/);
  assert.match(t, /2 requests waiting/);
  assert.match(t, /Uses the warm palette/);
  assert.match(t, /Own the site's look/);
  assert.match(t, /Check contrast weekly.*every Monday/);
  assert.equal(m.calls.filter(c => /set|update|fill|retire|add/.test(c.tool)).length, 0);
});

test("Edit notes saves through team.notes set; Edit charter through team.charter.set; fill and duties call their tools", async () => {
  const m = await mount({ "team.notes": i => (i.action === "set" ? { version: 2 } : ANS["team.notes"]), "team.charter.set": { version: 3 }, "team.role.fill": {}, "team.duties.enable": {}, "team.duties.disable": {} });
  const a = "design-harlow-legal";
  click($(row(m.el, a), "[data-act=open]")); await settle();
  click($(row(m.el, a), "[data-act=notes-edit]"));
  $(row(m.el, a), "[data-sec=notes] textarea").value = "New palette notes";
  click($(row(m.el, a), "[data-act=notes-save]")); await settle();
  assert.deepEqual(m.of("team.notes").find(c => c.input.action === "set")?.input, { action: "set", agent: a, text: "New palette notes" });
  click($(row(m.el, a), "[data-act=charter-edit]"));
  $(row(m.el, a), "[data-sec=setup] textarea").value = "Own it.";
  click($(row(m.el, a), "[data-act=charter-save]")); await settle();
  assert.deepEqual(m.of("team.charter.set")[0].input, { teammate: a, text: "Own it." });
  $(row(m.el, a), "select").value = "";
  click($(row(m.el, a), "[data-act=fill]")); await settle();
  assert.deepEqual(m.of("team.role.fill")[0].input, { teammate: a }, "no agent means the project's helper");
  click($(row(m.el, a), "[data-act=duty-toggle]")); await settle();
  assert.deepEqual(m.of("team.duties.enable")[0].input, { id: "d1", expect: "Check contrast weekly" }, "enable carries the instruction the person was shown, so a duty edited since never starts");
  assert.equal(m.of("team.duties.update").length, 0);
});

test("Retire asks once, says the notes are kept, then calls team.retire", async () => {
  const m = await mount({ "team.retire": { retired: true } });
  const a = "backend-harlow-legal";
  click($(row(m.el, a), "[data-act=open]")); await settle();
  click($(row(m.el, a), "[data-act=retire]"));
  assert.equal(m.of("team.retire").length, 0);
  assert.match(text(row(m.el, a)), /Its notes and history are kept/);
  click($(row(m.el, a), "[data-act=retire-yes]")); await settle();
  assert.deepEqual(m.of("team.retire")[0].input, { teammate: a });
});

test("Add a teammate: a role word and an optional brief go to team.add; a bad role is refused in words first", async () => {
  const m = await mount({ "team.add": {} });
  click($(m.el, "[data-act=add]"));
  $(m.el, ".tm-add input").value = "Bad Role";
  $(m.el, ".tm-add").dispatchEvent(new /** @type {any} */ (globalThis).Event("submit")); await settle();
  assert.equal(m.of("team.add").length, 0);
  assert.match(text(m.el), /one lowercase word/);
  const inputs = $$(m.el, ".tm-add input");
  inputs[0].value = "docs"; inputs[1].value = "Write the help pages";
  $(m.el, ".tm-add").dispatchEvent(new /** @type {any} */ (globalThis).Event("submit")); await settle();
  assert.deepEqual(m.of("team.add")[0].input, { project: "harlow-legal", role: "docs", brief: "Write the help pages" });
});

test("the steer toggle calls team.default.set; a refusal is shown; no teammate module is one plain line", async () => {
  const m = await mount({ "team.default.set": { $error: { code: "denied", message: "only a person" } } });
  const box = $(m.el, "[data-act=steer]");
  box.checked = false; box.dispatchEvent(Object.assign(new /** @type {any} */ (globalThis).Event("change"), { target: box })); await settle();
  assert.deepEqual(m.of("team.default.set")[0].input, { project: "harlow-legal", enabled: false });
  assert.match(text(m.el), /only a person/);
  const none = await mount({ "team.list": { $error: { code: "no_such_tool", message: "x", missing: true, module: "team" } } });
  assert.match(text(none.el), /Teammates are not on this box yet/);
});

test("team events reload the list", async () => {
  const m = await mount();
  assert.ok(m.subs.some(s => s[0] === "teammate.added") && m.subs.some(s => s[0] === "team.done"));
  m.subs.find(s => s[0] === "teammate.retired")[1]({}); await settle();
  assert.equal(m.of("team.list").length, 2);
});

test("a failed enable shows the box's own words (a bad trigger reads watchers: how to write it)", async () => {
  const m = await mount({ "team.duties.enable": { $error: { code: "bad_input", message: "watchers: write the trigger like daily 07:00" } } });
  const a = "design-harlow-legal";
  click($(row(m.el, a), "[data-act=open]")); await settle();
  click($(row(m.el, a), "[data-act=duty-toggle]")); await settle();
  assert.match(text(m.el), /watchers: write the trigger like daily 07:00/);
});
