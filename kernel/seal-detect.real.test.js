// `ctx.kernel.sealDetect` (SD-3) against the REAL sealing process: a first-party module that declares `needs.kernel.sealDetect` asks whether ONE candidate is a sealed field's value, and gets
// yes or no. The kernel's own grants decide which records count; the registry's module name (never the call's) is what the process counts. Stand-in, labelled:
//   SHIM(presence): the kernel's grants acts use the allow-all presence stand-in the other real-process gateway tests use.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createKernel } from "./index.js";
import { canonical, sha256 } from "./core/canonical.js";
import { startSealer } from "./seal/client.js";
import { tmp } from "./seal/testing.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", REC = `vyre://${SPACE}/matter/m_1`;
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
const code = p => p.then(() => null, e => e.code);

async function rig(t) {
  const dir = tmp("sealdetect"), sealer = startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await sealer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), sealer, presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const role = { person: BOB, role: "member" };
  await k.gateway.grants.setRole(owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${BOB}`) });
  await sealer.api.put({ chain: owner, record: REC, field: "ssn", class: "us-ssn", value: "123-45-6789", hint_allowed: false });
  return { k, owner, bob, sealer };
}

test("sealDetect: only for a module that declares it; yes for the sealed value in any written form, no for anything else, and nothing else leaves", async t => {
  const { k, owner, bob } = await rig(t);
  assert.equal(k.kernelFor({ name: "memory", needs: { kernel: { actions: [] } } }).sealDetect, undefined, "not declared, not there");
  const mem = k.kernelFor({ name: "memory", needs: { kernel: { actions: [], sealDetect: true } } });
  assert.equal(typeof mem.sealDetect, "function");
  assert.deepEqual(await mem.sealDetect(owner, "123-45-6789"), { match: true });
  assert.deepEqual(await mem.sealDetect(owner, "123 45 6789"), { match: true }, "folded forms match");
  assert.deepEqual(await mem.sealDetect(owner, "987-65-4321"), { match: false });
  assert.deepEqual(Object.keys(await mem.sealDetect(owner, "123-45-6789")), ["match"], "nothing else leaves");
});

test("sealDetect: only the records the asking person may read count; a short candidate is refused", async t => {
  const { k, bob, owner } = await rig(t);
  const mem = k.kernelFor({ name: "memory", needs: { kernel: { actions: [], sealDetect: true } } });
  // A member who may read the record gets the same answer; a person who is not in the Space reads nothing there, so the same value answers no.
  assert.deepEqual(await mem.sealDetect(bob, "123-45-6789"), { match: true });
  const stranger = k.chains.fromFacts({ kind: "device", device_key_id: "d-s", person: "per_stranger", path: "direct" });
  assert.deepEqual(await mem.sealDetect(stranger, "123-45-6789"), { match: false });
  assert.equal(await code(mem.sealDetect(owner, "12")), "bad_input", "a candidate too short is refused by the process");
});

test("sealDetect: one owner-visible event per answered call, naming the module and the count and never the candidate; the process rate-limits five a minute", async t => {
  const { k, owner } = await rig(t);
  const mem = k.kernelFor({ name: "memory", needs: { kernel: { actions: [], sealDetect: true } } });
  await mem.sealDetect(owner, "123-45-6789");
  await mem.sealDetect(owner, "555-66-7777");
  const ev = k.log.read({ type: "seal.detect" });
  assert.equal(ev.length, 2);
  assert.deepEqual(ev.map(e => e.data), [{ module: "memory", count: 1 }, { module: "memory", count: 2 }]);
  assert.equal(JSON.stringify(ev).includes("6789"), false, "no candidate in the log");
  for (let i = 0; i < 3; i++) await mem.sealDetect(owner, `99${i}-00-1111`);
  assert.equal(await code(mem.sealDetect(owner, "444-55-6666")), "rate_limited");
  // Another module has its own bucket: the count is by the registry's name.
  const rec = k.kernelFor({ name: "recall", needs: { kernel: { actions: [], sealDetect: true } } });
  assert.deepEqual(await rec.sealDetect(owner, "123-45-6789"), { match: true });
  assert.equal(k.log.read({ type: "seal.detect" }).pop().data.module, "recall");
});
