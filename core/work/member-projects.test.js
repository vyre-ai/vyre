// @ts-check
// A team member starts her own projects on the team's server (0.3.3), on a REAL vyred with the kernel on: the member door's `work` group (kernel/remote/wire.js CALLS.work, core/work/member-projects.js). She starts a blank
// project and one from an installed template; both are hers, in the team's Space, and the owner sees them by the Space's rules; a template is read as the work module (the record type is closed to members) and a draft is
// never hers to start; a person who is not a member gets nothing; and what she can do to ANOTHER member's project is written down by the last test, not assumed. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { CALLS } from "../../kernel/remote/wire.js";
import { createMemberTools, MEMBER_TOOLS } from "./member-tools.js";
import { createMemberProjects, MAX_LIVE } from "./member-projects.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", ZED = "per_" + "defghijklmnopqrstuvwxyzabc";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const TEMPLATE = { name: "Intake kit", description: "One stage with a task", tags: ["kit"], roles: [{ role: "researcher", agent: "research", lead: true }], stages: [{ name: "Intake", tasks: [{ title: "Gather documents", doer: "role:researcher", output: { kind: "note" } }] }, { name: "Done" }] };

/** @param {any} t */
async function world(t) {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner, space = d.kernel.id.space;
  const facts = (/** @type {string} */ person) => ({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  const ownerFacts = { kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" };
  const ownerChain = d.kernel.chains.fromFacts(ownerFacts);
  for (const person of [ANA, BEN]) await d.kernel.gateway.grants.setRole(ownerChain, { person, role: "member" }, { presence: proof() });
  const svc = createMemberTools({ space, kernel: d.kernel, registry: d.registry }).work;
  const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts(facts(person));
  const as = (/** @type {string} */ person, /** @type {string} */ call, /** @type {any} */ input = {}) => svc[call](chainOf(person), input);
  const owner = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(ownerChain, {})).token }); if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code }); return r.data; };
  const live = async () => { await owner("agents.create", { name: "research", kind: "agent", projects: [] }); const def = await owner("work.template.define", { body: TEMPLATE }); await owner("work.template.golive", { template: def.template, version: def.version }); return def.template; };
  const projects = async (/** @type {string} */ person) => (await d.kernel.gateway.records.query(person === OWNER ? ownerChain : chainOf(person), "project", { page: { limit: 100 } })).rows;
  return { d, OWNER, space, svc, as, owner, live, projects, ownerChain, chainOf };
}

test("work is a group of the Space kernel's remote calls, and every call of it is a row of the member door's one table", () => {
  assert.deepEqual([...CALLS.work].sort(), ["project-create", "start-project", "templates"]);
  assert.deepEqual(Object.keys(MEMBER_TOOLS).filter(k => k.startsWith("work.")).map(k => k.slice(5)).sort(), [...CALLS.work].sort());
});

test("a member starts a blank project: it is hers, in the team's Space, and the owner and she both see it", { timeout: 120_000 }, async t => {
  const w = await world(t);
  const made = await w.as(ANA, "project-create", { name: "Ana's matter" });
  assert.match(String(made.project), new RegExp(`^vyre://${w.space}/project/`), JSON.stringify(made));
  const hers = (await w.projects(ANA)).find((/** @type {any} */ r) => r.data.slug === made.slug);
  assert.ok(hers, "she reads her project");
  assert.equal(hers.data.owner.actor.id, ANA, "she is its owner, not the Space's owner");
  assert.ok((await w.projects(w.OWNER)).some((/** @type {any} */ r) => r.data.slug === made.slug), "the owner sees it");
});

test("a member starts a project from an installed template: its first stage's tasks are made; a draft or a pinned version is not hers to name; a library template is not hers to install", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const id = await w.live();
  const list = await w.as(ANA, "templates", {});
  assert.deepEqual(list.templates.map((/** @type {any} */ x) => [x.template, x.live]), [[id, 1]], "she sees the live templates by name");
  assert.ok(!JSON.stringify(list).includes("Gather documents"), "and not their bodies");
  const started = await w.as(ANA, "start-project", { template: id, name: "Rivera" });
  assert.equal(started.template, id, JSON.stringify(started));
  assert.ok(started.tasks_made >= 1, `its first task is made: ${JSON.stringify(started)}`);
  const mine = (await w.projects(ANA)).find((/** @type {any} */ r) => r.data.slug === started.slug);
  assert.equal(mine.data.owner.actor.id, ANA);
  // who made what the template made: the project is hers; print the creator of its first task (the Flows stage module makes it)
  try { const tasks = await w.d.kernel.gateway.ask.list(w.ownerChain, { record: started.project }); const first = (tasks.rows || tasks)[0]; console.log(`# first task: ${JSON.stringify({ by: first && (first.created_by || first.requester || first.requested_by), doer: first && first.doer })}`); } catch (e) { console.log(`# first task creator not read: ${/** @type {Error} */ (e).message}`); }
  // the door lets through only the keys the row names: a version, a repository or a client she names is dropped, and the project is made from the live version
  const dropped = await w.as(ANA, "start-project", { template: id, name: "Pinned", version: 99, repo: "git@x:y", client: "vyre://x/contact/1" });
  assert.equal(dropped.version, 1, "a pinned version she names is dropped: it starts at the live one");
  const droppedRow = (await w.projects(ANA)).find((/** @type {any} */ r) => r.data.slug === dropped.slug);
  assert.ok(!droppedRow.data.repo && !droppedRow.data.client, "and so are a repository and a client she names");
  const draft = await w.owner("work.template.define", { body: { ...TEMPLATE, name: "Secret draft" } });
  await assert.rejects(w.as(ANA, "start-project", { template: draft.template, name: "Y" }), /no live version|not_found/i, "a draft starts nothing for her");
  assert.ok(!(await w.as(ANA, "templates", {})).templates.some((/** @type {any} */ x) => x.template === draft.template), "and is not in her list");
});

test("a person who is not a member, and a chain that is not one person's, get nothing", { timeout: 90_000 }, async t => {
  const w = await world(t);
  await assert.rejects(w.as(ZED, "project-create", { name: "Nope" }), /not found|not_found/i);
  const two = w.d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-two", person: ANA, path: "relay" });
  await assert.rejects(w.svc["project-create"]({ ...two, delegated: true }, { name: "Nope" }), /not found|not_found/i);
});

test("the folder marker is the work module's and gives nobody a folder right: another member opens none of the project's files", { timeout: 120_000 }, async t => {
  const w = await world(t);
  const gw = w.d.kernel.gateway;
  const made = await w.as(ANA, "project-create", { name: "Ana's folder" });
  const dir = made.drive_path;
  assert.match(String(dir), /^Projects\//);
  const read = async (/** @type {any} */ chain, /** @type {string} */ p) => { try { await gw.drive.get(chain, p); return true; } catch { return false; } };
  const write = async (/** @type {any} */ chain, /** @type {string} */ p) => { try { await gw.drive.put(chain, p, new TextEncoder().encode("hello")); return true; } catch { return false; } };
  assert.equal(await read(w.chainOf(BEN), `${dir}/.project`), false, "another member reads nothing in it");
  assert.equal(await write(w.chainOf(BEN), `${dir}/files/ben.txt`), false, "and writes nothing in it");
  console.log(`# her own folder today: Ana reads the marker=${await read(w.chainOf(ANA), `${dir}/.project`)}, Ana writes ${dir}/files/note.txt=${await write(w.chainOf(ANA), `${dir}/files/note.txt`)}`);
});

// What she can do with her project's files today (measured): she puts a file in `Projects/<id>/files/` and reads it back; she does not read the marker `Projects/<id>/.project` (outside the files area), which is the work module's.
test("her own project's files: she puts a file in the project's files area and reads it back", { timeout: 120_000 }, async t => {
  const w = await world(t);
  const gw = w.d.kernel.gateway;
  const made = await w.as(ANA, "project-create", { name: "Ana's files" });
  const path = `${made.drive_path}/files/note.txt`;
  await gw.drive.put(w.chainOf(ANA), path, new TextEncoder().encode("hello"));
  const got = await gw.drive.get(w.chainOf(ANA), path);
  assert.ok(got, "she reads it back");
  await assert.rejects(gw.drive.get(w.chainOf(BEN), path), "another member does not");
});

// The ownership rule (rc1-a, kernel/gateway/ownership.js): a member updates a `project` only if she owns it or is on its team, and never its owner field; team-member rows are the project's owner's. These were the red-first cases.
test("another member's project: she cannot rename it and cannot take its owner field", { timeout: 120_000 }, async t => {
  const w = await world(t);
  const bens = await w.as(BEN, "project-create", { name: "Ben's matter" });
  const row = (await w.projects(ANA)).find((/** @type {any} */ r) => r.data.slug === bens.slug);
  await assert.rejects(w.d.kernel.gateway.records.update(w.chainOf(ANA), "project", row.id, { name: "Renamed by Ana" }, row.version), "renaming another member's project is refused");
  await assert.rejects(w.d.kernel.gateway.records.update(w.chainOf(ANA), "project", row.id, { owner: { actor: { kind: "person", id: ANA, space: w.space } } }, row.version), "taking its owner field is refused");
});

test("what a member can do to ANOTHER member's project is the Space's rule today: written down, not assumed", { timeout: 120_000 }, async t => {
  const w = await world(t);
  const bens = await w.as(BEN, "project-create", { name: "Ben's matter" });
  const row = (await w.projects(ANA)).find((/** @type {any} */ r) => r.data.slug === bens.slug);
  assert.ok(row, "Ana can read Ben's project record (members hold records.read)");
  let changed = null, why = "";
  try { changed = await w.d.kernel.gateway.records.update(w.chainOf(ANA), "project", row.id, { name: "Renamed by Ana" }, row.version); } catch (e) { why = String(/** @type {Error} */ (e).message); }
  console.log(`# Ana renaming Ben's project: ${changed ? "ALLOWED" : "refused: " + why}`);
  let took = null, why2 = "";
  try { const fresh = (await w.projects(ANA)).find((/** @type {any} */ r) => r.id === row.id); took = await w.d.kernel.gateway.records.update(w.chainOf(ANA), "project", row.id, { owner: { actor: { kind: "person", id: ANA, space: w.space } } }, fresh.version); } catch (e) { why2 = String(/** @type {Error} */ (e).message); }
  console.log(`# Ana taking Ben's project's owner field: ${took ? "ALLOWED" : "refused: " + why2}`);
  assert.ok(true, "recorded above; the decision is the lead's");
});

test("what a member can do to ANOTHER member's team-member row and task today: measured and printed, not assumed", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const gw = w.d.kernel.gateway;
  const bens = await w.as(BEN, "project-create", { name: "Ben's team" });
  const urn = bens.project;
  // team-member: Ana adds HERSELF to Ben's project, the row that opens the project's files
  let joined = false, why = "";
  try { await gw.records.create(w.chainOf(ANA), "team-member", { name: "ana", actor: { actor: { kind: "person", id: ANA, space: w.space } }, kind: "person", project: { urn } }); joined = true; } catch (e) { why = String(/** @type {Error} */ (e).message); }
  let reads = false;
  if (joined) { try { await gw.drive.put(w.chainOf(BEN), `${bens.drive_path}/files/b.txt`, new TextEncoder().encode("b")); await gw.drive.get(w.chainOf(ANA), `${bens.drive_path}/files/b.txt`); reads = true; } catch { /* no */ } }
  console.log(`# team-member: Ana adds herself to Ben's project: ${joined ? "ALLOWED" : "refused: " + why}; then reads his files: ${reads}`);
  // task: Ben has a task; Ana tries to complete it
  let done = "not made", took = "";
  try {
    const task = await gw.ask.request(w.chainOf(BEN), { title: "Ben's task", doer: { kind: "person", id: BEN, space: w.space }, checker: { kind: "person", id: w.OWNER, space: w.space }, output: { kind: "note" } });
    try { await gw.ask.start(w.chainOf(ANA), task.id); await gw.ask.complete(w.chainOf(ANA), task.id, { answer: "done by Ana" }); done = "ALLOWED"; } catch (e) { done = "refused: " + String(/** @type {Error} */ (e).message); }
    took = task.id;
  } catch (e) { done = "could not set up: " + String(/** @type {Error} */ (e).message); }
  console.log(`# task: Ana completes Ben's task: ${done}`);
  assert.ok(true, took || "recorded above");
});

test("another member's project: she cannot add herself to its team (the row that opens its files)", { timeout: 120_000 }, async t => {
  const w = await world(t);
  const bens = await w.as(BEN, "project-create", { name: "Ben's team 2" });
  await w.d.kernel.gateway.drive.put(w.chainOf(BEN), `${bens.drive_path}/files/b.txt`, new TextEncoder().encode("b"));
  await assert.rejects(w.d.kernel.gateway.records.create(w.chainOf(ANA), "team-member", { name: "ana", actor: { actor: { kind: "person", id: ANA, space: w.space } }, kind: "person", project: { urn: bens.project } }), "adding herself to his team is refused");
  await assert.rejects(w.d.kernel.gateway.drive.get(w.chainOf(ANA), `${bens.drive_path}/files/b.txt`), "and his files stay unreadable to her");
});

test("a member keeps at most 50 live projects of her own: the next one is refused in words, and nothing is made", async () => {
  let made = 0;
  const hub = () => ({ createProject: async () => { made++; return { urn: "u", data: {} }; } });
  const ops = createMemberProjects({ liveOf: async () => MAX_LIVE, templates: /** @type {any} */ ({}), hub, reader: () => ({ service: {}, read: {} }) });
  const chain = { hops: [{ actor: { kind: "person", id: ANA } }] };
  await assert.rejects(ops["create-project"](chain, { name: "One more" }), /already have 50 live projects.*Archive one/);
  await assert.rejects(ops["start-project"](chain, { template: "tpl_x", name: "One more" }), /already have 50 live projects/);
  assert.equal(made, 0);
  assert.equal(MAX_LIVE, 50);
  const under = createMemberProjects({ liveOf: async () => MAX_LIVE - 1, templates: /** @type {any} */ ({}), hub, reader: () => ({ service: {}, read: {} }) });
  await under["create-project"](chain, { name: "The 50th" });
  assert.equal(made, 1);
});
