// A Flow token through a link: {kin.spouse.name} reads the linked record under the Flow's own chain (kernel/flows/links.js, lib/link/path.js).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";
import { linksFor, withLinks, byPerson } from "./links.js";

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
  // Bob's chain is the stand-in whose reads are cut off above; anyone else (Alex) is a real member of the Space and reads as the kernel says
  w.runner.ports.actorChain = (/** @type {string} */ id) => (id === "per_bob" ? { theirs: id, hops: [{ actor: { kind: "person", id } }] } : w.kernel.as({ kind: "person", id }));
  const flow = { format: 1, name: "read_kin", label: "Read kin", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "put", kind: "create", type: "payment", set: { amount: 1, client: { expr: "trigger.kin.name" } } }] };
  const { id } = await install(w, flow);
  const asAlex = w.kernel.as(ALEX), asBob = w.kernel.as({ kind: "person", id: "per_bob" });
  await w.runner.start(id, { kin: urn(sam) }, asAlex);
  await settle(w);
  await w.runner.start(id, { kin: urn(sam) }, asBob);
  await settle(w);
  const runs = (await w.runner.listRuns()).sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
  assert.deepEqual(runs.map(r => r.state).sort(), ["done", "failed"], `one run read it, the other did not: ${JSON.stringify(runs.map(r => ({ state: r.state, by: r.started_by, error: r.error })))}`);
  const failed = runs.find(r => r.state === "failed");
  assert.match(String(failed && failed.error.message), /not there, or is not yours to see/, "the starter could not read it, so neither can the Flow for them");
  assert.deepEqual(await payments(w, chain), ["Sam"], "only the run that Alex started wrote it");
});

test("an event-triggered run reads a linked record under the lesser of the Flow's chain and the chain of the person whose change fired it", async () => {
  const { w, chain, urn } = await setup();
  const sam = await w.kernel.records.create(chain, "kin", { name: "Sam" });
  const real = w.kernel.records.get;
  w.kernel.records.get = async (/** @type {any} */ c, /** @type {string} */ t, /** @type {string} */ id) => (c && c.theirs === "per_bob" && id === sam.id ? null : real.call(w.kernel.records, c, t, id));
  // Bob's chain is the stand-in whose reads are cut off above; anyone else (Alex) is a real member of the Space and reads as the kernel says
  w.runner.ports.actorChain = (/** @type {string} */ id) => (id === "per_bob" ? { theirs: id, hops: [{ actor: { kind: "person", id } }] } : w.kernel.as({ kind: "person", id }));
  await install(w, copyFlow("trigger.after.spouse.name"));
  // a change by Bob, who may not read Sam, fires the Flow: it stops; the same change by Alex goes through
  await w.kernel.records.create(w.kernel.as({ kind: "person", id: "per_bob" }), "kin", { name: "Main", spouse: urn(sam) });
  await settle(w);
  await w.kernel.records.create(w.kernel.as(ALEX), "kin", { name: "Main", spouse: urn(sam) });
  await settle(w);
  const runs = await w.runner.listRuns();
  assert.deepEqual(runs.map(r => r.state).sort(), ["done", "failed"], JSON.stringify(runs.map(r => ({ state: r.state, started_by: r.started_by, actor: r.trigger && r.trigger.event && r.trigger.event.actor, kind: r.trigger && r.trigger.kind }))));
  assert.match(String(runs.find(r => r.state === "failed")?.error.message), /not there, or is not yours to see/);
  assert.deepEqual(await payments(w, chain), ["Sam"], "only Alex's change wrote it");
});

test("a manual start with a person on its chain records who started the run (run.started_by), which is what the linked-record read and the file preview compare against", async () => {
  const { w, urn, chain } = await setup();
  const sam = await w.kernel.records.create(chain, "kin", { name: "Sam" });
  const flow = { format: 1, name: "read_kin2", label: "Read kin", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "put", kind: "create", type: "payment", set: { amount: 1, client: { expr: "trigger.kin.name" } } }] };
  const { id } = await install(w, flow);
  await w.runner.start(id, { kin: urn(sam) }, w.kernel.as({ kind: "person", id: "per_bob" }));
  await settle(w);
  const runs = await w.runner.listRuns();
  assert.deepEqual(runs.map(r => r.started_by), ["per_bob"], "the starter is recorded on the run, not on the trigger");
  assert.equal(runs[0].trigger.by, undefined, "and the trigger does not carry it");
});

test("byPerson: the person whose change fired a Flow is its starter, even when a service emitted the event; a service-first chain and a schedule have none", () => {
  assert.deepEqual(byPerson("person:per_bob", []), { by: "per_bob" }, "the actor names a person");
  assert.deepEqual(byPerson("person:per_bob@spc_harlow000001", []), { by: "per_bob" }, "as the log writes it, with the Space");
  assert.deepEqual(byPerson("service:records", [{ actor: { kind: "person", id: "per_bob" } }, { actor: { kind: "service", id: "records" } }]), { by: "per_bob" }, "a person's change the records service emitted");
  assert.deepEqual(byPerson("agent:kit", [{ actor: { kind: "person", id: "per_bob" } }, { actor: { kind: "agent", id: "kit" } }]), { by: "per_bob" }, "an assistant's change is its person's");
  assert.deepEqual(byPerson("service:automation", [{ actor: { kind: "service", id: "automation" } }, { actor: { kind: "person", id: "per_alex" } }]), {}, "a Flow's own change has no starter");
  assert.deepEqual(byPerson("service:cron", undefined), {}, "a schedule has none");
  assert.deepEqual(byPerson(undefined, []), {});
});

test("a Flow-written change carries the starter of the run that wrote it: Bob's run of Flow A makes Flow B read as Bob (and stop), Alex's run goes through", async () => {
  const { w, chain, urn } = await setup();
  const sam = await w.kernel.records.create(chain, "kin", { name: "Sam" });
  const real = w.kernel.records.get;
  w.kernel.records.get = async (/** @type {any} */ c, /** @type {string} */ t, /** @type {string} */ id) => (c && c.theirs === "per_bob" && id === sam.id ? null : real.call(w.kernel.records, c, t, id));
  w.runner.ports.actorChain = (/** @type {string} */ id) => (id === "per_bob" ? { theirs: id, hops: [{ actor: { kind: "person", id } }] } : w.kernel.as({ kind: "person", id }));
  await install(w, copyFlow("trigger.after.spouse.name"));
  // Flow A (approved by Alex) writes the "Main" record that links to Sam: its change fires Flow B, which reads Sam through the link
  const a = await install(w, { format: 1, name: "make_main", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "mk", kind: "create", type: "kin", set: { name: "Main", spouse: { expr: "trigger.kin" } } }] });
  await w.runner.start(a.id, { kin: urn(sam) }, w.kernel.as({ kind: "person", id: "per_bob" }));
  await settle(w);
  await w.runner.start(a.id, { kin: urn(sam) }, w.kernel.as(ALEX));
  await settle(w);
  const all = await w.runner.listRuns();
  const bRuns = all.filter(r => r.flow !== a.id);
  const diag = JSON.stringify(all.map(r => ({ flow: r.flow === a.id ? "A" : "B", state: r.state, started_by: r.started_by, error: r.error && r.error.message, corr: r.trigger && r.trigger.event && r.trigger.event.corr, chain: r.trigger && r.trigger.event && (r.trigger.event.chain || []).map((/** @type {any} */ h) => `${h.actor.kind}:${h.actor.id}`) })));
  assert.deepEqual(all.filter(r => r.flow === a.id).map(r => r.state), ["done", "done"], diag);
  assert.deepEqual(bRuns.map(r => r.state).sort(), ["done", "failed"], `B read as the person who started A: ${diag}`);
  assert.equal(bRuns.find(r => r.state === "failed")?.started_by, "per_bob", "B's starter is Bob, not the approver of A");
  assert.match(String(bRuns.find(r => r.state === "failed")?.error.message), /not there, or is not yours to see/);
  assert.deepEqual(await payments(w, chain), ["Sam"], "only the chain Alex started wrote it");
});
