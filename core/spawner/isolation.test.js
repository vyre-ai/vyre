// @ts-check
// Real uids, as root, on Linux only (the box image, or a hosted runner with sudo): account A's
// credentials and transcripts against account B, and vyred's own reach. Skipped anywhere else.
//   sudo node --test core/spawner/isolation.test.js        (needs /usr/bin/setpriv and /usr/bin/tini)
// Proves the ruling: credentials stay 0600 and owned by the account's uid; transcripts sit where
// vyred (in every account's group) can read them and no other account can.

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
