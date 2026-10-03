import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { planHome, selfTest, homeSeatbelt } from "./homesandbox.js";
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
  const servers = await Promise.all([listen(own), listen(other), listen(person), listen({ port: 0, host: "127.0.0.1" })]);
  t.after(() => servers.forEach(s => { s.close(); }));
  const port = servers[3].address().port;
  fs.mkdirSync(path.join(home, "Documents"), { recursive: true }); fs.writeFileSync(path.join(home, "Documents", "private.txt"), "PERSONAL");
  const proj = path.join(home, "proj"), settings = path.join(home, ".agentcfg"), temp = path.join(home, "tmp-session"); for (const d of [proj, settings, temp]) fs.mkdirSync(d, { recursive: true });
  const agent = { command: process.execPath, versionArgs: ["-v"], settingsPaths: [settings], hosts: [] };
  return { home, own, other, person, port, proj, settings, temp, agent, probes: { personSocket: person, otherSocket: other, daemonPorts: [port], keyFile: path.join(home, ".vyre", "keys", "device.key"), homeFile: path.join(home, "Documents", "private.txt") } };
}

test("home sandbox: the person's socket, another session's socket, the daemon's loopback port and the Vyre home are all out of reach; the session's own socket works", { skip: SKIP, timeout: 60_000 }, async t => {
  const r = await rig(t);
  const res = await selfTest({ platform: process.platform, command: process.execPath, home: r.home, vyreHome: path.join(r.home, ".vyre"), sessionSocket: r.own, workdirs: [r.proj], temp: r.temp, agent: r.agent, probes: r.probes });
  assert.deepEqual(res.failures, [], JSON.stringify(res.results));
  assert.equal(res.ok, true);
  assert.equal(res.results.ownSocket, "connected");
  assert.notEqual(res.results.personSocket, "connected");
  assert.notEqual(res.results.homeFile, "READ", "a personal file outside the allowed paths is denied");
  assert.deepEqual(res.results.writes, ["ok", "ok", "ok"], "settings, temp and project are usable");
});

test("home sandbox: the self-test also fails when the agent cannot reach its host or cannot start", { skip: SKIP, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const base = { platform: process.platform, command: process.execPath, home: r.home, vyreHome: path.join(r.home, ".vyre"), sessionSocket: r.own, workdirs: [r.proj], temp: r.temp, probes: r.probes };
  const noHost = await selfTest({ ...base, agent: { ...r.agent, hosts: ["127.0.0.1:9"] } });
  assert.ok(noHost.failures.some(f => /cannot reach 127\.0\.0\.1:9/.test(f)), noHost.failures.join("; "));
  const noStart = await selfTest({ ...base, agent: { ...r.agent, command: process.execPath, versionArgs: ["-e", "process.exit(3)"] } });
  assert.ok(noStart.failures.some(f => /does not start inside the sandbox \(exit 3/.test(f)), noStart.failures.join("; "));
});

test("home sandbox: the self-test fails when a hole is left (the person's socket is the session's own)", { skip: SKIP, timeout: 60_000 }, async t => {
  const r = await rig(t);
  const res = await selfTest({ platform: process.platform, command: process.execPath, home: r.home, vyreHome: path.join(r.home, ".vyre"), sessionSocket: r.person, workdirs: [r.proj], temp: r.temp, agent: r.agent, probes: process.platform === "linux" ? { ...r.probes, personSocket: "/run/vyre-session.sock" } : r.probes });
  assert.equal(res.ok, false);
  assert.ok(res.failures.some(f => /person's own socket is reachable/.test(f)), res.failures.join("; "));
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
  assert.match(await ask(`127.0.0.1:${tp}`, "wrong"), / 403 /);
  assert.match(await ask(`127.0.0.1:${tp}`, ""), / 403 /);
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
