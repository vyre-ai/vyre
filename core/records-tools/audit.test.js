// @ts-check
// records.audit (roadmap 0.6 item 9): who changed what, with before and after, from the signed event log. Owners and admins only; a member is refused; filters by record, person, project and type;
// a sealed value is never in it. A real vyred with the kernel on. SHIM(presence) `kernelPresence` accepts any proof.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { CONTACT } from "../../kernel/conformance/suite.js";
import { PROJECT } from "../../records/core-types.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("the audit shows who changed what with before and after, to an admin and the owner only, and filters by person, record and project", { timeout: 150_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const dev = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  const ownerChain = dev(OWNER);
  await K.gateway.grants.setRole(ownerChain, { person: ANA, role: "admin" }, { presence: proof() });
  await K.gateway.grants.setRole(ownerChain, { person: BEN, role: "member" }, { presence: proof() });
  await K.gateway.records.define(ownerChain, { add_types: [CONTACT, { ...PROJECT, fields: PROJECT.fields.filter((/** @type {any} */ f) => f.name !== "client") }] });
  const R = K.gateway.records;
  const project = await R.create(ownerChain, "project", { name: "Rivera", slug: "rivera" });
  const c = await R.create(ownerChain, "contact", { name: "Jane", age: 40 }, { attrs: { project: project.id } });
  const c2 = await R.create(dev(ANA), "contact", { name: "Other", age: 1 });
  const u = await R.update(dev(ANA), "contact", c.id, { age: 41 }, c.version);
  await R.update(ownerChain, "contact", c.id, { name: "Jane Doe" }, u.version);
  const as = async (/** @type {string} */ p, /** @type {any} */ input) => d.registry.call("records.audit", input, "cli", { token: (await K.surfaces.open(dev(p), {})).token });

  const all = (await as(ANA, {})).data.changes;
  const mine = all.filter((/** @type {any} */ x) => x.type === "contact");
  assert.ok(mine.length >= 4, `every create and update is there: ${mine.length}`);
  const ageChange = mine.find((/** @type {any} */ x) => x.record === c.urn && x.changed.includes("age"));
  assert.equal(ageChange.who, `person:${ANA}`, "who");
  assert.equal(ageChange.before.age, 40); assert.equal(ageChange.after.age, 41);
  assert.equal(all[0].seq > all[all.length - 1].seq, true, "newest first");
  assert.ok((await as(OWNER, {})).data.changes.length >= mine.length, "the owner opens it too");
  const byAna = (await as(ANA, { person: ANA })).data.changes;
  assert.ok(byAna.length >= 2 && byAna.every((/** @type {any} */ x) => x.who === `person:${ANA}`), "filter by person");
  const rec = (await as(ANA, { record: c.urn })).data.changes;
  assert.ok(rec.length === 3 && rec.every((/** @type {any} */ x) => x.record === c.urn), "filter by record");
  const inProject = (await as(ANA, { project: project.id, type: "contact" })).data.changes;
  assert.ok(inProject.length === 3 && inProject.every((/** @type {any} */ x) => x.record === c.urn) && !inProject.some((/** @type {any} */ x) => x.record === c2.urn), "filter by project and type");
  // a member cannot open it, and no grant of the member role reaches it
  const refused = await as(BEN, {});
  assert.equal(refused.error && refused.error.code, "not_allowed");
});
