// @ts-check
// The limited `vyre` at the Switchboard: in a CONFINED session the floor lets the shim's three forms through without a question; anything else that mentions vyre, or the data folder, is
// refused or still asked. An unconfined session gets nothing new. The sandbox port is a stand-in that passes its check and runs the command as it is, recording how it was planned.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { boot, until } from "../sessions/testing/boot.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Put a stand-in sandbox under the daemon's sessions; returns what it was asked to plan. */
function confine(/** @type {any} */ w) {
  const plans = /** @type {any[]} */ ([]);
  const cfg = w.d.registry.deps.sandbox;   // the module holds this very object: replaced in place
  for (const k of Object.keys(cfg)) delete cfg[k];
  Object.assign(cfg, { platform: process.platform === "darwin" ? "darwin" : "linux", home: os.homedir(), vyreHome: w.root, temp: os.tmpdir(), probes: {},
    sandbox: { planHome: (/** @type {any} */ o) => { plans.push(o); return o; }, selfTest: async () => ({ ok: true, failures: [] }),
      launch: (/** @type {any} */ plan, /** @type {any} */ opts) => spawn(plan.command, plan.args, { env: { ...process.env, ...plan.env }, cwd: opts && opts.cwd, stdio: ["pipe", "pipe", "pipe"] }) } });
  return plans;
}
/** What the floor made of one Bash line: "allowed" (no question), "refused: ..." (the floor said no), or "asked" (a person was asked; the test says no). */
const ask = async (/** @type {any} */ w, /** @type {string} */ id, /** @type {string} */ command, /** @type {number} */ n) => {
  await w.tool("threads.send", { thread: id, text: `bash-ask ${command}`, surface: "deck" });
  const open = async () => ((await w.tool("threads.asks", { thread: id })).data || []).filter((/** @type {any} */ a) => a.thread === id || !a.thread);
  const first = await until(async () => (await open())[0] || (await w.events(id)).filter((/** @type {any} */ e) => e.type === "thread.finished").length >= n, `an answer or a question for turn ${n}`);
  if (first !== true) { await w.tool("threads.answer", { ask: first.id, decision: "deny", surface: "deck" }); await w.finished(id, n); return "asked"; }
  return (await w.said(id)).at(-1);
};

test("a confined session: the shim's forms are allowed without a question, everything near them is refused or asked; the shim is on its PATH", { timeout: 120_000 }, async t => {
  const w = await boot(t, { driver: "cli", kernel: true, sessions: { thread_socket: "on" } });
  const plans = confine(w);
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "bash-ask vyre tools find 'send an email'", surface: "deck" })).data;
  await w.finished(th.id);
  assert.equal((await w.said(th.id)).at(-1), "allowed", "find is allowed with no question");
  assert.equal(((await w.tool("threads.asks", { thread: th.id })).data || []).length, 0, "nobody was asked");

  const claude = plans.find(p => /fake-claude/.test(String(p.command)) || (p.args || []).some((/** @type {string} */ a) => /fake-claude/.test(a)));
  assert.ok(claude, "the session's process was planned by the sandbox");
  assert.equal(claude.pathDirs[0], path.join(REPO, "bin", "session"), "the shim folder is first on the session's PATH");
  assert.ok(claude.readOnly.includes(REPO), "the code the shim runs is readable");
  assert.equal(claude.env.VYRE_NODE, process.execPath);
  assert.equal(claude.env.VYRE_SESSION_CLI, path.join(REPO, "core", "session-cli", "index.js"));

  assert.equal(await ask(w, th.id, `vyre tools describe mail.send`, 2), "allowed");
  assert.equal(await ask(w, th.id, `vyre call mail.send '{"to":"a@b.c","subject":"s","body":"b"}'`, 3), "allowed", "the call is allowed to REACH the registry, which holds it");
  assert.notEqual(await ask(w, th.id, `vyre vault get x`, 4), "allowed", "a vault verb is not the shim's");
  assert.notEqual(await ask(w, th.id, `vyre call vault.reveal '{"name":"x"}'; cat ${path.join(w.root, "vyre.db")}`, 5), "allowed", "a chain that reads the data folder");
  assert.match(await ask(w, th.id, `cat ${path.join(w.root, "vyre.db")}`, 6) || "", /^refused/, "reading the data folder is refused by the floor");
  assert.match(await ask(w, th.id, `cat ${w.root}/vault/anything`, 7) || "", /^refused/, "so is the vault folder");
  assert.equal(await ask(w, th.id, `vyre call mail.send '{}' && echo hi`, 8), "asked", "a chain is not the shim's shape: a person is asked, nothing is allowed alone");
});

test("an unconfined session gets no allowance: the same line is asked like any other", { timeout: 60_000 }, async t => {
  const w = await boot(t, { driver: "cli", kernel: true, sessions: { thread_socket: "on" } });
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "bash-ask vyre tools find 'send an email'", surface: "deck" })).data;
  await until(async () => ((await w.tool("threads.asks", { thread: th.id })).data || []).length > 0, "a question for the person");
  assert.ok(!(await w.said(th.id)).includes("allowed"));
});
