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
import { projectGroups } from "./project-groups.js";
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
  const pg = projectGroups({ file, work, vyre: { uid: VYRE, gid: VYRE }, groups: [WORKGID], owners: uid => uid === VYRE || uid === AGENT || (uid >= 2000 && uid <= 2063) });
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
