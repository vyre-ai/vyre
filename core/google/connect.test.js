// @ts-check
// "Sign in with Google" alone (connect.js), against the fake Google, with its vyred side injected:
// the vault is a Map and the account list is an array. The whole module inside a real vyred is in
// module.test.js. Nothing here reaches real Google, and the listener is always on port 0.
//
// What these prove: the loopback and the pasted address both end in a saved refresh token and an
// account; a bad, reused or expired state, a declined consent and a missing refresh token each
// fail in plain words; the listener exists only while a sign-in is open; and no value reaches a
// result, an error, an event or a log line.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { connector, CONSENT_SCOPES } from "./connect.js";
import { startFakeGoogle } from "../../lib/connectors/testing/fake-google.js";
import { allowLoopbackForTests } from "../../lib/http.js";
allowLoopbackForTests();   // this file runs its fakes on loopback

const ME = "alex@example.com";

/** A connector over a pretend vault and account list, recording everything that leaves it. */
function rig(t, fake, opts = {}) {
  const client = fake.oauthClient();
  const items = new Map([["google-client", { ...client }]]);
  const accounts = [];
  const saved = [];
  const events = [];
  const lines = [];
  const out = [];
  const c = connector({
    fetchItem: async (item, field) => {
      const v = items.get(item);
      if (!v) throw new Error(`${item} is not granted to google`);
      if (!(field in v)) throw new Error(`${item} has no field ${field}`);
      return v[field];
    },
    taken: name => accounts.some(a => a.name === name),
    save: async (item, fields) => { saved.push({ item, fields }); items.set(item, fields); },
    add: async acct => { accounts.push(acct); },
    emit: (type, payload) => events.push({ type, payload }),
    log: (m, x) => lines.push(`${m} ${JSON.stringify(x || {})}`),
    ...opts,
  });
  t.after(() => c.stop());
  /** Call a method and keep what came back, result or error, for the leak check. */
  const keep = async p => { try { const r = await p; out.push(r); return r; } catch (e) { out.push(String(/** @type {any} */ (e).message)); throw e; } };
  return { c, client, items, accounts, saved, events, lines, out, keep };
}

/** Is anything accepting connections on this loopback port? */
const listening = port => new Promise(resolve => {
  const s = net.connect(port, "127.0.0.1");
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
});

/** Every value that must never leave: the secret, codes, verifiers, tokens. */
function assertNoLeak(r, fake, extra = []) {
  const everything = JSON.stringify([r.out, r.events, r.lines]);
  const values = [r.client.client_secret, ...fake.tokens.keys(), ...fake.issued.keys(), ...extra];
  for (const v of values) assert.ok(!everything.includes(v), `a value leaked: ${v.slice(0, 10)}...`);
}

const codeOf = back => new URL(back).searchParams.get("code") || "";

test("connect: the loopback sign-in saves the refresh token, adds the account, and closes the listener", async t => {
  const fake = await startFakeGoogle(t);
  const r = rig(t, fake);
  assert.equal(r.c.port(), null, "nothing listens at idle");

  const started = await r.keep(r.c.start({ name: "home", client: "google-client", base: fake.base }));
  assert.deepEqual(Object.keys(started).sort(), ["id", "redirect", "url"]);
  const port = r.c.port();
  assert.ok(port && port !== 7300);
  assert.equal(started.redirect, `http://127.0.0.1:${port}/google/callback`);
  const q = new URL(started.url).searchParams;
  assert.equal(q.get("client_id"), r.client.client_id);
  assert.equal(q.get("redirect_uri"), started.redirect);
  assert.equal(q.get("scope"), CONSENT_SCOPES.join(" "));
  assert.match(q.get("scope") || "", /^openid email https:\/\/www\.googleapis\.com\/auth\/calendar\.readonly /);
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("prompt"), "consent");
  assert.notEqual(q.get("state"), started.id);

  // Anything but the callback is a 404.
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/google/callback`, { method: "POST" })).status, 404);

  // The browser comes back: the page says so, and the account is there.
  const back = fake.consent(started.url);
  const res = await fetch(back);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /You can close this tab and go back to Vyre\./);
  assert.equal(r.accounts.length, 1);
  assert.deepEqual(r.accounts[0], { name: "home", email: ME, auth: { type: "oauth", item: "google-home" }, base: fake.base });
  assert.equal(r.saved.length, 1);
  assert.equal(r.saved[0].item, "google-home");
  assert.deepEqual(Object.keys(r.saved[0].fields).sort(), ["client_id", "client_secret", "refresh_token", "token_uri"]);
  assert.ok(fake.issued.has(r.saved[0].fields.refresh_token), "the saved refresh token is the one Google issued");
  assert.equal(r.saved[0].fields.token_uri, fake.tokenUri);
  assert.deepEqual(r.events.map(e => e.type), ["google.connected"]);
  assert.deepEqual(r.events[0].payload, { id: started.id, name: "home", email: ME });

  // PKCE and the redirect were checked by the fake's token endpoint.
  const exchange = fake.calls.find(x => x.path === "/token" && x.body.grant_type === "authorization_code");
  assert.equal(exchange?.body.redirect_uri, started.redirect);
  assert.ok(exchange?.body.code_verifier);

  assert.equal(r.c.port(), null);
  assert.equal(await listening(port), false, "the listener is closed after finish");

  // The name is now taken.
  await assert.rejects(r.keep(r.c.start({ name: "home", client: "google-client" })), /already connected/);
  assert.equal(r.c.port(), null);
  assertNoLeak(r, fake, [codeOf(back), exchange?.body.code_verifier]);
});

test("connect: the pasted address finishes a sign-in; a wrong one leaves it open", async t => {
  const fake = await startFakeGoogle(t);
  const r = rig(t, fake);
  const a = await r.keep(r.c.start({ name: "work", client: "google-client" }));
  const b = await r.keep(r.c.start({ name: "home", client: "google-client" }));
  assert.equal(new URL(a.redirect).port, new URL(b.redirect).port, "one listener for every open sign-in");
  const backA = fake.consent(a.url, { email: "juno@northwindbakery.com" });
  const backB = fake.consent(b.url);

  // B's address pasted into A: refused, and neither ends.
  await assert.rejects(r.keep(r.c.finish({ id: a.id, url: backB })), /not from a sign-in Vyre started/);
  await assert.rejects(r.keep(r.c.finish({ id: a.id, url: "not an address" })), /whole address/);
  assert.ok(r.c.port());

  const done = await r.keep(r.c.finish({ id: a.id, url: backA.replace("127.0.0.1", "localhost") }));
  assert.deepEqual(done, { name: "work", email: "juno@northwindbakery.com", item: "google-work" });
  assert.ok(r.c.port(), "B is still open, so the listener stays");

  // The same address again: already used.
  await assert.rejects(r.keep(r.c.finish({ id: a.id, url: backA })), /already used/);
  const again = await fetch(backA);
  assert.equal(again.status, 400);
  assert.match(await again.text(), /already used/);

  const port = /** @type {number} */ (r.c.port());
  assert.deepEqual(await r.keep(r.c.cancel({ id: b.id })), { cancelled: true });
  assert.equal(r.c.port(), null);
  assert.equal(await listening(port), false, "the listener is closed after cancel");
  await assert.rejects(r.keep(r.c.finish({ id: b.id, url: backB })), /cancelled/);
  assert.deepEqual(r.events.map(e => e.type), ["google.connected", "google.connect-failed"]);
  assertNoLeak(r, fake, [codeOf(backA), codeOf(backB)]);
});

test("connect: a bad state, a declined consent and a missing refresh token each fail plainly", async t => {
  const fake = await startFakeGoogle(t);
  const r = rig(t, fake);

  const s = await r.keep(r.c.start({ name: "home", client: "google-client" }));
  const bad = new URL(fake.consent(s.url));
  bad.searchParams.set("state", "forged-state-forged-state-forged-state-000");
  const page = await fetch(bad);
  assert.equal(page.status, 400);
  assert.match(await page.text(), /not from a sign-in Vyre started/);
  assert.equal(r.accounts.length, 0);
  assert.ok(r.c.port(), "a forged state does not end the real sign-in");

  // Declined on Google's page.
  const denied = await fetch(fake.consent(s.url, { deny: true }));
  assert.equal(denied.status, 400);
  assert.match(await denied.text(), /declined, so nothing was connected/);
  assert.equal(r.c.port(), null);

  // A client allowed before gets no refresh token.
  const s2 = await r.keep(r.c.start({ name: "home", client: "google-client" }));
  const back2 = fake.consent(s2.url, { refresh: false });
  await assert.rejects(r.keep(r.c.finish({ id: s2.id, url: back2 })), /myaccount\.google\.com\/permissions/);
  assert.equal(r.saved.length, 0);
  assert.equal(r.accounts.length, 0);
  const failed = r.events.filter(e => e.type === "google.connect-failed");
  assert.equal(failed.length, 2);
  assert.match(String(failed[1].payload.error), /remove Vyre's access/i);

  // A client item with no secret, or not granted, says so before anything listens.
  r.items.set("half", { client_id: "x.apps.googleusercontent.com" });
  await assert.rejects(r.keep(r.c.start({ name: "home", client: "half" })), /client_secret/);
  await assert.rejects(r.keep(r.c.start({ name: "home", client: "nothing" })), /vyre vault grant nothing google/);
  r.items.set("plain", { client_id: "x.apps.googleusercontent.com", client_secret: "GOCSPX-fixture-secret", token_uri: "http://oauth.example.com/token" });
  await assert.rejects(r.keep(r.c.start({ name: "home", client: "plain" })), /token_uri that is not an https address/);
  r.items.set("plain2", { client_id: "x.apps.googleusercontent.com", client_secret: "GOCSPX-fixture-secret", auth_uri: "http://accounts.example.com/auth" });
  await assert.rejects(r.keep(r.c.start({ name: "home", client: "plain2" })), /auth_uri that is not an https address/);
  await assert.rejects(r.keep(r.c.start({ name: "Bad Name", client: "google-client" })), /lowercase/);
  assert.equal(r.c.port(), null);
  assertNoLeak(r, fake, [codeOf(back2), "GOCSPX-fixture-secret"]);
});

test("connect: a sign-in expires after its time, once, and the listener closes", async t => {
  const fake = await startFakeGoogle(t);
  const r = rig(t, fake, { expiresMs: 40 });
  const s = await r.keep(r.c.start({ name: "home", client: "google-client" }));
  const port = /** @type {number} */ (r.c.port());
  const back = fake.consent(s.url);
  await new Promise(res => setTimeout(res, 120));
  assert.equal(r.c.port(), null);
  assert.equal(await listening(port), false);
  assert.deepEqual(r.events.map(e => e.type), ["google.connect-failed"]);
  assert.match(String(r.events[0].payload.error), /expired after 10 minutes/);
  await assert.rejects(r.keep(r.c.finish({ id: s.id, url: back })), /expired/);
  assert.equal(r.accounts.length, 0);
  assertNoLeak(r, fake, [codeOf(back)]);
});

test("connect: a refused code is scrubbed of the secret, the code and the verifier", async t => {
  const fake = await startFakeGoogle(t);
  // A token endpoint that echoes what it was sent, as a careless one might.
  const echo = async (url, init) => new Response(JSON.stringify({ error: "invalid_grant", error_description: String(init.body) }), { status: 400 });
  const r = rig(t, fake, { fetch: echo });
  const s = await r.keep(r.c.start({ name: "home", client: "google-client" }));
  const back = fake.consent(s.url);
  const err = await r.c.finish({ id: s.id, url: back }).catch(e => e);
  r.out.push(err.message);
  assert.match(err.message, /Google refused the sign-in code: invalid_grant/);
  assert.ok(err.message.includes("<concealed by vyre>"));
  assert.ok(!err.message.includes(r.client.client_secret));
  assert.ok(!err.message.includes(codeOf(back)));
  assert.ok(!/code_verifier=[A-Za-z0-9_-]{20}/.test(err.message), "the verifier leaked");
  assertNoLeak(r, fake, [codeOf(back)]);
});

test("connect: stop drops open sign-ins and closes the listener", async t => {
  const fake = await startFakeGoogle(t);
  const r = rig(t, fake);
  const s = await r.keep(r.c.start({ name: "home", client: "google-client" }));
  const port = /** @type {number} */ (r.c.port());
  r.c.stop();
  assert.equal(r.c.port(), null);
  assert.equal(await listening(port), false);
  await assert.rejects(r.keep(r.c.finish({ id: s.id, url: fake.consent(s.url) })), /no sign-in/);
  assert.equal(r.accounts.length, 0);
});
