// @ts-check
// vault.access.*: sharing an item is a kernel grant (vault.use, vault.edit) through the vault module's mint handle, for a person, and nothing else.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { register, sourceOf } from "./sharing.js";

const BOB = "per_" + "b".repeat(26);

function rig() {
  /** @type {any[]} */ const grants = [];
  const mint = {
    make: async (/** @type {any} */ g) => { grants.push({ ...g, id: "gr_" + grants.length }); },
    end: async (/** @type {any} */ q) => { for (let i = grants.length - 1; i >= 0; i--) if (grants[i].source === q.source) grants.splice(i, 1); },
    list: async (/** @type {any} */ q) => grants.filter(g => g.source.startsWith(q.source)),
  };
  const kernel = { space: "spc_x", mint, chain: async () => ({ hops: [] }), grants: { members: { list: async () => [{ person: BOB, name: "Bob", role: "member" }] } } };
  const reg = /** @type {Map<string, any>} */ (new Map());
  const audit = /** @type {any[]} */ ([]);
  const vault = { row: (/** @type {string} */ n) => (n === "stripe" ? { name: n } : undefined), access: { urn: async (/** @type {string} */ n) => `vyre://spc_x/vault/v1/item/${n}` }, audit: (/** @type {any[]} */ ...a) => audit.push(a) };
  register({ ctx: { kernel }, vault: /** @type {any} */ (vault), tool: (n, callers, d, i, run) => reg.set(n, { callers, run }) });
  return { grants, reg, audit, call: (/** @type {string} */ n, /** @type {any} */ i) => reg.get(n).run(i, {}) };
}

test("share Can use, then Can edit, then take it away: one grant at a time, on the item's address, for a person", async () => {
  const { call, grants } = rig();
  await call("vault.access.set", { name: "stripe", kind: "person", subject: BOB, level: "use" });
  assert.equal(grants.length, 1);
  assert.deepEqual(grants[0].actions, ["vault.use"]);
  assert.equal(grants[0].resource.prefix, "vyre://spc_x/vault/v1/item/stripe");
  assert.equal(grants[0].source, sourceOf("stripe", BOB));
  assert.deepEqual(grants[0].subject.actor, { kind: "person", id: BOB, space: "spc_x" });
  await call("vault.access.set", { name: "stripe", kind: "person", subject: BOB, level: "edit" });
  assert.equal(grants.length, 1, "sharing again replaces, never doubles");
  assert.deepEqual(grants[0].actions, ["vault.use", "vault.edit"]);
  assert.deepEqual((await call("vault.access.get", { name: "stripe" })).access, [{ kind: "person", subject: BOB, level: "edit" }]);
  assert.equal((await call("vault.access.get", { name: "stripe" })).people[0].id, BOB);
  await call("vault.access.set", { name: "stripe", kind: "person", subject: BOB, level: null });
  assert.equal(grants.length, 0);
});

test("refusals: no such item, not a person, a bad id or level; owner surfaces only, no module or model caller", async () => {
  const { call, reg } = rig();
  await assert.rejects(call("vault.access.set", { name: "nope", kind: "person", subject: BOB, level: "use" }), /no item/);
  await assert.rejects(call("vault.access.set", { name: "stripe", kind: "role", subject: "admin", level: "use" }), /person/);
  await assert.rejects(call("vault.access.set", { name: "stripe", kind: "person", subject: "../x y", level: "use" }), /person/);
  await assert.rejects(call("vault.access.set", { name: "stripe", kind: "person", subject: BOB, level: "root" }), /level/);
  for (const n of ["vault.access.get", "vault.access.set"]) for (const c of ["module", "mcp", "harness", "device", "mobile"]) assert.ok(!reg.get(n).callers.includes(c), `${n} not for ${c}`);
});

test("sharing is audited without a value", async () => {
  const { call, audit } = rig();
  await call("vault.access.set", { name: "stripe", kind: "person", subject: BOB, level: "edit" });
  assert.equal(audit[0][0], "share");
  assert.ok(!JSON.stringify(audit).includes("secret"));
});
