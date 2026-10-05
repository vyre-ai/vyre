// @ts-check
// Flows platform gaps, in a REAL vyred (kernel on): a Code step runs in the OS sandbox, a classify step goes through the model door with sealed values as placeholders and no tools,
// and a real watcher (a process the watchers module runs) starts a Flow. Not rigs: the daemon builds the Flows assembly, the runner, the sandbox port and the door port.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import * as config from "../core/config/index.js";
import { createDoor } from "../kernel/door/door.js";
import { isChain } from "../kernel/core/chain.js";
import { redact } from "../kernel/seal/classes.js";
import { CORE_TYPES } from "../records/core-types.js";
import { mechanism } from "../kernel/modules/sandbox.js";
import { testHooks, OPEN_WALL } from "../lib/sandbox/index.js";
import { skipOffRunner } from "../lib/sandbox/test-host.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const until = async (/** @type {() => Promise<any>} */ f, what, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };
const CONTRACT = { name: "contract", label: "Contract", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "signed", kind: "text", label: "Signed" }, { name: "due", kind: "text", label: "Due" }] };
const MESSAGE = { name: "message", label: "Message", fields: [{ name: "body", kind: "text", label: "Body" }, { name: "kind", kind: "text", label: "Kind" }] };

/** @param {import("node:test").TestContext} t @param {any} [opts] */
async function boot(t, opts = {}) {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true, ...opts });
  t.after(() => d.stop());
  const space = d.kernel.id.space;
  const host = d.registry.deps.flowsHost.get(space);
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" }), {})).token });
  const install = async (/** @type {any} */ flow) => {
    const r = await d.registry.call("flows.define", { flow }, "cli", await meta());
    assert.ok(r.data && r.data.ok, JSON.stringify(r));
    await host.flows.tools["flows.approve"](host.personChain(), { id: r.data.id, version: r.data.version, hash: r.data.hash });
    return r.data;
  };
  return { root, d, host, admin, meta, install };
}

test("a Code step runs in a real daemon: the date a deadline falls on, computed from record fields, in the OS sandbox", { skip: mechanism() === null && "no OS sandbox here", timeout: 120_000 }, async t => {
  const { d, host, admin, install } = await boot(t);
  await d.kernel.gateway.records.define(admin, { add_types: [CONTRACT] });
  const rec = await d.kernel.gateway.records.create(admin, "contract", { name: "Acme", signed: "2026-10-05" });
  const flow = await install({ format: 1, name: "due_date", label: "Work out the due date", authorship: "human", trigger: { on: "manual" }, steps: [
    { id: "p", kind: "pick", type: "contract", where: "record.name == \"Acme\"" },
    { id: "f", kind: "fn", language: "js", source: "const d = new Date(inputs.signed + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + inputs.days); return { due: d.toISOString().slice(0, 10) };",
      inputs: { signed: { expr: "steps.p.record.data.signed" }, days: 30 }, outputs: ["due"] },
    { id: "u", kind: "update", type: "contract", record: { expr: "steps.p.record.id" }, set: { due: { expr: "steps.f.due" } } }] });
  const started = await host.flows.tools["flows.start"](host.personChain(), { id: flow.id, input: {} });
  const got = await until(async () => { const r = await d.kernel.gateway.records.get(admin, "contract", rec.id); return r && r.data.due ? r : null; }, "the code step to write the due date").catch(async e => { throw new Error(`${e.message}: ${JSON.stringify(await host.flows.tools["flows.runs"](host.personChain(), { id: flow.id }))}`); });
  assert.equal(got.data.due, "2026-11-04");
  const run = (await d.registry.call("flows.run", { run: started.run || started.id }, "cli", await (async () => ({ token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" }), {})).token }))())).data;
  assert.ok(run, "the run is recorded");
});

test("a Code step that runs forever is stopped and the run fails with a reason the owner can read; nothing is written", { skip: mechanism() === null && "no OS sandbox here", timeout: 120_000 }, async t => {
  const { d, host, admin, install } = await boot(t);
  await d.kernel.gateway.records.define(admin, { add_types: [CONTRACT] });
  const rec = await d.kernel.gateway.records.create(admin, "contract", { name: "Acme", signed: "2026-10-05" });
  const flow = await install({ format: 1, name: "spin", label: "Spin", authorship: "human", trigger: { on: "manual" }, steps: [
    { id: "p", kind: "pick", type: "contract", where: "record.name == \"Acme\"" },
    { id: "f", kind: "fn", language: "js", source: "while (true) {}", inputs: {}, outputs: ["due"] },
    { id: "u", kind: "update", type: "contract", record: { expr: "steps.p.record.id" }, set: { due: { expr: "steps.f.due" } } }] });
  await host.flows.tools["flows.start"](host.personChain(), { id: flow.id, input: {} });
  const runs = await until(async () => { const r = await host.flows.tools["flows.runs"](host.personChain(), { id: flow.id }); return r.length && r[0].state === "failed" ? r : null; }, "the run to fail", 30_000);
  assert.equal(runs[0].error && runs[0].error.code, "timeout", JSON.stringify(runs));
  assert.equal((await d.kernel.gateway.records.get(admin, "contract", rec.id)).data.due, undefined);
});

/** A door whose driver is a stub model: it records what it was sent and answers by a rule. The sealer redacts sealed-looking values the way the sealing process does. */
function stubDoor() {
  /** @type {any[]} */ const sent = [];
  const sealer = { detect: async (/** @type {any} */ i) => { const r = redact(i.text); return { text: r.text, found: r.found.map((/** @type {any} */ f) => ({ class: f.class, n: f.n })), ledger: [] }; }, endSession: async () => {} };
  const door = createDoor({ sealer, isChain, sinks: [], drivers: { default: { call: async (/** @type {any} */ i) => { sent.push(i); const text = String(i.messages[i.messages.length - 1].content); if (/JSON object/.test(String(i.messages[0].content))) return { content: JSON.stringify({ client: "Jane", amount: 500 }), usage: { cost_micro: 0 } };
      return { content: /quote|retain|hire|injur/i.test(text) ? "new_lead" : "other", usage: { cost_micro: 0 } }; } } } });
  return { door, sent };
}

test("a classify step goes through the model door in a real daemon: sealed values reach the model as placeholders, the step offers no tools, and the label drives the Flow", { timeout: 120_000 }, async t => {
  const { door, sent } = stubDoor();
  const { d, host, admin, install } = await boot(t, { kernelDoor: door });
  await d.kernel.gateway.records.define(admin, { add_types: [MESSAGE] });
  const triage = await install({ format: 1, name: "triage", label: "Triage inbound messages", authorship: "human", trigger: { on: "manual" }, steps: [
    { id: "c", kind: "classify", input: { expr: "trigger.body" }, labels: ["new_lead", "other"] },
    { id: "u", kind: "update", type: "message", record: { expr: "trigger.id" }, set: { kind: { expr: "steps.c.label" } } }] });
  const a = await d.kernel.gateway.records.create(admin, "message", { body: "Hi, I was injured at work and need a quote. My SSN is 123-45-6789." });
  const b = await d.kernel.gateway.records.create(admin, "message", { body: "Your invoice is attached." });
  for (const m of [a, b]) await host.flows.tools["flows.start"](host.personChain(), { id: triage.id, input: { id: m.id, body: m.data.body } });
  const kindOf = async (/** @type {any} */ r) => until(async () => { const x = await d.kernel.gateway.records.get(admin, "message", r.id); return x && x.data.kind ? x.data.kind : null; }, "the classification");
  assert.equal(await kindOf(a), "new_lead");
  assert.equal(await kindOf(b), "other");
  assert.equal(sent.length, 2);
  assert.ok(!JSON.stringify(sent).includes("123-45-6789"), "the SSN never reached the model");
  assert.match(JSON.stringify(sent[0].messages), /\[sealed: /, "a placeholder stood in for it");
  assert.ok(sent.every(s => !s.tools || s.tools.length === 0), "a classify step passes no tools");
  void host;
});

test("fn.run and model.call are a Flow run's alone: a person calling them directly is refused, even an owner", { timeout: 60_000 }, async t => {
  const { d, admin } = await boot(t);
  const sp = d.kernel.id.space;
  for (const [action, resource] of [["fn.run", `vyre://${sp}/fn/*`], ["model.call", `vyre://${sp}/model/*`]]) {
    const r = await d.kernel.gateway.authorize({ chain: admin, action, resource });
    assert.deepEqual([r.effect, r.reason], ["deny", "runner_only"], action);
  }
  assert.equal((await d.kernel.gateway.authorize({ chain: admin, action: "flows.run", resource: `vyre://${sp}/flow/x` })).effect, "allow", "starting a Flow is a person's");
});

test("a classify step in a home with no model door fails plainly instead of hanging, and the Flow records why", { timeout: 120_000 }, async t => {
  const { d, host, admin, install } = await boot(t);
  await d.kernel.gateway.records.define(admin, { add_types: [MESSAGE] });
  const flow = await install({ format: 1, name: "triage", label: "Triage", authorship: "human", trigger: { on: "manual" }, steps: [
    { id: "c", kind: "classify", input: { expr: "trigger.body" }, labels: ["new_lead", "other"] }] });
  await host.flows.tools["flows.start"](host.personChain(), { id: flow.id, input: { body: "hello" } });
  const runs = await until(async () => { const r = await host.flows.tools["flows.runs"](host.personChain(), { id: flow.id }); return r.length && r[0].state === "failed" ? r : null; }, "the run to fail");
  assert.match(runs[0].error.message, /no model door/);
});

// ---- a real watcher ----
const offMac = skipOffRunner();
test("a real watcher starts a Flow: the watcher process files an item, watcher.fired reaches the bridge, and the Flow runs once with the item as its trigger", { skip: offMac, timeout: 120_000 }, async t => {
  testHooks.wall = OPEN_WALL;
  t.after(() => { testHooks.wall = undefined; });
  const root = tempHome(t);
  const p = config.ensure(root);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(root), "vyre-proj-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(p.config, JSON.stringify({ roots: [], transcripts: [path.join(root, "no-transcripts")], vault: { keystore: "file" } }));
  const logs = /** @type {string[]} */ ([]);
  const d = await start({ root, presence: present, log: m => logs.push(String(m)), kernel: true });
  t.after(() => d.stop());
  const space = d.kernel.id.space;
  const host = d.registry.deps.flowsHost.get(space);
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  await d.kernel.gateway.records.define(admin, { add_types: [MESSAGE] });
  const made = await call("projects.create", { name: "Harlow Legal", home }, { root });
  assert.ok(!made.error, JSON.stringify(made.error));
  const meta = async () => ({ token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" }), {})).token });
  const def = await d.registry.call("flows.define", { flow: { format: 1, name: "on_form", label: "A form came in", authorship: "human", trigger: { on: "watcher", watcher: "harlow-forms" }, steps: [
    { id: "m", kind: "create", type: "message", set: { body: { expr: "trigger.item.title" }, kind: "from-watcher" } }] } }, "cli", await meta());
  assert.ok(def.data && def.data.ok, JSON.stringify(def));
  await host.flows.tools["flows.approve"](host.personChain(), { id: def.data.id, version: def.data.version, hash: def.data.hash });
  // a real watcher: a folder with its spec and code, run by the watchers module
  const dir = path.join(p.watchers, "harlow-forms");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "watcher.json"), JSON.stringify({ name: "harlow-forms", project: "harlow-legal", schedule: "*/15 * * * *", emits: "form.answered" }));
  fs.writeFileSync(path.join(dir, "watch.js"), `export default async function watch({ emit }) { emit({ id: "f-1", title: "Intake form answered by Jane" }); }`);
  const dry = (await call("watchers.test", { name: "harlow-forms" }, { root })).data;
  assert.equal(dry.ok, true, JSON.stringify(dry));
  const on = await call("watchers.create", { name: "harlow-forms" }, { root });
  assert.ok(!on.error, JSON.stringify(on.error));
  const row = await until(async () => { const r = await d.kernel.gateway.records.query(admin, "message", { page: { limit: 50 } }); return r.rows.find((/** @type {any} */ x) => x.data.kind === "from-watcher") || null; }, "the Flow to file the item").catch(async e => { throw new Error(`${e.message}: items=${JSON.stringify((await call("watchers.items", { name: "harlow-forms" }, { root })).data)} runs=${JSON.stringify(await host.flows.tools["flows.runs"](host.personChain(), { id: def.data.id }))} logs=${JSON.stringify(logs.filter(m => /flows|watcher/i.test(m)).slice(-8))}`); });
  assert.equal(row.data.body, "Intake form answered by Jane");
  const runs = await host.flows.tools["flows.runs"](host.personChain(), { id: def.data.id });
  assert.equal(runs.length, 1, "once per item");
  const full = (await host.flows.tools["flows.run"](host.personChain(), { run: runs[0].id })).run;
  assert.equal(full.trigger.kind, "watcher");
  assert.equal(full.trigger.source, "watcher:harlow-forms");
  assert.equal(full.tainted, true, "an item from outside is data: the run is tainted");
  // running it again files nothing new: the same item is the same run
  await call("watchers.run", { name: "harlow-forms" }, { root }).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
  assert.equal((await host.flows.tools["flows.runs"](host.personChain(), { id: def.data.id })).length, 1);
});

test("a task given to a pool in a real daemon goes to the team member with the skill, and says why on the task", { timeout: 120_000 }, async t => {
  const { d, host, admin, install } = await boot(t);
  const sp = d.kernel.id.space;
  const TEAM = CORE_TYPES.find(x => x.name === "team-member");
  await d.kernel.gateway.records.define(admin, { add_types: [TEAM, { ...MESSAGE, name: "case", label: "Case" }] });
  const mk = (/** @type {string} */ name, /** @type {string} */ skills) => d.kernel.gateway.records.create(admin, "team-member", { name, kind: "assistant", role: "legal", skills, actor: { actor: { kind: "person", id: name, space: sp } } });
  await mk("per_ann", "probate");
  await mk(d.kernel.id.owner, "probate, spanish");
  const flow = await install({ format: 1, name: "give", label: "Give", authorship: "human", trigger: { on: "manual" }, steps: [
    { id: "a", kind: "assign", to: "pool:legal", skills: ["spanish"], title: "Call the client", output: { kind: "note" }, how: "person" }] });
  await host.flows.tools["flows.start"](host.personChain(), { id: flow.id, input: {} });
  const runs = await until(async () => { const r = await host.flows.tools["flows.runs"](host.personChain(), { id: flow.id }); return r.length && r[0].state !== "running" ? r : null; }, "the run");
  const full = (await host.flows.tools["flows.run"](host.personChain(), { run: runs[0].id })).run;
  assert.equal(full.steps.a.output.chosen.doer, d.kernel.id.owner, JSON.stringify(full.error || full.steps.a));
  assert.match(full.steps.a.output.chosen.why, /has spanish/);
});

test("an extract step in a real daemon reads fields through the door: the SSN in the message is a placeholder, no tools are offered, the fields reach the record", { timeout: 120_000 }, async t => {
  const { door, sent } = stubDoor();
  const { d, host, admin, install } = await boot(t, { kernelDoor: door });
  await d.kernel.gateway.records.define(admin, { add_types: [{ name: "intake", label: "Intake", fields: [{ name: "who", kind: "text", label: "Who" }, { name: "owed", kind: "number", label: "Owed" }] }] });
  const flow = await install({ format: 1, name: "read", label: "Read", authorship: "human", trigger: { on: "manual" }, steps: [
    { id: "e", kind: "extract", input: { expr: "trigger.body" }, fields: [{ name: "client", kind: "text" }, { name: "amount", kind: "number" }] },
    { id: "c", kind: "create", type: "intake", set: { who: { expr: "steps.e.fields.client" }, owed: { expr: "steps.e.fields.amount" } } }] });
  await host.flows.tools["flows.start"](host.personChain(), { id: flow.id, input: { body: "Jane owes $500. SSN 123-45-6789." } });
  const row = await until(async () => (await d.kernel.gateway.records.query(admin, "intake", { page: { limit: 10 } })).rows[0] || null, "the extracted record");
  assert.equal(row.data.who, "Jane");
  assert.equal(row.data.owed, 500);
  assert.ok(!JSON.stringify(sent).includes("123-45-6789"));
  assert.match(JSON.stringify(sent[0].messages), /\[sealed: /);
  assert.ok(sent.every(x => !x.tools || x.tools.length === 0));
});

test("one person, two Spaces: the AI daily budget and the context budget are each Space's own", { timeout: 120_000 }, async t => {
  const { d, host } = await boot(t);
  const firm = await d.kernel.spaces.host({ owner: d.kernel.id.owner, name: "Harlow Legal" });
  const fh = d.registry.deps.flowsHost.get(firm.space);
  assert.ok(fh && fh !== host && firm.space !== d.kernel.id.space);
  const home = host.flows.tools, other = fh.flows.tools;
  assert.equal((await home["flows.budget"](host.personChain(), {})).tokens_per_day, 200_000, "the default");
  await home["flows.budget"](host.personChain(), { tokens_per_day: 111, context_tokens: 2000 });
  await other["flows.budget"](fh.personChain(), { tokens_per_day: 222_000, context_tokens: 3000 });
  const a = await home["flows.budget"](host.personChain(), {}), b = await other["flows.budget"](fh.personChain(), {});
  assert.deepEqual([a.tokens_per_day, a.context_tokens], [111, 2000]);
  assert.deepEqual([b.tokens_per_day, b.context_tokens], [222_000, 3000]);
  await other["flows.budget"](fh.personChain(), { tokens_per_day: 0 });
  assert.equal((await home["flows.budget"](host.personChain(), {})).tokens_per_day, 111, "turning AI off in one Space leaves the other");
});
