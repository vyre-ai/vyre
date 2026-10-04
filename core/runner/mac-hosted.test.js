// Behaviour probes for the macOS Mach-service denies (reviewer-3 HS-4 low): the clipboard, the keychain and Apple events must be unreachable
// from inside the home sandbox. These can raise permission dialogs, so they run ONLY on a hosted macOS runner (VYRE_TEST_HOSTED=1), never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { planHome } from "./homesandbox.js";
import { launch } from "./sandbox.js";

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

test("macOS Mach denies: the clipboard is not readable from the sandbox", { skip: !HOSTED, timeout: 30_000 }, async t => {
  const r = await inside(t, "/usr/bin/pbpaste", []);
  assert.ok(r.code !== 0 || r.out === "", `pbpaste returned something: ${JSON.stringify(r)}`);
});

test("macOS Mach denies: no keychain is listed from the sandbox", { skip: !HOSTED, timeout: 30_000 }, async t => {
  const r = await inside(t, "/usr/bin/security", ["list-keychains"]);
  assert.ok(!/\.keychain/.test(r.out), `a keychain was listed: ${JSON.stringify(r)}`);
});

test("macOS Mach denies: Apple events to Finder are refused and do not hang", { skip: !HOSTED, timeout: 30_000 }, async t => {
  const r = await inside(t, "/usr/bin/osascript", ["-e", 'with timeout of 4 seconds\ntell application "Finder" to get name of startup disk\nend timeout'], 12000);
  assert.notEqual(r.code, "timeout", "osascript hung");
  assert.notEqual(r.code, 0, `the Finder answered: ${JSON.stringify(r)}`);
});
