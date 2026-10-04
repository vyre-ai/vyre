// @ts-check
// STEP 7 of the E2E run (team/0.3/E2E-RUN.md), on a REAL vyred PROCESS: a chat with alex, carol and the assistant the kernel lists; alex asks and the reply streams through appendOpen
// frame by frame over a real WebSocket (a stream.open ticket); carol joins mid-reply and gets none of it and the next one in full; the vyred is killed (SIGKILL, a real process death,
// not a registry rebuild) mid-turn and started again on the same home, and the pending turn reopens, and a second kill with the person no longer reopenable ends in "couldn't resume".
// Skipped unless VYRE_E2E=1 so the suite stays fast. Run on the test box only (the daemon host guard refuses the Mac):
//   VYRE_E2E=1 VYRE_TEST_HOST=testbox nice -n 15 node --test --test-timeout=300000 "core/stream/e2e-step7.test.js"
// What is real: the vyred process (core/daemon start: kernel, durable kernel_turns table, the real Switchboard, sessions, stream), the fake claude as the provider (a child process of that
// vyred), the kernel's chats and appendOpen, the WebSockets, the process kill and restart. Not real: no provider is called (the fake claude echoes), the presence of a person is a test
// verifier (`kernelPresence`), and the daemon's own unix socket is not used: a harness in e2e-step7-vyred.js fronts it on 127.0.0.1. The scripted adapter of scripts/eval/assistant-fit is
// a MODEL adapter for the work assistant (core/work); a chat turn goes through the Switchboard and a provider, so the fake claude stands in for the provider and no adapter is involved.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { FAKE } from "../sessions/testing/boot.js";
import { connect, wsDuplex } from "./client.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const until = async (/** @type {() => any} */ f, /** @type {string} */ what, ms = 30_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return; await sleep(20); } throw new Error(`timed out waiting for ${what}`); };
const textOf = (/** @type {any[]} */ frames) => frames.filter(f => f.type === "session.text-delta" && !f.data.reasoning).map(f => f.data.text).join("");
const LONG = (/** @type {string} */ tag) => `${tag} ` + Array(400).fill("word").join(" "); // the fake claude says it back in short deltas a few milliseconds apart

test("step 7 on a real vyred: a chat streams frame by frame, carol joins mid-reply and gets none of it, a kill -9 mid-turn reopens or says it could not resume", { skip: process.env.VYRE_E2E !== "1" && "set VYRE_E2E=1 (test box only)", timeout: 280_000 }, async t => {
  const home = tempHome(t);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-step7-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const env = { ...process.env, VYRE_HOME: home, VYRE_KERNEL: "1", VYRE_SEAL_DEV: "1", VYRE_KERNEL_PATH_RULE: "1", VYRE_SESSION_SANDBOX_OFF: "1", VYRE_TEST_HOST: "testbox",
    VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", VYRE_SESSIONS_SPAWNER: "off", VYRE_SESSIONS_THREAD_SOCKET: "on", VYRE_NO_DIALOGS: "1" };
  delete env.NODE_TEST_CONTEXT;
  /** @type {import("node:child_process").ChildProcess[]} */ const procs = [];
  const logFile = () => { try { return fs.readdirSync(path.join(home, "logs")).filter(f => f.startsWith("e2e-")).map(f => fs.readFileSync(path.join(home, "logs", f), "utf8")).join("\n"); } catch { return ""; } };
  let boots = 0;
  /** Start the real vyred process (own process group, output to a log in the home) and wait for its harness. */
  async function boot() {
    fs.rmSync(path.join(home, "e2e-harness.json"), { force: true });
    fs.mkdirSync(path.join(home, "logs"), { recursive: true });
    const fd = fs.openSync(path.join(home, "logs", `e2e-${++boots}.log`), "a");
    const child = spawn(process.execPath, [path.join(HERE, "e2e-step7-vyred.js")], { detached: true, stdio: ["ignore", fd, fd], env });
    procs.push(child);
    await until(() => fs.existsSync(path.join(home, "e2e-harness.json")) || child.exitCode !== null, "vyred's harness", 60_000);
    assert.equal(child.exitCode, null, `vyred exited: ${logFile()}`);
    const h = JSON.parse(fs.readFileSync(path.join(home, "e2e-harness.json"), "utf8"));
    const base = `http://127.0.0.1:${h.port}`;
    const post = async (/** @type {string} */ p, /** @type {any} */ b) => (await fetch(base + p, { method: "POST", body: JSON.stringify(b || {}) })).json();
    const info = await (await fetch(base + "/info")).json();
    const call = (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input) => post("/call", { who, tool, input });
    const watch = (/** @type {string} */ who, /** @type {number} */ from = 0) => {
      /** @type {{ at: number, f: any }[]} */ const seen = [];
      const c = connect({ from, open: async ({ from: fr }) => { const r = await call(who, "stream.open", { session: info.chat, from: fr }); assert.ok(!r.error, r.error && r.error.message); return wsDuplex(`ws://127.0.0.1:${h.port}${r.data.path}`); }, onFrame: f => seen.push({ at: Date.now(), f }), backoff: { base: 20, cap: 100 } });
      t.after(() => c.close());
      return { seen, frames: { get all() { return seen.map(s => s.f); } }, close: () => c.close() };
    };
    return { child, pid: /** @type {number} */ (child.pid), info, post, call, watch, add: () => post("/add-carol") };
  }
  const killGroup = (/** @type {import("node:child_process").ChildProcess} */ c, sig = "SIGKILL") => { try { process.kill(-/** @type {number} */ (c.pid), sig); } catch { /* gone */ } };
  t.after(() => { for (const c of procs) killGroup(c); }); // only the processes this test started
  t.after(() => { if (process.env.E2E_SHOW_LOG) console.error(logFile()); });

  // ---- 1. the chat: alex and the assistant the kernel lists; alex asks, the reply streams frame by frame over a real WebSocket
  let v = await boot();
  const { chat } = v.info;
  const alex = v.watch("alex");
  const sent = await v.call("alex", "stream.send", { session: chat, text: "@assistant " + LONG("SECRET1"), to: ["assistant:assistant"], cwd: work });
  assert.ok(!sent.error, JSON.stringify(sent.error));
  await until(() => textOf(alex.frames.all).includes("SECRET1"), "the first delta");
  assert.ok(!alex.frames.all.some(f => f.type === "session.text-done"), "the reply is still arriving when its first word is on alex's screen");

  // ---- 2. carol joins mid-reply: she is added to the chat while the reply is still being written, then opens the stream
  assert.ok((await v.add()).ok);
  const carol = v.watch("carol");
  await until(() => carol.frames.all.some(f => f.type === "session.participant-joined" || f.type === "session.status") || carol.seen.length > 0, "carol's stream to open");
  await until(() => alex.frames.all.some(f => f.type === "session.text-done"), "the first reply to finish");
  const deltas = alex.seen.filter(s => s.f.type === "session.text-delta" && !s.f.data.reasoning);
  assert.ok(deltas.length >= 5, `the reply came as many frames (got ${deltas.length})`);
  assert.ok(deltas.at(-1).at - deltas[0].at >= 100, "the frames arrived over time, not in one lump");
  const curs = alex.seen.map(s => s.f.cur).filter(c => c > 0);
  assert.deepEqual(curs, [...curs].sort((a, b) => a - b), "cursors only go up");
  assert.equal(new Set(curs).size, curs.length, "no cursor twice");
  assert.equal(textOf(alex.frames.all), "echo: " + "@assistant " + LONG("SECRET1"), "alex got every word of the reply");
  await sleep(300);
  assert.ok(!JSON.stringify(carol.frames.all).includes("SECRET1"), "carol, who joined mid-reply, got none of it");
  assert.ok(!carol.frames.all.some(f => f.type === "session.text-done"), "nor its end");
  // the next reply reaches her in full
  const second = await v.call("alex", "stream.send", { session: chat, text: "@assistant " + LONG("SECOND"), to: ["assistant:assistant"], cwd: work });
  assert.ok(!second.error, JSON.stringify(second.error));
  await until(() => carol.frames.all.filter(f => f.type === "session.text-done").length >= 1, "carol's copy of the next reply", 40_000);
  assert.equal(textOf(carol.frames.all), "echo: " + "@assistant " + LONG("SECOND"), "carol got the next reply in full");

  // ---- 3. kill -9 mid-turn, start again on the same home: the pending turn reopens
  await until(() => alex.frames.all.filter(f => f.type === "session.text-done").length >= 2, "the second reply to finish", 40_000);
  const third = await v.call("alex", "stream.send", { session: chat, text: "@assistant " + LONG("KILLME"), to: ["assistant:assistant"], cwd: work });
  assert.ok(!third.error, JSON.stringify(third.error));
  await until(() => textOf(alex.frames.all).includes("KILLME"), "the third reply to start");
  const pidBefore = v.pid;
  killGroup(v.child); // a real process death, mid-turn: SIGKILL to vyred and its fake claude
  await until(() => { try { process.kill(pidBefore, 0); return false; } catch { return true; } }, "vyred to be gone", 10_000);
  alex.close(); carol.close();
  const turnsOf = () => { const db = new DatabaseSync(path.join(home, "vyre.db"), { readOnly: true }); try { return /** @type {any[]} */ (db.prepare("SELECT thread, body FROM kernel_turns").all()); } finally { db.close(); } };
  const kept = turnsOf();
  assert.equal(kept.length, 1, "the open turn survived the kill in the home's own database");
  assert.ok(!/token/i.test(kept[0].body), "and holds no token");
  assert.equal(JSON.parse(kept[0].body).person, v.info.alex, "it is alex's turn, in the chat");
  v = await boot();
  assert.notEqual(v.pid, pidBefore, "a new process");
  const after = v.watch("alex");
  await sleep(1500);
  const afterSend = await v.call("alex", "stream.send", { session: chat, text: "@assistant AFTERKILL", to: ["assistant:assistant"], cwd: work });
  assert.ok(!afterSend.error, JSON.stringify(afterSend.error));
  await until(() => textOf(after.frames.all).includes("echo: @assistant AFTERKILL"), "the reply after the restart", 40_000);
  assert.ok(!after.frames.all.some(f => f.type === "session.status" && f.data.state === "failed" && /resume/.test(String(f.data.note))), "the turn reopened: nothing says it could not resume");
  assert.match(logFile(), /module threads/, "the second process ran the Switchboard");
  assert.ok(!/could not resume/.test(fs.readFileSync(path.join(home, "logs", "e2e-2.log"), "utf8")), "the second process gave nothing up");

  // ---- 4. a second kill, and the person can no longer be reopened (the kept turn names someone who is no longer a member): the room is told, and the turn is forgotten
  await until(() => after.frames.all.filter(f => f.type === "session.text-done").length >= 1, "the reply to finish", 40_000);
  const fourth = await v.call("alex", "stream.send", { session: chat, text: "@assistant " + LONG("GONE"), to: ["assistant:assistant"], cwd: work });
  assert.ok(!fourth.error, JSON.stringify(fourth.error));
  await until(() => textOf(after.frames.all).includes("GONE"), "the fourth reply to start");
  const pid2 = v.pid;
  killGroup(v.child);
  await until(() => { try { process.kill(pid2, 0); return false; } catch { return true; } }, "vyred to be gone", 10_000);
  after.close();
  { const db = new DatabaseSync(path.join(home, "vyre.db")); try { for (const r of /** @type {any[]} */ (db.prepare("SELECT thread, body FROM kernel_turns").all())) db.prepare("UPDATE kernel_turns SET body = ? WHERE thread = ?").run(JSON.stringify({ ...JSON.parse(r.body), person: "per_nobody_left_in_the_space" }), r.thread); } finally { db.close(); } }
  v = await boot();
  const late = v.watch("alex");
  await until(() => late.frames.all.some(f => f.type === "session.status" && f.data.state === "failed" && /couldn't resume, ask again/.test(String(f.data.note))), "the give-up note", 60_000);
  assert.equal(turnsOf().length, 0, "the given-up turn is forgotten");
  killGroup(v.child, "SIGTERM");
});
