// @ts-check
import "../scripts/mac-test-guard.mjs";
// Who may start sessions and ask agents, on a real daemon (kernel on, fake provider): the home's assistant, an agent the person made, and a bare model session. A model caller is never the person: it acts
// under its own agent's grants or not at all.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present, kernelCaller } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";
import { FAKE } from "../core/sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

async function rig(/** @type {any} */ t) {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on", max_live: 60 } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const mk = (/** @type {string} */ n) => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, `vyre-${n}-`))); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
  const work = mk("work"), p1 = mk("p1"), p2 = mk("p2");
  const ok = (/** @type {any} */ r) => { assert.ok(!r.error, JSON.stringify(r)); return r.data; };
  ok(await d.registry.call("projects.create", { name: "One", home: p1 }, "cli"));
  ok(await d.registry.call("projects.create", { name: "Two", home: p2 }, "cli"));
  ok(await d.registry.call("agents.create", { name: "assistant", kind: "assistant", projects: "*" }, "cli"));
  ok(await kernelCaller(d, root)("agents.create", { name: "kit", projects: ["one"] }));
  const person = ok(await d.registry.call("threads.start", { cwd: work, prompt: "hi", surface: "deck" }, "cli")).id;
  const other = ok(await d.registry.call("threads.start", { cwd: work, prompt: "someone else's thread", surface: "deck" }, "cli")).id;
  const asAssistant = { thread: person, agent: "assistant", agentKind: "assistant", granted: "*" };
  const asKit = { thread: person, agent: "kit", agentKind: "agent", granted: ["one"] };
  return { d, work, p1, p2, person, other, asAssistant, asKit, call: (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ meta) => d.registry.call(tool, input, caller, meta) };
}
const refused = (/** @type {any} */ r) => Boolean(r.error);

test("a bare model session (mcp, mcp:thread:<id>) starts no session, asks no agent and writes into no other thread", { timeout: 120_000 }, async t => {
  const { work, person, other, call } = await rig(t);
  for (const [caller, meta] of [["mcp", { thread: person }], [`mcp:thread:${person}`, { thread: person }], ["harness", { thread: person }]]) {
    assert.ok(refused(await call("threads.start", { cwd: work, prompt: "child", surface: "deck" }, caller, meta)), `${caller} starts a session`);
    assert.ok(refused(await call("agents.ask", { agent: "kit", text: "hi", wait: false }, caller, meta)), `${caller} asks an agent`);
    assert.ok(refused(await call("agents.ask", { agent: "assistant", text: "hi", wait: false }, caller, meta)), `${caller} asks the assistant`);
    const inject = await call("threads.send", { thread: other, text: "INJECTED", surface: "deck" }, caller, meta);
    assert.ok(refused(inject), `${caller} types into another person's thread: ${JSON.stringify(inject)}`);
  }
});

test("the assistant starts and drives sessions and asks its agents; threads.launch stays modules-only", { timeout: 120_000 }, async t => {
  const { work, p1, asAssistant, call } = await rig(t);
  const started = await call("threads.start", { cwd: p1, prompt: "child", surface: "deck" }, "mcp:agent:assistant", asAssistant);
  assert.ok(!started.error && started.data && started.data.id, JSON.stringify(started));
  assert.ok(!(await call("agents.ask", { agent: "kit", text: "hi", wait: false }, "mcp:agent:assistant", asAssistant)).error, "the assistant asks an agent");
  for (const [caller, meta] of [["cli", undefined], ["mcp:agent:assistant", asAssistant], ["mcp", { thread: "x" }]]) {
    assert.ok(refused(await call("threads.launch", { cwd: work, prompt: "x" }, caller, meta)), `${caller} threads.launch`);
  }
});

test("a named agent acts only within its own grants: not another project, not the assistant, not the person's fields", { timeout: 120_000 }, async t => {
  const { work, p1, p2, other, asKit, call } = await rig(t);
  // only the assistant starts and drives sessions (agents.* docs): an agent the person made does not, in its own project or any other
  assert.ok(refused(await call("threads.start", { cwd: p1, prompt: "in my project", surface: "deck" }, "mcp:agent:kit", asKit)), "an agent starts no session of its own");
  assert.ok(refused(await call("threads.start", { cwd: p2, prompt: "in someone else's project", surface: "deck" }, "mcp:agent:kit", asKit)), "another project's folder");
  assert.ok(refused(await call("threads.start", { cwd: work, prompt: "a folder in no project", surface: "deck" }, "mcp:agent:kit", asKit)), "a folder in no project");
  assert.ok(refused(await call("agents.ask", { agent: "assistant", text: "hi", wait: false }, "mcp:agent:kit", asKit)), "an agent asks the assistant (sees every project)");
  assert.ok(refused(await call("threads.send", { thread: other, text: "INJECTED", surface: "deck" }, "mcp:agent:kit", asKit)), "an agent types into another thread");
  // a model never picks another agent's credentials or a thread to resume: those fields are not its to send
  const sneaky = await call("threads.start", { cwd: p1, prompt: "x", surface: "deck", agent: "assistant", agent_kind: "assistant", resume: other, account: "someone" }, "mcp:agent:kit", asKit);
  if (!sneaky.error) {
    const rec = (await call("threads.get", { thread: sneaky.data.id }, "cli")).data.thread;
    assert.ok(!rec.agent || rec.agent === "kit", `the new thread did not borrow the assistant: ${JSON.stringify(rec.agent)}`);
  }
});

test("SW-1: an agent's session starts only inside a mapped project's folder: not a folder in no project, not / or /etc, not through a symlink or ..", { timeout: 120_000 }, async t => {
  const { work, p1, asAssistant, asKit, call } = await rig(t);
  const start = (/** @type {any} */ input, /** @type {any} */ meta = asAssistant, caller = "mcp:agent:assistant") => call("threads.start", { prompt: "x", surface: "deck", ...input }, caller, meta);
  const sub = path.join(p1, "sub"); fs.mkdirSync(sub);
  const link = path.join(p1, "to-etc"); fs.symlinkSync("/etc", link);
  const outsideLink = path.join(p1, "to-work"); fs.symlinkSync(work, outsideLink);
  for (const [what, cwd] of [["a folder in no project", work], ["/", "/"], ["/etc", "/etc"], ["a symlink out of the project", link], ["a symlink to another folder", outsideLink], ["a .. out of the project", path.join(p1, "..", path.basename(work))], ["a folder that is not there", path.join(p1, "nope")]]) {
    const r = await start({ cwd });
    assert.equal(r.error && r.error.code, "denied", `${what}: ${JSON.stringify(r)}`);
  }
  assert.ok(!(await start({ cwd: p1 })).error, "the project's own folder");
  assert.ok(!(await start({ cwd: sub })).error, "a folder inside it");
  assert.ok(!(await start({ project: "one" })).error, "the project by name");
  assert.equal((await start({})).error?.code, "denied", "no folder and no project is not a place");
  // a person's own start keeps today's rule
  assert.ok(!(await call("threads.start", { cwd: work, prompt: "mine", surface: "deck" }, "cli")).error, "the person may start anywhere they could before");
});

test("SW-2: what a named agent may do does not depend on the label it sends: mcp, mcp:thread:<id>, harness and mcp:agent:kit answer the same", { timeout: 180_000 }, async t => {
  const { work, p1, p2, other, asKit, asAssistant, call, person } = await rig(t);
  const labels = ["mcp", `mcp:thread:${person}`, "harness", "mcp:agent:kit", "mcp:agent:assistant"];
  /** @param {string} caller @param {any} meta @param {any} input */
  const outcome = async (caller, meta, input) => { const r = await call("threads.start", { prompt: "x", surface: "deck", ...input }, caller, meta); return r.error ? r.error.code : "ok"; };
  for (const label of labels) {
    for (const [what, input] of [["its own project", { cwd: p1 }], ["project two's folder", { cwd: p2 }], ["project two by name", { project: "two" }], ["no project", { cwd: work }]]) {
      assert.notEqual(await outcome(label, asKit, input), "ok", `kit via ${label}: ${what} starts nothing (only the assistant starts sessions)`);
    }
    const send = await call("threads.send", { thread: other, text: "INJECTED", surface: "deck" }, label, asKit);
    assert.ok(send.error, `kit via ${label} types into another thread: ${JSON.stringify(send)}`);
    // the assistant: its granted projects only (here every project), the same under every label
    assert.equal(await outcome(label, asAssistant, { cwd: p1 }), "ok", `assistant via ${label} in a project`);
    assert.notEqual(await outcome(label, asAssistant, { cwd: "/etc" }), "ok", `assistant via ${label} in /etc`);
    // a model does not pick a looser purpose
    for (const purpose of ["capsule", "job", "teammate", "memory", "planner", "learn", "helper"]) assert.notEqual(await outcome(label, asAssistant, { cwd: p1, purpose }), "ok", `assistant via ${label} purpose ${purpose}`);
  }
});
