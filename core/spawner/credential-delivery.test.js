// @ts-check
// A session's credential through the SPAWNER (the packaged box's path: vyred asks a root helper to start the session as an ACCOUNT's own uid). Real uids, as root, on Linux only (the box image, or a hosted runner with
// sudo; core/spawner/isolation.test.js is the same rig): skipped anywhere else.
//   sudo env "PATH=$PATH" node --test core/spawner/credential-delivery.test.js        (needs /usr/bin/setpriv and /usr/bin/tini)
// A stand-in for the CLI is started through spawnSession's spawner path (core/sessions/spawn.js viaSpawner) with a key or a setup token in its env, exactly as the Switchboard hands them; the spawner starts it as account 2000.
// The stand-in does what Claude Code does with a descriptor credential (reads *_FILE_DESCRIPTOR once) and then runs a "tool": a child shell that looks for the secret in its own environment, its parent's /proc environ,
// the parent's descriptors 3 and 4 (where a credential pipe sits; other descriptors can be this scan's own output pipe), its command line and the account's home. Where the runner image carries the real `claude`, it also asks `claude auth status` as that account. When the terminal role is present
// (core/spawner/server.js), a terminal shell started from the same session must read nothing on fd 3 and have no credential variable.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { serve } from "./server.js";
import { spawnSession } from "../sessions/spawn.js";
import { SCRATCH } from "../../test/scratch.mjs";

const root = process.platform === "linux" && process.getuid && process.getuid() === 0 && fs.existsSync("/usr/bin/setpriv") && fs.existsSync("/usr/bin/tini");
const A = 2000;
const SECRET = "FAKE-CRED-spawner-0123456789abcdef";
const NODE = fs.realpathSync(process.execPath);
const CLAUDE = (() => { for (const c of ["/usr/bin/claude", "/usr/local/bin/claude"]) if (fs.existsSync(c)) return fs.realpathSync(c); return ""; })();
const HAS_TERMINAL = fs.readFileSync(new URL("./server.js", import.meta.url), "utf8").includes('"terminal"');

/** The stand-in CLI: reads the credential off its descriptor once, then runs a tool-like child shell and reports what that child can see. */
const STAND_IN = `
const fs = require("fs"), cp = require("child_process");
const v = process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR || process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
let got = ""; try { got = fs.readFileSync(Number(v), "utf8"); } catch (e) { got = "ERR " + e.code; }
const scan = "S=\\"$1\\"; P=$PPID; echo env $(env | grep -c \\"$S\\"); echo environ $(tr '\\\\0' '\\\\n' < /proc/$P/environ 2>/dev/null | grep -c \\"$S\\"); echo cmdline $(tr '\\\\0' ' ' < /proc/$P/cmdline 2>/dev/null | grep -c \\"$S\\"); n=0; for f in /proc/$P/fd/3 /proc/$P/fd/4; do [ -e \\"$f\\" ] || continue; c=$(timeout 1 head -c 4096 \\"$f\\" 2>/dev/null | grep -c \\"$S\\"); n=$((n+c)); done; echo fd $n; echo home $(grep -rl \\"$S\\" \\"$HOME\\" 2>/dev/null | wc -l)";
const r = cp.spawnSync("/bin/sh", ["-c", scan, "sh", got], { encoding: "utf8" });
const out = { got_equals_secret: got === fs.readFileSync(__dirname + "/expected.txt", "utf8"), var: Object.keys(process.env).filter(k => /FILE_DESCRIPTOR$/.test(k)), ownEnvHasSecret: Object.values(process.env).some(x => x.includes(got)) };
for (const l of r.stdout.trim().split("\\n")) { const [k, n] = l.split(" "); out[k] = Number(n); }
process.stdout.write(JSON.stringify(out) + "\\n");
`;

const collect = child => new Promise(resolve => { let out = "", err = ""; child.stdout.on("data", d => (out += d)); child.stderr.on("data", d => (err += d)); child.on("exit", code => resolve({ code, out, err })); });

async function rig(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-cred-"));
  fs.chmodSync(dir, 0o755);
  const acct = path.join(dir, "acct"), work = path.join(dir, "work"), bin = path.join(dir, "bin");
  fs.mkdirSync(work, { mode: 0o777 }); fs.mkdirSync(bin, { mode: 0o755 });
  const h = path.join(acct, String(A)); fs.mkdirSync(h, { recursive: true }); fs.chownSync(h, A, A); fs.chmodSync(h, 0o700); fs.chmodSync(acct, 0o755);
  const script = path.join(bin, "stand-in.js"); fs.writeFileSync(script, STAND_IN, { mode: 0o644 }); fs.writeFileSync(path.join(bin, "expected.txt"), SECRET, { mode: 0o644 });
  const socket = path.join(dir, "s.sock");
  const srv = await serve({ socket, allow: ["/bin/sh", NODE, ...(CLAUDE ? [CLAUDE] : [])], work, agent: { uid: 1001, gid: 1001, groups: [] },
    makeDir: (d, who) => execFileSync("/usr/bin/setpriv", [`--reuid=${who.uid}`, `--regid=${who.gid}`, "--clear-groups", "--", "/bin/mkdir", "-p", d]),
    grantGroup: (d, who) => execFileSync("/usr/bin/setpriv", [`--reuid=${who.uid}`, `--regid=${who.gid}`, "--clear-groups", "--", "/bin/chmod", "710", d]),
    accounts: { min: 2000, max: 2063, home: acct, shared: [] } });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { socket, work, script, expected: path.join(bin, "expected.txt") };
}

for (const [name, plain] of [["an API key", "ANTHROPIC_API_KEY"], ["a setup token", "CLAUDE_CODE_OAUTH_TOKEN"]]) {
  test(`spawner: ${name} reaches the account's session on a descriptor and no tool of the session can read it`, { skip: root ? false : "needs root on Linux with setpriv and tini", timeout: 120_000 }, async t => {
    const r = await rig(t);
    const child = spawnSession(NODE, [r.script], { cwd: r.work, spawner: true, spawnerSocket: r.socket, account: { uid: A }, env: { PATH: process.env.PATH, [plain]: SECRET} });
    const res = await collect(child);
    assert.equal(res.code, 0, res.err.slice(0, 300));
    const o = JSON.parse(res.out.trim().split("\n").pop());
    assert.equal(o.got_equals_secret, true, "the CLI read the credential off its descriptor: " + res.out + res.err.slice(0, 200));
    assert.ok(o.var.some((/** @type {string} */ k) => /FILE_DESCRIPTOR$/.test(k)), "the descriptor variable is set");
    assert.equal(o.ownEnvHasSecret, false, "not in the CLI's own environment");
    for (const k of ["env", "environ", "cmdline", "fd", "home"]) assert.equal(o[k], 0, `a tool of the session finds the credential in its ${k}: ${JSON.stringify(o)}`);
  });
}

test("spawner: the real claude, started as the account, finds the credential on the descriptor (auth status)", { skip: root ? (CLAUDE ? false : "this image has no claude binary") : "needs root on Linux with setpriv and tini", timeout: 120_000 }, async t => {
  const r = await rig(t);
  for (const [plain, method] of [["ANTHROPIC_API_KEY", "api_key"], ["CLAUDE_CODE_OAUTH_TOKEN", "oauth_token"]]) {
    const child = spawnSession(CLAUDE, ["auth", "status"], { cwd: r.work, spawner: true, spawnerSocket: r.socket, account: { uid: A }, env: { PATH: process.env.PATH, [plain]: SECRET } });
    const res = await collect(child);
    const j = JSON.parse(res.out.slice(res.out.indexOf("{")).trim());
    assert.equal(j.authMethod, method, res.out.slice(0, 300) + res.err.slice(0, 200));
    assert.equal(j.loggedIn, true);
  }
});

test("spawner: a terminal shell from a session that holds a credential reads nothing on fd 3 and has no credential variable", { skip: root ? (HAS_TERMINAL ? false : "this build has no terminal role yet (terminal-spawn)") : "needs root on Linux with setpriv and tini", timeout: 120_000 }, async t => {
  const r = await rig(t);
  const child = spawnSession("/bin/sh", ["-c", "echo fd3=[$(timeout 1 head -c 200 /proc/self/fd/3 2>&1)]; echo vars=$(env | grep -c 'FILE_DESCRIPTOR\\|KEY\\|TOKEN\\|SECRET\\|OAUTH'); echo has=$(env | grep -c \"$(cat ${r.expected})\")"], { cwd: r.work, spawner: true, spawnerSocket: r.socket, account: { uid: A }, terminal: true, env: { PATH: process.env.PATH, CLAUDE_CODE_OAUTH_TOKEN: SECRET, ANTHROPIC_API_KEY: SECRET } });
  const res = await collect(child);
  assert.ok(!res.out.includes(SECRET), "the terminal printed the credential: " + res.out);
  assert.match(res.out, /vars=0/, res.out);
  assert.match(res.out, /fd3=\[[^A-Za-z0-9]*\]/, res.out);
});
