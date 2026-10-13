// @ts-check
// The whole GitHub sign-in with the escrow: the relay Worker, the escrow Worker (its own runtime and secrets), a fake GitHub and a fake names directory that applies ops with the real chain verifier.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import relay, * as W from "./index.js";
import escrow, * as E from "../../escrow/worker/index.js";
import { createRuntime } from "./fake-cf.js";
import * as C from "../../kernel/identity/chain.js";

const APP = "https://app.vyre.run", DAY = 86_400_000, T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
const SECRET = "x".repeat(40);
const KEK = Buffer.alloc(32, 7).toString("base64url");

async function key() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("base64url");
  const eid = await C.eidOf(pub);
  return { eid, pub, sig: m => crypto.sign(null, Buffer.from(m), privateKey).toString("base64url"), sign: m => crypto.sign(null, Buffer.from(m), privateKey), entry: kind => ({ eid, kind, pub }) };
}
/** A device that also has an agreement key, the way a real one does. */
function agreeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { agree: Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-65)).toString("base64url"), privateKey };
}
function openSealed(privateKey, s) {
  const peer = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"), Buffer.from(s.eph, "base64url")]), format: "der", type: "spki" });
  const bits = crypto.diffieHellman({ privateKey, publicKey: peer });
  const k = Buffer.from(crypto.hkdfSync("sha256", bits, Buffer.alloc(0), "vyre-gh-escrow-release-v1", 32));
  const ct = Buffer.from(s.ct, "base64url");
  const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(s.iv, "base64url"));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString());
}

async function world(t) {
  const clock = { t: T0 };
  const phone = await key();
  const g = await C.makeGenesis({ kind: "person", entry: phone.entry("device"), nonce: "n-" + phone.eid.slice(0, 8), ts: T0 - 3 * DAY, sign: phone.sign });
  const chain = { ops: [g], state: await C.verifyChain([g], { now: T0 }) };
  const hooks = { during: null };
  const names = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === "/health") return new Response(JSON.stringify({ ok: true, chain: { relayKey: true } }));
    if (u.pathname === "/v1/ids/resolve") { if (hooks.during) { const h = hooks.during; hooks.during = null; await h(); } }
    if (u.pathname === "/v1/ids/resolve") return new Response(JSON.stringify({ data: { name: "alex", kind: "person", id: chain.state.id, ops: chain.ops } }));
    if (u.pathname === "/v1/ids/append") {
      try { for (const op of JSON.parse(init.body).ops) { chain.state = await C.applyOp(chain.state, op, { now: clock.t, live: true }); chain.ops = [...chain.ops, op]; } return new Response("{}"); }
      catch (e) { return new Response(JSON.stringify({ error: String(e.code) }), { status: 400 }); }
    }
    return new Response("{}", { status: 404 });
  };
  const github = async (url, init = {}) => {
    const j = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (url.endsWith("/access_token")) return j({ access_token: "gho_T" });
    if (url === "https://api.github.com/user") return j({ id: 4242, login: "alex-gh", avatar_url: "https://avatars.githubusercontent.com/u/4242" });
    return j({}, 204);
  };
  const ert = createRuntime({ worker: escrow, Class: E.Escrow, classes: { ESCROW: E.Escrow }, env: { ESCROW_RELAY_SECRET: SECRET, ESCROW_KEK_k1: KEK, ESCROW_KEK_CURRENT: "k1", NAMES_FETCH: names, NOW: () => clock.t } });
  const escrowFetch = (url, init) => escrow.fetch(new Request(url, { ...init, headers: { ...(init.headers || {}), "cf-connecting-ip": "198.51.100.1" } }), ert.env);
  const rrt = createRuntime({ worker: relay, Class: W.RouteRelay, classes: { TICKETS: W.PairTicket, CODES: W.CodeSlot, GITHUB: W.GithubLinks },
    env: { GITHUB_OAUTH_CLIENT_ID: "id", GITHUB_OAUTH_CLIENT_SECRET: "s", GITHUB_FETCH: github, NAMES_FETCH: names, ESCROW_FETCH: escrowFetch, ESCROW_RELAY_SECRET: SECRET, NOW: () => clock.t } });
  t.after(async () => { await ert.settle(); await rrt.settle(); assert.deepEqual([...ert.errors, ...rrt.errors].map(String), []); });
  const req = (path, o = {}) => relay.fetch(new Request("https://relay.test" + path, { redirect: "manual", ...o, headers: { "cf-connecting-ip": "203.0.113.7", ...(o.headers || {}) } }), rrt.env);
  const post = (path, body) => req(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const signIn = async () => {
    const cv = crypto.randomBytes(32).toString("base64url");
    const cc = crypto.createHash("sha256").update(cv).digest("base64url");
    const s = await req(`/v1/github/start?cc=${cc}&app=${encodeURIComponent(APP)}`);
    const state = new URL(s.headers.get("location")).searchParams.get("state");
    const cb = await req(`/v1/github/callback?code=good&state=${state}`, { headers: { cookie: s.headers.get("set-cookie").split(";")[0] } });
    return { cv, ticket: new URLSearchParams(cb.headers.get("location").split("#")[1]).get("ticket") };
  };
  const tid = tk => crypto.createHash("sha256").update(tk).digest("base64url");
  const linkWith = async () => {
    const r = await signIn();
    const ts = clock.t;
    const res = await post("/v1/github/link", { ticket: r.ticket, cv: r.cv, name: "alex", eid: phone.eid, ts, sig: phone.sig(`${"vyre-gh-link-v1"}\n4242\n${chain.state.id}\n${tid(r.ticket)}\n${ts}\nrelay.test`) });
    return { res, body: await res.json() };
  };
  /** The device's side of a link: put the relay's entry on the list, then send the escrow the bundle. */
  const finishLink = async body => {
    const op = await C.makeOp(chain.state, { type: "add", entry: { eid: body.relay.eid, kind: "device", pub: body.relay.pub, held: "relay" } }, { by: phone.eid, ts: clock.t, sign: phone.sign });
    chain.state = await C.applyOp(chain.state, op, { now: clock.t, live: true }); chain.ops = [...chain.ops, op];
    return escrowFetch("https://escrow.test/v1/escrow/put", { method: "POST", body: JSON.stringify({ token: body.escrow.token, bundle: { sk: "VSK1-SECRET-KEY-VALUE", home: JSON.stringify({ v: 1, relay: "wss://relay.vyre.run", route: "r".repeat(26), box: "b".repeat(43) }) } }) });
  };
  return { hooks, clock, phone, chain, ert, rrt, req, post, signIn, linkWith, finishLink, escrowFetch };
}

test("link, then a new device signs in with GitHub: it is added as a limited device and gets the Secret Key and home hint sealed to its own agreement key", async t => {
  const w = await world(t);
  const { res, body } = await w.linkWith();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal((await w.finishLink(body)).status, 200);
  const dev = await key(), ag = agreeKey();
  const r = await w.signIn();
  const out = await w.post("/v1/github/enter", { ticket: r.ticket, cv: r.cv, device: { eid: dev.eid, pub: dev.pub, agree: ag.agree } });
  assert.equal(out.status, 200, JSON.stringify(await out.clone().json()));
  const j = await out.json();
  assert.equal(j.name, "alex");
  const opened = openSealed(ag.privateKey, j.sealed);
  assert.equal(opened.sk, "VSK1-SECRET-KEY-VALUE");
  assert.equal(JSON.parse(opened.home).route, "r".repeat(26));
  const e = w.chain.state.entries.find(x => x.eid === dev.eid);
  assert.equal(e.via, "github");
  assert.equal(e.confirmed, undefined, "added limited");
  // the limited device changes nothing on the list; the phone confirms it
  await assert.rejects(C.makeOp(w.chain.state, { type: "remove", target: w.phone.eid }, { by: dev.eid, ts: w.clock.t + 2 * DAY, sign: dev.sign }).then(op => C.applyOp(w.chain.state, op, { now: w.clock.t + 2 * DAY })), x => x.code === "limited");
  // nothing of the Secret Key sits in the relay's storage, and the escrow stores it only sealed
  assert.ok(!JSON.stringify([...w.rrt.object("links", "GITHUB").ctx.storage.map]).includes("VSK1"));
  assert.ok(!JSON.stringify([...w.ert.object("escrow", "ESCROW").ctx.storage.map]).includes("VSK1"));
});

test("a GitHub id that is not linked gets 'not linked', and a bad device or a replayed ticket gets nothing", async t => {
  const w = await world(t);
  const r = await w.signIn();
  const dev = await key(), ag = agreeKey();
  assert.equal((await w.post("/v1/github/enter", { ticket: r.ticket, cv: r.cv, device: { eid: dev.eid, pub: dev.pub, agree: ag.agree } })).status, 404);
  const { body } = await w.linkWith(); await w.finishLink(body);
  const r2 = await w.signIn();
  assert.equal((await w.post("/v1/github/enter", { ticket: r2.ticket, cv: r2.cv, device: { eid: "bad", pub: dev.pub, agree: ag.agree } })).status, 409);
  const ok = await w.post("/v1/github/enter", { ticket: r2.ticket, cv: r2.cv, device: { eid: dev.eid, pub: dev.pub, agree: ag.agree } });
  assert.equal(ok.status, 200);
  assert.equal((await w.post("/v1/github/enter", { ticket: r2.ticket, cv: r2.cv, device: { eid: dev.eid, pub: dev.pub, agree: ag.agree } })).status, 401, "a ticket opens one sign-in");
});

test("the escrow answers only the relay (MAC and time), refuses a stale call, and a put token works once", async t => {
  const w = await world(t);
  const { body } = await w.linkWith();
  const call = (op, b) => w.escrowFetch(`https://escrow.test/v1/escrow/${op}`, { method: "POST", body: JSON.stringify(b) });
  assert.equal((await call("release", { ghid: 4242, device: {}, ts: w.clock.t, m: "forged" })).status, 401);
  const rest = { ghid: 4242, identity: w.chain.state.id, ts: w.clock.t - 10 * 60_000, n: "s".repeat(20) };
  assert.equal((await call("delete", { ...rest, m: await E.mac(SECRET, "delete", rest) })).status, 401, "stale");
  assert.equal((await w.finishLink(body)).status, 200);
  const again = await w.escrowFetch("https://escrow.test/v1/escrow/put", { method: "POST", body: JSON.stringify({ token: body.escrow.token, bundle: { sk: "VSK1-OTHER-OTHER" } }) });
  assert.equal(again.status, 401, "a put token is one use");
});

test("the Secret Key is refreshed by a device-signed request, and a vault reset's new key replaces the old", async t => {
  const w = await world(t);
  const { body } = await w.linkWith(); await w.finishLink(body);
  const { nonce } = await (await w.post("/v1/github/challenge", { name: "alex" })).json();
  const ts = w.clock.t;
  const res = await w.post("/v1/github/account", { name: "alex", action: "refresh", nonce, eid: w.phone.eid, ts, sig: w.phone.sig(`vyre-gh-account-v1\nrefresh\n${w.chain.state.id}\n${nonce}\n${ts}\nrelay.test`) });
  assert.equal(res.status, 200);
  const j = await res.json();
  const put = await w.escrowFetch("https://escrow.test/v1/escrow/put", { method: "POST", body: JSON.stringify({ token: j.escrow.token, bundle: { sk: "VSK2-NEW-KEY-AFTER-RESET", home: null } }) });
  assert.equal(put.status, 200);
  const dev = await key(), ag = agreeKey(), r = await w.signIn();
  const out = await (await w.post("/v1/github/enter", { ticket: r.ticket, cv: r.cv, device: { eid: dev.eid, pub: dev.pub, agree: ag.agree } })).json();
  assert.equal(openSealed(ag.privateKey, out.sealed).sk, "VSK2-NEW-KEY-AFTER-RESET");
});

test("unlink purges the sealed key and the relay's key: a later sign-in finds nothing, and a re-link makes a different relay key", async t => {
  const w = await world(t);
  const first = await w.linkWith(); await w.finishLink(first.body);
  const { nonce } = await (await w.post("/v1/github/challenge", { name: "alex" })).json();
  const ts = w.clock.t;
  assert.equal((await w.post("/v1/github/account", { name: "alex", action: "unlink", nonce, eid: w.phone.eid, ts, sig: w.phone.sig(`vyre-gh-account-v1\nunlink\n${w.chain.state.id}\n${nonce}\n${ts}\nrelay.test`) })).status, 200);
  assert.deepEqual([...w.ert.object("escrow", "ESCROW").ctx.storage.map.keys()].filter(k => k.startsWith("g/") || k.startsWith("i/")), []);
  const dev = await key(), ag = agreeKey(), r = await w.signIn();
  assert.equal((await w.post("/v1/github/enter", { ticket: r.ticket, cv: r.cv, device: { eid: dev.eid, pub: dev.pub, agree: ag.agree } })).status, 404);
  const second = await w.linkWith();
  assert.equal(second.res.status, 200);
  assert.notEqual(second.body.relay.pub, first.body.relay.pub, "a new key pair on every link");
});

test("the fourth device in a day is refused by the chain, and repeated failures lock only the GitHub path", async t => {
  const w = await world(t);
  const { body } = await w.linkWith(); await w.finishLink(body);
  for (let i = 0; i < 3; i++) { const d = await key(), ag = agreeKey(), r = await w.signIn(); assert.equal((await w.post("/v1/github/enter", { ticket: r.ticket, cv: r.cv, device: { eid: d.eid, pub: d.pub, agree: ag.agree } })).status, 200); }
  const d = await key(), ag = agreeKey(), r = await w.signIn();
  const four = await w.post("/v1/github/enter", { ticket: r.ticket, cv: r.cv, device: { eid: d.eid, pub: d.pub, agree: ag.agree } });
  assert.ok([409, 429].includes(four.status));
  // the owner's own phone still signs a change, locked or not
  const op = await C.makeOp(w.chain.state, { type: "add", entry: (await key()).entry("device") }, { by: w.phone.eid, ts: w.clock.t, sign: w.phone.sign });
  await C.applyOp(w.chain.state, op, { now: w.clock.t, live: true });
});

test("a reset's new Secret Key put while a release waits on the directory is the one released, and an unlink during a release is not undone", async t => {
  const w = await world(t);
  const { body } = await w.linkWith(); await w.finishLink(body);
  const store = () => w.ert.object("escrow", "ESCROW").ctx.storage.map;
  // What a refresh put leaves in storage (the fake serialises one object's calls, so the interleaving is made by writing the record the put would have written).
  const before = structuredClone(store().get("g/4242"));
  const rest = { ghid: 4242, identity: w.chain.state.id, ts: w.clock.t, n: "t".repeat(20) };
  const tk = await (await w.escrowFetch("https://escrow.test/v1/escrow/token", { method: "POST", body: JSON.stringify({ ...rest, m: await E.mac(SECRET, "token", rest) }) })).json();
  assert.equal((await w.escrowFetch("https://escrow.test/v1/escrow/put", { method: "POST", body: JSON.stringify({ token: tk.token, bundle: { sk: "VSK3-FRESH-AFTER-RESET", home: null } }) })).status, 200);
  const after = structuredClone(store().get("g/4242"));
  store().set("g/4242", before);
  const dev = await key(), ag = agreeKey(), r = await w.signIn();
  w.hooks.during = async () => { store().set("g/4242", { ...structuredClone(store().get("g/4242")), bundle: after.bundle }); };
  const out = await (await w.post("/v1/github/enter", { ticket: r.ticket, cv: r.cv, device: { eid: dev.eid, pub: dev.pub, agree: ag.agree } })).json();
  assert.equal(openSealed(ag.privateKey, out.sealed).sk, "VSK3-FRESH-AFTER-RESET", "not the stale key read before the wait");
  // an unlink that lands during a release: nothing is resurrected
  const dev2 = await key(), ag2 = agreeKey(), r2 = await w.signIn();
  w.hooks.during = async () => { store().delete("g/4242"); store().delete("i/" + w.chain.state.id); };
  const gone = await w.post("/v1/github/enter", { ticket: r2.ticket, cv: r2.cv, device: { eid: dev2.eid, pub: dev2.pub, agree: ag2.agree } });
  assert.ok([404, 409].includes(gone.status), String(gone.status));
  assert.deepEqual([...store().keys()].filter(k => k.startsWith("g/") || k.startsWith("i/")), []);
});

test("a captured relay call cannot be replayed, and old counters and nonces are pruned", async t => {
  const w = await world(t);
  const { body } = await w.linkWith();
  void body;
  const rest = { ghid: 4242, identity: w.chain.state.id, ts: w.clock.t, n: "z".repeat(20) };
  const send = async () => (await w.escrowFetch("https://escrow.test/v1/escrow/token", { method: "POST", body: JSON.stringify({ ...rest, m: await E.mac(SECRET, "token", rest) }) })).status;
  assert.equal(await send(), 200);
  assert.equal(await send(), 401, "the same call again");
  w.clock.t += 3 * 3_600_000;
  const rest2 = { ghid: 4242, identity: w.chain.state.id, ts: w.clock.t, n: "y".repeat(20) };
  await w.escrowFetch("https://escrow.test/v1/escrow/token", { method: "POST", body: JSON.stringify({ ...rest2, m: await E.mac(SECRET, "token", rest2) }) });
  const keys = [...w.ert.object("escrow", "ESCROW").ctx.storage.map.keys()];
  assert.ok(!keys.includes("r/" + "z".repeat(20)), "the spent nonce is gone after its window");
});
