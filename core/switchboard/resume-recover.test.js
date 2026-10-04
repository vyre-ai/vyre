// @ts-check
// A thread whose process was killed is put back to its last sealed turn before it resumes (runner.recover): the torn tail and the unfinished turn a kill left in the provider's transcript
// never reach `claude --resume`. A thread that was stopped cleanly is resumed as it is.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { FAKE, until } from "../sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

test("a killed thread resumes from its last sealed turn: the torn tail and the unfinished turn are gone", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "local", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const events = async (/** @type {string} */ id) => (await d.registry.call("threads.get", { thread: id, limit: 500 }, "cli")).data.events;
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "first", surface: "deck" }, "cli");
  assert.ok(r.data && r.data.id, JSON.stringify(r));
  const id = r.data.id;
  await until(async () => (await events(id)).some((/** @type {any} */ e) => e.type === "thread.finished"), "the first turn");
  const host = (await import("../daemon/ownserver-host.js")).createOwnServerHost({ kernel: d.kernel, registry: d.registry, root, log: () => {} });
  await until(async () => { const c = await host.port(d.kernel.id.space).getCheckpoint(id).catch(() => null); return c && c.turn >= 1; }, "the turn sealed");
  const info = (await d.registry.call("threads.own-transcript", { session: id }, "module:runner")).data;
  const sealed = fs.readFileSync(info.file, "utf8");
  // the kill: the process dies, and the file holds a torn line and an unfinished turn
  const pids = (await d.registry.call("threads.pids", {}, "module:vyred")).data;
  assert.ok(pids.pids[0], "a pid to kill");
  process.kill(pids.pids[0], "SIGKILL");
  await until(async () => (await events(id)).some((/** @type {any} */ e) => e.type === "thread.stopped"), "the crash");
  fs.appendFileSync(info.file, JSON.stringify({ type: "user", message: { role: "user", content: "UNFINISHED" } }) + "\n{\"type\":\"assistant\",\"mess");
  await d.registry.call("threads.send", { thread: id, text: "back after the crash", surface: "deck" }, "cli");
  await until(async () => (await events(id)).filter((/** @type {any} */ e) => e.type === "thread.finished").length >= 2, "the resumed turn");
  const now = fs.readFileSync(info.file, "utf8");
  assert.ok(!now.includes("UNFINISHED") && !now.includes('{"type":"assistant","mess\n'), "the killed turn's leftovers never reached the resumed session");
  assert.ok(now.startsWith(sealed.split("\n").slice(0, 1).join("\n")), "the sealed history is what the session resumed from");
});
