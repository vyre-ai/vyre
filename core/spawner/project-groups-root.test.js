// @ts-check
// Real uids, as root, on Linux only (the box image, or a hosted runner with sudo): two projects on one /work, a member on each, the daemon, and a folder that existed before the groups did.
//   sudo node --test core/spawner/project-groups-root.test.js        (needs /usr/bin/setpriv)
// The regression for the measured fixture in PROJECT-GROUPS.md section 1: a session of a member on project A read and wrote project B's folder and listed /work.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { serve } from "./server.js";
import { spawnAsAgent, projectGroup } from "./client.js";
import { projectGroups, prepareWork } from "./project-groups.js";
import { SCRATCH } from "../../test/scratch.mjs";

const root = process.platform === "linux" && process.getuid && process.getuid() === 0 && fs.existsSync("/usr/bin/setpriv");
const A = 2000, B = 2001, VYRE = 1000, AGENT = 1001, WORKGID = 1002;
const collect = stream => new Promise(resolve => { let out = ""; stream.setEncoding("utf8"); stream.on("data", d => (out += d)); stream.on("end", () => resolve(out)); });
const exited = p => new Promise(resolve => p.once("exit", (code, signal) => resolve({ code, signal })));
const as = (uid, groups, ...argv) => spawnSync("/usr/bin/setpriv", [`--reuid=${uid}`, `--regid=${uid}`, groups.length ? `--groups=${groups.join(",")}` : "--clear-groups", "--", ...argv], { encoding: "utf8" });

/** A /work as the box makes it: vyre:vyre-work, 2711, two projects that already hold files (the group the old rule gave them), one made by an account. */
async function box(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-pgr-")); fs.chmodSync(dir, 0o755);
  const work = path.join(dir, "work"), acct = path.join(dir, "acct"), file = path.join(dir, "table.json");
  fs.mkdirSync(work); fs.chownSync(work, VYRE, WORKGID); fs.chmodSync(work, 0o2711);
  const mk = (/** @type {string} */ p, /** @type {number} */ uid, /** @type {number} */ gid, /** @type {number} */ mode) => { fs.mkdirSync(p, { recursive: true }); fs.chownSync(p, uid, gid); fs.chmodSync(p, mode); };
  const put = (/** @type {string} */ p, /** @type {string} */ text, /** @type {number} */ uid, /** @type {number} */ gid, /** @type {number} */ mode) => { fs.writeFileSync(p, text); fs.chownSync(p, uid, gid); fs.chmodSync(p, mode); };
  for (const p of ["alpha", "beta"]) {
    mk(path.join(work, p), VYRE, WORKGID, 0o2770);
    put(path.join(work, p, "notes.txt"), `${p}-vyre`, VYRE, WORKGID, 0o660);
    mk(path.join(work, p, "sub"), A, WORKGID, 0o2775);   // made by an account before the groups existed
    put(path.join(work, p, "sub", "made.txt"), `${p}-made-by-account`, A, WORKGID, 0o664);
  }
  for (const uid of [A, B]) { const h = path.join(acct, String(uid)); mk(h, uid, uid, 0o700); }
  fs.chmodSync(acct, 0o711);
  const pg = projectGroups({ file, work, containers: [path.join(work, "projects")], vyre: { uid: VYRE, gid: VYRE }, groups: [WORKGID], owners: uid => uid === VYRE || uid === AGENT || (uid >= 2000 && uid <= 2063) });
  const socket = path.join(dir, "s.sock");
  // the default wrap without tini (the test boxes have none; tini is only the subreaper)
  const wrap = (/** @type {string[]} */ argv, /** @type {string} */ cwd, /** @type {any} */ who) => ["/usr/bin/setpriv", `--reuid=${who.uid}`, `--regid=${who.gid}`, who.groups.length ? `--groups=${who.groups.join(",")}` : "--clear-groups", "--inh-caps=-all", "--",
    "/bin/sh", "-c", 'umask 002; cd "$1" || exit 126; shift; exec "$@"', "sh", cwd, ...argv];
  const srv = await serve({ socket, allow: ["/bin/sh"], work, agent: { uid: AGENT, gid: AGENT, groups: [WORKGID] }, projects: pg, wrap,
    makeDir: (d, who) => spawnSync("/usr/bin/setpriv", [`--reuid=${who.uid}`, `--regid=${who.gid}`, "--clear-groups", "--", "/bin/mkdir", "-p", d]),
    grantGroup: () => {}, accounts: { min: 2000, max: 2063, home: acct, shared: [WORKGID] } });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, work, acct, socket, pg, file };
}

const run = async (/** @type {string} */ socket, /** @type {number} */ uid, /** @type {string[]} */ projects, /** @type {string} */ cwd, /** @type {string} */ script) => {
  const p = await spawnAsAgent(["/bin/sh", "-c", script], { socket, cwd, account: uid, projects });
  const out = collect(p.stdout), err = collect(p.stderr); const r = await exited(p); return { code: r.code, out: await out, err: await err };
};

test("project groups, real uids: a member on project A works in A and is denied in B and in the list of /work; the daemon and the box agent reach both", { skip: root ? false : "needs root on Linux with setpriv" }, async t => {
  const { work, socket } = await box(t);
  // a loose file directly under /work: the old shared group's, for the daemon and the box agent
  fs.writeFileSync(path.join(work, "loose.txt"), "loose"); fs.chownSync(path.join(work, "loose.txt"), VYRE, WORKGID); fs.chmodSync(path.join(work, "loose.txt"), 0o660);
  const alpha = await projectGroup("alpha", path.join(work, "alpha"), { socket }), beta = await projectGroup("beta", path.join(work, "beta"), { socket });
  assert.notEqual(alpha.gid, beta.gid);
  assert.equal(fs.statSync(path.join(work, "alpha")).gid, alpha.gid);
  assert.equal(fs.statSync(path.join(work, "alpha")).mode & 0o7777, 0o2770);

  // A, on alpha only
  const mine = await run(socket, A, ["alpha"], path.join(work, "alpha"), "cat notes.txt && echo new > fresh.txt && cat sub/made.txt");
  assert.deepEqual([mine.code, mine.out], [0, "alpha-vyrealpha-made-by-account"], mine.err);
  const other = path.join(work, "beta");
  for (const cmd of [`cat ${other}/notes.txt`, `cat ${other}/sub/made.txt`, `echo x > ${other}/planted.txt`, `ls ${other}`, `ls ${work}`, `touch ${work}/new.txt`, `cat ${work}/loose.txt`]) {
    const r = await run(socket, A, ["alpha"], path.join(work, "alpha"), cmd);
    assert.notEqual(r.code, 0, `${cmd} should be denied`);
    assert.match(r.err, /Permission denied/, cmd);
  }
  assert.ok(!fs.existsSync(path.join(other, "planted.txt")));
  // a file A made keeps the project's group (setgid) and is group-writable, so the team and the daemon reach it
  const fresh = fs.statSync(path.join(work, "alpha", "fresh.txt"));
  assert.deepEqual([fresh.uid, fresh.gid, fresh.mode & 0o777], [A, alpha.gid, 0o664]);
  // B, on beta only, and a member who is on both
  assert.equal((await run(socket, B, ["beta"], path.join(work, "beta"), "cat notes.txt")).out, "beta-vyre");
  assert.notEqual((await run(socket, B, ["beta"], path.join(work, "beta"), `cat ${work}/alpha/notes.txt`)).code, 0);
  assert.equal((await run(socket, A, ["alpha", "beta"], work.concat("/beta"), `cat ${work}/alpha/notes.txt ${work}/beta/notes.txt`)).out, "alpha-vyrebeta-vyre");
  // a member on no project (or the shared flag only) reaches neither
  assert.notEqual((await run(socket, A, [], path.join(work, "alpha"), "cat notes.txt")).code, 0);

  // the daemon (vyre in every project group) reads what the account made, in both projects; the box agent likewise
  const range = [alpha.gid, beta.gid];
  for (const [uid, groups] of [[VYRE, range], [AGENT, range]]) {
    for (const f of ["alpha/fresh.txt", "alpha/sub/made.txt", "beta/sub/made.txt", "beta/notes.txt"]) {
      assert.equal(as(uid, groups, "/bin/cat", path.join(work, f)).status, 0, `uid ${uid} reads ${f}`);
    }
    assert.equal(as(uid, groups, "/bin/sh", "-c", `echo more >> ${work}/beta/sub/made.txt`).status, 0, `uid ${uid} writes in beta`);
  }
  assert.equal(as(AGENT, [WORKGID], "/bin/cat", path.join(work, "loose.txt")).stdout, "loose", "the box agent (in the old group) reads a loose file");
  // a stranger uid in no project group reads nothing, and cannot list /work
  assert.notEqual(as(3000, [], "/bin/cat", path.join(work, "alpha/notes.txt")).status, 0);
  assert.notEqual(as(3000, [], "/bin/ls", work).status, 0);
});

test("project groups, real uids: a folder that existed before is migrated, files an account made included; twice changes nothing; a planted link is not followed", { skip: root ? false : "needs root on Linux with setpriv" }, async t => {
  const { work, socket } = await box(t);
  // a link inside alpha to beta's secret, and a hard-to-spot one to a file Vyre owns elsewhere
  fs.writeFileSync(path.join(work, "beta", "secret.txt"), "beta-secret"); fs.chownSync(path.join(work, "beta", "secret.txt"), VYRE, WORKGID); fs.chmodSync(path.join(work, "beta", "secret.txt"), 0o660);
  fs.symlinkSync(path.join(work, "beta", "secret.txt"), path.join(work, "alpha", "link-to-secret")); fs.lchownSync(path.join(work, "alpha", "link-to-secret"), VYRE, WORKGID);
  const before = fs.statSync(path.join(work, "beta", "secret.txt"));
  const alpha = await projectGroup("alpha", path.join(work, "alpha"), { socket });
  const after = fs.statSync(path.join(work, "beta", "secret.txt"));
  assert.deepEqual([after.gid, after.mode], [before.gid, before.mode], "a link in alpha did not carry the pass into beta's file");
  const sub = fs.statSync(path.join(work, "alpha", "sub")), made = fs.statSync(path.join(work, "alpha", "sub", "made.txt"));
  assert.deepEqual([sub.gid, made.gid], [alpha.gid, alpha.gid], "the folder an account made, and its file, are the project's now");
  assert.equal(sub.mode & 0o2070, 0o2070); assert.equal(made.mode & 0o060, 0o060);
  assert.equal(fs.statSync(path.join(work, "beta", "sub", "made.txt")).gid, WORKGID, "the other project is untouched until it is asked for");
  // A (on alpha) reads it; B (on beta) does not
  assert.equal((await run(socket, A, ["alpha"], path.join(work, "alpha"), "cat sub/made.txt")).out, "alpha-made-by-account");
  assert.notEqual((await run(socket, B, ["beta"], path.join(work, "beta"), `cat ${work}/alpha/sub/made.txt`)).code, 0);
  // twice: nothing changes (ctime is not touched when no change is needed), also when forced
  const c1 = fs.statSync(path.join(work, "alpha", "sub", "made.txt")).ctimeMs;
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await projectGroup("alpha", path.join(work, "alpha"), { socket })).migrated, false);
  assert.equal((await projectGroup("alpha", path.join(work, "alpha"), { socket, force: true })).migrated, true);
  assert.equal(fs.statSync(path.join(work, "alpha", "sub", "made.txt")).ctimeMs, c1, "a second pass changed nothing");
});

test("project groups, real uids: a link, a file, a folder not owned by Vyre and a folder inside another project are refused before anything changes", { skip: root ? false : "needs root on Linux with setpriv" }, async t => {
  const { work, socket } = await box(t);
  fs.symlinkSync(path.join(work, "beta"), path.join(work, "viabeta")); fs.lchownSync(path.join(work, "viabeta"), VYRE, WORKGID);
  fs.writeFileSync(path.join(work, "afile"), "x"); fs.chownSync(path.join(work, "afile"), VYRE, WORKGID);
  fs.mkdirSync(path.join(work, "theirs")); fs.chownSync(path.join(work, "theirs"), A, A);
  fs.mkdirSync(path.join(work, "alpha", "inner"), { recursive: true }); fs.chownSync(path.join(work, "alpha", "inner"), VYRE, WORKGID);
  await assert.rejects(projectGroup("p1", path.join(work, "viabeta"), { socket }), /goes through a link|is not a folder/);
  await assert.rejects(projectGroup("p1", work + "/alpha/../viabeta", { socket }), /absolute path with no \.\./);
  await assert.rejects(projectGroup("p2", path.join(work, "afile"), { socket }), /is not a folder/);
  await assert.rejects(projectGroup("p3", path.join(work, "theirs"), { socket }), /owned by uid 2000, not by Vyre/);
  await assert.rejects(projectGroup("p4", path.join(work, "nothing"), { socket }), /cannot be reached/);
  await projectGroup("alpha", path.join(work, "alpha"), { socket });
  await assert.rejects(projectGroup("p5", path.join(work, "alpha", "inner"), { socket }), /overlaps .*alpha/);
  assert.equal(fs.statSync(path.join(work, "beta")).gid, WORKGID, "none of them touched beta");
  assert.equal(fs.statSync(path.join(work, "theirs")).gid, A);
});

test("project groups, real uids: a project at /work/projects/<slug> is reached through a folder the member passes but cannot list; one owned by someone else stops the pass", { skip: root ? false : "needs root on Linux with setpriv" }, async t => {
  const { work, socket } = await box(t);
  const projects = path.join(work, "projects");
  for (const p of ["gamma", "delta"]) { fs.mkdirSync(path.join(projects, p), { recursive: true }); fs.chownSync(path.join(projects, p), VYRE, WORKGID); fs.chmodSync(path.join(projects, p), 0o2775); fs.writeFileSync(path.join(projects, p, "f.txt"), p); fs.chownSync(path.join(projects, p, "f.txt"), VYRE, WORKGID); }
  fs.chownSync(projects, VYRE, WORKGID); fs.chmodSync(projects, 0o2770);
  await assert.rejects(projectGroup("gamma", projects, { socket }), /holds project folders/, "the container is not a project");
  await projectGroup("gamma", path.join(projects, "gamma"), { socket });
  await projectGroup("delta", path.join(projects, "delta"), { socket });
  assert.equal(fs.statSync(projects).mode & 0o7777, 0o2771, "the folder holding projects is passed through by anyone");
  assert.equal((await run(socket, A, ["gamma"], path.join(projects, "gamma"), "cat f.txt")).out, "gamma");
  assert.match((await run(socket, A, ["gamma"], path.join(projects, "gamma"), `ls ${projects}`)).err, /Permission denied/, "a member cannot list the folder to find the other projects");
  const out = await run(socket, A, ["gamma"], path.join(projects, "gamma"), `cat ${projects}/delta/f.txt; ls ${projects}`);
  assert.notEqual(out.code, 0);
  assert.equal(out.out, "", "neither delta's file nor the list of projects");
  // a folder holding the project that is not Vyre's cannot be made passable
  fs.mkdirSync(path.join(work, "theirs", "epsilon"), { recursive: true }); fs.chownSync(path.join(work, "theirs"), A, A); fs.chownSync(path.join(work, "theirs", "epsilon"), VYRE, WORKGID);
  await assert.rejects(projectGroup("epsilon", path.join(work, "theirs", "epsilon"), { socket }), /holds the project folder, is owned by uid 2000/);
});

test("project groups, real uids: at start /work becomes 2711 and the folders in it lose their other bits, links untouched, nothing inside changed; a second start changes nothing", { skip: root ? false : "needs root on Linux with setpriv" }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-pgr-")); fs.chmodSync(dir, 0o755);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const work = path.join(dir, "work");
  const mk = (/** @type {string} */ p, /** @type {number} */ mode) => { fs.mkdirSync(p, { recursive: true }); fs.chownSync(p, VYRE, WORKGID); fs.chmodSync(p, mode); };
  mk(work, 0o2770); mk(path.join(work, "old-project"), 0o2775); mk(path.join(work, "projects"), 0o2775); mk(path.join(work, "projects", "acme"), 0o2775); mk(path.join(work, "projects", "acme", "inside"), 0o2775);
  fs.symlinkSync("/etc", path.join(work, "to-etc"));
  const asVyre = (/** @type {string[]} */ ...argv) => { const r = spawnSync("/usr/bin/setpriv", [`--reuid=${VYRE}`, `--regid=${VYRE}`, `--groups=${WORKGID}`, "--inh-caps=-all", "--", ...argv]); if (r.status !== 0) throw new Error(String(r.stderr)); };
  const mode = (/** @type {string} */ p) => fs.lstatSync(p).mode & 0o7777;
  prepareWork({ work, shared: WORKGID, asVyre });
  assert.equal(mode(work), 0o2711);
  assert.equal(mode(path.join(work, "old-project")), 0o2770, "a folder directly in /work is closed to others");
  assert.equal(mode(path.join(work, "projects")), 0o2771, "the folder holding projects is passed through by others, never listed by them");
  assert.equal(mode(path.join(work, "projects", "acme")), 0o2770, "a project folder is closed to others");
  assert.equal(mode(path.join(work, "projects", "acme", "inside")), 0o2775, "what is inside is left alone");
  assert.ok(fs.lstatSync(path.join(work, "to-etc")).isSymbolicLink());
  const c = fs.statSync(work).ctimeMs; await new Promise(r => setTimeout(r, 30));
  prepareWork({ work, shared: WORKGID, asVyre });
  assert.equal(fs.statSync(work).ctimeMs, c, "a second start changes nothing");
});

test("project groups, real uids: an old-layout /work (vyre-work 2770, projects in it): the agent works in a project before the upgrade and after its first ensure, with no vyre-work; loose files are named in the notice", { skip: root ? false : "needs root on Linux with setpriv" }, async t => {
  const { work, socket } = await box(t);
  fs.writeFileSync(path.join(work, "loose.txt"), "loose"); fs.chownSync(path.join(work, "loose.txt"), VYRE, WORKGID); fs.chmodSync(path.join(work, "loose.txt"), 0o660);
  fs.chmodSync(work, 0o2770);   // the old mode
  // before: the agent holds vyre-work and works in alpha
  assert.equal(as(AGENT, [WORKGID], "/bin/sh", "-c", `echo before >> ${work}/alpha/notes.txt`).status, 0);
  // upgrade: /work is prepared, the agent drops vyre-work and holds only the range
  const asVyre = (/** @type {string[]} */ ...argv) => { const r = spawnSync("/usr/bin/setpriv", [`--reuid=${VYRE}`, `--regid=${VYRE}`, `--groups=${WORKGID}`, "--inh-caps=-all", "--", ...argv]); if (r.status !== 0) throw new Error(String(r.stderr)); };
  const said = /** @type {string[]} */ ([]);
  const loose = prepareWork({ work, shared: WORKGID, asVyre, log: m => said.push(m) });
  assert.deepEqual(loose, ["loose.txt"]); assert.match(said.join("\n"), /loose file\(s\).*loose\.txt.*move what a session needs/);
  assert.notEqual(as(AGENT, [], "/bin/cat", path.join(work, "alpha/notes.txt")).status, 0, "before its first ensure the project is closed to a session with no group");
  const alpha = await projectGroup("alpha", path.join(work, "alpha"), { socket });
  const after = as(AGENT, [alpha.gid], "/bin/sh", "-c", `cat ${work}/alpha/notes.txt && echo after >> ${work}/alpha/notes.txt && cat ${work}/alpha/sub/made.txt`);
  assert.equal(after.status, 0, after.stderr); assert.match(after.stdout, /alpha-vyrebefore\nalpha-made-by-account/);
  assert.notEqual(as(AGENT, [alpha.gid], "/bin/cat", path.join(work, "loose.txt")).status, 0, "a loose file is vyred's alone now, and was said so");
  assert.notEqual(as(AGENT, [alpha.gid], "/bin/cat", path.join(work, "beta/notes.txt")).status, 0, "another project's tree is still closed");
});

test("project groups, real uids: a path that leaves /work, a link in the middle of it, or one with .. is refused and nothing outside /work is regrouped", { skip: root ? false : "needs root on Linux with setpriv" }, async t => {
  const { work, socket, dir } = await box(t);
  const outside = path.join(dir, "outside"); fs.mkdirSync(path.join(outside, "proj"), { recursive: true }); fs.chownSync(path.join(outside, "proj"), VYRE, WORKGID); fs.chownSync(outside, VYRE, WORKGID);
  fs.writeFileSync(path.join(outside, "proj", "f"), "x"); fs.chownSync(path.join(outside, "proj", "f"), VYRE, WORKGID);
  fs.symlinkSync(outside, path.join(work, "out")); fs.lchownSync(path.join(work, "out"), VYRE, WORKGID);
  await assert.rejects(projectGroup("o1", path.join(outside, "proj"), { socket }), /outside .*work/);
  await assert.rejects(projectGroup("o2", path.join(work, "out", "proj"), { socket }), /link|cannot be reached|not a folder/);
  await assert.rejects(projectGroup("o3", `${work}/alpha/../../outside/proj`, { socket }), /no \.\./);
  await assert.rejects(projectGroup("o4", "/etc", { socket }), /outside .*work/);
  assert.equal(fs.statSync(path.join(outside, "proj")).gid, WORKGID); assert.equal(fs.statSync(path.join(outside, "proj", "f")).gid, WORKGID, "nothing outside /work was regrouped");
});
