// @ts-check
// Real uids, as root, on Linux only (the box image, or a hosted runner with sudo): account A's
// credentials and transcripts against account B, and vyred's own reach. Skipped anywhere else.
//   sudo node --test core/spawner/isolation.test.js        (needs /usr/bin/setpriv and /usr/bin/tini)
// Proves the ruling: credentials stay 0600 and owned by the account's uid; transcripts sit where
// vyred (in every account's group) can read them and no other account can.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { serve } from "./server.js";
import { spawnAsAgent } from "./client.js";
import { SCRATCH } from "../../test/scratch.mjs";

const root = process.platform === "linux" && process.getuid && process.getuid() === 0 && fs.existsSync("/usr/bin/setpriv") && fs.existsSync("/usr/bin/tini");
const A = 2000, B = 2001, VYRE = 1000;

const exited = p => new Promise(resolve => p.once("exit", (code, signal) => resolve({ code, signal })));
const as = (uid, groups, ...argv) => spawnSync("/usr/bin/setpriv", [`--reuid=${uid}`, `--regid=${uid}`, groups.length ? `--groups=${groups.join(",")}` : "--clear-groups", "--", ...argv], { encoding: "utf8" });

test("isolation: B cannot read A's credentials or transcripts; vyred reads both accounts' transcripts", { skip: root ? false : "needs root on Linux with setpriv and tini" }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-iso-"));
  fs.chmodSync(dir, 0o755);
  const acct = path.join(dir, "acct"), work = path.join(dir, "work");
  fs.mkdirSync(work, { mode: 0o777 });
  for (const uid of [A, B]) { const h = path.join(acct, String(uid)); fs.mkdirSync(h, { recursive: true }); fs.chownSync(h, uid, uid); fs.chmodSync(h, 0o700); }
  fs.chmodSync(acct, 0o755);
  const socket = path.join(dir, "s.sock");
  const srv = await serve({ socket, allow: ["/bin/sh"], work, agent: { uid: 1001, gid: 1001, groups: [] },
    makeDir: (d, who) => execFileSync("/usr/bin/setpriv", [`--reuid=${who.uid}`, `--regid=${who.gid}`, "--clear-groups", "--", "/bin/mkdir", "-p", d]),
    grantGroup: (d, who) => execFileSync("/usr/bin/setpriv", [`--reuid=${who.uid}`, `--regid=${who.gid}`, "--clear-groups", "--", "/bin/chmod", "710", d]),
    accounts: { min: 2000, max: 2063, home: acct, shared: [] } });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  // Each account's session writes a credential (0600, as a CLI does) and a transcript.
  for (const uid of [A, B]) {
    const p = await spawnAsAgent(["/bin/sh", "-c", `umask 077; echo secret-${uid} > "$HOME/auth.json"; umask 002; mkdir -p "$HOME/.claude/projects"; echo transcript-${uid} > "$HOME/.claude/projects/s.jsonl"`], { socket, cwd: path.join(acct, String(uid)), account: uid });
    assert.equal((await exited(p)).code, 0);
  }
  const ga = path.join(acct, String(A)), gb = path.join(acct, String(B));
  // B, in no group of A's, gets nothing of A's.
  for (const f of ["auth.json", ".claude/projects/s.jsonl"]) {
    const r = as(B, [], "/bin/cat", path.join(ga, f));
    assert.notEqual(r.status, 0, `B read A's ${f}`);
    assert.ok(!r.stdout.includes("secret-") && !r.stdout.includes("transcript-"));
  }
  assert.notEqual(as(B, [], "/bin/ls", ga).status, 0);
  // vyred (uid 1000, in both accounts' groups): the transcripts yes, the credentials no (0600 is the owner's).
  const vy = [A, B];
  assert.equal(as(VYRE, vy, "/bin/cat", path.join(ga, ".claude/projects/s.jsonl")).stdout.trim(), `transcript-${A}`);
  assert.equal(as(VYRE, vy, "/bin/cat", path.join(gb, ".claude/projects/s.jsonl")).stdout.trim(), `transcript-${B}`);
  assert.notEqual(as(VYRE, vy, "/bin/cat", path.join(ga, "auth.json")).status, 0, "0600: owner only");
  // The HOME itself is 710: vyred can walk in but not list it.
  assert.notEqual(as(VYRE, vy, "/bin/ls", ga).status, 0, "no listing of the HOME");
});

const collect = stream => new Promise(resolve => { let out = ""; stream.setEncoding("utf8"); stream.on("data", d => (out += d)); stream.on("end", () => resolve(out)); });

test("isolation: a session under an account's uid reads its own approved skills from its HOME; another account is denied; a traversal or oversized set is refused; the library in Vyre's home is closed to it", { skip: root ? false : "needs root on Linux with setpriv and tini" }, async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-iso-")); fs.chmodSync(dir, 0o755);
  const acct = path.join(dir, "acct"), work = path.join(dir, "work"), vyreHome = path.join(dir, "vyrehome");
  fs.mkdirSync(work, { mode: 0o777 });
  for (const uid of [A, B]) { const h = path.join(acct, String(uid)); fs.mkdirSync(h, { recursive: true }); fs.chownSync(h, uid, uid); fs.chmodSync(h, 0o700); }
  fs.chmodSync(acct, 0o755);
  // Vyre's own home, where the skills module writes the library: owned by vyred, closed to everyone else (as in the box)
  const ID = "0123456789abcdef", lib = path.join(vyreHome, "materialised", "claude", ID, "skills", "okafor");
  fs.mkdirSync(lib, { recursive: true }); fs.writeFileSync(path.join(lib, "SKILL.md"), "BLUEBIRD-77"); fs.chownSync(vyreHome, VYRE, VYRE); fs.chmodSync(vyreHome, 0o700);
  const socket = path.join(dir, "s.sock");
  const srv = await serve({ socket, allow: ["/bin/sh"], work, agent: { uid: 1001, gid: 1001, groups: [] },
    makeDir: (d, who) => execFileSync("/usr/bin/setpriv", [`--reuid=${who.uid}`, `--regid=${who.gid}`, "--clear-groups", "--", "/bin/mkdir", "-p", d]),
    grantGroup: (d, who) => execFileSync("/usr/bin/setpriv", [`--reuid=${who.uid}`, `--regid=${who.gid}`, "--clear-groups", "--", "/bin/chmod", "710", d]),
    accounts: { min: 2000, max: 2063, home: acct, shared: [] } });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const set = (/** @type {string} */ id, /** @type {number} */ n) => ({ [`.vyre-skills/${id}/skills/okafor/SKILL.md`]: "BLUEBIRD-77", [`.vyre-skills/${id}/.claude-plugin/plugin.json`]: "{}", ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`.vyre-skills/${id}/skills/s${i}/SKILL.md`, `skill ${i}\n`])) });
  const run = async (/** @type {number} */ uid, /** @type {string} */ script, /** @type {any} */ seed) => { const p = await spawnAsAgent(["/bin/sh", "-c", script], { socket, cwd: work, account: uid, ...(seed ? { seed } : {}) }); const out = collect(p.stdout); const x = await exited(p); return { code: x.code, out: (await out).trim() }; };
  // the situation before: the library in Vyre's home is closed to the account's session (nothing opens it)
  assert.notEqual((await run(A, `cat ${path.join(lib, "SKILL.md")}`)).code, 0, "the library in Vyre's home is closed to the account's session");
  // now: 40 files (far over an ordinary seed's 8) are written into A's HOME as A, and A's session reads its skill there
  const mine = await run(A, `cat "$HOME/.vyre-skills/${ID}/skills/okafor/SKILL.md"`, set(ID, 40));
  assert.deepEqual(mine, { code: 0, out: "BLUEBIRD-77" }, "her session reads her skill");
  const ga = path.join(acct, String(A));
  assert.equal(as(A, [], "/usr/bin/stat", "-c", "%a %U", path.join(ga, ".vyre-skills", ID, "skills", "okafor", "SKILL.md")).stdout.trim().split(" ")[0], "600", "a file is 0600");
  assert.equal(as(A, [], "/usr/bin/stat", "-c", "%a", path.join(ga, ".vyre-skills", ID, "skills")).stdout.trim(), "700", "a folder is 0700");
  // B, another account, reads nothing of it; vyred (in A's group, which only walks) cannot read it either
  assert.notEqual(as(B, [], "/bin/cat", path.join(ga, ".vyre-skills", ID, "skills", "okafor", "SKILL.md")).status, 0, "another account is denied");
  assert.notEqual(as(VYRE, [A, B], "/bin/cat", path.join(ga, ".vyre-skills", ID, "skills", "okafor", "SKILL.md")).status, 0, "and so is vyred: it cannot read a person's private set");
  // a traversal key and an oversized set are refused before anything is written
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account: A, seed: { [`.vyre-skills/${ID}/../../.ssh/authorized_keys`]: "x" } }), /seed is up to 8|a skills set is one content id/);
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: work, account: A, seed: set(ID, 200) }), /send a smaller set/);
  assert.ok(!fs.existsSync(path.join(ga, ".ssh")), "and nothing was written outside the set");
  // a link planted under her skills folder is not followed when the next set is written; the older set is pruned
  const NEW = "fedcba9876543210";
  fs.symlinkSync("/etc", path.join(ga, ".vyre-skills", "aaaaaaaaaaaaaaaa")); fs.chownSync(path.join(ga, ".vyre-skills", "aaaaaaaaaaaaaaaa"), A, A);
  await run(A, "true", set(NEW, 3));
  assert.deepEqual(fs.readdirSync(path.join(ga, ".vyre-skills")).sort(), [NEW], "only the current set stays, and the planted link is removed, not followed");
  assert.ok(fs.existsSync("/etc/passwd"));
});
