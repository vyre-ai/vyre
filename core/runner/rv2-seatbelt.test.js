import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
// reviewer-2 probes (kept in the tree, run by the hosted Mac job) for the macOS home profile (core/runner/homesandbox.js homeSeatbelt), against origin/work/runner c3afce4cb. Drop into core/runner/ and run on the hosted Mac job
// (NOT run by me: no tests on the Mac I work on). Each probe tries something the profile's text does not forbid; the asserts name what must NOT work. A failing assert is a hole.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { homeSeatbelt } from "./homesandbox.js";

const real = p => fs.realpathSync(p);
const rnd = () => crypto.randomBytes(4).toString("hex");

test("macOS home profile: launchd job escape, preferences daemon, per-user temp, outbound reach", { skip: process.platform !== "darwin" || process.env.VYRE_TEST_HOSTED !== "1", timeout: 90_000 }, t => {
  const base = real(fs.mkdtempSync(path.join(os.tmpdir(), "rv2-sb-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "home"), proj = path.join(base, "proj"), temp = path.join(base, "temp");
  for (const d of [home, path.join(home, ".vyre", "run"), proj, temp]) fs.mkdirSync(d, { recursive: true });
  const hostSecret = path.join(os.tmpdir(), `rv2-host-secret-${rnd()}`);       // the person's own per-user temp, outside the session's folders
  fs.writeFileSync(hostSecret, "host temp secret");
  t.after(() => fs.rmSync(hostSecret, { force: true }));
  const marker = `/private/tmp/rv2-escape-${rnd()}`;                          // a place the profile makes unwritable
  const label = `rv2probe${rnd()}`;
  t.after(() => { spawnSync("/bin/launchctl", ["remove", label]); fs.rmSync(marker, { force: true }); });
  const profile = homeSeatbelt({ platform: "darwin", command: process.execPath, home, vyreHome: path.join(home, ".vyre"), sessionSocket: path.join(home, ".vyre", "run", "s.sock"), workdirs: [proj], temp, readOnly: [path.dirname(process.execPath)], daemonPorts: [] });
  const P = { marker, label, hostSecret };
  const script = `
    const cp=require("child_process"),fs=require("fs"),net=require("net");const P=JSON.parse(process.argv[1]);const out={};
    try{cp.execFileSync("/bin/launchctl",["submit","-l",P.label,"--","/usr/bin/touch",P.marker],{stdio:"ignore"});out.launchctl="submitted"}catch(e){out.launchctl="refused:"+(e.status||e.code)}
    try{const r=cp.execFileSync("/usr/bin/defaults",["read","com.apple.dock"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]});out.defaults=r.length>10?"READ":"empty"}catch(e){out.defaults="refused"}
    try{fs.readFileSync(P.hostSecret);out.hostTmp="READ"}catch(e){out.hostTmp=e.code}
    new Promise(res=>{const s=net.connect(443,"1.1.1.1");const f=v=>{try{s.destroy()}catch{}res(v)};s.on("connect",()=>f("connected"));s.on("error",e=>f(e.code||"error"));setTimeout(()=>f("timeout"),2500)}).then(v=>{out.internet=v;console.log(JSON.stringify(out))});`;
  const r = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", script, JSON.stringify(P)], { encoding: "utf8", timeout: 30000, env: { PATH: "/usr/bin:/bin", HOME: home } });
  let out; try { out = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { assert.fail("probe did not run: " + r.stderr.slice(0, 300)); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);          // give a launchd job time to run
  const escaped = fs.existsSync(marker);
  console.log("RV2 seatbelt probes:", JSON.stringify({ ...out, markerWrittenByUnsandboxedJob: escaped }));
  assert.equal(escaped, false, "launchctl submit from inside the profile started a job OUTSIDE it (it wrote a file the profile makes unwritable)");
  assert.notEqual(out.defaults, "READ", "the preferences daemon answered a read of another app's preferences that the file rules deny");
  assert.equal(out.hostTmp === "READ", false, "the person's per-user temp (outside the session's folders) is readable");
  // informational: the profile cannot filter hosts on macOS (allow default); record it so the docs can say so
  if (out.internet === "connected") console.log("NOTE: outbound internet is open from inside the macOS profile (the Linux profile allows the provider's hosts only)");
});
