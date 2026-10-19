import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sentenceOf, stageCards, metaParts, rowLine, waitingForYes, PAGE_TABS, ownerWords } from "./page.ts";

const body = (extra = {}) => ({
  name: "Launch", stages: [
    { name: "Brief", tasks: [{ title: "Write the brief", doer: "lead", brief: "Say what we are launching and by when. Keep it to one page.\nThen share it." }, { title: "Agree the date", doer: "role:ops", required: false }] },
    { name: "Draft", tasks: [{ title: "First design", doer: "teammate:kit", checker: "lead" }] },
    { name: "Review", tasks: [] },
  ],
  automations: [{ when: "Draft", flow: "launch_email", note: "sends the draft to the list" }, { when: "start", flow: "welcome" }],
  ...extra,
});
const people = [{ id: "per_a", name: "Alex" }], agents = [{ id: "kit", name: "Kit" }];

test("the headline is one sentence: a playbook goes through its stages, with its to-dos and Flows", () => {
  assert.equal(sentenceOf(body()), "A launch goes Brief, Draft and Review, with 3 to-dos and 2 Flows.");
  assert.equal(sentenceOf(body({ automations: [] })), "A launch goes Brief, Draft and Review, with 3 to-dos.");
  assert.equal(sentenceOf({ name: "Hiring", stages: [{ name: "Screen", tasks: [] }, { name: "Offer", tasks: [] }] }), "A hiring goes Screen and Offer.");
  assert.equal(sentenceOf({ name: "Onboarding", stages: [{ name: "Start" }] }), "An onboarding goes Start.");
  assert.equal(sentenceOf(body({ stage_mode: "none" })), "A launch is a list of 3 to-dos and 2 Flows.");
  assert.equal(sentenceOf(body(), true), "A launch goes Brief, Draft and Review.", "the list row's short form");
});

test("a stage is a card: its to-dos with doers and the first line of the brief, and the Flows that turn on there", () => {
  const cards = stageCards(body(), people, agents);
  assert.deepEqual(cards.map((c) => [c.index, c.name, c.todos.length, c.flows.length]), [[0, "Brief", 2, 1], [1, "Draft", 1, 1], [2, "Review", 0, 0]]);
  assert.deepEqual(cards[0].todos[0], { title: "Write the brief", doer: "The project lead", brief: "Say what we are launching and by when. Keep it to one page.", optional: false, approver: "", reviewer: "", late: "" });
  assert.equal(cards[0].todos[1].optional, true);
  assert.equal(cards[1].todos[0].doer, "Kit (agent)");
  assert.equal(cards[1].todos[0].approver, "The project lead", "the checker is the Approver");
  assert.deepEqual(cards[0].flows, [{ flow: "welcome", label: "welcome", when: "start", note: "" }], "start Flows turn on in the first stage");
  assert.deepEqual(cards[1].flows, [{ flow: "launch_email", label: "launch email", when: "Draft", note: "sends the draft to the list" }]);
  assert.equal(cards[2].summary, "No to-dos");
  assert.equal(cards[0].summary, "2 to-dos · 1 Flow");
});

test("the meta line has the name, the version, who made it and Live or Draft", () => {
  assert.deepEqual(metaParts({ name: "Launch", version: 3, by: "Engineer", live: true }), ["Launch", "v3", "made by Engineer", "Live"]);
  assert.deepEqual(metaParts({ name: "Launch", version: 1, by: null, live: false }), ["Launch", "v1", "Draft"]);
});

test("a list row says its sentence's shape, its counts and where it is used", () => {
  assert.equal(rowLine({ stages: 3, todos: 14, flows: 2, usedBy: "Used by Spring launch" }), "3 stages · 14 to-dos · 2 Flows · Used by Spring launch");
  assert.equal(rowLine({ stages: 1, todos: 1, flows: 0, usedBy: "Not used yet" }), "1 stage · 1 to-do · Not used yet");
});

test("the page has four tabs in order", () => {
  assert.deepEqual(PAGE_TABS, [["stages", "Stages"], ["projects", "Projects"], ["test", "Test"], ["versions", "Versions"]]);
});

test("a playbook waits for a yes when a pending card names its template, or says its version goes live", () => {
  const answer = { approvals: [{ id: "a", title: "Put Launch version 3 live", body: "A new version of the playbook", fields: { template: "tpl_launch" } }, { id: "b", title: "Send the invoice", body: "", fields: {} }, { id: "c", title: "Make the Hiring playbook live", body: "", fields: {} }] };
  assert.equal(waitingForYes(answer, "tpl_launch", "Launch"), true, "by template id");
  assert.equal(waitingForYes(answer, "tpl_hiring", "Hiring"), true, "by the words");
  assert.equal(waitingForYes(answer, "tpl_other", "Onboarding"), false);
  assert.equal(waitingForYes({ approvals: [{ id: "d", title: "Send the Launch invoice", fields: {} }] }, "tpl_launch", "Launch"), false, "a card that only mentions the name is not a playbook change");
  assert.equal(waitingForYes(null, "tpl_launch", "Launch"), false);
  assert.equal(waitingForYes({ approvals: [] }, "tpl_launch", "Launch"), false);
});

test("who made a playbook is a name a person reads, never an id or a placeholder", () => {
  const members = [{ id: "per_ana", name: "Ana Reyes" }, { id: "per_zagy5e", name: "Member zagy5e" }, { id: "per_bare", name: "per_bare" }];
  assert.equal(ownerWords("per_ana", members, "per_me"), "Ana Reyes");
  assert.equal(ownerWords("per_me", members, "per_me"), "you");
  assert.equal(ownerWords("per_zagy5e", members, "per_me"), "a teammate", "an auto name like Member zagy5e is not shown");
  assert.equal(ownerWords("per_bare", members, "per_me"), "a teammate", "a name that is only the id is not shown");
  assert.equal(ownerWords("per_unknown", members, "per_me"), "a teammate");
  assert.equal(ownerWords(null, members, "per_me"), null);
  assert.deepEqual(metaParts({ name: "Launch", version: 2, by: ownerWords("per_ana", members), live: false }), ["Launch", "v2", "made by Ana Reyes", "Draft"]);
});
