// @ts-check
// The identity-name client against the real directory Worker on the fake runtime: claim an identity chain, resolve and re-verify it, notice a
// stale or different list against the pin, refuse a substituted record, and alias, release and add owners through the client.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker, * as W from "../../names/worker/index.js";
import { createRuntime } from "../../relay/worker/fake-cf.js";
import { fakeDns } from "../../names/worker/fake-dns.js";
import * as ids from "./directory.js";
import * as C from "../../kernel/identity/chain.js";

function world(t) {
  const dns = fakeDns();
  const clock = { t: Date.UTC(2026, 9, 3, 12, 0, 0) };
  const txt = new Map();
  const rt = createRuntime({ worker, Class: W.Directory, classes: { DIRECTORY: W.Directory },
    env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, NOW: () => clock.t, ZONE: "vyre.run", RESOLVE_TXT: async n => txt.get(n) || [] } });
  t.after(async () => { await rt.settle(); assert.deepEqual(rt.errors.map(String), []); });
  const fetch = async (url, init) => worker.fetch(new Request(url, { ...init, headers: { ...(init.headers || {}), "cf-connecting-ip": "203.0.113.9" } }), rt.env);
  const dir = ids.idDirectory({ base: "http://127.0.0.1:1", fetch, now: () => clock.t });
  /** A person: a device key and its genesis chain. */
  const person = async () => {
    const signer = ids.memorySigner(crypto.generateKeyPairSync("ed25519").privateKey);
    const g = await C.makeGenesis({ kind: "person", entry: { eid: signer.eid, kind: "device", pub: signer.publicKey }, nonce: crypto.randomBytes(8).toString("base64url"), ts: clock.t, sign: signer.sign });
    const state = await C.verifyChain([g], { now: clock.t });
    return { signer, ops: [g], state };
  };
  return { clock, txt, dir, person };
}

test("ids client: sealing is for the name, tamper-evident and bounded", () => {
  const s = ids.sealRecord("alex", { v: 1, relay: "r1" });
  assert.deepEqual(ids.openRecord("alex", s), { v: 1, relay: "r1" });
  assert.equal(ids.openRecord("kit", s), null, "another name cannot open it");
  const raw = Buffer.from(s, "base64url"); raw[20] ^= 1;
  assert.equal(ids.openRecord("alex", raw.toString("base64url")), null, "a changed byte");
  assert.throws(() => ids.sealRecord("alex", { pad: "x".repeat(4000) }), /too large/);
  assert.notEqual(ids.sealRecord("alex", { v: 1 }), ids.sealRecord("alex", { v: 1 }), "fresh randomness each time");
});

test("ids client: claim, then anyone resolves and re-verifies the chain, and a pinned head must still be on it", async t => {
  const w = world(t), alex = await w.person();
  const c = await w.dir.claim("alex", alex.state, alex.ops, alex.signer, { v: 1, relay: { route: "abc" } });
  assert.equal(c.mine, true);
  assert.equal(c.id, alex.state.id);
  const r = await w.dir.resolve("alex");
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload, { v: 1, relay: { route: "abc" } });
  assert.equal(r.id, alex.state.id);
  assert.deepEqual(r.pin, C.pinOf(alex.state));
  assert.equal((await w.dir.resolve("alex", { pin: r.pin })).ok, true);
  // a pin for another identity, and one for a head that is not on this list
  const other = await w.person();
  assert.equal((await w.dir.resolve("alex", { pin: C.pinOf(other.state) })).code, "other_id");
  assert.equal((await w.dir.resolve("alex", { pin: { ...r.pin, head: "0".repeat(64) } })).code, "fork", "the op at the pinned place is not the one the client trusted");
  await assert.rejects(() => w.dir.resolve("nobody"), e => /** @type {any} */ (e).code === "not_found");
});

test("ids client: a list that grew is taken; a shorter or different one is refused", async t => {
  const w = world(t), alex = await w.person();
  await w.dir.claim("alex", alex.state, alex.ops, alex.signer, { v: 1 });
  const first = await w.dir.resolve("alex");
  const laptop = ids.memorySigner(crypto.generateKeyPairSync("ed25519").privateKey);
  w.clock.t += 1000;
  const op = await C.makeOp(alex.state, { type: "add", entry: { eid: laptop.eid, kind: "device", pub: laptop.publicKey } }, { by: alex.signer.eid, ts: w.clock.t, sign: alex.signer.sign });
  await w.dir.append("alex", [op]);
  const grown = await w.dir.resolve("alex", { pin: first.pin });
  assert.equal(grown.ok, true);
  assert.equal(grown.advanced, true);
  assert.equal(grown.state.entries.length, 2);
  // the client holds the longer pin; a replay of the shorter chain would be "stale" (chain.test covers the check itself, here through verifyResolved)
  const stale = await ids.verifyResolved("alex", { name: "alex", kind: "person", id: alex.state.id, ops: alex.ops, sealed: "", rec: null }, grown.pin, { now: w.clock.t });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, "stale");
});

test("ids client: a record the directory altered, or signed by an entry that is not on the list, is refused by the client", async t => {
  const w = world(t), alex = await w.person(), mallory = await w.person();
  await w.dir.claim("alex", alex.state, alex.ops, alex.signer, { v: 1, home: "h" });
  const good = await w.dir.resolve("alex");
  assert.equal(good.ok, true);
  const raw = { name: "alex", kind: "person", id: alex.state.id, ops: alex.ops, aliases: [] };
  const sealedEvil = ids.sealRecord("alex", { v: 1, home: "evil" });
  // a swapped record under the old signature
  const r1 = await ids.verifyResolved("alex", { ...raw, sealed: sealedEvil, rec: { by: alex.signer.eid, ts: w.clock.t, sig: "A".repeat(86) } }, undefined, { now: w.clock.t });
  assert.equal(r1.ok, false, "a substituted record does not verify");
  // a record signed by a key that is not on the list
  const sealed = ids.sealRecord("alex", { v: 1, home: "mine" });
  const sig = Buffer.from(await mallory.signer.sign(ids.recordMessage({ name: "alex", id: alex.state.id, by: mallory.signer.eid, ts: w.clock.t, sealedHash: crypto.createHash("sha256").update(sealed).digest("hex") }))).toString("base64url");
  const r2 = await ids.verifyResolved("alex", { ...raw, sealed, rec: { by: mallory.signer.eid, ts: w.clock.t, sig } }, undefined, { now: w.clock.t });
  assert.equal(r2.ok, false);
  assert.equal((await ids.verifyResolved("kit", { ...raw, sealed: ids.sealRecord("alex", { v: 1 }), rec: null }, undefined, { now: w.clock.t })).ok, false, "not the name asked for");
  // a chain with a tampered op
  const bad = { ...raw, ops: [{ ...alex.ops[0], nonce: "tampered-nonce" }], sealed: "", rec: null };
  assert.equal((await ids.verifyResolved("alex", bad, undefined, { now: w.clock.t })).ok, false);
});

test("ids client: the signer is asked to sign only our own messages, and an own-domain alias, an update and a release go through it", async t => {
  const w = world(t), alex = await w.person();
  const signed = [];
  const spy = { ...alex.signer, sign: async m => { signed.push(Buffer.from(m).toString().split("\n")[0]); return alex.signer.sign(m); } };
  await w.dir.claim("alex", alex.state, alex.ops, spy, { v: 1 });
  const txt = await w.dir.aliasTxt("alex", alex.state.id, "alex.example.com", spy);
  assert.equal(txt.host, "_vyre-id.alex.example.com");
  w.txt.set(txt.host, [txt.value]);
  assert.deepEqual((await w.dir.addAlias("alex", "alex.example.com")).aliases, ["alex.example.com"]);
  const via = await w.dir.resolve("alex.example.com", { alias: true });
  assert.equal(via.ok, true);
  assert.equal(via.kind, "person");
  w.clock.t += 1000;
  await w.dir.update("alex", alex.state, spy, { v: 2 });
  assert.deepEqual((await w.dir.resolve("alex")).payload, { v: 2 });
  assert.deepEqual((await w.dir.removeAlias("alex", "alex.example.com", spy)).aliases, []);
  assert.equal((await w.dir.release("alex", spy)).tombstone, false, "released within the hour of the claim");
  assert.ok(signed.length >= 5 && signed.every(s => ["vyre-id-record-v1", "vyre-id-alias-v1", "vyre-id-act-v1"].includes(s)), signed.join(","));
});

test("ids client: a client pinned from an invite refuses a backdated space op by a removed device; an unpinned first fetch is the gap the pin closes", async t => {
  const w = world(t);
  const d1 = ids.memorySigner(crypto.generateKeyPairSync("ed25519").privateKey), d2 = ids.memorySigner(crypto.generateKeyPairSync("ed25519").privateKey);
  const g0 = await C.makeGenesis({ kind: "person", entry: { eid: d1.eid, kind: "device", pub: d1.publicKey }, nonce: "alex-nonce-1", ts: w.clock.t, sign: d1.sign });
  let alex = [g0];
  let st = await C.verifyChain(alex, { now: w.clock.t });
  const at = h => w.clock.t + h * 3_600_000;
  alex = [...alex, await C.makeOp(st, { type: "add", entry: { eid: d2.eid, kind: "device", pub: d2.publicKey } }, { by: d1.eid, ts: at(30), sign: d1.sign })];
  const pos = await C.viaOf(alex);                      // d1 still on the list
  const sg = await C.makeGenesis({ kind: "space", entry: { eid: st.id, kind: "owner", subject: st.id, label: "alex" }, nonce: "space-nonce-1", ts: at(40), via: d1.eid, viaPos: pos, sign: d1.sign });
  const ownerOps = async id => (id === st.id ? alex : null);
  const spaceState = await C.verifyChain([sg], { now: at(1000), ownerOps });
  const pin = C.pinOf(spaceState);                      // what the invite carries
  // d1 is removed from alex's list
  st = await C.verifyChain(alex, { now: at(1000) });
  alex = [...alex, await C.makeOp(st, { type: "remove", target: d1.eid }, { by: d2.eid, ts: at(100), sign: d2.sign })];
  // a colluding operator serves the space with one more op, signed by d1 with a time before the removal and the position it saw then
  const evil = await C.makeOp(spaceState, { type: "add", entry: { eid: "per_" + "e".repeat(26), kind: "owner", subject: "per_" + "e".repeat(26) } }, { by: st.id, via: d1.eid, viaPos: pos, ts: at(41), sign: d1.sign });
  const answer = { name: "harlow", kind: "space", id: spaceState.id, ops: [sg, evil], sealed: "", rec: null, aliases: [] };
  const pinned = await ids.verifyResolved("harlow", answer, pin, { now: at(1000), ownerOps });
  assert.equal(pinned.ok, false);
  assert.match(pinned.why, /removed/);
  const unpinned = await ids.verifyResolved("harlow", answer, undefined, { now: at(1000), ownerOps });
  assert.equal(unpinned.ok, true, "without a pin the first fetch cannot tell: that is why a link carries one");
});
