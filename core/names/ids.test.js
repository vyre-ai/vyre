// @ts-check
// The identity-name client against the real directory Worker on the fake runtime: claim, resolve with the pinned key and the sealed record,
// the signer only ever signs directory messages, aliases, rotation and recovery, and a substituted record is refused.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker, * as W from "../../names/worker/index.js";
import { createRuntime } from "../../relay/worker/fake-cf.js";
import { fakeDns } from "../../names/worker/fake-dns.js";
import * as ids from "./ids.js";

function world(t) {
  const dns = fakeDns();
  const clock = { t: Date.UTC(2026, 9, 3, 12, 0, 0) };
  const txt = new Map();
  const rt = createRuntime({ worker, Class: W.Directory, classes: { DIRECTORY: W.Directory },
    env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, NOW: () => clock.t, ZONE: "vyre.run", RESOLVE_TXT: async n => txt.get(n) || [] } });
  t.after(async () => { await rt.settle(); assert.deepEqual(rt.errors.map(String), []); });
  const fetch = async (url, init) => worker.fetch(new Request(url, { ...init, headers: { ...(init.headers || {}), "cf-connecting-ip": "203.0.113.9" } }), rt.env);
  const client = signer => ids.idDirectory({ base: "http://127.0.0.1:1", signer, fetch, now: () => clock.t });
  const key = () => ids.memorySigner(crypto.generateKeyPairSync("ed25519").privateKey);
  return { clock, txt, client, key };
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

test("ids client: claim, then anyone resolves it, and a pinned key must match", async t => {
  const w = world(t), alexKey = w.key(), other = w.key();
  const alex = w.client(alexKey);
  const c = await alex.claim("alex", "person", { v: 1, relay: { route: "abc" } });
  assert.equal(c.mine, true);
  const r = await w.client(other).resolve("alex");
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload, { v: 1, relay: { route: "abc" } });
  assert.equal(r.pin, (await alexKey.identity()).pub.toString("base64url"));
  assert.equal((await w.client(other).resolve("alex", { pinned: r.pin })).ok, true);
  const bad = await w.client(other).resolve("alex", { pinned: Buffer.alloc(32, 7).toString("base64url") });
  assert.equal(bad.ok, false);
  assert.match(bad.why, /different key/);
  await assert.rejects(() => w.client(other).resolve("nobody"), e => /** @type {any} */ (e).code === "not_found");
});

test("ids client: a record the directory altered, or signed by another key, is refused by the client", async t => {
  const w = world(t), alexKey = w.key();
  await w.client(alexKey).claim("alex", "space", { v: 1, home: "h" });
  const good = await w.client(w.key()).resolve("alex");
  assert.equal(good.ok, true);
  // A directory (or a path) that swaps the sealed record: the signature no longer covers it.
  const r = { name: "alex", kind: "space", pub: (await alexKey.identity()).pub.toString("base64url"), keyId: (await alexKey.identity()).route, sealed: ids.sealRecord("alex", { v: 1, home: "evil" }), recordSig: "A".repeat(86), ts: w.clock.t, aliases: [] };
  assert.equal(ids.verifyResolved("alex", r, undefined).ok, false, "a substituted record does not verify");
  assert.equal(ids.verifyResolved("kit", { ...r }, undefined).ok, false, "not the name asked for");
});

test("ids client: the signer is asked to sign only directory messages", async t => {
  const w = world(t);
  const signed = [];
  const k = w.key();
  const spy = { identity: k.identity, sign: async m => { signed.push(m.toString().split("\n")[0]); return k.sign(m); } };
  const c = w.client(spy);
  await c.claim("alex", "person", { v: 1 });
  await c.mine();
  await c.update("alex", "person", { v: 2 }).catch(() => {});
  assert.ok(signed.length >= 3 && signed.every(s => ["vyre-names-v1", "vyre-id-record-v1"].includes(s)), signed.join(","));
});
  await assert.rejects(() => evil.mine().then(() => { throw new Error("did not refuse"); }), /unreachable|not reachable|no/);
});

test("ids client: an own-domain alias, rotation to a new key, release and recovery through the client", async t => {
  const w = world(t), oldKey = w.key(), newKey = w.key(), fresh = w.key();
  const alex = w.client(oldKey);
  const claimed = await alex.claim("alex", "person", { v: 1 });
  const txt = await alex.aliasTxt("alex", "alex.example.com");
  assert.equal(txt.host, "_vyre-id.alex.example.com");
  w.txt.set(txt.host, [txt.value]);
  assert.deepEqual((await alex.addAlias("alex", "alex.example.com")).aliases, ["alex.example.com"]);
  const via = await w.client(w.key()).resolve("alex.example.com", { alias: true });
  assert.equal(via.ok, true);
  assert.equal(via.kind, "person");
  w.clock.t += 1000;
  const rotated = await alex.rotate("alex", "person", { v: 2 }, newKey);
  assert.equal(rotated.keyId, (await newKey.identity()).route);
  assert.equal((await w.client(w.key()).resolve("alex")).keyId, (await newKey.identity()).route);
  // Recovery from the code, by a third key, with a hash of a new code.
  const { codeHash } = W;
  w.clock.t += 1000;
  const pending = await w.client(fresh).recover("alex", "person", claimed.code, await codeHash("alex", "next"), { v: 3 });
  assert.equal(pending.pendingUntil, w.clock.t + 72 * 3_600_000);
  assert.equal((await w.client(newKey).cancelRecovery("alex")).cancelled, true);
  assert.equal((await w.client(newKey).release("alex")).tombstone, false, "released within the hour of the claim");
});
