// @ts-check
// Three Records promises, on a real vyred with the kernel on (a temp home, never a Mac): "Seal this field for all" really seals (an agent never gets the value afterwards, and only an owner or an admin may
// do it); "Add a column" shows at once in records.types, becomes a real field and can then be filtered; "New task" is made through tasks.request, linked to the record it was started from.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome, present, absent } from "../../test/helpers.js";
import { QUICK_FIELD, RECORD_LAYOUT } from "../../records/core-types.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const MEMBER = "per_" + "mnopqrstuvwxyzabcdefghijkl";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const CLIENT = { name: "client", label: "Client", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "account", kind: "text", label: "Account number" }] };
const VALUE = "ACCT-5521-sample", OTHER = "ACCT-7734-sample";

/** A vyred with the Client type, and calls as a person through a surface token of their own. @param {any} t @param {any} presence */
async function rig(t, presence) {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, presence, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const { call } = await import("../daemon/client.js");
  const K = d.kernel, OWNER = K.id.owner;
  const dev = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  await K.gateway.records.define(dev(OWNER), { add_types: [QUICK_FIELD, RECORD_LAYOUT] }).catch(() => {});
  await K.gateway.records.define(dev(OWNER), { add_types: [CLIENT] });
  // the owner on their own surface (the CLI, as the app's calls arrive), and another person through a surface of their own
  const own = async (/** @type {string} */ tool, /** @type {any} */ input) => /** @type {any} */ (await call(tool, input, { root, caller: "cli" }));
  const as = async (/** @type {string} */ p, /** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", { token: (await K.surfaces.open(dev(p), {})).token });
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input) => { const r = await own(tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  return { d, K, OWNER, dev, as, own, ok };
}

test("Seal this field for all: the values move into a sealed field, an agent's view and a reference never hold them, and only an owner or an admin may do it", { timeout: 150_000 }, async t => {
  const { K, OWNER, dev, as, ok } = await rig(t, present);
  const a = (await ok("records.create", { type: "client", data: { name: "Sample One", account: VALUE } })).record;
  await ok("records.create", { type: "client", data: { name: "Sample Two", account: OTHER } });
  // before: the plain value is there for an agent (so the check below means something)
  assert.ok(JSON.stringify((await ok("records.sees-as", { urn: a.urn, who: "assistant" })).data).includes(VALUE), "before sealing an agent reads the plain value");
  assert.ok(JSON.stringify((await ok("records.reference", { urn: a.urn })).reference).includes(VALUE), "and a reference carries it");

  // a member may not seal a field, and nothing moves
  await K.gateway.grants.setRole(dev(OWNER), { person: MEMBER, role: "member" }, { presence: proof() });
  const refused = await as(MEMBER, "records.field.seal", { type: "client", field: "account" });
  assert.ok(refused.error, "a member is refused: " + JSON.stringify(refused));
  assert.equal((await K.gateway.records.get(dev(OWNER), "client", a.id)).data.account, VALUE, "a refused seal changes nothing");

  const out = await ok("records.field.seal", { type: "client", field: "account" });
  assert.equal(out.sealed_field, "account_sealed");
  assert.equal(out.moved, 2);
  const types = (await ok("records.types", {})).types;
  const client = types.find((/** @type {any} */ x) => x.name === "client");
  assert.equal(client.fields.find((/** @type {any} */ f) => f.name === "account_sealed").kind, "sealed", "a real sealed field, not a flag");
  assert.equal(client.fields.find((/** @type {any} */ f) => f.name === "account").hidden, true, "the plain field is removed from view");

  for (const [what, got] of /** @type {[string, any][]} */ ([
    ["an agent's view (sees-as)", (await ok("records.sees-as", { urn: a.urn, who: "assistant" })).data],
    ["a reference put in front of the AI", (await ok("records.reference", { urn: a.urn })).reference],
    ["the person's own read", (await ok("records.get", { urn: a.urn })).record],
    ["the record's events", (await ok("records.events", { record: a.urn })).events],
  ])) {
    const s = JSON.stringify(got);
    assert.equal(s.includes(VALUE), false, `${what} holds no plain value: ${s.slice(0, 400)}`);
    assert.equal(s.includes(OTHER), false, `${what} holds no other record's value`);
  }
  const ref = (await ok("records.reference", { urn: a.urn })).reference;
  assert.ok(JSON.stringify(ref.placeholders || ref).includes("account_sealed"), "the reference names the sealed field as a placeholder");
  assert.equal(JSON.stringify(K.log.read()).includes(VALUE), false, "the event log keeps no plain value");
});

test("Seal this field for all asks for the person's presence: without it nothing is sealed", { timeout: 150_000 }, async t => {
  const { K, OWNER, dev, own } = await rig(t, absent);
  const a = await K.gateway.records.create(dev(OWNER), "client", { name: "Sample One", account: VALUE });
  const r = await own("records.field.seal", { type: "client", field: "account" });
  assert.ok(r.error, JSON.stringify(r));
  assert.equal((await K.gateway.records.get(dev(OWNER), "client", a.id)).data.account, VALUE, "the value is still plain: nothing ran");
});

test("Add a column: records.types lists the new field at once, a define of that answer keeps it a fast field, promote makes it real and then a filter on it works", { timeout: 150_000 }, async t => {
  const { K, OWNER, dev, ok, own } = await rig(t, present);
  const added = (await ok("records.field.add", { type: "client", label: "Budget", kind: "number" })).field;
  assert.equal(added.name, "budget");
  const listed = () => ok("records.types", {}).then((x) => x.types.find((/** @type {any} */ y) => y.name === "client"));
  const before = (await listed()).fields.filter((/** @type {any} */ f) => f.name === "budget");
  assert.equal(before.length, 1, "records.types lists the new field");
  assert.equal(before[0].fast, true);
  assert.equal(before[0].state, "bag");
  assert.equal(before[0].kind, "number");
  const rec = (await ok("records.create", { type: "client", data: { name: "Sample Big", budget: 900 } })).record;
  assert.equal(rec.data.budget, 900, "the value reads back at once");
  await ok("records.create", { type: "client", data: { name: "Sample Small", budget: 100 } });
  const early = await own("records.list", { type: "client", filter: { field: "budget", op: "gt", value: 500 } });
  assert.equal(early.error && early.error.code, "bad_input", "a filter waits for the real field");

  // the app saves a type as records.types gave it (a new view, a layout, Customize): the fast field is not made a store field that way
  await ok("records.define", { diff: { change_types: [await listed()] } });
  assert.equal((await ok("records.field.status", { type: "client" })).fields.find((/** @type {any} */ f) => f.name === "budget").state, "bag");
  assert.equal(((await K.gateway.definitions(dev(OWNER))) || []).find((/** @type {any} */ x) => x.name === "client").fields.some((/** @type {any} */ f) => f.name === "budget"), false, "still a fast field, not a store field");

  const done = await ok("records.field.promote", { type: "client", name: "budget" });
  assert.equal(done.state, "real");
  assert.equal(done.done, 2);
  const after = (await listed()).fields.filter((/** @type {any} */ f) => f.name === "budget");
  assert.equal(after.length, 1, "listed once, as the store's own field");
  assert.equal(after[0].fast, undefined);
  const page = await ok("records.list", { type: "client", filter: { field: "budget", op: "gt", value: 500 } });
  assert.deepEqual(page.rows.map((/** @type {any} */ r) => r.data.name), ["Sample Big"], "the filter works on the real field");
  const sorted = await ok("records.list", { type: "client", sort: [{ field: "budget", dir: "desc" }] });
  assert.deepEqual(sorted.rows.map((/** @type {any} */ r) => r.data.budget), [900, 100]);
});

test("New task from a record's page: a person cannot write the kernel's status, so it goes through tasks.request, done by the person and linked to that record", { timeout: 150_000 }, async t => {
  const { OWNER, ok, own } = await rig(t, present);
  const about = (await ok("records.create", { type: "client", data: { name: "Sample Client" } })).record;
  const direct = await own("records.create", { type: "task", data: { title: "Call back", status: "ready" } });
  assert.ok(direct.error, "the old path: the kernel refuses a person writing a task's status");
  // what the app's New task sends (apps/app/ui/records/logic.js taskRequestOf)
  const task = (await ok("tasks.request", { task: { title: "Call back", doer: OWNER, output: { kind: "note" }, source: "manual", record: about.urn, due: Date.parse("2026-11-30T10:00:00Z"), fields: { priority: 2 } } })).task;
  assert.equal(task.state, "ready");
  assert.equal(task.record, about.urn);
  const rec = (await ok("records.get", { urn: `vyre://${task.space}/task/${task.id}` })).record;
  assert.equal(rec.data.title, "Call back");
  assert.equal(rec.data.status, "ready", "the kernel wrote the status");
  assert.equal(rec.data.priority, 2);
  assert.equal(rec.data.record && rec.data.record.urn, about.urn, "the task is about the record it was started from");
});
