// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { createMockStore, REVEAL_MS } from "./mock-store.js";
import { getStore, setStore } from "./store.js";
import { needsYou, needsReason, cardTitle } from "./tasks.js";
import { runClientPays } from "./scenario.js";

const NOON = Date.parse("2026-10-01T13:00:00");
const METHODS = ["spaces", "actors", "types", "list", "get", "create", "update", "tasks", "task", "createTask", "updateTask", "approveTask", "reassignTask", "events", "reveal", "seesAs", "subscribe"];

test("the mock store implements the whole Store interface", async () => {
  const s = createMockStore({ now: () => NOON });
  for (const m of METHODS) assert.equal(typeof /** @type {any} */ (s)[m], "function", m);
  assert.deepEqual((await s.spaces()).map(x => x.name), ["Mine", "Harlow Legal"]);
  assert.deepEqual((await s.actors()).filter(a => a.kind !== "device").map(a => a.name), ["Alex Rivera", "Chris Park", "juno", "kit", "iris", "rev", "Research", "Intake", "Drafting"]);
  const types = await s.types();
  assert.ok(["contact", "matter", "project", "trip", "template"].every(id => types.some(t => t.id === id)));
  assert.deepEqual((await s.types("mine")).every(t => t.space === "mine"), true);
  const doe = (await s.list("matter")).find(m => m.values.title === "Doe estate plan");
  assert.equal(doe?.stage, "Engagement");
  assert.equal((await s.list("contact", { space: "harlow" })).some(c => c.values.name === "Jane Doe"), true);
  assert.equal((await s.list("matter", { where: { stage: "Signing" } })).length, 1);
  assert.equal(await s.get("nope"), null);
  assert.equal(await s.task("nope"), null);
});

test("the morning world holds k1 to k28, and seven things need Alex", async () => {
  const s = createMockStore({ now: () => NOON });
  const all = await s.tasks();
  assert.equal(all.length, 28);
  assert.equal(all[0].id, "k1");
  const actors = await s.actors();
  const mine = all.filter(t => needsYou(t, "alex", actors));
  assert.deepEqual(mine.map(t => t.id), ["k4", "k6", "k9", "k10", "k13", "k22", "k28"]);
  assert.deepEqual(mine.map(t => needsReason(t, "alex", actors)), ["do", "stuck", "do", "do", "check", "do", "check"]);
  assert.equal((await s.tasks({ space: "mine" })).every(t => t.record.startsWith("p3") || t.record.startsWith("p4") || t.record.startsWith("t")), true);
  assert.equal((await s.tasks({ state: ["stuck"] })).length, 2);
  assert.equal((await s.tasks({ checker: "alex", state: ["needs_check"] })).length, 2);
  assert.equal((await s.events({ limit: 3 })).length, 3);
});

test("a sealed field is never in a read; an assistant's view never holds it; Reveal gives it for 30 seconds", async () => {
  let t = NOON;
  const s = createMockStore({ now: () => t });
  const jane = await s.get("c1");
  assert.deepEqual(jane?.values.ssn, { sealed: true });
  assert.equal(JSON.stringify(await s.list("contact")).includes("412-55-6789"), false);
  const asAssistant = await s.seesAs("c1", "assistant");
  assert.equal(JSON.stringify(asAssistant).includes("412-55-6789"), false);
  assert.deepEqual(asAssistant.ssn, { sealed: true, note: "SSN on file, sealed" });
  assert.equal(asAssistant.name, "Jane Doe");
  assert.deepEqual((await s.seesAs("c1", "person")).ssn, { sealed: true });
  await assert.rejects(() => s.reveal("c1", "ssn", { method: "pin" }), /Face ID/);
  await assert.rejects(() => s.reveal("c1", "name", { method: "face_id" }), /not sealed/);
  const r = await s.reveal("c1", "ssn", { method: "face_id" });
  assert.equal(r.value, "412-55-6789");
  assert.equal(r.until - t, REVEAL_MS);
  assert.equal(REVEAL_MS, 30_000);
  assert.ok((await s.events({ record: "c1" })).some(e => /revealed SSN/.test(e.what)));
  await assert.rejects(() => s.update("c1", { ssn: "000" }, "juno"), /sealed/);
  await s.update("c1", { ssn: "412-55-0000" }, "alex");
  assert.equal((await s.reveal("c1", "ssn", { method: "touch_id" })).value, "412-55-0000");
});

test("subscribe calls back after any change and stops when told to", async () => {
  const s = createMockStore({ now: () => NOON });
  let n = 0;
  const off = s.subscribe(() => { n++; });
  await s.update("c1", { notes: "x" });
  assert.equal(n, 1);
  await s.reassignTask("k6", "chris");
  assert.equal(n, 2);
  off();
  await s.update("c1", { notes: "y" });
  assert.equal(n, 2);
});

test("a stuck task is reassigned and starts again; only people and assistants take tasks", async () => {
  const s = createMockStore({ now: () => NOON });
  const k = await s.reassignTask("k6", "chris");
  assert.deepEqual([k.doer, k.state, k.stuck], ["chris", "ready", null]);
  await assert.rejects(() => s.reassignTask("k6", "vyre"), /not someone/);
  await assert.rejects(() => s.reassignTask("k1", "chris"), /finished/);
});

test("an assistant cannot mark a task done without its output, and cannot touch someone else's task", async () => {
  const s = createMockStore({ world: "payday", now: () => NOON });
  await runClientPays(s, {});
  const tasks = await s.tasks({ record: (await s.list("matter")).find(m => m.values.title === "Doe estate plan")?.id });
  const research = tasks.find(t => t.doer === "research");
  assert.equal(research?.state, "done");
  const s2 = createMockStore({ world: "empty", now: () => NOON });
  const m = await s2.create("matter", { title: "Doe estate plan", client: "c1" }, { by: "vyre" });
  const r = (await s2.tasks({ record: m.id })).find(t => t.doer === "research");
  assert.ok(r);
  await assert.rejects(() => s2.updateTask(r.id, { state: "done" }, "research"), /empty/);
  await assert.rejects(() => s2.updateTask(r.id, { state: "done" }, "juno"), /Only the doer/);
});

test("approving a task records an event and sends nothing", async () => {
  const s = createMockStore({ now: () => NOON });
  const before = (await s.events({})).length;
  const k = await s.approveTask("k13", { method: "face_id" });
  assert.equal(k.state, "done");
  assert.equal(k.result?.sent?.method, "face_id");
  const ev = await s.events({ task: "k13" });
  assert.equal(ev.length, 1);
  assert.match(ev[0].what, /approved and sent Email to Dana Reyes/);
  assert.match(String(ev[0].why), /Face ID/);
  assert.equal((await s.events({})).length, before + 1);
  await assert.rejects(() => s.approveTask("k13", { method: "face_id" }), /Nothing is waiting/);
  await assert.rejects(() => s.approveTask("k13", /** @type {any} */ ({ method: "none" })), /Nothing is waiting|Face ID/);
  await assert.rejects(() => s.approveTask("k4", { method: "face_id" }), /Nothing is waiting/);
});

test("createTask puts a task on a record, waiting on what it depends on", async () => {
  const s = createMockStore({ now: () => NOON });
  const t = await s.createTask({ title: "Call Jane", record: "m1", doer: "alex", output: { kind: "decision" }, dependsOn: ["k3"] });
  assert.equal(t.state, "waiting");
  const free = await s.createTask({ title: "Ring Chris", record: "m1", doer: "juno", output: { kind: "note" } });
  assert.equal(free.state, "working");
  await assert.rejects(() => s.createTask({ title: "x", record: "zz", doer: "alex", output: { kind: "file" } }), /does not exist/);
});

test("getStore is the one switch, and setStore replaces it", async () => {
  setStore(null);
  const a = getStore();
  assert.equal(getStore(), a);
  const mine = createMockStore({ world: "empty" });
  setStore(mine);
  assert.equal(getStore(), mine);
  setStore(null);
  assert.notEqual(getStore(), mine);
  setStore(null);
});

test("client pays: Now's Needs-you holds exactly one card, and approving it moves the stage on by itself", async () => {
  const s = createMockStore({ world: "empty", now: () => NOON });
  const steps = /** @type {number[]} */ ([]);
  const ran = await runClientPays(s, { onStep: n => steps.push(n) });
  assert.deepEqual(steps, [1, 2, 3, 4]);

  const actors = await s.actors();
  const matter = await s.get(ran.matter);
  assert.equal(matter?.values.title, "Doe estate plan");
  assert.equal(matter?.stage, "Intake");
  // Created from the Kit, with its team's tasks, and Research's findings written onto the record, with sources.
  assert.deepEqual((await s.tasks({ record: ran.matter })).map(t => [t.doer, t.state]), [["research", "done"], ["intake", "needs_check"]]);
  assert.match(String(matter?.values.research), /Sources: Intake form, 8 Sep, County property record/);
  assert.ok(matter?.values.situation && matter?.values.assets && matter?.values.pressure);
  const research = (await s.tasks({ record: ran.matter }))[0];
  assert.equal(research.result?.note?.sources.length, 3);

  // Now: one card for the person.
  const cards = (await s.tasks()).filter(t => needsYou(t, "alex", actors));
  assert.equal(cards.length, 1);
  const [card] = cards;
  assert.equal(cardTitle(card, needsReason(card, "alex", actors), actors), "Welcome email for Jane Doe is ready");
  assert.equal(card.state, "needs_check");
  assert.equal(card.doer, "intake");
  assert.equal(card.checker, "alex");
  assert.match(String(card.result?.draft?.body), /^Hi Jane,/);
  assert.match(String(card.result?.draft?.body), /Your matter is Doe estate plan, and Alex Rivera is your attorney/);

  // One tap: the checker's approval is the Gate approval. The stage moves on by itself.
  await s.approveTask(card.id, { method: "face_id" });
  assert.equal((await s.get(ran.matter))?.stage, "Engagement");
  const after = await s.tasks({ record: ran.matter });
  assert.deepEqual(after.map(t => [t.title, t.state]), [["Research the client", "done"], ["Welcome email for Jane Doe", "done"], ["Engagement letter", "working"], ["Review the draft with Jane Doe", "waiting"]]);
  assert.equal((await s.tasks()).filter(t => needsYou(t, "alex", actors)).length, 0, "nothing needs Alex until the engagement letter is drafted");
  assert.ok((await s.events({ record: ran.matter })).some(e => /moved Doe estate plan to Engagement by itself/.test(e.what)));
});

test("client pays: it runs on a world that already holds other work, next to it", async () => {
  const s = createMockStore({ world: "payday", now: () => NOON });
  const actors = await s.actors();
  const before = (await s.tasks()).filter(t => needsYou(t, "alex", actors)).length;
  await runClientPays(s, {});
  assert.equal((await s.tasks()).filter(t => needsYou(t, "alex", actors)).length, before + 1);
  assert.equal((await s.list("contact")).filter(c => c.values.name === "Jane Doe").length, 1, "the existing contact is reused");
});
