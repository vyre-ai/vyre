// The launcher against a REAL sandbox: runner's planHome, selfTest and launch (bubblewrap on Linux, seatbelt on macOS) composed by hand, the per-session socket a real listening
// socket, and a scripted provider adapter as the session. Skipped where there is no sandbox. The real `claude` and `codex` binaries are used when they are installed
// (CLAUDE_BIN, CODEX_BIN, or the usual places).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { SCRATCH } from "../test/scratch.mjs";
import * as runner from "../core/runner/homesandbox.js";
import { launch, unavailable } from "../core/runner/sandbox.js";
import { AGENTS, prepareSandbox } from "./agent-sandbox.js";

const SKIP = !["darwin", "linux"].includes(process.platform) || unavailable() !== "";
const CLAUDE = process.env.CLAUDE_BIN || ["/usr/bin/claude", "/usr/local/bin/claude"].find(p => fs.existsSync(p));
const CODEX = process.env.CODEX_BIN || [path.join(process.env.HOME || "", "vyre-ci/codex/node_modules/.bin/codex")].find(p => fs.existsSync(p));
const sandbox = { planHome: runner.planHome, selfTest: runner.selfTest, launch };
const tmp = () => fs.mkdtempSync(path.join(SCRATCH, "as-"));
const rm = d => fs.rmSync(d, { recursive: true, force: true });
const listen = where => new Promise((res, rej) => { const s = net.createServer(c => { c.on("error", () => {}); c.end("hi"); }); s.once("error", rej); s.listen(where, () => res(s)); });
const run = (child) => new Promise(res => { let out = "", err = ""; child.stdout.on("data", d => (out += d)); child.stderr.on("data", d => (err += d)); child.on("close", code => res({ code, out, err })); });

async function rig(t) {
  const home = tmp(); t.after(() => rm(home));
  const runDir = path.join(home, ".vyre", "run", "sessions"); fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(home, ".vyre", "keys"), { recursive: true }); fs.writeFileSync(path.join(home, ".vyre", "keys", "device.key"), "SECRET-DEVICE-KEY");
  const own = path.join(runDir, "s1.sock"), other = path.join(runDir, "s2.sock"), person = path.join(home, ".vyre", "vyred.sock");
  const daemon = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); t.after(() => daemon.kill("SIGKILL"));
  const servers = await Promise.all([listen(own), listen(other), listen(person), listen({ port: 0, host: "127.0.0.1" })]);
  t.after(() => servers.forEach(s => s.close()));
  fs.mkdirSync(path.join(home, "Documents"), { recursive: true }); fs.writeFileSync(path.join(home, "Documents", "private.txt"), "PERSONAL");
  const proj = path.join(home, "proj"), temp = path.join(home, "tmp-session"); for (const d of [proj, temp]) fs.mkdirSync(d, { recursive: true });
  // the real agent folders the sessions must never touch, each with a sign-in and something that is not the sign-in
  for (const [d, cred, other2] of [[".claude", ".credentials.json", "projects/other-space.jsonl"], [".codex", "auth.json", "history.jsonl"]]) {
    fs.mkdirSync(path.join(home, d, path.dirname(other2)), { recursive: true });
    fs.writeFileSync(path.join(home, d, cred), cred === "auth.json" ? '{"OPENAI_API_KEY":"sk-test-aaaaaaaaaaaaaaaaaaaaaaaa"}' : '{"claudeAiOauth":{"accessToken":"SIGN-IN"}}');
    fs.writeFileSync(path.join(home, d, other2), "ANOTHER CONVERSATION");
  }
  const probes = { personSocket: person, otherSocket: other, daemonPorts: [servers[3].address().port], keyFile: path.join(home, ".vyre", "keys", "device.key"), homeFile: path.join(home, "Documents", "private.txt"), daemonPid: daemon.pid };
  const cfg = { sandbox, platform: process.platform, home, vyreHome: path.join(home, ".vyre"), probes, temp };
  return { home, own, proj, temp, probes, cfg };
}
const snapshot = d => JSON.stringify(fs.readdirSync(d, { recursive: true }).sort().map(f => [f, fs.statSync(path.join(d, f)).mtimeMs]));

// This machine has no proxy for the provider's hosts (the daemon composes that), so the self-test's "can still reach its hosts" probe is switched off for the run.
const noHosts = () => { const was = Object.fromEntries(Object.entries(AGENTS).map(([k, v]) => [k, v.hosts])); for (const v of Object.values(AGENTS)) v.hosts = []; return () => { for (const [k, v] of Object.entries(AGENTS)) v.hosts = was[k]; }; };

test("real sandbox: the self-test passes, the scripted session does one turn over its own socket and reaches nothing else", { skip: SKIP, timeout: 120_000 }, async t => {
  const r = await rig(t); t.after(noHosts());
  const s = await prepareSandbox(r.cfg, { provider: "claude", command: CLAUDE || process.execPath, sessionSocket: r.own, workdirs: [r.proj], readOnly: [path.dirname(process.execPath)] });
  assert.equal(s.sandboxed, true, "the self-test passed under the real sandbox");
  const script = `const net=require("net"),fs=require("fs");const conn=t=>new Promise(res=>{const c=typeof t==="number"?net.connect(t,"127.0.0.1"):net.connect(t);let d="";c.on("data",x=>d+=x);c.on("end",()=>res(d||"closed"));c.on("error",e=>res(e.code||"error"));setTimeout(()=>res("timeout"),2000)});
(async()=>{const o={turn:await conn(process.env.VYRE_SOCKET),person:await conn(${JSON.stringify(r.probes.personSocket)}),other:await conn(${JSON.stringify(r.probes.otherSocket)}),daemon:await conn(${r.probes.daemonPorts[0]})};
for(const f of [${JSON.stringify(r.probes.keyFile)},${JSON.stringify(r.probes.homeFile)}]){try{fs.readFileSync(f);o[f.split("/").pop()]="READ"}catch(e){o[f.split("/").pop()]=e.code}}
o.env=Object.keys(process.env).filter(k=>/token|secret|key/i.test(k));console.log(JSON.stringify(o))})()`;
  process.env.PLANTED_SECRET_TOKEN = "SECRET-IN-ENV"; t.after(() => { delete process.env.PLANTED_SECRET_TOKEN; });
  const out = await run(s.spawn(process.execPath, ["-e", script], { ...process.env }, r.proj));
  const res = JSON.parse(out.out.trim().split("\n").pop());
  assert.equal(res.turn, "hi", "the one turn went over the session's own socket");
  assert.notEqual(res.person, "hi"); assert.notEqual(res.other, "hi"); assert.notEqual(res.daemon, "hi");
  assert.notEqual(res["device.key"], "READ"); assert.notEqual(res["private.txt"], "READ");
  assert.deepEqual(res.env, [], "no token, key or secret in the session's environment, though one was planted in the launcher's");
});

test("real sandbox: breaking the profile makes the self-test refuse, and nothing is started", { skip: SKIP, timeout: 120_000 }, async t => {
  const r = await rig(t); t.after(noHosts());
  // a key file the session CAN read (it is in the project): the proof must fail
  fs.writeFileSync(path.join(r.proj, "device.key"), "visible");
  await assert.rejects(() => prepareSandbox({ ...r.cfg, probes: { ...r.probes, keyFile: path.join(r.proj, "device.key") } }, { provider: "claude", command: CLAUDE || process.execPath, sessionSocket: r.own, workdirs: [r.proj], readOnly: [path.dirname(process.execPath)] }),
    e => e.code === "sandbox_failed" && /key file in the Vyre home can be read/.test(e.failures.join(";")) && /safety check failed/.test(e.message));
  // a workdir that contains the home is refused before anything runs
  await assert.rejects(() => prepareSandbox(r.cfg, { provider: "claude", command: process.execPath, sessionSocket: r.own, workdirs: [r.home] }), { code: "sandbox_workdir" });
});

test("real claude: starts inside the sandbox from the relocated config folder; the real folder is untouched", { skip: SKIP || !CLAUDE, timeout: 120_000 }, async t => {
  const r = await rig(t); t.after(noHosts());
  const before = snapshot(path.join(r.home, ".claude"));
  const s = await prepareSandbox(r.cfg, { provider: "claude", command: CLAUDE, sessionSocket: r.own, workdirs: [r.proj] });
  assert.equal(s.sandboxed, true, "the agent starts inside the sandbox (versionArgs exit 0)");
  const out = await run(s.spawn(CLAUDE, ["--version"], {}, r.proj));
  assert.equal(out.code, 0, out.err); assert.match(out.out, /\d+\.\d+\.\d+/);
  assert.equal(snapshot(path.join(r.home, ".claude")), before, "nothing written to the real config folder");
});

test("real codex: signs in from the relocated folder (only auth.json and config.toml copied) and writes nothing to the real one", { skip: SKIP || !CODEX, timeout: 120_000 }, async t => {
  const r = await rig(t); t.after(noHosts());
  fs.writeFileSync(path.join(r.home, ".codex", "config.toml"), 'approval_policy = "on-request"\n');
  const before = snapshot(path.join(r.home, ".codex"));
  const ro = [path.resolve(path.dirname(CODEX), "..")];
  const s = await prepareSandbox(r.cfg, { provider: "codex", command: CODEX, sessionSocket: r.own, workdirs: [r.proj], readOnly: ro });
  assert.equal(s.sandboxed, true);
  const out = await run(s.spawn(CODEX, ["login", "status"], {}, r.proj));
  assert.match(out.out + out.err, /Logged in using an API key/, out.out + out.err);
  assert.doesNotMatch(out.out + out.err, /ANOTHER CONVERSATION/);
  assert.equal(snapshot(path.join(r.home, ".codex")), before, "nothing written to the real config folder");
});

// Needs runner to allow `relocatable: false` agents (asked in CHAT.md); until its planHome stops refusing them this is skipped rather than red.
const RUNNER_ALLOWS_OWN_FOLDER = (() => { try { runner.planHome({ platform: "linux", command: process.execPath, home: "/h", vyreHome: "/h/.vyre", sessionSocket: "/run/x.sock", workdirs: ["/h/p"], agent: { command: process.execPath, relocatable: false, settingsPaths: ["/h/.grok"], hosts: [], versionArgs: [] } }); return true; } catch (e) { return !/can't run sandboxed yet/.test(String(e.message)); } })();
test("real sandbox, Grok's case: a provider that cannot relocate gets its OWN settings folder back and nothing else of the home", { skip: SKIP || !RUNNER_ALLOWS_OWN_FOLDER, timeout: 120_000 }, async t => {
  const r = await rig(t); t.after(noHosts());
  fs.mkdirSync(path.join(r.home, ".grok"), { recursive: true }); fs.writeFileSync(path.join(r.home, ".grok", "config.toml"), "own settings\n");
  const s = await prepareSandbox(r.cfg, { provider: "grok", command: process.execPath, sessionSocket: r.own, workdirs: [r.proj], readOnly: [path.dirname(process.execPath)] });
  assert.equal(s.sandboxed, true); assert.equal(s.partial.reason, "own_settings_folder");
  const script = `const fs=require("fs");const o={};for(const [k,f,w] of [["own",${JSON.stringify(path.join(r.home, ".grok", "config.toml"))},1],["claude",${JSON.stringify(path.join(r.home, ".claude", ".credentials.json"))}],["docs",${JSON.stringify(r.probes.homeFile)}],["key",${JSON.stringify(r.probes.keyFile)}]]){try{fs.readFileSync(f);o[k]="READ"}catch(e){o[k]=e.code}}
try{fs.writeFileSync(${JSON.stringify(path.join(r.home, ".grok", "written.txt"))},"x");o.write="ok"}catch(e){o.write=e.code}console.log(JSON.stringify(o))`;
  const out = JSON.parse((await run(s.spawn(process.execPath, ["-e", script], {}, r.proj))).out.trim().split("\n").pop());
  assert.equal(out.own, "READ"); assert.equal(out.write, "ok", "its own folder is read and write");
  assert.notEqual(out.claude, "READ", "another agent's folder stays out of reach");
  assert.notEqual(out.docs, "READ"); assert.notEqual(out.key, "READ");
});
