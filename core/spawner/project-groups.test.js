// @ts-check
// Project groups (team/0.3.4/PROJECT-GROUPS.md), the parts that need no root: the gid table, the folder rules, and what a spawn with `projects` runs as. The real uids and folders are
// core/spawner/project-groups-root.test.js.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { serve } from "./server.js";
import { spawnAsAgent, projectGroup } from "./client.js";
import { projectGroups, readTable, GID_MIN, GID_MAX } from "./project-groups.js";
import { SCRATCH } from "../../test/scratch.mjs";

const exited = p => new Promise(resolve => p.once("exit", (code, signal) => resolve({ code, signal })));
const VYRE = { uid: 1000, gid: 1000 };

/** A spawner with project groups whose folder pass is recorded instead of run. */
async function withGroups(t, { min, max, owners = () => true } = {}) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-pg-"));
  const work = path.join(dir, "work"), acct = path.join(dir, "acct"), file = path.join(dir, "table.json");
  fs.mkdirSync(path.join(work, "a"), { recursive: true }); fs.mkdirSync(path.join(work, "b")); fs.mkdirSync(path.join(acct, "2000"), { recursive: true });
  const passes = [], ran = [];
  const mk = () => projectGroups({ file, work, min, max, vyre: VYRE, owners, regroup: async (folder, gid) => { passes.push([folder, gid]); } });
  const socket = path.join(dir, "s.sock");
  const stat = d => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: Number(path.basename(d)), mode: 0o40700 });
  const srv = await serve({ socket, allow: ["/bin/sh"], work, agent: { uid: 1001, gid: 1001, groups: [1002] }, wrap: (argv, _cwd, who) => { ran.push(who); return argv; },
    accounts: { min: 2000, max: 2063, home: acct, shared: [1002], stat }, projects: mk() });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { socket, work, acct, file, passes, ran, mk };
}

test("project groups: a project gets a group from the range on first ask, the same one every time, and a second project another", async t => {
  const { socket, work, passes } = await withGroups(t);
  const a = await projectGroup("alpha", path.join(work, "a"), { socket });
  assert.equal(a.gid, GID_MIN);
  assert.equal(a.migrated, true);
  const again = await projectGroup("alpha", path.join(work, "a"), { socket });
  assert.deepEqual([again.gid, again.migrated], [GID_MIN, false], "asking again changes nothing");
  assert.equal(passes.length, 1, "the folder was handed over once");
  const b = await projectGroup("beta", path.join(work, "b"), { socket });
  assert.equal(b.gid, GID_MIN + 1);
  const forced = await projectGroup("alpha", path.join(work, "a"), { socket, force: true });
  assert.deepEqual([forced.gid, forced.migrated], [GID_MIN, true]);
  assert.equal(passes.length, 3, "force runs the pass again");
});

test("project groups: the table survives a restart and a group number is never given twice", async t => {
  const { socket, work, file, mk } = await withGroups(t);
  await projectGroup("alpha", path.join(work, "a"), { socket });
  await projectGroup("beta", path.join(work, "b"), { socket });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the table is private");
  const again = mk();   // a new spawner on the same file
  assert.deepEqual(again.gids(["beta", "alpha", "nobody"]), [GID_MIN + 1, GID_MIN], "the numbers are the ones the first spawner gave; an unknown project has none");
  fs.mkdirSync(path.join(work, "c"));
  const c = await again.ensure("gamma", path.join(work, "c"));
  assert.equal(c.gid, GID_MIN + 2, "the next project gets a number above every one given");
  assert.equal(readTable(file, GID_MIN, GID_MAX).next, GID_MIN + 3);
});

test("project groups: a table that cannot be read is not started over, in words that say what to do", async t => {
  const { socket, work, file } = await withGroups(t);
  await projectGroup("alpha", path.join(work, "a"), { socket });
  const good = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => readTable(file, GID_MIN, GID_MAX), /not valid JSON.*left as it is.*Restore it from a backup/);
  const dup = JSON.parse(good); dup.projects.other = { gid: dup.projects.alpha.gid, paths: {} }; dup.next = GID_MIN + 5;
  fs.writeFileSync(file, JSON.stringify(dup));
  assert.throws(() => readTable(file, GID_MIN, GID_MAX), /given to two projects/);
  const low = JSON.parse(good); low.next = GID_MIN;
  fs.writeFileSync(file, JSON.stringify(low));
  assert.throws(() => readTable(file, GID_MIN, GID_MAX), /next group number is not above/);
  fs.writeFileSync(file, "{ not json");
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json", "reading never rewrites it");
});

test("project groups: the folder rules, each refused with the folder that is wrong and a next step", async t => {
  const { socket, work } = await withGroups(t);
  await projectGroup("alpha", path.join(work, "a"), { socket });
  await assert.rejects(projectGroup("alpha", work, { socket }), /itself cannot be a project folder/);
  await assert.rejects(projectGroup("alpha", work + "/", { socket }), /absolute path with no \.\. or trailing slash/);
  await assert.rejects(projectGroup("alpha", work + "/a/../b", { socket }), /absolute path with no \.\./);
  await assert.rejects(projectGroup("alpha", "work/a", { socket }), /absolute path/);
  await assert.rejects(projectGroup("alpha", "/etc", { socket }), /outside .*project folders live under/);
  await assert.rejects(projectGroup("alpha", path.dirname(work), { socket }), /outside/);
  await assert.rejects(projectGroup("alpha", work + "x/a", { socket }), /outside/, "a sibling that only starts with the same letters is not inside");
  await assert.rejects(projectGroup("beta", path.join(work, "a"), { socket }), /overlaps .* belongs to another project \(alpha\)/);
  await assert.rejects(projectGroup("beta", path.join(work, "a", "deep"), { socket }), /overlaps/, "inside another project's tree");
  await assert.rejects(projectGroup("../x", path.join(work, "b"), { socket }), /project id is letters/);
  await assert.rejects(projectGroup("", path.join(work, "b"), { socket }), /project id is letters/);
  await assert.rejects(projectGroup("beta", /** @type {any} */ (7), { socket }), /absolute path/);
  const parent = path.join(work, "p");
  fs.mkdirSync(path.join(parent, "child"), { recursive: true });
  await projectGroup("gamma", path.join(parent, "child"), { socket });
  await assert.rejects(projectGroup("delta", parent, { socket }), /overlaps .*child.*gamma/, "a folder holding another project's folder cannot be handed over, or its files would be regrouped");
});

test("project groups: a server that has used its whole range refuses a new project, says why, and keeps the ones it has", async t => {
  const { socket, work } = await withGroups(t, { min: 20000, max: 20001 });
  fs.mkdirSync(path.join(work, "c"));
  assert.equal((await projectGroup("alpha", path.join(work, "a"), { socket })).gid, 20000);
  assert.equal((await projectGroup("beta", path.join(work, "b"), { socket })).gid, 20001);
  await assert.rejects(projectGroup("gamma", path.join(work, "c"), { socket }), /used all 2 project groups \(20000 to 20001\).*never reused/);
  assert.equal((await projectGroup("alpha", path.join(work, "a"), { socket })).gid, 20000, "a project that has one still answers");
});

test("project groups: a failed pass is told, leaves the folder not done, and the next ask tries again", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-pg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const work = path.join(dir, "work"); fs.mkdirSync(path.join(work, "a"), { recursive: true });
  let fail = true;
  const pg = projectGroups({ file: path.join(dir, "t.json"), work, vyre: VYRE, owners: () => true, regroup: async () => { if (fail) throw new Error("the pass as uid 1000 failed"); } });
  await assert.rejects(pg.ensure("alpha", path.join(work, "a")), /pass as uid 1000 failed/);
  fail = false;
  const r = await pg.ensure("alpha", path.join(work, "a"));
  assert.deepEqual([r.gid, r.migrated], [GID_MIN, true], "same number as before, and now done");
});

test("project groups: a spawn runs in exactly the groups of the projects it names; unknown ones are ignored; `shared` alone is no group", async t => {
  const { socket, work, acct, ran } = await withGroups(t);
  const ga = (await projectGroup("alpha", path.join(work, "a"), { socket })).gid, gb = (await projectGroup("beta", path.join(work, "b"), { socket })).gid;
  const go = async (opts) => { const p = await spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account: 2000, ...opts }); await exited(p); return ran[ran.length - 1].groups; };
  assert.deepEqual(await go({ projects: ["alpha"] }), [ga]);
  assert.deepEqual(await go({ projects: ["alpha", "beta"] }), [ga, gb]);
  assert.deepEqual(await go({ projects: ["beta", "ghost"] }), [gb], "an id the spawner does not know is ignored");
  assert.deepEqual(await go({ projects: [] }), []);
  assert.deepEqual(await go({}), [], "no list, no group");
  assert.deepEqual(await go({ shared: true }), [], "`shared` is accepted and means no group (the old /work group is not joined)");
  assert.deepEqual(await go({ shared: true, projects: ["beta"] }), [gb]);
  // the agent's own spawn (no account) is unchanged
  const a = await spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work }); await exited(a);
  assert.deepEqual(ran[ran.length - 1].groups, [1002]);
  // the account's own home is not a project
  const h = await spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: path.join(acct, "2000"), account: 2000, projects: ["alpha"] }); await exited(h);
  assert.deepEqual(ran[ran.length - 1].groups, [ga]);
});

test("project groups: what a spawn may carry in `projects` is checked, and a watcher takes none", async t => {
  const { socket, work } = await withGroups(t);
  const bad = (projects, why) => assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account: 2000, projects }), why);
  await bad(Array.from({ length: 65 }, (_, i) => "p" + i), /up to 64 project ids/);
  await bad(["ok", "../etc"], /up to 64 project ids/);
  await bad(["ok", 7], /up to 64 project ids/);
  await bad("alpha", /up to 64 project ids/);
  // the client sends projects only with an account; a hand-made request without one is refused all the same
  const raw = await new Promise(resolve => { const c = net.createConnection(socket, () => c.write(JSON.stringify({ op: "spawn", argv: ["/bin/sh", "-c", "true"], cwd: work, projects: ["alpha"] }) + "\n")); let b = ""; c.on("data", d => { b += d; c.end(); }); c.on("close", () => resolve(b)); });
  assert.match(String(raw), /projects are for an account/);
  const ok = await spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account: 2000, projects: Array.from({ length: 64 }, (_, i) => "p" + i) });
  assert.equal((await exited(ok)).code, 0, "64 is allowed");
});

test("project groups: a spawner without them refuses the op in words, and keeps the old single group", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-pg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const work = path.join(dir, "work"), acct = path.join(dir, "acct"), ran = [];
  fs.mkdirSync(work, { recursive: true }); fs.mkdirSync(path.join(acct, "2000"), { recursive: true });
  const socket = path.join(dir, "s.sock");
  const srv = await serve({ socket, allow: ["/bin/sh"], work, agent: { uid: 1001, gid: 1001, groups: [] }, wrap: (argv, _c, who) => { ran.push(who); return argv; },
    accounts: { min: 2000, max: 2063, home: acct, shared: [1002], stat: d => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: Number(path.basename(d)), mode: 0o40700 }) } });
  t.after(() => srv.close());
  await assert.rejects(projectGroup("alpha", path.join(work, "a"), { socket }), /this spawner has no project groups/);
  const p = await spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account: 2000, shared: true }); await exited(p);
  assert.deepEqual(ran[0].groups, [1002]);
});
