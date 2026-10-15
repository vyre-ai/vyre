// A Flow token through a link: {kin.spouse.name} reads the linked record under the Flow's own chain (kernel/flows/links.js, lib/link/path.js).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";
import { linksFor, withLinks } from "./links.js";

const KIN = { name: "kin", label: "Kin", fields: [
  { name: "name", kind: "text", label: "Name" },
  { name: "spouse", kind: "link", label: "Spouse", to: "kin" },
  { name: "kids", kind: "link", label: "Kids", to: "kin", many: true },
] };
const copyFlow = (/** @type {string} */ path) => ({ format: 1, name: "copy_name", authorship: "builder", trigger: { on: "event", event: "kin.created", where: 'trigger.after.name == "Main"' }, steps: [
  { id: "put", kind: "create", type: "payment", set: { amount: 1, client: { expr: path } } },
] });
async function setup() {
  const w = await world();
  await w.kernel.records.define(w.kernel.sysChain(), { add_types: [KIN] });
  const chain = w.kernel.chainFor({ flow: "x", approver: ALEX, tainted: false, space: w.cat.space });
  const urn = (/** @type {any} */ r) => ({ urn: r.urn || `vyre://${w.cat.space}/kin/${r.id}` });
  return { w, chain, urn };
}
const payments = async (/** @type {any} */ w, /** @type {any} */ chain) => (await w.kernel.records.query(chain, "payment", { page: { limit: 10 } })).rows.map((/** @type {any} */ r) => r.data.client);

test("a second hop through an empty link reads as nothing, and the run goes on", async () => {
  const { w, chain, urn } = await setup();
  const sam = await w.kernel.records.create(chain, "kin", { name: "Sam" });
  await install(w, copyFlow("trigger.after.spouse.name + ' / ' + trigger.after.spouse.spouse.name"));
  await w.kernel.records.create(chain, "kin", { name: "Main", spouse: urn(sam) });
  await settle(w);
  const [run] = await w.runner.listRuns();
  assert.equal(run.state, "done", "Sam has no spouse: that part is empty text");
  assert.deepEqual(await payments(w, chain), ["Sam / "]);
});

test("a token through two links fills", async () => {
  const { w, chain, urn } = await setup();
  const rae = await w.kernel.records.create(chain, "kin", { name: "Rae" });
  const sam = await w.kernel.records.create(chain, "kin", { name: "Sam", spouse: urn(rae) });
  await install(w, copyFlow("trigger.after.spouse.name + ' / ' + trigger.after.spouse.spouse.name"));
  await w.kernel.records.create(chain, "kin", { name: "Main", spouse: urn(sam) });
  await settle(w);
  assert.deepEqual(await payments(w, chain), ["Sam / Rae"]);
});

test("a many link read without a number is the names joined by a comma; with a number, the first", async () => {
  const { w, chain, urn } = await setup();
  const a = await w.kernel.records.create(chain, "kin", { name: "Kit" }), b = await w.kernel.records.create(chain, "kin", { name: "Lou" });
  await install(w, copyFlow("trigger.after.kids.name + ' | ' + trigger.after.kids[0].name"));
  await w.kernel.records.create(chain, "kin", { name: "Main", kids: [urn(a), urn(b)] });
  await settle(w);
  assert.deepEqual(await payments(w, chain), ["Kit, Lou | Kit"]);
});

test("a linked record that is gone stops the step with a plain error", async () => {
  const { w, chain, urn } = await setup();
  const gone = await w.kernel.records.create(chain, "kin", { name: "Gone" });
  const main = await w.kernel.records.create(chain, "kin", { name: "Main", spouse: urn(gone) });
  await w.kernel.records.remove(chain, "kin", gone.id, gone.version);
  await install(w, { ...copyFlow("trigger.after.spouse.name"), trigger: { on: "event", event: "kin.updated", where: 'trigger.after.name == "Main2"' } });
  await w.kernel.records.update(chain, "kin", main.id, { name: "Main2" }, main.version);
  await settle(w);
  const runs = await w.runner.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, "failed");
  assert.match(String(runs[0].error.message), /step put: .*the kin it links to is not there, or is not yours to see/);
  assert.deepEqual(await payments(w, chain), []);
});

test("a link with nothing in it reads as nothing in a value, and the run goes on", async () => {
  const { w, chain } = await setup();
  await install(w, copyFlow("trigger.after.spouse.name"));
  await w.kernel.records.create(chain, "kin", { name: "Main" });
  await settle(w);
  const [run] = await w.runner.listRuns();
  assert.equal(run.state, "done");
  assert.deepEqual(await payments(w, chain), [null]);
});

// The pure half, with a stand-in reader: sealed through a link, and the caller who may not read.
const reader = (/** @type {Record<string, any>} */ recs) => ({ space: "spc_s", read: async (/** @type {string} */ t, /** @type {string} */ i) => (recs[`${t}/${i}`] ? { data: recs[`${t}/${i}`] } : null) });
const step = (/** @type {string} */ e) => ({ id: "s", kind: "create", type: "t", set: { v: { expr: e } } });

test("links.js: a sealed value through a link is its placeholder; a record the caller cannot read stops it", async () => {
  const scope = { steps: { find: { record: { urn: "vyre://spc_s/kin/a", data: { spouse: { urn: "vyre://spc_s/kin/b" } } } } } };
  const e = "steps.find.record.data.spouse.ssn";
  const over = await linksFor(step(e), scope, reader({ "kin/b": { ssn: { sealed: "ssn", ref: "r", present: true } } }));
  assert.equal(withLinks(scope, over).steps.find.record.data.spouse.ssn, "[sealed: ssn]");
  assert.deepEqual(scope.steps.find.record.data.spouse, { urn: "vyre://spc_s/kin/b" }, "the run's own record is not changed");
  await assert.rejects(linksFor(step(e), scope, reader({})), /is not there, or is not yours to see/);
});

test("links.js: a path that follows no link reads nothing", async () => {
  const scope = { steps: { find: { record: { urn: "vyre://spc_s/kin/a", data: { name: "A" } } } } };
  assert.deepEqual(await linksFor(step("steps.find.record.data.name"), scope, reader({})), []);
});

test("a linked record is read under the lesser of the Flow's chain and the chain of whoever started the run", async () => {
  const { w, chain, urn } = await setup();
  const sam = await w.kernel.records.create(chain, "kin", { name: "Sam" });
  const real = w.kernel.records.get;
  // the Flow's own chain may read every kin; the member who starts it may not read Sam
  w.kernel.records.get = async (/** @type {any} */ c, /** @type {string} */ t, /** @type {string} */ id) => (c && c.theirs === "per_bob" && id === sam.id ? null : real.call(w.kernel.records, c, t, id));
  w.runner.ports.actorChain = (/** @type {string} */ id) => ({ theirs: id, hops: [{ actor: { kind: "person", id } }] });
  const flow = { format: 1, name: "read_kin", label: "Read kin", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "put", kind: "create", type: "payment", set: { amount: 1, client: { expr: "trigger.kin.name" } } }] };
  const { id } = await install(w, flow);
  const asAlex = w.kernel.as(ALEX), asBob = w.kernel.as("per_bob");
  await w.runner.start(id, { kin: urn(sam) }, asAlex);
  await settle(w);
  await w.runner.start(id, { kin: urn(sam) }, asBob);
  await settle(w);
  const runs = (await w.runner.listRuns()).sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
  assert.deepEqual(runs.map(r => r.state).sort(), ["done", "failed"], "one run read it, the other did not");
  const failed = runs.find(r => r.state === "failed");
  assert.match(String(failed && failed.error.message), /not there, or is not yours to see/, "the starter could not read it, so neither can the Flow for them");
  assert.deepEqual(await payments(w, chain), ["Sam"], "only the run that Alex started wrote it");
});
