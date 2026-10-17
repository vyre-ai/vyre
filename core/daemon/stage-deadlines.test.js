import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createStageDeadlines } from "./stage-deadlines.js";

const task = (id, extra = {}) => ({ id, state: "ready", stage: "Drafting", record: "vyre://s/matter/m1", due: 1000, doer: { kind: "agent", id: "juno" }, ...extra });
function make(rows, now = 5000) {
  const withdrawn = [], logs = [];
  const clock = { t: now };
  const sd = createStageDeadlines({ gw: { ask: { list: async () => rows, withdraw: async (_c, id, o) => { withdrawn.push([id, o.reason]); } } }, chain: () => ({}), withdrawChain: () => ({}), now: () => clock.t, log: (m) => logs.push(m) });
  return { sd, withdrawn, logs, clock };
}

test("a stage task an agent holds is withdrawn once its due offset has passed, and one not yet due is waited for", async () => {
  const { sd, withdrawn } = make([task("a"), task("b", { due: 9000 })]);
  await sd.tick();
  assert.deepEqual(withdrawn.map(w => w[0]), ["a"]);
  assert.equal(sd.next(), 9000, "the timer is told when the next one falls due");
});

test("a person's task, a task with no due time, a note to a follower and a task outside a stage are left alone", async () => {
  const { sd, withdrawn } = make([task("p", { doer: { kind: "person", id: "alex" } }), task("n", { due: undefined }), task("f", { form: { fyi: true } }), task("x", { stage: undefined })]);
  await sd.tick();
  assert.deepEqual(withdrawn, []);
  assert.equal(sd.next(), null);
});

test("a task that has already ended is not an error, and any other refusal is logged and does not stop the rest", async () => {
  const rows = [task("a"), task("b")];
  const logs = [], done = [];
  const sd = createStageDeadlines({ gw: { ask: { list: async () => rows, withdraw: async (_c, id) => { if (id === "a") throw Object.assign(new Error("ended"), { code: "bad_state" }); if (id === "b") throw new Error("boom"); done.push(id); } } }, chain: () => ({}), withdrawChain: () => ({}), now: () => 5000, log: (m) => logs.push(m) });
  await sd.tick();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /task b/);
});
