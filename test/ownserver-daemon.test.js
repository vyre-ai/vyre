// @ts-check
// A session on the person's own server is sealed at every turn on a real daemon: the Switchboard says which transcript a finished turn belongs to, the runner seals it into the home's
// checkpoint store as the owner's chain, and after a kill (a torn last line, an unfinished turn) `recover` puts the file back to exactly the last whole turn.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";
import { FAKE, until } from "../core/sessions/testing/boot.js";
import { createTurnSeal } from "../core/runner/ownserver.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

test("own-server session: every finished turn is sealed into the home's checkpoint store, and recover restores the last whole turn after a kill", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "local", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const logs = /** @type {string[]} */ ([]);
  const d = await start({ root, presence: present, log: m => logs.push(String(m)), kernel: true });
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const finished = async (/** @type {string} */ id, /** @type {number} */ n) => until(async () => (await d.registry.call("threads.get", { thread: id, limit: 500 }, "cli")).data.events.filter((/** @type {any} */ e) => e.type === "thread.finished").length >= n, `turn ${n}`);
  // the daemon supplies ownServer to the runner module through the kernel's runnerHost: a merge that drops it fails here, not silently
  const rh = d.kernel.kernelFor({ name: "runner" }).runnerHost();
  assert.ok(rh.ownServer && typeof rh.ownServer.resolve === "function" && typeof rh.ownServer.port === "function", "the daemon supplies ports.ownServer to the runner");
  assert.equal(typeof rh.identity, "function", "and runner's own { member, identity() } stands beside it");
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "first", surface: "deck" }, "cli");
  assert.ok(r.data && r.data.id, JSON.stringify(r));
  await finished(r.data.id, 1);
  await d.registry.call("threads.send", { thread: r.data.id, text: "second", surface: "deck" }, "cli");
  await finished(r.data.id, 2);
  const host = (await import("../core/daemon/ownserver-host.js")).createOwnServerHost({ kernel: d.kernel, registry: d.registry, root, log: () => {} });
  const cp = await until(async () => { const c = await host.port(d.kernel.id.space).getCheckpoint(r.data.id).catch(() => null); return c && c.turn >= 2 ? c : null; }, `two sealed turns (${logs.filter(m => /runner|seal/i.test(m)).join(" | ")})`);
  assert.equal(cp.turn, 2, "one checkpoint per finished turn");
  // the store the runner wrote is the home's own, readable as the owner
  const info = (await d.registry.call("threads.own-transcript", { session: r.data.id }, "module:runner")).data;
  const sealed = fs.readFileSync(info.file, "utf8");
  // a kill: the file's last line is torn and an unfinished turn follows
  fs.appendFileSync(info.file, JSON.stringify({ type: "user", message: { role: "user", content: "unfinished turn" } }) + "\n{\"type\":\"assistant\",\"mess");
  const seal = createTurnSeal({ port: host.port(d.kernel.id.space), session: r.data.id, file: info.file, root: info.root });
  const back = await seal.recover();
  assert.ok(back && back.turn === 2, JSON.stringify(back));
  assert.equal(fs.readFileSync(info.file, "utf8"), sealed, "the file is exactly the last whole turn again");
});
