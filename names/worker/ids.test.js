// @ts-check
// Identity names in the directory: a person key and a space root key claim names in the same namespace as the boxes, resolve through a
// sealed record, alias an own domain by a signed TXT, move to a new key, release, and recover with the code after 72 hours.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker, * as W from "./index.js";
import * as I from "./ids.js";
import { createRuntime } from "../../relay/worker/fake-cf.js";
import { fakeDns } from "./fake-dns.js";
import * as wire from "../../core/relay/wire.js";

const BASE = "https://names.test";
const HOUR = 3_600_000;
const data = r => { assert.ok(r.json && r.json.data, JSON.stringify(r.json)); return r.json.data; };
const code = r => r.json && r.json.error && r.json.error.code;

function world(t, extra = {}) {
  const dns = fakeDns();
  const clock = { t: Date.UTC(2026, 9, 3, 12, 0, 0) };
  const txt = new Map();
  const rt = createRuntime({ worker, Class: W.Directory, classes: { DIRECTORY: W.Directory },
    env: { CF_API_TOKEN: dns.token, CF_ZONE_ID: dns.zoneId, CF_API: dns.api, CF_FETCH: dns.fetch, NOW: () => clock.t, ZONE: "vyre.run", RESOLVE_TXT: async n => txt.get(n) || [], ...extra } });
  t.after(async () => { await rt.settle(); assert.deepEqual(rt.errors.map(String), [], "no errors inside the Worker"); });
  return { rt, dns, clock, env: rt.env, txt };
}

/** An identity: an Ed25519 key that signs requests and its own records. */
function who(w, key = wire.newRouteKey()) {
  const route = wire.routeId(key.pub);
  const pub = key.pub.toString("base64url");
  const send = async (method, path, body, o = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const nonce = crypto.randomBytes(16).toString("base64url");
    const ts = o.ts ?? w.clock.t;
    const bodyHash = crypto.createHash("sha256").update(text).digest("hex");
    const sig = wire.signRoute(key.priv, Buffer.from(W.authMessage({ route, ts, nonce, method, target: path, bodyHash }))).toString("base64url");
    const headers = { ...(o.unsigned ? {} : { "x-vyre-route": route, "x-vyre-pub": pub, "x-vyre-ts": String(ts), "x-vyre-nonce": nonce, "x-vyre-sig": sig }),
      ...(body === undefined ? {} : { "content-type": "application/json" }), "cf-connecting-ip": o.ip || "203.0.113.7" };
    const res = await worker.fetch(new Request(BASE + path, { method, headers, body: text || undefined }), w.env);
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const sign = m => wire.signRoute(key.priv, Buffer.from(m)).toString("base64url");
  /** A signed record for a name. */
  const record = (name, kind, sealed = "c2VhbGVk", ts = w.clock.t) => {
    const sealedHash = crypto.createHash("sha256").update(sealed).digest("hex");
    return { record: { name, kind, pub, sealed, ts }, recordSig: sign(I.recordMessage({ name, kind, pub, ts, sealedHash })) };
  };
  return { key, route, pub, send, sign, record, post: (p, b, o) => send("POST", p, b, o), get: (p, o) => send("GET", p, undefined, o), del: (p, b, o) => send("DELETE", p, b, o),
    claim: (name, kind = "person", sealed) => send("POST", "/v1/ids/claim", { name, kind, ...record(name, kind, sealed) }) };
}

test("ids: a person and a space claim names; anyone resolves the sealed record and the pinned key", async t => {
  const w = world(t), alex = who(w), harlow = who(w);
  const a = data(await alex.claim("alex"));
  assert.deepEqual([a.name, a.kind, a.mine], ["alex", "person", true]);
  assert.match(a.code, /^[a-z2-7-]{20,}$/, "a one-time recovery code");
  const h = data(await harlow.claim("harlow", "space", "aG9tZQ"));
  assert.equal(h.kind, "space");
  // Resolving needs no signature, and gives the record, the key and its id, never the recovery code.
  const r = data(await alex.get("/v1/ids/resolve?name=alex", { unsigned: true }));
  assert.deepEqual([r.name, r.kind, r.pub, r.keyId, r.sealed], ["alex", "person", alex.pub, alex.route, "c2VhbGVk"]);
  assert.ok(!("codeHash" in r) && !("code" in r));
  assert.equal(data(await alex.get("/v1/ids/mine")).name, "alex");
});

test("ids: one namespace with the boxes, one name per key, reserved and invalid names refused", async t => {
  const w = world(t), alex = who(w), box = who(w), other = who(w);
  data(await alex.claim("alex"));
  assert.equal(code(await box.post("/v1/names/claim", { name: "alex" })), "taken", "a box cannot take an identity's name");
  assert.equal(data(await box.get("/v1/names/check?name=alex", { unsigned: true })).status, "taken");
  data(await box.post("/v1/names/claim", { name: "juno" }));
  assert.equal(code(await other.claim("juno")), "taken", "an identity cannot take a box's name");
  assert.equal(code(await alex.claim("alex2")), "one_per_key");
  assert.equal(data(await alex.claim("alex")).code, null, "claiming your own name again is a no-op");
  assert.equal(code(await other.claim("vyre")), "reserved");
  assert.equal(code(await other.claim("x")), "invalid");
  assert.equal(code(await other.claim("nope", "robot")), "bad_kind");
  assert.equal(data(await alex.get("/v1/names/check?name=alex")).status, "mine");
});

test("ids: the claim must be signed by the key it names, over the record it posts", async t => {
  const w = world(t), alex = who(w), mallory = who(w);
  const good = alex.record("alex", "person");
  assert.equal(code(await mallory.post("/v1/ids/claim", { name: "alex", kind: "person", ...good })), "wrong_key", "someone else's record under my signature");
  assert.equal(code(await alex.post("/v1/ids/claim", { name: "alex", kind: "person", record: { ...good.record, sealed: "dGFtcGVyZWQ" }, recordSig: good.recordSig })), "bad_signature", "a changed record");
  assert.equal(code(await alex.post("/v1/ids/claim", { name: "alex", kind: "person", record: { ...good.record, name: "alexa" }, recordSig: good.recordSig })), "bad_record");
  assert.equal(code(await alex.post("/v1/ids/claim", { name: "alex", kind: "person", record: { ...good.record, ts: w.clock.t - 3_600_000 }, recordSig: good.recordSig })), "stale");
  assert.equal(code(await alex.post("/v1/ids/claim", { name: "alex", kind: "person", record: { ...good.record, sealed: "x".repeat(3000) }, recordSig: good.recordSig })), "bad_record");
  assert.equal(code(await alex.post("/v1/ids/claim", { name: "alex", kind: "person", record: good.record })), "bad_record", "unsigned");
  assert.equal((await alex.get("/v1/ids/mine")).json.data.name, null, "nothing was claimed by any of those");
});

test("ids: an unknown, an invalid and a released-then-freed name all resolve as not found", async t => {
  const w = world(t), alex = who(w);
  for (const q of ["nobody", "x", "vyre"]) assert.equal(code(await alex.get(`/v1/ids/resolve?name=${q}`, { unsigned: true })), "not_found", q);
  data(await alex.claim("alex"));
  data(await alex.post("/v1/ids/release", { name: "alex" }));
  assert.equal(code(await alex.get("/v1/ids/resolve?name=alex", { unsigned: true })), "not_found");
});

test("ids: update replaces the sealed record with a newer one by the same key; nobody else can", async t => {
  const w = world(t), alex = who(w), mallory = who(w);
  data(await alex.claim("alex"));
  w.clock.t += 1000;
  const next = alex.record("alex", "person", "bmV3");
  data(await alex.post("/v1/ids/update", { name: "alex", ...next }));
  assert.equal(data(await alex.get("/v1/ids/resolve?name=alex", { unsigned: true })).sealed, "bmV3");
  assert.equal(code(await alex.post("/v1/ids/update", { name: "alex", ...next })), "stale", "not newer");
  w.clock.t += 1000;
  assert.equal(code(await mallory.post("/v1/ids/update", { name: "alex", ...mallory.record("alex", "person", "ZXZpbA") })), "not_yours");
  assert.equal(code(await alex.post("/v1/ids/update", { name: "alex", ...who(w).record("alex", "person", "b3RoZXI") })), "wrong_key", "an update keeps the key");
});

test("ids: an own domain becomes an alias only with a TXT the identity key signed, and one domain belongs to one name", async t => {
  const w = world(t), alex = who(w), kit = who(w);
  data(await alex.claim("alex")); data(await kit.claim("kit"));
  const proof = (id, domain) => `vyre-id=1;name=${id === alex ? "alex" : "kit"};key=${id.route};sig=${id.sign(I.aliasMessage({ name: id === alex ? "alex" : "kit", domain, keyId: id.route }))}`;
  assert.equal(code(await alex.post("/v1/ids/alias", { name: "alex", domain: "alex.example.com" })), "not_proven", "no TXT yet");
  w.txt.set("_vyre-id.alex.example.com", [proof(kit, "alex.example.com")]);
  assert.equal(code(await alex.post("/v1/ids/alias", { name: "alex", domain: "alex.example.com" })), "not_proven", "a TXT signed by another key");
  w.txt.set("_vyre-id.alex.example.com", [proof(alex, "alex.example.com")]);
  assert.deepEqual(data(await alex.post("/v1/ids/alias", { name: "alex", domain: "Alex.Example.com." })).aliases, ["alex.example.com"]);
  const by = data(await alex.get("/v1/ids/resolve?alias=alex.example.com", { unsigned: true }));
  assert.equal(by.name, "alex", "the alias resolves to the vyre.run name, which stays the identity");
  w.txt.set("_vyre-id.alex.example.com", [proof(kit, "alex.example.com")]);
  assert.equal(code(await kit.post("/v1/ids/alias", { name: "kit", domain: "alex.example.com" })), "taken");
  for (const bad of ["vyre.run", "x.vyre.run", "10.0.0.1", "localhost", "a_b.example.com", "-x.example.com", "xn--e1afmkfd.example.com", ""]) assert.equal(code(await alex.post("/v1/ids/alias", { name: "alex", domain: bad })), "bad_domain", bad);
  data(await alex.del("/v1/ids/alias", { name: "alex", domain: "alex.example.com" }));
  assert.equal(code(await alex.get("/v1/ids/resolve?alias=alex.example.com", { unsigned: true })), "not_found");
});

test("ids: rotate moves the name to a new key that signs the move; the old key stops working", async t => {
  const w = world(t), old = who(w), next = who(w), other = who(w);
  data(await old.claim("alex"));
  w.clock.t += 1000;
  const rec = next.record("alex", "person", "cm90YXRlZA");
  const rotateSig = next.sign(I.rotateMessage({ name: "alex", from: old.route, to: next.route }));
  assert.equal(code(await old.post("/v1/ids/rotate", { name: "alex", ...rec, rotateSig: other.sign(I.rotateMessage({ name: "alex", from: old.route, to: next.route })) })), "bad_signature", "the new key must sign");
  assert.equal(data(await old.post("/v1/ids/rotate", { name: "alex", ...rec, rotateSig })).keyId, next.route);
  assert.equal(data(await next.get("/v1/ids/mine")).name, "alex");
  assert.equal(code(await old.post("/v1/ids/update", { name: "alex", ...old.record("alex", "person") })), "not_yours");
  assert.equal(data(await other.get("/v1/ids/resolve?name=alex", { unsigned: true })).keyId, next.route);
});

test("ids: released soon is freed; released after use is a tombstone for good", async t => {
  const w = world(t), a = who(w), b = who(w), c = who(w);
  data(await a.claim("alex"));
  assert.equal(data(await a.post("/v1/ids/release", { name: "alex" })).tombstone, false);
  data(await b.claim("alex"));
  w.clock.t += 2 * HOUR;
  assert.equal(data(await b.post("/v1/ids/release", { name: "alex" })).tombstone, true);
  assert.equal(code(await c.claim("alex")), "taken", "a used name is never reassigned");
  assert.equal(data(await c.get("/v1/names/check?name=alex", { unsigned: true })).status, "taken");
});

test("ids: recovery with the code waits 72 hours, the current key can cancel it, a wrong code is refused alike", async t => {
  const w = world(t), old = who(w), fresh = who(w), thief = who(w);
  const claimed = data(await old.claim("alex"));
  const { codeHash } = W;
  const next = await codeHash("alex", "newcode");
  const ask = (who_, c) => who_.post("/v1/ids/recover", { name: "alex", code: c, next, ...who_.record("alex", "person", "cmVjb3ZlcmVk") });
  assert.equal(code(await ask(thief, "wrong-code")), "refused");
  assert.equal(code(await ask(thief, "x")), "refused");
  const pending = data(await ask(fresh, claimed.code));
  assert.equal(pending.pendingUntil, w.clock.t + 72 * HOUR);
  assert.equal(data(await old.get("/v1/ids/mine")).pending.eta, pending.pendingUntil, "the holder's devices see it");
  assert.equal(data(await old.post("/v1/ids/recover/cancel", { name: "alex" })).cancelled, true);
  w.clock.t += 73 * HOUR;
  assert.equal(data(await old.get("/v1/ids/mine")).name, "alex", "cancelled, so the old key still holds it");
  // Again, and this time nobody cancels.
  data(await ask(fresh, claimed.code));
  w.clock.t += 73 * HOUR;
  const landed = data(await fresh.get("/v1/ids/resolve?name=alex", { unsigned: true }));
  assert.equal(landed.keyId, fresh.route);
  assert.equal(data(await fresh.get("/v1/ids/mine")).name, "alex");
  assert.equal(data(await old.get("/v1/ids/mine")).name, null);
});

test("ids: the unchanged box claim path still works beside identities", async t => {
  const w = world(t), box = who(w), alex = who(w);
  const c = data(await box.post("/v1/names/claim", { name: "harlow" }));
  assert.equal(c.name, "harlow");
  assert.equal(code(await alex.claim("harlow", "space")), "taken");
});
