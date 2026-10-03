import "./testing/hosted-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { place, hereBlock, deviceState } from "./placement.js";
import { createLease } from "./lease.js";
import { createEgress } from "./egress.js";
import { plan, seatbeltProfile, cleanEnv, unavailable } from "./sandbox.js";
import { workspaceUnavailable, driverFor } from "./workspace.js";
import { createSessionSync, restore, localReaderFor } from "./sync.js";
import { createRunner } from "./runner.js";
import { fakeSpace } from "./testing/fake-space.js";

const hmac = s => crypto.createHmac("sha256", "test-seal-key").update(s).digest("hex");
const seal = st => ({ ...st, mac: hmac(JSON.stringify(st)) });
const unseal = st => { const { mac, ...rest } = st || {}; return Boolean(mac) && mac === hmac(JSON.stringify(rest)); };
const tmp = () => fs.mkdtempSync(path.join(SCRATCH, "rn-"));
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
    assert.match(refused, /403/);
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
    assert.ok(!a.includes("/home") && !a.includes("/root"));
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

// ---- the real thing: sandbox + encrypted workspace + proxy + sync, on this machine --------------------------------

const SKIP = unavailable() || workspaceUnavailable() || "";

/** Every byte under a folder, except mounted workspace views, as one string-searchable list of [file, buffer]. */
function* diskFiles(root) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const f = path.join(root, e.name);
    if (e.name === "mnt") continue;
    if (e.isDirectory()) yield* diskFiles(f); else if (e.isFile()) yield [f, fs.readFileSync(f)];
  }
}
const findOnDisk = (root, needles) => { const hits = []; for (const [f, b] of diskFiles(root)) for (const n of needles) if (b.includes(Buffer.from(n))) hits.push([f, n]); return hits; };

async function rig(t, over = {}) {
  const base = tmp(); const agentDir = tmp(); const outsideDir = tmp();
  fs.copyFileSync(new URL("./testing/fake-agent.js", import.meta.url), path.join(agentDir, "agent.js"));
  fs.writeFileSync(path.join(outsideDir, "private.txt"), "OUTSIDE-PRIVATE-FILE");
  const up = await upstream();
  const sp = over.space || fakeSpace({ ttlMs: over.ttlMs || 3_600_000 });
  const grants = over.grants || { spaceAllows: true, memberAccepts: true };
  const server = { starts: 0 };
  const mk = (b = base) => createRunner({ base: b, space: "harlow", device: "kit", vault: sp.vault, sync: sp.sync, grants: () => grants, requestServer: () => { server.starts++; }, retryMs: 50, sealState: seal, verifyState: unseal, sessionState: s => ({ v: 1, session: s, taint: "external" }) });
  const runner = mk();
  const routes = [{ prefix: "/provider", upstream: `http://127.0.0.1:${up.port}`, credential: { header: "x-api-key" }, allow: [{ method: "GET", path: "/v1/messages" }, { method: "POST", path: "/v1/messages" }] },
    { prefix: "/space", upstream: `http://127.0.0.1:${up.port}/api`, credential: { header: "authorization", prefix: "Bearer " }, allow: [{ method: "GET", path: "/gmail/*" }] }];
  const launch = (r, session, extra = {}) => r.start({ session, command: process.execPath, args: [path.join(agentDir, "agent.js")], readOnly: [agentDir, path.dirname(process.execPath)], routes,
    env: { VYRE_PROBE_FILE: path.join(outsideDir, "private.txt"), VYRE_PROBE_HOME: process.env.HOME || process.env.USERPROFILE || "/root", VYRE_PROBE_PORT: String(up.port) }, ...extra });
  t.after(async () => { try { await runner.stopAll(); await runner.lock(); } catch {} await up.close(); for (const d of [base, agentDir, outsideDir]) rm(d); });
  return { base, runner, sp, up, routes, launch, server, mk };
}
const lines = (h, n) => new Promise(res => { const got = []; h.child.stdout.on("data", d => { for (const l of String(d).split("\n").filter(Boolean)) got.push(JSON.parse(l)); if (got.length >= n) res(got); }); });
const waitFor = async (fn, ms = 10000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error("timed out"); };

test("runner: a session runs on this computer, sees only its workspace, reaches only the proxy, and the server stays idle", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  const events = [];
  h.child.stdout.on("data", d => { for (const l of String(d).split("\n").filter(Boolean)) events.push(JSON.parse(l)); });
  h.send("turn write the memo");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  h.send("probe");
  const probe = await waitFor(() => events.find(e => e.type === "probe"));
  assert.ok(["EPERM", "ENOENT", "EACCES"].includes(probe.outside), "cannot read a file outside the workspace: " + probe.outside);
  assert.ok(["EPERM", "ENOENT", "EACCES"].includes(probe.homeList), "cannot list the home folder: " + probe.homeList);
  assert.equal(probe.envHasSecret, false, "no real credential in the session's environment");
  assert.equal(probe.envToken, true);
  assert.notEqual(probe.net, "CONNECTED", "no direct network: " + probe.net);
  assert.notEqual(probe.net2, "CONNECTED", "no internet: " + probe.net2);
  assert.equal(probe.provider.status, 200, JSON.stringify(probe.provider));
  assert.equal(probe.noToken.status, 401);
  assert.equal(probe.space.status, 200);
  assert.equal(probe.other.status, 403);
  assert.equal(r.up.seen.find(s => s.url === "/v1/messages").headers["x-api-key"], "tk-REAL-PROVIDER-SECRET-0001");
  assert.ok(!JSON.stringify(events).includes("REAL-PROVIDER-SECRET"), "the secret is not in anything the session saw");
  // Transcript and files reached the space.
  const tr = r.sp.state.transcript.get("s1").map(e => JSON.parse(e.line));
  assert.ok(tr.some(e => e.text === "did write the memo"));
  assert.equal(r.sp.state.files.get("s1|files/notes.txt").length, 1);
  assert.equal(r.server.starts, 0, "the space's server started nothing");
  assert.equal(r.runner.decide().where === "here" || /battery|busy|memory/.test(r.runner.decide().reason), true);
  await h.stop();
});

test("runner: both grants are required to start", { skip: SKIP || false }, async t => {
  const r = await rig(t, { grants: { spaceAllows: true, memberAccepts: false } });
  await assert.rejects(() => r.launch(r.runner, "s1"), /both grants/);
  const r2 = await rig(t, { grants: { spaceAllows: false, memberAccepts: true } });
  await assert.rejects(() => r2.launch(r2.runner, "s1"), /both grants/);
});

test("runner: a disk search finds no credential and no plaintext transcript, running or locked", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  const key = r.sp.state.key;
  h.send("turn CANARY-TRANSCRIPT-7741");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  h.send("probe");
  await waitFor(() => r.up.seen.some(s => s.headers.authorization));
  const needles = ["CANARY-TRANSCRIPT-7741", "REAL-PROVIDER-SECRET", "REAL-GMAIL-SECRET", key.toString("hex"), key.toString("base64")];
  assert.deepEqual(findOnDisk(r.base, needles), [], "nothing readable on the raw disk while the session runs");
  await h.stop();
  await r.runner.lock();
  assert.deepEqual(findOnDisk(r.base, needles), [], "nothing readable once the workspace is locked");
  assert.equal(r.runner.status().open, false);
});

test("runner: after revoke the workspace is gone and no key is issued again", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  h.send("turn secret work");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  const dir = r.runner.dir;
  assert.ok(fs.existsSync(dir));
  r.sp.state.revoked = true;
  await r.runner.revoke();
  assert.equal(fs.existsSync(dir), false, "the encrypted workspace was deleted");
  await h.done;
  await assert.rejects(() => r.launch(r.runner, "s2"), /access to this space has ended/);
});

test("runner: a machine that was offline at revoke deletes its workspace on next contact", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  h.send("turn work");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  await r.runner.lock();
  const dir = r.runner.dir;
  assert.ok(fs.existsSync(dir), "locked, still on disk");
  assert.deepEqual(findOnDisk(dir, ["work"]), [], "and unreadable");
  r.sp.state.revoked = true;
  const c = await r.runner.contact();
  assert.equal(c.ok, false);
  assert.equal(fs.existsSync(dir), false);
});

test("runner: when the lease ends the workspace locks, the session stops, and the data is unreadable", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t, { ttlMs: 12000 });
  const h = await r.launch(r.runner, "s1");
  h.send("turn before expiry");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  r.sp.state.offline = true;
  await h.done;
  await waitFor(() => r.runner.status().open === false);
  assert.equal(r.runner.lease.key(), null);
  assert.equal(r.runner.status().state, "locked");
  assert.deepEqual(findOnDisk(r.runner.dir, ["before expiry"]), []);
  // Back online and still a member: it opens again with the same data.
  r.sp.state.offline = false;
  const c = await r.runner.contact();
  assert.equal(c.ok, true);
  const nf = path.join(r.runner.mnt, "work", "files", "notes.txt");
  if (!fs.existsSync(nf)) console.log("DEBUG missing; files:", fs.readdirSync(path.join(r.runner.mnt, "work", "files")), "work:", fs.readdirSync(path.join(r.runner.mnt, "work")), "mnt:", fs.readdirSync(r.runner.mnt), "events:", JSON.stringify(r.events || []));
  assert.equal(fs.readFileSync(nf, "utf8"), "before expiry\n");
});

test("runner: a stopped machine's session resumes on another machine from the last turn", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  const ev = [];
  h.child.stdout.on("data", d => { for (const l of String(d).split("\n").filter(Boolean)) ev.push(JSON.parse(l)); });
  h.send("turn one");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  h.send("turn two");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 2);
  h.send("half three");           // changes a file, then the machine dies before the turn ends
  await h.done;
  assert.equal(r.sp.state.checkpoints.get("s1").turn, 2, "the half turn was never checkpointed");
  // Another computer, its own disk, the same space.
  const base2 = tmp();
  const other = r.mk(base2);
  t.after(async () => { try { await other.stopAll(); await other.lock(); } catch {} rm(base2); });
  const h2 = await r.launch(other, "s1", { resume: true });
  const ev2 = [];
  h2.child.stdout.on("data", d => { for (const l of String(d).split("\n").filter(Boolean)) ev2.push(JSON.parse(l)); });
  const resumed = await waitFor(() => ev2.find(e => e.type === "resumed"));
  assert.equal(resumed.turn, 2);
  assert.equal(h2.resumed.turn, 2);
  assert.deepEqual(h2.resumed.state.session, { v: 1, session: "s1", taint: "external" }, "the session state comes back to the caller");
  assert.equal(resumed.notes, "one\ntwo\n");
  assert.ok(!resumed.files.includes("half.txt"), "the unfinished turn's change did not carry over");
  assert.ok(resumed.files.includes("notes.txt"));
  // The agent's own session files came along too.
  assert.match(fs.readFileSync(path.join(other.mnt, "work", "home", ".claude", "projects", "s.jsonl"), "utf8"), /"said":"two"/);
  h2.send("turn three");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 3);
  await h2.stop();
});

test("runner: move to server takes a stop here and asks the server to resume", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  h.send("turn a");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  await r.runner.moveToServer("s1");
  assert.equal(r.server.starts, 1);
  assert.deepEqual(r.runner.status().sessions, []);
});

test("workspace: a wrong key never opens it and a drive image holds no plaintext", { skip: SKIP || false, timeout: 60_000 }, async t => {
  const d = tmp(); t.after(() => rm(d));
  const drv = driverFor(process.platform, { sizeGb: 1 });
  const key = crypto.randomBytes(32), wrong = crypto.randomBytes(32);
  const dir = path.join(d, "w");
  await drv.create(dir, key);
  const m = await drv.mount(dir, key);
  fs.writeFileSync(path.join(m, "x.txt"), "PLAINTEXT-IN-WORKSPACE-9");
  await drv.unmount(dir);
  assert.deepEqual(findOnDisk(dir, ["PLAINTEXT-IN-WORKSPACE-9"]), []);
  await assert.rejects(() => drv.mount(dir, wrong));
  await drv.destroy(dir);
  assert.equal(fs.existsSync(dir), false);
});
