// @ts-check
// Which agents may reach a Project is a KERNEL GRANT (action project.reach on the Project record), the one permission system: deny by default, given and taken away by a person with the kernel's proof,
// kept in step with an agent's `projects` list by the agents module, and "*" is one grant on every project. A real vyred, kernel on.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const until = async (/** @type {() => Promise<any>} */ f, what, ms = 15_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };

async function boot(/** @type {any} */ t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "walk\n");
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner, space = d.kernel.id.space;
  // the person's own enrolled device (a paired phone), as the app calls: the kernel builds the person's chain from its facts
  d.registry.deps.db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, ?, 'p', 1, 'app', 0, NULL)").run("dphonepaired00001", "phone");
  const SI = { proof: { method: "stand-in" }, kernel_proof: { method: "stand-in" }, kernelFacts: { kind: "device", device_key_id: "dphonepaired00001", person: owner, path: "relay", session: "ps_1" } };
  const SI_FACTS = SI.kernelFacts;
  const call = (/** @type {string} */ tool, /** @type {any} */ input = {}, meta = SI) => d.registry.call(tool, input, "cli", meta);
  const home = (/** @type {string} */ n) => { const h = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, `vyre-${n}-`))); t.after(() => fs.rmSync(h, { recursive: true, force: true })); return h; };
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const addAgent = (/** @type {string} */ name) => d.kernel.gateway.grants.addActor(admin, { kind: "agent", id: name, space }, { presence: { method: "stand-in" } });
  return { d, owner, space, call, home, addAgent, SI_FACTS };
}
const granted = async (/** @type {any} */ call, /** @type {string} */ project, /** @type {string} */ agent) => (await call("projects.access.check", { project, agent })).data.granted;

test("an agent reaches a project only by a kernel grant: deny by default, grant, revoke; no other project and no other agent is reached", { timeout: 180_000 }, async t => {
  const { call, home } = await boot(t);
  for (const n of ["northwind", "harlow"]) assert.ok(!(await call("projects.create", { name: n, home: home(n) })).error, n);
  for (const a of ["kit", "other"]) assert.ok(!(await call("agents.create", { name: a, projects: [] })).error, a);
  assert.equal(await granted(call, "northwind", "kit"), false, "deny by default");
  const g = await call("projects.access.grant", { project: "northwind", agent: "kit" });
  assert.ok(!g.error, JSON.stringify(g));
  const chk = await call("projects.access.check", { project: "northwind", agent: "kit" });
  assert.equal(chk.data.granted, true, JSON.stringify([chk, await call("projects.access.list", {})]));
  assert.equal(await granted(call, "harlow", "kit"), false, "another project is not reached");
  assert.equal(await granted(call, "northwind", "other"), false, "another agent is not reached");
  const list = (await call("projects.access.list", {})).data.grants;
  assert.deepEqual(list.map((/** @type {any} */ x) => [x.agent, x.status]), [["kit", "active"]]);
  assert.ok(!(await call("projects.access.revoke", { project: "northwind", agent: "kit" })).error);
  assert.equal(await granted(call, "northwind", "kit"), false, "taken away");
  assert.deepEqual((await call("projects.access.list", {})).data.grants, []);
});

test("without the person's proof nothing is granted: a grant is a person's act with the kernel's own proof", { timeout: 180_000 }, async t => {
  const { call, home, SI_FACTS } = await boot(t);
  assert.ok(!(await call("projects.create", { name: "northwind", home: home("n") })).error);
  assert.ok(!(await call("agents.create", { name: "kit", projects: [] })).error);
  const noProof = await call("projects.access.grant", { project: "northwind", agent: "kit" }, { kernelFacts: SI_FACTS });
  assert.ok(noProof.error, "no proof, no grant");
  assert.equal(await granted(call, "northwind", "kit"), false);
});

test("an agent's projects list is kept in step with its grants, '*' is one grant on every project (later ones too), and deleting the agent takes them away", { timeout: 180_000 }, async t => {
  const { call, home } = await boot(t);
  for (const n of ["northwind", "harlow"]) assert.ok(!(await call("projects.create", { name: n, home: home(n) })).error, n);
  const made = await call("agents.create", { name: "kit", projects: ["northwind"] });
  assert.ok(!made.error, JSON.stringify(made));
  assert.equal(await granted(call, "northwind", "kit"), true);
  assert.equal(await granted(call, "harlow", "kit"), false);
  { const r = await call("agents.update", { agent: "kit", projects: ["harlow"] }); assert.ok(!r.error, JSON.stringify(r)); }
  assert.equal(await granted(call, "northwind", "kit"), false, "dropped from its list: revoked");
  assert.equal(await granted(call, "harlow", "kit"), true);
  { const r = await call("agents.update", { agent: "kit", projects: "*" }); assert.ok(!r.error, JSON.stringify(r)); }
  assert.equal(await granted(call, "northwind", "kit"), true);
  assert.ok(!(await call("projects.create", { name: "later", home: home("later") })).error);
  assert.equal(await granted(call, "later", "kit"), true, "a project made after the grant is reached too");
  { const r = await call("agents.delete", { agent: "kit" }); assert.ok(!r.error, JSON.stringify(r)); }
  assert.equal(await granted(call, "harlow", "kit"), false, "a deleted agent reaches nothing");
});

test("an agent's grants are keyed by its stable id: a deleted agent's name given to a new agent inherits nothing, and a delete with no person is refused", { timeout: 180_000 }, async t => {
  const { d, call, home, SI_FACTS } = await boot(t);
  assert.ok(!(await call("projects.create", { name: "northwind", home: home("n") })).error);
  const made = await call("agents.create", { name: "kit", projects: ["northwind"] });
  assert.ok(!made.error, JSON.stringify(made));
  const uid = made.data.uid;
  assert.match(uid, /^agt_[0-9a-f-]{36}$/, "a stable id");
  assert.equal(await granted(call, "northwind", "kit"), true);
  const grants = (await d.kernel.gateway.grants.list(d.kernel.chains.fromFacts(SI_FACTS), {}));
  const mine = (Array.isArray(grants) ? grants : grants.grants).filter((/** @type {any} */ g) => g.actions.includes("project.reach") && g.subject.kind === "actor" && g.subject.actor.kind === "agent");
  assert.ok(mine.length > 0 && mine.every((/** @type {any} */ g) => g.subject.actor.id === uid), "the grant names the id, not the name");
  // a delete that carries no person is refused, and nothing is deleted
  const bare = await d.registry.call("agents.delete", { agent: "kit" }, "cli", {});
  assert.equal(bare.error && bare.error.code, "denied", JSON.stringify(bare));
  assert.equal(await granted(call, "northwind", "kit"), true, "the agent and its reach are untouched");
  // the person's delete, then a new agent with the same name: new id, no reach
  assert.ok(!(await call("agents.delete", { agent: "kit" })).error);
  const again = await call("agents.create", { name: "kit", projects: [] });
  assert.ok(!again.error, JSON.stringify(again));
  assert.notEqual(again.data.uid, uid, "never the same id");
  assert.equal(await granted(call, "northwind", "kit"), false, "the name given again inherits nothing");
});
