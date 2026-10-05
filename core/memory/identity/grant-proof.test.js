// @ts-check
// The person's one yes for `memory.identity.unlock`, checked by the REAL sealing process (nothing stubbed but the phone's key, which is a signer): the proof is signed over signOf("vault", { op, fields: { identity, server } })
// in the person's kernel chain, so the Space id inside the signed payload is the chain's own Space (the Space this kernel hosts), and the request must carry that chain.
import "../../../scripts/mac-test-guard.mjs";
import fs from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSealer } from "../../../kernel/seal/client.js";
import { sealerPresence } from "../../../kernel/core/presence.js";
import { signer, enrolDevice, person, tmp, SPACE } from "../../../kernel/seal/testing.js";
import { yes, signOf, configureYes } from "../../../lib/one-yes.js";

process.env.VYRE_SEAL_DEV = "1";

test("a real signed proof for memory.identity.unlock stands for the person's chain, and not without the chain, for another Space, or for another server", async t => {
  const dir = tmp("grant-proof"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sealer = startSealer({ dir, dev: true, unattested: true });
  t.after(() => sealer.close());
  const sg = signer("per_alex");
  const enrolled = await enrolDevice(sealer, sg);
  assert.ok(enrolled && !enrolled.refused, JSON.stringify(enrolled));
  const presence = sealerPresence(sealer);
  // exactly the daemon's wiring (core/daemon/index.js): the sealing process is asked over the act word and fields signOf gives the request
  configureYes({ softwareOk: () => false, verify: async i => { const s = signOf(i.moment, { op: i.request ? i.request.op : i.op, fields: i.request ? i.request.fields : i.fields }); return presence.check({ ...(i.chain ? { chain: i.chain } : {}), op: s.op, fields: s.fields, proof: i.proof }); } });
  t.after(() => configureYes({ verify: null }));
  const chain = person("per_alex", "deck", SPACE);
  const request = { op: "memory.identity.unlock", fields: { identity: "ident_alex", server: "srvfp0123456789ab" } };
  const sign = (ch, req = request) => { const s = signOf("vault", req); return sg.proof(ch, s.op, s.fields); };

  assert.equal(signOf("vault", request).op, "task.vault_use");
  // no chain on the request (what memory.identity.grant sent before it carried one): the sealing process refuses it
  assert.deepEqual(await yes("vault", request, sign(chain)), { ok: false, reason: "no_proof" });
  // the proof was spent by that refusal or not, a new one for the same request with the chain stands
  const ok = await yes("vault", { ...request, chain }, sign(chain));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // the same proof does not stand twice
  const p = sign(chain);
  assert.equal((await yes("vault", { ...request, chain }, p)).ok, true);
  assert.equal((await yes("vault", { ...request, chain }, p)).ok, false, "a proof is used up");
  // signed in another Space (the phone put the wrong Space id in the payload): not this chain's payload
  const other = person("per_alex", "deck", "spc_otherspace01");
  assert.deepEqual(await yes("vault", { ...request, chain }, sign(other)), { ok: false, reason: "wrong_request" });
  // a proof for another server's fingerprint or another identity is not a yes for this one
  const forB = sign(chain, { op: request.op, fields: { identity: "ident_alex", server: "srvfpOTHER000000" } });
  assert.deepEqual(await yes("vault", { ...request, chain }, forB), { ok: false, reason: "wrong_request" });
});
