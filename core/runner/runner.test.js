import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import "./testing/require-sandbox.js";
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
import { HARNESS_MARK } from "./pipe-home.js";
const PLUGIN_FLAG = `--${"plugin-dir"}`;
import { pidsUnder } from "./proctree.js";
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
  const server = { starts: 0, asked: [] };
  const mk = (b = base) => createRunner({ base: b, space: "harlow", device: "kit", vault: sp.vault, sync: sp.sync, grants: () => grants, requestServer: over.requestServer || ((session, reason) => { server.starts++; server.asked.push([session, reason]); }), retryMs: 50, ...(over.onEvent ? { onEvent: over.onEvent } : {}), sealState: seal, verifyState: unseal, sessionState: s => ({ v: 1, session: s, taint: "external" }) });
  const runner = mk();
  const routes = [{ prefix: "/provider", upstream: `http://127.0.0.1:${up.port}`, credential: { header: "x-api-key" }, allow: [{ method: "GET", path: "/v1/messages" }, { method: "POST", path: "/v1/messages" }] },
    { prefix: "/space", upstream: `http://127.0.0.1:${up.port}/api`, credential: { header: "authorization", prefix: "Bearer " }, allow: [{ method: "GET", path: "/gmail/*" }] }];
  const launch = (r, session, extra = {}) => r.start({ session, command: process.execPath, args: [path.join(agentDir, "agent.js"), ...(extra.moreArgs || [])], readOnly: [agentDir, path.dirname(process.execPath)], routes,
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

test("egress: a route's own static headers go with the credential (a sign-in token as a bearer with its beta flag, added to the program's own beta list), and bad ones are refused at the start", async () => {
  const up = await upstream(); const sp = fakeSpace();
  const route = { prefix: "/provider", upstream: `http://127.0.0.1:${up.port}`, credential: { header: "authorization", prefix: "Bearer " }, headers: { "anthropic-beta": "oauth-2025-04-20" }, allow: [{ method: "POST", path: "/v1/messages" }] };
  const eg = createEgress({ routes: [route], vault: sp.vault, session: "s1", token: "tok-abc", lease: () => "lease-1" });
  const { port } = await eg.listen();
  try {
    await get(port, "/provider/v1/messages", { "x-api-key": "tok-abc", "anthropic-beta": "evil-flag" }, "POST");
    assert.equal(up.seen[0].headers["anthropic-beta"], "evil-flag,oauth-2025-04-20", "the Space's flag is added to the program's own list");
    await get(port, "/provider/v1/messages", { "x-api-key": "tok-abc" }, "POST");
    assert.equal(up.seen[1].headers["anthropic-beta"], "oauth-2025-04-20");
    assert.match(up.seen[0].headers.authorization, /^Bearer tk-REAL/);
    assert.ok(!JSON.stringify(up.seen).includes("tok-abc"));
  } finally { await eg.close(); await up.close(); }
  for (const headers of [{ Authorization: "x" }, { "x-api-key": "x" }, { host: "x" }, { "bad name": "x" }, { "a-b": "line\nbreak" }, "no"]) {
    assert.throws(() => createEgress({ routes: [{ ...route, headers }], vault: sp.vault, session: "s", token: "t" }), /own headers/, JSON.stringify(headers));
  }
});

// ---- handing a session to the server, freezing, fencing (R031-95 2.4) -------------------------------------------------------------------------------------------------------------------
const procState = pid => { try { const t = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return t.slice(t.lastIndexOf(")") + 2, t.lastIndexOf(")") + 3); } catch { return ""; } };
const LINUX = process.platform === "linux";

test("runner: handing a session over freezes it, flushes the last turn, tells the server why, and only then ends it", { skip: SKIP || false, timeout: 90_000 }, async t => {
  /** @type {any} */ let seen = null;
  const r = await rig(t, { requestServer: (session, reason) => { seen = { session, reason, state: LINUX ? procState(h.pid) : "T", checkpoint: r.sp.state.checkpoints.get("s1")?.turn }; return { moved: true }; } });
  const h = await r.launch(r.runner, "s1");
  h.send("turn a");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  const events = []; 
  assert.deepEqual(await r.runner.moveToServer("s1", "lid-closed"), { moved: true });
  assert.deepEqual([seen.session, seen.reason, seen.state, seen.checkpoint], ["s1", "lid-closed", "T", 1], "frozen, with the last whole turn already at the space, when the server is told");
  assert.deepEqual(r.runner.status().sessions, [], "the server took it: it is gone here");
  void events;
});

test("runner: a server that holds the move back, or cannot be reached, leaves the session running", { skip: SKIP || false, timeout: 90_000 }, async t => {
  let answer = /** @type {any} */ ({ moved: false, why: "cooldown" });
  const r = await rig(t, { requestServer: () => { if (answer instanceof Error) throw answer; return answer; } });
  const h = await r.launch(r.runner, "s1");
  h.send("turn a");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  assert.deepEqual(await r.runner.moveToServer("s1", "unplugged"), { moved: false, why: "cooldown" });
  assert.deepEqual(r.runner.status().sessions, ["s1"]);
  if (LINUX) assert.notEqual(procState(h.pid), "T", "it carries on");
  answer = new Error("the server is not reachable");
  await assert.rejects(r.runner.moveToServer("s1", "unplugged"), /not reachable/);
  assert.deepEqual(r.runner.status().sessions, ["s1"]);
  if (LINUX) assert.notEqual(procState(h.pid), "T");
  h.send("turn b");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 2);
});

test("runner: Pause all freezes every session and keeps it frozen until resumed; this computer being offline is a second reason and does not thaw the first", { skip: SKIP || !LINUX || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  r.runner.pause();
  await waitFor(() => procState(h.pid) === "T"); assert.equal(r.runner.paused, true);
  assert.equal(r.runner.info()[0].paused, true);
  r.runner.freeze("offline"); r.runner.thaw("offline");
  await sleep(200); assert.equal(procState(h.pid), "T", "the person's pause is still in force");
  const h2 = await r.launch(r.runner, "s2");
  await waitFor(() => procState(h2.pid) === "T");
  r.runner.resume();
  await waitFor(() => procState(h.pid) !== "T" && procState(h2.pid) !== "T");
  assert.equal(r.runner.paused, false);
  r.runner.freeze("offline");
  await waitFor(() => procState(h.pid) === "T"); assert.equal(r.runner.paused, false, "offline is not the person's pause");
  r.runner.thaw("offline");
  await waitFor(() => procState(h.pid) !== "T");
});

test("runner: a fenced session ends at once and writes nothing more to the space", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  h.send("turn a");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  const before = r.sp.state.transcript.get("s1").length;
  assert.equal(await r.runner.fence("s1"), true);
  assert.deepEqual(r.runner.status().sessions, []);
  assert.equal(r.sp.state.transcript.get("s1").length, before, "nothing written after the fence");
  assert.equal(await r.runner.fence("s1"), false, "a session already gone is not fenced twice");
});

test("runner: when the lease ends the sessions are handed to the server first, with the reason the chat prints", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t, { ttlMs: 12000 });
  const h = await r.launch(r.runner, "s1");
  h.send("turn before expiry");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  r.sp.state.offline = true;
  await h.done;
  await waitFor(() => r.runner.status().open === false);
  assert.deepEqual(r.server.asked, [["s1", "lease-expired"]]);
});

test("runner: a hand-over under way is not woken by anything else, and a second ask joins the first", { skip: SKIP || !LINUX || false, timeout: 90_000 }, async t => {
  /** @type {(v: any) => void} */ let answer = () => {};
  let asked = 0;
  const r = await rig(t, { requestServer: () => { asked++; return new Promise(res => { answer = res; }); } });
  const h = await r.launch(r.runner, "s1");
  h.send("turn a");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  const first = r.runner.moveToServer("s1", "lid-closed"), second = r.runner.moveToServer("s1", "unplugged");
  assert.equal(first, second, "the same hand-over");
  await waitFor(() => procState(h.pid) === "T" && asked === 1);
  r.runner.freeze("offline"); r.runner.thaw("offline");   // a good heartbeat that thaws what was frozen for being offline
  await sleep(300);
  assert.equal(procState(h.pid), "T", "the session being handed over stays still");
  answer({ moved: true });
  assert.deepEqual(await first, { moved: true });
  assert.equal(asked, 1);
});

test("runner: a second start of a session that is being started is refused, and leaves no child", { skip: SKIP || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const a = r.launch(r.runner, "s1"), b = r.launch(r.runner, "s1");
  const out = await Promise.allSettled([a, b]);
  assert.deepEqual(out.map(x => x.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String(/** @type {any} */ (out.find(x => x.status === "rejected")).reason.message), /already/);
  assert.deepEqual(r.runner.status().sessions, ["s1"]);
});

test("runner: stopping a session that is frozen ends everything under it", { skip: SKIP || !LINUX || false, timeout: 90_000 }, async t => {
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  await waitFor(() => pidsUnder(h.pid).length > 0);
  const under = pidsUnder(h.pid);
  r.runner.pause();
  await waitFor(() => procState(h.pid) === "T");
  await r.runner.stop("s1");
  await waitFor(() => under.every(p => { try { process.kill(p, 0); return false; } catch { return true; } }), 8000);
  assert.deepEqual(r.runner.status().sessions, []);
});

test("runner: a session says why it ended: finished by itself, stopped by the person, or died", { skip: SKIP || !LINUX || false, timeout: 90_000 }, async t => {
  /** @type {any[]} */ const ended = [];
  const r = await rig(t, { onEvent: e => { if (e.type === "stopped") ended.push([e.session, e.why]); } });
  const a = await r.launch(r.runner, "fin");
  a.send("exit");   // the program ends itself, successfully
  await waitFor(() => ended.length === 1);
  const b = await r.launch(r.runner, "stp");
  await r.runner.stop("stp");
  const c = await r.launch(r.runner, "die");
  process.kill(c.pid, "SIGKILL");
  await waitFor(() => ended.length === 3);
  void b;
  assert.deepEqual(ended, [["fin", "finished"], ["stp", "stopped"], ["die", "crashed"]]);
});

test("runner: a server that never answers a hand-over leaves the session running, not frozen for ever", { skip: SKIP || !LINUX || false, timeout: 90_000 }, async t => {
  const r = await rig(t, { requestServer: () => new Promise(() => {}), handoverMs: 400 });
  const h = await r.launch(r.runner, "s1");
  h.send("turn a");
  await waitFor(() => r.sp.state.checkpoints.get("s1")?.turn === 1);
  await assert.rejects(r.runner.moveToServer("s1", "lid-closed"), /did not answer/);
  await waitFor(() => procState(h.pid) !== "T");
  assert.deepEqual(r.runner.status().sessions, ["s1"]);
  // and the next hand-over can be asked: the first left nothing set
  await assert.rejects(r.runner.moveToServer("s1", "lid-closed"), /did not answer/);
});

test("runner: a hand-over the home holds back, or that fails, does not wake a session the person paused", { skip: SKIP || !LINUX || false, timeout: 90_000 }, async t => {
  let answer = /** @type {() => any} */ (() => ({ moved: false, why: "cooldown" }));
  const r = await rig(t, { requestServer: () => answer(), handoverMs: 400 });
  const h = await r.launch(r.runner, "s1");
  r.runner.pause(); await waitFor(() => procState(h.pid) === "T");
  assert.deepEqual(await r.runner.moveToServer("s1", "lid-closed"), { moved: false, why: "cooldown" });
  await sleep(300);
  assert.equal(procState(h.pid), "T", "Pause all stands after a refused hand-over");
  answer = () => new Promise(() => {});
  await assert.rejects(r.runner.moveToServer("s1", "lid-closed"), /did not answer/);
  await sleep(300);
  assert.equal(procState(h.pid), "T", "and after one that never answered");
  r.runner.resume();
  await waitFor(() => procState(h.pid) !== "T");
});

test("seatbelt: the session may see that its door to Vyre exists (a hook checks VYRE_SOCKET before it trusts it), and open only that socket", () => {
  const sock = "/private/var/folders/zz/T/vyre-door-abc.sock";
  const p = seatbeltProfile({ platform: "darwin", workspace: "/tmp/ws", command: process.execPath, readOnly: [path.dirname(process.execPath)], proxy: { port: 4567 }, vyre: { socket: sock } });
  assert.match(p, new RegExp(`\\(allow network-outbound \\(remote unix-socket \\(path-literal "${sock}"\\)\\)\\)`));
  for (const d of [sock, "/private/var/folders/zz/T", "/private/var/folders/zz", "/private/var/folders"]) assert.ok(p.includes(`(allow file-read-metadata (literal "${d}"))`), d);
  assert.ok(!p.includes('(allow file-read* (subpath "/private/var/folders'), "a stat, never a read or a listing");
});

test("runner: a chat's session gets a door to Vyre (VYRE_SOCKET) that asks the home, and a Vyre folder the sandbox will not bind leaves the session running without it, said in an event", { skip: SKIP || !LINUX || false, timeout: 90_000 }, async t => {
  /** @type {any[]} */ const events = [];
  const r = await rig(t, { onEvent: e => events.push(e) });
  const root = fs.mkdtempSync(path.join(SCRATCH, "vyre-root-")); t.after(() => rm(root));
  fs.mkdirSync(path.join(root, "harness", "mcp"), { recursive: true }); fs.writeFileSync(path.join(root, "harness", "mcp", "run.js"), "");
  /** @type {any[]} */ const asked = [];
  fs.mkdirSync(path.join(root, "harness", "hooks"), { recursive: true }); fs.writeFileSync(path.join(root, "harness", "hooks", "run.js"), "");
  const door = { call: async (/** @type {any} */ q) => { asked.push(q); return { status: 200, body: JSON.stringify({ data: "from the home" }) }; }, entry: path.join(root, "harness", "mcp", "run.js"), root, plugin: path.join(root, "harness") };
  const h = await r.launch(r.runner, "sd", { vyre: door, moreArgs: ["--verbose", PLUGIN_FLAG, HARNESS_MARK] });
  const lines = []; h.child.stdout.on("data", d => { for (const l of String(d).split("\n").filter(Boolean)) lines.push(JSON.parse(l)); });
  h.send("vyre records.list {\"a\":1}");
  const said = await waitFor(() => lines.find(e => e.type === "vyre"));
  assert.deepEqual([said.reply.status, JSON.parse(said.reply.body).data], [200, "from the home"]);
  assert.deepEqual([asked[0].method, asked[0].path, asked[0].body, asked[0].caller], ["POST", "/v1/tools/records.list", "{\"a\":1}", "mcp"]);
  h.send("argv");
  const argv = await waitFor(() => lines.find(e => e.type === "argv"));
  assert.equal(argv.socket, "/run/vyre.sock");
  assert.ok(argv.argv.includes("--mcp-config"));
  // the box's Harness is named by the mark; with the door up the lender's copy of it loads in its place, and the hooks have the door too
  const at = argv.argv.indexOf(PLUGIN_FLAG);
  assert.ok(at >= 0 && argv.argv[at + 1] === path.join(root, "harness") && !argv.argv.includes(HARNESS_MARK), JSON.stringify(argv.argv));
  h.send("env VYRE_THREAD");
  assert.equal((await waitFor(() => lines.find(e => e.type === "env"))).value, "sd", "Vyre's own session, as on the box");
  // a folder that holds a person's secret folder is never bound: no door, the session still runs
  const bad = fs.mkdtempSync(path.join(SCRATCH, "vyre-bad-")); t.after(() => rm(bad));
  fs.mkdirSync(path.join(bad, ".ssh")); fs.mkdirSync(path.join(bad, "harness", "mcp"), { recursive: true }); fs.writeFileSync(path.join(bad, "harness", "mcp", "run.js"), "");
  const h2 = await r.launch(r.runner, "se", { vyre: { ...door, entry: path.join(bad, "harness", "mcp", "run.js"), root: bad }, moreArgs: ["--verbose", PLUGIN_FLAG, HARNESS_MARK] });
  const lines2 = []; h2.child.stdout.on("data", d => { for (const l of String(d).split("\n").filter(Boolean)) lines2.push(JSON.parse(l)); });
  h2.send("argv");
  const argv2 = await waitFor(() => lines2.find(e => e.type === "argv"));
  assert.equal(argv2.socket, null, "no door");
  assert.ok(!argv2.argv.includes(PLUGIN_FLAG) && !argv2.argv.includes(HARNESS_MARK) && argv2.argv.includes("--verbose"), "and no plugin flag left without a value or a door: " + JSON.stringify(argv2.argv));
  assert.ok(events.some(e => e.type === "vyre-unavailable" && e.session === "se"), "and the person's side is told");
});

test("runner: thawing a reason nobody froze for sends no signal; a session stopped by the machine's teardown says so, not that the person stopped it", { skip: SKIP || !LINUX || false, timeout: 90_000 }, async t => {
  /** @type {any[]} */ const ended = [];
  const r = await rig(t, { onEvent: e => { if (e.type === "stopped") ended.push(e.why); } });
  const h = await r.launch(r.runner, "s1");
  r.runner.pause(); await waitFor(() => procState(h.pid) === "T");
  r.runner.thaw("offline");   // never frozen for that: the person's pause stands
  await sleep(200);
  assert.equal(procState(h.pid), "T");
  r.runner.resume();
  await r.runner.stopAll();
  assert.deepEqual(ended, ["teardown"]);
});
