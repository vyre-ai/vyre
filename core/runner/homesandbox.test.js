import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { planHome, selfTest, homeSeatbelt, seedConfig, discardConfig } from "./homesandbox.js";
import { launch } from "./sandbox.js";
import { spawn } from "node:child_process";
import { unavailable } from "./sandbox.js";

const tmp = () => fs.mkdtempSync(path.join(SCRATCH, "hs-"));
const rm = d => fs.rmSync(d, { recursive: true, force: true });
const listen = (where) => new Promise((res, rej) => { const s = net.createServer(c => { c.on("error", () => {}); c.end("hi"); }); s.once("error", rej); s.listen(where, () => res(s)); });
const SKIP = !["darwin", "linux"].includes(process.platform) || unavailable() !== "";

async function rig(t) {
  const home = tmp(); t.after(() => rm(home));
  const run = path.join(home, ".vyre", "run", "sessions"); fs.mkdirSync(run, { recursive: true });
  fs.mkdirSync(path.join(home, ".vyre", "keys"), { recursive: true }); fs.writeFileSync(path.join(home, ".vyre", "keys", "device.key"), "SECRET-DEVICE-KEY");
  const own = path.join(run, "s1.sock"), other = path.join(run, "s2.sock"), person = path.join(home, ".vyre", "vyred.sock");
  const daemon = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { env: { ...process.env, DAEMON_TOKEN: "SECRET-DAEMON-TOKEN" }, stdio: "ignore" }); t.after(() => daemon.kill("SIGKILL"));
  const servers = await Promise.all([listen(own), listen(other), listen(person), listen({ port: 0, host: "127.0.0.1" }), listen({ port: 0, host: "::" })]);
  const outside = path.join(path.dirname(home), "outside-" + path.basename(home)); fs.mkdirSync(outside, { recursive: true }); t.after(() => rm(outside));
  t.after(() => servers.forEach(s => { s.close(); }));
  const port = servers[3].address().port, portAll = servers[4].address().port;
  fs.mkdirSync(path.join(home, "Documents"), { recursive: true }); fs.writeFileSync(path.join(home, "Documents", "private.txt"), "PERSONAL");
  const proj = path.join(home, "proj"), settings = path.join(home, ".agentcfg"), temp = path.join(home, "tmp-session"); for (const d of [proj, settings, temp]) fs.mkdirSync(d, { recursive: true });
  const real = path.join(home, ".agentreal"); fs.mkdirSync(real, { recursive: true }); fs.writeFileSync(path.join(real, ".credentials.json"), "{}");
  const agent = { command: process.execPath, versionArgs: ["-v"], hosts: [], private: { from: real, env: "AGENT_CONFIG_DIR", credentialFiles: [".credentials.json"] } };
  return { home, own, other, person, port, proj, settings, temp, agent, probes: { personSocket: person, otherSocket: other, daemonPorts: [port, portAll], mustNotWrite: [outside], keyFile: path.join(home, ".vyre", "keys", "device.key"), homeFile: path.join(home, "Documents", "private.txt"), daemonPid: daemon.pid } };
}

test("home sandbox: the person's socket, another session's socket, the daemon's loopback port and the Vyre home are all out of reach; the session's own socket works", { skip: SKIP, timeout: 60_000 }, async t => {
  const r = await rig(t);
  const res = await selfTest({ platform: process.platform, command: process.execPath, home: r.home, vyreHome: path.join(r.home, ".vyre"), sessionSocket: r.own, workdirs: [r.proj], temp: r.temp, agent: r.agent, probes: r.probes });
  assert.deepEqual(res.failures, [], JSON.stringify(res.results));
  assert.equal(res.ok, true);
  assert.equal(res.results.ownSocket, "connected");
  assert.notEqual(res.results.personSocket, "connected");
  assert.notEqual(res.results.homeFile, "READ", "a personal file outside the allowed paths is denied");
  assert.deepEqual(res.results.writes, ["ok", "ok"], "temp and project are usable");
});

test("home sandbox: the self-test also fails when the agent cannot reach its host or cannot start", { skip: SKIP, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const base = { platform: process.platform, command: process.execPath, home: r.home, vyreHome: path.join(r.home, ".vyre"), sessionSocket: r.own, workdirs: [r.proj], temp: r.temp, probes: r.probes };
  const noHost = await selfTest({ ...base, agent: { ...r.agent, hosts: ["127.0.0.1:9"] } });
  assert.ok(noHost.failures.some(f => /cannot reach 127\.0\.0\.1:9/.test(f)), noHost.failures.join("; "));
  const noStart = await selfTest({ ...base, agent: { ...r.agent, command: process.execPath, versionArgs: ["-e", "process.exit(3)"] } });
  assert.ok(noStart.failures.some(f => /does not start inside the sandbox \(exit 3/.test(f)), noStart.failures.join("; "));
});

test("home sandbox: the self-test fails when a hole is left (the person's socket is the session's own)", { skip: SKIP || process.platform !== "darwin", timeout: 60_000 }, async t => {
  const r = await rig(t);
  const res = await selfTest({ platform: process.platform, command: process.execPath, home: r.home, vyreHome: path.join(r.home, ".vyre"), sessionSocket: r.person, workdirs: [r.proj], temp: r.temp, agent: r.agent, probes: process.platform === "linux" ? { ...r.probes, personSocket: "/run/vyre-session.sock" } : r.probes });
  assert.equal(res.ok, false);
  assert.ok(res.failures.some(f => /person's own socket is reachable/.test(f)), res.failures.join("; "));
});

test("ES-1: the seatbelt profile denies all writes first and allows them back only to the project and the temp folder; read-only folders are read-only", () => {
  const home = tmp(); try {
    const proj = path.join(home, "proj"), tools = path.join(home, "tools"), temp = path.join(home, "t"); for (const d of [proj, tools, temp]) fs.mkdirSync(d, { recursive: true });
    const p = homeSeatbelt({ platform: "darwin", command: "/bin/sh", home, sessionSocket: path.join(home, ".vyre", "run", "s.sock"), workdirs: [proj], temp, readOnly: [tools] });
    assert.ok(p.indexOf("(deny file-write*)") > 0 && p.indexOf("(deny file-write*)") < p.indexOf("(allow file* (subpath"), "all writes are denied before anything is allowed");
    assert.match(p, /\(allow file-write\* \(subpath "\/dev"\)\)/);
    assert.ok(p.includes(`(allow file* (subpath "${fs.realpathSync(proj)}"))`) && p.includes(`(allow file* (subpath "${fs.realpathSync(temp)}"))`));
    assert.ok(p.includes(`(allow file-read* (subpath "${fs.realpathSync(tools)}"))`) && !p.includes(`(allow file* (subpath "${fs.realpathSync(tools)}"))`), "a read-only folder is not writable");
  } finally { rm(home); }
});

test("home sandbox: the seatbelt profile denies every unix socket and loopback connection, and the Vyre home, before the one allow", () => {
  const home = tmp(); try {
    const p = homeSeatbelt({ platform: "darwin", command: "/bin/sh", home, sessionSocket: path.join(home, ".vyre", "run", "s.sock") });
    assert.match(p, /\(deny network-outbound \(remote unix-socket\)\)/);
    assert.match(p, /\(deny network-outbound \(remote ip "localhost:\*"\)\)/);
    assert.ok(p.indexOf("(deny network-outbound (remote unix-socket))") < p.indexOf("(allow network-outbound (remote unix-socket"), "the allow comes last so it wins");
    assert.match(p, /deny file\* \(subpath ".*\/\.vyre"\)/);
  } finally { rm(home); }
});

test("home sandbox: Windows is refused with a plain reason, not run unsandboxed", () => {
  assert.throws(() => planHome({ platform: "win32", command: "C:\\x.exe", home: "C:\\Users\\x", sessionSocket: "\\\\.\\pipe\\x" }), /not sandboxed yet/);
});

import { createEgress } from "./egress.js";
test("egress CONNECT: only the listed hosts are tunnelled, and only with the session's token", async t => {
  const target = await listen({ port: 0, host: "127.0.0.1" }); t.after(() => target.close());
  const tp = target.address().port;
  const eg = createEgress({ routes: [], vault: {}, session: "s", token: "tok", connect: [`127.0.0.1:${tp}`] });
  const { port } = await eg.listen(); t.after(() => eg.close());
  const ask = (host, auth) => new Promise(res => { const s = net.connect(port, "127.0.0.1"); let b = ""; s.on("connect", () => s.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n${auth ? "Proxy-Authorization: Basic " + Buffer.from("vyre:" + auth).toString("base64") + "\r\n" : ""}\r\n`)); s.on("data", d => { b += d; if (b.includes("\r\n")) { s.destroy(); res(b.split("\r\n")[0]); } }); s.on("error", () => res("error")); setTimeout(() => res("timeout"), 3000); });
  assert.match(await ask(`127.0.0.1:${tp}`, "tok"), / 200 /);
  assert.match(await ask(`127.0.0.1:${tp}`, "wrong"), / 407 /);
  assert.match(await ask(`127.0.0.1:${tp}`, ""), / 407 /);
  assert.match(await ask("example.com:443", "tok"), / 403 /);
});

test("home sandbox (Linux): the agent reaches its host through the proxy's CONNECT tunnel, and nothing else", { skip: process.platform !== "linux" || SKIP, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const target = await listen({ port: 0, host: "127.0.0.1" }); t.after(() => target.close());
  const tp = target.address().port;
  const sock = path.join(r.home, "egress.sock");
  const eg = createEgress({ routes: [], vault: {}, session: "s", token: "tok", connect: [`127.0.0.1:${tp}`] }); await eg.listen({ socket: sock }); t.after(() => eg.close());
  const base = { platform: "linux", command: process.execPath, home: r.home, vyreHome: path.join(r.home, ".vyre"), sessionSocket: r.own, workdirs: [r.proj], temp: r.temp, probes: r.probes, proxy: { socket: sock, token: "tok" } };
  const ok = await selfTest({ ...base, agent: { ...r.agent, hosts: [`127.0.0.1:${tp}`] } });
  assert.deepEqual(ok.failures, [], JSON.stringify(ok.results));
  const bad = await selfTest({ ...base, agent: { ...r.agent, hosts: ["example.com:443"] } });
  assert.ok(bad.failures.some(f => /cannot reach example\.com:443/.test(f)), bad.failures.join("; "));
});

// ---- reviewer-3: HS-1 to HS-7 ---------------------------------------------------------------------------------------------

const base = (r, over = {}) => ({ platform: process.platform, command: process.execPath, home: r.home, vyreHome: path.join(r.home, ".vyre"), sessionSocket: r.own, workdirs: [r.proj], temp: r.temp, agent: r.agent, probes: r.probes, ...over });

test("HS-2: an entry that is the home, above it, or inside the Vyre home or a secret folder is refused; a project inside the home is fine", async t => {
  const r = await rig(t);
  fs.mkdirSync(path.join(r.home, ".ssh"), { recursive: true });
  const plan = over => () => planHome({ ...base(r, over), command: process.execPath });
  assert.throws(plan({ workdirs: [r.home] }), /home folder or above/);
  assert.throws(plan({ workdirs: [path.dirname(r.home)] }), /home folder or above/);
  assert.throws(plan({ workdirs: [path.dirname(path.join(r.home, ".vyre"))] }), /home folder or above/);
  assert.throws(plan({ workdirs: [path.join(r.home, ".vyre", "keys")] }), /never sees/);
  assert.throws(plan({ workdirs: [path.join(r.home, ".ssh")] }), /never sees/);
  assert.throws(plan({ readOnly: [r.home] }), /home folder or above/);
  assert.doesNotThrow(plan({ workdirs: [r.proj] }));
  await assert.rejects(() => selfTest(base(r, { workdirs: [r.home] })), /home folder or above/);
});

test("HS-3: a stale probe fails the self-test instead of passing over a hole", { skip: SKIP, timeout: 60_000 }, async t => {
  const r = await rig(t);
  const res = await selfTest(base(r, { probes: { ...r.probes, keyFile: path.join(r.home, "gone.key"), personSocket: path.join(r.home, "gone.sock"), daemonPorts: [1] } }));
  assert.equal(res.ok, false);
  assert.match(res.failures[0], /self-test is stale/);
  assert.match(res.failures[0], /key file does not exist/);
});

test("HS-1: each session gets its own config folder with only the credential file; hooks it plants never reach the person's real folder, which is not even visible", { skip: SKIP, timeout: 60_000 }, async t => {
  const r = await rig(t);
  const real = path.join(r.home, ".agentreal"); fs.mkdirSync(path.join(real, "projects"), { recursive: true });
  fs.writeFileSync(path.join(real, ".credentials.json"), '{"token":"SIGN-IN"}'); fs.writeFileSync(path.join(real, "projects", "other-space.jsonl"), "OTHER SPACE TRANSCRIPT"); fs.writeFileSync(path.join(real, "settings.json"), "{}");
  const agent = { command: process.execPath, versionArgs: ["-v"], hosts: [], private: { from: real, env: "AGENT_CONFIG_DIR", credentialFiles: [".credentials.json"] } };
  const script = `const fs=require("fs");const d=process.env.AGENT_CONFIG_DIR;const o={files:fs.readdirSync(d).sort(),cred:fs.readFileSync(d+"/.credentials.json","utf8")};
    try{fs.writeFileSync(d+"/settings.json",'{"hooks":"EVIL"}');o.planted="ok"}catch(e){o.planted=e.code}
    try{o.real=fs.readdirSync(${JSON.stringify(real)}).length}catch(e){o.real=e.code}console.log(JSON.stringify(o))`;
  const p = planHome({ ...base(r, { agent }), command: process.execPath, args: ["-e", script], readOnly: [path.dirname(process.execPath)] });
  const c = launch(p); let out = ""; c.stdout.on("data", d => out += d); c.stderr.on("data", d => out += d); await new Promise(res => c.on("close", res));
  const j = JSON.parse(out.trim().split("\n").pop());
  assert.deepEqual(j.files, [".credentials.json"], "only the credential file was copied");
  assert.match(j.cred, /SIGN-IN/);
  assert.notEqual(typeof j.real, "number", "the real config folder is not visible: " + j.real);
  assert.equal(fs.readFileSync(path.join(real, "settings.json"), "utf8"), "{}", "the real settings were not touched");
  const seeded = seedConfig({ ...base(r, { agent }) });
  assert.ok(seeded.dir.endsWith("agent-config"));
  assert.equal(discardConfig(base(r, { agent })), true, "the private config folder is thrown away at session end");
  assert.equal(fs.existsSync(seeded.dir), false);
  assert.throws(() => seedConfig({ ...base(r, { agent: { ...agent, private: { ...agent.private, credentialFiles: ["../x"] } } }) }), /name inside/);
});

test("HS-5: the session's environment is filtered, not copied through", { skip: SKIP, timeout: 60_000 }, async t => {
  const r = await rig(t);
  const p = planHome({ ...base(r), command: process.execPath, args: ["-e", "console.log(JSON.stringify({a:process.env.AWS_SECRET_ACCESS_KEY||null,v:process.env.VYRE_SOCKET?1:0}))"], readOnly: [path.dirname(process.execPath)], env: { AWS_SECRET_ACCESS_KEY: "SECRET", LD_PRELOAD: "x", VYRE_THING: "1" } });
  const c = launch(p); let out = ""; c.stdout.on("data", d => out += d); await new Promise(res => c.on("close", res));
  assert.deepEqual(JSON.parse(out.trim()), { a: null, v: 1 });
});

test("HS-6: an agent installed under the home still starts (read-only folders are bound after the empty home)", { skip: SKIP, timeout: 60_000 }, async t => {
  const r = await rig(t);
  const tools = path.join(r.home, "tools"); fs.mkdirSync(tools, { recursive: true }); fs.writeFileSync(path.join(tools, "agent.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const res = await selfTest(base(r, { agent: { ...r.agent, command: path.join(tools, "agent.sh"), versionArgs: [] }, readOnly: [tools] }));
  assert.deepEqual(res.failures, [], JSON.stringify(res.results));
});

test("HS-4: the session cannot signal the daemon or read its process environment (the self-test probes it)", { skip: SKIP, timeout: 60_000 }, async t => {
  const r = await rig(t);
  const res = await selfTest(base(r));
  assert.deepEqual(res.failures, [], JSON.stringify(res.results));
  assert.notEqual(res.results.signal, "ok");
  assert.notEqual(res.results.psEnv, "READ");
});

test("HS-4: the seatbelt profile denies signals, process info, procargs and the Mach services after the allows", () => {
  const home = tmp(); try {
    const p = homeSeatbelt({ platform: "darwin", command: "/bin/sh", home, sessionSocket: path.join(home, ".vyre", "run", "s.sock"), workdirs: [path.join(home, "proj")] });
    for (const rule of ["(deny signal)", "(allow signal (target self) (target children))", "(deny process-info* (target others))", 'kern.procargs2', "com.apple.pasteboard.1", "com.apple.SecurityServer", "com.apple.coreservices.appleevents"]) assert.ok(p.includes(rule), rule);
    assert.ok(p.lastIndexOf("(deny file* (subpath") > p.indexOf("(allow file* (subpath"), "the protected denies come after the allows");
  } finally { rm(home); }
});

test("HS-7: CONNECT tunnels are capped per session", async t => {
  const { MAX_TUNNELS } = await import("./egress.js");
  const held = new Set(); const target = net.createServer(c => { held.add(c); c.on("error", () => {}); }); await new Promise(r => target.listen({ port: 0, host: "127.0.0.1" }, r)); t.after(() => { held.forEach(c => c.destroy()); target.close(); });
  const tp = target.address().port;
  const eg = createEgress({ routes: [], vault: {}, session: "s", token: "tok", connect: [`127.0.0.1:${tp}`] });
  const { port } = await eg.listen(); t.after(() => eg.close());
  const open = () => new Promise(res => { const s = net.connect(port, "127.0.0.1"); let b = ""; s.on("connect", () => s.write(`CONNECT 127.0.0.1:${tp} HTTP/1.1\r\nHost: x\r\nProxy-Authorization: Basic ${Buffer.from("vyre:tok").toString("base64")}\r\n\r\n`)); s.on("data", d => { b += d; if (b.includes("\r\n")) res({ s, line: b.split("\r\n")[0] }); }); s.on("error", () => res({ s, line: "error" })); });
  const socks = []; let last = "";
  for (let i = 0; i <= MAX_TUNNELS; i++) { const r = await open(); socks.push(r.s); last = r.line; }
  socks.forEach(s => s.destroy());
  assert.match(last, / 403 /, "the tunnel over the cap is refused");
});

// ---- the lead's ruling and reviewer-2's E-1, reviewer-3's HS-8 -----------------------------------------------------------

import { homeEnv } from "./homesandbox.js";
test("a provider entry without a relocatable config folder does not start sandboxed, with one plain reason", async t => {
  const r = await rig(t);
  const noPrivate = { command: process.execPath, versionArgs: ["-v"], hosts: [] };
  assert.throws(() => planHome({ ...base(r, { agent: noPrivate }), command: process.execPath }), /this assistant can't run sandboxed yet/);
  await assert.rejects(() => selfTest(base(r, { agent: noPrivate })), /can't run sandboxed yet/);
});

test("env allow-list: planted credentials never reach the plan, and only a name the caller lists is passed", async t => {
  const planted = { RAILWAY_TOKEN: "t1", AWS_SECRET_ACCESS_KEY: "t2", GITHUB_TOKEN: "t3", ANTHROPIC_API_KEY: "t4", OPENAI_API_KEY: "t5", LD_PRELOAD: "x", PATH: "/usr/bin", LANG: "C", VYRE_THREAD: "th1" };
  const e = homeEnv(planted);
  assert.deepEqual(Object.keys(e).sort(), ["LANG", "PATH", "VYRE_THREAD"]);
  assert.equal(homeEnv(planted, ["ANTHROPIC_API_KEY"]).ANTHROPIC_API_KEY, "t4");
  const r = await rig(t);
  const p = planHome({ ...base(r), command: process.execPath, env: planted });
  assert.ok(!JSON.stringify(p.argv).includes("RAILWAY_TOKEN") && !JSON.stringify(p.env).includes("t1") && !JSON.stringify(p.argv).includes('"t2"'));
});

test("HS-8: an entry that contains a Vyre home outside the person's home is refused", async t => {
  const r = await rig(t);
  const outer = tmp(); t.after(() => rm(outer));
  const vyre = path.join(outer, "var", "lib", "vyre"); fs.mkdirSync(vyre, { recursive: true });
  assert.throws(() => planHome({ ...base(r), command: process.execPath, vyreHome: vyre, workdirs: [path.join(outer, "var")] }), /contains/);
  assert.throws(() => planHome({ ...base(r), command: process.execPath, vyreHome: vyre, workdirs: [vyre] }), /inside|contains/);
});

import { isPublicAddress, resolvePublic } from "./netguard.js";
test("internet mode: only public addresses; loopback, private, link-local, CGNAT, the machine's own and mapped forms are refused", () => {
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip, []), true, ip);
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.100.100.100", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) assert.equal(isPublicAddress(ip, []), false, ip);
  assert.equal(isPublicAddress("203.0.113.9", ["203.0.113.9"]), false, "this machine's own public address");
});

test("internet mode: a name with any private answer is refused whole, and CONNECT dials the checked address", async t => {
  await assert.rejects(() => resolvePublic("evil.example", { lookup: async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }], own: [] }), /not a public/);
  const held = new Set(); const target = net.createServer(c => { held.add(c); c.on("error", () => {}); c.end("pong"); }); await new Promise(r => target.listen({ port: 0, host: "127.0.0.1" }, r)); t.after(() => { held.forEach(c => c.destroy()); target.close(); });
  const tp = target.address().port; const dialed = [];
  const mk = lookup => createEgress({ routes: [], vault: {}, session: "s", token: "tok", internet: true, lookup, dial: (ip, port) => { dialed.push(ip + ":" + port); return net.connect(tp, "127.0.0.1"); } });
  const ask = (egPort, host) => new Promise(res => { const s = net.connect(egPort, "127.0.0.1"); let b = ""; s.on("connect", () => s.write(`CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\nProxy-Authorization: Basic ${Buffer.from("vyre:tok").toString("base64")}\r\n\r\n`)); s.on("data", d => { b += d; if (b.includes("\r\n")) { s.destroy(); res(b.split("\r\n")[0]); } }); s.on("error", () => res("error")); setTimeout(() => res("timeout"), 3000); });
  const egPublic = mk(async () => [{ address: "93.184.216.34" }]); const a = await egPublic.listen(); t.after(() => egPublic.close());
  assert.match(await ask(a.port, "files.example:443"), / 200 /);
  assert.deepEqual(dialed, ["93.184.216.34:443"], "it dialled the address it had checked");
  assert.match(await ask(a.port, "files.example:25"), / 403 /, "no mail relay");
  const egPriv = mk(async () => [{ address: "127.0.0.1" }]); const b = await egPriv.listen(); t.after(() => egPriv.close());
  assert.match(await ask(b.port, "rebind.example:443"), / 403 /, "a name that resolves to loopback is refused");
  assert.match(await ask(b.port, "127.0.0.1:22"), / 403 /, "a literal loopback address is refused");
});

import http from "node:http";
test("internet mode: plain HTTP through the proxy goes only to public addresses", async t => {
  const up = http.createServer((q, r) => r.end("hello-from-upstream")); await new Promise(r => up.listen(0, "127.0.0.1", r)); t.after(() => up.close());
  const eg = createEgress({ routes: [], vault: {}, session: "s", token: "tok", internet: true, lookup: async h => [{ address: h === "private.example" ? "10.0.0.9" : "127.0.0.1" }] });
  const { port } = await eg.listen(); t.after(() => eg.close());
  const get = (url, auth = "tok") => new Promise(res => { const q = http.request({ hostname: "127.0.0.1", port, path: url, method: "GET", headers: { host: new URL(url).host, ...(auth ? { "proxy-authorization": "Basic " + Buffer.from("vyre:" + auth).toString("base64") } : {}) } }, m => { let b = ""; m.on("data", d => b += d); m.on("end", () => res({ s: m.statusCode, b })); }); q.on("error", () => res({ s: 0 })); q.end(); });
  // the stand-in "public" resolver answers loopback, which the guard refuses: the test proves the refusal, and the unit above proves the allow path
  assert.equal((await get(`http://pypi.example:${up.address().port}/simple/`)).s, 403);
  assert.equal((await get("http://private.example/x")).s, 403);
  assert.equal((await get("http://pypi.example/x", "")).s, 407);
});
