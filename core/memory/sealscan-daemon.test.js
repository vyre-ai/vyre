// memory.sealscan with the ledger on a REAL daemon, a real kernel and the REAL sealing process (SD-3). A value sealed in a record that has no class shape (a medical record number) is found in
// memory's held text by the sealing process's yes or no and reported by table and column only. Run it on a test box, never on a person's Mac. Stand-in, labelled:
//   SHIM(person chain): the owner's chain is the daemon's own `callerFacts` for the `cli` surface (a person's terminal), the same chain a real CLI call gets.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { start, callerFacts } from "../daemon/index.js";
import { startSealer } from "../../kernel/seal/client.js";
import { tmp } from "../../kernel/seal/testing.js";
import { tempHome } from "../../test/helpers.js";

test("memory.sealscan {ledger:true} on a real daemon: a sealed value with no class shape is found by the sealing process, counts only, and the ledger answers are logged without the candidate", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const dir = tmp("scanseal"), sealer = startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await sealer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelSealer: sealer });
  t.after(() => d.stop());
  const facts = callerFacts("cli", {}, {}, d.kernel, false, null, { inside: false });
  const owner = d.kernel.chains.fromFacts(facts);
  await sealer.api.put({ chain: owner, record: `vyre://${d.kernel.id.space}/patient/p_1`, field: "mrn", class: "medical", value: "MRN-5589120", hint_allowed: false });
  const call = (input, caller = "cli", tool = "memory.sealscan") => d.registry.call(tool, input, caller, { ...(callerFacts(caller, {}, {}, d.kernel, false, null, { inside: false }) ? { kernelFacts: callerFacts(caller, {}, {}, d.kernel, false, null, { inside: false }) } : {}) });
  const w = await call({ project: "you", kind: "note", text: "Chart note: MRN-5589120 came in with a referral; their order 7788990 shipped" }, "cli", "memory.write");
  assert.ok(!w.error, JSON.stringify(w.error));
  const shape = await call({}); 
  assert.ok(!shape.error, JSON.stringify(shape.error));
  assert.equal(shape.data.ledger, undefined, "no ledger unless asked");
  const r = await call({ ledger: true, max: 10 });
  assert.ok(!r.error, JSON.stringify(r.error));
  assert.equal(r.data.ledger.available, true, JSON.stringify(r.data));
  assert.deepEqual(r.data.ledger.matched, [{ table: "memory_writes", column: "text", rows: 1 }], JSON.stringify(r.data.ledger));
  assert.ok(r.data.ledger.calls >= 1 && r.data.ledger.calls <= 2);
  assert.equal(JSON.stringify(r.data).includes("5589120"), false, "no value in the answer");
  assert.equal(JSON.stringify(d.kernel.log.read({ type: "seal.detect" })).includes("5589120"), false, "no candidate in the log");
  assert.ok(d.kernel.log.read({ type: "seal.detect" }).every(e => e.data.module === "memory"));
});
