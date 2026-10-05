// @ts-check
// A graceful stop on a REAL vyred process: SIGTERM (what a restart for an update sends) mid-turn keeps the open turn in the home's database, and the next start reopens it or says it could not.
// Skipped unless VYRE_E2E=1 on the test box (see e2e-step7.test.js). Borrows that test's harness process (e2e-step7-vyred.js).
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
const LONG = (/** @type {string} */ tag) => `${tag} ` + Array(400).fill("word").join(" ");

test("SIGTERM to a real vyred mid-turn keeps the open turn; the next start reopens it", { skip: (process.env.VYRE_E2E !== "1" && "set VYRE_E2E=1 on the test box") || (!fs.existsSync(path.join(HERE, "e2e-step7-vyred.js")) && "needs chat's step 7 harness (core/stream/e2e-step7-vyred.js)"), timeout: 240_000 }, async t => {
  const home = tempHome(t);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-sigterm-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const env = { ...process.env, VYRE_HOME: home, VYRE_KERNEL: "1", VYRE_SEAL_DEV: "1", VYRE_KERNEL_PATH_RULE: "1", VYRE_SESSION_SANDBOX_OFF: "1", VYRE_TEST_HOST: "testbox",
    VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", VYRE_SESSIONS_SPAWNER: "off", VYRE_SESSIONS_THREAD_SOCKET: "on", VYRE_NO_DIALOGS: "1" };
  delete env.NODE_TEST_CONTEXT;
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  /** @type {import("node:child_process").ChildProcess[]} */ const procs = [];
  t.after(() => { for (const c of procs) { try { process.kill(-/** @type {number} */ (c.pid), "SIGKILL"); } catch { /* gone */ } } });
  let boots = 0;
  async function boot() {
    fs.rmSync(path.join(home, "e2e-harness.json"), { force: true });
    const fd = fs.openSync(path.join(home, "logs", `e2e-${++boots}.log`), "a");
    const child = spawn(process.execPath, [path.join(HERE, "e2e-step7-vyred.js")], { detached: true, stdio: ["ignore", fd, fd], env });
    procs.push(child);
    await until(() => fs.existsSync(path.join(home, "e2e-harness.json")) || child.exitCode !== null, "vyred's harness", 60_000);
    assert.equal(child.exitCode, null, "vyred is up");
    const h = JSON.parse(fs.readFileSync(path.join(home, "e2e-harness.json"), "utf8"));
    const post = async (/** @type {string} */ p, /** @type {any} */ b) => (await fetch(`http://127.0.0.1:${h.port}${p}`, { method: "POST", body: JSON.stringify(b || {}) })).json();
    const info = await (await fetch(`http://127.0.0.1:${h.port}/info`)).json();
    const call = (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input) => post("/call", { who, tool, input });
    /** @type {any[]} */ const frames = [];
    const c = connect({ from: 0, open: async ({ from }) => { const r = await call("alex", "stream.open", { chat: info.chat, from }); assert.ok(!r.error, r.error && r.error.message); return wsDuplex(`ws://127.0.0.1:${h.port}${r.data.path}`); }, onFrame: (/** @type {any} */ f) => frames.push(f), backoff: () => 100 });
    t.after(() => c.close());
    return { child, pid: /** @type {number} */ (child.pid), info, call, frames, close: () => c.close() };
  }
  const turns = () => { const db = new DatabaseSync(path.join(home, "vyre.db"), { readOnly: true }); try { return /** @type {any[]} */ (db.prepare("SELECT thread, body FROM kernel_turns").all()).map(r => JSON.parse(r.body)); } finally { db.close(); } };
  let v = await boot();
  const sent = await v.call("alex", "stream.send", { chat: v.info.chat, text: "@assistant " + LONG("TERMME"), to: ["assistant:assistant"], cwd: work });
  assert.ok(!sent.error, JSON.stringify(sent.error));
  await until(() => textOf(v.frames).includes("TERMME"), "the reply to start");
  assert.equal(turns().length, 1, "a turn is open");
  const pid = v.pid;
  v.close();
  process.kill(-pid, "SIGTERM"); // graceful: what a restart for an update sends
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, "vyred to exit on SIGTERM", 30_000);
  const kept = turns();
  assert.equal(kept.length, 1, "the open turn survived a graceful stop");
  assert.equal(kept[0].person, v.info.alex);
  assert.ok(!/token/i.test(JSON.stringify(kept)), "and holds no token");
  v = await boot();
  await sleep(1500);
  const after = await v.call("alex", "stream.send", { chat: v.info.chat, text: "@assistant AFTERTERM", to: ["assistant:assistant"], cwd: work });
  assert.ok(!after.error, JSON.stringify(after.error));
  await until(() => textOf(v.frames).includes("echo: @assistant AFTERTERM"), "the reply after the restart", 40_000);
  assert.ok(!/could not resume/.test(fs.readFileSync(path.join(home, "logs", "e2e-2.log"), "utf8")), "the second process gave nothing up");
  process.kill(-v.pid, "SIGTERM");
});
