// @ts-check
import "../scripts/mac-test-guard.mjs";
// A session never sits in "starting" for ever, on a real daemon: no AI account on a server whose sessions run in the sandbox is refused at once with a plain reason; an agent that never speaks fails
// its own thread within the limit and its process is stopped; an agent that exits at once fails its thread; and the daemon keeps answering.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present, asOwner } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";
import { sessionsRoot } from "../lib/session-temp.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };

async function rig(/** @type {any} */ t, /** @type {{ bin?: string, sandboxOff: boolean, sessions?: any }} */ o) {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, VYRE_SESSION_SANDBOX_OFF: process.env.VYRE_SESSION_SANDBOX_OFF };
  if (o.bin) process.env.VYRE_CLAUDE_BIN = o.bin; else delete process.env.VYRE_CLAUDE_BIN;
  process.env.VYRE_SESSIONS_DRIVER = "cli";
  if (o.sandboxOff) process.env.VYRE_SESSION_SANDBOX_OFF = "1"; else delete process.env.VYRE_SESSION_SANDBOX_OFF;
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [], sessions: { install: false, thread_socket: "on", start_timeout_s: 2, ...(o.sessions || {}) } }));
  if (o.pre) o.pre(root);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root); // calls from cli/deck arrive as the owner's device, as on the real socket (chat gate)
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  return { d, work, root };
}
const script = (/** @type {any} */ t, /** @type {string} */ body) => { const f = path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-bin-")), "claude"); fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); t.after(() => fs.rmSync(path.dirname(f), { recursive: true, force: true })); return f; };
const status = async (/** @type {any} */ d, /** @type {string} */ id) => (await d.registry.call("threads.get", { thread: id, limit: 50 }, "cli")).data.thread;

test("no AI account on a server with the sandbox on: threads.start refuses at once with a plain reason and leaves no thread", { timeout: 60_000 }, async t => {
  const { d, work } = await rig(t, { sandboxOff: false });
  const t0 = Date.now();
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hi", surface: "deck" }, "cli");
  assert.equal(r.error && r.error.code, "no_account", JSON.stringify(r));
  assert.match(String(r.error.message), /Connect an AI account/);
  assert.ok(Date.now() - t0 < 8000, "answered at once");
  assert.equal((await d.registry.call("threads.list", {}, "cli")).data.length, 0, "no thread was left in starting");
  assert.ok(!(await d.registry.call("system.echo", { text: "x" }, "cli")).error, "the daemon still answers");
});

test("an agent that never speaks fails its own thread within the limit and its process is stopped", { timeout: 60_000 }, async t => {
  const bin = script(t, "exec sleep 300");
  const { d, work } = await rig(t, { bin, sandboxOff: true });
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hi", surface: "deck" }, "cli");
  assert.ok(r.data && r.data.id, JSON.stringify(r));
  const th = await until(async () => { const x = await status(d, r.data.id); return x.status === "stopped" ? x : null; }, "the thread to fail");
  assert.equal(th.canonical_status, "failed", JSON.stringify(th));
  assert.match(String(th.stopped_reason || ""), /said nothing/);
  assert.ok(!(await d.registry.call("system.echo", { text: "x" }, "cli")).error, "the daemon still answers");
});

test("an agent that exits at once fails its thread, with what it said", { timeout: 60_000 }, async t => {
  const bin = script(t, "echo 'Not logged in' >&2\nexit 3");
  const { d, work } = await rig(t, { bin, sandboxOff: true });
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hi", surface: "deck" }, "cli");
  assert.ok(r.data && r.data.id, JSON.stringify(r));
  const th = await until(async () => { const x = await status(d, r.data.id); return x.status === "stopped" ? x : null; }, "the thread to fail");
  assert.equal(th.canonical_status, "failed", JSON.stringify(th));
  assert.ok(!(await d.registry.call("system.echo", { text: "x" }, "cli")).error, "the daemon still answers");
});

test("a start that blocks before the agent is spawned fails the thread at its step, answers the caller, and leaves the daemon answering", { timeout: 60_000 }, async t => {
  // a session socket that never comes up stands in for any await in the start path that never settles
  const bin = script(t, "exec sleep 300");
  const { d, work } = await rig(t, { bin, sandboxOff: true });
  const tool = d.registry.tools.get("sessions.models.resolve");
  assert.ok(tool, "the models tool the start path calls");
  tool.run = () => new Promise(() => {}); // a module the start path waits on never answers
  const t0 = Date.now();
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hi", surface: "deck" }, "cli");
  assert.equal(r.error && r.error.code, "start_timeout", JSON.stringify(r));
  assert.match(String(r.error.message), /stuck at "/);
  assert.ok(Date.now() - t0 < 15_000, "answered within a bounded time");
  // stuck before its row exists (this injection): no thread is left; stuck after (any later step): the thread is stopped with the step, never left in starting
  const rows = (await d.registry.call("threads.list", {}, "cli")).data;
  for (const row of rows) {
    assert.equal(row.status, "stopped", "the thread is not left in starting");
    assert.match(String((await d.registry.call("threads.get", { thread: row.id, limit: 20 }, "cli")).data.thread.stopped_reason || ""), /stuck at/);
  }
  assert.ok(!(await d.registry.call("system.echo", { text: "x" }, "cli")).error, "the daemon still answers");
});

for (const surface of ["deck", undefined]) {
  test(`a start the limit gives up on during its first prompt sends nothing and never respawns the stopped thread (${surface ? "surface" : "module"} start)`, { timeout: 60_000 }, async t => {
    // the limit (2 s) fires while the start is slowed after the spawn (test seam VYRE_TEST_START_PAUSE_MS): the abandoned start must not send, which would resume the thread it stopped
    const runs = path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-runs-")), "runs");
    t.after(() => fs.rmSync(path.dirname(runs), { recursive: true, force: true }));
    const bin = script(t, `echo x >> '${runs}'\nexec sleep 300`);
    const saved = process.env.VYRE_TEST_START_PAUSE_MS;
    process.env.VYRE_TEST_START_PAUSE_MS = "3000";
    t.after(() => { if (saved === undefined) delete process.env.VYRE_TEST_START_PAUSE_MS; else process.env.VYRE_TEST_START_PAUSE_MS = saved; });
    const { d, work } = await rig(t, { bin, sandboxOff: true });
    const r = await d.registry.call("threads.start", { cwd: work, prompt: "hi", ...(surface ? { surface } : {}) }, "cli");
    assert.equal(r.error && r.error.code, "start_timeout", JSON.stringify(r));
    assert.match(String(r.error.message), /first prompt/);
    await new Promise(res => setTimeout(res, 5000)); // the abandoned start's pauses end here
    const rows = (await d.registry.call("threads.list", {}, "cli")).data;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "stopped", "the thread stays stopped");
    const n = fs.existsSync(runs) ? fs.readFileSync(runs, "utf8").trim().split("\n").length : 0;
    assert.equal(n, 1, "the agent was spawned once, never again by the abandoned start");
    assert.ok(!(await d.registry.call("system.echo", { text: "x" }, "cli")).error, "the daemon still answers");
  });
}

test("a start that throws after its thread exists (any step, not only the limit) ends the thread stopped with the reason, and the caller gets the error", { timeout: 60_000 }, async t => {
  // max_live 1 with one session running and not idle: the second start is refused by room() AFTER its row was inserted
  const bin = script(t, "exec sleep 300");
  const { d, work } = await rig(t, { bin, sandboxOff: true, sessions: { max_live: 1, start_timeout_s: 30 } });
  const first = await d.registry.call("threads.start", { cwd: work, prompt: "one", surface: "deck" }, "cli");
  assert.ok(first.data && first.data.id, JSON.stringify(first));
  const second = await d.registry.call("threads.start", { cwd: work, prompt: "two", surface: "deck" }, "cli");
  assert.equal(second.error && second.error.code, "busy", JSON.stringify(second));
  const rows = (await d.registry.call("threads.list", {}, "cli")).data;
  const other = rows.filter((/** @type {any} */ r) => r.id !== first.data.id);
  assert.equal(other.length, 1, "the refused start left its thread row");
  const th = await status(d, other[0].id);
  assert.equal(th.status, "stopped", "never left in starting");
  assert.match(String(th.stopped_reason || ""), /exited without starting: .*sessions are already running/);
  assert.ok(!(await d.registry.call("system.echo", { text: "x" }, "cli")).error, "the daemon still answers");
});

test("the daemon's start empties the session temp folders a killed daemon left behind, and keeps the folder itself", { timeout: 60_000 }, async t => {
  const left = /** @type {string[]} */ ([]);
  const { root } = await rig(t, { sandboxOff: true, pre: r => {
    const tmp = path.join(sessionsRoot(r), "tmp");
    for (const n of ["dead1", "dead2"]) { fs.mkdirSync(path.join(tmp, n), { recursive: true }); fs.writeFileSync(path.join(tmp, n, "x"), "x"); left.push(path.join(tmp, n)); }
  } });
  for (const p of left) assert.ok(!fs.existsSync(p), `${p} is gone`);
  assert.ok(fs.existsSync(path.join(sessionsRoot(root), "tmp")), "the folder itself stays");
});
