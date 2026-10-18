// The Space's own set-up rows: a fast field is an owner's or admin's write, a layout row is the Space's (owner or admin) or one person's own. A member's create and update of each is refused;
// her own person-scoped layout is allowed. Real kernel, real members.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", ADMIN = "per_admin", BOB = "per_bob", DAN = "per_dan", EVE = "per_eve";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
  { name: "matter", kind: "link", to: "matter", label: "Matter" }, { name: "project", kind: "link", to: "project", label: "Project" }] };

import { QUICK_FIELD, RECORD_LAYOUT } from "../../records/core-types.js";

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  for (const [p, role] of [[ADMIN, "admin"], [BOB, "member"], [DAN, "member"], [EVE, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  await k.gateway.records.define(owner, { add_types: [QUICK_FIELD, RECORD_LAYOUT] });
  const bob = id => k.chains.fromFacts({ kind: "device", device_key_id: `d-${id}`, person: id, path: "direct", session: "s" });
  return { k, owner, bob, R: k.gateway.records };
}
const code = p => p.then(() => null, e => e && e.code);

test("a member cannot make or change a fast field; an owner and an admin can", async () => {
  const { owner, bob, R } = await rig();
  const row = { type: "contact", name: "budget", label: "Budget", kind: "number", state: "bag" };
  assert.equal(await code(R.create(bob(BOB), "quick-field", row)), "not_allowed");
  const made = await R.create(bob(ADMIN), "quick-field", row);
  assert.equal(await code(R.update(bob(BOB), "quick-field", made.id, { state: "real" }, made.version)), "not_allowed");
  assert.equal((await R.update(owner, "quick-field", made.id, { state: "real" }, made.version)).data.state, "real");
});

test("a member saves only her own person layout; the Space layout and anyone else's are refused", async () => {
  const { owner, bob, R } = await rig();
  const mine = { type: "contact", scope: "person", owner: `person:${BOB}`, layout: "{}" };
  assert.equal(await code(R.create(bob(BOB), "record-layout", { ...mine, scope: "space", owner: "" })), "not_allowed", "the Space's");
  assert.equal(await code(R.create(bob(BOB), "record-layout", { ...mine, owner: `person:${DAN}` })), "not_allowed", "another person's");
  assert.equal(await code(R.create(bob(BOB), "record-layout", { ...mine, owner: "" })), "not_allowed", "no owner named");
  const own = await R.create(bob(BOB), "record-layout", mine);
  assert.equal((await R.update(bob(BOB), "record-layout", own.id, { layout: "{\"columns\":[\"name\"]}" }, own.version)).data.layout.includes("name"), true, "her own");
  const cur = await R.get(bob(BOB), "record-layout", own.id);
  assert.equal(await code(R.update(bob(BOB), "record-layout", own.id, { scope: "space", owner: "" }, cur.version)), "not_allowed", "cannot hand it to the Space");
  assert.equal(await code(R.update(bob(BOB), "record-layout", own.id, { owner: `person:${DAN}` }, cur.version)), "not_allowed", "cannot hand it to someone else");
  const space = await R.create(owner, "record-layout", { type: "contact", scope: "space", owner: "", layout: "{}" });
  assert.equal(await code(R.update(bob(BOB), "record-layout", space.id, { layout: "{\"columns\":[\"email\"]}" }, space.version)), "not_allowed", "the Space's row is not hers");
  assert.equal(await code(R.create(bob(ADMIN), "record-layout", { type: "task", scope: "space", owner: "", layout: "{}" })), null, "an admin sets the Space's");
});
