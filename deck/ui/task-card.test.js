// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { createMockStore } from "./mock-store.js";
import { runClientPays } from "./scenario.js";
import { cardModel } from "./card-model.js";

const NOW = Date.parse("2026-10-01T13:00:00");
/** @param {any} store */
async function models(store) {
  const [tasks, actors] = await Promise.all([store.tasks(), store.actors()]);
  /** @type {any[]} */
  const out = [];
  for (const task of tasks) {
    const record = await store.get(task.record);
    const tpl = task.template ? await store.get(task.template) : null;
    const m = cardModel({ task, record, recordTitle: record?.values.title || "", actors, me: "alex", templateName: tpl?.values.name });
    if (m.reason) out.push({ task, m });
  }
  return out;
}

test("the Welcome card names what it used and offers Send with Face ID and Edit", async () => {
  const s = createMockStore({ world: "empty", now: () => NOW });
  await runClientPays(s);
  const cards = await models(s);
  assert.equal(cards.length, 1);
  const { m } = cards[0];
  assert.equal(m.title, "Welcome email for Jane Doe is ready");
  assert.equal(m.why, "Intake drafted it from Welcome, using Research's notes.");
  assert.deepEqual(m.actions.map((/** @type {any} */ a) => a.label), ["Send with Face ID", "Edit"]);
  assert.equal(m.lead, "intake");
  assert.ok(m.tags.some((/** @type {any} */ t) => t.text === "Doe estate plan"));
});

test("a stuck card says why and offers Fix and Reassign", async () => {
  const cards = await models(createMockStore({ now: () => NOW }));
  const stuck = cards.find(c => c.task.id === "k6").m;
  assert.equal(stuck.title, "juno could not log in to the court portal");
  assert.equal(stuck.why, "The password changed. Update the password in the Vault, or reassign to Chris.");
  assert.deepEqual(stuck.actions.map((/** @type {any} */ a) => a.label), ["Fix", "Reassign"]);
  assert.ok(stuck.tags.some((/** @type {any} */ t) => t.text === "Stuck"));
  const todo = cards.find(c => c.task.id === "k4").m;
  assert.equal(todo.why, "Chris Park assigned this to you. Due with Engagement.");
  assert.deepEqual(todo.actions.map((/** @type {any} */ a) => a.label), ["Mark done", "Open"]);
});
