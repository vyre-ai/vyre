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
import { ConnectionTokens } from "../connection-token.js";
import { SHARE_TOOLS } from "./member-share.js";
import { openConnectionKey, wrapPath } from "../people-seal.js";
import { openItemV2 } from "../crypto.js";
import { gateTools, MEMBER_ALLOWED, MEMBER_REFUSAL } from "../member-gate.js";
import { register, ME_TOOLS, ME_MODULE_TOOLS, SHARED_ME_TOOLS, memberOf, ME_REFUSAL } from "./me.js";

const OWNER = "per_" + "o".repeat(26), BOB = "per_" + "b".repeat(26), EVE = "per_" + "e".repeat(26);
const PW = "a long master password";
const hop = (/** @type {string} */ kind, /** @type {string} */ id) => ({ actor: { kind, id } });

function rig(/** @type {import("node:test").TestContext} */ t, /** @type {any} */ kernelExtra = {}, /** @type {any} */ peopleExtra = {}) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-me-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  /** What the vault announced (people.emit), and the member token accounts the sessions module would answer for (vault.me.lend asks sessions.accounts.item). */
  const events = /** @type {{ type: string, p: any }[]} */ ([]), accounts = /** @type {Record<string, any>} */ ({});
  const people = new PeopleVaults({ dir: home, testKdf: TEST_KDF, emit: (/** @type {string} */ type, /** @type {any} */ p) => { events.push({ type, p }); }, ...peopleExtra });
  t.after(() => people.close());
  const kernel = { owner: OWNER, space: "spc_aaaaaaaaaaaa", hasOtherMembers: async () => true, chain: async (/** @type {any} */ m) => { if (m.gone) throw new Error("not a member of this Space"); return { hops: m.hops || [] }; }, ...kernelExtra };
  const reg = /** @type {Map<string, any>} */ (new Map());
  const ctx = gateTools({ kernel, tool: (/** @type {string} */ n, /** @type {any} */ d) => reg.set(n, d) });
  /** @type {any} */ (ctx).call = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    if (tool !== "sessions.accounts.item") return { error: { code: "no_such_tool", message: tool } };
    const a = accounts[String(input.account)];
    return a && a.person === input.person ? { data: a } : { error: { code: "not_found", message: "no such account" } };
  };
  register({ ctx, people, tool: (n, callers, description, input, run) => ctx.tool(n, { description, input, callers, run }) });
  // a tool of the space (owner's) vault, as index.js registers it
  ctx.tool("vault.put", { callers: ["cli"], run: async () => "space vault written" });
  ctx.tool("vault.get", { callers: ["cli"], run: async () => "space vault read" });
  const call = async (/** @type {string} */ name, /** @type {any} */ input, /** @type {string} */ who, /** @type {any} */ extra = {}) => {
    const meta = { caller: "device:abcdefghijklmnop", token: "t", hops: who ? [hop("person", who)] : [], ...extra };
    try { return { data: await reg.get(name).run(input, meta) }; } catch (e) { return { error: /** @type {any} */ (e) }; }
  };
  return { call, reg, people, home, accounts, events };
}

/** A connection made the one way it can be: the connectors module, for the person in the chain. */
const SRV = "https://mcp.example.test/mcp";
const conn = (/** @type {any} */ call, /** @type {string} */ name, /** @type {any} */ fields, /** @type {string} */ who) => call("vault.me.connect.put", { name, fields: { server_url: SRV, ...fields } }, who, { caller: "module:connectors" });

test("the gate lets through exactly the vault.me.* names, and every one is registered", async t => {
  const { reg } = rig(t);
  assert.deepEqual([...MEMBER_ALLOWED].sort(), [...ME_TOOLS, ...ME_MODULE_TOOLS, ...SHARED_ME_TOOLS, ...SHARE_TOOLS].sort());
  for (const n of [...ME_TOOLS, ...ME_MODULE_TOOLS]) assert.ok(reg.has(n), `${n} is registered`);
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
  assert.match((await call("vault.me.remove", { name: "bobs", person: BOB }, EVE)).error.message, /^no item named bobs\b/);
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
  assert.deepEqual((await call("vault.me.store.get", { key: "mcp/a" }, BOB, via(BOB, { caller: "device:abcdefghijklmnop" }))).data, { t: "bob" }, "her own device still reads");
});

test("vault.me.release hands her Dropbox token to the files module only, for the one person in the chain", async t => {
  const { call, people } = rig(t);
  await call("vault.me.account.create", { password: PW }, BOB);
  await call("vault.me.account.create", { password: PW }, EVE);
  await call("vault.me.put", { name: "dropbox", kind: "api-key", fields: { value: "sl.bob-dropbox-token-0001" } }, BOB);
  await call("vault.me.put", { name: "claude", fields: { token: "sk-bob" } }, BOB);
  const asFiles = (/** @type {any} */ input, /** @type {string | null} */ who, /** @type {any} */ extra = {}) => call("vault.me.release", input, who, { caller: "module:files", ...extra });
  assert.deepEqual((await asFiles({ name: "dropbox", field: "value" }, BOB)).data, { person: BOB, value: "sl.bob-dropbox-token-0001" });
  assert.deepEqual((await asFiles({ name: "dropbox" }, BOB)).data, { person: BOB, value: "sl.bob-dropbox-token-0001" }, "field defaults to value");
  // another module, a person's surface, a model: refused
  for (const caller of ["module:mcp", "module:sessions", "cli", "device:abcdef", "mcp", "harness", "mcp:agent:juno"]) assert.equal((await call("vault.me.release", { name: "dropbox" }, BOB, { caller })).error?.code, "denied", caller);
  // only her dropbox item, never another of hers
  assert.equal((await asFiles({ name: "claude", field: "token" }, BOB)).error.code, "denied");
  // the person is the chain's, not the input's: Eve gets her own (none), never Bob's
  assert.match((await asFiles({ name: "dropbox", person: BOB }, EVE)).error.message, /^no item named dropbox\b/);
  // the owner, no person, two people, an agent turn
  assert.equal((await asFiles({ name: "dropbox" }, OWNER)).error.message, ME_REFUSAL);
  assert.equal((await asFiles({ name: "dropbox" }, null)).error.code, "denied");
  assert.equal((await asFiles({ name: "dropbox" }, BOB, { hops: [hop("person", BOB), hop("person", EVE)] })).error.code, "denied");
  assert.equal((await asFiles({ name: "dropbox" }, BOB, { hops: [hop("person", BOB), hop("agent", "kit")] })).error?.code, "denied");
  // a locked vault answers locked, never a value
  people.lock(BOB);
  assert.equal((await asFiles({ name: "dropbox" }, BOB)).error.code, "locked");
});

test("vault.connection.token: the hub gets a short-lived token for the owner's connection, after a second check of who is asking; the refresh token never leaves", async t => {
  const asked = [];
  const { call, people } = rig(t, { authorize: async (/** @type {any} */ q) => { asked.push(q); const ok = q.chain.hops.some((/** @type {any} */ h) => h.actor.id === EVE) && q.action === "vault.read"; return { effect: ok ? "allow" : "deny" }; } });
  await call("vault.me.account.create", { password: PW }, BOB);
  const future = String(Date.now() + 3_600_000);
  await conn(call, "clio", { auth_kind: "oauth", client_id: "c", token_uri: "https://auth.example.test/token", refresh_token: "REFRESH-SECRET-0001", access_token: "ACCESS-0001-abcdefghij", expires_at: future, resource: "https://mcp.example.test/mcp" }, BOB);
  await conn(call, "pit", { auth_kind: "bearer", token: "PIT-TOKEN-0001-abcdefghij" }, BOB);
  await call("vault.me.put", { name: "claude", fields: { token: "sk-bob" } }, BOB);
  const hub = (/** @type {any} */ input, /** @type {string | null} */ who, /** @type {any} */ extra = {}) => call("vault.connection.token", input, who, { caller: "module:mcp", ...extra });
  // the owner of the connection, alone in the chain: the stored access token, never the refresh token
  const own = (await hub({ owner: BOB, connection: "clio" }, BOB)).data;
  assert.equal(own.access_token, "ACCESS-0001-abcdefghij"); assert.equal(own.token_type, "Bearer"); assert.equal(own.resource, "https://mcp.example.test/mcp");
  assert.ok(!JSON.stringify(own).includes("REFRESH-SECRET"), "the refresh token never leaves");
  assert.equal((await hub({ owner: BOB, connection: "pit" }, BOB)).data.access_token, "PIT-TOKEN-0001-abcdefghij");
  // only the mcp module asks
  for (const caller of ["module:files", "cli", "device:abcdef", "mcp", "mcp:agent:juno"]) assert.equal((await call("vault.connection.token", { owner: BOB, connection: "clio" }, BOB, { caller })).error?.code, "denied", caller);
  // a colleague is asked of the kernel: allowed only with a grant for a read; a write needs vault.call
  assert.equal((await hub({ owner: BOB, connection: "clio" }, EVE)).data.access_token, "ACCESS-0001-abcdefghij");
  assert.equal(asked.at(-1).resource, "vyre://spc_aaaaaaaaaaaa/vault/" + BOB + "/item/clio");
  assert.equal((await hub({ owner: BOB, connection: "clio", write: true }, EVE)).error.code, "denied");
  assert.equal((await hub({ owner: BOB, connection: "clio" }, "per_" + "z".repeat(26))).error.code, "denied");
  // an assistant acting for the owner is not the owner alone: it needs a grant too
  assert.equal((await hub({ owner: BOB, connection: "clio" }, BOB, { hops: [hop("person", BOB), hop("agent", "kit")] })).error.code, "denied");
  // not a connection, no such one, the Space owner, a bad name
  assert.equal((await hub({ owner: BOB, connection: "claude" }, BOB)).error.code, "not_found");
  assert.match((await hub({ owner: BOB, connection: "nope" }, BOB)).error.message, /no item named nope/);
  assert.equal((await hub({ owner: OWNER, connection: "clio" }, OWNER)).error.code, "denied");
  assert.equal((await hub({ owner: "bob", connection: "clio" }, BOB)).error.code, "bad_input");
  // a locked vault answers locked, never a value
  people.lock(BOB);
  assert.equal((await hub({ owner: BOB, connection: "clio" }, BOB)).error.code, "locked");
});

test("vault.me.lend gives a member their own key for their own turn: the person is the turn's chain, the account must be theirs, the vault unlocked, and the value goes nowhere but the reply", async t => {
  const { call, people, accounts, events } = rig(t);
  await call("vault.me.account.create", { password: PW }, BOB);
  await call("vault.me.account.create", { password: PW }, EVE);
  await call("vault.me.put", { name: "bob-claude", kind: "setup-token", fields: { value: "sk-ant-bob-0001" } }, BOB);
  accounts.acct_bob = { person: BOB, item: "bob-claude", kind: "setup-token", provider: "claude" };
  const lend = (/** @type {any} */ input, /** @type {string | null} */ who, /** @type {any} */ extra = {}) => call("vault.me.lend", input, who, { caller: "module:threads", ...extra });
  const has = (/** @type {any} */ input, /** @type {string | null} */ who, caller = "module:sessions") => call("vault.me.has", input, who, { caller });
  assert.equal((await has({ name: "bob-claude" }, BOB)).data.has, true, "the add-time check");
  assert.equal((await has({ name: "bob-claude" }, EVE)).data.has, false, "not in her vault");
  assert.equal((await has({ name: "bob-claude" }, BOB, "module:switchboard")).error.code, "denied", "only the sessions module asks");
  assert.equal(JSON.stringify((await has({ name: "bob-claude" }, BOB)).data).includes("sk-ant"), false, "never a value");
  // the person is the chain's: a `person` in the input changes nothing, either way
  assert.equal((await has({ person: BOB, name: "bob-claude" }, EVE)).data.has, false, "Eve asking about Bob's item by naming Bob is asked about Eve's own vault");
  assert.equal((await has({ person: EVE, name: "bob-claude" }, BOB)).data.has, true, "Bob naming Eve is still asked about Bob's own vault");
  assert.equal((await has({ person: BOB, name: "bob-claude" }, OWNER)).error.message, ME_REFUSAL, "the owner is refused, whoever the input names");
  assert.equal((await has({ person: BOB, name: "bob-claude" }, null)).error.code, "denied", "a call with no person on its chain gets nothing, whoever the input names");
  assert.deepEqual((await lend({ account: "acct_bob" }, BOB)).data, { value: "sk-ant-bob-0001" });
  // the account names the person: another member's turn, even naming the account or a person, gets nothing
  assert.equal((await lend({ account: "acct_bob", person: BOB }, EVE)).error.code, "denied");
  assert.equal((await lend({ account: "acct_nobody" }, BOB)).error.code, "denied");
  // not the owner, not a chain with no person, not two people, not an agent's turn, not another module or a surface
  assert.equal((await lend({ account: "acct_bob" }, OWNER)).error.message, ME_REFUSAL);
  assert.equal((await lend({ account: "acct_bob" }, null)).error.code, "denied");
  assert.equal((await lend({ account: "acct_bob" }, BOB, { hops: [hop("person", BOB), hop("agent", "kit")] })).error?.code, "denied", "an agent's job never uses a member's key");
  for (const caller of ["module:switchboard", "module:files", "module:sessions", "module:mcp", "cli", "device:abcdef", "mcp", "mcp:agent:juno"]) assert.equal((await call("vault.me.lend", { account: "acct_bob" }, BOB, { caller })).error?.code, "denied", caller);
  // a member who has left the Space has no chain in it: a thread resumed on their account gets no value and no other credential
  const gone = await lend({ account: "acct_bob" }, BOB, { gone: true });
  assert.equal(gone.error.code, "denied");
  assert.equal(JSON.stringify(gone).includes("sk-ant"), false);
  // the owner's turn naming the member's account id is refused too (the account is not the owner's, and the owner is not a member)
  assert.equal((await lend({ account: "acct_bob", person: BOB }, OWNER)).error.code, "denied");
  // a locked vault says so and gives nothing
  people.lock(BOB);
  const locked = await lend({ account: "acct_bob" }, BOB);
  assert.equal(locked.error.code, "locked"); assert.equal(JSON.stringify(locked.error.message).includes("sk-ant"), false);
  // every lend is in the audit trail by person, account and item, and the value is in none of it
  assert.ok(events.some(e => e.type === "vault.me.lent" && e.p.person === BOB && e.p.account === "acct_bob"));
  assert.equal(JSON.stringify(events.filter(e => e.type === "vault.me.lent")).includes("bob-claude"), false, "the event names the account, never the item the member labelled");
  assert.equal(JSON.stringify(events).includes("sk-ant-bob-0001"), false, "no event carries the value");
});

test("sealed server copy: a connection keeps working while its owner is locked, the person's own vault does not, and no plaintext key is written", async t => {
  const sealRoot = fs.mkdtempSync(path.join(SCRATCH, "vyre-seal-"));
  t.after(() => fs.rmSync(sealRoot, { recursive: true, force: true }));
  const { call, people, home } = rig(t, {}, { sealRoot });
  const made = await call("vault.me.account.create", { password: PW }, BOB);
  await call("vault.me.account.create", { password: PW }, EVE);
  await conn(call, "clio", { auth_kind: "oauth", client_id: "c", token_uri: "https://auth.example.test/token", refresh_token: "REFRESH-OLD-0001", access_token: "ACCESS-OLD-0001-abcdefghij", expires_at: String(Date.now() - 1000), resource: "https://mcp.example.test/mcp" }, BOB);
  await call("vault.me.put", { name: "claude", fields: { token: "sk-bob-private" } }, BOB);
  await conn(call, "evepit", { auth_kind: "bearer", token: "EVE-PIT-0001-abcdefghij" }, EVE);
  let posted = 0;
  const fetch = async (/** @type {string} */ _u, /** @type {any} */ o) => { posted++; assert.match(String(o.body), /refresh_token=REFRESH-OLD-0001/); return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "ACCESS-NEW-0002-abcdefghij", refresh_token: "REFRESH-NEW-0002", expires_in: 3600 }) }; };
  const tokens = new ConnectionTokens({ people, kernel: { owner: OWNER, space: "spc_aaaaaaaaaaaa", chain: async (/** @type {any} */ m) => ({ hops: m.hops || [] }) }, fetch });
  const asBob = { caller: "module:mcp", hops: [hop("person", BOB)] };
  // nobody is unlocked now
  people.lock(BOB); people.lock(EVE);
  assert.equal((await call("vault.me.get", { name: "claude" }, BOB)).error.code, "locked", "her own vault still needs the master password");
  assert.equal((await call("vault.me.get", { name: "clio" }, BOB)).error.code, "locked");
  // the hub's token tool still refreshes through the sealed copy, and saves the rotated refresh token
  const r = await tokens.token({ owner: BOB, connection: "clio" }, asBob);
  assert.equal(r.access_token, "ACCESS-NEW-0002-abcdefghij"); assert.equal(posted, 1);
  assert.ok(!JSON.stringify(r).includes("REFRESH"), "no refresh token leaves");
  await call("vault.me.account.unlock", { password: PW, secretKey: made.data.secretKey }, BOB);
  assert.equal((await people.service(BOB).get("clio")).fields.refresh_token, "REFRESH-NEW-0002", "the rotation was saved to the item");
  people.lock(BOB);
  // only connection items open this way: a note or an AI sign-in is refused, a locked vault with no seal is locked
  await assert.rejects(() => tokens.token({ owner: BOB, connection: "claude" }, asBob), { code: "not_found" });
  await assert.rejects(() => people.service(BOB).get("claude"), { code: "not_found" });
  // the seal is bound to the person: Bob's wrap moved to Eve's place opens nothing
  const bobFile = wrapPath(sealRoot, BOB), eveFile = wrapPath(sealRoot, EVE);
  assert.ok(fs.existsSync(bobFile) && fs.existsSync(eveFile));
  assert.notEqual(openConnectionKey(sealRoot, BOB), null);
  const keep = fs.readFileSync(eveFile);
  fs.copyFileSync(bobFile, eveFile);
  assert.equal(openConnectionKey(sealRoot, EVE), null, "a wrap moved to another person's place opens nothing");
  fs.writeFileSync(eveFile, keep);
  // no plaintext copy of any key under the state folder: scan every file for the raw key bytes of the unlocked vault
  await call("vault.me.account.unlock", { password: PW, secretKey: made.data.secretKey }, BOB);
  const dump = (/** @type {string} */ d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? dump(path.join(d, e.name)) : [path.join(d, e.name)]);
  const raw = people.slot(BOB).vault.pvk.export();
  assert.equal(raw.length, 32);
  const ckRaw = openConnectionKey(sealRoot, BOB).export();
  for (const f of [...dump(sealRoot), ...dump(home)]) { assert.ok(!fs.readFileSync(f).includes(raw), `${f} holds the raw vault key`); assert.ok(!fs.readFileSync(f).includes(ckRaw), `${f} holds the raw connection key`); }
  // leaving the Space removes the seal
  people.destroy(BOB);
  assert.equal(openConnectionKey(sealRoot, BOB), null);
  await assert.rejects(() => tokens.token({ owner: BOB, connection: "clio" }, asBob), { code: "locked" });
});

test("vault.me.connect.put: the connectors module stores a sign-in in the signing-in member's own vault, labelled by the chain, never by the input", async t => {
  const { call, people } = rig(t);
  await call("vault.me.account.create", { password: PW }, BOB);
  await call("vault.me.account.create", { password: PW }, EVE);
  const put = (/** @type {any} */ input, /** @type {string | null} */ who, /** @type {any} */ extra = {}) => call("vault.me.connect.put", input, who, { caller: "module:connectors", ...extra });
  const f = { auth_kind: "oauth", server_url: "https://mcp.example.test/mcp", client_id: "c", refresh_token: "R1", token_uri: "https://auth.example.test/token" };
  assert.equal((await put({ name: "clio", fields: { ...f, connected_by: EVE } }, BOB)).data.created, true);
  const got = (await call("vault.me.get", { name: "clio" }, BOB)).data;
  assert.equal(got.kind, "connection"); assert.equal(got.fields.connected_by, BOB, "connected_by is the chain's person, not the input's");
  assert.deepEqual(Object.keys(got.fields).sort(), ["auth_kind", "connected_by", "server_url"], "the person sees what it connects to and never a token");
  assert.match((await call("vault.me.get", { name: "clio" }, EVE)).error.message, /^no item named clio\b/, "nothing lands in another person's vault");
  assert.equal((await put({ name: "clio", fields: { ...f, refresh_token: "R2" } }, BOB)).data.created, false, "a second sign-in updates it");
  assert.equal((await people.service(BOB).get("clio")).fields.refresh_token, "R2");
  for (const caller of ["module:files", "module:sessions", "cli", "device:abcdef", "mcp", "mcp:agent:juno"]) assert.equal((await call("vault.me.connect.put", { name: "x", fields: f }, BOB, { caller })).error?.code, "denied", caller);
  assert.equal((await call("vault.me.connect.put", { name: "mine-her-mail-token", fields: { auth_kind: "bearer", token: "T", server_url: "https://mcp.example.com/mail" } }, BOB, { caller: "module:mcp" })).data.created, true, "the mcp module stores a token she pasted for her own server")
  assert.equal((await put({ name: "x", fields: { ...f, auth_kind: "magic" } }, BOB)).error.code, "bad_input");
  assert.equal((await put({ name: "x", fields: { ...f, server_url: "http://plain.example.test" } }, BOB)).error.code, "bad_input");
  await call("vault.me.put", { name: "claude", fields: { token: "sk-bob" } }, BOB);
  assert.equal((await put({ name: "claude", fields: f }, BOB)).error.code, "denied", "it never overwrites an item that is not a connection");
  assert.equal((await put({ name: "clio", fields: f }, OWNER)).error.message, ME_REFUSAL, "the owner's connections stay in the owner's vault");
  assert.equal((await put({ name: "clio", fields: f }, BOB, { hops: [hop("person", BOB), hop("agent", "kit")] })).error.code, "denied");
});

test("a connection is made only by connect.put: the general tools cannot create, edit or read the secret of one", async t => {
  const { call } = rig(t);
  await call("vault.me.account.create", { password: PW }, BOB);
  assert.equal((await call("vault.me.put", { name: "forged", kind: "connection", fields: { auth_kind: "oauth", token_uri: "https://evil.example.test/token", connected_by: EVE } }, BOB)).error.code, "denied");
  await conn(call, "clio", { auth_kind: "bearer", token: "TOKEN-SECRET-0001" }, BOB);
  assert.equal((await call("vault.me.update", { name: "clio", fields: { token_uri: "https://evil.example.test/token" } }, BOB)).error.code, "denied");
  assert.ok(!JSON.stringify((await call("vault.me.get", { name: "clio" }, BOB)).data).includes("TOKEN-SECRET"));
  assert.ok((await call("vault.me.list", {}, BOB)).data.items.some((/** @type {any} */ i) => i.name === "clio" && i.kind === "connection"), "it is listed");
  assert.equal((await call("vault.me.remove", { name: "clio" }, BOB)).data.removed, "clio", "the person can remove it");
  assert.match((await call("vault.me.get", { name: "clio" }, BOB)).error.message, /no item named clio/);
});

test("the sealed key is a connection key: by cryptography it opens connection items and nothing else in the vault; reset rotates it", async t => {
  const sealRoot = fs.mkdtempSync(path.join(SCRATCH, "vyre-seal2-"));
  t.after(() => fs.rmSync(sealRoot, { recursive: true, force: true }));
  const { call, people } = rig(t, {}, { sealRoot });
  await call("vault.me.account.create", { password: PW }, BOB);
  await call("vault.me.put", { name: "claude", kind: "ai-signin", fields: { token: "sk-bob-private" } }, BOB);
  await conn(call, "clio", { auth_kind: "bearer", token: "CONN-TOKEN-0001-abcdefghij" }, BOB);
  const sealed = openConnectionKey(sealRoot, BOB);
  assert.ok(sealed, "the server holds a key");
  const list = (/** @type {string} */ d) => fs.readdirSync(d).filter(f => f.endsWith(".json"));
  const folder = people.folder(BOB);
  const open = (/** @type {any} */ k, /** @type {string} */ dir, /** @type {any} */ at, /** @type {string} */ f) => openItemV2(k, at(BOB, f.slice(0, -5)), JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  const [conF] = list(people.connDir(BOB)), [ordF] = list(people.itemDir(BOB));
  assert.equal(open(sealed, people.connDir(BOB), people.atConn.bind(people), conF).fields.token, "CONN-TOKEN-0001-abcdefghij", "the sealed key opens the connection");
  assert.throws(() => open(sealed, people.itemDir(BOB), people.at.bind(people), ordF), "the sealed key cannot open an ordinary item");
  assert.throws(() => openItemV2(sealed, people.at(BOB, "ck"), JSON.parse(fs.readFileSync(path.join(folder, "ck.json"), "utf8"))), "nor the file that holds the connection key");
  assert.ok(!fs.readFileSync(path.join(people.itemDir(BOB), ordF), "utf8").includes("sk-bob-private"));
  // the service reads connections only
  await assert.rejects(() => people.service(BOB).get("claude"), { code: "not_found" });
  await assert.rejects(() => people.service(BOB).update("claude", { token: "x" }), { code: "not_found" });
  // a reset rotates the connection key: the old sealed key opens nothing, the new one does, and the connection still works
  people.rotateConnectionKey(BOB, people.slot(BOB));
  const fresh = openConnectionKey(sealRoot, BOB);
  assert.throws(() => open(sealed, people.connDir(BOB), people.atConn.bind(people), conF), "the old key opens nothing now");
  assert.equal(open(fresh, people.connDir(BOB), people.atConn.bind(people), conF).fields.token, "CONN-TOKEN-0001-abcdefghij");
  people.lock(BOB);
  assert.equal((await people.service(BOB).get("clio")).fields.token, "CONN-TOKEN-0001-abcdefghij", "still served from the sealed copy while locked");
  // leaving removes the seal
  people.destroy(BOB);
  assert.equal(openConnectionKey(sealRoot, BOB), null);
});

test("vault.me.who names the owner or the one member in the chain, to the mcp and connectors modules only, and refuses what it cannot name", async t => {
  const { call } = rig(t);
  const who = (/** @type {string | null} */ p, /** @type {any} */ extra = {}) => call("vault.me.who", {}, p, { caller: "module:mcp", ...extra });
  assert.deepEqual((await who(BOB)).data, { kind: "member", person: BOB });
  assert.deepEqual((await who(OWNER)).data, { kind: "owner" });
  assert.deepEqual((await who(BOB, { caller: "module:connectors" })).data, { kind: "member", person: BOB });
  assert.deepEqual((await who(BOB, { hops: [hop("person", BOB)], person: EVE })).data, { kind: "member", person: BOB }, "a person field changes nothing");
  for (const caller of ["module:files", "cli", "device:abcdef", "mcp", "mcp:agent:juno"]) assert.equal((await who(BOB, { caller })).error?.code, "denied", caller);
  assert.equal((await who(null)).error.code, "denied");
  assert.equal((await who(BOB, { hops: [hop("person", BOB), hop("person", EVE)] })).error.code, "denied");
  assert.equal((await who(BOB, { hops: [hop("person", BOB), hop("agent", "kit")] })).error.code, "denied");
});

test("the lend key: what a member lends to an agent sits in her own vault under a key of its own, the sealed key opens lent copies and nothing else, and unlending deletes the copy", async t => {
  const sealRoot = fs.mkdtempSync(path.join(SCRATCH, "vyre-seal3-"));
  t.after(() => fs.rmSync(sealRoot, { recursive: true, force: true }));
  const { call, people } = rig(t, {}, { sealRoot });
  await call("vault.me.account.create", { password: PW }, BOB);
  await call("vault.me.account.create", { password: PW }, EVE);
  await call("vault.me.put", { name: "bank", kind: "login", fields: { username: "bob", password: "PW-BANK-0001-abcdefghij" } }, BOB);
  await conn(call, "clio", { auth_kind: "bearer", token: "CONN-TOKEN-0001-abcdefghij" }, BOB);
  const lent = people.lent(BOB);
  assert.deepEqual(await lent.put("bank", { kind: "login", fields: { username: "bob", password: "PW-BANK-0001-abcdefghij" } }), { name: "bank", created: true });
  assert.deepEqual(await lent.put("bank", { kind: "login", fields: { username: "bob", password: "PW-BANK-0002-abcdefghij" } }), { name: "bank", created: false });
  assert.deepEqual(await lent.names(), ["bank"]);
  // her own tools never list a lent copy, and no vault.me tool reads one
  assert.deepEqual((await call("vault.me.list", {}, BOB)).data.items.map((/** @type {any} */ i) => i.name).sort(), ["bank", "clio"]);
  // the sealed lend key opens the lent copy and nothing else: not her ordinary login, not the connection, not the connection key file
  const lk = openConnectionKey(sealRoot, BOB, "lend");
  assert.ok(lk, "the server holds a lend key");
  const folder = people.folder(BOB);
  const files = (/** @type {string} */ d) => fs.readdirSync(d).filter(f => f.endsWith(".json"));
  const open = (/** @type {any} */ k, /** @type {string} */ dir, /** @type {any} */ at, /** @type {string} */ f) => openItemV2(k, at(BOB, f.slice(0, -5)), JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
  const [lentF] = files(people.lendDir(BOB)), [ordF] = files(people.itemDir(BOB)), [conF] = files(people.connDir(BOB));
  assert.equal(open(lk, people.lendDir(BOB), people.atLend.bind(people), lentF).fields.password, "PW-BANK-0002-abcdefghij");
  assert.throws(() => open(lk, people.itemDir(BOB), people.at.bind(people), ordF), "not her ordinary items");
  assert.throws(() => open(lk, people.connDir(BOB), people.atConn.bind(people), conF), "not her connections");
  assert.throws(() => openItemV2(lk, people.at(BOB, "lk"), JSON.parse(fs.readFileSync(path.join(folder, "lk.json"), "utf8"))), "not the file that holds the key");
  // the connection key's seal does not open as a lend key, and Bob's lend wrap moved to Eve's place opens nothing
  assert.notEqual(openConnectionKey(sealRoot, BOB), null);
  const bobLend = wrapPath(sealRoot, BOB, "lend"), eveLend = wrapPath(sealRoot, EVE, "lend"), keep = fs.readFileSync(eveLend), keepBob = fs.readFileSync(bobLend);
  fs.copyFileSync(bobLend, eveLend);
  assert.equal(openConnectionKey(sealRoot, EVE, "lend"), null);
  fs.writeFileSync(eveLend, keep);
  fs.copyFileSync(wrapPath(sealRoot, BOB), bobLend);
  assert.equal(openConnectionKey(sealRoot, BOB, "lend"), null, "a connection wrap is not a lend wrap");
  fs.writeFileSync(bobLend, keepBob);
  // served from the sealed copy while she is locked; a reset rotates the key
  people.lock(BOB);
  const afterLock = people.lent(BOB);
  assert.equal((await afterLock.get("bank")).fields.password, "PW-BANK-0002-abcdefghij");
  assert.equal((await call("vault.me.get", { name: "bank" }, BOB)).error.code, "locked", "her own vault still needs the master password");
  await assert.rejects(() => people.lent(EVE).get("bank"), { code: "not_found" });
  const made = await call("vault.me.account.status", {}, BOB);
  assert.equal(made.data.unlocked, false);
  // unlending deletes the copy
  assert.deepEqual(await afterLock.remove("bank"), { removed: true });
  assert.deepEqual(await afterLock.names(), []);
  assert.deepEqual(await afterLock.remove("bank"), { removed: false });
  // leaving removes both seals
  people.destroy(BOB);
  assert.equal(openConnectionKey(sealRoot, BOB, "lend"), null); assert.equal(openConnectionKey(sealRoot, BOB), null);
  await assert.rejects(() => people.lent(BOB).get("bank"), { code: "locked" });
});

test("a reset rotates the lend key: the old sealed key opens nothing and the new one opens the copies", async t => {
  const sealRoot = fs.mkdtempSync(path.join(SCRATCH, "vyre-seal4-"));
  t.after(() => fs.rmSync(sealRoot, { recursive: true, force: true }));
  const { call, people } = rig(t, {}, { sealRoot });
  await call("vault.me.account.create", { password: PW }, BOB);
  await people.lent(BOB).put("bank", { kind: "login", fields: { password: "PW-BANK-0001-abcdefghij" } });
  const old = openConnectionKey(sealRoot, BOB, "lend");
  const [f] = fs.readdirSync(people.lendDir(BOB)).filter(x => x.endsWith(".json"));
  const rd = (/** @type {any} */ k) => openItemV2(k, people.atLend(BOB, f.slice(0, -5)), JSON.parse(fs.readFileSync(path.join(people.lendDir(BOB), f), "utf8")));
  assert.ok(rd(old));
  people.rotateLendKey(BOB, people.slot(BOB));
  assert.throws(() => rd(old), "the old key opens nothing now");
  assert.equal(rd(openConnectionKey(sealRoot, BOB, "lend")).fields.password, "PW-BANK-0001-abcdefghij");
});

test("vault.me.serve: only the daemon's door runs it, never as the owner, and it puts one AI key in the member's own vault and nothing else", async t => {
  const { reg, people } = rig(t);
  const run = (/** @type {any} */ i, caller = "module:vyred") => reg.get("vault.me.serve").run({ space: "spc_aaaaaaaaaaaa", ...i }, { caller }).then((/** @type {any} */ data) => ({ data }), (/** @type {any} */ error) => ({ error }));
  const KEY = "sk-ant-0123456789abcdef";
  assert.equal((await run({ call: "status", person: BOB }, "device:abcdefghijklmnop")).error.code, "denied", "a person's surface does not run it");
  assert.equal((await run({ call: "status", person: OWNER })).error.code, "denied", "never as the owner");
  assert.equal((await run({ call: "status", person: "../x" })).error.code, "denied");
  assert.deepEqual(Object.keys((await run({ call: "status", person: BOB })).data).sort().slice(0, 2), ["account", "unlocked"]);
  const made = (await run({ call: "create", person: BOB, input: { password: PW } })).data;
  assert.ok(made.secretKey, "the Secret Key comes back once, to their device");
  assert.equal((await run({ call: "put", person: BOB, input: { name: "My Claude", kind: "api-key", fields: { value: KEY } } })).data?.stored, undefined, "a locked vault takes nothing");
  assert.ok((await run({ call: "unlock", person: BOB, input: { password: PW, secretKey: made.secretKey } })).data);
  assert.deepEqual((await run({ call: "put", person: BOB, input: { name: "My Claude", kind: "api-key", fields: { value: KEY } } })).data, { stored: true, name: "My Claude" });
  const listed = (await run({ call: "list", person: BOB })).data;
  assert.deepEqual(listed.items, [{ name: "My Claude", kind: "api-key" }], "names and kinds only");
  assert.ok(!JSON.stringify(listed).includes(KEY));
  for (const bad of [{ name: "x", kind: "login", fields: { value: KEY } }, { name: "../x", kind: "api-key", fields: { value: KEY } }, { name: "ok", kind: "api-key", fields: { value: "short" } }, { name: "ok", kind: "api-key", fields: { value: KEY, other: "x" } }, { name: "ok", kind: "api-key", fields: { value: "has space inside key" } }]) {
    assert.equal((await run({ call: "put", person: BOB, input: bad })).error?.code, "bad_input", JSON.stringify(bad).slice(0, 60));
  }
  assert.equal((await run({ call: "list", person: EVE })).data?.items?.length ?? 0, 0, "another member's vault is theirs");
  assert.equal((await run({ call: "mystery", person: BOB })).error.code, "bad_input");
  assert.ok(people);
});
