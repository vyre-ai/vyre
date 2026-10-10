import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowLine, treeOf, roleLines, bodyText, parseBody, plural, stateWord, whoWords, startName, projectIdOf, startWords } from "./model.ts";

const body = () => ({ name: "Estate plan", roles: [{ role: "researcher", agent: "research", lead: true }, { role: "attorney" }], stages: [
  { name: "Intake", owner: "role:attorney", moves_on_when: 'status == "retained"', tasks: [{ title: "Gather documents", doer: "role:researcher", output: { kind: "note" } }, { title: "Conflict check", doer: "role:researcher", checker: "role:attorney", output: { kind: "decision" }, required: false }] },
  { name: "Drafting", tasks: [{ title: "Draft the trust", doer: "role:researcher", output: { kind: "draft" } }] },
  { name: "Signing" },
] });

test("a template's list line says how many versions and which is live", () => {
  assert.equal(rowLine({ template: "t", name: "T", live: 2, latest: 3, versions: 3, owner: null, tags: [] }), "3 versions, version 2 is live");
  assert.equal(rowLine({ template: "t", name: "T", live: null, latest: 1, versions: 1, owner: null, tags: [] }), "1 version, none live (version 1 is the newest)");
  assert.equal(plural(0, "task"), "0 tasks");
  assert.equal(stateWord("live"), "Live");
});

test("the tree shows each stage with who may move it and what it waits for, each task with its doer, and says so when a stage has no tasks", () => {
  const t = treeOf(body());
  assert.deepEqual(t.filter((l) => l.depth === 0).map((l) => l.text), ["1. Intake", "2. Drafting", "3. Signing"]);
  assert.equal(t[0].note, "The attorney may move it early");
  assert.equal(t.find((l) => l.text === "2. Drafting")?.note, 'entered when status == "retained"');
  assert.equal(t.find((l) => l.text === "Conflict check")?.note, "The researcher, checked by the attorney, optional");
  assert.equal(t[t.length - 1].text, "The last stage: the project ends here.");
  assert.deepEqual(roleLines(body()), ["researcher is research (the project lead)", "attorney is a person with that role"]);
});

test("the editor round-trips the body, refuses what is not JSON in plain words", () => {
  const r = parseBody(bodyText(body()));
  assert.equal(r.ok && r.body.stages.length, 3);
  const bad = parseBody("{ not json");
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.why : "", /not valid JSON/);
  assert.equal(parseBody("[1]").ok, false);
});

test("who does a task is said as a person says it: the attorney, Research, a person, never role:attorney", () => {
  assert.equal(whoWords("role:attorney"), "the attorney");
  assert.equal(whoWords("teammate:research"), "Research");
  assert.equal(whoWords("person:per_abc"), "a person");
  assert.equal(whoWords("pool:drafters"), "anyone in drafters");
  assert.equal(whoWords("something else"), "something else", "a form it does not know is shown as it came");
});

test("a project is started under a name, and the page opens by the id the box answers with", () => {
  assert.deepEqual(startName("  Rivera   Family Trust "), { ok: true, name: "Rivera Family Trust" });
  assert.equal(startName("   ").ok, false);
  assert.match(startName("x".repeat(121)).why, /at most 120/);
  assert.equal(projectIdOf("vyre://spc_aaaaaaaaaaaa/project/11111111-1111-4111-8111-111111111111"), "11111111-1111-4111-8111-111111111111");
});

test("starting a project says where the tasks are, or which could not be made and why", () => {
  assert.equal(startWords("Rivera", { tasks_made: 2 }), "Rivera is started. Its first tasks are in Now.");
  assert.equal(startWords("Rivera", { tasks_made: 0, tasks_skipped: [{ task: "Gather", why: "research is not in this space yet" }, { task: "Check", why: "research is not in this space yet" }] }),
    "Rivera is started, but 2 of its first tasks could not be made: research is not in this space yet. Add the assistant in Settings, Assistants, and start again.");
  assert.match(startWords("Rivera", { tasks_made: 1, tasks_skipped: [{ task: "Check", why: "drafting is not in this space yet" }] }), /1 of its first tasks could not be made: drafting is not in this space yet\. The others are in Now\./);
});
