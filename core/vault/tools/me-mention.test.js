// @ts-check
// A member's own # chip in a chat turn (vault.me.mention.search and .resolve): the Switchboard hands the asker (a person the kernel has already checked is in the chat); the answer comes from THAT person's own vault
// only, never the owner's, and is a name, a kind and a note, never a value. A locked vault says so in words the chat can show. Only the Switchboard asks, and never for the owner or for someone who is not a member.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "./me-mention.js";

const BOB = "per_bob", EVE = "per_eve", OWNER = "per_owner";
function rig() {
  const vaults = /** @type {Record<string, any[]>} */ ({ [BOB]: [{ name: "passport", kind: "login", description: "Passport portal", fields: ["username", "password"], updated: 1 }, { name: "clio-conn", kind: "connection", description: "connection to mcp.clio.test", fields: ["server_url"], updated: 2 }, { name: "bobs-api", kind: "api-credential", description: "Bob's API key", fields: ["config", "secret"], updated: 3 }, { name: "key", kind: "api-key", description: "", fields: ["value"], updated: 3 }, { name: "pk", kind: "passkey", description: "", fields: ["x"], updated: 4 }], [EVE]: [{ name: "airline", kind: "login", description: "", fields: ["password"], updated: 3 }] });
  const locked = new Set(/** @type {string[]} */ ([]));
  const people = { get: async (/** @type {string} */ id, /** @type {any} */ o) => ({ fields: o.name === "passport" ? { url: "https://passport.example.test/login" } : {} }), list: async (/** @type {string} */ id, /** @type {any} */ o = {}) => { if (locked.has(id)) throw Object.assign(new Error("your vault is locked: unlock it with your master password"), { code: "locked" }); const f = o.filter ? String(o.filter).toLowerCase() : ""; return { items: (vaults[id] || []).filter(i => !f || i.name.includes(f)) }; } };
  const reg = /** @type {Map<string, any>} */ (new Map());
  const ctx = { kernel: { owner: OWNER, grants: { members: { list: async () => [{ person: BOB }, { person: EVE }] } }, chain: async () => ({ hops: [] }) } };
  register({ ctx, people: /** @type {any} */ (people), internal: (n, _d, _i, run) => reg.set(n, { run }) });
  const ask = (/** @type {string} */ tool, /** @type {any} */ input, caller = "module:threads") => reg.get(tool).run(input, { caller });
  return { ask, locked, reg };
}

test("a member's chip finds and resolves from HER vault: name, kind and a note, never a value, and never the owner's or another member's", async () => {
  const { ask } = rig();
  const found = await ask("vault.me.mention.search", { asker: BOB, q: "pass" });
  assert.deepEqual(found.items.map((/** @type {any} */ i) => i.id), ["passport"]);
  assert.ok(!JSON.stringify(found).includes("password") || found.items[0].hint === "login · Passport portal", "kind and note only");
  assert.deepEqual((await ask("vault.me.mention.search", { asker: BOB })).items.map((/** @type {any} */ i) => i.id), ["passport", "clio-conn"]);
  const r = await ask("vault.me.mention.resolve", { asker: BOB, id: "passport", thread: "t1", said: "s1" });
  assert.deepEqual([r.id, r.name, r.kind], ["passport", "passport", "login"]);
  assert.ok(!("value" in r) && !JSON.stringify(r).includes("secret"));
  await assert.rejects(ask("vault.me.mention.resolve", { asker: BOB, id: "airline", thread: "t1" }), { code: "not_found" }, "Eve's item is not Bob's");
  await assert.rejects(ask("vault.me.mention.resolve", { asker: BOB, id: "stripe", thread: "t1" }), { code: "not_found" }, "an owner's item is not Bob's");
});

test("a locked vault answers in plain words the chat can show", async () => {
  const { ask, locked } = rig();
  locked.add(BOB);
  const e = await ask("vault.me.mention.search", { asker: BOB }).catch((/** @type {any} */ x) => x);
  assert.equal(e.code, "locked"); assert.match(e.message, /unlock your vault/i);
  await assert.rejects(ask("vault.me.mention.resolve", { asker: BOB, id: "passport", thread: "t" }), { code: "locked" });
});

test("only the Switchboard (module:threads) asks, no other module, and only about a member: not the owner, not a stranger, not another module or a model", async () => {
  const { ask } = rig();
  for (const caller of ["module:switchboard", "module:sessions", "module:assistant", "module:mentions", "module:files", "module:threadsx", "cli", "mcp", "mcp:agent:kit", "device:abcdef"]) await assert.rejects(ask("vault.me.mention.search", { asker: BOB }, caller), { code: "denied" }, caller);
  await assert.rejects(ask("vault.me.mention.search", { asker: OWNER }), { code: "denied" }, "the owner's chips are the owner's vault");
  await assert.rejects(ask("vault.me.mention.search", { asker: "per_stranger" }), { code: "denied" });
  await assert.rejects(ask("vault.me.mention.search", { asker: "bob" }), { code: "bad_input" });
  await assert.rejects(ask("vault.me.mention.search", {}), { code: "bad_input" });
});
