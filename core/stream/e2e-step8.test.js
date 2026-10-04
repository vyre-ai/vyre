// @ts-check
// Step 8 (team/0.3/E2E-RUN.md) on a REAL vyred process with two real members (alex the owner, carol a member; presence is the test verifier `kernelPresence`, which accepts any proof for a grants act: a stand-in, said
// plainly in team/0.3/E2E-RUN.md): a turn belongs to its asker for its whole run. carol's turn is running when alex speaks: alex's message is queued as the NEXT turn, never steers carol's,
// the kernel still holds carol's open turn while hers runs (it is not swapped for alex's), and alex's turn then runs as alex. Skipped unless VYRE_E2E=1 (see e2e-step7.test.js for how to run).
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

test("step 8: the assistant reads a record with a sealed ssn inside a chat turn and its transcript holds the placeholder, never the value or the reference", { skip: (process.env.VYRE_E2E !== "1" && "set VYRE_E2E=1 on the test box") || false, timeout: 150_000 }, async t => {
  const home = tempHome(t);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-step8-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const env = { ...process.env, VYRE_HOME: home, VYRE_KERNEL: "1", VYRE_SEAL_DEV: "1", VYRE_KERNEL_PATH_RULE: "1", VYRE_SESSION_SANDBOX_OFF: "1", VYRE_TEST_HOST: "testbox",
    VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", VYRE_SESSIONS_SPAWNER: "off", VYRE_SESSIONS_THREAD_SOCKET: "on", VYRE_NO_DIALOGS: "1" };
  delete env.NODE_TEST_CONTEXT;
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  const fd = fs.openSync(path.join(home, "logs", "e2e-8.log"), "a");
  const child = spawn(process.execPath, [path.join(HERE, "e2e-step7-vyred.js")], { detached: true, stdio: ["ignore", fd, fd], env });
  t.after(() => { try { process.kill(-/** @type {number} */ (child.pid), "SIGKILL"); } catch { /* gone */ } });
  await until(() => fs.existsSync(path.join(home, "e2e-harness.json")) || child.exitCode !== null, "vyred's harness", 60_000);
  const h = JSON.parse(fs.readFileSync(path.join(home, "e2e-harness.json"), "utf8"));
  const base = `http://127.0.0.1:${h.port}`;
  const post = async (/** @type {string} */ p, /** @type {any} */ b) => (await fetch(base + p, { method: "POST", body: JSON.stringify(b || {}) })).json();
  const info = await (await fetch(base + "/info")).json();
  assert.ok(info.record, `the harness seeded a record with a sealed ssn (${info.recordError})`);
  const call = (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input) => post("/call", { who, tool, input });
  /** @type {any[]} */ const frames = [];
  const c = connect({ from: 0, open: async ({ from }) => { const r = await call("alex", "stream.open", { session: info.chat, from }); assert.ok(!r.error, r.error && r.error.message); return wsDuplex(`ws://127.0.0.1:${h.port2 || h.port}${r.data.path}`); }, onFrame: (/** @type {any} */ f) => frames.push(f) });
  t.after(() => c.close());
  // the person asks; the fake provider is the assistant: its prompt carries a `vyre-sock work.call {tool: contacts.find}` line, which it runs on its OWN thread socket (VYRE_SOCKET), where vyred adds the thread's kernel session: the assistant's own door to the Space's records, as the plugin's MCP server uses it, which it runs the way the MCP server does inside its own thread (the agent's caller)
  const ask = `vyre-sock work.call ${JSON.stringify({ tool: "contacts.find", input: {} })}`;
  const sent = await call("alex", "stream.send", { session: info.chat, text: ask, to: ["assistant:assistant"], cwd: work });
  assert.ok(!sent.error, JSON.stringify(sent.error));
  await until(() => frames.some(f => f.type === "session.text-done"), "the assistant's reply", 90_000);
  const reply = textOf(frames);
  console.log("STEP8 reply the model produced from the tool result:\n" + reply.slice(0, 1500));
  // the transcript the model received: every recorded event of its thread, as the thread stored them
  const list = await call("alex", "threads.list", { all: true });
  const threads = (list.data && (list.data.threads || list.data)) || [];
  const events = [];
  for (const th of Array.isArray(threads) ? threads : []) { const g = await call("alex", "threads.get", { thread: th.id || th.thread, limit: 500 }); if (g.data && Array.isArray(g.data.events)) events.push(...g.data.events); }
  const transcript = JSON.stringify(events);
  for (const e of events) console.log("STEP8 event " + e.type + " " + JSON.stringify(e.payload || {}).slice(0, 260));
  console.log("STEP8 transcript events: " + events.length + ", bytes " + transcript.length);
  console.log("STEP8 tool result in the transcript: " + (transcript.match(/\{[^{}]*sealed[^{}]*\}/) || ["(none found)"])[0].slice(0, 400));
  assert.ok(/sealed|placeholder|us-ssn|SSN/i.test(reply + transcript), "the model's view names the field as sealed");
  assert.ok(!(reply + transcript).includes("123-45-6789"), "the value is nowhere in what the model received or said");
  assert.ok(!/seal[:_][A-Za-z0-9-]{4,}/.test(reply + transcript), "no sealed reference reached the model either");
});
