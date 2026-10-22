// @ts-check
// Checklist lines 21-24 on a real daemon: an agent's Flow lands on the project's list, a schedule and a webhook address and an agent-made watcher each start a Flow, a deadline takes the on timeout path and says so, and a failed run says why and can be retried.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";
import { flowsHere } from "../apps/app/screens/projects/kind-panes.js";
import { addressFacts } from "../apps/app/ui/flows/webhook-model.js";
import { canRetry } from "../apps/app/screens/flows/run-model.ts";
import { testHooks, OPEN_WALL } from "../lib/sandbox/index.js";
import { skipOffRunner } from "../lib/sandbox/test-host.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const canonical = (/** @type {any} */ x) => JSON.stringify(x, Object.keys(x).sort());
const signedPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 40_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(what); await new Promise(r => setTimeout(r, 150)); } };
const SLIP = { name: "slip", label: "Slip", fields: [{ name: "body", kind: "text", label: "Body" }, { name: "kind", kind: "text", label: "Kind" }] };
const slip = (/** @type {string} */ body, /** @type {string} */ kind) => ({ id: "m", kind: "create", type: "slip", set: { body, kind } });

/** @param {import("node:test").TestContext} t */
async function boot(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-home", role: "box", sessions: { install: false }, projectsDir: path.join(root, "projects"), vault: { keystore: "file" }, hooks: { port: 0 } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: signedPresence() });
  t.after(() => d.stop().catch(() => {}));
  const space = d.kernel.id.space;
  const host = d.registry.deps.flowsHost.get(space);
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  await d.kernel.gateway.records.define(admin, { add_types: [SLIP] });
  const person = async () => ({ token: (await d.kernel.surfaces.open(admin, {})).token });
  const agent = async (/** @type {string} */ thread) => ({ token: (await d.kernel.surfaces.open(admin, { agent: "scout", thread })).token, thread, agent: "scout" });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ meta) => d.registry.call(tool, input, caller, meta);
  const approve = (/** @type {any} */ def) => host.flows.tools["flows.approve"](host.personChain(), { id: def.id, version: def.version, hash: def.hash });
  return { root, d, host, admin, person, agent, call, approve };
}

test("an agent asked in a project's chat makes a Flow that shows under that project's Flows", { timeout: 120_000 }, async t => {
  const { root, d, person, agent, call } = await boot(t);
  const now = Date.now();
  d.registry.deps.db.prepare("INSERT INTO threads_runs (id, name, cwd, project, agent, status, started_at, last_at) VALUES (?,?,?,?,?,?,?,?)").run("th-quill", "quill", root, "quill-desk", "scout", "idle", now, now);
  const draft = { format: 1, name: "quill_note", label: "Quill note", authorship: "model", trigger: { on: "manual" }, steps: [slip("from the ask", "ask")] };
  const made = await call("flows.define", { flow: draft }, "mcp:agent:scout", await agent("th-quill"));
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  assert.equal(made.data.ok, true, JSON.stringify(made.data));
  const got = await call("flows.get", { id: made.data.id }, "cli", await person());
  assert.equal(got.data.flow.project, "quill-desk", "the thread's project is stamped when the Flow names none");
  const listed = await call("flows.list", { project: "quill-desk" }, "cli", await person());
  assert.ok(listed.data.some((/** @type {any} */ r) => r.id === made.data.id), JSON.stringify(listed.data));
  assert.ok(flowsHere(listed.data, []).some((/** @type {any} */ r) => r.id === made.data.id), "the project's Flows pane lists it");
  const other = await call("flows.list", { project: "other-desk" }, "cli", await person());
  assert.equal(other.data.some((/** @type {any} */ r) => r.id === made.data.id), false);
  const fromChat = await call("flows.from-chat", { name: "quill chat", calls: [{ tool: "work.call", input: { tool: "slips.create", input: { data: { body: "from the chat", kind: "chat" } } } }] }, "mcp:agent:scout", await agent("th-quill"));
  assert.equal(fromChat.error, undefined, JSON.stringify(fromChat.error));
  assert.equal(fromChat.data.ok, true, JSON.stringify(fromChat.data));
  const chatFlow = await call("flows.get", { id: fromChat.data.id }, "cli", await person());
  assert.equal(chatFlow.data.flow.project, "quill-desk");
});

test("a Flow runs when its schedule comes round, through the wake timer", { timeout: 120_000 }, async t => {
  const { d, host, admin, person, call, approve } = await boot(t);
  const at = Date.now() + 12_000;
  const def = await call("flows.define", { flow: { format: 1, name: "quill_clock", label: "Quill clock", authorship: "human", trigger: { on: "time", at }, steps: [slip("the schedule ran", "schedule")] } }, "cli", await person());
  assert.equal(def.data && def.data.ok, true, JSON.stringify(def.data || def.error));
  await approve(def.data);
  const row = await until(async () => (await d.kernel.gateway.records.query(admin, "slip", { page: { limit: 20 } })).rows.find((/** @type {any} */ r) => r.data.kind === "schedule") || null, "the schedule to start the Flow", 40_000);
  assert.equal(row.data.body, "the schedule ran");
  const runs = await until(async () => { const r = await host.flows.tools["flows.runs"](host.personChain(), { id: def.data.id }); return r.length && r[0].state !== "running" ? r : null; }, "the schedule's run to leave running");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].state, "done", JSON.stringify(runs[0].error || runs[0].state));
});

test("the Flow page can copy the webhook path when the server has no public address, and a delivery starts the Flow", { timeout: 120_000 }, async t => {
  const { d, person, call, approve } = await boot(t);
  const def = await call("flows.define", { flow: { format: 1, name: "quill_hook", label: "Quill hook", authorship: "human", trigger: { on: "web", path: "hook", address: true }, steps: [{ id: "pause", kind: "wait", for_ms: 60_000 }] } }, "cli", await person());
  assert.equal(def.data && def.data.ok, true, JSON.stringify(def.data || def.error));
  await approve(def.data);
  const h = await until(async () => { const r = await call("hooks.flow", { flow: def.data.id }, "cli", {}); return r.data && r.data.open ? r.data : null; }, "the address to open");
  assert.equal(h.address.url, null);
  const facts = addressFacts(h);
  assert.equal(facts.state, "here");
  assert.equal(facts.address, h.address.path);
  assert.match(facts.address, /^\/hooks\/quill-hook-[0-9a-f]{64}$/);
  const page = fs.readFileSync(new URL("../apps/app/ui/flows/WebhookFields.tsx", import.meta.url), "utf8");
  assert.match(page, /<CodeBlock code=\{f\.address\}/);
  const http = await import("node:http");
  const port = (await call("hooks.list", {}, "cli", {})).data.port;
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: h.address.path, headers: { "content-type": "application/json" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject);
    req.end('{"body":"from the hook"}');
  });
  assert.equal(status, 200);
  const runs = await until(async () => { const r = await call("flows.runs", { id: def.data.id }, "cli", await person()); return r.data && r.data.length ? r.data : null; }, "the delivery to start a run");
  assert.equal(runs[0].state === "waiting" || runs[0].state === "running" || runs[0].state === "done", true, JSON.stringify(runs[0]));
});

test("a watcher the agent made starts the Flow armed on it", { skip: skipOffRunner(), timeout: 180_000 }, async t => {
  testHooks.wall = OPEN_WALL;
  t.after(() => { testHooks.wall = undefined; });
  const { root, d, host, admin, person, call, approve } = await boot(t);
  const def = await call("flows.define", { flow: { format: 1, name: "quill_watch", label: "Quill watch", authorship: "human", trigger: { on: "watcher", watcher: "quill-forms" }, steps: [slip({ expr: "trigger.item.title" }, "from-watcher")] } }, "cli", await person());
  assert.equal(def.data && def.data.ok, true, JSON.stringify(def.data || def.error));
  await approve(def.data);
  const said = await d.registry.call("vault.said.record", { thread: "th-quill", said: "s-quill", kind: "act_out", channel: "watchers", to: ["watchers.write"], what: "set up for itself" }, "module:sessions");
  assert.ok(said.data, JSON.stringify(said.error));
  const spec = { schedule: "*/15 * * * *", summary: { when: "Every 15 minutes", check: "Is there a new form?", do: "Starts the Flow" } };
  const code = "export default async function watch({ emit }) { emit({ id: 'q-1', title: 'Quill form arrived' }); }\n";
  const wrote = await d.registry.call("watchers.write", { name: "quill-forms", spec, code }, "mcp:agent:scout", { thread: "th-quill", agent: "scout" });
  assert.equal(wrote.error, undefined, JSON.stringify(wrote.error));
  assert.equal(wrote.data.state, "paused");
  const dry = await d.registry.call("watchers.test", { name: "quill-forms" }, "mcp:agent:scout", { thread: "th-quill", agent: "scout" });
  assert.equal(dry.error, undefined, JSON.stringify(dry.error));
  assert.equal(dry.data.turnedOn, true, JSON.stringify(dry.data));
  const row = await until(async () => (await d.kernel.gateway.records.query(admin, "slip", { page: { limit: 20 } })).rows.find((/** @type {any} */ r) => r.data.kind === "from-watcher") || null, "the watcher to start the Flow");
  assert.equal(row.data.body, "Quill form arrived");
  const runs = await host.flows.tools["flows.runs"](host.personChain(), { id: def.data.id });
  assert.equal(runs.length, 1);
  const shown = await host.flows.tools["flows.run"](host.personChain(), { run: runs[0].id });
  assert.equal(shown.run.trigger.kind, "watcher", JSON.stringify(shown.run.trigger));
  void root;
});

test("a step deadline takes the on timeout path and the person is told why", { timeout: 120_000 }, async t => {
  const { d, host, admin, person, call, approve } = await boot(t);
  // The deadline is on a task given to the Space's owner: that person is a member, so the task is opened and waits. An unknown teammate is refused at once and never reaches the deadline.
  const flow = { format: 1, name: "quill_due", label: "Quill due", authorship: "human", trigger: { on: "manual" }, steps: [
    { id: "go", kind: "assign", to: `person:${d.kernel.id.owner}`, title: "Draft the note", label: "the draft", output: { kind: "note" }, await: true, timeout_ms: 2500, on_fail: { then: "continue", steps: [{ id: "late", kind: "create", type: "slip", label: "the late note", set: { body: "the deadline passed", kind: "timeout-path" } }] } },
  ] };
  const def = await call("flows.define", { flow }, "cli", await person());
  assert.equal(def.data && def.data.ok, true, JSON.stringify(def.data || def.error));
  await approve(def.data);
  await host.flows.tools["flows.start"](host.personChain(), { id: def.data.id, input: {} });
  const row = await until(async () => (await d.kernel.gateway.records.query(admin, "slip", { page: { limit: 20 } })).rows.find((/** @type {any} */ r) => r.data.kind === "timeout-path") || null, "the on timeout path to run", 30_000).catch(async e => { const runs = await host.flows.tools["flows.runs"](host.personChain(), { id: def.data.id }); const full = runs[0] ? await host.flows.tools["flows.run"](host.personChain(), { run: runs[0].id }) : null; throw new Error(`${e.message}: ${JSON.stringify(full && full.run ? { state: full.run.state, error: full.run.error, steps: full.run.steps } : runs)}`); });
  assert.equal(row.data.body, "the deadline passed");
  const runs = await host.flows.tools["flows.runs"](host.personChain(), { id: def.data.id });
  const described = await call("flows.describe", { run: runs[0].id }, "cli", await person());
  assert.match(described.data.explain, /The deadline on the draft passed, so the Flow took that step's on timeout path/);
  assert.match(described.data.explain, /It finished/);
});

test("a failed Flow run says why in plain words and Retry runs it again", { timeout: 120_000 }, async t => {
  const { d, person, call, approve } = await boot(t);
  const flow = { format: 1, name: "quill_fail", label: "Quill fail", authorship: "human", trigger: { on: "manual" }, steps: [
    { id: "m", kind: "create", type: "slip", label: "the slip", set: { body: "no", kind: "fail" }, verify: { check: "1 == 2", say: "the slip did not check" }, retry: false },
  ] };
  const def = await call("flows.define", { flow }, "cli", await person());
  assert.equal(def.data && def.data.ok, true, JSON.stringify(def.data || def.error));
  await approve(def.data);
  const started = await call("flows.start", { id: def.data.id, input: {} }, "cli", await person());
  assert.equal(started.error, undefined, JSON.stringify(started.error));
  const failed = await until(async () => { const r = await call("flows.runs", { id: def.data.id }, "cli", await person()); return r.data && r.data[0] && r.data[0].state === "failed" ? r.data[0] : null; }, "the run to fail");
  const described = await call("flows.describe", { run: failed.id }, "cli", await person());
  assert.match(described.data.explain, /It stopped at the slip: the slip did not check\. Retry it, skip that step, or stop the run/);
  assert.equal(canRetry(failed.state), true);
  const page = fs.readFileSync(new URL("../apps/app/screens/flows/RunPage.tsx", import.meta.url), "utf8");
  assert.match(page, /Retry this run/);
  const again = await call("flows.retry", { run: failed.id }, "cli", await person());
  assert.equal(again.error, undefined, JSON.stringify(again.error));
  assert.equal(again.data.ok, true);
  const after = await until(async () => { const r = await call("flows.runs", { id: def.data.id }, "cli", await person()); return r.data && r.data[0] && r.data[0].state === "failed" ? r.data[0] : null; }, "the retried run to fail again");
  const told = await call("flows.describe", { run: after.id }, "cli", await person());
  assert.match(told.data.explain, /Retry it/);
  void d;
});
