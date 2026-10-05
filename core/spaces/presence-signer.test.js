import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { SCRATCH } from "../../test/scratch.mjs";
import { softwareProof, softwareActProof, challengeProblem, softwareKey } from "./presence-signer.js";
import { proofRequest } from "../../kernel/remote/proof.js";
import { payloadHash } from "../../kernel/core/presence.js";

const SPACE = "spc_aaaaaaaaaaaa", PERSON = "per_" + "a".repeat(26);
const file = () => path.join(fs.mkdtempSync(path.join(SCRATCH, "ps-")), "key.json");
const challengeFor = (body, over = {}) => { const r = proofRequest(SPACE, "inviteCreate", body); return { call: "grants.invites.create", space: SPACE, home: SPACE, nonce: "n".repeat(22), op: r.op, fields: r.fields, payload_hash: r.payload_hash, ...over }; };

test("WN-1: the signer recomputes the hash and refuses a challenge whose hash is not the one its op, space and fields make, or that is not for the request this device made", () => {
  const f = file();
  const mine = { role: "member" };
  const expect = proofRequest(SPACE, "inviteCreate", mine);
  const good = challengeFor(mine);
  const p = softwareProof(f, PERSON, good, undefined, expect);
  assert.ok(p && p.payload_hash === payloadHash(good.op, SPACE, good.fields), "it signs the hash it worked out");
  // a handed hash that does not match the fields: not signed, however it is dressed
  assert.equal(softwareProof(f, PERSON, challengeFor(mine, { payload_hash: "x".repeat(43) }), undefined, expect), null);
  assert.equal(challengeProblem(challengeFor(mine, { payload_hash: "x".repeat(43) }), expect), "hash_mismatch");
  // a challenge with its own consistent hash, but for another act (an invite with another role, or a different op): refused, because it is not what this device asked
  const other = challengeFor({ role: "owner" });
  assert.equal(challengeProblem(other, expect), "not_this_request");
  assert.equal(softwareProof(f, PERSON, other, undefined, expect), null);
  const role = proofRequest(SPACE, "setRole", { person: PERSON, role: "admin" });
  assert.equal(softwareProof(f, PERSON, { ...good, op: role.op, fields: role.fields, payload_hash: role.payload_hash }, undefined, expect), null, "a home asking for another act gets no signature");
  assert.equal(challengeProblem({ op: "x" }, expect), "no_challenge");
  // the accept proof is made the same way: from the request's fields, and refused when the hash it carries is not theirs
  assert.ok(softwareActProof(f, PERSON, { op: expect.op, space: SPACE, fields: expect.fields, payload_hash: expect.payload_hash }));
  assert.equal(softwareActProof(f, PERSON, { op: expect.op, space: SPACE, fields: expect.fields, payload_hash: crypto.randomBytes(32).toString("base64url") }), null);
  assert.ok(softwareKey(f).key_id.startsWith("dk_"));
});
