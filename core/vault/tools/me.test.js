// @ts-check
// vault.me.*: a member's own vault through the gate. The person comes from the kernel chain alone; another person's vault, the space (owner's) vault, and the owner are refused.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../../test/scratch.mjs";
import { TEST_KDF } from "../testing.js";
import { PeopleVaults } from "../people.js";
import { gateTools, MEMBER_ALLOWED, MEMBER_REFUSAL } from "../member-gate.js";
import { register, ME_TOOLS, memberOf, ME_REFUSAL } from "./me.js";

const OWNER = "per_" + "o".repeat(26), BOB = "per_" + "b".repeat(26), EVE = "per_" + "e".repeat(26);
const PW = "a long master password";
const hop = (/** @type {string} */ kind, /** @type {string} */ id) => ({ actor: { kind, id } });

function rig(/** @type {import("node:test").TestContext} */ t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-me-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const people = new PeopleVaults({ dir: home, testKdf: TEST_KDF });
  t.after(() => people.close());
  const kernel = { owner: OWNER, hasOtherMembers: async () => true, chain: async (/** @type {any} */ m) => ({ hops: m.hops || [] }) };
  const reg = /** @type {Map<string, any>} */ (new Map());
  const ctx = gateTools({ kernel, tool: (/** @type {string} */ n, /** @type {any} */ d) => reg.set(n, d) });
  register({ ctx, people, tool: (n, callers, description, input, run) => ctx.tool(n, { description, input, callers, run }) });
  // a tool of the space (owner's) vault, as index.js registers it
  ctx.tool("vault.put", { callers: ["cli"], run: async () => "space vault written" });
  ctx.tool("vault.get", { callers: ["cli"], run: async () => "space vault read" });
  const call = async (/** @type {string} */ name, /** @type {any} */ input, /** @type {string} */ who, /** @type {any} */ extra = {}) => {
    const meta = { caller: "device:abcdef", token: "t", hops: who ? [hop("person", who)] : [], ...extra };
    try { return { data: await reg.get(name).run(input, meta) }; } catch (e) { return { error: /** @type {any} */ (e) }; }
  };
  return { call, reg, people };
}

test("the gate lets through exactly the vault.me.* names, and every one is registered", async t => {
  const { reg } = rig(t);
  assert.deepEqual([...MEMBER_ALLOWED].sort(), [...ME_TOOLS].sort());
  for (const n of ME_TOOLS) assert.ok(reg.has(n), `${n} is registered`);
});

test("a member makes, unlocks and uses their own vault", async t => {
  const { call } = rig(t);
  const made = await call("vault.me.account.create", { password: PW }, BOB);
  assert.match(made.data.secretKey, /^V2-/);
  assert.equal((await call("vault.me.put", { name: "claude", kind: "ai-signin", fields: { token: "sk-1" } }, BOB)).data.created, true);
  assert.equal((await call("vault.me.get", { name: "claude" }, BOB)).data.fields.token, "sk-1");
  assert.deepEqual((await call("vault.me.list", {}, BOB)).data.items.map((/** @type {any} */ i) => i.name), ["claude"]);
  await call("vault.me.account.lock", {}, BOB);
  assert.equal((await call("vault.me.get", { name: "claude" }, BOB)).error.code, "locked");
  assert.equal((await call("vault.me.account.unlock", { password: PW, secretKey: made.data.secretKey }, BOB)).data.unlocked, true);
});

test("a member is refused another person's vault: a person field in the input changes nothing, and each sees only their own", async t => {
  const { call } = rig(t);
  const b = await call("vault.me.account.create", { password: PW }, BOB);
  await call("vault.me.account.create", { password: PW }, EVE);
  await call("vault.me.put", { name: "bobs", fields: { token: "bob-secret" } }, BOB);
  for (const input of [{ name: "bobs", person: BOB }, { name: "bobs", vault: BOB, id: BOB, owner: BOB }]) {
    const r = await call("vault.me.get", input, EVE);
    assert.ok(r.error, "Eve cannot read Bob's item");
    assert.ok(!JSON.stringify(r).includes("bob-secret"));
  }
  assert.deepEqual((await call("vault.me.list", { person: BOB }, EVE)).data.items, []);
  assert.equal((await call("vault.me.remove", { name: "bobs", person: BOB }, EVE)).error.message, "no item named bobs");
  assert.equal((await call("vault.me.get", { name: "bobs" }, BOB)).data.fields.token, "bob-secret", "Bob's item is untouched");
  assert.ok((await call("vault.me.account.unlock", { password: PW, secretKey: b.data.secretKey, person: BOB }, EVE)).error, "Bob's Secret Key does not open Eve's vault");
});

test("a member is refused the space (owner's) vault", async t => {
  const { call } = rig(t);
  for (const name of ["vault.put", "vault.get"]) {
    const r = await call(name, { name: "x" }, BOB);
    assert.equal(r.error.code, "denied", name);
    assert.equal(r.error.message, MEMBER_REFUSAL);
  }
});

test("the owner, a call with no person, two people in one chain, and a broken chain are refused vault.me.*", async t => {
  const { call, reg } = rig(t);
  assert.equal((await call("vault.me.list", {}, OWNER)).error.message, ME_REFUSAL, "the owner uses the vault tools");
  assert.equal((await call("vault.me.list", {}, null)).error.code, "denied", "no person");
  assert.equal((await call("vault.me.list", {}, BOB, { hops: [hop("person", BOB), hop("person", EVE)] })).error.code, "denied", "two people");
  assert.equal((await call("vault.me.list", {}, BOB, { hops: [hop("person", BOB), hop("person", OWNER)] })).error.code, "denied", "a member behind the owner");
  assert.equal((await call("vault.me.list", {}, BOB, { hops: [hop("person", BOB), hop("agent", "kit")] })).error?.code, "denied", "a member's agent turn is not the person at the keyboard");
  assert.equal(await memberOf({ owner: OWNER, chain: async () => { throw new Error("x"); } }, {}).catch(e => e.code), "denied", "an unreadable chain");
  assert.equal(await memberOf(null, {}).catch(e => e.code), "denied", "no kernel");
  // a model's labels are not callers of any vault.me tool
  for (const n of ME_TOOLS) for (const c of ["mcp", "harness"]) assert.ok(!reg.get(n).callers.includes(c), `${n} is not callable by ${c}`);
});

test("vault.me.store.*: a member's JSON entries; another member and the owner do not see them", async t => {
  const { call } = rig(t);
  await call("vault.me.account.create", { password: PW }, BOB);
  await call("vault.me.account.create", { password: PW }, EVE);
  assert.equal((await call("vault.me.store.put", { key: "mcp/gh", value: { url: "https://x.example", token: "t" } }, BOB)).data.stored, true);
  assert.deepEqual((await call("vault.me.store.get", { key: "mcp/gh" }, BOB)).data, { url: "https://x.example", token: "t" });
  assert.deepEqual((await call("vault.me.store.list", {}, BOB)).data.map((/** @type {any} */ e) => e.key), ["mcp/gh"]);
  assert.equal((await call("vault.me.store.get", { key: "mcp/gh", person: BOB }, EVE)).data, null);
  assert.deepEqual((await call("vault.me.store.list", {}, EVE)).data, []);
  assert.equal((await call("vault.me.store.get", { key: "mcp/gh" }, OWNER)).error.code, "denied");
  assert.equal((await call("vault.me.store.remove", { key: "mcp/gh" }, BOB)).data.removed, true);
});

test("vault.me.store.*: only the mcp module may call it, and only on a member's own turn; the person is the chain's, never the input", async t => {
  const { call, reg } = rig(t);
  for (const n of ["get", "put", "list", "remove"]) assert.ok(reg.get("vault.me.store." + n).callers.includes("module"), n);
  for (const n of ME_TOOLS.filter(x => !x.startsWith("vault.me.store."))) assert.ok(!reg.get(n).callers.includes("module"), `${n} stays closed to modules`);
  await call("vault.me.account.create", { password: PW }, BOB);
  await call("vault.me.account.create", { password: PW }, EVE);
  const via = (/** @type {string} */ who, /** @type {any} */ extra = {}) => ({ caller: "module:mcp", hops: who ? [hop("person", who)] : [], ...extra });
  await call("vault.me.store.put", { key: "mcp/a", value: { t: "bob" } }, BOB, via(BOB));
  assert.deepEqual((await call("vault.me.store.get", { key: "mcp/a" }, BOB, via(BOB))).data, { t: "bob" }, "a relayed module hop for Bob reads Bob's store");
  assert.equal((await call("vault.me.store.get", { key: "mcp/a", person: BOB, id: BOB }, EVE, via(EVE))).data, null, "naming Bob in the input still reads Eve's store");
  assert.equal((await call("vault.me.store.get", { key: "mcp/a" }, null, { caller: "module:mcp", hops: [] })).error.code, "denied", "a module call with no person is refused");
  assert.equal((await call("vault.me.store.get", { key: "mcp/a" }, BOB, via(BOB, { hops: [hop("person", BOB), hop("agent", "kit")] }))).error.code, "denied", "an agent hop is refused");
  assert.equal((await call("vault.me.store.get", { key: "mcp/a" }, OWNER, via(OWNER))).error.code, "denied", "the owner is refused");
  for (const other of ["module:appmods", "module:spaces", "module:some-installed-app"]) for (const n of ["get", "list"]) assert.equal((await call("vault.me.store." + n, { key: "mcp/a" }, BOB, via(BOB, { caller: other }))).error.code, "denied", `${other} is refused even with her token`);
  assert.deepEqual((await call("vault.me.store.get", { key: "mcp/a" }, BOB, via(BOB, { caller: "device:abc" }))).data, { t: "bob" }, "her own device still reads");
});
