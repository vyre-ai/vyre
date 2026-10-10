// @ts-check
// A person using Flows while the Space's record store is still starting (a Twenty box, minutes after an update or a first start) gets plain words, never a raw store error ("no type flow-state", a refused
// write). The Flows tools wait a bounded while for the host to make its record types, then say Flows is still starting. A real daemon whose store cannot start. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("Flows tools on a Space whose store is still starting say so in words, after a short wait", { timeout: 200_000 }, async t => {
  process.env.VYRE_STORE = "twenty";   // no room for a Twenty here, so the Space's store stays away
  t.after(() => { delete process.env.VYRE_STORE; });
  const d = await start({ root: tempHome(t), presence: present, log: () => {}, kernel: true, flowsTypesWaitMs: 300 });
  t.after(() => d.stop());
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(admin, {})).token });
  for (const [tool, input] of [["flows.list", {}], ["flows.define", { flow: { format: 1, name: "x", label: "X", authorship: "human", trigger: { on: "manual" }, steps: [] } }], ["flows.runs", { id: "fl_none" }]]) {
    const t0 = Date.now();
    const r = await call(String(tool), input);
    assert.equal(r.error?.code, "unavailable", `${tool}: ${JSON.stringify(r.error || r.data).slice(0, 200)}`);
    assert.match(r.error?.message || "", /Flows is still starting.*Try again in a minute/, `${tool} says so in words`);
    assert.ok(Date.now() - t0 < 5_000, `${tool} waited only the short cap`);
  }
});

test("when the host cannot make its record types, the tools say so in words, not with a raw store error", { timeout: 120_000 }, async t => {
  const d = await start({ root: tempHome(t), presence: present, log: () => {}, kernel: true, flowsSetupTypes: async () => { throw new Error("the disk is full"); } });
  t.after(() => d.stop());
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const r = await d.registry.call("flows.list", {}, "cli", { token: (await d.kernel.surfaces.open(admin, {})).token });
  assert.equal(r.error?.code, "unavailable");
  assert.match(r.error?.message || "", /Flows could not set up its records: the disk is full\. vyre modules shows the state\./);
});
