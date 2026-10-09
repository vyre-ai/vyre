// @ts-check
// The assistant's golden path on ONE real daemon with the fake provider, so the class "the registry default refuses a proven assistant" is found by a test and not one tool at a time. A proven assistant
// (its own session: the thread socket stamps its caller and kernel session) acting for its person inside its own grants must reach what it needs; the SAME call from a bare session, from another agent
// without the grant, and for a wider scope must be refused. Each step is one row: who calls, what, what must happen. A row that fails is a red test, shown in the
// run and never silently green. Run: node --test test/assistant-golden-path.test.js on a test box.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present, asOwner } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";
import { FAKE, until } from "../core/sessions/testing/boot.js";
import { isPerson, modelKey } from "../lib/caller.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

/** One real daemon: a home with a kernel, the fake provider, an assistant `juno`, a project agent `kit` with no grants, a plain session, and a task whose doer is the assistant. */
async function world(t) {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root); // calls from cli/deck arrive as the owner's device, as on the real socket (chat gate)
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller = "cli") => d.registry.call(tool, input, caller);
  // The project the assistant is granted: its home is the work folder, a teammate "design" is in it (so team.ask and threads.start have somewhere to go). kit is granted nothing.
  const project = (await call("projects.create", { name: "Harlow Legal", home: work })).data;
  const record = (await until(async () => { const r = await call("work.project.ref", { project: project.slug }); return r.error ? null : r.data; }, "the Project record")).id;
  assert.ok(!(await call("agents.create", { name: "juno", kind: "assistant", projects: [project.slug] })).error, "juno created");
  assert.ok(!(await call("agents.create", { name: "kit", kind: "agent" })).error, "kit created");
  const added = await call("team.add", { project: record, role: "design", brief: "visual design" });
  assert.ok(!added.error, "a teammate in the project: " + JSON.stringify(added.error));
  const owner = d.kernel.id.owner, space = d.kernel.id.space;
  const person = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const ask = async (/** @type {string} */ title) => d.kernel.gateway.ask.request(person, { title, output: { kind: "decision" }, source: "manual", doer: { kind: "agent", id: "assistant", space }, checker: { kind: "person", id: owner, space } });
  /** A session's own tool call, the way its MCP server makes it: the prompt line `vyre-sock <tool> <json>` goes through the session's socket, which stamps its caller and kernel session. Returns the JSON the tool answered. */
  async function viaSession(/** @type {string} */ agent, /** @type {string} */ tool, /** @type {any} */ input) {
    const before = new Set();
    const r = await call("agents.ask", { agent, text: `vyre-sock ${tool} ${JSON.stringify(input)}`, wait: false, surface: "deck" });
    if (r.error) return { error: r.error };
    const thread = r.data.thread;
    let answer = null;
    await until(async () => {
      const th = (await call("threads.get", { thread, limit: 400 })).data;
      const texts = (th.events || []).filter((/** @type {any} */ e) => e.type === "thread.text" && e.payload && e.payload.done === true && typeof e.payload.text === "string");
      const last = texts[texts.length - 1];
      if (!last || before.has(last.payload.message + last.payload.turn)) return false;
      try { answer = JSON.parse(last.payload.text); } catch { answer = { raw: last.payload.text }; }
      return true;
    }, `${agent} ${tool} answered`, 30_000);
    return answer;
  }
  /** A plain session (no agent named): its socket labels it mcp:thread:<id>, which is every model's shell and never the assistant. */
  async function viaPlainSession(/** @type {string} */ tool, /** @type {any} */ input) {
    const started = await call("threads.start", { cwd: work, prompt: `vyre-sock ${tool} ${JSON.stringify(input)}`, surface: "deck" });
    if (started.error) return { error: started.error };
    const thread = started.data.id;
    let answer = null;
    await until(async () => {
      const th = (await call("threads.get", { thread, limit: 400 })).data;
      const texts = (th.events || []).filter((/** @type {any} */ e) => e.type === "thread.text" && e.payload && e.payload.done === true && typeof e.payload.text === "string");
      const last = texts[texts.length - 1];
      if (!last) return false;
      try { answer = JSON.parse(last.payload.text); } catch { answer = { raw: last.payload.text }; }
      return true;
    }, `plain ${tool} answered`, 30_000);
    return answer;
  }
  return { d, call, person, owner, space, ask, viaSession, viaPlainSession, work, record };
}
const refused = (/** @type {any} */ r) => Boolean(r && r.error);

test("lib/caller.js agrees with the rows below: a session's label is never the person, and a named agent has its own key", () => {
  for (const l of ["mcp", "mcp:thread:t1", "mcp:agent:juno"]) assert.equal(isPerson(l), false, l);
  assert.equal(modelKey("mcp:agent:juno"), "juno");
  assert.equal(modelKey("mcp:thread:t1"), "caller:mcp");
});

test("the proven assistant takes and submits a task it is the doer of; another agent without the grant cannot", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const task = await w.ask("Draft the engagement letter");
  assert.equal(task.state, "ready");
  // another agent (kit, no grant) reaches nothing of this task: not even its existence
  const kitMove = await w.viaSession("kit", "tasks.move", { id: task.id, to: "working" });
  assert.ok(refused(kitMove), "kit must not move the assistant's task: " + JSON.stringify(kitMove));
  assert.equal((await w.d.kernel.gateway.ask.get(w.person, task.id)).state, "ready");
  // the assistant does
  const mv = await w.viaSession("juno", "tasks.move", { id: task.id, to: "working" });
  assert.ok(!refused(mv), "the assistant moves its own task: " + JSON.stringify(mv));
  await until(async () => (await w.d.kernel.gateway.ask.get(w.person, task.id)).state === "working", "the task is working");
  const sub = await w.viaSession("juno", "tasks.submit", { id: task.id, evidence: { answer: "yes", reason: "drafted" } });
  assert.ok(!refused(sub), "the assistant submits it: " + JSON.stringify(sub));
  await until(async () => (await w.d.kernel.gateway.ask.get(w.person, task.id)).state === "needs_check", "the task needs the person's check");
  // and it cannot decide its own work: tasks.decide is the person's
  const dec = await w.viaSession("juno", "tasks.decide", { id: task.id, decision: "approve" });
  const after = await w.d.kernel.gateway.ask.get(w.person, task.id);
  assert.equal(after.state, "needs_check", "the assistant never approves its own task (answer: " + JSON.stringify(dec).slice(0, 200) + ")");
});

/** The steps of the golden path, each on a real daemon. */
const STEPS = [
  { name: "reads what it is granted (tasks.list, memory.facts)", tool: "tasks.list", input: {}, agent: "juno", ok: true },
  { name: "another agent without the grant sees none of the assistant's tasks", tool: "tasks.list", input: {}, agent: "kit", ok: true, empty: "tasks" },
  { name: "writes a memory line the person must settle (memory.heard)", tool: "memory.heard", input: { action: "add", subject: "accountant", rel: "is", object: "Dana Reyes" }, agent: "juno", ok: true },
  { name: "proposes a lesson (learn.add makes a PROPOSED one)", tool: "learn.add", input: { text: "never use em dashes" }, agent: "juno", ok: true },
  { name: "asks a teammate (team.ask)", tool: "team.ask", input: { to: "design", text: "hello", project: "PROJECT" }, agent: "juno", ok: true },
  { name: "asks an agent (agents.ask kit)", tool: "agents.ask", input: { agent: "kit", text: "hello", wait: false }, agent: "juno", ok: true },
  { name: "kit (no grant) cannot ask the assistant", tool: "agents.ask", input: { agent: "juno", text: "hello", wait: false }, agent: "kit", ok: false },
  { name: "starts a session inside its grant (threads.start)", tool: "threads.start", input: { cwd: "WORK", prompt: "hello", surface: "deck" }, agent: "juno", ok: true },
  { name: "kit cannot start a session in a folder it has no project for", tool: "threads.start", input: { cwd: "WORK", prompt: "hello", surface: "deck" }, agent: "kit", ok: false },
  { name: "proposes a Kit (flows.kit.propose)", tool: "flows.kit.propose", input: { kit: "starter" }, agent: "juno", ok: true },
];

for (const step of STEPS) {
  test(`golden path: ${step.name}`, { timeout: 90_000 }, async t => {
    const w = await world(t);
    const input = JSON.parse(JSON.stringify(step.input).replace("WORK", w.work).replace("PROJECT", w.record));
    const r = await w.viaSession(step.agent, step.tool, input);
    if (step.empty) { assert.ok(!refused(r) && Array.isArray(r.data && r.data[step.empty]) && r.data[step.empty].length === 0, `${step.agent} ${step.tool} must see nothing: ${JSON.stringify(r).slice(0, 200)}`); return; }
    if (step.ok) assert.ok(!refused(r), `${step.agent} ${step.tool}: ${JSON.stringify(r).slice(0, 300)}`);
    else assert.ok(refused(r), `${step.agent} ${step.tool} must be refused: ${JSON.stringify(r).slice(0, 300)}`);
  });
}

// Found by the first run (5 Oct) and fixed with R031-94: only the person's pinned assistant chat acts as the assistant (lib/kernel-session.js `pinned`); a bare session is a plain session.
test("a plain session (no agent named) cannot move the assistant's task", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const task = await w.ask("Draft the engagement letter");
  const plain = await w.viaPlainSession("tasks.move", { id: task.id, to: "working" });
  assert.ok(refused(plain) || (await w.d.kernel.gateway.ask.get(w.person, task.id)).state === "ready", "a bare session must not move the assistant's task: " + JSON.stringify(plain).slice(0, 200));
});
