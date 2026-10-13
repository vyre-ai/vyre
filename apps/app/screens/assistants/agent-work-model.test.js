// @ts-check
// An agent's Work list: which threads, which group, which state, in what order.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const NOW = 1_760_000_000_000;
const rows = [
  { id: "t1", agent: "intake", name: "intake", purpose: "agent", status: "idle", asks: 0, last: NOW - 3_600_000 },
  { id: "t2", agent: "intake", name: "intake", purpose: "job", status: "working", asks: 0, last: NOW - 60_000 },
  { id: "t3", agent: "intake", name: "Draft the reply", purpose: "chat", status: "waiting", asks: 1, last: NOW - 120_000 },
  { id: "t4", agent: "intake", name: "intake", purpose: "job", status: "stopped", stopped_reason: "exited 1", last: NOW - 9_000_000 },
  { id: "t5", agent: "refunds", name: "refunds", purpose: "job", status: "idle", last: NOW },
  { id: "t6", agent: "intake", purpose: "helper", status: "idle", archived: 1, last: NOW },
  null,
];

test("only this agent's threads, newest first, archived left out", { skip: !strip }, async () => {
  const m = await import("./agent-work-model.ts");
  assert.deepEqual(m.workRows(rows, "intake", NOW).map((r) => r.id), ["t2", "t3", "t1", "t4"]);
  assert.deepEqual(m.workRows("nope", "intake", NOW), []);
});

test("a job's purpose makes it a Job; anything else is from a person", { skip: !strip }, async () => {
  const m = await import("./agent-work-model.ts");
  const w = m.workRows(rows, "intake", NOW);
  assert.deepEqual(w.map((r) => [r.id, r.kind]), [["t2", "job"], ["t3", "people"], ["t1", "people"], ["t4", "job"]]);
  assert.deepEqual(m.filterWork(w, "jobs").map((r) => r.id), ["t2", "t4"]);
  assert.deepEqual(m.filterWork(w, "people").map((r) => r.id), ["t3", "t1"]);
  assert.equal(m.filterWork(w, "all").length, 4);
});

test("state: an open ask is waiting on you, a crash is failed, a live turn is running", { skip: !strip }, async () => {
  const m = await import("./agent-work-model.ts");
  const by = Object.fromEntries(m.workRows(rows, "intake", NOW).map((r) => [r.id, r]));
  assert.equal(by.t3.state, "waiting");
  assert.equal(by.t3.needsYou, true);
  assert.equal(by.t4.state, "failed");
  assert.equal(by.t2.state, "running");
  assert.equal(by.t1.state, "done");
  assert.equal(by.t3.title, "Draft the reply");
  assert.equal(by.t2.title, "Job");
  assert.match(by.t2.sub, /Started by a job · Running · 1 min ago/);
});

test("an empty filter says what to do next", { skip: !strip }, async () => {
  const m = await import("./agent-work-model.ts");
  assert.match(m.emptyWork("rex", "jobs"), /scheduled task/);
  assert.match(m.emptyWork("rex", "people"), /Talk to rex/);
});
