// @ts-check
// Sharing a Flow, through the real daemon: a member makes a Flow and shares it, another member cannot change it until she is given Can edit, and the creator's grant is kept in the Flows module's own store.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "../team/team-fixture.js";

const BEN = "per_" + "c".repeat(26);
const ADA = "per_" + "d".repeat(26);
const flow = (/** @type {any[]} */ steps) => ({ format: 1, name: "shared_one", label: "Shared one", authorship: "builder", trigger: { on: "manual" }, steps });

test("a member shares her Flow: another member changes it only with Can edit", { timeout: 150_000 }, async t => {
  const { d } = await boot(t);
  const OWNER = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const add = async (/** @type {string} */ p, /** @type {number} */ n) => {
    await d.kernel.gateway.grants.setRole(ownerChain, { person: p, role: "member" }, { presence: { op: "x", fields: {}, n } });
    const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s-" + p.slice(4, 8) });
    return { token: (await d.kernel.surfaces.open(chain, {})).token };
  };
  const ben = await add(BEN, 2), ada = await add(ADA, 3);
  const as = (/** @type {any} */ who) => (/** @type {string} */ name, /** @type {any} */ input = {}) => d.registry.call(name, input, "deck", who);
  const B = as(ben), A = as(ada);
  const made = await B("flows.define", { flow: flow([{ id: "one", kind: "create", type: "organization", set: { name: "x" } }]) });
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  const id = made.data.id;
  const edit = flow([{ id: "one", kind: "create", type: "organization", set: { name: "x" } }, { id: "two", kind: "create", type: "organization", set: { name: "y" } }]);
  assert.match(String((await A("flows.define", { id, flow: edit })).error?.message), /Can edit/);
  assert.match(String((await A("flows.access.set", { id, kind: "person", subject: ADA, level: "edit" })).error?.message), /creator/);
  assert.equal((await B("flows.access.set", { id, kind: "person", subject: ADA, level: "edit" })).error, undefined);
  assert.deepEqual((await B("flows.access.get", { id })).data.access.map((/** @type {any} */ x) => [x.subject, x.level]), [[ADA, "edit"]]);
  const changed = await A("flows.define", { id, flow: edit });
  assert.equal(changed.error, undefined, JSON.stringify(changed.error));
  assert.equal(changed.data.ok, true, JSON.stringify(changed.data));
});
