import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import "./testing/require-sandbox.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createEgress } from "./egress.js";
import { plan, seatbeltProfile } from "./sandbox.js";
import { pidsUnder } from "./proctree.js";
import { rig, waitFor, findOnDisk, SKIP, sleep, procState, LINUX, PLUGIN_FLAG, HARNESS_MARK, SCRATCH, rm, upstream, get } from "./runner-test-lib.js";
import { fakeSpace } from "./testing/fake-space.js";
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
  await r.runner.whenSecured();
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
