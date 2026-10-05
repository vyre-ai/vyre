// @ts-check
// An upgrade from before the Project hub (a 0.2.x home): the projects module has its four released migration steps applied and agents hold project access in the old table. The upgrade keeps every row,
// grants nothing by itself, raises ONE Needs-you item, and `projects.access.restore` (the person's own call) turns the rows into grants, leaving a revoke revoked.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { start } from "../core/daemon/index.js";
import { tempHome, present, kernelCaller } from "./helpers.js";
import { MIGRATIONS } from "../core/projects/projects.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const until = async (/** @type {() => Promise<any>} */ f, what, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };

test("a 0.2.x home upgrades: its access rows are kept, nothing is granted, one Needs-you item waits, and restoring makes the grants", { timeout: 240_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  const work = path.join(root, "Work"); fs.mkdirSync(path.join(work, "northwind"), { recursive: true });
  // 1. a home that has run once, then is put back as it was before the hub: the four released steps, the old tables, the old rows
  const first = await start({ root, presence: present, log: () => {}, kernel: true });
  assert.ok(!(await kernelCaller(first, root)("agents.create", { name: "kit", projects: [] })).error);
  await first.stop();
  const db = new DatabaseSync(path.join(root, "vyre.db"));
  db.exec("DROP TABLE IF EXISTS projects_folders; DROP TABLE IF EXISTS projects_access_legacy; DROP TABLE IF EXISTS projects_projects; DROP TABLE IF EXISTS projects_access; DROP TABLE IF EXISTS projects_access_seeded; DROP TABLE IF EXISTS projects_history; DROP TABLE IF EXISTS work_flags;");
  db.prepare("DELETE FROM _migrations WHERE module = 'projects'").run();
  for (const [i, step] of MIGRATIONS.slice(0, 4).entries()) { db.exec(step); db.prepare("INSERT INTO _migrations (module, version, at) VALUES ('projects', ?, 1)").run(i + 1); }
  db.prepare("INSERT INTO projects_access (id, project, agent, status, by, at) VALUES ('r1','northwind','kit','granted','cli',1)").run();
  db.prepare("INSERT INTO projects_access (id, project, agent, status, by, at) VALUES ('r2','northwind','other','revoked','cli',1)").run();
  db.close();
  // 2. the upgrade
  const d = await start({ root, presence: present, log: (/** @type {string} */ m) => { if (/access-restore|restore/.test(m)) console.log(m); }, kernel: true });
  t.after(() => d.stop());
  const call = kernelCaller(d, root);
  assert.equal((await call("projects.access.pending", {})).data.pending, 2, "the rows came through the migration");
  assert.ok(!(await call("projects.create", { name: "northwind", home: path.join(work, "northwind") })).error);
  assert.equal((await call("projects.access.check", { project: "northwind", agent: "kit" })).data.granted, false, "nothing is granted by the upgrade");
  // 3. exactly one Needs-you item, for the owner
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const item = await until(async () => (await d.kernel.gateway.ask.needsYou(owner)).find((/** @type {any} */ x) => /Restore who could see your projects/.test(x.title)), "the Needs-you item");
  assert.ok(item.id);
  assert.match(String(item.note || item.title), /northwind \(1\)|Restore who could see your projects/, "the item lists what waits");
  assert.equal((await d.kernel.gateway.ask.needsYou(owner)).filter((/** @type {any} */ x) => /Restore who could see/.test(x.title)).length, 1);
  // 4. ONE yes: the owner approves the item, and the Work service carries out exactly that act, once, as them
  const row = await d.kernel.gateway.ask.get(owner, item.id);
  assert.equal(row.state, "needs_check", "the item waits on the owner's check");
  await d.kernel.gateway.ask.decide(owner, item.id, { outcome: "approved", proof: { method: "stand-in" } });
  await until(async () => (await call("projects.access.check", { project: "northwind", agent: "kit" })).data.granted === true, "the grant");
  assert.equal((await call("projects.access.check", { project: "northwind", agent: "other" })).data.granted, false, "what was revoked stays revoked");
  await until(async () => (await call("projects.access.pending", {})).data.pending === 0, "the old rows to clear");
  // 5. a replay is refused: the approval was spent by the act
  const doer = d.kernel.chains.forModule({ module: "work", approver: owner });
  const replay = await d.kernel.gateway.authorize({ chain: doer, action: "projects.access.restore", resource: `vyre://${d.kernel.id.space}/project/*`, approval: item.id, bind: "x" });
  assert.notEqual(replay.effect, "allow", "the approval cannot be used again");
});

test("the yes covers the list it was shown: a row added after the item was raised stops the restore", { timeout: 240_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  const work = path.join(root, "Work"); fs.mkdirSync(path.join(work, "northwind"), { recursive: true });
  // 1. a home that has run once, then is put back as it was before the hub: the four released steps, the old tables, the old rows
  const first = await start({ root, presence: present, log: () => {}, kernel: true });
  assert.ok(!(await kernelCaller(first, root)("agents.create", { name: "kit", projects: [] })).error);
  await first.stop();
  const db = new DatabaseSync(path.join(root, "vyre.db"));
  db.exec("DROP TABLE IF EXISTS projects_folders; DROP TABLE IF EXISTS projects_access_legacy; DROP TABLE IF EXISTS projects_projects; DROP TABLE IF EXISTS projects_access; DROP TABLE IF EXISTS projects_access_seeded; DROP TABLE IF EXISTS projects_history; DROP TABLE IF EXISTS work_flags;");
  db.prepare("DELETE FROM _migrations WHERE module = 'projects'").run();
  for (const [i, step] of MIGRATIONS.slice(0, 4).entries()) { db.exec(step); db.prepare("INSERT INTO _migrations (module, version, at) VALUES ('projects', ?, 1)").run(i + 1); }
  db.prepare("INSERT INTO projects_access (id, project, agent, status, by, at) VALUES ('r1','northwind','kit','granted','cli',1)").run();
  db.prepare("INSERT INTO projects_access (id, project, agent, status, by, at) VALUES ('r2','northwind','other','revoked','cli',1)").run();
  db.close();
  // 2. the upgrade
  const d = await start({ root, presence: present, log: (/** @type {string} */ m) => { if (/access-restore|restore/.test(m)) console.log(m); }, kernel: true });
  t.after(() => d.stop());
  const call = kernelCaller(d, root);
  assert.equal((await call("projects.access.pending", {})).data.pending, 2, "the rows came through the migration");
  assert.ok(!(await call("projects.create", { name: "northwind", home: path.join(work, "northwind") })).error);
  assert.equal((await call("projects.access.check", { project: "northwind", agent: "kit" })).data.granted, false, "nothing is granted by the upgrade");
  // 3. exactly one Needs-you item, for the owner
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const item = await until(async () => (await d.kernel.gateway.ask.needsYou(owner)).find((/** @type {any} */ x) => /Restore who could see your projects/.test(x.title)), "the Needs-you item");
  assert.ok(item.id);
  assert.match(String(item.note || item.title), /northwind \(1\)|Restore who could see your projects/, "the item lists what waits");
  assert.equal((await d.kernel.gateway.ask.needsYou(owner)).filter((/** @type {any} */ x) => /Restore who could see/.test(x.title)).length, 1);
  // 4. a row appears after the item was raised: the approval was for the list the owner was shown, so the restore refuses
  const db2 = new DatabaseSync(path.join(root, "vyre.db"));
  db2.prepare("INSERT INTO projects_access_legacy (id, project, agent, status, by, at) VALUES ('r3','northwind','later','granted','cli',1)").run();
  db2.close();
  await d.kernel.gateway.ask.decide(owner, item.id, { outcome: "approved", proof: { method: "stand-in" } });
  await new Promise(r => setTimeout(r, 2500));
  assert.equal((await call("projects.access.check", { project: "northwind", agent: "kit" })).data.granted, false, "nothing was restored for a list nobody approved");
  assert.equal((await call("projects.access.pending", {})).data.pending, 3, "the rows are untouched");
});
