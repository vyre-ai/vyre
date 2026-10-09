import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { problems, compile, briefOf, snapshotOf } from "./project-template.js";
import { stagesFor } from "./expr/conditions.js";

const estate = () => ({
  name: "Estate plan", description: "Intake to signing", tags: ["estate"],
  roles: [{ role: "researcher", agent: "research", lead: false }, { role: "drafter", agent: "scribe" }, { role: "attorney" }],
  stages: [
    { name: "Intake", owner: "role:attorney", tasks: [
      { title: "Gather documents", doer: "role:researcher", output: { kind: "note" }, context: ["the client sent a folder link"], checklist: [{ say: "the folder has a will and a deed", check: { field: "status != \"\"" } }] },
      { title: "Conflict check", doer: "role:researcher", output: { kind: "decision" }, depends_on: ["Gather documents"] },
    ] },
    { name: "Drafting", moves_on_when: "status == \"retained\"", tasks: [{ title: "Draft the trust", doer: "role:drafter", checker: "role:attorney", output: { kind: "draft" }, needs_yes: ["sending the draft to the client"], ask: "role:attorney" }] },
    { name: "Signing" },
  ],
});

test("a valid template has no problems; each way of getting one wrong says where and how", () => {
  assert.deepEqual(problems(estate()), []);
  const bad = (/** @type {(t: any) => void} */ f, /** @type {RegExp} */ re, /** @type {string} */ at = "") => { const t = estate(); f(t); const p = problems(t); assert.ok(p.some(x => re.test(x.message) && x.path.startsWith(at)), `${re}: ${JSON.stringify(p)}`); };
  bad(t => { t.stages = [t.stages[0]]; }, /2 to 40 stages/, "stages");
  bad(t => { t.stages[1].name = "Intake"; }, /two stages are named Intake/);
  bad(t => { t.stages[0].tasks[0].doer = "role:janitor"; }, /not one of the template's roles/, "stages[0].tasks[0].doer");
  bad(t => { t.stages[0].tasks[1].depends_on = ["Draft the trust"]; }, /EARLIER tasks/);
  bad(t => { t.stages[0].tasks[0].output = { kind: "poem" }; }, /output is/);
  bad(t => { t.stages[1].moves_on_when = "status =="; }, /condition over the project/);
  bad(t => { t.roles.push({ role: "boss", lead: true }); t.roles[0].lead = true; }, /at most one role is the project lead/);
  bad(t => { t.stages[0].tasks[0].checklist = [{ say: "x", check: { poll: {} } }]; }, /connection|Connection/i);
  bad(t => { t.stages[0].tasks[0].surprise = 1; }, /not part of a task/);
  bad(t => { t.stages[0].owner = "everyone"; }, /who may move a stage early/);
  assert.match(problems(null)[0].message, /a template is/);
});

test("the brief is written from the task's choices: goal and done-check, context, what needs a yes, who to ask; a hand-written brief is kept", () => {
  const t = estate();
  const b = briefOf(t.stages[1].tasks[0], t.stages[1], t);
  assert.match(b, /Goal: Draft the trust for \{record\.name\}\. Done when: you mark it done when your note is on the project\./);
  assert.match(b, /Needs a yes before it happens: sending the draft to the client\./);
  assert.match(b, /If you are stuck, ask role:attorney\./);
  const g = briefOf(t.stages[0].tasks[0], t.stages[0], t);
  assert.match(g, /Done when: the folder has a will and a deed\./, "the checklist is the done-check");
  assert.match(g, /the client sent a folder link/);
  assert.match(g, /Needs a yes: nothing/);
  assert.equal(briefOf({ ...t.stages[0].tasks[0], brief: "Do it my way." }, t.stages[0], t), "Do it my way.");
});

test("compile gives the stage list a project is pinned to: briefs written, 'moves on when' becomes the next stage's entry condition, the authoring helpers are gone", () => {
  const stages = compile(estate());
  assert.deepEqual(stages.map(s => s.name), ["Intake", "Drafting", "Signing"]);
  assert.equal(stages[1].enter_if, undefined);
  assert.equal(stages[2].enter_if, 'status == "retained"', "Drafting moves on when the project is retained: Signing is entered only then");
  assert.equal(stages[0].owner, "role:attorney");
  const task = /** @type {any} */ (stages[1].tasks)[0];
  assert.ok(task.brief.includes("{record.name}") && !("needs_yes" in task) && !("ask" in task) && !("context" in task));
  assert.equal(stages[2].tasks, undefined);
  const snap = JSON.parse(snapshotOf(estate(), { id: "tpl_1", version: 3 }));
  assert.deepEqual([snap.template, snap.version, snap.stages.length], ["tpl_1", 3, 3]);
  assert.ok(stagesFor, "the condition language is the one Kits use");
});
