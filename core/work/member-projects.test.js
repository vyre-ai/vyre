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
  await assert.rejects(w.as(ANA, "start-project", { template: id, name: "X", version: 1 }), /version is not something a member names/, "a pinned version is refused in words");
  await assert.rejects(w.as(ANA, "start-project", { template: id, name: "X", repo: "git@x:y" }), /repo is not something a member names/);
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
