// @ts-check
// Flows in a REAL vyred (kernel on): not a rig. A Flow is written through the `flows` module's tool, approved, run by a record event and by a schedule, and still there after a restart,
// with its trigger in the run record.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const CONTACT = { name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "status", kind: "text", label: "Status" }] };
const until = async (/** @type {() => Promise<any>} */ f, what, ms = 15_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 100)); } };

test("Flows run in a real daemon: an event trigger and a schedule, approved by a person, with their trigger in the run record, and both survive a restart", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const logs = /** @type {string[]} */ ([]);
  let d = await start({ root, log: m => logs.push(String(m)), kernel: true });
  const space = d.kernel.id.space;
  const host = () => d.registry.deps.flowsHost.get(space);
  assert.ok(host(), "the Flows assembly is built for the home's own Space");
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  await d.kernel.gateway.records.define(admin, { add_types: [CONTACT] });

  // The Flow tools are the `flows` module's, run under the caller's own chain; a caller with no chain is refused
  const onEvent = { format: 1, name: "mark_seen", label: "Mark a new contact seen", authorship: "human", trigger: { on: "event", event: "contact.created" },
    steps: [{ id: "u", kind: "update", type: "contact", record: { expr: "event.subject" }, set: { status: "seen" } }] };
  const nightly = { format: 1, name: "tick_jane", label: "Mark Jane every minute", authorship: "human", trigger: { on: "time", cron: "* * * * *" },
    steps: [{ id: "f", kind: "find", type: "contact", where: "record.name == \"Jane\"", limit: 1 }, { id: "p", kind: "pick", type: "contact", where: "record.name == \"Jane\"" },
      { id: "u", kind: "update", type: "contact", record: { expr: "steps.p.record.id" }, set: { status: "scheduled" } }] };
  const refused = await d.registry.call("flows.define", { flow: onEvent }, "mcp");
  assert.ok(refused.error, "an unnamed model has no chain to define under");
  const ra = await d.registry.call("flows.define", { flow: onEvent }, "cli"), rb = await d.registry.call("flows.define", { flow: nightly }, "cli");
  const a = ra.data, b = rb.data;
  assert.ok(a && a.ok, JSON.stringify(ra));
  assert.ok(b && b.ok, JSON.stringify(rb));
  // approving is a person's own and asks for the person's proof: the tool refuses an unproven call
  const noProof = await d.registry.call("flows.approve", { id: a.id, version: a.version, hash: a.hash }, "cli");
  assert.ok(noProof.error, "approval needs the person's proof");
  // (the proof itself is the kernel's one verifier; here the person's own chain approves through the assembly)
  for (const x of [a, b]) await host().flows.tools["flows.approve"](host().personChain(), { id: x.id, version: x.version, hash: x.hash });

  // an event trigger: a new contact is marked
  const jane = await d.kernel.gateway.records.create(admin, "contact", { name: "Jane" });
  const dump = async () => JSON.stringify({ runs: (await d.registry.call("flows.runs", { id: a.id }, "cli")).data, logs: logs.filter(m => /flows|stages/.test(m)).slice(-6) });
  const seen = await until(async () => { const r = await d.kernel.gateway.records.get(admin, "contact", jane.id); return r && r.data.status === "seen" ? r : null; }, "the event Flow to mark the contact").catch(async e => { throw new Error(`${e.message}: ${await dump()}`); });
  assert.equal(seen.data.status, "seen");
  const runs = (await d.registry.call("flows.runs", { id: a.id }, "cli")).data;
  assert.equal(runs.length, 1);
  const run = (await d.registry.call("flows.run", { run: runs[0].id }, "cli")).data.run;
  assert.equal(run.trigger.kind, "event", "the run record names its trigger");
  assert.equal(run.state, "done");

  // a schedule: due now (its last run was two minutes ago), the tick runs it once and the run names it
  await host().flows.store.putSchedule(b.id, Date.now() - 120_000);
  await host().flows.tick();
  const sched = await until(async () => { const r = (await d.registry.call("flows.runs", { id: b.id }, "cli")).data; return r.length ? r : null; }, "the scheduled run");
  const srun = (await d.registry.call("flows.run", { run: sched[0].id }, "cli")).data.run;
  assert.equal(srun.trigger.kind, "time");
  assert.match(String(srun.trigger.source), /^schedule:/, "the run record names the schedule that started it");
  assert.equal(srun.state, "done", JSON.stringify(srun.error));
  assert.equal((await d.kernel.gateway.records.get(admin, "contact", jane.id)).data.status, "scheduled");

  // a restart keeps the Flows, their approval and their history, and the event Flow still fires
  await d.stop();
  d = await start({ root, log: () => {}, kernel: true });
  const listed = (await d.registry.call("flows.list", {}, "cli")).data;
  assert.equal(listed.length, 2, JSON.stringify(listed));
  assert.equal((await d.registry.call("flows.runs", { id: a.id }, "cli")).data.length, 1, "the run history survived");
  const admin2 = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const sam = await d.kernel.gateway.records.create(admin2, "contact", { name: "Sam" });
  await until(async () => { const r = await d.kernel.gateway.records.get(admin2, "contact", sam.id); return r && r.data.status === "seen" ? r : null; }, "the event Flow after the restart");
  await d.stop();
});

test("Flows run in a hosted FIRM Space too: its own kernel, its own Flow records, its own owner: not only the home's personal Space", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const ownerId = "per_" + "abcdefghijklmnopqrstuvwxyz";
  const firm = await d.kernel.spaces.host({ owner: ownerId, name: "Harlow Legal" });
  const space = firm.space;
  const host = d.registry.deps.flowsHost.get(space);
  assert.ok(host, "the Flows assembly is built for the hosted Space");
  assert.notEqual(space, d.kernel.id.space);
  const admin = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-h", person: ownerId, path: "direct", session: "s" });
  await firm.gateway.records.define(admin, { add_types: [CONTACT] });
  const flow = { format: 1, name: "mark_seen", label: "Mark a new contact seen", authorship: "human", trigger: { on: "event", event: "contact.created" },
    steps: [{ id: "u", kind: "update", type: "contact", record: { expr: "event.subject" }, set: { status: "seen" } }] };
  const def = await d.registry.call("flows.define", { space, flow }, "cli");
  assert.ok(def.data && def.data.ok, JSON.stringify(def));
  await host.flows.tools["flows.approve"](host.personChain(), { id: def.data.id, version: def.data.version, hash: def.data.hash });
  const jane = await firm.gateway.records.create(admin, "contact", { name: "Jane" });
  await until(async () => { const r = await firm.gateway.records.get(admin, "contact", jane.id); return r && r.data.status === "seen" ? r : null; }, "the firm's Flow to mark the contact");
  // the home's own Space does not see the firm's Flow
  assert.deepEqual((await d.registry.call("flows.list", {}, "cli")).data, []);
  assert.equal((await d.registry.call("flows.list", { space }, "cli")).data.length, 1);
  assert.ok((await d.registry.call("flows.list", { space: "spc_zzzzzzzzzzzz" }, "cli")).error, "a Space this home does not host");
});
