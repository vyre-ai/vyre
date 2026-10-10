import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createMockStore } from "../../src/store-core/mock-store.js";
import { runClientPays } from "../../src/store-core/scenario.js";
import { isRawId, plainLine, cardModel, cardFor, nowModel, stageGroups, teamOf, liveLine, createdLine, draftOf, briefOf, taskFacts, progressText, stateWord, whenLabel } from "./model.js";
import { loadWorld } from "./world.js";

const NOW = Date.parse("2026-10-01T13:00:00");

test("client pays: the Welcome card names what it used and offers Send with Face ID and Edit", async () => {
  const LATER = NOW + 3_600_000;
  const s = createMockStore({ world: "payday", now: () => LATER });
  const steps = [];
  await runClientPays(s, { onStep: (n, what) => steps.push([n, what]) });
  assert.deepEqual(steps.map(([n]) => n), [1, 2, 3, 4]);
  const w = await loadWorld(s, () => LATER);
  const need = nowModel(w).needs.filter((t) => t.title === "Welcome email for Jane Doe");
  assert.equal(need.length, 1);
  assert.equal(nowModel(w).needs.length, 7);
  assert.equal(nowModel(w).needs[0].title, "Welcome email for Jane Doe", "the newest card is first");
  const m = cardFor(w, need[0]);
  assert.equal(m.title, "Welcome email for Jane Doe is ready");
  assert.equal(m.why, "Intake drafted it from Welcome, using Research's notes.");
  assert.deepEqual(m.actions.map((a) => a.label), ["Send with Face ID", "Edit"]);
  assert.equal(m.lead, "intake");
  assert.ok(m.tags.some((t) => t.text === "Doe estate plan"));
  const d = draftOf(w, need[0]);
  assert.match(d.body, /trust funded before the house sale/);
  assert.match(d.subject, /Welcome to Juniper Studio, Jane/);
});

test("approving the Welcome email through the Gate sends it and moves the stage on by itself", async () => {
  const s = createMockStore({ world: "payday", now: () => NOW });
  const r = await runClientPays(s);
  const before = await s.get(r.matter);
  assert.equal(before.data.stage, "Intake");
  await s.decide(r.task, { outcome: "approved", proof: { signer: "secure_enclave", key_id: "k", payload_hash: "h", decision: "approve", chain_hash: "c", issued_at: NOW, expires_at: NOW + 1, nonce: "n", signature: "s" } });
  const after = await s.get(r.matter);
  assert.equal(after.data.stage, "Engagement");
});

test("the morning world: a stuck card says why and offers Fix and Reassign; a task assigned by a colleague says so", async () => {
  const s = createMockStore({ now: () => NOW });
  const w = await loadWorld(s, () => NOW);
  const now = nowModel(w);
  const stuck = now.needs.find((t) => t.state === "stuck");
  const m = cardFor(w, stuck);
  assert.equal(m.title, "juno could not log in to the court portal");
  assert.equal(m.why, "The password changed. Update the password in the Vault, or reassign to Chris.");
  assert.deepEqual(m.actions.map((a) => a.label), ["Fix", "Reassign"]);
  assert.ok(m.tags.some((t) => t.text === "Stuck"));
  const todo = now.needs.find((t) => t.title === "Review the draft with Jane Doe");
  const t = cardFor(w, todo);
  assert.equal(t.why, "Chris Park assigned this to you. Due with Engagement.");
  assert.deepEqual(t.actions.map((a) => a.label), ["Mark done", "Open"]);
  assert.equal(now.needs.length, 7);
  assert.match(now.meta, /7 things need you/);
});

test("a to-do with no stage and no record says it is waiting for you, never \"Due with .\"", async () => {
  const s = createMockStore({ now: () => NOW });
  const w = await loadWorld(s, () => NOW);
  const now = nowModel(w);
  const todo = now.needs.find((t) => t.title === "Review the draft with Jane Doe");
  const bare = { ...todo, stage: undefined, record: undefined };
  const m = cardFor(w, bare);
  assert.ok(!/Due with \./.test(m.why), m.why);
  assert.ok(/waiting for you/.test(m.why) || /Due with \w/.test(m.why), m.why);
});

test("one field to fill is an inline input with the field's own label", async () => {
  const w = await loadWorld(createMockStore({ now: () => NOW }), () => NOW);
  const t = nowModel(w).needs.find((x) => x.title === "Signing date");
  const m = cardFor(w, t);
  assert.deepEqual(m.inline, { name: "signing", label: "Signing date", kind: "date" });
  assert.deepEqual(m.actions.map((a) => a.label), ["Save"]);
});

test("scope narrows Now to a space; calendar and doing-now come from the store", async () => {
  const w = await loadWorld(createMockStore({ now: () => NOW }), () => NOW);
  const mine = nowModel(w, w.spaces.find((s) => s.kind === "mine").id);
  assert.ok(mine.needs.every((t) => t.space === w.spaces.find((s) => s.kind === "mine").id));
  const all = nowModel(w);
  assert.equal(all.calendar.length, 3);
  assert.ok(all.working.length >= 5);
  assert.ok(all.doneToday.length >= 1);
  assert.equal(whenLabel(all.calendar[0].at, NOW), "10:00 am");
});

test("the project page: stages made of tasks, the team with its doing-now line, the live line, the created line", async () => {
  const s = createMockStore({ now: () => NOW });
  const w = await loadWorld(s, () => NOW);
  const rec = [...w.records.values()].find((r) => r.data.title === "Doe estate plan");
  const tasks = w.tasks.filter((t) => t.record === rec.urn);
  const stages = w.types.get("matter").stages.map((x) => x.name);
  const groups = stageGroups(tasks, stages, rec.data.stage);
  assert.deepEqual(groups.map((g) => g.label), ["Intake", "Engagement"]);
  assert.equal(groups[0].complete, true);
  assert.equal(groups[1].current, true);
  assert.equal(`${groups[1].done} of ${groups[1].total}`, "0 of 2");
  const team = teamOf({ tasks, actors: w.actors, owner: rec.data.owner.actor.id });
  assert.deepEqual(team.map((t) => t.doing), ["Owner", "Research wrote 3 fields and a note with 3 sources", "Intake sent the Welcome email", "Drafting is drafting the engagement letter"]);
  assert.equal(liveLine(tasks, w.actors), "Drafting is drafting the engagement letter");
  const events = await s.events({ record: rec.urn });
  assert.equal(createdLine(events, w.actors, NOW), "Created by Vyre from the Kit Estate planning matter, 9:00 am. Flow On payment: Jane Doe paid $1,500.");
  assert.equal(progressText(tasks), "2 of 4 tasks");
  assert.equal(stateWord(tasks.find((t) => t.state === "ready"), w.me), "Ready");
});

test("task facts: doer, checker, output, how, inputs", async () => {
  const w = await loadWorld(createMockStore({ now: () => NOW }), () => NOW);
  const t = w.tasks.find((x) => x.title === "Welcome email for Jane Doe");
  const f = taskFacts(w, t, { titles: new Map(w.tasks.map((x) => [x.id, x.title])) });
  assert.equal(f.doer.id, "intake");
  assert.equal(f.checker.meta, "Their approval sends it");
  assert.equal(f.output.label, "A sent item");
  assert.equal(f.how, "Assistant tailors the template");
  assert.deepEqual(f.inputs.slice(0, 2), ["Research notes on Doe estate plan", "Template: Welcome"]);
});

test("Now never greets a raw id, and Recent is plain sentences with kernel housekeeping left out", () => {
  const id = "per_pbiglgp6ji6jzrnbskpuzw77np";
  const w = { me: id, actors: [{ id, name: id, family: "person" }], spaces: [{ id: "spc_1", name: "Home" }], types: new Map(), tasks: [], events: [], calendar: [], records: new Map(), now: NOW };
  assert.equal(isRawId(id), true);
  assert.equal(isRawId("Devbox"), false);
  assert.equal(nowModel(w).greeting, "Good afternoon");
  assert.equal(nowModel({ ...w, actors: [{ id, name: "Devbox", family: "person" }] }).greeting, "Good afternoon, Devbox");
  assert.deepEqual(plainLine(w, { what: "owner.changed", actor: "Vyre", record: "vyre://spc_1/space/x" }), { what: "became the owner of Home", actor: "You", record: "vyre://spc_1/space/x" });
  assert.equal(plainLine(w, { what: "member.set", actor: "Vyre" }), null);
  // the Flows system's own bookkeeping records have hyphenated names: they are not a person's news either
  for (const what of ["def-flow.created", "flow-approval.created", "flow-state.updated", "flow-run.created", "flow-schedule.updated"]) assert.equal(plainLine(w, { what, actor: "Vyre" }), null, what);
  assert.equal(plainLine(w, { what: "grant.created", actor: "Vyre" }), null);
  assert.deepEqual(plainLine(w, { what: "sent the Welcome email", actor: "Intake" }), { what: "sent the Welcome email", actor: "Intake" });
});

test("a task's brief is shown as what to do; a tag line is not a brief", () => {
  assert.equal(briefOf({ note: "Goal: Gather documents for Rivera.\n\nBefore this counts as done:\n- the folder has the will" }), "Goal: Gather documents for Rivera.\n\nBefore this counts as done:\n- the folder has the will");
  assert.equal(briefOf({ ext: { note: "  Check the fee.  " } }), "Check the fee.");
  assert.equal(briefOf({ note: "Flow: On payment", ext: { note: "is working on it" } }), "", "tags are not briefs");
  assert.equal(briefOf({}), "");
  assert.equal(briefOf(null), "");
});

test("a to-do a Flow gave you says a Flow is waiting; one with no maker and no stage just waits", () => {
  const base = { id: "t1", title: "Look it over", state: "ready", doer: { kind: "person", id: "per_me" }, output: { kind: "decision" }, assigned_by: { kind: "person", id: "per_me" } };
  const actors = [{ id: "per_me", name: "Me", family: "person" }];
  const card = (task) => cardModel({ task, actors, me: "per_me", recordTitle: "" });
  assert.equal(card({ ...base, source: "flow_step" }).why, "A Flow is waiting for you.");
  assert.equal(card({ ...base, source: "manual" }).why, "It is waiting for you.");
  assert.equal(card({ ...base, source: "flow_step", stage: "Intake" }).why, "Due with Intake.");
});
