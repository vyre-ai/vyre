// @ts-check
// SS-1 on a REAL vyred process with two real members (alex the owner, carol a member; presence is the test verifier `kernelPresence`, which accepts any proof for a grants act: a stand-in, said
// plainly in team/0.3/E2E-RUN.md): a turn belongs to its asker for its whole run. carol's turn is running when alex speaks: alex's message is queued as the NEXT turn, never steers carol's,
// the kernel still holds carol's open turn while hers runs (it is not swapped for alex's), and alex's turn then runs as alex. Skipped unless VYRE_E2E=1 (see e2e-step7.test.js for how to run).
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

test("a turn keeps its asker on a real vyred with two members: another person's message mid-turn queues as the next turn and runs under its own asker", { skip: (process.env.VYRE_E2E !== "1" && "set VYRE_E2E=1 on the test box") || (!fs.existsSync(path.join(HERE, "e2e-step7-vyred.js")) && "needs chat's step 7 harness (core/stream/e2e-step7-vyred.js)"), timeout: 240_000 }, async t => {
  const home = tempHome(t);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-asker-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const env = { ...process.env, VYRE_HOME: home, VYRE_KERNEL: "1", VYRE_SEAL_DEV: "1", VYRE_KERNEL_PATH_RULE: "1", VYRE_SESSION_SANDBOX_OFF: "1", VYRE_TEST_HOST: "testbox",
    VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", VYRE_SESSIONS_SPAWNER: "off", VYRE_SESSIONS_THREAD_SOCKET: "on", VYRE_NO_DIALOGS: "1" };
  delete env.NODE_TEST_CONTEXT;
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  const fd = fs.openSync(path.join(home, "logs", "e2e-1.log"), "a");
  const child = spawn(process.execPath, [path.join(HERE, "e2e-step7-vyred.js")], { detached: true, stdio: ["ignore", fd, fd], env });
  t.after(() => { try { process.kill(-/** @type {number} */ (child.pid), "SIGKILL"); } catch { /* gone */ } });
  await until(() => fs.existsSync(path.join(home, "e2e-harness.json")) || child.exitCode !== null, "vyred's harness", 60_000);
  const h = JSON.parse(fs.readFileSync(path.join(home, "e2e-harness.json"), "utf8"));
  const base = `http://127.0.0.1:${h.port}`;
  const post = async (/** @type {string} */ p, /** @type {any} */ b) => (await fetch(base + p, { method: "POST", body: JSON.stringify(b || {}) })).json();
  const info = await (await fetch(base + "/info")).json();
  const call = (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input) => post("/call", { who, tool, input });
  const turns = () => { const db = new DatabaseSync(path.join(home, "vyre.db"), { readOnly: true }); try { return /** @type {any[]} */ (db.prepare("SELECT thread, body FROM kernel_turns").all()).map(r => JSON.parse(r.body)); } finally { db.close(); } };
  assert.ok((await post("/add-carol")).ok, "carol is a member and in the chat");
  /** @type {any[]} */ const frames = [];
  const c = connect({ from: 0, open: async ({ from }) => { const r = await call("alex", "stream.open", { session: info.chat, from }); assert.ok(!r.error, r.error && r.error.message); return wsDuplex(`ws://127.0.0.1:${h.port}${r.data.path}`); }, onFrame: (/** @type {any} */ f) => frames.push(f), backoff: () => 100 });
  t.after(() => c.close());
  // carol asks first: a long reply, so her turn is running when alex speaks
  const first = await call("carol", "stream.send", { session: info.chat, text: "@assistant " + LONG("CAROLS"), to: ["assistant:assistant"], cwd: work });
  assert.ok(!first.error, JSON.stringify(first.error));
  await until(() => textOf(frames).includes("CAROLS"), "carol's reply to start");
  const during = turns();
  assert.deepEqual(during.map(x => x.person), [info.carol], "the open turn is carol's");
  // alex speaks mid-turn
  const second = await call("alex", "stream.send", { session: info.chat, text: "@assistant " + LONG("ALEXS"), to: ["assistant:assistant"], cwd: work });
  assert.ok(!second.error, JSON.stringify(second.error));
  await sleep(300);
  assert.deepEqual(turns().map(x => x.person), [info.carol], "carol's turn is still carol's: alex's message did not take it over");
  assert.ok(!textOf(frames).replace(/CAROLS[\s\S]*?(?=echo|$)/, "").includes("ALEXS") || textOf(frames).indexOf("ALEXS") > textOf(frames).lastIndexOf("CAROLS"), "alex's words did not steer carol's turn");
  // carol's reply finishes; alex's turn then runs as its own turn, under alex
  await until(() => frames.filter(f => f.type === "session.text-done").length >= 1, "carol's reply to finish", 40_000);
  await until(() => turns().some(x => x.person === info.alex), "alex's own turn to open under alex", 40_000);
  await until(() => textOf(frames).includes("ALEXS"), "alex's reply", 40_000);
  const order = frames.filter(f => f.type === "session.text-done").length;
  assert.ok(order >= 1);
  assert.ok(textOf(frames).indexOf("CAROLS") < textOf(frames).indexOf("ALEXS"), "in arrival order: carol's reply, then alex's");
  try { process.kill(-/** @type {number} */ (child.pid), "SIGTERM"); } catch { /* gone */ }
});
