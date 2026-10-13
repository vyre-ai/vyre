// @ts-check
// A chat moved to another Claude account where accounts share one HOME (no spawner uid) starts a fresh session. The thread id already names a transcript there, and the real CLI refuses it
// ("Session ID is already in use"), so it starts under a fresh native id, recorded as a rollover is. Found by the G01 walk (a teammate's turn on her own sign-in never finished).
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { asOwner, tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { until, FAKE } from "../sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1"; process.env.VYRE_SESSION_SANDBOX_OFF = "1";

test("a Claude chat moved to another Claude account with a shared HOME starts under a fresh native id, not the id the HOME already holds", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS, FAKE_CLAUDE_SESSION_IN_USE: process.env.FAKE_CLAUDE_SESSION_IN_USE };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts, FAKE_CLAUDE_SESSION_IN_USE: "1" });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = asOwner(await start({ root, presence: present, log: () => {}, kernel: true }), root);
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const db = d.registry.deps.db;
  const settled = (/** @type {string} */ id) => { const r = db.prepare("SELECT status FROM threads_runs WHERE id = ?").get(id); return Boolean(r && ["finished", "idle", "stopped"].includes(r.status)); };
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck", provider: "claude" }, "cli");
  assert.ok(r.data, JSON.stringify(r));
  const id = r.data.id;
  await until(async () => settled(id), "the first turn to end", 90_000);
  const other = await d.registry.call("sessions.accounts.add", { provider: "claude", label: "Other Claude", kind: "login" }, "cli");
  assert.ok(!other.error, JSON.stringify(other.error));
  db.prepare("UPDATE sessions_accounts SET signed_in_at = ? WHERE id = ?").run(Date.now(), other.data.id);
  const nativeBefore = (await d.registry.call("threads.rolls", { thread: id }, "deck")).data.native;
  assert.equal(nativeBefore, id, "the first session is the thread's own id");
  const sw = await d.registry.call("threads.switch", { thread: id, provider: "claude", account: other.data.id }, "cli");
  assert.ok(!sw.error, JSON.stringify(sw.error));
  await new Promise(x => setTimeout(x, 800));
  const row = /** @type {any} */ (db.prepare("SELECT status, account, stopped_reason FROM threads_runs WHERE id = ?").get(id));
  assert.doesNotMatch(String(row.stopped_reason || ""), /already in use/, "the new account's session started");
  assert.notEqual(row.status, "stopped", JSON.stringify(row));
  assert.equal(row.account, other.data.id);
  const rolls = /** @type {any[]} */ (db.prepare("SELECT reason, native_from, native_to FROM threads_rolls WHERE thread = ?").all(id));
  assert.equal(rolls.length, 1);
  assert.equal(rolls[0].reason, "account");
  assert.equal(rolls[0].native_from, id);
  assert.notEqual(rolls[0].native_to, id, "a fresh native id");
  assert.equal((await d.registry.call("threads.rolls", { thread: id }, "deck")).data.native, rolls[0].native_to, "the thread now runs on it");
});
