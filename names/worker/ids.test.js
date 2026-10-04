// @ts-check
// Identity names in the directory: a person (a permanent id with a signed, chained list) and a space (a list of owners) claim names in the
// same namespace as the boxes, resolve exactly by name, grow their lists by verified ops, alias an own domain by a signed TXT, and release.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker, * as W from "./index.js";
import * as I from "./ids.js";
import * as C from "./chain.js";
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


/** A route key, for the box claim path only (box routes still sign their requests). */
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
  return { route, post: (p, b, o) => send("POST", p, b, o), get: (p, o) => send("GET", p, undefined, o) };
}

async function key(label) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const pubText = Buffer.from(pub).toString("base64url");
  const eid = await C.eidOf(pub);
  const sign = m => crypto.sign(null, Buffer.from(m), privateKey);
  return { label, pub: pubText, eid, sign, sig64: m => sign(m).toString("base64url"), entry: kind => ({ eid, kind, pub: pubText, label }) };
}

/** A person (or space) client over the directory: it holds the chain it has built and talks plain HTTP with nothing signed at the request level. */
async function identity(w, first, { kind = "person", ctxFor } = {}) {
  const ts = w.clock.t;
  const send = async (method, path, body, ip = "203.0.113.7") => {
    const text = body === undefined ? "" : JSON.stringify(body);
    const res = await worker.fetch(new Request(BASE + path, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "cf-connecting-ip": ip }, body: text || undefined }), w.env);
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const me = { first, ops: [], state: null, send, get: (p, ip) => send("GET", p, undefined, ip), post: (p, b, ip) => send("POST", p, b, ip), del: (p, b) => send("DELETE", p, b) };
  me.sealRecord = (name, sealed, by = first, via) => {
    const sealedHash = crypto.createHash("sha256").update(sealed).digest("hex");
    const ts2 = w.clock.t;
    const pos = kind === "space" && me.pos ? { vseq: me.pos.via_seq, vhead: me.pos.via_head } : {};
    return { sealed, rec: { by: kind === "space" ? me.state.entries[0].eid : by.eid, ...(via ? { via } : {}), ...pos, ts: ts2, sig: by.sig64(I.recordMessage({ name, id: me.state.id, by: kind === "space" ? me.state.entries[0].eid : by.eid, via, ts: ts2, sealedHash, ...pos })) } };
  };
  me.genesis = async (entry, via) => {
    if (kind === "space" && ctxFor) me.pos = await C.viaOf(await ctxFor(entry.subject));
    const g = await C.makeGenesis({ kind, entry: entry || first.entry("device"), nonce: "nonce-" + first.eid.slice(0, 10), ts, via, viaPos: me.pos, sign: first.sign });
    me.ops = [g];
    me.state = await C.verifyChain(me.ops, { now: ts, ownerOps: ctxFor });
    return me;
  };
  me.claim = (name, sealed = "c2VhbGVk", by, via) => me.post("/v1/ids/claim", { name, ops: me.ops, ...me.sealRecord(name, sealed, by, via) });
  me.append = async (body, signer, { via } = {}) => {
    const op = await C.makeOp(me.state, body, { by: kind === "space" ? me.state.entries[0].eid : signer.eid, via, viaPos: me.pos, ts: w.clock.t, sign: signer.sign });
    return op;
  };
  me.accept = async op => { me.state = await C.applyOp(me.state, op, { now: w.clock.t, ownerOps: ctxFor }); me.ops = [...me.ops, op]; return op; };
  return me;
}
const person = async (w, k = null) => identity(w, k || await key("phone")).then(i => i.genesis());

test("ids: a person and a space claim names; anyone resolves the whole chain by the exact name", async t => {
  const w = world(t);
  const alex = await person(w);
  const a = data(await alex.claim("alex"));
  assert.deepEqual([a.name, a.kind, a.mine, a.id], ["alex", "person", true, alex.state.id]);
  const chainsById = new Map();
  const harlow = await identity(w, alex.first, { kind: "space", ctxFor: async id => id === alex.state.id ? alex.ops : null });
  await harlow.genesis({ eid: alex.state.id, kind: "owner", subject: alex.state.id, label: "Alex" }, alex.first.eid);
  const h = data(await harlow.claim("harlow", "aG9tZQ", alex.first, alex.first.eid));
  assert.equal(h.kind, "space");
  assert.match(h.id, /^spc_/);
  const r = data(await alex.get("/v1/ids/resolve?name=alex"));
  assert.deepEqual([r.name, r.kind, r.id, r.sealed], ["alex", "person", alex.state.id, "c2VhbGVk"]);
  assert.equal((await C.verifyChain(r.ops, { now: w.clock.t })).head, alex.state.head, "the client re-verifies the chain, it does not trust the directory");
  // The directory holds public keys only.
  const blob = JSON.stringify(r);
  assert.ok(!/code|pin|email|device name/i.test(blob.replace(/"label":"phone"/g, "")), "no private field comes back");
  // No listing, no search.
  for (const p of ["/v1/ids/list", "/v1/ids/search?q=a", "/v1/ids/resolve", "/v1/ids/resolve?name=al*", "/v1/ids/resolve?name="]) assert.ok([404, 405].includes((await alex.get(p)).status), p);
  void chainsById;
});

test("ids: one namespace with the boxes, one name per identity, reserved and invalid names refused", async t => {
  const w = world(t), box = who(w);
  const alex = await person(w), other = await person(w);
  data(await alex.claim("alex"));
  assert.equal(code(await box.post("/v1/names/claim", { name: "alex" })), "taken", "a box cannot take an identity's name");
  assert.equal(data(await box.get("/v1/names/check?name=alex", { unsigned: true })).status, "taken");
  data(await box.post("/v1/names/claim", { name: "juno" }));
  assert.equal(code(await other.claim("juno")), "taken", "an identity cannot take a box's name");
  assert.equal(code(await alex.claim("alex2")), "one_per_identity");
  assert.equal(data(await alex.claim("alex")).mine, true, "claiming your own name again is a no-op");
  assert.equal(code(await other.claim("vyre")), "reserved");
  assert.equal(code(await other.claim("x")), "invalid");
});

test("ids: a claim must carry a valid chain and a record an entry signed; a forged id or a borrowed signature is refused", async t => {
  const w = world(t);
  const alex = await person(w), mallory = await person(w);
  const good = alex.sealRecord("alex", "c2VhbGVk");
  assert.equal(code(await alex.post("/v1/ids/claim", { name: "alex", ops: [{ ...alex.ops[0], id: "per_" + "a".repeat(26) }], ...good })), "bad_id");
  assert.equal(code(await alex.post("/v1/ids/claim", { name: "alex", ops: [], ...good })), "bad_chain");
  assert.equal(code(await mallory.post("/v1/ids/claim", { name: "alex", ops: mallory.ops, ...good })), "bad_signature", "alex's record under mallory's chain");
  assert.equal(code(await alex.post("/v1/ids/claim", { name: "alex", ops: alex.ops, sealed: "dGFtcGVyZWQ", rec: good.rec })), "bad_signature", "a changed record");
  assert.equal(code(await alex.post("/v1/ids/claim", { name: "alex", ops: alex.ops, sealed: "x".repeat(3000), rec: good.rec })), "bad_record");
  assert.equal(code(await alex.post("/v1/ids/claim", { name: "alex", ops: alex.ops, sealed: good.sealed })), "bad_record", "unsigned");
  w.clock.t += 10 * 60_000;
  assert.equal(code(await alex.post("/v1/ids/claim", { name: "alex", ops: alex.ops, ...good })), "bad_time", "a genesis made ten minutes ago is not made now");
  assert.equal(code(await alex.get("/v1/ids/resolve?name=alex")), "not_found", "nothing was claimed by any of those");
});

test("ids: an unknown, an invalid and a released-then-freed name all resolve as not found", async t => {
  const w = world(t), alex = await person(w);
  for (const q of ["nobody", "x", "vyre"]) assert.equal(code(await alex.get(`/v1/ids/resolve?name=${q}`)), "not_found", q);
  data(await alex.claim("alex"));
  data(await alex.post("/v1/ids/release", { name: "alex", act: await act(w, alex, "release", "alex") }));
  assert.equal(code(await alex.get("/v1/ids/resolve?name=alex")), "not_found");
});

const act = async (w, who_, action, name, domain, by = who_.first) => ({ by: by.eid, ts: w.clock.t, sig: by.sig64(I.actMessage({ action, name, domain, ts: w.clock.t })) });

test("ids: the list grows by ops the directory verifies against the list before; an operator or stranger cannot forge one", async t => {
  const w = world(t), alex = await person(w), phone = alex.first;
  data(await alex.claim("alex"));
  const laptop = await key("laptop"), stranger = await key("stranger");
  w.clock.t += HOUR;
  const add = await alex.append({ type: "add", entry: laptop.entry("device") }, phone);
  const r = data(await alex.post("/v1/ids/append", { name: "alex", ops: [add] }));
  assert.equal(r.seq, 1);
  await alex.accept(add);
  assert.equal(r.head, alex.state.head);
  // resending the same op is fine; a different op at the same place is a fork
  assert.equal(data(await alex.post("/v1/ids/append", { name: "alex", ops: [add] })).seq, 1);
  const other = await C.makeOp({ ...alex.state, seq: 0, head: alex.ops[0] && await C.hashOf(alex.ops[0]) }, { type: "add", entry: stranger.entry("device") }, { by: phone.eid, ts: w.clock.t, sign: phone.sign });
  assert.equal(code(await alex.post("/v1/ids/append", { name: "alex", ops: [other] })), "fork");
  // a stranger's op (not on the list) and a signature that is not the signer's
  const forged = await C.makeOp(alex.state, { type: "add", entry: stranger.entry("device") }, { by: stranger.eid, ts: w.clock.t, sign: stranger.sign });
  assert.equal(code(await alex.post("/v1/ids/append", { name: "alex", ops: [forged] })), "not_on_list");
  const lie = await C.makeOp(alex.state, { type: "add", entry: stranger.entry("device") }, { by: phone.eid, ts: w.clock.t, sign: stranger.sign });
  assert.equal(code(await alex.post("/v1/ids/append", { name: "alex", ops: [lie] })), "bad_signature");
  // the stored list is what the client built, op for op
  const stored = data(await alex.get("/v1/ids/resolve?name=alex"));
  assert.equal((await C.verifyChain(stored.ops, { now: w.clock.t })).head, alex.state.head);
  assert.equal(code(await alex.post("/v1/ids/append", { name: "nobody", ops: [add] })), "not_found");
});

test("ids: the newcomer rule holds at the directory too: a new sign-in works at once, cannot remove older entries for 24 hours, and an older device removes it", async t => {
  const w = world(t), alex = await person(w), phone = alex.first;
  data(await alex.claim("alex"));
  const thief = await key("thief"), friend = await key("friend");
  w.clock.t += HOUR;
  data(await alex.post("/v1/ids/append", { name: "alex", ops: [await alex.accept(await alex.append({ type: "add", entry: thief.entry("device") }, phone))] }));
  const sneak = await alex.append({ type: "remove", target: phone.eid }, thief);
  assert.equal(code(await alex.post("/v1/ids/append", { name: "alex", ops: [sneak] })), "newcomer");
  const contact = await alex.append({ type: "add", entry: friend.entry("contact") }, thief);
  assert.equal(code(await alex.post("/v1/ids/append", { name: "alex", ops: [contact] })), "newcomer");
  const out = await alex.append({ type: "remove", target: thief.eid }, phone);
  assert.equal(data(await alex.post("/v1/ids/append", { name: "alex", ops: [out] })).seq, 2);
  assert.equal(code(await alex.post("/v1/ids/release", { name: "alex", act: await act(w, alex, "release", "alex", undefined, thief) })), "not_yours", "a removed entry does nothing");
});

test("ids: recovery is a chain op, by the code or by two contacts, with no wait and no takeover", async t => {
  const w = world(t), alex = await person(w), phone = alex.first;
  data(await alex.claim("alex"));
  const code1 = await key("code"), c1 = await key("c1"), c2 = await key("c2"), fresh = await key("new phone"), fresh2 = await key("new phone 2");
  w.clock.t += 30 * HOUR;
  for (const [kind, k] of [["code", code1], ["contact", c1], ["contact", c2]]) {
    const op = await alex.accept(await alex.append({ type: "add", entry: k.entry(kind) }, phone));
    data(await alex.post("/v1/ids/append", { name: "alex", ops: [op] }));
  }
  w.clock.t += 30 * HOUR;
  // all devices lost, code in hand: the code signs a new device at once
  const viaCode = await alex.append({ type: "add", entry: fresh.entry("device") }, code1);
  assert.equal(data(await alex.post("/v1/ids/append", { name: "alex", ops: [viaCode] })).seq, 4);
  await alex.accept(viaCode);
  // everything lost: two contacts approve
  const op = await C.makeOp(alex.state, { type: "recover", entry: fresh2.entry("device") }, { ts: w.clock.t });
  op.approvals = [c1, c2].map(k => ({ eid: k.eid, sig: k.sig64(C.approvalMessage(op)) }));
  assert.equal(code(await alex.post("/v1/ids/append", { name: "alex", ops: [{ ...op, approvals: op.approvals.slice(0, 1) }] })), "no_quorum");
  assert.equal(data(await alex.post("/v1/ids/append", { name: "alex", ops: [op] })).seq, 5);
  // the code is replaceable and the old one then stops
  await alex.accept(op);
  const code2 = await key("code 2");
  const rep = await alex.append({ type: "replace-code", entry: code2.entry("code") }, phone);
  data(await alex.post("/v1/ids/append", { name: "alex", ops: [rep] }));
  await alex.accept(rep);
  const old = await alex.append({ type: "remove", target: phone.eid }, code1);
  assert.equal(code(await alex.post("/v1/ids/append", { name: "alex", ops: [old] })), "not_on_list");
});

test("ids: update replaces the sealed record with a newer one by an entry; nobody else can", async t => {
  const w = world(t), alex = await person(w), mallory = await person(w);
  data(await alex.claim("alex"));
  w.clock.t += 1000;
  const next = alex.sealRecord("alex", "bmV3");
  data(await alex.post("/v1/ids/update", { name: "alex", ...next }));
  assert.equal(data(await alex.get("/v1/ids/resolve?name=alex")).sealed, "bmV3");
  assert.equal(code(await alex.post("/v1/ids/update", { name: "alex", ...next })), "stale", "not newer");
  w.clock.t += 1000;
  assert.equal(code(await mallory.post("/v1/ids/update", { name: "alex", ...mallory.sealRecord("alex", "ZXZpbA") })), "bad_signature");
});

test("ids: an own domain becomes an alias only with a TXT an entry of the identity signed, and one domain belongs to one name", async t => {
  const w = world(t), alex = await person(w), kit = await person(w);
  data(await alex.claim("alex")); data(await kit.claim("kit"));
  const proof = (who_, name, domain) => `vyre-id=2;name=${name};id=${who_.state.id};by=${who_.first.eid};via=-;sig=${who_.first.sig64(I.aliasMessage({ name, domain, id: who_.state.id }))}`;
  assert.equal(code(await alex.post("/v1/ids/alias", { name: "alex", domain: "alex.example.com" })), "not_proven", "no TXT yet");
  w.txt.set("_vyre-id.alex.example.com", [proof(kit, "alex", "alex.example.com")]);
  assert.equal(code(await alex.post("/v1/ids/alias", { name: "alex", domain: "alex.example.com" })), "not_proven", "a TXT signed by another identity");
  w.txt.set("_vyre-id.alex.example.com", [proof(alex, "alex", "alex.example.com")]);
  assert.deepEqual(data(await alex.post("/v1/ids/alias", { name: "alex", domain: "Alex.Example.com." })).aliases, ["alex.example.com"]);
  assert.equal(data(await alex.get("/v1/ids/resolve?alias=alex.example.com")).name, "alex", "the alias resolves to the vyre.run name, which stays the identity");
  w.txt.set("_vyre-id.alex.example.com", [proof(kit, "kit", "alex.example.com")]);
  assert.equal(code(await kit.post("/v1/ids/alias", { name: "kit", domain: "alex.example.com" })), "taken");
  for (const bad of ["vyre.run", "x.vyre.run", "10.0.0.1", "localhost", "a_b.example.com", "-x.example.com", "xn--e1afmkfd.example.com", ""]) assert.equal(code(await alex.post("/v1/ids/alias", { name: "alex", domain: bad })), "bad_domain", bad);
  data(await alex.del("/v1/ids/alias", { name: "alex", domain: "alex.example.com", act: await act(w, alex, "alias-clear", "alex", "alex.example.com") }));
  assert.equal(code(await alex.get("/v1/ids/resolve?alias=alex.example.com")), "not_found");
});

test("ids: released soon is freed; released after use is a tombstone for good, and a newcomer cannot release", async t => {
  const w = world(t), a = await person(w), b = await person(w);
  data(await a.claim("alex"));
  assert.equal(data(await a.post("/v1/ids/release", { name: "alex", act: await act(w, a, "release", "alex") })).tombstone, false);
  data(await b.claim("alex"));
  w.clock.t += 2 * HOUR;
  assert.equal(data(await b.post("/v1/ids/release", { name: "alex", act: await act(w, b, "release", "alex") })).tombstone, true);
  const c = await person(w);
  assert.equal(code(await c.claim("alex")), "taken", "a used name is never reassigned");
  assert.equal(data(await c.get("/v1/names/check?name=alex")).status, "taken");
  // a newcomer cannot release a name
  const d = await person(w), kit = await key("kit");
  data(await d.claim("dana"));
  w.clock.t += HOUR;
  data(await d.post("/v1/ids/append", { name: "dana", ops: [await d.accept(await d.append({ type: "add", entry: kit.entry("device") }, d.first))] }));
  assert.equal(code(await d.post("/v1/ids/release", { name: "dana", act: await act(w, d, "release", "dana", undefined, kit) })), "newcomer");
});

test("ids: a space's list holds its owners; a person who is not on a chain the directory knows cannot own", async t => {
  const w = world(t), alex = await person(w), phone = alex.first;
  data(await alex.claim("alex"));
  const ctxFor = async id => id === alex.state.id ? alex.ops : null;
  const space = await identity(w, phone, { kind: "space", ctxFor });
  await space.genesis({ eid: alex.state.id, kind: "owner", subject: alex.state.id }, phone.eid);
  data(await space.claim("harlow", "aG9tZQ", phone, phone.eid));
  const bob = await person(w);
  w.clock.t += 25 * HOUR;
  const addBob = await space.append({ type: "add", entry: { eid: bob.state.id, kind: "owner", subject: bob.state.id } }, phone, { via: phone.eid });
  // bob has no name in the directory, so the directory cannot resolve him: adding is allowed, he just cannot sign yet
  assert.equal(data(await space.post("/v1/ids/append", { name: "harlow", ops: [addBob] })).seq, 1);
  await space.accept(addBob);
  const stranger = await key("stranger");
  const bad = await space.append({ type: "remove", target: bob.state.id }, stranger, { via: stranger.eid });
  assert.equal(code(await space.post("/v1/ids/append", { name: "harlow", ops: [bad] })), "not_on_list");
});

test("ids: the unchanged box claim path still works beside identities", async t => {
  const w = world(t), box = who(w), alex = await person(w);
  const c = data(await box.post("/v1/names/claim", { name: "harlow" }));
  assert.equal(c.name, "harlow");
  assert.equal(code(await alex.claim("harlow")), "taken");
});

test("ids: the directory refuses an op made at an old time, so an adder cannot hand a new entry a past age", async t => {
  const w = world(t), alex = await person(w), phone = alex.first;
  data(await alex.claim("alex"));
  const thief = await key("thief");
  w.clock.t += 500 * HOUR;
  const old = await C.makeOp(alex.state, { type: "add", entry: thief.entry("device") }, { by: phone.eid, ts: alex.state.ts, sign: phone.sign });
  assert.equal(code(await alex.post("/v1/ids/append", { name: "alex", ops: [old] })), "bad_time");
  const now = await alex.append({ type: "add", entry: thief.entry("device") }, phone);
  assert.equal(data(await alex.post("/v1/ids/append", { name: "alex", ops: [now] })).seq, 1);
});
