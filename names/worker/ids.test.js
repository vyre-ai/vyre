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
  return { label, pub: pubText, eid, sign, sig64: m => sign(m).toString("base64url"), entry: kind => ({ eid, kind, pub: pubText }) };
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

test("ids: a space's record (where its home is) cannot be repointed by a device under 24 hours old unless it signed the record itself; an older device can", async t => {
  const w = world(t), alex = await person(w), phone = alex.first;
  data(await alex.claim("alex"));
  const ctxFor = async id => id === alex.state.id ? alex.ops : null;
  const space = await identity(w, phone, { kind: "space", ctxFor });
  await space.genesis({ eid: alex.state.id, kind: "owner", subject: alex.state.id }, phone.eid);
  data(await space.claim("harlow", "aG9tZQ", phone, phone.eid));
  // a thief adds a device with a stolen recovery code: it is on the list at once and is a newcomer for 24 hours
  const thief = await key("thief");
  w.clock.t += HOUR;
  data(await alex.post("/v1/ids/append", { name: "alex", ops: [await alex.accept(await alex.append({ type: "add", entry: thief.entry("device") }, phone))] }));
  space.pos = await C.viaOf(alex.ops);
  w.clock.t += 1000;
  assert.equal(code(await space.post("/v1/ids/update", { name: "harlow", ...space.sealRecord("harlow", "ZXZpbA", thief, thief.eid) })), "newcomer", "a young device cannot repoint the space");
  // the founding phone can
  w.clock.t += 1000;
  data(await space.post("/v1/ids/update", { name: "harlow", ...space.sealRecord("harlow", "bW92ZWQ", phone, phone.eid) }));
  // once the thief's device is a day old it is an older device
  w.clock.t += 25 * HOUR;
  w.clock.t += 1000;
  data(await space.post("/v1/ids/update", { name: "harlow", ...space.sealRecord("harlow", "bGF0ZXI", thief, thief.eid) }));
});

test("ids: the same newcomer rule holds for a person's record: a young device cannot repoint it, the founding phone can, and a young device may keep what it signed", async t => {
  const w = world(t), alex = await person(w), phone = alex.first;
  data(await alex.claim("alex"));
  const thief = await key("thief");
  w.clock.t += HOUR;
  data(await alex.post("/v1/ids/append", { name: "alex", ops: [await alex.accept(await alex.append({ type: "add", entry: thief.entry("device") }, phone))] }));
  w.clock.t += 1000;
  assert.equal(code(await alex.post("/v1/ids/update", { name: "alex", ...alex.sealRecord("alex", "ZXZpbA", thief) })), "newcomer", "a young device cannot repoint a person's record");
  w.clock.t += 1000;
  data(await alex.post("/v1/ids/update", { name: "alex", ...alex.sealRecord("alex", "bW92ZWQ", phone) }));
  w.clock.t += 25 * HOUR;
  data(await alex.post("/v1/ids/update", { name: "alex", ...alex.sealRecord("alex", "bGF0ZXI", thief) }));
  // a device added later is young and is not the record's signer: refused; the record's own signer keeps going
  const laptop = await key("laptop");
  data(await alex.post("/v1/ids/append", { name: "alex", ops: [await alex.accept(await alex.append({ type: "add", entry: laptop.entry("device") }, phone))] }));
  w.clock.t += 1000;
  assert.equal(code(await alex.post("/v1/ids/update", { name: "alex", ...alex.sealRecord("alex", "b3duIQ", laptop) })), "newcomer");
  w.clock.t += 1000;
  data(await alex.post("/v1/ids/update", { name: "alex", ...alex.sealRecord("alex", "c2FtZQ", thief) }));
});

test("ids: a key that was removed and put back is a newcomer again: it cannot repoint the record it once signed (a removal resets a key's age)", async t => {
  const w = world(t), alex = await person(w), phone = alex.first;
  data(await alex.claim("alex"));
  const thief = await key("thief");
  w.clock.t += HOUR;
  data(await alex.post("/v1/ids/append", { name: "alex", ops: [await alex.accept(await alex.append({ type: "add", entry: thief.entry("device") }, phone))] }));
  w.clock.t += 25 * HOUR;
  data(await alex.post("/v1/ids/update", { name: "alex", ...alex.sealRecord("alex", "bW92ZWQ", thief) }));
  // control: while it stays on the list it keeps going
  w.clock.t += 1000;
  data(await alex.post("/v1/ids/update", { name: "alex", ...alex.sealRecord("alex", "c3RpbGw", thief) }));
  // the phone removes it, then it is put back (the old key and the recovery code, say): it is a newcomer again
  data(await alex.post("/v1/ids/append", { name: "alex", ops: [await alex.accept(await alex.append({ type: "remove", target: thief.eid }, phone))] }));
  w.clock.t += 1000;
  data(await alex.post("/v1/ids/append", { name: "alex", ops: [await alex.accept(await alex.append({ type: "add", entry: thief.entry("device") }, phone))] }));
  w.clock.t += 1000;
  assert.equal(code(await alex.post("/v1/ids/update", { name: "alex", ...alex.sealRecord("alex", "ZXZpbA", thief) })), "newcomer", "a re-added key cannot repoint the record");
  // after 24 hours on the list again it is no newcomer
  w.clock.t += 25 * HOUR;
  data(await alex.post("/v1/ids/update", { name: "alex", ...alex.sealRecord("alex", "YmFjaw", thief) }));
});

test("ids: a young device may keep updating the space's record it signed itself (the phone that made the space this morning finishes setting it up)", async t => {
  const w = world(t), alex = await person(w), phone = alex.first;
  data(await alex.claim("alex"));
  const ctxFor = async id => id === alex.state.id ? alex.ops : null;
  const laptop = await key("laptop");
  w.clock.t += HOUR;
  data(await alex.post("/v1/ids/append", { name: "alex", ops: [await alex.accept(await alex.append({ type: "add", entry: laptop.entry("device") }, phone))] }));
  const space = await identity(w, laptop, { kind: "space", ctxFor });
  await space.genesis({ eid: alex.state.id, kind: "owner", subject: alex.state.id }, laptop.eid);
  data(await space.claim("harlow", "aG9tZQ", laptop, laptop.eid));
  w.clock.t += 1000;
  data(await space.post("/v1/ids/update", { name: "harlow", ...space.sealRecord("harlow", "cm91dGU", laptop, laptop.eid) }));
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

// ---- CORS for the browser app (lead's ruling 4 Oct): resolve is public read-only data; claim, append and update carry their own signature and take the app's origins ----

const raw = async (w, method, path, { origin, headers = {}, body } = {}) => {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const res = await worker.fetch(new Request(BASE + path, { method, headers: { ...(origin ? { origin } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), "cf-connecting-ip": "203.0.113.9", ...headers }, body: text }), w.env);
  return { status: res.status, h: n => res.headers.get(n), json: await res.json().catch(() => null) };
};

test("cors: resolve answers any origin, read-only, no credentials, and a preflight for it", async t => {
  const w = world(t);
  const alex = await person(w);
  data(await alex.claim("alex"));
  for (const origin of ["https://app.vyre.run", "https://evil.example", "null"]) {
    const r = await raw(w, "GET", "/v1/ids/resolve?name=alex", { origin, headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(r.status, 200, origin);
    assert.equal(r.h("access-control-allow-origin"), "*");
    assert.equal(r.h("access-control-allow-credentials"), null, "never with credentials");
    assert.equal(r.json.data.name, "alex");
  }
  const pre = await raw(w, "OPTIONS", "/v1/ids/resolve?name=alex", { origin: "https://app.vyre.run", headers: { "access-control-request-method": "GET" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.h("access-control-allow-origin"), "*");
  assert.match(pre.h("access-control-allow-methods"), /GET/);
  assert.equal((await raw(w, "GET", "/v1/ids/resolve?name=nobody", { origin: "https://evil.example" })).h("access-control-allow-origin"), "*", "an unknown name answers CORS too");
});

test("cors: claim, append and update accept the app's origin (and only its exact origin), answer it, and keep their limits; everything else still refuses a foreign Origin", async t => {
  const w = world(t, { APP_ORIGINS: "https://app.vyre.run, http://localhost:5173" });
  const alex = await person(w);
  const body = { name: "alex", ops: alex.ops, ...alex.sealRecord("alex", "c2VhbGVk") };
  const ok = await raw(w, "POST", "/v1/ids/claim", { origin: "https://app.vyre.run", headers: { "sec-fetch-site": "cross-site" }, body });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.h("access-control-allow-origin"), "https://app.vyre.run");
  assert.equal(ok.h("vary"), "origin");
  assert.equal(ok.h("access-control-allow-credentials"), null);
  const bob = await person(w);
  const dev = await raw(w, "POST", "/v1/ids/claim", { origin: "http://localhost:5173", body: { name: "bob", ops: bob.ops, ...bob.sealRecord("bob", "c2VhbGVk") } });
  assert.equal(dev.status, 200, "the stand-in's origin from APP_ORIGINS");
  for (const origin of ["https://evil.example", "https://app.vyre.run.evil.example", "http://app.vyre.run", "https://vyre.run", "null"]) {
    const r = await raw(w, "POST", "/v1/ids/claim", { origin, body });
    assert.equal(r.status, 403, origin);
    assert.equal(r.h("access-control-allow-origin"), null, "a foreign origin gets no CORS answer");
  }
  // preflights: the app origin for the three routes, nothing for others
  for (const p of ["/v1/ids/claim", "/v1/ids/append", "/v1/ids/update"]) {
    const pre = await raw(w, "OPTIONS", p, { origin: "https://app.vyre.run", headers: { "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    assert.equal(pre.status, 204, p);
    assert.equal(pre.h("access-control-allow-origin"), "https://app.vyre.run");
    assert.equal((await raw(w, "OPTIONS", p, { origin: "https://evil.example", headers: { "access-control-request-method": "POST" } })).status, 405, p);
  }
  for (const [method, p] of [["POST", "/v1/ids/alias"], ["DELETE", "/v1/ids/alias"], ["POST", "/v1/ids/release"], ["POST", "/v1/names/claim"], ["POST", "/v1/names/release"], ["POST", "/v1/names/code"]]) {
    assert.equal((await raw(w, "OPTIONS", p, { origin: "https://app.vyre.run", headers: { "access-control-request-method": method } })).status, 405, `${method} ${p} has no preflight`);
    const r = await raw(w, method, p, { origin: "https://app.vyre.run", body: { name: "alex" } });
    assert.equal(r.status, 403, `${method} ${p} still refuses a foreign Origin`);
  }
});

test("cors: the per-IP claim limit applies to claims from the app origin too", async t => {
  const w = world(t);
  const results = [];
  for (let i = 0; i < 7; i++) {
    const p = await person(w);
    const r = await raw(w, "POST", "/v1/ids/claim", { origin: "https://app.vyre.run", body: { name: `name${i}x`, ops: p.ops, ...p.sealRecord(`name${i}x`, "c2VhbGVk") } });
    results.push(r.status === 200 ? "ok" : code(r));
  }
  assert.equal(results.filter(x => x === "ok").length, 5, JSON.stringify(results));
  assert.ok(results.slice(5).every(x => x !== "ok"));
});

test("cors: the name availability check answers any origin like resolve (no credentials), and the claim limit per address is configurable", async t => {
  const w = world(t, { CLAIMS_PER_IP_PER_DAY: "8" });
  for (const origin of ["https://app.vyre.run", "http://localhost:5173", "https://evil.example"]) {
    const r = await raw(w, "GET", "/v1/names/check?name=freshname", { origin, headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(r.status, 200, origin);
    assert.equal(r.h("access-control-allow-origin"), "*");
    assert.equal(r.h("access-control-allow-credentials"), null);
    assert.equal(r.json.data.status, "ok");
  }
  const pre = await raw(w, "OPTIONS", "/v1/names/check?name=x", { origin: "https://app.vyre.run", headers: { "access-control-request-method": "GET" } });
  assert.equal(pre.status, 204);
  const results = [];
  for (let i = 0; i < 9; i++) { const p = await person(w); const r = await raw(w, "POST", "/v1/ids/claim", { origin: "https://app.vyre.run", body: { name: `limit${i}x`, ops: p.ops, ...p.sealRecord(`limit${i}x`, "c2VhbGVk") } }); results.push(r.status === 200 ? "ok" : code(r)); }
  assert.equal(results.filter(x => x === "ok").length, 8, JSON.stringify(results));
});

test("CO-1: the live config pins APP_ORIGINS to exactly one https origin, and no dev or wildcard origin", async () => {
  const fs = await import("node:fs"), url = await import("node:url"), path = await import("node:path");
  const toml = fs.readFileSync(path.join(path.dirname(url.fileURLToPath(import.meta.url)), "wrangler.toml"), "utf8");
  const m = /^APP_ORIGINS\s*=\s*"([^"]*)"/m.exec(toml);
  assert.ok(m, "APP_ORIGINS is set in [vars]");
  assert.match(m[1], /^https:\/\/[a-z0-9.-]+$/);
  assert.ok(!/localhost|127\.0\.0\.1|\*|,/.test(m[1]), m[1]);
  assert.equal(m[1], "https://app.vyre.run");
});

test("PT-1: certificates for a Space's names are DNS-01 only: the Space signs, the directory writes the TXT and one CAA that pins the ACME account; nobody else can", async t => {
  const w = world(t);
  const alex = await person(w);
  data(await alex.claim("alex"));
  const harlow = await identity(w, alex.first, { kind: "space", ctxFor: async id => id === alex.state.id ? alex.ops : null });
  await harlow.genesis({ eid: alex.state.id, kind: "owner", subject: alex.state.id, label: "Alex" }, alex.first.eid);
  data(await harlow.claim("harlow", "aG9tZQ", alex.first, alex.first.eid));
  w.clock.t += 25 * HOUR; // the signing device is no newcomer
  const spaceAct = async (action, subject, signer = alex.first) => ({ by: alex.state.id, via: signer.eid, ts: w.clock.t, sig: signer.sig64(I.actMessage({ action, name: "harlow", domain: subject, ts: w.clock.t })) });
  const TOKEN = "x".repeat(43);
  const ok = data(await harlow.post("/v1/ids/acme", { name: "harlow", token: TOKEN, act: await spaceAct("acme", TOKEN) }));
  assert.equal(ok.fqdn, "_acme-challenge.harlow.vyre.run");
  assert.deepEqual(w.dns.at("_acme-challenge.harlow.vyre.run", "TXT").map(r => r.content), [`"${TOKEN}"`]);
  // the CAA pin: issue and issuewild name the one account, nothing else, and a second pin replaces the first
  const acct = "https://acme-v02.api.letsencrypt.org/acme/acct/123456";
  data(await harlow.post("/v1/ids/caa", { name: "harlow", accounturi: acct, act: await spaceAct("caa", acct) }));
  const caa = w.dns.at("harlow.vyre.run", "CAA");
  assert.deepEqual(caa.map(r => [r.data.tag, r.data.value]).sort(), [["issue", `letsencrypt.org; accounturi=${acct}`], ["issuewild", `letsencrypt.org; accounturi=${acct}`]]);
  const acct2 = "https://acme-v02.api.letsencrypt.org/acme/acct/777";
  data(await harlow.post("/v1/ids/caa", { name: "harlow", accounturi: acct2, act: await spaceAct("caa", acct2) }));
  assert.equal(w.dns.at("harlow.vyre.run", "CAA").length, 2);
  assert.ok(w.dns.at("harlow.vyre.run", "CAA").every(r => r.data.value.endsWith("/777")));
  // refusals: an act for another token or action, a stranger's key, a bad token, a person's name, an unknown name
  assert.equal(code(await harlow.post("/v1/ids/acme", { name: "harlow", token: "y".repeat(43), act: await spaceAct("acme", TOKEN) })), "bad_signature", "an act for one token is not an act for another");
  assert.equal(code(await harlow.post("/v1/ids/acme", { name: "harlow", token: TOKEN, act: await spaceAct("caa", TOKEN) })), "bad_signature", "nor for another action");
  const stranger = await key("stranger");
  assert.equal(code(await harlow.post("/v1/ids/acme", { name: "harlow", token: TOKEN, act: await spaceAct("acme", TOKEN, stranger) })), "not_yours");
  assert.equal(code(await harlow.post("/v1/ids/acme", { name: "harlow", token: "short", act: await spaceAct("acme", "short") })), "bad_token");
  assert.equal(code(await harlow.post("/v1/ids/caa", { name: "harlow", accounturi: "http://evil.example/x", act: await spaceAct("caa", "http://evil.example/x") })), "bad_account");
  const pAct = { by: alex.first.eid, ts: w.clock.t, sig: alex.first.sig64(I.actMessage({ action: "acme", name: "alex", domain: TOKEN, ts: w.clock.t })) };
  assert.equal(code(await alex.post("/v1/ids/acme", { name: "alex", token: TOKEN, act: pAct })), "not_a_space", "a person's name gets no certificate through this");
  assert.equal(code(await harlow.post("/v1/ids/acme", { name: "nosuch", token: TOKEN, act: await spaceAct("acme", TOKEN) })), "not_found");
  assert.equal(w.dns.at("_acme-challenge.alex.vyre.run").length, 0);
  // the TXT is cleared by the Space, and only by it
  assert.equal(code(await harlow.del("/v1/ids/acme", { name: "harlow", act: await spaceAct("acme-clear", undefined, stranger) })), "not_yours");
  data(await harlow.del("/v1/ids/acme", { name: "harlow", act: await spaceAct("acme-clear", undefined) }));
  assert.equal(w.dns.at("_acme-challenge.harlow.vyre.run", "TXT").length, 0);
  // a challenge written for one Space is under that Space's label only, whatever the token says
  assert.deepEqual(w.dns.records.filter(r => r.type === "TXT").map(r => r.name), []);
});

test("ids: continuing one's own record needs a readable age: an unreadable or later `since` is not the same signer (fail closed)", async () => {
  const { continuesOwnRecord } = await import("./ids.js");
  const cur = { by: "e1", ts: 1000 };
  assert.equal(continuesOwnRecord(cur, { by: "e1", since: 500 }), true);
  assert.equal(continuesOwnRecord(cur, { by: "e1", since: 1000 }), true);
  assert.equal(continuesOwnRecord(cur, { by: "e1", since: 1001 }), false, "put back after the record: a newcomer");
  assert.equal(continuesOwnRecord(cur, { by: "e1", since: NaN }), false, "an unreadable age is not the same signer");
  assert.equal(continuesOwnRecord(cur, { by: "e1" }), false, "no age at all is not the same signer");
  assert.equal(continuesOwnRecord(cur, { by: "e2", since: 1 }), false);
  assert.equal(continuesOwnRecord({ by: "o", via: "d1", ts: 1000 }, { by: "o", via: "d1", since: 5 }), true);
  assert.equal(continuesOwnRecord({ by: "o", via: "d1", ts: 1000 }, { by: "o", via: "d2", since: 5 }), false);
  assert.equal(continuesOwnRecord(null, { by: "e1", since: 1 }), false);
});
