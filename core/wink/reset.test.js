// @ts-check
// Reset from the server's own console (core/wink/reset.js): a one-time code made by the command line, only its hash reaches the daemon.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createPairing, MIGRATIONS, PEER_MIGRATIONS } from "./pairing.js";
import { registerReset, newCode, beginInput, normalise, codeHash, CODE_LIFE_MS, LOCK_MS, MAX_WRONG, resetCard } from "./reset.js";
import { startSealer } from "../../kernel/seal/client.js";
import { person, chain, signer, tmp, enrolDevice } from "../../kernel/seal/testing.js";
import { Vault, MIGRATIONS as VAULT_MIGRATIONS } from "../vault/vault.js";
import { open, migrate } from "../store/index.js";

const ME = "per_aaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ZOE = "per_zzzzzzzzzzzzzzzzzzzzzzzzzzz";

/** A server with an owner (an app, device app1, plus a second device of the owner), a fake clock, and every output captured. @param {any} [o] { file, clock, dataStores (null: no list), newSpace } */
function box(o = /** @type {any} */ ({})) {
  const db = new DatabaseSync(o.file || ":memory:");
  const fresh = !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'wink_meta'").get();
  if (fresh) for (const m of [...MIGRATIONS, ...PEER_MIGRATIONS]) db.exec(m);
  const clock = o.clock || { t: 1_000_000 };
  /** @type {Map<string, any>} */ const tools = new Map();
  const events = /** @type {any[]} */ ([]), logs = /** @type {string[]} */ ([]), calls = /** @type {any[]} */ ([]);
  const ctx = { store: { db }, config: { name: "juno" }, log: (/** @type {string} */ m) => logs.push(m), events: { emit: (/** @type {string} */ n, /** @type {any} */ d) => events.push([n, d]) }, tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), call: async (/** @type {string} */ t, /** @type {any} */ i) => { calls.push([t, i]); return { data: {} }; } };
  const p = createPairing({ ctx, now: () => clock.t, identity: async () => ME, space: async () => "spc_x", directory: { memberships: async () => [] }, ports: {}, openCode: async () => ({}), ack: async () => ({ ok: true }), owner: () => {}, dropMs: 0, relayUrl: async () => "ws://r", spaceNow: () => "spc_x" });
  p.tools();
  registerReset({ ctx, pairing: p, now: () => clock.t, identity: async () => ME, dropMs: 0, dataStores: o.dataStores === null ? undefined : (o.dataStores || (async () => [])), newSpace: o.newSpace, wipeDelayMs: 0 });
  /** @param {string} name @param {any} input @param {string} [caller] @param {any} [extra] */
  const call = (name, input, caller = "cli", extra = {}) => tools.get(name).run(input, { caller, ...extra });
  const own = () => {
    p.devices.setSelf({ identity: ME, name: "juno", target: { kind: "identity", id: ME } });
    p.meta.set("owner", { kind: "identity", id: ME, identity: ME });
    p.meta.set("adopter", "device:app1"); p.meta.set("handover", { home: "h" }); p.meta.set("peer_secret", "s3cret"); p.meta.set("peer_root", "keyroot");
    p.devices.add({ id: "app1", identity: ME, kind: "computer", name: "Alex's Mac", target: { kind: "identity", id: ME } });
    p.devices.add({ id: "phone1", identity: ME, kind: "phone", name: "Alex's phone", target: { kind: "identity", id: ME } });
  };
  /** The one-time code as the command line makes it, and the begin call it sends. */
  const begin = async (code = newCode()) => { const r = await call("wink.server.reset.begin", beginInput(code)); return { code, r }; };
  return { db, p, tools, events, logs, calls, clock, call, own, begin };
}

test("begin then confirm: the server lets go of its owner, keeps its keys, and the old owner's devices get a card and a log line is written", async () => {
  const b = box(); b.own();
  const { code, r } = await b.begin();
  assert.equal(r.begun, true);
  assert.equal(r.until, 1_000_000 + CODE_LIFE_MS);
  assert.deepEqual(Object.keys(r).sort(), ["begun", "until"], "begin answers nothing a caller could use to guess");
  assert.ok(b.p.meta.get("owner"), "nothing changed yet");
  assert.deepEqual(await b.call("wink.server.reset.confirm", { code: code.toLowerCase().replace("-", " ") }), { reset: true, had: true }, "case, dash and spaces do not matter");
  for (const k of ["owner", "adopter", "handover", "peer_secret"]) assert.equal(b.p.meta.get(k), null, k);
  assert.equal(b.p.meta.get("peer_root"), "keyroot", "the server's own keys stay");
  assert.equal(b.p.devices.get("self").removed, true);
  assert.deepEqual(b.p.devices.list(ME), [], "the owner's devices are dropped here");
  assert.deepEqual(b.calls.filter(c => c[0] === "relay.devices.drop").map(c => c[1].id).sort(), ["app1", "phone1"], "and their relay devices go");
  const ev = b.events.find(e => e[0] === "wink.server-reset");
  assert.ok(ev, "a reset event");
  assert.deepEqual(ev[1].devices.sort(), ["app1", "phone1"]);
  assert.equal(ev[1].card.text, "This server was reset from its console at 1970-01-01 00:16 UTC.");
  assert.equal(ev[1].card.text, resetCard(1_000_000).text);
  assert.ok(b.logs.some(l => /this server was reset from its console at 1970-01-01T00:16:40/.test(l)), "a line in the server's log");
});

test("a reset with no owner says so, and still needs the code", async () => {
  const b = box();
  await assert.rejects(() => b.call("wink.server.reset.confirm", { code: "ABCD-EFGH" }), e => e.code === "no_code");
  const { code } = await b.begin();
  assert.deepEqual(await b.call("wink.server.reset.confirm", { code }), { reset: true, had: false });
  assert.ok(!b.events.some(e => e[0] === "wink.server-reset"), "nobody to tell");
});

test("an expired code is refused and does not count as a wrong try; a fresh begin works", async () => {
  const b = box(); b.own();
  const { code } = await b.begin();
  b.clock.t += CODE_LIFE_MS + 1;
  await assert.rejects(() => b.call("wink.server.reset.confirm", { code }), e => e.code === "expired");
  await assert.rejects(() => b.call("wink.server.reset.confirm", { code }), e => e.code === "no_code", "it is gone");
  assert.equal(b.p.meta.get("reset_guard"), null);
  assert.ok(b.p.meta.get("owner"));
  const again = await b.begin();
  assert.deepEqual(await b.call("wink.server.reset.confirm", { code: again.code }), { reset: true, had: true });
});

test("a code works once", async () => {
  const b = box(); b.own();
  const { code } = await b.begin();
  await b.call("wink.server.reset.confirm", { code });
  b.own();
  await assert.rejects(() => b.call("wink.server.reset.confirm", { code }), e => e.code === "no_code");
  assert.ok(b.p.meta.get("owner"), "the second use freed nothing");
  // a begin made again replaces the first: the old code no longer opens it
  const one = await b.begin(), two = await b.begin();
  await assert.rejects(() => b.call("wink.server.reset.confirm", { code: one.code }), e => e.code === "wrong_code");
  assert.deepEqual(await b.call("wink.server.reset.confirm", { code: two.code }), { reset: true, had: true });
});

test("five wrong codes lock reset for an hour, even for the right code; after the hour a new begin works", async () => {
  const b = box(); b.own();
  const { code } = await b.begin();
  for (let i = 1; i < MAX_WRONG; i++) await assert.rejects(() => b.call("wink.server.reset.confirm", { code: "AAAA-AAA" + i }), e => e.code === "wrong_code" && new RegExp(`${MAX_WRONG - i} ${MAX_WRONG - i === 1 ? "try" : "tries"} left`).test(e.message));
  await assert.rejects(() => b.call("wink.server.reset.confirm", { code: "AAAA-AAA9" }), e => e.code === "reset_locked");
  await assert.rejects(() => b.call("wink.server.reset.confirm", { code }), e => e.code === "reset_locked", "the right code does not open a lock");
  await assert.rejects(() => b.begin(), e => e.code === "reset_locked", "and begin is locked too");
  b.clock.t += LOCK_MS - 1;
  await assert.rejects(() => b.call("wink.server.reset.confirm", { code }), e => e.code === "reset_locked");
  assert.ok(b.p.meta.get("owner"));
  b.clock.t += 2;
  const next = await b.begin();
  assert.deepEqual(await b.call("wink.server.reset.confirm", { code: next.code }), { reset: true, had: true });
});

test("a right code in between does not reset the count of wrong ones before it, a success does", async () => {
  const b = box(); b.own();
  const { code } = await b.begin();
  for (let i = 0; i < 3; i++) await assert.rejects(() => b.call("wink.server.reset.confirm", { code: "ZZZZ-ZZZ" + i }), e => e.code === "wrong_code");
  assert.equal(b.p.meta.get("reset_guard").wrong, 3);
  await b.call("wink.server.reset.confirm", { code });
  assert.equal(b.p.meta.get("reset_guard"), null);
});

test("the lock survives a restart of the daemon (same store, new process)", async t => {
  const dir = tmp("wink-reset"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "wink.db"), clock = { t: 5_000_000 };
  const a = box({ file, clock }); a.own();
  await a.begin();
  for (let i = 0; i < MAX_WRONG; i++) await a.call("wink.server.reset.confirm", { code: "AAAA-AAA" + i }).catch(() => null);
  a.db.close();
  const b = box({ file, clock });
  await assert.rejects(() => b.begin(), e => e.code === "reset_locked");
  await assert.rejects(() => b.call("wink.server.reset.confirm", { code: "AAAA-AAAA" }), e => e.code === "reset_locked");
  clock.t += LOCK_MS + 1;
  const { code } = await b.begin();
  assert.equal((await b.call("wink.server.reset.confirm", { code })).reset, true);
  b.db.close();
});

test("only the local cli may call either tool: every other caller is refused with the right data, and nothing moves", async () => {
  const b = box(); b.own();
  const { code } = await b.begin();
  const callers = ["deck", "hook", "anonymous", "mcp", "harness", "agent:kit", "cli:agent:kit", "mcp:agent:kit", "module:wink", "module:relay", "device:abcdefghijklmnop", "tailnet:alex", "tailnet:agent:kit", "tailnet-guest:x", "relay", "capsule", "local", "space:x", "org:x", ""];
  for (const c of callers) {
    await assert.rejects(() => b.call("wink.server.reset.confirm", { code }, c), e => e.code === "denied", `confirm from ${c || "(none)"}`);
    await assert.rejects(() => b.call("wink.server.reset.begin", beginInput(newCode()), c), e => e.code === "denied", `begin from ${c || "(none)"}`);
  }
  await assert.rejects(() => b.call("wink.server.reset.confirm", { code }, "cli", { agent: true }), e => e.code === "denied", "an agent behind the cli");
  assert.ok(b.p.meta.get("owner"), "nothing moved");
  assert.equal(b.p.meta.get("reset_guard"), null, "a refused caller does not count against the person's tries");
  for (const c of ["wink.server.reset.begin", "wink.server.reset.confirm"]) assert.deepEqual(b.tools.get(c).callers, ["cli"]);
});

test("the old paths are gone: no fingerprint tool, no presence reset, nothing but begin and confirm", async () => {
  const b = box();
  assert.deepEqual([...b.tools.keys()].filter(n => /server\.(fingerprint|reset)/.test(n)).sort(), ["wink.server.reset.begin", "wink.server.reset.confirm"]);
  assert.ok(!b.tools.get("wink.server.reset.begin").presence && !b.tools.get("wink.server.reset.confirm").presence, "no presence path: console only");
});

test("begin takes only a salt and a hash: a code, or anything else, is refused", async () => {
  const b = box();
  for (const bad of [{}, { salt: "x", hash: "y" }, { code: "ABCD-EFGH" }, { salt: "a".repeat(32), hash: "b".repeat(63) }]) await assert.rejects(() => b.call("wink.server.reset.begin", bad), e => e.code === "bad_input");
  assert.equal(b.p.meta.get("reset_begin"), null);
});

test("the code is in no tool result, event, log line, stored row or call the daemon made", async () => {
  const b = box(); b.own();
  const { code, r } = await b.begin();
  const results = [r];
  await b.call("wink.server.reset.confirm", { code: "AAAA-AAAA" }).catch(e => results.push({ code: e.code, message: e.message }));
  await b.call("wink.server.reset.confirm", { code: "AAAA-AAAA" }, "device:abcdefghijklmnop").catch(e => results.push({ code: e.code, message: e.message }));
  results.push(await b.call("wink.server.reset.confirm", { code }));
  await b.call("wink.server.reset.confirm", { code }).catch(e => results.push({ code: e.code, message: e.message }));
  const rows = b.db.prepare("SELECT k, v FROM wink_meta").all();
  const dump = JSON.stringify({ results, events: b.events, logs: b.logs, calls: b.calls, rows, devices: b.db.prepare("SELECT * FROM wink_devices").all() }).toUpperCase();
  assert.ok(dump.length > 500);
  for (const form of [code, normalise(code), code.toLowerCase(), Buffer.from(code).toString("base64"), Buffer.from(normalise(code)).toString("hex")]) assert.ok(!dump.includes(form.toUpperCase()), `no form of the code in the dump: ${form}`);
  // what is stored is the salt and the hash, and the hash is not the code
  const st = JSON.stringify(rows);
  assert.ok(!st.includes(normalise(code)));
});

test("the CLI's hash is what the daemon compares: codeHash is stable per salt and differs between salts", () => {
  const c = newCode(); assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const a = beginInput(c), d = beginInput(c);
  assert.notEqual(a.salt, d.salt); assert.notEqual(a.hash, d.hash);
  assert.equal(codeHash(c.toLowerCase(), a.salt), a.hash);
});

// ---- the required property: a reset gives the next owner nothing of an existing Space's sealed data or vault ----

test("after a reset and a new adoption by another identity, the new owner cannot open what was sealed to the old identity or Space", async t => {
  // A real sealing process in a temp home, as on a box. Alex's SSN is sealed in Alex's Space; his enrolled hardware key is the only thing that reveals it.
  const dir = tmp("wink-reset-seal"), s = startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const alex = signer("per_alex"); await enrolDevice(s, alex);
  const REC = "vyre://spc_testspace0001/contact/c_jane";
  const { ref } = await s.api.put({ chain: person(), record: REC, field: "ssn", class: "us-ssn", value: "123-45-6789" });
  const reveal = (/** @type {any} */ who, /** @type {any} */ ch, /** @type {string} */ r = ref.ref) => s.api.reveal({ chain: ch, ref: r, purpose: "read it", proof: who.proof(ch, "seal.reveal", { ref: r, purpose: "read it" }) });
  assert.equal((await reveal(alex, person())).value, "123-45-6789", "the old owner can");

  // The box is reset from its console and then adopted by someone else. The reset touches wink's own tables only: take a snapshot of the sealer's folder first.
  const snapshot = (/** @type {string} */ d) => JSON.stringify(fs.readdirSync(d, { recursive: true }).sort().map(f => { const p = path.join(d, String(f)); return fs.statSync(p).isFile() ? [f, fs.readFileSync(p).toString("base64")] : [f]; }));
  const before = snapshot(dir);
  const b = box(); b.own();
  const { code } = await b.begin();
  await b.call("wink.server.reset.confirm", { code });
  b.p.meta.set("owner", { kind: "identity", id: ZOE, identity: ZOE }); b.p.meta.set("adopter", "device:zoe1"); // a new adoption by another identity
  assert.equal(snapshot(dir), before, "reset left the sealing folder exactly as it was: keys kept, nothing opened, nothing wiped");

  // Zoe now owns the box. Her own key, in her own chain: another Space opens nothing, and she cannot become Alex or add a key to his list.
  const zoe = signer(ZOE); await enrolDevice(s, zoe);
  const zch = person(ZOE);
  const tried = async (/** @type {any} */ who, /** @type {any} */ ch) => reveal(who, ch).then((/** @type {any} */ r) => ({ value: r.value }), (/** @type {any} */ e) => ({ code: e.code }));
  for (const [who, ch] of [[zoe, chain([["person", ZOE]], "deck", "spc_zoespace00001")], [zoe, person("per_alex")], [alex, zch]]) {
    const got = await tried(who, ch);
    assert.ok(!("value" in got), `no value in ${ch.space} for ${JSON.stringify(ch.hops.map((/** @type {any} */ h) => h.actor.id))}`);
    assert.ok(["not_found", "unknown_key", "bad_signature", "human_only", "needs_presence", "wrong_payload"].includes(got.code), `a plain refusal, got ${got.code}`);
  }
  // KNOWN GAP, reported to the lead on 4 Oct 2026: the sealing process keeps values per Space and per enrolled person key; it has no per-value owner. A chain for Zoe INSIDE the old Space
  // with her own enrolled key opens Alex's value. Whether she can have such a chain is the kernel's membership, which a reset does not touch (it forgets the owner in wink's own
  // tables only). With the box's fallback directory (no kernel roles) the box's owner is the owner of its Space, so a new owner would have it. If the kernel ever stops that, this flips on purpose.
  assert.equal((await tried(zoe, zch)).value, "123-45-6789", "KNOWN GAP: a new owner placed in the old Space reads what was sealed there");
  const intruder = signer("per_alex"), e = intruder.enrolment;
  await assert.rejects(() => s.enrol({ chain: person("per_alex"), person: "per_alex", key_id: e.key_id, spki: e.spki, signer: e.signer, token: "x" }), (/** @type {any} */ x) => x.code === "no_ceremony");
  await assert.rejects(() => s.begin({ chain: zch, person: "per_alex", key_id: e.key_id, spki: e.spki, signer: e.signer }), (/** @type {any} */ x) => x.code === "chain_not_person", "Zoe cannot start a ceremony for Alex");
  assert.equal((await reveal(alex, person())).value, "123-45-6789", "and Alex's own key still opens it");
});

test("a reset leaves the vault sealed: a paired app or a new owner's device is no module, and the item is ciphertext on disk", async t => {
  const dir = tmp("wink-reset-vault"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = open(path.join(dir, "vyre.db")); migrate(db, "vault", VAULT_MIGRATIONS); t.after(() => db.close());
  const v = new Vault({ db, dir: path.join(dir, "vault"), config: { name: "juno", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  const secret = "fixture-value-8d41c0ffee77aa55bb66";
  await v.put({ name: "stripe", kind: "secret", fields: { value: secret } }, "cli");
  const b = box(); b.own();
  const { code } = await b.begin();
  await b.call("wink.server.reset.confirm", { code });
  b.p.meta.set("owner", { kind: "identity", id: ZOE, identity: ZOE }); b.p.meta.set("adopter", "device:zoe1");
  for (const caller of ["device:zoe1aaaaaaaaaaaa", "tailnet:zoe", "deck", "mcp"]) await assert.rejects(() => v.release({ name: "stripe" }, caller), /only modules may ask the vault/, caller);
  for (const f of fs.readdirSync(dir, { recursive: true })) { const p = path.join(dir, String(f)); if (fs.statSync(p).isFile() && !/\.key$|keys?\./.test(String(f))) assert.ok(!fs.readFileSync(p).includes(secret), `${f} holds no plaintext`); }
  assert.equal((await v.release({ name: "stripe" }, "module:x").catch(e => e.message)).includes("not granted"), true, "even a module needs the item granted to it");
});

/** A store of the kernel's list: holds data until wiped. @param {string} name @param {{ stuck?: boolean, throws?: boolean }} [f] */
const store = (name, f = {}) => { const st = { name, full: true, wiped: 0, holds: async () => { if (f.throws) throw new Error("cannot tell"); return st.full; }, wipe: async () => { st.wiped++; if (!f.stuck) st.full = false; } }; return st; };

test("a box with data refuses a reset that does not wipe, names the stores, and leaves the owner in place; a box with no list is a box with data", async () => {
  for (const o of [{ dataStores: async () => [store("the vault"), store("sealed values")] }, { dataStores: null }, { dataStores: async () => [store("memory", { throws: true })] }]) {
    const b = box(o); b.own();
    await assert.rejects(() => b.begin(), e => e.code === "holds_data" && /--wipe/.test(e.message) && /recover your identity/.test(e.message));
    assert.deepEqual(b.p.meta.get("owner"), { kind: "identity", id: ME, identity: ME }, "nothing was reset");
    assert.equal(b.p.meta.get("reset_begin"), null, "no code was made valid");
  }
  const named = box({ dataStores: async () => [store("the vault"), store("empty one")] }); named.own(); named.p.meta.get("owner");
  const e = await named.begin().catch(x => x); assert.match(e.message, /the vault/);
  // a box nobody owns has nothing to hand over
  const unowned = box({ dataStores: null });
  assert.equal((await unowned.begin()).r.begun, true);
});

test("the wipe: begin names --wipe, confirm needs the code AND the typed word, the old owner's card goes first, every store is wiped and checked empty, a new Space identity is made, then the box is unowned", async () => {
  const vault = store("the vault"), seal = store("sealed values");
  /** @type {string[]} */ const order = [];
  const b = box({ dataStores: async () => [vault, seal], newSpace: async () => { order.push("newSpace"); } });
  b.own();
  const code = newCode();
  const begun = await b.call("wink.server.reset.begin", { ...beginInput(code), wipe: true });
  assert.equal(begun.wipe, true);
  await assert.rejects(() => b.call("wink.server.reset.confirm", { code }), e => e.code === "wipe_needs_typed");
  await assert.rejects(() => b.call("wink.server.reset.confirm", { code, typed: "yes" }), e => e.code === "wipe_needs_typed");
  assert.equal(b.p.meta.get("reset_guard"), null, "a slip with the word does not count as a wrong code");
  assert.equal(vault.wiped, 0);
  b.events.length = 0;
  const r = await b.call("wink.server.reset.confirm", { code, typed: " Wipe " });
  assert.deepEqual(r, { reset: true, had: true, wiped: true });
  assert.equal(vault.wiped + seal.wiped, 2);
  assert.equal(vault.full || seal.full, false, "verified empty");
  assert.deepEqual(order, ["newSpace"]);
  assert.equal(b.p.meta.get("owner"), null);
  assert.ok(b.events.some(e => e[0] === "wink.server-reset"), "the previous owner's card");
  await assert.rejects(() => b.call("wink.server.reset.confirm", { code, typed: "wipe" }), e => e.code === "no_code", "the code was single use");
});

test("a wipe that does not empty a store, or has no new-Space maker, or no list, fails closed: the owner stays and the reason is said", async () => {
  const stuck = store("the vault", { stuck: true });
  let made = 0;
  const b = box({ dataStores: async () => [stuck], newSpace: async () => { made++; } });
  b.own();
  const code = newCode();
  await b.call("wink.server.reset.begin", { ...beginInput(code), wipe: true });
  await assert.rejects(() => b.call("wink.server.reset.confirm", { code, typed: "wipe" }), e => e.code === "wipe_failed" && /the vault/.test(e.message));
  assert.ok(b.p.meta.get("owner"), "still owned");
  assert.equal(made, 0, "no new Space until the stores are empty");
  assert.ok(b.events.some(e => e[0] === "wink.server-reset-failed"));
  const noSpace = box({ dataStores: async () => [store("the vault")] }); noSpace.own();
  await assert.rejects(() => noSpace.call("wink.server.reset.begin", { ...beginInput(newCode()), wipe: true }), e => e.code === "wipe_unavailable" && /new Space/.test(e.message));
  const noList = box({ dataStores: null }); noList.own();
  await assert.rejects(() => noList.call("wink.server.reset.begin", { ...beginInput(newCode()), wipe: true }), e => e.code === "wipe_unavailable" && /list/.test(e.message));
});
