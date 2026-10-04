// @ts-check
// Presence over the peer wire: a proof carries `home` and `challenge`, signed with everything else; the sealing process verifies it (once), and `remoteBinding` ties it to this home and this challenge.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startSealer } from "./client.js";
import { signer, person, tmp, enrolDevice } from "./testing.js";
import { remoteBinding } from "../core/presence.js";
import { proofBytes } from "./wire.js";

test("a proof naming this home and this challenge verifies once; another home, another challenge, a tampered field and a replay are refused", async t => {
  const dir = tmp("rp"), s = startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const phone = signer("per_alex", "dk_phone", "software");
  await enrolDevice(s, phone);
  const ch = person("per_alex"), op = "grant.invite", fields = { resource: "vyre://spc_testspace0001/invite/new", input_hash: "h" };
  const HOME = "spc_testspace0001", CHAL = "chal_abc123";
  const good = phone.proof(ch, op, fields, { extra: { home: HOME, challenge: CHAL } });
  assert.equal(remoteBinding(good, { home: HOME, challenge: CHAL }), null);
  assert.equal(await s.presenceCheck({ chain: ch, op, fields, proof: good }), null, "the sealing process accepts it (the extra fields are signed)");
  assert.equal(await s.presenceCheck({ chain: ch, op, fields, proof: good }), "replayed", "a replay is refused");
  // a proof for another home or another challenge: the binding refuses it
  assert.equal(remoteBinding(phone.proof(ch, op, fields, { extra: { home: "spc_otherhome0001", challenge: CHAL } }), { home: HOME, challenge: CHAL }), "wrong_home");
  assert.equal(remoteBinding(phone.proof(ch, op, fields, { extra: { home: HOME, challenge: "chal_other" } }), { home: HOME, challenge: CHAL }), "wrong_challenge");
  assert.equal(remoteBinding({ ...good, challenge: undefined }, { home: HOME, challenge: CHAL }), "wrong_challenge");
  assert.equal(remoteBinding(null, { home: HOME, challenge: CHAL }), "no_proof");
  // changing home after signing breaks the signature (the field is signed): the sealer refuses it
  const forged = { ...phone.proof(ch, op, fields, { extra: { home: "spc_otherhome0001", challenge: CHAL } }), home: HOME };
  assert.equal(await s.presenceCheck({ chain: ch, op, fields, proof: forged }), "bad_signature");
  // another op or other fields: the payload hash does not match
  assert.equal(await s.presenceCheck({ chain: ch, op: "grant.revoke", fields, proof: phone.proof(ch, op, fields, { extra: { home: HOME, challenge: CHAL } }) }), "wrong_decision");
  // the vector file's two remote cases reproduce the signed bytes
  const { vectors } = JSON.parse(fs.readFileSync(new URL("./proofbytes-vectors.json", import.meta.url), "utf8"));
  for (const v of vectors.filter((/** @type {any} */ x) => x.proof.home)) assert.equal(proofBytes(v.proof).toString("utf8"), v.bytes);
});
