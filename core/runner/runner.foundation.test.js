import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import "./testing/require-sandbox.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { SCRATCH, runnerScratch } from "../../test/scratch.mjs";
import { place, hereBlock, deviceState } from "./placement.js";
import { createLease } from "./lease.js";
import { createEgress } from "./egress.js";
import { plan, seatbeltProfile, cleanEnv, unavailable } from "./sandbox.js";
import { workspaceUnavailable, driverFor, fscryptSupported } from "./workspace.js";
import { createSessionSync, restore, localReaderFor } from "./sync.js";
import { createRunner } from "./runner.js";
import { HARNESS_MARK } from "./pipe-home.js";
const PLUGIN_FLAG = `--${"plugin-dir"}`;
import { pidsUnder } from "./proctree.js";
import { fakeSpace } from "./testing/fake-space.js";

const hmac = s => crypto.createHmac("sha256", "test-seal-key").update(s).digest("hex");
const seal = st => ({ ...st, mac: hmac(JSON.stringify(st)) });
const unseal = st => { const { mac, ...rest } = st || {}; return Boolean(mac) && mac === hmac(JSON.stringify(rest)); };
const tmp = () => runnerScratch("rn-");
const rm = d => fs.rmSync(d, { recursive: true, force: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- placement -------------------------------------------------------------------------------------------------

const calm = { onPower: true, awake: true, cpuPct: 10, memPct: 40 };
const both = { spaceAllows: true, memberAccepts: true };

test("placement: here when both grants exist and the device has room", () => {
  assert.equal(place({ ...both, state: calm }).where, "here");
});

test("placement: no grant, no local run, and the reason names the missing side", () => {
  assert.match(hereBlock({ spaceAllows: false, memberAccepts: true, state: calm }), /has not allowed members/);
  assert.match(hereBlock({ spaceAllows: true, memberAccepts: false, state: calm }), /not set to run this space's work/);
});

test("placement: device limits move the session to the server, then to waiting, each with a plain reason", () => {
  const server = { available: true, hasRoom: true };
  const battery = place({ ...both, state: { ...calm, onPower: false }, server });
  assert.equal(battery.where, "server");
  assert.match(battery.reason, /plugged in/);
  assert.equal(place({ ...both, state: { ...calm, cpuPct: 95 }, server }).where, "server");
  assert.equal(place({ ...both, state: { ...calm, memPct: 95 }, server }).where, "server");
  const full = place({ ...both, state: { ...calm, onPower: false }, server: { available: true, hasRoom: false } });
  assert.equal(full.where, "wait");
  assert.match(full.reason, /server is full/);
  assert.match(place({ ...both, state: { ...calm, onPower: false } }).reason, /no server/);
  assert.match(place({ ...both, state: { ...calm, onPower: false }, server: { available: false, hasRoom: false, why: "the server is offline" } }).reason, /server is offline/);
});

test("placement: the person's own limits are respected, and pinning to the server wins", () => {
  assert.equal(place({ ...both, state: { ...calm, onPower: false }, limits: { onlyOnPower: false } }).where, "here");
  assert.equal(place({ ...both, state: calm, pinnedToServer: true, server: { available: true, hasRoom: true } }).where, "server");
  assert.equal(place({ ...both, state: calm, pinnedToServer: true }).where, "wait");
});

test("placement: deviceState reads load, memory and power from the machine", () => {
  const os = { cpus: () => [1, 2], loadavg: () => [1, 0, 0], totalmem: () => 100, freemem: () => 25 };
  const s = deviceState({ os, platform: "darwin", run: () => "Now drawing from 'Battery Power'" });
  assert.equal(s.onPower, false);
  assert.equal(Math.round(s.cpuPct), 50);
  assert.equal(s.memPct, 75);
  assert.equal(deviceState({ os, platform: "darwin", run: () => "Now drawing from 'AC Power'" }).onPower, true);
});

// ---- lease -----------------------------------------------------------------------------------------------------

test("lease: the key is held in memory, renewed before it ends, and zeroed on lock", async () => {
  const sp = fakeSpace({ ttlMs: 400 });
  const locks = [];
  const l = createLease({ vault: sp.vault, space: "harlow", device: "kit", onLock: w => locks.push(w) });
  assert.deepEqual(await l.acquire(), { ok: true });
  const k = l.key();
  assert.equal(k.length, 32);
  await sleep(700);
  assert.ok(sp.state.renews >= 1, "renewed while access holds");
  assert.equal(l.state, "open");
  assert.ok(l.key(), "still open after one ttl because renewals extend it");
  await l.release();
  assert.equal(l.key(), null);
  assert.ok(k.every(b => b === 0), "the key buffer was zeroed");
  assert.deepEqual(locks, ["released"]);
});

test("lease: expiry locks when renewal keeps failing", async () => {
  const sp = fakeSpace({ ttlMs: 300 });
  const locks = [];
  const l = createLease({ vault: sp.vault, space: "harlow", device: "kit", retryMs: 20, onLock: w => locks.push(w) });
  await l.acquire();
  sp.state.offline = true;
  await sleep(450);
  assert.deepEqual(locks, ["expired"]);
  assert.equal(l.key(), null);
});

test("lease: a revoked answer on renewal locks and deletes", async () => {
  const sp = fakeSpace({ ttlMs: 200 });
  const log = [];
  const l = createLease({ vault: sp.vault, space: "harlow", device: "kit", onLock: w => log.push("lock:" + w), onRevoke: () => log.push("revoke") });
  await l.acquire();
  sp.state.revoked = true;
  await sleep(300);
  assert.deepEqual(log, ["lock:revoked", "revoke"]);
  assert.equal(l.state, "revoked");
});

test("lease: no key is issued for a revoked member", async () => {
  const sp = fakeSpace(); sp.state.revoked = true;
  const log = [];
  const l = createLease({ vault: sp.vault, space: "harlow", device: "kit", onRevoke: () => log.push("revoke") });
  const r = await l.acquire();
  assert.equal(r.ok, false);
  assert.deepEqual(log, ["revoke"]);
  assert.equal(l.key(), null);
});

// ---- egress: credentials at the point of use -------------------------------------------------------------------

async function upstream() {
  const seen = [];
  const s = http.createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); });
  await new Promise(r => s.listen(0, "127.0.0.1", r));
  return { port: s.address().port, seen, close: () => new Promise(r => { s.closeAllConnections(); s.close(r); }) };
}
const get = (port, p, headers = {}, method = "GET") => new Promise(res => { const q = http.request({ hostname: "127.0.0.1", port, path: p, method, headers }, m => { let b = ""; m.on("data", d => b += d); m.on("end", () => res({ status: m.statusCode, body: b })); }); q.on("error", e => res({ error: e.code })); q.end(); });

test("egress: the vault is asked per request, the secret goes only into the outgoing header, the token never leaves", async () => {
  const up = await upstream(); const sp = fakeSpace();
  const routes = [{ prefix: "/provider", upstream: `http://127.0.0.1:${up.port}`, credential: { header: "x-api-key" }, allow: [{ method: "GET", path: "/v1/messages" }, { method: "POST", path: "/v1/messages" }] },
    { prefix: "/space", upstream: `http://127.0.0.1:${up.port}/api`, credential: { header: "authorization", prefix: "Bearer " }, allow: [{ method: "GET", path: "/gmail/*" }] }];
  const eg = createEgress({ routes, vault: sp.vault, session: "s1", token: "tok-abc", lease: () => "lease-1" });
  const { port } = await eg.listen();
  try {
    const a = await get(port, "/provider/v1/messages?x=1", { "x-api-key": "tok-abc", "x-vyre-extra": "keep" });
    assert.equal(a.status, 200);
    assert.equal(up.seen[0].headers["x-api-key"], "tk-REAL-PROVIDER-SECRET-0001");
    assert.equal(up.seen[0].url, "/v1/messages?x=1");
    assert.equal(up.seen[0].headers["x-vyre-extra"], "keep");
    await get(port, "/provider/v1/messages", { "x-api-key": "tok-abc" });
    assert.equal(sp.state.uses.length, 2, "asked once per request, never cached");
    const b = await get(port, "/space/gmail/inbox", { authorization: "Bearer tok-abc" });
    assert.equal(b.status, 200);
    assert.equal(up.seen[2].url, "/api/gmail/inbox");
    assert.equal(up.seen[2].headers.authorization, "Bearer ya29.REAL-GMAIL-SECRET");
    assert.ok(!JSON.stringify(up.seen).includes("tok-abc"), "the session token is not forwarded");
  } finally { await eg.close(); await up.close(); }
});

test("egress: no token, a wrong token, an unlisted path and CONNECT are all refused, and nothing is fetched", async () => {
  const up = await upstream(); const sp = fakeSpace();
  const eg = createEgress({ routes: [{ prefix: "/provider", upstream: `http://127.0.0.1:${up.port}`, credential: { header: "x-api-key" }, allow: [{ method: "GET", path: "/v1/messages" }, { method: "POST", path: "/v1/messages" }] }], vault: sp.vault, session: "s1", token: "tok-abc", lease: () => "lease-1" });
  const { port } = await eg.listen();
  try {
    assert.equal((await get(port, "/provider/x")).status, 401);
    assert.equal((await get(port, "/provider/x", { "x-api-key": "nope" })).status, 401);
    assert.equal((await get(port, "/other/x", { "x-api-key": "tok-abc" })).status, 403);
    assert.equal((await get(port, "http://evil.example/x", { "x-api-key": "tok-abc" })).status, 403);
    assert.equal(sp.state.uses.length, 0);
    assert.equal(up.seen.length, 0);
    const refused = await new Promise(res => { const s = net_connect(port); s.on("data", d => res(String(d))); s.on("error", () => res("error")); });
    assert.match(refused, /40[37]/);
  } finally { await eg.close(); await up.close(); }
});

import net from "node:net";
function net_connect(port) { const s = net.connect(port, "127.0.0.1"); s.write("CONNECT evil.example:443 HTTP/1.1\r\nHost: evil.example:443\r\n\r\n"); return s; }

test("egress: when the vault fails the request fails plainly and nothing goes upstream", async () => {
  const up = await upstream(); const sp = fakeSpace(); sp.state.offline = true;
  const eg = createEgress({ routes: [{ prefix: "/provider", upstream: `http://127.0.0.1:${up.port}`, credential: { header: "x-api-key" }, allow: [{ method: "GET", path: "/v1/messages" }, { method: "POST", path: "/v1/messages" }] }], vault: sp.vault, session: "s1", token: "t", lease: () => "lease-1" });
  const { port } = await eg.listen();
  try {
    const r = await get(port, "/provider/v1/messages", { "x-api-key": "t" });
    assert.equal(r.status, 502);
    assert.equal(up.seen.length, 0);
    assert.ok(!r.body.includes("SECRET"));
  } finally { await eg.close(); await up.close(); }
});

test("egress: a route needs a one-segment prefix and an https upstream", () => {
  assert.throws(() => createEgress({ routes: [{ prefix: "/a/b", upstream: "https://x.example" }], vault: {}, session: "s", token: "t" }));
  assert.throws(() => createEgress({ routes: [{ prefix: "/a", upstream: "http://x.example" }], vault: {}, session: "s", token: "t" }));
});

// ---- sandbox plans ---------------------------------------------------------------------------------------------

test("sandbox: the environment is cut to known keys", () => {
  const e = cleanEnv({ PATH: "/x", LD_PRELOAD: "evil", NODE_OPTIONS: "--x", AWS_SECRET_ACCESS_KEY: "k", VYRE_SESSION: "s", ANTHROPIC_API_KEY: "t" });
  assert.deepEqual(Object.keys(e).sort(), ["ANTHROPIC_API_KEY", "PATH", "VYRE_SESSION"]);
});

test("sandbox: the seatbelt profile denies by default and opens only the workspace and the proxy port", () => {
  const ws = tmp();
  try {
    const p = seatbeltProfile({ platform: "darwin", workspace: ws, command: process.execPath, readOnly: [path.dirname(process.execPath)], proxy: { port: 4567 } });
    assert.match(p, /^\(version 1\)\n\(deny default\)/);
    assert.match(p, /network-outbound \(remote ip "localhost:4567"\)/);
    assert.ok(!/\/Users\b/.test(p.replace(/\(allow file-read-metadata[^\n]*\n/g, "").replace(path.dirname(process.execPath), "")) || process.execPath.startsWith("/Users"), "the profile never opens /Users as a whole");
    assert.doesNotMatch(p, /network\*|\(allow network-outbound\)/);
  } finally { rm(ws); }
});

test("sandbox: the bubblewrap plan unshares everything, mounts nothing of the host but the system, and clears the environment", () => {
  const ws = tmp();
  try {
    const p = plan({ platform: "linux", workspace: ws, command: "/usr/bin/node", args: ["a.js"], proxy: { socket: path.join(ws, "e.sock") }, env: { AWS_SECRET: "x", VYRE_SESSION: "s" } });
    const a = p.argv;
    assert.equal(a[0], "bwrap");
    for (const f of ["--unshare-all", "--clearenv", "--die-with-parent", "--new-session"]) assert.ok(a.includes(f), f);
    assert.ok(!a.includes("--share-net"));
    assert.ok(!a.includes("AWS_SECRET"));
    const binds = a.reduce((acc, x, i) => (x === "--bind" ? acc.concat([a[i + 1]]) : acc), []);
    assert.deepEqual(binds, [fs.realpathSync(ws)], "the only writable host path is the workspace");
    const nodePath = fs.realpathSync(process.execPath);
    const hostPath = (/** @type {string} */ flag) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : [])).filter(Boolean);
    const isHomeTree = (/** @type {string} */ p) => { try { const r = fs.realpathSync(p); return r !== nodePath && (r.startsWith("/home") || r.startsWith("/root")); } catch { return false; } };
    assert.ok(!hostPath("--bind").some(isHomeTree), "the host home is not mounted");
    assert.ok(!hostPath("--ro-bind").some(isHomeTree), "only the node binary may be read from under the host home, never the tree");
    assert.ok(a.some((x, i) => x === "--tmpfs" && a[i + 1] === "/home"), "HOME lives on a tmpfs inside the sandbox");
  } finally { rm(ws); }
});

// ---- sync and checkpoints --------------------------------------------------------------------------------------

test("sync: a checkpoint records the transcript and changed files as versions, and restore rebuilds them elsewhere", async () => {
  const sp = fakeSpace(); const a = tmp(), b = tmp();
  try {
    for (const d of ["work/files", "work/home/.claude", "state"]) fs.mkdirSync(path.join(a, d), { recursive: true });
    const sy = createSessionSync({ space: sp.sync, session: "s1", work: path.join(a, "work"), state: path.join(a, "state"), reader: localReaderFor(path.join(a, "work")), seal: s => s });
    fs.writeFileSync(path.join(a, "work", "files", "doc.txt"), "v1");
    await sy.line('{"type":"assistant"}'); await sy.line('{"type":"result"}');
    assert.equal(await sy.checkpoint({ note: 1 }), true);
    fs.writeFileSync(path.join(a, "work", "files", "doc.txt"), "v2");
    await sy.line('{"type":"result"}');
    assert.equal(await sy.checkpoint(), true);
    assert.equal(sp.state.files.get("s1|files/doc.txt").length, 2, "two versions, no merge");
    assert.equal(sy.turn, 2);
    // A different machine restores from the space.
    fs.mkdirSync(path.join(b, "work", "files"), { recursive: true });
    const r = await restore({ space: sp.sync, session: "s1", work: path.join(b, "work"), state: path.join(b, "state"), verify: () => true });
    assert.equal(r.turn, 2);
    assert.equal(fs.readFileSync(path.join(b, "work", "files", "doc.txt"), "utf8"), "v2");
    assert.equal(fs.readFileSync(path.join(b, "state", "s1", "transcript.jsonl"), "utf8").split("\n").filter(Boolean).length, 3);
  } finally { rm(a); rm(b); }
});

test("sync: when the space is unreachable the checkpoint is not claimed, and the lines wait in the outbox", async () => {
  const sp = fakeSpace(); const a = tmp();
  try {
    fs.mkdirSync(path.join(a, "work", "files"), { recursive: true });
    const sy = createSessionSync({ space: sp.sync, session: "s1", work: path.join(a, "work"), state: path.join(a, "state"), reader: localReaderFor(path.join(a, "work")), seal: s => s });
    sp.state.offline = true;
    await sy.line('{"type":"assistant"}');
    assert.equal(await sy.checkpoint(), false);
    assert.equal(sy.turn, 0);
    sp.state.offline = false;
    assert.equal(await sy.checkpoint(), true);
    assert.equal(sy.acked, 1);
  } finally { rm(a); }
});
