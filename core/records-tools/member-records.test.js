// @ts-check
// Behaviour of the Records tools as a person, on a real vyred with the kernel on: a move cannot change a record's ID, and a member moves a record she can write, relates two records and saves her own layout,
// and is refused the Space's layout, a pipeline and a fast field. SHIM(presence) `kernelPresence` accepts any proof.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { DEAL, CONTACT, RELATIONSHIP, QUICK_FIELD, RECORD_LAYOUT } from "../../records/core-types.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a move cannot change the ID; a member moves, relates and saves her own layout, and is refused the Space's layout, a pipeline and a fast field", { timeout: 150_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const dev = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  const ownerChain = dev(OWNER);
  await K.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: proof() });
  const strip = (/** @type {any} */ x) => ({ ...x, hidden_in_records: undefined });
  await K.gateway.records.define(ownerChain, { add_types: [CONTACT, RELATIONSHIP, QUICK_FIELD, RECORD_LAYOUT, strip(DEAL)].map((x) => ({ ...x, fields: x.fields.filter((/** @type {any} */ f) => f.name !== "organization" || x.name !== "deal") })) }).catch(() => {});
  const as = async (/** @type {string} */ p, /** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", { token: (await K.surfaces.open(dev(p), {})).token });

  const made = await as(OWNER, "records.create", { type: "deal", data: { name: "Okafor", amount: 1000 } });
  assert.ok(!made.error, JSON.stringify(made.error));
  const rec = made.data.record, ref = rec.data.ref;
  assert.ok(ref, "the deal has an ID");

  // a move cannot reach the ID by any back door
  const back = await as(OWNER, "records.move", { urn: rec.urn, stage: "Qualified", patch: { ref: "DEA-9999" } });
  assert.equal(back.error && back.error.code, "field_not_allowed");
  const after = await as(OWNER, "records.get", { urn: rec.urn });
  assert.equal(after.data.record.data.ref, ref, "the ID is unchanged");
  assert.notEqual(after.data.record.data.stage, "Qualified", "and nothing was moved");
  // a good move works, sets the stage's chance and keeps the weighted value
  const moved = await as(OWNER, "records.move", { urn: rec.urn, stage: "Qualified" });
  assert.ok(!moved.error, JSON.stringify(moved.error));
  assert.equal(moved.data.record.data.stage, "Qualified");
  assert.equal(moved.data.record.data.probability, 30);
  assert.equal(moved.data.record.data.weighted_value, 300);

  // a member: a deal she makes is hers to move
  const mine = (await as(BEN, "records.create", { type: "deal", data: { name: "Ben's deal", amount: 200 } }));
  assert.ok(!mine.error, JSON.stringify(mine.error));
  const bm = await as(BEN, "records.move", { urn: mine.data.record.urn, stage: "Lead" });
  assert.ok(!bm.error, JSON.stringify(bm.error));
  // she relates two records she can read
  const c1 = (await as(OWNER, "records.create", { type: "contact", data: { name: "Ava" } })).data.record;
  const c2 = (await as(OWNER, "records.create", { type: "contact", data: { name: "Sam" } })).data.record;
  const rel = await as(BEN, "records.relationship.add", { from: c1.urn, to: c2.urn, kind: "Colleague" });
  assert.ok(!rel.error, JSON.stringify(rel.error));
  const gone = await as(BEN, "records.relationship.remove", { id: rel.data.relationship.id });
  assert.ok(!gone.error, JSON.stringify(gone.error));
  // her own layout, not the Space's
  const own = await as(BEN, "records.layout.set", { type: "deal", scope: "mine", layout: { columns: ["name", "amount"] } });
  assert.ok(!own.error, JSON.stringify(own.error));
  assert.equal((await as(BEN, "records.layout.set", { type: "deal", scope: "space", layout: { columns: ["name"] } })).error.code, "not_allowed");
  { const got = await as(BEN, "records.layout.get", { type: "deal" }); assert.equal(JSON.stringify(got.data && got.data.layout && got.data.layout.columns), JSON.stringify(["name", "amount"]), JSON.stringify(got) + " rows: " + JSON.stringify((((await as(OWNER, "records.list", { type: "record-layout" })).data) || {}).rows)); }
  // the Space's pipelines and fast fields stay with an owner or an admin
  const pipe = await as(BEN, "records.pipeline.set", { type: "deal", stages: [{ name: "A" }, { name: "B" }] });
  assert.ok(pipe.error, "a member cannot change the pipeline");
  const field = await as(BEN, "records.field.add", { type: "deal", label: "Budget", kind: "number" });
  assert.equal(field.error && field.error.code, "not_allowed");
  const typeSet = await as(BEN, "records.type.update", { name: "deal", color: "red" });
  assert.ok(typeSet.error, "a member cannot change a type's settings");
  assert.equal((await as(OWNER, "records.type.update", { name: "deal", color: "red" })).error, undefined);
});
