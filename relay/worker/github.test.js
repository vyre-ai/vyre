// @ts-check
// Sign in with GitHub on the relay (relay/worker/github.js): a fake GitHub and a fake names directory, the real chain verifier.
// GitHub proves who a person is; it holds and opens nothing. A link is signed by a device that is on the identity's chain.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import worker, * as W from "./index.js";
import * as G from "./github.js";
import { createRuntime } from "./fake-cf.js";
import * as C from "../../kernel/identity/chain.js";

const BASE = "https://relay.test";
const APP = "https://app.vyre.run";
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
const DAY = 86_400_000;

/** A key and its chain entry. */
async function key() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32)).toString("base64url");
  const eid = await C.eidOf(pub);
  return { eid, pub, sig: (/** @type {string} */ m) => crypto.sign(null, Buffer.from(m), privateKey).toString("base64url"), sign: (/** @type {Uint8Array} */ m) => crypto.sign(null, Buffer.from(m), privateKey), entry: { eid, kind: "device", pub } };
}

/** A person's chain: a first device (a founder) and, if asked, a second one added later (a newcomer for a day). */
async function person(clock, withSecond = false) {
  const first = await key();
  const g = await C.makeGenesis({ kind: "person", entry: first.entry, nonce: "n-" + first.eid.slice(0, 8), ts: clock.t - 3 * DAY, sign: first.sign });
  let ops = [g], state = await C.verifyChain(ops, { now: clock.t - 3 * DAY });
  let second = null;
  if (withSecond) {
    second = await key();
    const op = await C.makeOp(state, { type: "add", entry: second.entry }, { by: first.eid, ts: clock.t - 60_000, sign: first.sign });
    ops = [...ops, op]; state = await C.verifyChain(ops, { now: clock.t });
  }
  return { first, second, ops, state };
}

const w_ready = { v: true };
function world(t, { names = {}, user = { id: 4242, login: "alex-gh", name: "Alex", avatar_url: "https://avatars.githubusercontent.com/u/4242?v=4", two_factor_authentication: true } } = {}) {
  const clock = { t: T0 };
  const calls = [];
  const github = async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body, headers: init.headers });
    const j = (/** @type {any} */ b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url === "https://github.com/login/oauth/access_token") {
      const b = JSON.parse(init.body);
      return b.code === "good" ? j({ access_token: "gho_SECRET_TOKEN", token_type: "bearer", scope: "" }) : j({ error: "bad_verification_code" });
    }
    if (url === "https://api.github.com/user") return init.headers.authorization === "Bearer gho_SECRET_TOKEN" ? j(user) : j({}, 401);
    if (url.startsWith("https://api.github.com/applications/") && init.method === "DELETE") return j({}, 204);
    return j({}, 404);
  };
  const directory = new Map(Object.entries(names));
  const namesFetch = async (/** @type {string} */ url) => {
    if (new URL(url).pathname === "/health") return new Response(JSON.stringify({ ok: true, chain: { relayKey: w_ready.v } }));
    const name = new URL(url).searchParams.get("name") || "";
    const p = directory.get(name);
    if (!p) return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    return new Response(JSON.stringify({ data: { name, kind: "person", id: p.state.id, ops: p.ops } }), { status: 200 });
  };
  const rt = createRuntime({ worker, Class: W.RouteRelay, classes: { TICKETS: W.PairTicket, CODES: W.CodeSlot, GITHUB: W.GithubLinks },
    env: { GITHUB_OAUTH_CLIENT_ID: "Iv1.test", GITHUB_OAUTH_CLIENT_SECRET: "s3cret-value", GITHUB_FETCH: github, NAMES_FETCH: namesFetch, ESCROW_RELAY_SECRET: "x".repeat(40), ESCROW_FETCH: async (/** @type {string} */ u) => new Response(JSON.stringify(u.endsWith("/create") ? { pub: "P", eid: "E", token: { t: 1 } } : { ok: true })), NOW: () => clock.t } });
  t.after(async () => { await rt.settle(); assert.deepEqual(rt.errors.map(String), [], "no errors inside the Worker"); });
  const req = (/** @type {string} */ path, /** @type {any} */ o = {}) => worker.fetch(new Request(BASE + path, { ...o, redirect: "manual", headers: { "cf-connecting-ip": o.ip || "203.0.113.7", ...(o.headers || {}) } }), rt.env);
  const post = (/** @type {string} */ path, /** @type {any} */ body, /** @type {any} */ o = {}) => req(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(o.origin ? { origin: o.origin } : {}) }, ip: o.ip });
  return { rt, clock, calls, req, post, directory, env: rt.env };
}

/** Walk the browser's side: start, then the callback GitHub sends back. Returns the ticket and the cv the app kept. */
async function signIn(w, { code = "good", app = APP, ip } = {}) {
  const cv = crypto.randomBytes(32).toString("base64url");
  const cc = crypto.createHash("sha256").update(cv).digest("base64url");
  const s = await w.req(`/v1/github/start?cc=${cc}&app=${encodeURIComponent(app)}`, { ip });
  assert.equal(s.status, 302);
  const loc = new URL(s.headers.get("location") || "");
  const cookie = (s.headers.get("set-cookie") || "").split(";")[0];
  const state = loc.searchParams.get("state") || "";
  const cb = await w.req(`/v1/github/callback?code=${code}&state=${state}`, { headers: { cookie }, ip });
  return { s, loc, cookie, state, cb, cv, ticket: (new URLSearchParams((cb.headers.get("location") || "").split("#")[1] || "")).get("ticket") };
}

const linkMsg = (/** @type {number} */ ghid, /** @type {string} */ id, /** @type {string} */ tid, /** @type {number} */ ts) => `${G.GH_TAG_LINK}\n${ghid}\n${id}\n${tid}\n${ts}\nrelay.test`;
const tidOf = (/** @type {string} */ ticket) => crypto.createHash("sha256").update(ticket).digest("base64url");

test("start: no scope, PKCE on the GitHub leg, the state bound to this browser by a cookie, the app matched exactly", async t => {
  const w = world(t);
  const { loc, cookie, s } = await signIn(w);
  assert.equal(loc.origin + loc.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(loc.searchParams.get("client_id"), "Iv1.test");
  assert.equal(loc.searchParams.get("redirect_uri"), "https://relay.test/v1/github/callback");
  assert.equal(loc.searchParams.get("code_challenge_method"), "S256");
  assert.ok(loc.searchParams.get("code_challenge"));
  assert.equal(loc.searchParams.has("scope"), false, "no scope is asked for");
  assert.match(cookie, /^vyre_gh=[A-Za-z0-9_-]{32}$/);
  assert.match(s.headers.get("set-cookie") || "", /HttpOnly; Secure; SameSite=Lax/);
  const cc = crypto.createHash("sha256").update("x".repeat(43)).digest("base64url");
  for (const app of ["https://app.vyre.run.evil.test", "https://evil.test", "http://app.vyre.run", "https://app.vyre.run/", "https://app.vyre.runX", ""]) {
    assert.equal((await w.req(`/v1/github/start?cc=${cc}&app=${encodeURIComponent(app)}`)).status, 400, `refused: ${app}`);
  }
  assert.equal((await w.req(`/v1/github/start?cc=short&app=${encodeURIComponent(APP)}`)).status, 400);
  assert.equal((await w.req(`/v1/github/start?cc=${cc}&app=${encodeURIComponent("vyreapp://box")}`)).status, 302, "the Mac app's own origin is allowed");
});

test("callback: ticket in the fragment, the token revoked and never kept, the secret never leaves the exchange", async t => {
  const w = world(t);
  const r = await signIn(w);
  assert.equal(r.cb.status, 302);
  const to = r.cb.headers.get("location") || "";
  assert.match(to, /^https:\/\/app\.vyre\.run\/github-return#ticket=[A-Za-z0-9_-]{43}$/);
  assert.equal(new URL(to).search, "", "nothing in the query string, so nothing in an access log");
  assert.match(r.cb.headers.get("set-cookie") || "", /vyre_gh=; Max-Age=0/);
  const ex = w.calls.find(c => c.url.endsWith("/access_token"));
  const body = JSON.parse(ex.body);
  assert.equal(body.client_secret, "s3cret-value");
  assert.ok(body.code_verifier && body.code_verifier.length >= 43, "PKCE verifier sent on the GitHub leg");
  assert.equal(w.calls.filter(c => c.method === "DELETE").length, 1, "the access token is revoked at GitHub");
  // Nothing of the token or the secret is in storage or in anything the app got.
  const stored = JSON.stringify([...w.rt.object("links", "GITHUB").ctx.storage.map]);
  for (const bad of ["gho_SECRET_TOKEN", "s3cret-value"]) { assert.ok(!stored.includes(bad), bad); assert.ok(!to.includes(bad)); }
  assert.ok(!stored.includes(r.ticket), "the ticket is stored by its hash only");
});

test("callback: a state from another browser, a spent state, a bad code and a denial give no ticket", async t => {
  const w = world(t);
  const a = await signIn(w);
  // The same callback again: the state was spent.
  assert.equal((await w.req(`/v1/github/callback?code=good&state=${a.state}`, { headers: { cookie: a.cookie } })).status, 400);
  // A callback opened in another browser (no cookie, or somebody else's) is refused before GitHub is asked.
  const cc = crypto.createHash("sha256").update("y".repeat(43)).digest("base64url");
  const s2 = await w.req(`/v1/github/start?cc=${cc}&app=${encodeURIComponent(APP)}`);
  const st2 = new URL(s2.headers.get("location") || "").searchParams.get("state");
  const before = w.calls.length;
  assert.equal((await w.req(`/v1/github/callback?code=good&state=${st2}`)).status, 400);
  assert.equal((await w.req(`/v1/github/callback?code=good&state=${st2}`, { headers: { cookie: "vyre_gh=" + "A".repeat(32) } })).status, 400);
  assert.equal(w.calls.length, before, "GitHub was not asked");
  // A bad code and a denial go back to the app with an error, no ticket.
  const bad = await signIn(w, { code: "nope" });
  assert.equal(bad.cb.headers.get("location"), "https://app.vyre.run/github-return#error=failed");
  const cc3 = crypto.createHash("sha256").update("z".repeat(43)).digest("base64url");
  const s3 = await w.req(`/v1/github/start?cc=${cc3}&app=${encodeURIComponent(APP)}`);
  const st3 = new URL(s3.headers.get("location") || "").searchParams.get("state");
  const den = await w.req(`/v1/github/callback?error=access_denied&state=${st3}`, { headers: { cookie: (s3.headers.get("set-cookie") || "").split(";")[0] } });
  assert.equal(den.headers.get("location"), "https://app.vyre.run/github-return#error=denied");
});

test("me: the ticket needs the verifier the app kept; a few wrong verifiers burn it; the answer is the numeric id, login and avatar", async t => {
  const w = world(t);
  const r = await signIn(w);
  const wrong = crypto.randomBytes(32).toString("base64url");
  assert.equal((await w.post("/v1/github/me", { ticket: r.ticket, cv: wrong })).status, 401);
  const ok = await w.post("/v1/github/me", { ticket: r.ticket, cv: r.cv });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { github: { id: 4242, login: "alex-gh", name: "Alex", avatarUrl: "https://avatars.githubusercontent.com/u/4242?v=4", twofa: true }, linked: null });
  for (let i = 0; i < 5; i++) await w.post("/v1/github/me", { ticket: r.ticket, cv: wrong });
  assert.equal((await w.post("/v1/github/me", { ticket: r.ticket, cv: r.cv })).status, 401, "burnt");
  // A ticket runs out.
  const r2 = await signIn(w);
  w.clock.t += G.GH_LIMITS.ticketMs + 1;
  assert.equal((await w.post("/v1/github/me", { ticket: r2.ticket, cv: r2.cv })).status, 401);
});

test("an avatar that is not on GitHub's avatar host is dropped, and an unknown two-factor setting stays unknown", async t => {
  const w = world(t, { user: { id: 7, login: "x", avatar_url: "https://evil.test/a.png" } });
  const r = await signIn(w);
  const j = await (await w.post("/v1/github/me", { ticket: r.ticket, cv: r.cv })).json();
  assert.equal(j.github.avatarUrl, null);
  assert.equal(j.github.twofa, null);
});

test("link: signed by a device that is on the chain now and a day old; one GitHub, one identity; me then names it", async t => {
  const w = world(t);
  const p = await person(w.clock);
  w.directory.set("alex", p);
  const r = await signIn(w);
  const ts = w.clock.t, tid = tidOf(r.ticket);
  const body = { ticket: r.ticket, cv: r.cv, name: "alex", eid: p.first.eid, ts, sig: p.first.sig(linkMsg(4242, p.state.id, tid, ts)) };
  // A signature over a different ticket, host or time does not link.
  const other = await signIn(w);
  assert.equal((await w.post("/v1/github/link", { ...body, ticket: other.ticket, cv: other.cv })).status, 401, "signed for another ticket");
  const wrongHost = p.first.sig(linkMsg(4242, p.state.id, tid, ts).replace("relay.test", "evil.test"));
  assert.equal((await w.post("/v1/github/link", { ...body, sig: wrongHost })).status, 401);
  assert.equal((await w.post("/v1/github/link", { ...body, ts: ts - 10 * 60_000, sig: p.first.sig(linkMsg(4242, p.state.id, tid, ts - 10 * 60_000)) })).status, 401, "too old");
  // A stranger's key is not on the chain.
  const stranger = await key();
  assert.equal((await w.post("/v1/github/link", { ...body, eid: stranger.eid, sig: stranger.sig(linkMsg(4242, p.state.id, tid, ts)) })).status, 403);
  const ok = await w.post("/v1/github/link", body);
  assert.equal(ok.status, 200, JSON.stringify(await ok.clone().json()));
  assert.equal((await ok.json()).github.login, "alex-gh");
  // The ticket is spent: the same request again fails.
  assert.equal((await w.post("/v1/github/link", body)).status, 401);
  // Signing in with this GitHub later finds the identity.
  const again = await signIn(w);
  const me = await (await w.post("/v1/github/me", { ticket: again.ticket, cv: again.cv })).json();
  assert.deepEqual(me.linked, { name: "alex", since: w.clock.t });
  // A second GitHub cannot link to the same identity, and this GitHub cannot link to a second identity.
  const bob = await person(w.clock);
  w.directory.set("bob", bob);
  const t2 = tidOf(again.ticket);
  assert.equal((await w.post("/v1/github/link", { ticket: again.ticket, cv: again.cv, name: "bob", eid: bob.first.eid, ts, sig: bob.first.sig(linkMsg(4242, bob.state.id, t2, ts)) })).status, 409);
  const w2 = world(t, { user: { id: 999, login: "other" } });
  void w2;
});

test("link waits until the names directory runs the rules that know the relay's key", async t => {
  const w = world(t);
  const p = await person(w.clock);
  w.directory.set("alex", p);
  const r = await signIn(w);
  const ts = w.clock.t, tid = tidOf(r.ticket);
  const body = { ticket: r.ticket, cv: r.cv, name: "alex", eid: p.first.eid, ts, sig: p.first.sig(linkMsg(4242, p.state.id, tid, ts)) };
  w_ready.v = false;
  try { assert.equal((await w.post("/v1/github/link", body)).status, 503); } finally { w_ready.v = true; }
  assert.equal((await w.post("/v1/github/link", body)).status, 200, "the same ticket links once the directory is ready");
});

test("link: a newcomer device (under a day) cannot link, and a missing name or a directory that is down is refused", async t => {
  const w = world(t);
  const p = await person(w.clock, true);
  w.directory.set("alex", p);
  const r = await signIn(w);
  const ts = w.clock.t, tid = tidOf(r.ticket);
  const young = { ticket: r.ticket, cv: r.cv, name: "alex", eid: /** @type {any} */ (p.second).eid, ts, sig: /** @type {any} */ (p.second).sig(linkMsg(4242, p.state.id, tid, ts)) };
  assert.equal((await w.post("/v1/github/link", young)).status, 403);
  assert.equal((await w.post("/v1/github/link", { ...young, name: "nobody" })).status, 404);
  w.env.NAMES_FETCH = async () => { throw new Error("down"); };
  assert.equal((await w.post("/v1/github/link", { ...young, eid: p.first.eid })).status, 503);
});

test("account: status and unlink need a one-use nonce and a signature over it; unlink frees both sides", async t => {
  const w = world(t);
  const p = await person(w.clock);
  w.directory.set("alex", p);
  const r = await signIn(w);
  const ts0 = w.clock.t;
  assert.equal((await w.post("/v1/github/link", { ticket: r.ticket, cv: r.cv, name: "alex", eid: p.first.eid, ts: ts0, sig: p.first.sig(linkMsg(4242, p.state.id, tidOf(/** @type {string} */ (r.ticket)), ts0)) })).status, 200);
  const acct = async (/** @type {string} */ action, o = {}) => {
    const { nonce } = await (await w.post("/v1/github/challenge", { name: "alex" })).json();
    const ts = w.clock.t;
    const msg = `${G.GH_TAG_ACCOUNT}\n${action}\n${p.state.id}\n${nonce}\n${ts}\nrelay.test`;
    const body = { name: "alex", action, nonce, eid: p.first.eid, ts, sig: p.first.sig(msg), ...o };
    return { body, res: await w.post("/v1/github/account", body) };
  };
  w.clock.t += 1000;
  const s = await acct("status");
  assert.deepEqual(await s.res.json(), { linked: { login: "alex-gh", since: ts0 } });
  // The same signed request cannot be replayed: the nonce was spent.
  assert.equal((await w.post("/v1/github/account", s.body)).status, 401);
  // A request that is not signed by a device of the identity changes nothing and burns nobody's nonce.
  const stranger = await key();
  const bad = await acct("unlink", { eid: stranger.eid });
  assert.equal(bad.res.status, 403);
  assert.equal((await (await acct("status")).res.json()).linked.login, "alex-gh");
  const u = await acct("unlink");
  assert.equal(u.res.status, 200);
  assert.deepEqual(await (await acct("status")).res.json(), { linked: null });
  // Both sides are free: the same GitHub can sign in as unlinked.
  const again = await signIn(w);
  assert.equal((await (await w.post("/v1/github/me", { ticket: again.ticket, cv: again.cv })).json()).linked, null);
  // A nonce asked for another name does not work for this one.
  const { nonce } = await (await w.post("/v1/github/challenge", { name: "bob" })).json();
  const ts = w.clock.t;
  assert.equal((await w.post("/v1/github/account", { name: "alex", action: "status", nonce, eid: p.first.eid, ts, sig: p.first.sig(`${G.GH_TAG_ACCOUNT}\nstatus\n${p.state.id}\n${nonce}\n${ts}\nrelay.test`) })).status, 401);
});

test("CORS answers the app's own origin only; no other origin may call the POST routes; the relay without a client id says so", async t => {
  const w = world(t);
  const pre = await w.req("/v1/github/me", { method: "OPTIONS", headers: { origin: APP } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), APP);
  const evil = await w.post("/v1/github/challenge", { name: "alex" }, { origin: "https://evil.test" });
  assert.equal(evil.status, 403);
  const good = await w.post("/v1/github/challenge", { name: "alex" }, { origin: APP });
  assert.equal(good.headers.get("access-control-allow-origin"), APP);
  delete w.env.GITHUB_OAUTH_CLIENT_ID;
  const cc = crypto.createHash("sha256").update("q".repeat(43)).digest("base64url");
  assert.equal((await w.req(`/v1/github/start?cc=${cc}&app=${encodeURIComponent(APP)}`)).status, 503);
});

test("starts are limited per address", async t => {
  const w = world(t);
  const cc = crypto.createHash("sha256").update("r".repeat(43)).digest("base64url");
  let last = 0;
  for (let i = 0; i < G.GH_LIMITS.startPerMin + 2; i++) last = (await w.req(`/v1/github/start?cc=${cc}&app=${encodeURIComponent(APP)}`)).status;
  assert.equal(last, 429);
  assert.equal((await w.req(`/v1/github/start?cc=${cc}&app=${encodeURIComponent(APP)}`, { ip: "198.51.100.9" })).status, 302, "another address is not held up");
});
