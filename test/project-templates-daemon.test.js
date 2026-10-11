// @ts-check
// Project templates on a REAL vyred (R031-10..13): a template is written as a draft, tried with nothing done, put live by its owner, and a project started from it gets its teammates, its pinned stages and the
// first stage's tasks with their briefs; finishing the task moves the project to the next stage by the module; and a Flow step starts a project when a record reaches a stage.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { start } from "../core/daemon/index.js";
import { call as socketCall } from "../core/daemon/client.js";
import { COOKIE } from "../core/presence/person.js";
import { tempHome, pairDevice } from "./helpers.js";
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

async function boot(/** @type {any} */ t, member = true, verifier = presence) {
  const root = tempHome(t);
  const logs = /** @type {string[]} */ ([]);
  const d = await start({ root, log: (/** @type {string} */ m) => { logs.push(String(m)); }, kernel: true, kernelPresence: verifier });
  /** @type {any} */ (d).testLogs = logs;
  t.after(() => d.stop());
  const space = d.kernel.id.space, owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(ownerChain, {})).token });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await d.registry.call(tool, input, "cli", await meta()); if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code }); return r.data; };
  // the roster agent the template's role is filled by: making it makes it an actor of the Space (member = false leaves it out, so the role names an agent the Space does not have)
  const actor = { kind: "agent", id: "research", space };
  if (!member) return { d, space, owner, ownerChain, call, meta, host: d.registry.deps.flowsHost.get(space) };
  const made = await call("agents.create", { name: "research", kind: "agent", projects: [] });
  assert.equal(made.note, undefined, "the answer to a create that made the agent an actor has no warning");
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
  // the team the timeline names is the team a person can read: who is on it and the role each fills
  assert.deepEqual((await call("work.project.members", { project: started.project.split("/").pop() })).members, [{ agent: "research", role: "researcher" }]);
  await assert.rejects(() => call("work.project.members", { project: "no-such-project" }), /no such project/);
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
  // what a template project leaves behind reads as words: no "[object Object]", no "undefined", in its record, tasks, team records or timeline
  const hygiene = (/** @type {any} */ v) => JSON.stringify(v).match(/\[object Object\]|"undefined"|:undefined\b|\bNaN\b/);
  assert.equal(hygiene((await d.kernel.gateway.records.get(ownerChain, "project", started.project.split("/").pop())).data), null, "the project record");
  assert.equal(hygiene(await d.kernel.gateway.ask.list(ownerChain, {})), null, "the tasks");
  assert.equal(hygiene((await d.kernel.gateway.records.query(ownerChain, "team-member", { page: { limit: 50 } })).rows), null, "the team records");
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

test("a template's chosen opening page is pinned in the project it starts (G21)", { timeout: 180_000 }, async t => {
  const { d, call, ownerChain } = await boot(t);
  await call("work.template.define", { body: { ...TEMPLATE, name: "Files first", opens_on: "files" } });
  await call("work.template.golive", { template: "tpl_files-first", version: 1 });
  const started = await call("work.start-project", { template: "tpl_files-first", name: "Okafor" });
  const id = String(started.project).split("/").pop();
  const rec = await d.kernel.gateway.records.get(ownerChain, "project", /** @type {string} */ (id));
  assert.ok(rec && rec.data.template_snapshot, `the project carries its snapshot: ${JSON.stringify(started)}`);
  assert.equal(JSON.parse(rec.data.template_snapshot).opens_on, "files");
  await assert.rejects(() => call("work.template.define", { body: { ...TEMPLATE, name: "Bad open", opens_on: "dashboard" } }), /opens_on is the page/);
});

test("a free-flow project becomes a draft template: its tasks are the working stage's tasks, and the person refines it in the studio (G21)", { timeout: 180_000 }, async t => {
  const { d, call, ownerChain } = await boot(t);
  const made = await call("work.project.create", { name: "Okafor Estate" });
  const urn = String(made.urn || made.project || made.record);
  assert.ok(urn, `a project was made: ${JSON.stringify(made).slice(0, 200)}`);
  const slug = String(made.slug || "okafor-estate");
  for (const [title, note] of [["Collect the death certificate", "Ask the family for a certified copy"], ["Open the estate account", ""]]) {
    await d.kernel.gateway.records.create(ownerChain, "task", { title, project: { urn }, ...(note ? { note } : {}) });
  }
  const draft = await call("work.template.from-project", { project: slug, name: "Estate intake" });
  assert.equal(draft.state, "draft");
  const got = await call("work.template.get", { template: draft.template, version: draft.version });
  const stages = got.body.stages;
  assert.deepEqual(stages.map((/** @type {any} */ s) => s.name), ["Working", "Done"]);
  assert.deepEqual(stages[0].tasks.map((/** @type {any} */ x) => x.title).sort(), ["Collect the death certificate", "Open the estate account"]);
  assert.equal(stages[0].tasks.find((/** @type {any} */ x) => x.title.startsWith("Collect")).brief, "Ask the family for a certified copy");
  assert.equal(got.body.name, "Estate intake");
});

test("a team project lives in the team Space: the template tools take a `space` and make everything there (J9)", { timeout: 240_000 }, async t => {
  const { d, call, owner } = await boot(t);
  const team = await d.kernel.spaces.host({ owner, name: "teamroom" });
  const lib = (await call("work.template.library", { space: team.space })).templates;
  assert.ok(lib.length, "the library answers for the team Space");
  const inst = await call("work.template.install", { id: lib[0].id, space: team.space });
  assert.equal(inst.state, "draft");
  assert.deepEqual((await call("work.template.list", { space: team.space })).templates.map((/** @type {any} */ x) => x.template), [inst.template], "the team Space has the template");
  assert.deepEqual((await call("work.template.list")).templates, [], "and the home's own Space does not");
  await call("work.template.golive", { template: inst.template, version: inst.version, space: team.space });
  const started = await call("work.start-project", { template: inst.template, name: "Team day", space: team.space });
  const teamChain = team.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const projects = (await team.gateway.records.query(teamChain, "project", { page: { limit: 50 } })).rows.map((/** @type {any} */ r) => r.data.name);
  assert.deepEqual(projects, ["Team day"], `the project is in the team Space (${JSON.stringify(started).slice(0, 120)})`);
  const home = (await d.kernel.gateway.records.query(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" }), "project", { page: { limit: 50 } })).rows;
  assert.ok(!home.some((/** @type {any} */ r) => r.data.name === "Team day"), `and not in the home's (${home.map((/** @type {any} */ r) => r.data.name)})`);
  await assert.rejects(() => call("work.template.list", { space: "spc_nowhere000000" }), /does not host that Space/);
});

test("a Flow attached to a template runs for each project it starts, as its own approver (G21 Automations)", { timeout: 180_000 }, async t => {
  const { d, call, ownerChain, host } = await boot(t);
  const flow = { format: 1, name: "welcome_contact", label: "Welcome the client", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "c", kind: "create", type: "contact", set: { name: { expr: "\"Welcome \" + trigger.stage" } } }] };
  const def = await call("flows.define", { flow });
  assert.ok(def.ok, JSON.stringify(def));
  await host.flows.tools["flows.approve"](host.personChain(), { id: def.id, version: def.version, hash: def.hash });
  await call("work.template.define", { body: { ...TEMPLATE, name: "With automation", automations: [{ when: "start", flow: def.id, note: "greets the client" }] } });
  const tried = await call("work.template.test", { template: "tpl_with-automation", version: 1 });
  assert.match(tried.lines.join("\n"), /Automation: the Flow fl_.* runs when a project starts \(greets the client\)\. Nothing is run in test mode\./, "test mode lists the attached Flow and runs none");
  await call("work.template.golive", { template: "tpl_with-automation", version: 1 });
  await call("work.start-project", { template: "tpl_with-automation", name: "Okafor" });
  const names = async () => ((await d.kernel.gateway.records.query(ownerChain, "contact", { page: { limit: 50 } })).rows || []).map((/** @type {any} */ r) => r.data.name);
  await until(async () => (await names()).includes("Welcome Intake"), "the attached Flow to run when the project started (its first stage is Intake)");
  await call("work.start-project", { template: "tpl_with-automation", name: "Rivera" });
  await until(async () => (await names()).filter((/** @type {string} */ n) => n === "Welcome Intake").length === 2, "and once for each project");
  await assert.rejects(() => call("work.template.define", { body: { ...TEMPLATE, name: "Bad auto", automations: [{ when: "Nowhere", flow: def.id }] } }), /when is "start" or the name/);
});

test("an agent is made an actor of its Space when it is made: under its name, once, and not by a call with no person; deleting it takes the actor back", { timeout: 180_000 }, async t => {
  const { d, call, meta } = await boot(t, false);
  await call("work.template.define", { body: TEMPLATE });
  await call("work.template.golive", { template: "tpl_estate-plan", version: 1 });
  const ask = async (/** @type {string} */ name) => { const r = await call("work.start-project", { template: "tpl_estate-plan", name }); return r; };
  // a name with a capital is not an agent's name: the id the stage uses is the name as written
  await assert.rejects(() => call("agents.create", { name: "Research", kind: "agent", projects: [] }), /lowercase letters, digits and dashes/);
  // a model and a member never make an agent (the tool's callers), so neither makes an actor
  for (const caller of ["mcp:agent:kit", "space", "mcp"]) { const r = await d.registry.call("agents.create", { name: "sneaky", kind: "agent", projects: [] }, caller, await meta()); assert.ok(r.error, `${caller} cannot make an agent`); }
  // a module's call carries no person: the agent is made, it is not an actor, and the answer says so and what to do
  const viaModule = await d.registry.call("agents.create", { name: "research", kind: "agent", projects: [] }, "module:onboard");
  assert.equal(viaModule.error, undefined, JSON.stringify(viaModule.error));
  assert.match(String(viaModule.data.note), /not a member of this Space yet.*vyre space add-agent spc_/);
  assert.equal((await ask("Before")).tasks_made, 0, "its task is skipped, not claimed");
  await call("agents.delete", { agent: "research" });
  // a person makes it: an actor, so its task is made
  const mine = await call("agents.create", { name: "research", kind: "agent", projects: [] });
  assert.equal(mine.note, undefined);
  assert.equal((await ask("After")).tasks_made, 1);
  // deleting it takes the actor back: a project started now skips the task again
  await call("agents.delete", { agent: "research" });
  const gone = await ask("Gone");
  assert.equal(gone.tasks_made, 0);
  assert.deepEqual(gone.tasks_skipped, [{ task: "Gather documents", why: "research is not in this space yet" }]);
});

test("agents made before they became actors are left as they are by a restart: no event is written at start, and one gets its actor the first time its owner starts a chat with it (or add-agent)", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const startD = async () => start({ root, log: () => {}, kernel: true, kernelPresence: presence });
  let d = await startD();
  const owner = d.kernel.id.owner, space = d.kernel.id.space;
  const chain = () => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(chain(), {})).token }); if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code }); return r.data; };
  const added = (/** @type {string} */ id) => d.kernel.log.read({ type: "actor.added" }).filter((/** @type {any} */ e) => e.data.actor.id === id).length;
  await call("agents.create", { name: "research", kind: "agent", projects: [] });
  assert.equal(added("research"), 1, "one actor.added event for the agent");
  // asked again (a second create-path call, a second chat start): nothing more is written
  await d.registry.deps.agentActor("research");
  await d.registry.deps.agentActor("research");
  assert.equal(added("research"), 1, "registering an agent that is already an actor writes nothing");
  // the state of an install from before: the agent row is there and the Space has no such actor
  const actor = { kind: "agent", id: "research", space };
  await d.kernel.gateway.grants.removeActor(chain(), actor, { presence: proof("grants.role", { actor }, `vyre://${space}/member/research`) });
  await d.stop();
  d = await startD();
  t.after(() => d.stop());
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(d.kernel.log.read({ type: "actor.added" }).filter((/** @type {any} */ e) => e.data.actor.id === "research").length, 1, "a restart wrote no actor.added event, for this agent or any other");
  await call("work.template.define", { body: TEMPLATE });
  await call("work.template.golive", { template: "tpl_estate-plan", version: 1 });
  assert.equal((await call("work.start-project", { template: "tpl_estate-plan", name: "Before" })).tasks_made, 0, "an agent from before is still not an actor: the note on create and add-agent say how");
});

test("the app's own route: a paired owner device (Settings, Assistants) makes the agent, it carries the person, the agent becomes an actor and a template project makes its tasks; the owner's terminal is told what to do", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
  t.after(() => d.stop());
  const DEVICE = "abcdefghijklmnop";
  pairDevice(d, DEVICE, d.kernel.id.owner);   // the owner's phone or Mac, paired as a real one is
  const ctx = d.registry.context({ name: "names", version: "0.1.0", does: { tools: [] }, watches: { emits: ["owner.seen"] } });
  const sess = d.registry.deps.cliSessions.startStandIn("dev1");
  /** The app's call: the paired device over the listener, with the signed-in cookie session. */
  const device = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(input))]), { method: "POST", url: `/v1/tools/${tool}`, headers: { host: "relay", "content-type": "application/json", cookie: `${COOKIE}=${sess.token}`, "sec-fetch-site": "same-origin", "sec-fetch-dest": "empty" } });
    let out = "", status = 0;
    const res = { setHeader() {}, writeHead(/** @type {number} */ s) { status = s; }, end(b = "") { out += b; }, headersSent: false };
    await ctx.handler({})(req, res, `device:${DEVICE}`, { kind: "device", stableId: "dev1", node: "dev1", login: null, tags: [], caps: {} });
    return { status, ...(out ? JSON.parse(out) : {}) };
  };
  const made = await device("agents.create", { name: "research", kind: "agent", projects: [] });
  assert.equal(made.status, 200, JSON.stringify(made));
  assert.equal(made.data.note, undefined, `the app's create carries the person, so the agent became an actor: ${JSON.stringify(made.data.note)}`);
  assert.equal((await device("work.template.define", { body: TEMPLATE })).status, 200);
  assert.equal((await device("work.template.golive", { template: "tpl_estate-plan", version: 1 })).status, 200);
  const started = await device("work.start-project", { template: "tpl_estate-plan", name: "Rivera" });
  assert.equal(started.status, 200, JSON.stringify(started));
  assert.equal(started.data.tasks_made, 1, JSON.stringify(started.data));
  assert.equal(started.data.tasks_skipped, undefined);
  // the owner's terminal: `vyre` over the daemon's socket
  const viaTerminal = await socketCall("agents.create", { name: "scout", kind: "agent", projects: [] }, { root, caller: "cli" });
  assert.equal(viaTerminal.error, undefined, JSON.stringify(viaTerminal.error));
  assert.equal(viaTerminal.data.note, undefined, "the terminal over the daemon's socket carries the owner too, so it is registered as well");
  const SCOUT = { ...TEMPLATE, name: "Scout plan", roles: [{ role: "researcher", agent: "scout", lead: true }] };
  assert.equal((await device("work.template.define", { body: SCOUT })).status, 200);
  assert.equal((await device("work.template.golive", { template: "tpl_scout-plan", version: 1 })).status, 200);
  const st = await device("work.start-project", { template: "tpl_scout-plan", name: "Okafor" });
  assert.equal(st.data.tasks_made, 1, JSON.stringify(st.data));
  // (the note's own command, `vyre space add-agent`, asks the owner's yes from the same terminal: presence_required on the moment "pair", approved on the phone or confirmed on the computer)
});

test("an agent made by a MEMBER is made but is not an actor, and says so; nothing in the Space is given to it", { timeout: 240_000 }, async t => {
  const { d, call, space, ownerChain } = await boot(t, false);
  const BOB = "per_bobbobbobbobbobbobbobbobbo";
  const r = { person: BOB, role: "member" };
  await d.kernel.gateway.grants.setRole(ownerChain, r, { presence: proof("grants.role", r, `vyre://${space}/member/${BOB}`) });
  const bob = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-bob", person: BOB, path: "direct", session: "s" });
  const made = await d.registry.call("agents.create", { name: "research", kind: "agent", projects: [] }, "cli", { token: (await d.kernel.surfaces.open(bob, {})).token });
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  assert.match(String(made.data.note), /only the Space's owner adds an agent to it.*vyre space add-agent spc_/);
  assert.equal(d.kernel.log.read({ type: "actor.added" }).filter((/** @type {any} */ e) => e.data.actor.id === "research").length, 0, "no actor.added for it");
  await call("work.template.define", { body: TEMPLATE });
  await call("work.template.golive", { template: "tpl_estate-plan", version: 1 });
  assert.equal((await call("work.start-project", { template: "tpl_estate-plan", name: "Rivera" })).tasks_made, 0);
});

test("an agent deleted and made again under the same name inherits none of the old one's grants (its chat seats and open tasks stay with the name, flagged)", { timeout: 240_000 }, async t => {
  // (the kernel's presence check accepts every proof here: this test is about what the new agent holds, not about the yes)
  const { d, call, space, ownerChain } = await boot(t, true, { check: async () => null });
  const actor = { kind: "agent", id: "research", space };
  const gi = { subject: { kind: "actor", actor }, actions: ["records.read"], resource: { prefix: `vyre://${space}/note/*` }, conditions: {}, source: "test" };
  const g = d.kernel.gateway.grants;
  await g.create(ownerChain, gi, { presence: proof("grants.create", gi, `vyre://${space}/grant/new`) });
  const chat = await g.chats.create(ownerChain, { assistants: ["research"] });
  await call("work.template.define", { body: TEMPLATE });
  await call("work.template.golive", { template: "tpl_estate-plan", version: 1 });
  assert.equal((await call("work.start-project", { template: "tpl_estate-plan", name: "Old" })).tasks_made, 1, "an open task for the old agent");
  const mine = async () => (await g.list(ownerChain, {})).filter((/** @type {any} */ x) => x.status === "active" && x.subject.kind === "actor" && x.subject.actor.id === "research");
  const before = (await mine()).length;
  assert.ok(before >= 1, "it holds the grant");
  const del = await d.registry.call("agents.delete", { agent: "research" }, "cli", { token: (await d.kernel.surfaces.open(ownerChain, {})).token, kernel_proof: { method: "stand-in" } });
  assert.equal(del.error, undefined, JSON.stringify(del.error));
  assert.equal((await mine()).length, 0, "the grants given to its name went with it");
  await call("agents.create", { name: "research", kind: "agent", projects: [] });
  // TODAY, flagged as undecided (the owner's rulings list, "whose agents become actors", and the 0.3.4 backlog): a chat seat and an open task are given to the NAME, and the kernel lets only a person IN the chat change its seats, so deleting the agent leaves both with the name.
  // The new agent of that name is seated in the old chat again, and the old agent's open task can be worked by it. Grants are the part delete can and does take back.
  assert.deepEqual(g.chats.read(ownerChain, chat.id).assistants, ["research"], "the old chat still lists the name");
  const tasks = (await d.kernel.gateway.ask.list(ownerChain, { doer: "research" })) || [];
  assert.deepEqual(tasks.map((/** @type {any} */ x) => [x.title, x.state]), [["Gather documents", "ready"]], "the old open task is still the name's");
  assert.equal((await mine()).length, 0, "the new agent holds nothing of the old one");
});
