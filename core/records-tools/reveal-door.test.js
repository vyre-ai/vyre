import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { CONTACT } from "../../kernel/conformance/suite.js";
import { startSealer } from "../../kernel/seal/client.js";
import { signer } from "../../kernel/seal/testing.js";

// A daemon booted with the kernel on wires the inference door itself (kernel/home.js), so a reveal has the ledger it records what the person was shown in:
// without the door, records.reveal answered "the inference door is not wired" on every home.
test("records.reveal: a daemon with the kernel on has the inference door, and a sealed field is revealed to the person with a valid proof", async t => {
  process.env.VYRE_SEAL_DEV = "1";
  process.env.VYRE_KERNEL_PATH_RULE = "1";
  t.after(() => { delete process.env.VYRE_KERNEL_PATH_RULE; });
  const root = tempHome(t);
  // A real sealing process with an enrolled device key for the owner: the proof is signed by that key over exactly what the person is shown, and the sealing process verifies it.
  const sealer = startSealer({ dir: path.join(root, "seal-test"), timeoutMs: 8000, dev: true, unattested: true });
  t.after(() => sealer.close());
  const d = await start({ root, log: () => {}, kernel: true, kernelSealer: sealer });
  t.after(() => d.stop());
  const ownerChain = d.kernel.chains.fromFacts({ kind: "socket", surface: "cli", uid: process.getuid(), pid: 0, inside_model_process: false, capsule_verified: false });
  const key = signer(d.kernel.id.owner);
  const { token } = await sealer.begin({ chain: ownerChain, person: d.kernel.id.owner, key_id: key.key_id, spki: key.enrolment.spki });
  await sealer.enrol({ chain: ownerChain, person: d.kernel.id.owner, key_id: key.key_id, spki: key.enrolment.spki, signer: key.enrolment.signer, token });
  const { call } = await import("../daemon/client.js");
  fs.writeFileSync(path.join(root, "dev-presence-stand-in"), "");
  t.after(() => fs.rmSync(path.join(root, "dev-presence-stand-in"), { force: true }));
  const def = await call("records.define", { diff: { add_types: [CONTACT] } }, { root, caller: "cli" });
  assert.ok(!def.error, JSON.stringify(def));
  const mk = await call("records.create", { type: "contact", data: { name: "Jane", age: 40 } }, { root, caller: "cli" });
  assert.ok(!mk.error, "create " + JSON.stringify(mk));
  const made = mk.data.record;
  const sealed = await call("records.seal-put", { urn: made.urn, field: "ssn", value: "123-45-6789", class: "us-ssn" }, { root, caller: "cli" });
  assert.ok(!sealed.error, JSON.stringify(sealed));
  // A reveal is shown on a screen, never over the terminal: it comes from the owner's paired app device, which is also where the proof is signed.
  const id = "aaaaaaaaaaaaaaaa";
  d.registry.deps.db.prepare("INSERT OR IGNORE INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, 'phone', 'p', 1, 'app', 0, NULL)").run(id);
  const facts = { kind: "device", device_key_id: id, person: d.kernel.id.owner, path: "relay" };
  const device = d.kernel.chains.fromFacts(facts);
  const ref = sealed.data.record.data.ssn.ref;
  const proof = key.proof(device, "seal.reveal", { ref, purpose: "check" });
  const shown = await d.registry.call("records.reveal", { urn: made.urn, field: "ssn", purpose: "check" }, `device:${id}`, { person: { id: "ps1" }, kernelFacts: { ...facts, session: "ps1" }, kernel_proof: proof });
  assert.ok(!JSON.stringify(shown).includes("not wired"), "reveal: " + JSON.stringify(shown));
  assert.ok(!shown.error, JSON.stringify(shown));
  assert.equal(JSON.stringify(shown.data).includes("123-45-6789"), true, "the person is shown the value");
  const logged = d.kernel.log.read({ type: "field.revealed" });
  assert.equal(logged.length, 1, "a reveal is always in the kernel's log, once");
  assert.ok(!JSON.stringify(logged).includes("123-45-6789"), "and never with the value");
  // The terminal is no screen: the same call over the socket is refused, and shows nothing.
  const cli = await call("records.reveal", { urn: made.urn, field: "ssn", purpose: "check" }, { root, caller: "cli" });
  assert.ok(cli.error && !JSON.stringify(cli).includes("123-45-6789"), JSON.stringify(cli));
  assert.equal(typeof d.kernel.gateway.model, "object", "the gateway has a model door");
});
