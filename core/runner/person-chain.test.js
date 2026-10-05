// @ts-check
// The runner's start, stop, lock and move are the person's, and the person comes only from the kernel chain: a label never grants (kernel on).
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import mod from "./index.js";
import { fakeSpace } from "./testing/fake-space.js";
import { seams } from "./index.js";

const person = id => ({ hops: [{ actor: { kind: "person", id } }] });
const TOOLS = [["runner.stop", { space: "harlow", session: "s1" }], ["runner.lock", { space: "harlow" }], ["runner.move", { space: "harlow", session: "s1" }], ["runner.start", { space: "harlow", session: "s1" }]];

/** Starts the module against a stub context whose kernel answers `chainFor(meta)`. */
async function boot(t, chainFor, kernelExtra = {}) {
  const sp = fakeSpace();
  const root = `/tmp/runner-person-${process.pid}-${Math.random().toString(36).slice(2)}`;
  seams.set(root, { ports: { device: "dev_kit", vault: sp.vault, sync: sp.sync, grants: () => ({ spaceAllows: true, memberAccepts: true }), spec: async () => null } });
  t.after(() => seams.delete(root));
  /** @type {Map<string, any>} */ const tools = new Map();
  const ctx = { paths: { root }, events: { emit() {}, on: () => () => {} }, tool: (name, def) => tools.set(name, def), kernel: chainFor ? { owner: "per_a", ...kernelExtra, chain: async meta => chainFor(meta) } : undefined };
  const h = await mod.start(ctx);
  t.after(() => h.stop());
  return (tool, meta) => tools.get(tool).run(TOOLS.find(x => x[0] === tool)[1], meta);
}

test("kernel on: a web, setup or unknown device or tailnet label gets no chain and is refused for every tool", async t => {
  const call = await boot(t, () => null);
  for (const caller of ["web", "setup", "device:unknown", "device:okox2y4m54nuo3e2", "cli", "deck", ""]) for (const [tool] of TOOLS)
    await assert.rejects(call(tool, { caller }), e => e.code === "denied", `${tool} refused for label "${caller}"`);
});

test("kernel on: a chain with an agent, a service or a viewer hop is refused, and a thrown chain is a refusal", async t => {
  for (const chain of [{ hops: [{ actor: { kind: "person", id: "per_a" } }, { actor: { kind: "agent", id: "kit" } }] }, { hops: [{ actor: { kind: "service", id: "x" } }] }, { hops: [] }, { ...person("per_a"), viewer: true }]) {
    const call = await boot(t, () => chain);
    for (const [tool] of TOOLS) await assert.rejects(call(tool, { caller: "cli" }), e => e.code === "denied");
  }
  const call = await boot(t, () => { throw new Error("no chain"); });
  await assert.rejects(call("runner.lock", { caller: "cli" }), e => e.code === "denied");
});

test("kernel on: the person's own chain passes the person check whatever the label says", async t => {
  const call = await boot(t, () => person("per_a"));
  for (const caller of ["cli", "device:whatever"]) {
    const r = await call("runner.lock", { caller }).then(() => "ok", e => e);
    assert.ok(r === "ok" || r.code !== "denied", `lock is not refused for the person's chain (label "${caller}")`);
  }
});

test("kernel off (legacy labels): the old refusal of agents, modules and guests still holds", async t => {
  const call = await boot(t, null);
  for (const caller of ["cli:agent:kit", "module:rogue", "device:2oivbsc3tddw4erj"]) await assert.rejects(call("runner.lock", { caller }), e => e.code === "denied");
});

test("RN-2: another member's person chain is not this computer's person: refused for every tool, the owner's passes", async t => {
  const call = await boot(t, () => person("per_bob"));
  for (const [tool] of TOOLS) await assert.rejects(call(tool, { caller: "cli" }), e => e.code === "denied", `${tool} refused for a second member`);
  const noOwner = await boot(t, () => person("per_a"), { owner: undefined });
  await assert.rejects(noOwner("runner.lock", { caller: "cli" }), e => e.code === "denied", "an unknown owner is a refusal");
});

test("walk step 11: a kernel whose runner ports cannot be built yet (the host gave no device) does not stop the module from loading; status says it is not connected", async t => {
  const sp = fakeSpace();
  const root = `/tmp/runner-walk-${process.pid}-${Math.random().toString(36).slice(2)}`;
  /** @type {Map<string, any>} */ const tools = new Map();
  const ctx = { paths: { root }, events: { emit() {}, on: () => () => {} }, tool: (name, def) => tools.set(name, def), kernel: { runnerPorts: o => o.deviceId() } };
  const h = await mod.start(ctx); t.after(() => h.stop());
  const st = await tools.get("runner.status").run({}, {});
  assert.equal(st.ready, false);
  assert.match(st.why, /not connected|installed|blocks|missing/);
  void sp;
});
