// @ts-check
// A member's own # chip in a chat turn (vault.me.mention.search and .resolve): the Switchboard hands the asker (a person the kernel has already checked is in the chat); the answer comes from THAT person's own vault
// only, never the owner's, and is a name, a kind and a note, never a value. A locked vault says so in words the chat can show. Only the Switchboard asks, and never for the owner or for someone who is not a member.
import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "./me-mention.js";
import { yesFields, OP } from "../mention-yes.js";

const BOB = "per_bob", EVE = "per_eve", OWNER = "per_owner";
const canon = (/** @type {any} */ o) => JSON.stringify(Object.keys(o || {}).sort().map(k => [k, o[k]]));
/** A yes as her app would send it: bound to her, the op and the exact fields, with a nonce. */
const yesOf = (/** @type {string} */ person, /** @type {any} */ input, n = Math.random().toString(36), op = OP) => Buffer.from(JSON.stringify({ person, op, fields: yesFields(person, input), n })).toString("base64url");

function rig(over = /** @type {any} */ ({})) {
  const vaults = /** @type {Record<string, any[]>} */ ({ [BOB]: [{ name: "passport", kind: "login", description: "Passport portal", fields: ["username", "password"], updated: 1 }, { name: "clio-conn", kind: "connection", description: "connection to mcp.clio.test", fields: ["server_url"], updated: 2 }, { name: "bobs-api", kind: "api-credential", description: "Bob's API key", fields: ["config", "secret"], updated: 3 }, { name: "key", kind: "api-key", description: "", fields: ["value"], updated: 3 }, { name: "pk", kind: "passkey", description: "", fields: ["x"], updated: 4 }], [EVE]: [{ name: "airline", kind: "login", description: "", fields: ["password"], updated: 3 }] });
  const locked = new Set(/** @type {string[]} */ ([]));
  const people = { get: async (/** @type {string} */ id, /** @type {any} */ o) => ({ fields: o.name === "passport" ? { url: "https://passport.example.test/login" } : {} }), list: async (/** @type {string} */ id, /** @type {any} */ o = {}) => { if (locked.has(id)) throw Object.assign(new Error("your vault is locked: unlock it with your master password"), { code: "locked" }); const f = o.filter ? String(o.filter).toLowerCase() : ""; return { items: (vaults[id] || []).filter(i => !f || i.name.includes(f)) }; } };
  const reg = /** @type {Map<string, any>} */ (new Map());
  // the one verifier's behaviour: her key, this op, exactly these fields, spent once
  const spent = new Set(/** @type {string[]} */ ([]));
  const verifyYes = async (/** @type {string} */ person, /** @type {string} */ op, /** @type {any} */ fields, /** @type {any} */ p) => {
    if (!p || p.person !== person || p.op !== op || canon(p.fields) !== canon(fields)) return { ok: false, reason: "wrong_request" };
    if (spent.has(p.n)) return { ok: false, reason: "replayed" };
    spent.add(p.n); return { ok: true };
  };
  const ctx = { ...(over.noVerifier ? {} : { verifyYes }), kernel: { owner: OWNER, grants: { members: { list: async () => [{ person: BOB }, { person: EVE }] } }, chain: async () => ({ hops: [] }) } };
  /** @type {any[]} */ const lent = [], ended = [];
  const lend = { login: { shareAs: async (/** @type {string} */ o, /** @type {any} */ i) => { lent.push(["login", o, i]); return {}; }, endFor: async (/** @type {string} */ o, /** @type {string} */ t) => { ended.push(["login", o, t]); return 1; } },
    credential: { lend: async (/** @type {string} */ o, /** @type {any} */ i) => { lent.push(["credential", o, i]); return { credential: "lent-0123456789abcdef" }; }, endFor: async (/** @type {string} */ o, /** @type {string} */ t) => { ended.push(["credential", o, t]); return 1; } },
    connection: { lendTurn: async (/** @type {string} */ ...a) => { lent.push(["connection", ...a]); return {}; }, endTurn: async (/** @type {string} */ o, /** @type {string} */ t) => { ended.push(["connection", o, t]); return 1; } } };
  /** @type {Map<string, any>} */ const defs = new Map();
  register({ ctx, people: /** @type {any} */ (people), internal: (n, _d, _i, run) => reg.set(n, { run }), define: (n, d) => { defs.set(n, d); reg.set(n, { run: d.run }); }, now: () => 1_000_000, lend: over.lend === null ? {} : lend });
  // a lend carries a valid yes unless the test says otherwise (yes: null leaves it off)
  const ask = (/** @type {string} */ tool, /** @type {any} */ input, caller = "module:threads") => {
    if (tool !== "vault.me.mention.lend") return reg.get(tool).run(input, { caller });
    const { yes, ...rest } = input;
    return reg.get(tool).run(yes === null ? rest : { ...rest, yes: yes === undefined ? yesOf(String(rest.asker), rest) : yes }, { caller });
  };
  return { ask, locked, reg, lent, ended, defs };
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

test("tagging her own item lends it to that chat's agent for this turn only: Fill in, her item, never the owner's, with her signed yes required", async () => {
  const { ask, lent, ended, defs } = rig();
  const L = { asker: BOB, thread: "thread_1", agent: "kit" };
  const login = await ask("vault.me.mention.lend", { ...L, id: "passport" });
  assert.equal(login.lent, true); assert.equal(login.until, 1_000_000 + 30 * 60_000, "a short expiry as the backstop");
  assert.deepEqual(lent[0], ["login", BOB, { item: "passport", agent: "kit", origin: "https://passport.example.test/login", expires: 1_000_000 + 30 * 60_000, sessions: ["thread_1"] }], "held to the thread, for her item, at the site saved in it");
  await ask("vault.me.mention.lend", { ...L, id: "clio-conn" });
  assert.deepEqual(lent[1], ["connection", BOB, "clio-conn", "kit", "thread_1", 1_000_000 + 30 * 60_000]);
  assert.ok(defs.get("vault.me.mention.lend").presence && typeof defs.get("vault.me.mention.lend").presence.summary === "function", "her presence is asked for, once, at the tag");
  assert.match(await defs.get("vault.me.mention.lend").presence.summary({ id: "passport", agent: "kit" }), /kit.*passport.*without seeing/i);
  assert.deepEqual(await ask("vault.me.mention.end", { asker: BOB, thread: "thread_1" }), { ended: 3 });
  assert.deepEqual(ended, [["connection", BOB, "thread_1"], ["login", BOB, "thread_1"], ["credential", BOB, "thread_1"]]);
});

test("what is not lent: another member's item, the owner's, a key, a passkey; a login with no site asks which; only the Switchboard; an agent named by the chat text is not an agent", async () => {
  const { ask, lent } = rig();
  const L = { asker: BOB, thread: "thread_1", agent: "kit" };
  for (const id of ["airline", "stripe", "ghost"]) await assert.rejects(ask("vault.me.mention.lend", { ...L, id }), { code: "not_found" }, id);
  for (const id of ["key", "pk"]) await assert.rejects(ask("vault.me.mention.lend", { ...L, id }), { code: "bad_input" }, id);
  await assert.rejects(ask("vault.me.mention.lend", { asker: EVE, thread: "t", agent: "kit", id: "airline" }), { code: "bad_input" }, "Eve's airline login has no site saved: it asks which");
  await assert.rejects(ask("vault.me.mention.lend", { asker: OWNER, thread: "t", agent: "kit", id: "passport" }), { code: "denied" });
  for (const agent of ["assistant", "Kit; rm", "", "x".repeat(60)]) await assert.rejects(ask("vault.me.mention.lend", { ...L, id: "passport", agent }), { code: "bad_input" }, agent);
  await assert.rejects(ask("vault.me.mention.lend", { ...L, id: "passport", thread: "bad thread!" }), { code: "bad_input" });
  for (const c of ["module:switchboard", "module:sessions", "module:assistant", "module:mentions", "cli", "mcp", "mcp:agent:kit"]) await assert.rejects(ask("vault.me.mention.lend", { ...L, id: "passport" }, c), { code: "denied" }, c);
  for (const c of ["module:switchboard", "module:sessions", "module:assistant", "cli", "mcp"]) await assert.rejects(ask("vault.me.mention.end", { asker: BOB, thread: "t" }, c), { code: "denied" }, c);
  assert.equal(lent.length, 0, "nothing was lent by any refused call");
});

test("a locked vault cannot lend; no lend backend means nothing is lent, in words", async () => {
  const { ask, locked } = rig();
  locked.add(BOB);
  await assert.rejects(ask("vault.me.mention.lend", { asker: BOB, thread: "t", agent: "kit", id: "passport" }), { code: "locked" });
  const none = rig({ lend: null });
  await assert.rejects(none.ask("vault.me.mention.lend", { asker: BOB, thread: "t", agent: "kit", id: "passport", origin: "https://x.example.test" }), { code: "unavailable" });
});


// ---- her yes at the tag: every half (login, connection, API key) refuses without it ----
const HALVES = /** @type {[string, string][]} */ ([["login", "passport"], ["connection", "clio-conn"], ["api-credential", "bobs-api"]]);

for (const [half, id] of HALVES) {
  test(`${half}: no yes lends nothing; a yes for another item, thread, agent or person lends nothing; a replayed yes lends nothing; a valid yes lends once`, async () => {
    const { ask, lent } = rig();
    const L = { asker: BOB, thread: "thread_1", agent: "kit", id, origin: "https://passport.example.test/login" };
    await assert.rejects(ask("vault.me.mention.lend", { ...L, yes: null }), { code: "presence_required" }, "none");
    await assert.rejects(ask("vault.me.mention.lend", { ...L, yes: "" }), { code: "presence_required" }, "empty");
    await assert.rejects(ask("vault.me.mention.lend", { ...L, yes: "not a proof" }), { code: "presence_required" }, "junk");
    for (const [what, other] of [["item", { id: "key" }], ["thread", { thread: "thread_2" }], ["agent", { agent: "juno" }], ["origin", { origin: "https://evil.example.test" }]]) {
      await assert.rejects(ask("vault.me.mention.lend", { ...L, yes: yesOf(BOB, { ...L, ...other }) }), { code: "presence_required" }, `a yes for another ${what}`);
    }
    await assert.rejects(ask("vault.me.mention.lend", { ...L, yes: yesOf(EVE, { ...L, asker: EVE }) }), { code: "presence_required" }, "another person's yes");
    await assert.rejects(ask("vault.me.mention.lend", { ...L, yes: yesOf(BOB, L, "n1", "vault.reveal") }), { code: "presence_required" }, "a yes for another act");
    assert.equal(lent.length, 0, "nothing was lent by any refusal");
    const yes = yesOf(BOB, L, "once");
    assert.equal((await ask("vault.me.mention.lend", { ...L, yes })).lent, true);
    assert.equal(lent.length, 1);
    await assert.rejects(ask("vault.me.mention.lend", { ...L, yes }), { code: "presence_required" }, "the same yes again");
    assert.equal(lent.length, 1, "a replay lends nothing more");
  });
}

test("a server with no way to check a yes refuses every lend: it fails closed", async () => {
  const { ask, lent } = rig({ noVerifier: true });
  for (const [, id] of HALVES) await assert.rejects(ask("vault.me.mention.lend", { asker: BOB, thread: "t", agent: "kit", id, origin: "https://passport.example.test/login" }), { code: "presence_required" }, id);
  assert.equal(lent.length, 0);
});
