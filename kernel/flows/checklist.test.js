// @ts-check
// s2: task briefs and checklists, checked by the stage gate.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, settle, ALEX } from "./testing/world.js";
import { stagedCatalog } from "./testing/fixtures.js";
import { checkTaskExtras, renderBrief, evalChecklist } from "./checklist.js";
import { checkKit } from "./kits.js";

const sys = (/** @type {any} */ w) => w.kernel.sysChain();
const stageOf = async (/** @type {any} */ w, /** @type {any} */ r) => (await w.kernel.records.get(sys(w), "matter", r.id)).data.stage;
const finish = async (/** @type {any} */ w, /** @type {string} */ title) => { const t = (await w.kernel.allTasks()).find((/** @type {any} */ x) => x.title === title); await w.kernel.completeTask(t.id); await settle(w); };
const gate = async (/** @type {any} */ w) => (await w.runner.listRuns({})).find((/** @type {any} */ r) => r.gate);

/** An Intake stage whose one task carries a brief and a checklist. */
function withChecklist(/** @type {any[]} */ checklist, extra = {}) {
  const c = stagedCatalog();
  c.types.matter = { ...c.types.matter, stages: c.types.matter.stages.map((/** @type {any} */ s) => s.name === "Intake" ? { ...s, tasks: [{ title: "Welcome call", doer: "role:attorney", output: { kind: "note" }, brief: "Call {record.client} and book the intake.", checklist, ...extra }] } : s) };
  return c;
}

test("s2: checkTaskExtras names the place and the fix", () => {
  const env = { fields: ["client", "practice_area"], connections: ["orbit-crm"] };
  assert.deepEqual(checkTaskExtras({ brief: "Hi {record.client}", credentials: ["orbit-crm"], checklist: [{ say: "Area set", check: { field: "practice_area != null" } }, { say: "Seen", check: { answer: { event: "web.intake" } } }, { say: "Paid", check: { status: { connection: "orbit-crm", operation: "customers.list", expect: "response.body.count > 0" } } }, { say: "Signed", check: { poll: { connection: "orbit-crm", operation: "customers.list", until: "response.ok", every_ms: 60000, max: 3 } } }] }, "t", env), []);
  const bad = checkTaskExtras({ brief: "Hi {record.clent}", credentials: ["orbit"], checklist: [{ say: "x", check: { field: "nothing > 1" } }, { say: "y", check: { poll: { connection: "orbit-crm", operation: "o", until: "response.ok", every_ms: 10, max: 99 } } }, { say: "z", check: { field: "client", answer: {} } }] }, "t", env).map(p => p.message);
  assert.ok(bad.some(m => /did you mean client\?/.test(m)), bad.join("|"));
  assert.ok(bad.some(m => /no Connection orbit; did you mean orbit-crm\?/.test(m)));
  assert.ok(bad.some(m => /nothing is not available/.test(m)));
  assert.ok(bad.some(m => /every_ms is at least 60000/.test(m)));
  assert.ok(bad.some(m => /max is 1 to 20/.test(m)));
  assert.ok(bad.some(m => /exactly one of/.test(m)));
});

test("s2: a Kit with a bad checklist is refused at install with the same words", () => {
  const cat = { space: "s", types: {}, actions: {}, connectors: {} };
  const kit = { format: 1, id: "k", version: 1, name: "K", includes: { types: [{ name: "matter", fields: [{ name: "client", kind: "text" }], stages: [{ name: "Intake", tasks: [{ title: "T", doer: "role:x", output: { kind: "note" }, checklist: [{ say: "x", check: { field: "client2 == 1" } }] }] }] }] } };
  const r = checkKit(kit, /** @type {any} */ (cat));
  assert.equal(r.ok, false);
  assert.match(r.errors[0].path, /type matter stage Intake task "T"\.checklist\[0\]/);
});

test("s2: the brief is filled from the record into the task, with what must hold and the Connections it may use", async () => {
  const w = await world({ kernel: "real", cat: withChecklist([{ say: "Practice area is set", check: { field: "practice_area != null" } }], { credentials: [] }) });
  await w.kernel.records.create(sys(w), "matter", { client: "Jane", stage: "Intake" }); await settle(w);
  const t = (await w.kernel.allTasks()).find((/** @type {any} */ x) => x.title === "Welcome call");
  assert.match(t.note, /^Call Jane and book the intake\.\n\nBefore this counts as done:\n- Practice area is set$/);
  assert.equal(renderBrief("{record.nope}x", {}), "x");
});

test("s2: a task the doer calls done does not count until its checklist holds, and the gate says what is missing", async () => {
  const w = await world({ kernel: "real", cat: withChecklist([{ say: "Practice area is set", check: { field: "practice_area != null" } }]) });
  const r = await w.kernel.records.create(sys(w), "matter", { client: "Jane", stage: "Intake" }); await settle(w);
  await finish(w, "Welcome call");
  assert.equal(await stageOf(w, r), "Intake", "the doer said done, the record is not ready");
  let g = await gate(w);
  assert.equal(g.steps["task:Welcome call"].status, "waiting");
  assert.deepEqual(g.steps["task:Welcome call"].output.checklist, [{ say: "Practice area is set", ok: false }]);
  assert.ok(w.stageEvents.some((/** @type {any} */ e) => e.type === "stage.checklist-failed" && e.data.missing[0] === "Practice area is set"));
  const cur = await w.kernel.records.get(sys(w), "matter", r.id);
  await w.kernel.records.update(sys(w), "matter", r.id, { practice_area: "Estate" }, cur.version);
  await w.stages.tick(); await settle(w);
  assert.equal(await stageOf(w, r), "Engagement", "once it holds, the gate moves on");
  g = (await w.runner.listRuns({})).find((/** @type {any} */ x) => x.gate && x.gate.stage === "Intake");
  assert.equal(g.steps["task:Welcome call"].status, "done");
});

test("s2: an answer that arrives after the task began satisfies an answer check, and one before it does not", async () => {
  const items = [{ say: "Form answered", check: { answer: { event: "web.intake" } } }];
  const base = { data: {}, since: 1000, now: 5000 };
  assert.equal((await evalChecklist(items, { ...base, seen: [{ type: "web.intake", at: 500 }] })).ok, false);
  const ok = await evalChecklist(items, { ...base, seen: [{ type: "web.intake", at: 2000 }] });
  assert.equal(ok.ok, true);
  assert.equal((await evalChecklist(items, { ...base, seen: [], memo: ok.memo })).ok, true, "an answer that arrived stays arrived");
  assert.equal((await evalChecklist([{ say: "x", check: { answer: { event: "web.intake", within_ms: 500 } } }], { ...base, seen: [{ type: "web.intake", at: 2000 }] })).ok, false, "too late");
});

test("s2: a status check reads through the Connection; a poll is bounded and spaced", async () => {
  let reads = 0, count = 0;
  const read = async () => { reads++; return { status: 200, ok: true, body: JSON.stringify({ count }) }; };
  const status = [{ say: "CRM has the client", check: { status: { connection: "c", operation: "o", expect: "response.body.count > 0" } } }];
  assert.equal((await evalChecklist(status, { data: {}, since: 0, now: 1, seen: [], read })).ok, false);
  count = 1;
  assert.equal((await evalChecklist(status, { data: {}, since: 0, now: 2, seen: [], read })).ok, true);
  const poll = [{ say: "Cleared", check: { poll: { connection: "c", operation: "o", until: "response.body.count > 5", every_ms: 60_000, max: 2 } } }];
  reads = 0;
  let r = await evalChecklist(poll, { data: {}, since: 0, now: 1000, seen: [], read });
  assert.equal(reads, 1); assert.equal(r.results[0].ok, false); assert.equal(r.due, 61_000);
  r = await evalChecklist(poll, { data: {}, since: 0, now: 30_000, seen: [], read, memo: r.memo });
  assert.equal(reads, 1, "too soon to look again");
  r = await evalChecklist(poll, { data: {}, since: 0, now: 70_000, seen: [], read, memo: r.memo });
  assert.equal(reads, 2);
  r = await evalChecklist(poll, { data: {}, since: 0, now: 200_000, seen: [], read, memo: r.memo });
  assert.equal(reads, 2, "it gave up after max tries");
  assert.match(r.results[0].why || "", /gave up after 2 tries/);
  assert.equal((await evalChecklist(status, { data: {}, since: 0, now: 1, seen: [] })).results[0].ok, false, "no way to read: fail closed");
});
