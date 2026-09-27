// @ts-check
// `vyre agents history`, `resume` and `computer` as a person runs them: the real bin/vyre in a
// child process, against a vyred started in this process in a temp home, with the fake `claude`
// (core/switchboard/testing/fake-claude.js) for the agents' threads, the fake computer driver,
// and `present` as the presence verifier so no dialog is ever shown.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { call } from "../../daemon/client.js";
import { FakeDriver } from "../../computers/driver/fake.js";
import { tempHome, present } from "../../../test/helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "..", "..", "..", "bin", "vyre");
const FAKE_CLAUDE = path.join(HERE, "..", "..", "switchboard", "testing", "fake-claude.js");

/** @returns {Promise<{ code: number, out: string, stdout: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout + stderr, stdout })));

/** Every stdout line of a --view run, parsed as a frame. @param {string} s */
const frames = s => s.trim().split("\n").map(l => JSON.parse(l));

async function until(fn, what, ms = 10_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await new Promise(r => setTimeout(r, 25));
  }
}

async function world(t) {
  const root = tempHome(t);
  t.after(() => FakeDriver.forget(root));
  const log = path.join(root, "claude.log");
  const prev = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG };
  process.env.VYRE_CLAUDE_BIN = FAKE_CLAUDE;
  process.env.FAKE_CLAUDE_LOG = log;
  t.after(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  // Transcripts in the temp home, so nothing looks at the user's own sessions.
  const transcripts = path.join(root, "transcripts");
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], vault: { keystore: "file" },
    computers: { driver: "fake", sweepMs: 0, waitMs: 100 }, modules: { disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const tool = (name, input = {}) => call(name, input, { root, timeout: 20_000 });
  const launches = () => { try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  for (const a of [{ name: "juno", kind: "assistant" }, { name: "kit", projects: [], computer: true }]) {
    const r = await tool("agents.create", a);
    assert.ok(r.data, `agents.create ${a.name}: ${r.error && r.error.message}`);
  }
  return { root, tool, launches, vyre: (/** @type {string[]} */ ...args) => run(root, args) };
}

test("agents cli: history shows what was asked and answered, oldest first, pageable", async t => {
  const { vyre, tool } = await world(t);
  const none = await vyre("agents", "history", "kit");
  assert.equal(none.code, 0, none.out);
  assert.match(none.out, /nothing asked of kit yet · vyre agents ask kit <text>/);

  for (const text of ["one", "two", "three"]) assert.equal((await tool("agents.ask", { agent: "kit", text, surface: "deck" })).data.text, `echo: ${text}`);
  const h = await vyre("agents", "history", "kit");
  assert.equal(h.code, 0, h.out);
  assert.ok(h.out.indexOf("you › one") < h.out.indexOf("you › three"), "oldest first");
  assert.match(h.out, /kit › echo: two/);
  assert.match(h.out, /deck · thread \w{8} · #\d+/);
  assert.match(h.out, /older: vyre agents history kit --before \d+/);

  const all = JSON.parse((await vyre("agents", "history", "kit", "--json")).out);
  assert.deepEqual(all.map(x => [x.text, x.answer]), [["one", "echo: one"], ["two", "echo: two"], ["three", "echo: three"]]);
  const last = JSON.parse((await vyre("agents", "history", "kit", "--limit", "1", "--json")).out);
  assert.deepEqual(last.map(x => x.text), ["three"]);
  const before = JSON.parse((await vyre("agents", "history", "kit", "--before", String(last[0].id), "--json")).out);
  assert.deepEqual(before.map(x => x.text), ["one", "two"]);

  assert.equal((await vyre("agents", "history")).code, 2);
  assert.equal((await vyre("agents", "history", "kit", "--limit", "lots")).code, 2);
  assert.equal((await vyre("agents", "history", "kit", "--frob", "1")).code, 2, "an unknown flag is a usage mistake");
  const nobody = await vyre("agents", "history", "nobody", "--json");
  assert.equal(nobody.code, 1);
  assert.match(JSON.parse(nobody.out).error.message, /no agent nobody/);
});

test("agents cli: resume brings an agent's stopped thread back with its own credentials, and leaves a running one", async t => {
  const { root, vyre, tool, launches } = await world(t);
  const fresh = await vyre("agents", "resume", "kit");
  assert.equal(fresh.code, 1);
  assert.match(fresh.out, /kit has no thread to resume yet/);
  assert.match(fresh.out, /next: vyre agents ask kit <text>/);

  const asked = (await tool("agents.ask", { agent: "kit", text: "hello", surface: "deck" })).data;
  const running = JSON.parse((await vyre("agents", "resume", "kit", "--json")).out);
  assert.equal(running.running, true, "a running thread is left as it is");
  assert.equal(running.id, asked.thread);
  assert.match((await vyre("agents", "resume", "kit")).out, /kit's thread \w{8} is already running/);

  assert.ok((await tool("agents.stop", { agent: "kit" })).data);
  await until(async () => (await tool("threads.get", { thread: asked.thread })).data.thread.status === "stopped", "kit's thread to stop");
  const before = launches().length;
  const r = await vyre("agents", "resume", "kit");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`resumed kit thread ${asked.thread.slice(0, 8)}`));
  await until(() => launches().length > before, "the resume");
  const l = launches().at(-1);
  assert.ok(l.argv.includes("--resume") && l.argv.includes(asked.thread), JSON.stringify(l.argv));
  assert.equal(l.agent, "kit", "it runs as kit, with kit's scope");

  // Only the agent's own threads; and no model may ask for it (the callers list).
  const juno = (await tool("agents.ask", { agent: "juno", text: "hi", surface: "deck" })).data;
  const other = await vyre("agents", "resume", "kit", juno.thread);
  assert.equal(other.code, 1);
  assert.match(other.out, /is not one of kit's threads/);
  assert.equal((await call("agents.resume", { agent: "kit" }, { root, caller: "mcp" })).error?.code, "denied");
  assert.equal((await vyre("agents", "resume")).code, 2);
});

test("agents cli: computer shows an agent's machine, restarts it, and shows and sets its limits", async t => {
  const { vyre } = await world(t);
  const c = await vyre("agents", "computer", "kit");
  assert.equal(c.code, 0, c.out);
  assert.match(c.out, /kit's computer\s+none/);
  assert.match(c.out, /\d+ cores · [\d.]+ GB · no screen/);
  const cj = JSON.parse((await vyre("agents", "computer", "kit", "--json")).out);
  assert.equal(cj.agent, "kit");
  assert.equal(cj.state, "none");

  const lim = await vyre("agents", "computer", "kit", "limits", "--cpus", "3", "--memory", "6");
  assert.equal(lim.code, 0, lim.out);
  assert.match(lim.out, /limits set kit's computer/);
  assert.match(lim.out, /3 cores · 6 GB/);
  assert.match(lim.out, /they apply at the next restart: vyre agents computer kit restart/);
  assert.deepEqual(JSON.parse((await vyre("agents", "computer", "kit", "limits", "--json")).out), { agent: "kit", cpus: 3, memory_gb: 6 });
  assert.match((await vyre("agents", "computer", "kit", "limits")).out, /kit's computer: 3 cores, 6 GB/);

  const re = await vyre("agents", "computer", "kit", "restart", "--json");
  assert.equal(re.code, 0, re.out);
  const rj = JSON.parse(re.out);
  assert.equal(rj.state, "running");
  assert.equal(rj.cpus, 3);

  const bad = await vyre("agents", "computer", "kit", "limits", "--cpus", "99");
  assert.equal(bad.code, 1);
  assert.match(bad.out, /cpus is a whole number of cores/);
  assert.equal((await vyre("agents", "computer", "kit", "limits", "--cpus", "many")).code, 2);
  assert.equal((await vyre("agents", "computer", "kit", "--cpus", "2")).code, 2, "--cpus goes with limits");
  assert.equal((await vyre("agents", "computer", "kit", "reboot")).code, 2);
  assert.equal((await vyre("agents", "computer")).code, 2);
  const juno = await vyre("agents", "computer", "juno", "restart");
  assert.equal(juno.code, 1);
  assert.match(juno.out, /juno has no computer/);
  assert.match((await vyre("help", "agents")).out, /vyre agents computer <name> restart/);
});

test("agents cli: vyre commands lists every verb run() handles, without vyred", async t => {
  const root = tempHome(t);
  const r = await run(root, ["commands", "agents", "--json"]);
  assert.equal(r.code, 0, r.out);
  const verbs = JSON.parse(r.stdout).commands[0].verbs;
  assert.deepEqual(verbs.map(v => v.verb), ["list", "create", "update", "ask", "history", "threads", "resume", "computer", "usage", "stop", "delete"]);
  assert.deepEqual(verbs.filter(v => v.person).map(v => v.verb), ["create", "update", "resume", "computer"]);
  assert.deepEqual(verbs.filter(v => v.read).map(v => v.verb), ["list", "history", "threads", "usage"]);
  assert.deepEqual(verbs.find(v => v.verb === "delete").aliases, ["rm", "remove"]);
  assert.deepEqual(verbs.find(v => v.verb === "history").flags.map(f => f.name), ["limit", "before"]);
});

test("agents cli: --view draws the agents as a table and a computer as a card, with the data --json prints", async t => {
  const { vyre } = await world(t);
  const l = await vyre("agents", "list", "--view");
  assert.equal(l.code, 0, l.out);
  const f = frames(l.stdout);
  assert.deepEqual([f[0].cmd, f[0].view.kind, f[0].view.title], ["agents list", "table", "Agents"]);
  assert.deepEqual(f[0].view.columns.map(c => c.key), ["name", "kind", "status", "doing", "projects"]);
  assert.deepEqual(f[0].view.rows.map(r => r.id), ["juno", "kit"]);
  assert.deepEqual(f[0].data, JSON.parse((await vyre("agents", "--json")).stdout));
  assert.deepEqual(f.at(-1), { v: 1, done: true, exit: 0 });

  const c = frames((await vyre("agents", "computer", "kit", "--view")).stdout);
  assert.deepEqual([c[0].view.kind, c[0].view.title, c[0].view.state], ["card", "kit's computer", "unknown"]);
  assert.deepEqual(c[0].data, JSON.parse((await vyre("agents", "computer", "kit", "--json")).stdout));
});
