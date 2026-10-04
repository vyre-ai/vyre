// reviewer-2 repro TR-1 against work/kernel-reg c2477b47a (drop into test/): the needs-check event now logs the doer's `evidence` for fields, decision and note tasks; nothing screens it, and the log cannot be edited.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRig } from "./kernel-rig.js";

const MATTER = { name: "matter", label: "Matter", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "notes", kind: "text", label: "Notes" }] };
test("TR-1: an SSN-shaped value in a decision task's evidence (the same holds for fields and note) must not reach the sealed log in the clear", async () => {
  const rig = await createRig({ people: { per_bob: "member" }, agents: ["juno"], defs: [MATTER] });
  const rec = await rig.create("matter", { name: "Jane", notes: "x" });
  const alex = rig.ownerChain;
  const ssn = "123-45-6789";
  const t = await rig.kernel.ask.request(alex, { title: "fill notes", record: rec.urn, doer: { kind: "person", id: "per_alex", space: rig.space }, checker: { kind: "person", id: "per_bob", space: rig.space }, output: { kind: "decision" } });
  await rig.kernel.ask.start(alex, t.id);
  let how = "completed";
  try { await rig.kernel.ask.complete(alex, t.id, { answer: "yes", reason: "the client gave me her ssn " + ssn + " so proceed" }); } catch (e) { how = "refused:" + (e.code || e.message); }
  const evs = await rig.kernel.events.read(rig.ownerChain, { type: "task.*" });
  const hit = evs.filter(e => JSON.stringify(e).includes(ssn)).map(e => e.type);
  console.log("TR-1", how, "events holding the SSN:", JSON.stringify(hit));
  assert.deepEqual(hit, [], "task evidence reached the log unscreened");
});
