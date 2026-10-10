// @ts-check
// The human-step guarantee: a stage gate whose required task a person must do is not skipped by an assistant acting with its owner's authority. flows.advance and flows.settle's advance move a record past
// the gate early; only a person, in their own name, may, and the gate's ledger names who did it. On a REAL vyred. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };
const MATTER = { name: "matter", label: "Matter", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "stage", kind: "stage", label: "Stage", options: ["Review", "Done"] }],
  stages: [{ name: "Review", owner: "role:owner", tasks: [{ title: "Attorney review", doer: "role:owner", output: { kind: "decision" } }] }, { name: "Done" }] };

test("an assistant acting for the owner cannot move a record past a stage gate; the owner can, and the ledger names the person", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const space = d.kernel.id.space, host = d.registry.deps.flowsHost.get(space);
  const asOwner = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(owner, {})).token });
  const asAssistant = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(owner, { agent: "assistant" })).token });
  await d.kernel.gateway.records.define(owner, { add_types: [MATTER] });
  const gates = () => host.stages.entries().filter((/** @type {any} */ e) => !e.advanced);
  const open = async (/** @type {string} */ name) => { await d.kernel.gateway.records.create(owner, "matter", { name, stage: "Review" }); return until(async () => gates().find((/** @type {any} */ e) => e.stage === "Review" && !seen.has(e.run)), `the gate for ${name}`); };
  const seen = new Set();

  const g1 = await open("Rivera"); seen.add(g1.run);
  for (const [tool, input] of [["flows.advance", { run: g1.run, reason: "skip it" }], ["flows.settle", { run: g1.run, action: "advance", reason: "skip it" }]]) {
    const r = await asAssistant(tool, input);
    assert.ok(r.error, `${tool}: an assistant is refused (${JSON.stringify(r.data || r.error)})`);
  }
  assert.ok(gates().some((/** @type {any} */ e) => e.run === g1.run), "the gate is still closed after both attempts");

  const r = await asOwner("flows.advance", { run: g1.run, reason: "reviewed on the phone" });
  assert.ok(!r.error, `the owner, in their own name, can: ${JSON.stringify(r.error)}`);
  assert.equal(gates().some((/** @type {any} */ e) => e.run === g1.run), false, "and the gate is over");
  const gate = (await asOwner("flows.run", { run: g1.run })).data;
  assert.equal(gate.run.steps.move.output.by, d.kernel.id.owner, "the gate's ledger names the person");
  assert.equal(gate.run.steps.move.output.via, undefined, "and no assistant stands between");
  const g2 = await open("Chen"); seen.add(g2.run);
  const s = await asOwner("flows.settle", { run: g2.run, action: "advance", reason: "owner call" });
  assert.ok(!s.error, `settle-advance by the owner works: ${JSON.stringify(s.error)}`);
});
