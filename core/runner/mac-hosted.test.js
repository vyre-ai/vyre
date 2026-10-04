// Behaviour probes for the macOS Mach-service denies (reviewer-3 HS-4 low): the clipboard, the keychain and Apple events must be unreachable
// from inside the home sandbox. These can raise permission dialogs, so they run ONLY on a hosted macOS runner (VYRE_TEST_HOSTED=1), never on a person's Mac.
import "./testing/hosted-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SCRATCH } from "../../test/scratch.mjs";
import { planHome } from "./homesandbox.js";
import { launch, seatbeltProfile } from "./sandbox.js";

const HOSTED = process.platform === "darwin" && process.env.VYRE_TEST_HOSTED === "1";
const tmp = () => fs.mkdtempSync(path.join(SCRATCH, "mh-"));

async function inside(t, cmd, args, ms = 8000) {
  const home = tmp(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const run = path.join(home, ".vyre/run"); fs.mkdirSync(run, { recursive: true }); fs.mkdirSync(path.join(home, "proj"), { recursive: true }); fs.mkdirSync(path.join(home, "t"), { recursive: true });
  const real = path.join(home, ".realcfg"); fs.mkdirSync(real, { recursive: true });
  const sock = path.join(run, "s.sock"); const sv = net.createServer(c => c.end()); await new Promise(r => sv.listen(sock, r)); t.after(() => sv.close());
  const p = planHome({ platform: "darwin", command: cmd, args, home, vyreHome: path.join(home, ".vyre"), sessionSocket: sock, workdirs: [path.join(home, "proj")], temp: path.join(home, "t"), agent: { command: cmd, hosts: [], private: { from: real, env: "AGENT_CONFIG_DIR", credentialFiles: [] } } });
  const c = launch(p, { cwd: p.cwd }); let out = "", err = ""; c.stdout.on("data", d => out += d); c.stderr.on("data", d => err += d);
  const code = await new Promise(res => { const k = setTimeout(() => { c.kill("SIGKILL"); res("timeout"); }, ms); c.on("close", x => { clearTimeout(k); res(x); }); });
  return { code, out, err };
}

/** A sandbox that never started proves nothing (a profile error also exits non-zero with nothing on stdout, found 4 Oct on a hosted Mac). Every probe first runs a command that must work here. */
async function control(t) {
  const r = await inside(t, "/bin/echo", ["ok"]);
  assert.equal(r.code, 0, `the sandbox did not start: ${JSON.stringify(r)}`);
  assert.equal(r.out.trim(), "ok");
  assert.ok(!/sandbox-exec:/.test(r.err), `the sandbox profile was refused: ${r.err}`);
}
const started = r => assert.ok(!/sandbox-exec:/.test(r.err), `the sandbox profile was refused, so nothing was probed: ${r.err}`);
const outside = (cmd, args, input) => spawnSync(cmd, args, { encoding: "utf8", input, timeout: 8000 });

test("macOS Mach denies: the clipboard is not readable from the sandbox", { skip: !HOSTED, timeout: 30_000 }, async t => {
  await control(t);
  const marker = "vyre-clip-" + Date.now();
  const put = outside("/usr/bin/pbcopy", [], marker);
  assert.equal(put.status, 0, "could not put a marker on the clipboard outside the sandbox");
  assert.equal(outside("/usr/bin/pbpaste", []).stdout, marker, "the marker is readable outside, so the probe can see the clipboard");
  const r = await inside(t, "/usr/bin/pbpaste", []);
  started(r);
  assert.ok(!r.out.includes(marker), `the sandbox read the clipboard: ${JSON.stringify(r)}`);
});

test("macOS Mach denies: no keychain is listed from the sandbox", { skip: !HOSTED, timeout: 30_000 }, async t => {
  await control(t);
  const out = outside("/usr/bin/security", ["list-keychains"]);
  assert.match(out.stdout, /\.keychain/, "the keychains are listed outside, so the probe can see them");
  const r = await inside(t, "/usr/bin/security", ["list-keychains"]);
  started(r);
  assert.ok(!/\.keychain/.test(r.out), `a keychain was listed: ${JSON.stringify(r)}`);
});

test("macOS Mach denies: Apple events to Finder are refused and do not hang", { skip: !HOSTED, timeout: 30_000 }, async t => {
  await control(t);
  const r = await inside(t, "/usr/bin/osascript", ["-e", 'with timeout of 4 seconds\ntell application "Finder" to get name of startup disk\nend timeout'], 12000);
  started(r);
  assert.notEqual(r.code, "timeout", "osascript hung");
  assert.notEqual(r.code, 0, `the Finder answered: ${JSON.stringify(r)}`);
  assert.ok(r.err.length > 0, "a refusal says something on stderr (a silent failure is not a denial)");
});

// A profile seatbelt cannot load fails closed, so every probe "passes" and nothing starts. These load the real generated profiles and fail the job when seatbelt rejects one.
test("macOS profiles load: the home profile and the lent profile are accepted by sandbox-exec and run a command", { skip: !HOSTED, timeout: 30_000 }, async t => {
  const home = await inside(t, "/usr/bin/true", []);
  assert.ok(!/sandbox-exec:/.test(home.err), `seatbelt rejected the HOME profile: ${home.err}`);
  assert.equal(home.code, 0, `a command did not run in the home sandbox: ${JSON.stringify(home)}`);
  const ws = tmp(); t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const prof = seatbeltProfile({ platform: "darwin", workspace: ws, command: "/usr/bin/true", readOnly: [], proxy: { port: 4567 } });
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", prof, "/usr/bin/true"], { encoding: "utf8", timeout: 10000 });
  assert.ok(!/sandbox-exec:/.test(r.stderr), `seatbelt rejected the LENT profile: ${r.stderr}`);
  assert.equal(r.status, 0, `a command did not run in the lent sandbox: ${r.stderr}`);
});
