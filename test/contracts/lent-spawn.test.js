// @ts-check
// Contract test for team/contracts/lent-spawn.md (v1): the home's lent spawn and `lent.pipe` against the fixtures a consumer builds with. The real home service, the kernel's wire and the lender's client and pump are driven; the
// lender's process is a small program. A real daemon answers a lent spawn with no computer ready as a spawn that never started.
import "../../scripts/mac-test-guard.mjs";
import "../../core/runner/testing/hosted-guard.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { start } from "../../core/daemon/index.js";
import { rig, BOB } from "../../core/runner/testing/lent-rig.js";
import { startPump } from "../../core/runner/pipe-pump.js";
import { PIPE, lenderArgs } from "../../core/runner/pipe-home.js";
import { tempHome, present, asOwner } from "../helpers.js";
import { lentSpawnFixtures as F, SESSION, b64, shapeDiff } from "./lent-spawn.fixtures.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const keepAlive = (/** @type {any} */ t) => { const k = setInterval(() => {}, 100); t.after(() => clearInterval(k)); };

test("lent-spawn v1: the numbers the contract promises are the code's, and the box's paths do not travel", () => {
  assert.deepEqual({ chunkBytes: PIPE.CHUNK, callBytes: PIPE.CALL_BYTES, callChunks: PIPE.CALL_CHUNKS, downHigh: PIPE.DOWN_HIGH, upHigh: PIPE.UP_HIGH, holdMs: PIPE.HOLD_MS, waitMs: PIPE.WAIT_MS, waitMaxMs: PIPE.WAIT_MAX_MS, startMs: PIPE.START_MS, killMs: PIPE.KILL_MS }, F.limits);
  assert.deepEqual(lenderArgs(F.args.given), F.args.sent);
  assert.deepEqual(lenderArgs(["--mcp-config", JSON.stringify(F.mcpConfig.given)]), ["--mcp-config", JSON.stringify(F.mcpConfig.sent)]);
});

test("lent-spawn v1: a chat spawned for a ready lender: the heartbeat says start, lent.start answers the SDK's flags, and lent.pipe carries the bytes in the shapes the fixtures give", { timeout: 60_000 }, async t => {
  keepAlive(t);
  const r = await rig(t);
  const c = r.as(BOB, "dev_laptop");
  await c.vault.lease();
  await r.home.status(r.bob, { device_key: "KEY_LAPTOP" });
  await c.beat({ sessions: [], well: true });
  const placed = r.home.placeNew({ session: SESSION, person: BOB });
  assert.equal(shapeDiff(placed, F.placeNew.mac), "", JSON.stringify(placed));
  assert.equal(shapeDiff(r.home.placeNew({ session: "s_none_here", person: "per_carol" }), F.placeNew.box), "");
  const waiting = c.wait({ wait_ms: 3000 });
  const proc = r.home.spawn({ session: SESSION, person: BOB, command: "/box/bin/node", args: F.args.given, title: "A chat", computer: "Office Mac" });
  const nudged = await waiting;
  assert.equal(shapeDiff(nudged, F.answerWait), "", JSON.stringify(nudged));
  assert.equal(shapeDiff(proc.lent, F.lentStarting), "", JSON.stringify(proc.lent));
  for (const key of F.processKeys) assert.ok(key in proc, `the process has ${key}`);
  assert.deepEqual([proc.pid, proc.killed, proc.exitCode, proc.signalCode], [0, false, null, null]);
  // the lender hears it, and the definition it gets is the SDK's flags under the lender's own program
  const hb = await c.beat({ sessions: [], well: true });
  assert.equal(shapeDiff(hb.directives[0], F.directive), "", JSON.stringify(hb));
  assert.deepEqual([hb.directives[0].do, hb.directives[0].pipe], ["start", true]);
  const def = await c.spec({ session: SESSION });
  assert.equal(def.title, "A chat");
  assert.equal(def.command, F.startDefinition.command); assert.deepEqual(def.env, F.startDefinition.env); assert.equal(def.pipe, true);
  assert.deepEqual(def.args, F.args.sent);
  // the wire: the lender's call and the home's answers
  proc.stdin.write("{\"type\":\"user\"}\n");
  const first = await c.pipe({ session: SESSION, up: F.call.up, ack: 0, wait_ms: 0 });
  assert.equal(shapeDiff(proc.lent, F.lentUp), "", JSON.stringify(proc.lent));
  assert.equal(shapeDiff(first, F.answer), "", JSON.stringify(first));
  assert.deepEqual([first.acked, first.down.length, first.down[0].seq], [1, 1, 1]);
  assert.equal(Buffer.from(first.down[0].b64, "base64").toString(), "{\"type\":\"user\"}\n");
  // a repeat of what it already sent is not written twice; what it acked is not sent again
  const again = await c.pipe({ session: SESSION, up: F.call.up, ack: 1, wait_ms: 0 });
  assert.deepEqual([again.acked, again.down], [1, []]);
  assert.equal(await new Promise(res => { let n = 0; proc.stdout.on("data", (/** @type {any} */ d) => { n += d.length; }); setTimeout(() => res(n), 100); }), Buffer.from("{\"type\":\"system\"}\n").length, "the SDK read the line once");
  // stdin closed, then a kill: each told once, and the process end closes the pipe
  proc.stdin.end();
  assert.equal(shapeDiff(await c.pipe({ session: SESSION, ack: 1, wait_ms: 0 }), F.answerEnd), "");
  proc.kill();
  assert.equal(shapeDiff(await c.pipe({ session: SESSION, ack: 1, wait_ms: 0 }), F.answerKill), "");
  const closed = new Promise(res => proc.on("close", (/** @type {any} */ code, /** @type {any} */ sig) => res([code, sig])));
  const last = await c.pipe({ session: SESSION, ack: 1, exit: { code: null, signal: "SIGTERM" }, wait_ms: 0 });
  assert.equal(shapeDiff(last, F.answerClosed), "", JSON.stringify(last));
  assert.deepEqual(await closed, [null, "SIGTERM"]);
});

test("lent-spawn v1.2: lent.http carries a tool call and the tool list of the session, and nothing else of vyred", { timeout: 60_000 }, async t => {
  keepAlive(t);
  /** @type {any[]} */ const seen = [];
  const r = await rig(t, { http: async (/** @type {string} */ thread, /** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ headers, /** @type {string} */ body) => { seen.push([thread, method, p, headers["x-vyre-caller"], body]); return F.httpAnswer; } });
  const c = r.as(BOB, "dev_laptop");
  await c.vault.lease(); await c.spec({ session: SESSION });
  const call = F.httpCall;
  const a = await c.http({ session: SESSION, method: call.method, path: call.path, body: call.body, caller: call.caller });
  assert.equal(shapeDiff(a, F.httpAnswer), "", JSON.stringify(a));
  assert.deepEqual(seen[0], [SESSION, "POST", call.path, "mcp", call.body]);
  await c.http({ session: SESSION, method: "GET", path: F.httpList.path });
  assert.deepEqual(seen[1].slice(0, 3), [SESSION, "GET", "/v1/tools"]);
  for (const bad of ["/v1/tools/x/y", "/v1/health", "/v1/presence/x", "/events"]) await assert.rejects(c.http({ session: SESSION, method: "POST", path: bad, body: "{}" }), (/** @type {any} */ e) => e.code === "bad_input", bad);
});

test("lent-spawn v1.3: Vyre's tools are routed by the thread the chat's socket is open under, so a row older than the rule (session is not the thread) still gets the catalogue", { timeout: 60_000 }, async t => {
  keepAlive(t);
  /** @type {any[]} */ const seen = [];
  const r = await rig(t, { http: async (/** @type {string} */ thread, /** @type {string} */ method, /** @type {string} */ p) => { seen.push([thread, method, p]); return F.httpAnswer; } });
  const c = r.as(BOB, "dev_laptop");
  await c.vault.lease(); await r.home.status(r.bob, { device_key: "KEY_LAPTOP" }); await c.beat({ sessions: [], well: true });
  // an older chat: its row's session id is its own, the thread the switchboard opens its socket under is another
  const OLD = "s_older_row", THREAD = "t_the_socket_thread";
  r.home.placeNew({ session: OLD, person: BOB });
  r.home.spawn({ session: OLD, thread: THREAD, person: BOB, command: "/box/bin/node", args: F.args.given });
  await c.beat({ sessions: [], well: true });
  await c.spec({ session: OLD });
  await c.http({ session: OLD, method: "GET", path: "/v1/tools" });
  await c.http({ session: OLD, method: "POST", path: "/v1/tools/vyre.hello", body: "{}" });
  assert.deepEqual(seen.map(x => x.join(" ")), [`${THREAD} GET /v1/tools`, `${THREAD} POST /v1/tools/vyre.hello`], "routed by the thread; the session stays the book key");
  // the book and the checkpoints still use the session id
  assert.ok(r.home.placements().some((/** @type {any} */ x) => x.session === OLD), "the row is still keyed by the session");
});

test("lent-spawn v1.3: a tool call that outlasts one wire call is kept at the home under a ticket, the lender asks again, and the chat sees one long call", { timeout: 60_000 }, async t => {
  keepAlive(t);
  let release = () => {};
  const gate = new Promise(res => { release = () => res(undefined); });
  const r = await rig(t, { httpFirstMs: 40, http: async (/** @type {string} */ _t, /** @type {string} */ _m, /** @type {string} */ p) => { if (p.endsWith("/slow")) await gate; if (p.endsWith("/sleep")) await new Promise(res => setTimeout(res, 200)); return F.httpAnswer; } });
  const c = r.as(BOB, "dev_laptop");
  await c.vault.lease(); await c.spec({ session: SESSION });
  // on the wire: the first call answers pending after the first wait, and the ticket is only good for its own session
  const raw = await r.home.http(r.bob, { session: SESSION, epoch: 1, method: "POST", path: "/v1/tools/slow", body: "{}" });
  assert.equal(typeof raw.pending, "string", JSON.stringify(raw));
  const again = await r.home.http(r.bob, { session: SESSION, epoch: 1, ticket: raw.pending });
  assert.equal(again.pending, raw.pending, "still running: the same ticket");
  await assert.rejects(r.home.http(r.bob, { session: SESSION, epoch: 1, ticket: "call_nope" }), (/** @type {any} */ e) => e.code === "not_found");
  release();
  const done = await r.home.http(r.bob, { session: SESSION, epoch: 1, ticket: raw.pending });
  assert.deepEqual([done.status, done.body], [F.httpAnswer.status, F.httpAnswer.body]);
  await assert.rejects(r.home.http(r.bob, { session: SESSION, epoch: 1, ticket: raw.pending }), (/** @type {any} */ e) => e.code === "not_found", "an answer is handed over once");
  // through the lender's client the chat never sees the ticket: one call, the answer
  const a = await c.http({ session: SESSION, method: "POST", path: "/v1/tools/sleep", body: "{}" });   // 200 ms against a 40 ms first wait: asked for again at least twice
  assert.deepEqual([a.status, a.body], [F.httpAnswer.status, F.httpAnswer.body]);
});

test("lent-spawn v1: a session lent with no pipe open answers idle; a limit broken is bad_input; an old epoch is conflict", { timeout: 60_000 }, async t => {
  keepAlive(t);
  const r = await rig(t);
  const c = r.as(BOB, "dev_laptop");
  await c.vault.lease();
  await c.spec({ session: "s_nopipe" });
  const idle = await c.pipe({ session: "s_nopipe", ack: 0, wait_ms: 100 });
  assert.equal(shapeDiff(idle, F.answerIdle), "", JSON.stringify(idle));
  await r.home.status(r.bob, { device_key: "KEY_LAPTOP" }); await c.beat({ sessions: [], well: true });
  r.home.spawn({ session: SESSION, person: BOB });
  await c.beat({ sessions: [], well: true });
  await c.spec({ session: SESSION });
  const big = Buffer.alloc(PIPE.CHUNK + 1).toString("base64");
  await assert.rejects(c.pipe({ session: SESSION, up: [{ seq: 1, stream: "out", b64: big }], ack: 0, wait_ms: 0 }), (/** @type {any} */ e) => e.code === "bad_input");
  await assert.rejects(c.pipe({ session: SESSION, up: [{ seq: 1, stream: "tty", b64: b64("x") }], ack: 0, wait_ms: 0 }), (/** @type {any} */ e) => e.code === "bad_input");
  // the server takes the session: the lender's next call is fenced
  await r.home.takeOver(SESSION, "lid-closed", { auto: true });
  await assert.rejects(c.pipe({ session: SESSION, ack: 0, wait_ms: 0 }), (/** @type {any} */ e) => e.code === "conflict" || e.code === "not_found");
});

test("lent-spawn v1: a spawn nobody can take never started, and a move under a running chat ends it as a move", { timeout: 60_000 }, async t => {
  keepAlive(t);
  const r = await rig(t);
  const none = r.home.spawn({ session: "s_none", person: BOB });
  const err = await new Promise(res => none.on("error", res));
  assert.equal(/** @type {any} */ (err).code, F.neverStarted.errorCode);
  await new Promise(res => none.on("close", res));
  assert.deepEqual([none.exitCode, none.signalCode], [F.neverStarted.exitCode, F.neverStarted.signalCode]);
  // a running one that the server takes
  const c = r.as(BOB, "dev_laptop");
  await c.vault.lease(); await r.home.status(r.bob, { device_key: "KEY_LAPTOP" }); await c.beat({ sessions: [], well: true });
  const proc = r.home.spawn({ session: SESSION, person: BOB });
  await c.beat({ sessions: [], well: true }); await c.spec({ session: SESSION });
  await c.pipe({ session: SESSION, ack: 0, wait_ms: 0 });
  const closed = new Promise(res => proc.on("close", (/** @type {any} */ code, /** @type {any} */ sig) => res([code, sig])));
  await r.home.takeOver(SESSION, F.moved.moved.reason, { auto: true });
  assert.deepEqual(await closed, [null, F.moved.signal]);
  assert.equal(shapeDiff(proc.moved, F.moved.moved), "", JSON.stringify(proc.moved));
  assert.deepEqual(proc.moved, F.moved.moved);
});

test("lent-spawn v1: on a real daemon the lent home hands out a spawn, and with no computer of the person's ready it fails as a spawn that never started", { timeout: 120_000 }, async t => {
  keepAlive(t);
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", modules: { disable: ["agents", "computers"] } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const team = await d.kernel.spaces.host({ owner, name: "team" });
  const host = /** @type {any} */ (d.registry.deps).lentHome(team.space);
  assert.ok(host && typeof host.spawn === "function", "the Space's home can spawn on a lender");
  const proc = host.spawn({ session: SESSION, person: owner, args: F.args.given });
  const err = await new Promise(res => proc.on("error", res));
  assert.equal(/** @type {any} */ (err).code, "lent_unavailable");
  assert.equal(host.pipes.has(SESSION), false);
});

test("lent-spawn v1.1: on a real daemon the host names the Spaces this computer is set to lend to, and a new chat with no ready computer is placed on the box", { timeout: 120_000 }, async t => {
  keepAlive(t);
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "mac", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const sessionFor = async () => ({ call: async () => ({ v: 1, ok: true, result: {} }) });
  const d = await start({ root, kernel: true, sessionFor, deviceIdentity: async () => ({ deviceId: "eid_this_mac", deviceKey: "eid_this_mac" }), log: () => {} });
  t.after(() => d.stop());
  const db = d.registry.deps.db;
  const put = (/** @type {string} */ k, /** @type {any} */ v) => db.prepare("INSERT INTO spaces_kv (key, value) VALUES (?, ?)").run(k, JSON.stringify(v));
  put("server-hosted/spc_lendedspace1", { device: "srv_home0000000001" }); put("lend/spc_lendedspace1/eid_this_mac", { lent: true, device: "eid_this_mac" });
  put("server-hosted/spc_stoppedlend1", { device: "srv_home0000000001" }); put("lend/spc_stoppedlend1/eid_this_mac", { lent: false });
  put("server-hosted/spc_otherscomputer", { device: "srv_home0000000001" }); put("lend/spc_otherscomputer/eid_another", { lent: true });
  const host = /** @type {any} */ (d.kernel).kernelFor({ name: "runner", needs: { kernel: { actions: [] } } }).runnerHost();
  assert.deepEqual(await host.lentTo(), ["spc_lendedspace1"], "only a Space reached over a wire, lent from this computer, and still on");
  // with no computer ready the spawn fails as one that never started (the switchboard says thread.placing "fallback" for it: core/sessions/lent-spawn.test.js)
  const team = await d.kernel.spaces.host({ owner: d.kernel.id.owner, name: "team" });
  /** @type {any} */ (d.registry.deps).lentHome(team.space);
  const proc = host.lentSpawn(team.space, { session: "s_heard", chat: "chat_00000000-0000-4000-8000-0000000000c1", person: d.kernel.id.owner });
  const failed = await new Promise(res => proc.on("error", res));
  assert.equal(/** @type {any} */ (failed).code, "lent_unavailable");
  assert.deepEqual(await host.placeNew(d.kernel.id.space, { session: "s_x1", person: d.kernel.id.owner }), { where: "box" });
});

// the pump's reading of the child is covered by core/runner/lent-pipe.test.js; this keeps the import honest
void [spawn, startPump];
