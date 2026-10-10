// @ts-check
// A Flow's call step runs a registered tool its module offered as a Flow step (`flow.steps`), in a REAL vyred (kernel on): a read tool runs at once as the Flow's person; an outward tool is
// held for the person's yes (a step marked approve: true, or any outward one the turn-on yes does not cover) and then goes out exactly once, with that approval spent at the call. Not rigs: the daemon builds the Flows host, the runner and the call port.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present, writeModule } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const canonical = (/** @type {any} */ x) => JSON.stringify(x, Object.keys(x).sort());
const signedPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };

const MANIFEST = { version: "0.1.0", does: { tools: [
  { name: "zzflow.lookup", effect: "read", reach: "anyone" },
  { name: "zzflow.notify", reach: "anyone", outward: true },
  { name: "zzflow.plain", effect: "read", reach: "anyone" },
] }, flow: { steps: [
  { name: "zzflow.lookup", label: "Look up a client", inputs: { q: "string" }, outputs: { found: "string" } },
  { name: "zzflow.notify", label: "Notify the client", outward: true },
], triggers: [{ name: "zzflow.arrived", label: "A client arrives", event: "zzflow.arrived", inputs: { who: "string" } }] }, watches: { emits: ["zzflow.arrived"] } };
const SRC = `export default { async start(ctx) {
  const rec = (tool, meta, input) => { (globalThis.__zzflow ||= []).push({ tool, caller: meta.caller, origin: meta.origin, token: typeof meta.token === "string", input }); };
  ctx.tool("zzflow.lookup", { effect: "read", input: { type: "object" }, run: async (i, meta) => { rec("lookup", meta, i); return { found: "Acme", asked: i.q }; } });
  ctx.tool("zzflow.notify", { input: { type: "object" }, run: async (i, meta) => { rec("notify", meta, i); return { sent: true }; } });
  ctx.tool("zzflow.plain", { effect: "read", input: { type: "object" }, run: async (i, meta) => { rec("plain", meta, i); return {}; } });
  return {};
} };`;

async function boot(/** @type {import("node:test").TestContext} */ t) {
  const root = tempHome(t);
  const mods = path.join(root, "modules");
  writeModule(mods, "zzflow", MANIFEST, SRC);
  globalThis.__zzflow = [];
  t.after(() => { delete globalThis.__zzflow; });
  const lines = /** @type {string[]} */ ([]);
  const d = await start({ root, presence: present, log: (/** @type {string} */ m) => { lines.push(String(m)); }, kernel: true, kernelPresence: signedPresence(), firstPartyRoots: [mods] });
  t.after(() => d.stop());
  const space = d.kernel.id.space;
  const host = d.registry.deps.flowsHost.get(space);
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(admin, {})).token });
  const install = async (/** @type {any} */ flow) => {
    const r = await d.registry.call("flows.define", { flow }, "cli", await meta());
    assert.ok(r.data && r.data.ok, JSON.stringify(r));
    await host.flows.tools["flows.approve"](host.personChain(), { id: r.data.id, version: r.data.version, hash: r.data.hash });
    return r.data;
  };
  const calls = () => /** @type {any[]} */ (globalThis.__zzflow);
  return { d, host, admin, space, install, calls, lines };
}
const flowOf = (/** @type {string} */ space, /** @type {string} */ action, /** @type {any} */ input) => ({ format: 1, name: `step_${action.split(".")[1]}`, label: `Run ${action}`, authorship: "human", trigger: { on: "manual" },
  steps: [{ id: "c", kind: "call", action, resource: `vyre://${space}/tool/${action}`, input }] });

test("the module offers a tool as a Flow step only by listing it in flow.steps: the registry lists exactly those", { timeout: 120_000 }, async t => {
  const { d } = await boot(t);
  assert.deepEqual(d.registry.flowTools().filter((/** @type {any} */ x) => x.name.startsWith("zzflow.")).map((/** @type {any} */ x) => [x.name, x.risk]).sort(), [["zzflow.lookup", "read"], ["zzflow.notify", "outward"]]);
});

test("a module's flow.triggers are listed by the registry as the event or watcher trigger they compile to", { timeout: 120_000 }, async t => {
  const { d } = await boot(t);
  assert.deepEqual(d.registry.flowTriggers().filter((/** @type {any} */ x) => x.name.startsWith("zzflow.")), [{ name: "zzflow.arrived", label: "A client arrives", trigger: { on: "event", event: "zzflow.arrived" }, inputs: { who: "string" } }]);
});

test("a read tool runs at once as the Flow's person; a tool not listed in flow.steps is refused", { timeout: 120_000 }, async t => {
  const { host, install, calls, space } = await boot(t);
  const flow = await install(flowOf(space, "zzflow.lookup", { q: "Acme" }));
  await host.flows.tools["flows.start"](host.personChain(), { id: flow.id, input: {} });
  await until(async () => calls().find(c => c.tool === "lookup"), "the read tool to run");
  const c = calls().find(x => x.tool === "lookup");
  assert.deepEqual([c.caller, c.token, c.input.q], ["module:flows", true, "Acme"], "it ran for the Flow, with the person's session, and its input");
  assert.equal(calls().filter(x => x.tool === "lookup").length, 1, "once");
  // a registered tool its module did not list as a step cannot be named by a Flow
  const bad = await install(flowOf(space, "zzflow.plain", {})).catch(e => e);
  await host.flows.tools["flows.start"](host.personChain(), { id: bad.id, input: {} }).catch(() => null);
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(calls().filter(x => x.tool === "plain").length, 0, "a tool not listed in flow.steps never runs from a Flow");
});

test("an outward tool is held for the person's yes, then goes out exactly once", { timeout: 120_000 }, async t => {
  const { d, host, admin, install, calls, space, lines } = await boot(t);
  const gw = d.kernel.gateway;
  const flow = await install({ ...flowOf(space, "zzflow.notify", { to: "sam@example.com", body: "hello" }), steps: [{ id: "c", kind: "call", action: "zzflow.notify", resource: `vyre://${space}/tool/zzflow.notify`, input: { to: "sam@example.com", body: "hello" }, approve: true }] });
  await host.flows.tools["flows.start"](host.personChain(), { id: flow.id, input: {} });
  const task = await until(async () => (await gw.ask.list(admin, {})).find((/** @type {any} */ x) => /Run zzflow.notify|zzflow/.test(x.title)), "the held card");
  await new Promise(r => setTimeout(r, 800));
  assert.equal(calls().filter(x => x.tool === "notify").length, 0, "nothing goes out before the yes");
  const row = await gw.ask.get(admin, task.id);
  await gw.ask.decide(admin, task.id, { outcome: "approved", proof: { op: "task.decide", fields: { task: task.id, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: Math.random() } });
  await until(async () => calls().find(c => c.tool === "notify"), "the approved tool to run").catch(async e => { const runs = await host.flows.tools["flows.runs"](host.personChain(), { id: flow.id }).catch((/** @type {any} */ x) => String(x)); throw new Error(`${e.message}: runs ${JSON.stringify(runs).slice(0, 900)} log ${lines.slice(-12).join(" | ").slice(0, 900)}`); });
  await new Promise(r => setTimeout(r, 1000));
  const sent = calls().filter(x => x.tool === "notify");
  assert.equal(sent.length, 1, "exactly once");
  assert.deepEqual([sent[0].input.to, sent[0].input.body, sent[0].caller], ["sam@example.com", "hello", "module:flows"]);
});
