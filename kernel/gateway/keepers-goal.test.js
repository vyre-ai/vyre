// A goal is private to the people involved (class 3, lead ruling 12 Oct); for rc.2 it is KEPT by the goals module: a member has no raw Records route to it (get, list, search, count, change, remove, the events log),
// the module reads and writes it under its own service chain (its grants are its manifest's, not rebuilt here), the owner and an admin act as themselves.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const GOAL = { name: "goal", label: "Goal", fields: [{ name: "goal", kind: "text", label: "Goal", required: true }, { name: "project", kind: "text", label: "Project" }, { name: "created_by", kind: "text", label: "Created by" }] };

test("goal: a member reads, lists, counts, searches, changes and removes none of the owner's goals; the owner does", async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const r = { person: BOB, role: "member" }; await k.gateway.grants.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${BOB}`) });
  const R = k.gateway.records;
  await R.define(owner, { add_types: [GOAL] });
  const row = await R.create(owner, "goal", { goal: "OWNER-GOAL-TEXT", created_by: OWNER });
  assert.ok(await R.get(owner, "goal", row.id), "the owner reads it");
  assert.equal(await R.get(bob, "goal", row.id), null, "a member gets none by id");
  assert.deepEqual((await R.query(bob, "goal", { page: { limit: 10 } })).rows, [], "nor by list");
  assert.deepEqual(await R.aggregate(bob, "goal", { measures: [{ fn: "count" }] }), [], "nor a count");
  assert.equal((await R.search(bob, { text: "OWNER-GOAL-TEXT", page: { limit: 5 } })).rows.filter(h => h.type === "goal").length, 0, "nor by search");
  await assert.rejects(() => R.update(bob, "goal", row.id, { goal: "changed" }, row.version), e => ["not_allowed", "not_found"].includes(e.code), "nor change it");
  await assert.rejects(() => R.remove(bob, "goal", row.id, row.version), e => ["not_allowed", "not_found"].includes(e.code), "nor remove it");
  await assert.rejects(() => R.create(bob, "goal", { goal: "planted" }), { code: "not_allowed" }, "nor make one");
  const ev = await k.gateway.events.read(bob, {});
  assert.ok(!ev.some(e => String(e.subject).includes("/goal/")), "and the events log shows her none of them");
});
