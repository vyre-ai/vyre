// @ts-check
// On a REAL vyred (R031-12, 13, 11 propose, R031-03): a Flow starts a project from a template when a record reaches a stage; a template is saved from a project that ran one and installed from a Kit's
// library; an agent proposes a version live and the owner's yes does it; and a chat started with no project lands in its creator's private Personal project.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const used = new Set();
const presence = { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 25_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };
const TEMPLATE = { name: "Intake to retained", roles: [{ role: "researcher", agent: "research" }], stages: [{ name: "Intake", tasks: [{ title: "Gather documents", doer: "role:researcher", output: { kind: "note" } }] }, { name: "Done" }] };
const INTAKE = { name: "intake", label: "Intake", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "stage", kind: "stage", label: "Stage", options: ["New", "Retained"] }], stages: [{ name: "New" }, { name: "Retained" }] };

async function boot(/** @type {any} */ t) {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
  t.after(() => d.stop());
  const space = d.kernel.id.space, owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(ownerChain, {})).token });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await d.registry.call(tool, input, "cli", await meta()); if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code }); return r.data; };
  const actor = { kind: "agent", id: "research", space };
  await call("agents.create", { name: "research", kind: "agent", projects: [] });
  const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
  await d.kernel.gateway.grants.addActor(ownerChain, actor, { presence: proof("grants.role", { actor }, `vyre://${space}/member/research`) });
  return { d, space, owner, ownerChain, call, host: d.registry.deps.flowsHost.get(space) };
}

test("a Flow step starts a project when a record reaches a stage; the project is the template's, pinned and with its first tasks", { timeout: 180_000 }, async t => {
  const { d, call, space, ownerChain, host } = await boot(t);
  await call("work.template.define", { body: TEMPLATE });
  await call("work.template.golive", { template: "tpl_intake-to-retained", version: 1 });
  await d.kernel.gateway.records.define(ownerChain, { add_types: [INTAKE] });
  const flow = { format: 1, name: "start_project_on_retained", label: "Start a project when an intake is retained", authorship: "human", trigger: { on: "stage", type: "intake", stage: "Retained" },
    steps: [{ id: "p", kind: "call", action: "work.start-project", resource: `vyre://${space}/tool/work.start-project`, input: { template: "tpl_intake-to-retained", name: "Chen intake" } }] };
  const r = await call("flows.define", { flow });
  assert.ok(r.ok, JSON.stringify(r));
  await host.flows.tools["flows.approve"](host.personChain(), { id: r.id, version: r.version, hash: r.hash });
  const rec = await d.kernel.gateway.records.create(ownerChain, "intake", { name: "Chen", stage: "New" });
  assert.equal((await d.kernel.gateway.records.query(ownerChain, "project", { filter: { field: "template", op: "eq", value: "tpl_intake-to-retained" }, page: { limit: 5 } })).rows.length, 0, "nothing starts until the stage");
  await d.kernel.gateway.records.update(ownerChain, "intake", rec.id, { stage: "Retained" }, rec.version);
  const proj = await until(async () => (await d.kernel.gateway.records.query(ownerChain, "project", { filter: { field: "template", op: "eq", value: "tpl_intake-to-retained" }, page: { limit: 5 } })).rows[0], "the Flow to start the project");
  assert.deepEqual([proj.data.name, proj.data.template_stage, JSON.parse(proj.data.template_snapshot).stages.length], ["Chen intake", "Intake", 2]);
  await until(async () => (await d.kernel.gateway.ask.list(ownerChain, {})).find((/** @type {any} */ x) => x.title === "Gather documents" && x.record === proj.urn), "its first task");
});

test("a template is saved from a project that ran one, a Kit's library template installs as a draft, and a free-flow project has nothing to save", { timeout: 180_000 }, async t => {
  const { call, owner } = await boot(t);
  await call("work.template.define", { body: TEMPLATE });
  await call("work.template.golive", { template: "tpl_intake-to-retained", version: 1 });
  const started = await call("work.start-project", { template: "tpl_intake-to-retained", name: "Okafor" });
  const saved = await call("work.template.from-project", { project: started.slug, name: "Okafor-shaped" });
  assert.deepEqual([saved.template, saved.version, saved.state, saved.owner], ["tpl_okafor-shaped", 1, "draft", owner]);
  const got = (await call("work.template.get", { template: "tpl_okafor-shaped", version: 1 })).body;
  assert.deepEqual([got.stages.map((/** @type {any} */ s) => s.name), got.roles], [["Intake", "Done"], [{ role: "researcher", agent: "research" }]]);
  assert.match(got.stages[0].tasks[0].brief, /Goal: Gather documents for \{record\.name\}/, "the brief it ran with is kept");
  const free = await call("work.project.create", { name: "Plain chats" });
  await assert.rejects(() => call("work.template.from-project", { project: free.slug }), /did not start from a template/);
  const lib = (await call("work.template.library")).templates;
  assert.ok(lib.some((/** @type {any} */ x) => x.id === "law-firm/estate-plan" && x.stages === 5), JSON.stringify(lib));
  const inst = await call("work.template.install", { id: "law-firm/estate-plan" });
  assert.deepEqual([inst.template, inst.state, inst.kit], ["tpl_estate-plan", "draft", "law-firm"]);
  const tried = await call("work.template.test", { template: "tpl_estate-plan", version: 1, sample: { name: "Rivera" } });
  assert.ok(tried.ok && tried.counts.stages === 5, JSON.stringify(tried));
});

test("an agent proposes a template version live; its owner is asked on one card; the yes puts it live and retires the old one; nobody else is asked", { timeout: 180_000 }, async t => {
  const { d, call, owner, ownerChain, host } = await boot(t);
  await call("work.template.define", { body: TEMPLATE });
  await call("work.template.golive", { template: "tpl_intake-to-retained", version: 1 });
  const v2 = await call("work.template.define", { template: "tpl_intake-to-retained", body: { ...TEMPLATE, stages: [...TEMPLATE.stages, { name: "Archive" }] } });
  assert.equal(v2.version, 2);
  const kit = d.kernel.chains.fromFacts({ kind: "agent_session", vouched: true, person: owner, agent: "research", session: "s2", thread: "t2" });
  const p = await host.flows.tools["flows.propose"](kit, { what: "template", template: "tpl_intake-to-retained", version: 2 });
  assert.ok(p.ok && p.approver === owner, JSON.stringify(p));
  assert.equal((await call("work.template.list", { template: "tpl_intake-to-retained" })).versions.find((/** @type {any} */ v) => v.version === 2).state, "draft", "nothing changes before the yes");
  const row = await d.kernel.gateway.ask.get(ownerChain, p.task);
  assert.match(row.title, /^Put Intake to retained version 2 live\?/);
  await d.kernel.gateway.ask.decide(ownerChain, p.task, { outcome: "approved", proof: { op: "task.decide", fields: { task: p.task, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: Math.random() } });
  const live = await until(async () => { const v = (await call("work.template.list", { template: "tpl_intake-to-retained" })).versions; return v.find((/** @type {any} */ x) => x.version === 2 && x.state === "live") ? v : null; }, "the approved version to go live");
  assert.deepEqual(live.map((/** @type {any} */ v) => [v.version, v.state]), [[2, "live"], [1, "retired"]]);
});

test("a chat started with no project lands in its creator's private Personal project (a real vyred)", { timeout: 120_000 }, async t => {
  const { d, call, owner, ownerChain } = await boot(t);
  const made = await d.kernel.gateway.grants.chats.create(ownerChain, {});
  const chat = await until(async () => (await d.kernel.gateway.records.query(ownerChain, "chat-record", { filter: { field: "chat", op: "eq", value: made.id }, page: { limit: 1 } })).rows[0], "the chat's record");
  const proj = await d.kernel.gateway.records.get(ownerChain, "project", chat.data.project.urn.split("/").pop());
  assert.deepEqual([proj.data.name, proj.data.personal_of], ["Personal", owner]);
});
