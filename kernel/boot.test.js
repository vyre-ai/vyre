import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../test/scratch.mjs";
import { bootKernel } from "./boot.js";
import { canonical, sha256 } from "./core/canonical.js";
import { CONTACT } from "./conformance/suite.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const key = Buffer.alloc(32, 7);
const file = () => path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-boot-")), "kernel.db");
const sealer = { presenceCheck: async ({ proof, op, fields }) => (proof && proof.op === op && canonical(proof.fields) === canonical(fields) ? null : "wrong_payload") };
const proofFor = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) } });
const boot = f => bootKernel({ db: new DatabaseSync(f), space: SPACE, owner: OWNER, owner_uid: 501, key, sealer });
const ownerChain = k => k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });

test("boot: a first start makes the owner; a restart brings back every grant, member, record and event from the home's database", async () => {
  const f = file();
  let k = boot(f);
  assert.equal(k.fresh, true);
  const o = ownerChain(k);
  await k.gateway.records.define(o, { add_types: [CONTACT] });
  const bob = { kind: "person", id: "per_bob", space: SPACE };
  const role = { person: "per_bob", role: "member" };
  await k.gateway.grants.setRole(o, role, { presence: proofFor("grants.role", role, `vyre://${SPACE}/member/per_bob`) });
  const c = await k.gateway.records.create(o, "contact", { name: "Jane" });
  assert.equal(k.grants.roleOf(bob), "member");
  const events = k.log.latestSeq();
  // restart: a new process on the same file
  k = boot(f);
  assert.equal(k.fresh, false);
  assert.equal(k.grants.roleOf(bob), "member", "memberships come back from the log");
  assert.equal(k.grants.roleOf({ kind: "person", id: OWNER, space: SPACE }), "owner");
  assert.equal(k.log.latestSeq(), events);
  assert.equal((await k.gateway.audit.verify()).ok, true);
  assert.equal((await k.gateway.records.get(ownerChain(k), "contact", c.id)).data.name, "Jane", "records come back from the store");
  // bob can work on the restarted kernel with the grants the role gave him
  const bobChain = k.chains.fromFacts({ kind: "device", device_key_id: "d-bob", person: "per_bob", path: "direct" });
  assert.equal((await k.gateway.records.create(bobChain, "contact", { name: "Made after restart" })).data.name, "Made after restart");
});

import { createKernel } from "./index.js";
test("createKernel: one call wires everything with safe defaults, including the rule evaluator", async () => {
  const k = createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key });
  const o = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
  await k.gateway.records.define(o, { add_types: [{ name: "deal", label: "Deal", fields: [{ name: "stage", kind: "stage", label: "Stage", options: ["A", "B"] }, { name: "ok", kind: "boolean", label: "Ok" }], stages: [{ name: "A" }, { name: "B" }], rules: [{ name: "r", require: "stage < 'B' or ok == true" }] }] });
  await assert.rejects(() => k.gateway.records.create(o, "deal", { stage: "B", ok: false }), { code: "rule_failed" });
  assert.equal((await k.gateway.records.create(o, "deal", { stage: "B", ok: true })).data.stage, "B");
  assert.equal(k.fresh, true);
  assert.equal((await k.gateway.audit.verify()).ok, true);
});
