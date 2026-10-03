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
  return { home, own, other, person, port, probes: { personSocket: person, otherSocket: other, daemonPorts: [port], keyFile: path.join(home, ".vyre", "keys", "device.key") } };
}

test("home sandbox: the person's socket, another session's socket, the daemon's loopback port and the Vyre home are all out of reach; the session's own socket works", { skip: SKIP, timeout: 60_000 }, async t => {
  const r = await rig(t);
  const res = await selfTest({ platform: process.platform, command: process.execPath, home: r.home, vyreHome: path.join(r.home, ".vyre"), sessionSocket: r.own, probes: r.probes });
  assert.deepEqual(res.failures, [], JSON.stringify(res.results));
  assert.equal(res.ok, true);
  assert.equal(res.results.ownSocket, "connected");
  assert.notEqual(res.results.personSocket, "connected");
});

test("home sandbox: the self-test fails when a hole is left (the person's socket is the session's own)", { skip: SKIP, timeout: 60_000 }, async t => {
  const r = await rig(t);
  const res = await selfTest({ platform: process.platform, command: process.execPath, home: r.home, vyreHome: path.join(r.home, ".vyre"), sessionSocket: r.person, probes: process.platform === "linux" ? { ...r.probes, personSocket: "/run/vyre-session.sock" } : r.probes });
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
