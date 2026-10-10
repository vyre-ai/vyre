// @ts-check
// What Flows leave behind reads as words: after a run with lanes, a sub-flow, an ask, a task for a person and a failure, no record, task or logged event of the Space holds "[object Object]" or the text
// "undefined" where a value should be. (A task once carried flow: "[object Object]".) A real daemon; a test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const NOTE = { name: "filing-note", label: "Filing note", fields: [{ name: "body", kind: "text", label: "Body" }] };
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 40_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };
const BAD = /\[object Object\]|"undefined"|:undefined\b|\bNaN\b/;

test("what Flows leave in records, tasks and the log holds no [object Object] and no 'undefined'", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const space = d.kernel.id.space, owner = d.kernel.id.owner;
  const host = d.registry.deps.flowsHost.get(space);
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => (await d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(admin, {})).token })).data;
  await d.kernel.gateway.records.define(admin, { add_types: [NOTE] });
  const install = async (/** @type {any} */ flow) => { const r = await call("flows.define", { flow }); assert.ok(r && r.ok, JSON.stringify(r)); await host.flows.tools["flows.approve"](host.personChain(), { id: r.id, version: r.version, hash: r.hash }); return r; };
  await install({ format: 1, name: "inner", label: "Inner", authorship: "human", trigger: { on: "manual" }, returns: { body: { expr: "steps.c.record.data.body" } }, steps: [{ id: "c", kind: "create", type: "filing-note", set: { body: "inner" } }] });
  const outer = await install({ format: 1, name: "outer", label: "Outer", authorship: "human", trigger: { on: "manual" }, steps: [
    { id: "p", kind: "parallel", steps: [
      { id: "a", kind: "branch", steps: [{ id: "look", kind: "assign", to: `person:${owner}`, title: "Look it over", output: { kind: "decision" }, how: "person", await: true }] },
      { id: "b", kind: "branch", steps: [{ id: "s", kind: "subflow", flow: "inner" }] },
      { id: "c", kind: "branch", steps: [{ id: "q", kind: "ask", to: "role:nobody_holds_this", title: "Anyone?" }] },
    ] },
  ] });
  const started = await host.flows.tools["flows.start"](host.personChain(), { id: outer.id, input: {} });
  await until(async () => ((await call("flows.runs", { id: outer.id })) || []).some((/** @type {any} */ r) => r.state === "failed"), "the run to fail on its third lane");

  const found = /** @type {string[]} */ ([]);
  const scan = (/** @type {string} */ what, /** @type {any} */ v) => { const s = JSON.stringify(v); const m = BAD.exec(s); if (m) found.push(`${what}: ...${s.slice(Math.max(0, m.index - 60), m.index + 40)}...`); };
  for (const type of ["flow-run", "def-flow", "flow-state", "flow-approval", "filing-note"]) scan(`records ${type}`, (await d.kernel.gateway.records.query(admin, type, { page: { limit: 100 } })).rows);
  scan("tasks", await d.kernel.gateway.ask.list(admin, {}));
  scan("runs", await call("flows.runs", { id: outer.id }));
  scan("health", await call("flows.health", { id: outer.id }));
  const runId = String(started.run || started.id);
  scan("run page", await call("flows.run", { run: runId }));
  scan("canvas", await call("flows.graph", { id: outer.id }));
  scan("card", await call("flows.card", { id: outer.id, version: 1 }));
  scan("explain", await call("flows.timeline", { run: runId }));
  scan("practice", await call("flows.simulate", { id: outer.id, since: Date.now() - 60_000, until: Date.now() + 60_000 }));
  scan("timeline", (await call("work.timeline", { record: `vyre://${space}/flow-run/${runId}` })) || {});
  scan("log", d.kernel.log.read({}).map((/** @type {any} */ e) => ({ type: e.type, subject: e.subject, data: e.data })));
  assert.deepEqual(found, [], "a value reads as words");
});

test("the Vault can ask which Flows name a credential and read every stored definition (module-only reads)", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const host = d.registry.deps.flowsHost.get(d.kernel.id.space);
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input, caller = "cli") => d.registry.call(tool, input, caller, { token: (await d.kernel.surfaces.open(admin, {})).token });
  const r = (await call("flows.define", { flow: { format: 1, name: "uses_key", label: "Uses a key", authorship: "human", trigger: { on: "manual" }, steps: [{ id: "w", kind: "wait", for_ms: 1000 }, { id: "n", kind: "create", type: "contact", set: { name: "vault://deepgram" } }] } })).data;
  void host;
  assert.equal(r && r.ok, true, JSON.stringify(r));
  const uses = await call("flows.credential-uses", { name: "deepgram" }, "module:vault");
  assert.ok(!uses.error, JSON.stringify(uses.error));
  assert.ok(uses.data && uses.data.uses.length, JSON.stringify([uses, (await call("flows.definitions.scan", {}, "module:vault")).data]).slice(0, 600));
  assert.deepEqual((uses.data && uses.data.uses || []).map((/** @type {any} */ u) => u.name), ["Uses a key"]);
  assert.deepEqual((await call("flows.credential-uses", { name: "other" }, "module:vault")).data.uses, []);
  const scan = await call("flows.definitions.scan", {}, "module:vault");
  assert.equal(scan.data.definitions.length, 1);
  assert.match(scan.data.definitions[0].json, /vault:\/\/deepgram/);
  assert.ok((await call("flows.credential-uses", { name: "deepgram" }, "cli")).error, "a person's surface is not a module: refused");
});
