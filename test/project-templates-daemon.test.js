// @ts-check
// Project templates on a REAL vyred (R031-10..13): a template is written as a draft, tried with nothing done, put live by its owner, and a project started from it gets its teammates, its pinned stages and the
// first stage's tasks with their briefs; finishing the task moves the project to the next stage by the module; and a Flow step starts a project when a record reaches a stage.
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
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 25_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };

const TEMPLATE = {
  name: "Estate plan", description: "Intake to signing", tags: ["estate"],
  roles: [{ role: "researcher", agent: "research", lead: true }],
  stages: [
    { name: "Intake", owner: "role:attorney", tasks: [{ title: "Gather documents", doer: "role:researcher", output: { kind: "note" }, context: ["the client sent a folder link"], needs_yes: ["contacting the client"] }] },
    { name: "Drafting", tasks: [{ title: "Draft the trust", doer: "role:researcher", output: { kind: "note" } }] },
    { name: "Signing" },
  ],
};

async function boot(/** @type {any} */ t, member = true) {
  const root = tempHome(t);
  const logs = /** @type {string[]} */ ([]);
  const d = await start({ root, log: (/** @type {string} */ m) => { logs.push(String(m)); }, kernel: true, kernelPresence: presence });
  /** @type {any} */ (d).testLogs = logs;
  t.after(() => d.stop());
  const space = d.kernel.id.space, owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(ownerChain, {})).token });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await d.registry.call(tool, input, "cli", await meta()); if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code }); return r.data; };
  // the roster agent the template's role is filled by is a member of the Space
  await call("agents.create", { name: "research", kind: "agent", projects: [] });
  const actor = { kind: "agent", id: "research", space };
  if (!member) return { d, space, owner, ownerChain, call, meta, host: d.registry.deps.flowsHost.get(space) };
  await d.kernel.gateway.grants.addActor(ownerChain, actor, { presence: proof("grants.role", { actor }, `vyre://${space}/member/research`) });
  // and may do the tasks it is given
  const gi = { subject: { kind: "actor", actor }, actions: ["tasks.read", "tasks.work"], resource: { prefix: `vyre://${space}/task/*` }, conditions: {}, source: "test" };
  await d.kernel.gateway.grants.create(ownerChain, gi, { presence: proof("grants.create", gi, `vyre://${space}/grant/new`) });
  return { d, space, owner, ownerChain, call, meta, host: d.registry.deps.flowsHost.get(space) };
}

test("a template is a draft until its owner puts it live; test mode shows every brief and creates nothing; a project started from it has its team, pinned stages and first tasks; finishing a task moves it on", { timeout: 180_000 }, async t => {
  const { d, call, owner, space, ownerChain, host } = await boot(t);
  const def = await call("work.template.define", { body: TEMPLATE });
  assert.deepEqual([def.template, def.version, def.state, def.owner], ["tpl_estate-plan", 1, "draft", owner]);
  await assert.rejects(() => call("work.start-project", { template: "tpl_estate-plan", name: "Rivera" }), /no live version/, "a draft starts nothing");
  await assert.rejects(() => call("work.template.define", { body: { name: "Bad", stages: [{ name: "Only" }] } }), /2 to 40 stages/);

  const tried = await call("work.template.test", { template: "tpl_estate-plan", version: 1, sample: { name: "Rivera" } });
  assert.ok(tried.ok, JSON.stringify(tried));
  const text = tried.lines.join("\n");
  assert.match(text, /Nothing is created, sent or changed/);
  assert.match(text, /task "Gather documents" for role:researcher \(research, the project lead\)/);
  assert.match(text, /Goal: Gather documents for Rivera\./, "the brief, filled for the sample");
  assert.match(text, /Needs a yes before it happens: contacting the client\./);
  assert.match(text, /role:attorney may move it early/);
  assert.equal((await d.kernel.gateway.records.query(ownerChain, "project", { filter: { field: "template", op: "eq", value: "tpl_estate-plan" }, page: { limit: 10 } })).rows.length, 0, "test mode made no project");
  assert.equal((await d.kernel.allTasks?.() ?? []).length, 0);

  await call("work.template.golive", { template: "tpl_estate-plan", version: 1 });
  assert.equal((await call("work.template.list", {})).templates[0].live, 1);

  const started = await call("work.start-project", { template: "tpl_estate-plan", name: "Rivera Family", repo: "git@example.com:rivera.git" });
  assert.deepEqual([started.stage, started.lead, started.teammates.map((/** @type {any} */ x) => x.agent)], ["Intake", "research", ["research"]]);
  const proj = (await d.kernel.gateway.records.get(ownerChain, "project", started.project.split("/").pop())).data;
  assert.deepEqual([proj.template, proj.template_version, proj.template_stage, proj.lead], ["tpl_estate-plan", "1", "Intake", "research"]);
  assert.deepEqual(JSON.parse(proj.template_snapshot).stages.map((/** @type {any} */ s) => s.name), ["Intake", "Drafting", "Signing"], "the stages are pinned on the project");
  assert.ok(parseTags(proj.tags).includes("estate"), "the template's tag");

  const task = await until(async () => (await d.kernel.gateway.ask.list(ownerChain, {})).find((/** @type {any} */ x) => x.title === "Gather documents"), "the first task to be made");
  assert.deepEqual([task.doer.kind, task.doer.id, task.stage], ["agent", "research", "Intake"]);
  const brief = (await d.kernel.gateway.ask.get(ownerChain, task.id)).note || "";
  assert.match(String(brief), /Goal: Gather documents for Rivera Family\./);

  // editing the template afterwards changes nothing here (a second draft version, then live)
  const v2 = await call("work.template.define", { template: "tpl_estate-plan", body: { ...TEMPLATE, stages: [...TEMPLATE.stages, { name: "Funding" }] } });
  assert.equal(v2.version, 2);
  await call("work.template.golive", { template: "tpl_estate-plan", version: 2 });
  const versions = (await call("work.template.list", { template: "tpl_estate-plan" })).versions;
  assert.deepEqual(versions.map((/** @type {any} */ v) => [v.version, v.state]), [[2, "live"], [1, "retired"]]);
  assert.equal(JSON.parse((await d.kernel.gateway.records.get(ownerChain, "project", started.project.split("/").pop())).data.template_snapshot).stages.length, 3, "the running project keeps version 1");

  // the agent does the task; the module moves the project to the next stage and makes its tasks
  const agent = d.kernel.chains.fromFacts({ kind: "agent_session", vouched: true, person: owner, agent: "research", session: "s9", thread: "t9" });
  await d.kernel.gateway.ask.start(agent, task.id);
  await d.kernel.gateway.ask.complete(agent, task.id, { note: "all documents gathered", sources: ["session:s9"] });
  const moved = await until(async () => { const r = (await d.kernel.gateway.records.get(ownerChain, "project", started.project.split("/").pop())).data; return r.template_stage === "Drafting" ? r : null; }, "the project to move to Drafting");
  assert.equal(moved.template_stage, "Drafting");
  await until(async () => (await d.kernel.gateway.ask.list(ownerChain, {})).some((/** @type {any} */ x) => x.title === "Draft the trust" && x.stage === "Drafting"), `the next stage's task to be made (${JSON.stringify((await d.kernel.gateway.ask.list(ownerChain, {})).map((/** @type {any} */ x) => [x.title, x.stage, x.state]))} ${/** @type {any} */ (d).testLogs.filter((/** @type {string} */ l) => /stage\./.test(l)).join(' | ')} ${JSON.stringify(host.stages.entries().map((/** @type {any} */ e) => [e.stage, e.advanced, e.tasks.length]))})`);
  // J2, the timeline steps: the project's story says each move in plain lines, newest first, and none of them is an id or an event name
  const story = (await call("work.timeline", { record: started.project })).entries;
  const lines = story.map((/** @type {any} */ e) => e.line);
  assert.equal(lines[lines.length - 1], "Started from the Estate plan template", `the story begins with the template: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes("Entered the Intake stage"), `the Intake stage is on the timeline: ${JSON.stringify(lines)}`);
  assert.ok(lines.includes("Entered the Drafting stage"), "and so is Drafting");
  assert.ok(lines.some((/** @type {string} */ l) => /Gather documents/.test(l)), `the finished task is on it: ${JSON.stringify(lines)}`);
  assert.ok(lines.every((/** @type {string} */ l) => !/\b(task|flow-run|stage)_[0-9a-f]{6}|vyre:\/\/|\w+-\w+\.\w+$/.test(l)), `no line shows an id or an event name: ${JSON.stringify(lines)}`);
  const at = (/** @type {string} */ l) => story.find((/** @type {any} */ e) => e.line === l).at;
  assert.ok(at("Entered the Drafting stage") >= at("Entered the Intake stage"), "in order");
  void space;
});

function parseTags(/** @type {string} */ s) { try { return JSON.parse(s || "[]"); } catch { return []; } }

test("a project started when its assistant is not in the space yet says which first tasks could not be made and why, instead of claiming its tasks exist", { timeout: 180_000 }, async t => {
  const { call } = await boot(t, false);
  await call("work.template.define", { body: TEMPLATE });
  await call("work.template.golive", { template: "tpl_estate-plan", version: 1 });
  const r = await call("work.start-project", { template: "tpl_estate-plan", name: "Rivera" });
  assert.equal(r.tasks_made, 0);
  assert.deepEqual(r.tasks_skipped, [{ task: "Gather documents", why: "research is not in this space yet" }]);
  assert.equal(r.slug, "rivera", "the project itself is made");
});

test("with its assistant in the space, the same start reports its first task as made", { timeout: 180_000 }, async t => {
  const { call } = await boot(t, true);
  await call("work.template.define", { body: TEMPLATE });
  await call("work.template.golive", { template: "tpl_estate-plan", version: 1 });
  const r = await call("work.start-project", { template: "tpl_estate-plan", name: "Okafor" });
  assert.equal(r.tasks_made, 1);
  assert.equal(r.tasks_skipped, undefined);
});
