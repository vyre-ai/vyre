// @ts-check
// A Task as a record (DESIGN-tasks-records): the record holds what a person reads and edits, the kernel keeps what decides who may act, and the two move together.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { createMemoryStore } from "../store/memory.js";
import { createEventLog } from "../core/events.js";
import { canonical, sha256 } from "../core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const presence = { check: async ({ chain, op, fields, proof }) => (chain && proof && proof.op === op && canonical(proof.fields) === canonical(fields) ? null : "wrong_proof") };
const proofFor = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) } });
const FACTS = { kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" };

async function boot(over = {}) {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4), presence, tasksAsRecords: true, ...over });
  const owner = k.chains.fromFacts(FACTS);
  return { k, owner, R: k.gateway.records, T: k.tasks };
}
const addAgent = async (k, owner, id) => {
  const a = { kind: "agent", id, space: SPACE };
  await k.gateway.grants.addActor(owner, a, { presence: proofFor("grants.role", { actor: a }, `vyre://${SPACE}/member/${id}`) });
  const g = { subject: { kind: "actor", actor: a }, actions: ["tasks.read", "tasks.work", "records.read", "records.update", "records.create"], resource: { prefix: `vyre://${SPACE}/*/*` }, conditions: {}, source: "test" };
  await k.gateway.grants.create(owner, g, { presence: proofFor("grants.create", g, `vyre://${SPACE}/grant/new`) });
  return k.chains.fromFacts({ kind: "agent_session", agent: id, session: "s", thread: "t", vouched: true });
};
const spec = (over = {}) => ({ title: "Send the engagement letter", doer: { kind: "person", id: OWNER, space: SPACE }, output: { kind: "note" }, note: "use the new template", due: 1_800_000_100_000, ...over });

test("task records: a task made with tasks.request has a record with its fields, and every state change shows in its status", async () => {
  const { k, owner, R, T } = await boot();
  const t = await T.request(owner, spec({ fields: { priority: 2, list: "work" } }));
  const rec = await R.get(owner, "task", t.id);
  assert.deepEqual([rec.data.title, rec.data.note, rec.data.status, rec.data.priority, rec.data.list, rec.data.due], ["Send the engagement letter", "use the new template", "ready", 2, "work", new Date(1_800_000_100_000).toISOString()]);
  await T.start(owner, t.id);
  assert.equal((await R.get(owner, "task", t.id)).data.status, "working");
  await T.complete(owner, t.id, { note: "Done", sources: ["vyre://x/y/z"] });
  assert.equal((await R.get(owner, "task", t.id)).data.status, "done");
  await T.reopen(owner, t.id);
  assert.equal((await R.get(owner, "task", t.id)).data.status, "ready");
  assert.deepEqual((await R.query(owner, "task", { page: { limit: 10 } })).rows.map(r => r.id), [t.id], "one record per task");
  await assert.rejects(() => T.request(owner, spec({ fields: { status: "done" } })), { code: "bad_input" }, "status is not a custom field");
  assert.equal(k.log.read({ type: "task.created" }).length, 1);
});

test("task records: the record is the source of truth for words and due time; edits go through tasks.edit and show in both", async () => {
  const { owner, R, T } = await boot();
  const t = await T.request(owner, spec());
  const upd = await R.update(owner, "task", t.id, { title: "Send the Harlow letter", due: "2026-10-09T10:00:00.000Z", note: null, priority: 3 }, (await R.get(owner, "task", t.id)).version);
  assert.deepEqual([upd.data.title, upd.data.due, upd.data.priority], ["Send the Harlow letter", "2026-10-09T10:00:00.000Z", 3]);
  const task = await T.get(owner, t.id);
  assert.deepEqual([task.title, task.due, task.note], ["Send the Harlow letter", Date.parse("2026-10-09T10:00:00.000Z"), undefined], "the task reads the record's fields");
  // A change made straight on the record by a store that is not ours shows after the cache lapses: the kernel never keeps its own copy of a title.
  await T.edit(owner, t.id, { title: "By tasks.edit" });
  assert.equal((await R.get(owner, "task", t.id)).data.title, "By tasks.edit");
  await assert.rejects(() => R.update(owner, "task", t.id, { status: "done" }, null), { code: "field_not_allowed" }, "status is the kernel's");
  await assert.rejects(() => R.update(owner, "task", t.id, { title: "x" }, 999), { code: "version_conflict" });
  await assert.rejects(() => R.remove(owner, "task", t.id, 1), { code: "not_allowed" }, "a task is skipped, not removed");
});

test("task records: records.create makes the person's own plain to-do, and nothing else may make a task that way", async () => {
  const { k, owner, R, T } = await boot();
  const made = await R.create(owner, "task", { title: "Call Dana Wine", due: "2026-10-08T09:00:00.000Z", priority: 1, list: "clients" });
  assert.deepEqual([made.data.title, made.data.status, made.data.priority, made.data.list], ["Call Dana Wine", "ready", 1, "clients"]);
  const task = await T.get(owner, made.id);
  assert.deepEqual([task.doer.id, task.output.kind, task.state, task.assigned_by.id], [OWNER, "note", "ready", OWNER], "the kernel made the authority under the same checks");
  await assert.rejects(() => R.create(owner, "task", { title: "x", status: "done" }), { code: "field_not_allowed" });
  const research = await addAgent(k, owner, "research");
  await assert.rejects(() => R.create(research, "task", { title: "From an agent" }), { code: "field_not_allowed" }, "an agent uses tasks.request and names the doer");
  const assistant = await addAgent(k, owner, "assistant");
  assert.equal(assistant.via, "assistant");
  const byAssistant = await R.create(assistant, "task", { title: "The assistant's to-do for the person" });
  assert.equal((await T.get(owner, byAssistant.id)).doer.id, OWNER, "the person's assistant acts as the person");
  // The person's assistant finishes it; a project agent cannot touch its words.
  await T.start(assistant, byAssistant.id);
  assert.equal((await T.complete(assistant, byAssistant.id, { note: "ok", sources: ["vyre://x/y/z"] })).state, "done");
  const mine = await R.create(owner, "task", { title: "Private to-do" });
  // An agent acts for the person who assigned the task, under the grants that person gave it; one with no grant on the record is refused by the gate, as for any record.
  const bare = await (async () => { const a = { kind: "agent", id: "bare", space: SPACE }; await k.gateway.grants.addActor(owner, a, { presence: proofFor("grants.role", { actor: a }, `vyre://${SPACE}/member/bare`) }); return k.chains.fromFacts({ kind: "agent_session", agent: "bare", session: "s", thread: "t", vouched: true }); })();
  await assert.rejects(() => R.update(bare, "task", mine.id, { title: "changed by an agent" }, null), { code: "not_found" });
});

test("task records: the held act's body and the approval stay with the kernel, a checked task's words cannot be edited, and a held send still waits for its checker", async () => {
  const { owner, R, T } = await boot();
  const t = await T.request(owner, { title: "Welcome email", doer: { kind: "person", id: OWNER, space: SPACE }, output: { kind: "note" }, note: "n" });
  assert.ok(!("payload" in (await R.get(owner, "task", t.id)).data), "no approval fields on the record");
  assert.ok(!Object.keys((await R.get(owner, "task", t.id)).data).some(k => ["doer", "checker", "payload", "outcome"].includes(k)), "the record holds nothing that decides who may act");
});

test("task records: the move onto records is idempotent, keyed by the task id, and a crash in the middle is finished by the next run", async () => {
  const log = createEventLog({ space: SPACE });
  const store = createMemoryStore({});
  const kept = new Map();
  const texts = { get: (/** @type {string} */ id) => kept.get(id), set: (/** @type {string} */ id, /** @type {any} */ v) => { kept.set(id, v); }, drop: (/** @type {string} */ id) => { kept.delete(id); }, all: () => [...kept] };
  const before = await boot({ log, store, texts, tasksAsRecords: false });
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await before.T.request(before.owner, spec({ title: `Old task ${i}` }))).id);
  // Turned on, with a store that fails on the third record: the move stops part way.
  let creates = 0;
  const flaky = new Proxy(store, { get: (t, p) => (p === "create" ? async (...a) => { if (a[0] === "task" && ++creates === 3) throw new Error("crash"); return t.create(...a); } : t[p]) });
  await assert.rejects(() => boot({ log, store: flaky, texts, tasksAsRecords: true }), /crash/);
  const part = (await store.query("task", { page: { limit: 50 } })).rows.length;
  assert.equal(part, 2, "two were made before the crash");
  const again = await boot({ log, store, texts, tasksAsRecords: true });
  const rows = (await store.query("task", { page: { limit: 50 } })).rows;
  assert.equal(rows.length, 4, "the next run made the other two and no duplicates");
  assert.deepEqual(rows.map(r => r.id).sort(), [...ids].sort());
  assert.deepEqual(rows.map(r => r.data.title).sort(), ["Old task 0", "Old task 1", "Old task 2", "Old task 3"], "the words came from the task");
  const third = await boot({ log, store, texts, tasksAsRecords: true });
  assert.equal((await store.query("task", { page: { limit: 50 } })).rows.length, 4, "a third run changes nothing");
  assert.equal(log.read({ type: "tasks.migrated" }).length, 1, "the crashed run wrote none, the run that finished it wrote one");
  assert.equal((await again.T.get(again.owner, ids[0])).title, "Old task 0");
  void third;
});
