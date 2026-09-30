// @ts-check
// Tests for the shared credential library, against the fake Google in ./testing. Nothing here
// reaches a real vault or real Google: vault items are a Map, and every endpoint is on 127.0.0.1.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { Credentials, CredentialError, scrub, scrubAll } from "./auth.js";
import { startFakeGoogle } from "./testing/fake-google.js";
import { startFakeAuthServer } from "./testing/fake-oauth.js";

const S = "https://www.googleapis.com/auth/";
const CAL_RO = S + "calendar.readonly";
const CAL_EV = S + "calendar.events";
const MAIL_SEND = S + "gmail.send";

/** A pretend vault: items are strings, or objects of fields (an env-set). */
function vault(items) {
  const fetched = [];
  const fetchItem = async (item, field) => {
    fetched.push([item, field]);
    const v = items[item];
    if (v === undefined) throw new Error(`no item ${item}`);
    if (typeof v === "string") return field ? "" : v;
    return field ? v[field] : JSON.stringify(v);
  };
  return { fetchItem, fetched };
}

/** Collect everything a Credentials instance logged, so a test can check no value is in it. */
function logger() {
  const lines = [];
  return { lines, log: (m, f) => lines.push(`${m} ${JSON.stringify(f || {})}`) };
}

// Fixture values are made at run time, so no literal here looks like a credential to a scanner
// (test/hygiene.test.js) or to a person reading the file.
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const ALL = (creds, extra = []) => [...creds.secrets(), ...extra];

test("bearer: default header and format, a custom header and format, and none", async () => {
  const gh = fake("gh");
  const { fetchItem } = vault({ "harlow-api": "hl_live_0123456789abcdef", gh: { token: gh } });
  const creds = new Credentials({ fetchItem });
  assert.deepEqual(await creds.headers({ type: "none" }), {});
  assert.deepEqual(await creds.headers({ type: "bearer", item: "harlow-api" }), { authorization: "Bearer hl_live_0123456789abcdef" });
  assert.deepEqual(await creds.headers({ type: "bearer", item: "gh", field: "token", header: "X-Api-Key", format: "token {value}" }),
    { "x-api-key": `token ${gh}` });
  assert.ok(creds.secrets().includes("hl_live_0123456789abcdef"));
  assert.ok(creds.secrets().includes(gh));
  await assert.rejects(creds.headers({ type: "bearer", item: "harlow-api", format: "no placeholder" }), /needs \{value\}/);
  await assert.rejects(creds.headers(/** @type {any} */ ({ type: "magic" })), /unknown auth type/);
});

test("bearer: a value with a line break is refused without showing it", async () => {
  const { fetchItem } = vault({ bad: "abcd1234\r\nx-evil: yes" });
  const creds = new Credentials({ fetchItem });
  const err = await creds.headers({ type: "bearer", item: "bad" }).catch(e => e);
  assert.ok(err instanceof CredentialError);
  assert.match(err.message, /line break/);
  assert.ok(!err.message.includes("abcd1234"));
});

test("a vault failure is readable and scrubbed", async () => {
  const creds = new Credentials({ fetchItem: async () => { throw new Error("locked"); } });
  await assert.rejects(creds.headers({ type: "bearer", item: "juno-key" }), /vault item juno-key could not be fetched: locked/);
});

test("env: builds a stdio server's env from items and fields", async () => {
  const gh = fake("gh");
  const { fetchItem } = vault({ "gh-token": gh, kit: { api_key: "kit_secret_value_1" } });
  const creds = new Credentials({ fetchItem });
  assert.deepEqual(await creds.env({ GITHUB_TOKEN: "gh-token", KIT_KEY: { item: "kit", field: "api_key" } }),
    { GITHUB_TOKEN: gh, KIT_KEY: "kit_secret_value_1" });
  assert.ok(creds.secrets().includes("kit_secret_value_1"));
  await assert.rejects(creds.env({ "BAD NAME": "gh-token" }), /not an env var name/);
});

test("oauth: refresh mints a token, caches it, invalidate drops it, and it refreshes after expiry", async t => {
  const g = await startFakeGoogle(t);
  const oauth = g.oauthItem();
  const { fetchItem, fetched } = vault({ "alex-google": oauth });
  let clock = Date.now();
  const { lines, log } = logger();
  const creds = new Credentials({ fetchItem, now: () => clock, log });
  const auth = { type: /** @type {const} */ ("oauth"), item: "alex-google" };

  const h1 = await creds.headers(auth, { scopes: [CAL_RO] });
  assert.match(h1.authorization, /^Bearer ya29\.fake-/);
  const tokenCalls = () => g.calls.filter(c => c.path === "/token").length;
  assert.equal(tokenCalls(), 1);
  assert.equal(g.calls[0].body.grant_type, "refresh_token");
  assert.equal(g.calls[0].body.refresh_token, oauth.refresh_token);

  // Cached: the same scopes do not mint again, and two concurrent misses share one mint.
  assert.deepEqual(await creds.headers(auth, { scopes: [CAL_RO] }), h1);
  assert.equal(tokenCalls(), 1);
  const [a, b] = await Promise.all([creds.headers(auth, { scopes: [CAL_EV] }), creds.headers(auth, { scopes: [CAL_EV] })]);
  assert.deepEqual(a, b);
  assert.equal(tokenCalls(), 2);

  // The token works against the API.
  const res = await fetch(`${g.base}/calendar/v3/users/me/calendarList`, { headers: h1 });
  assert.equal(res.status, 200);

  // A 401 path: the fake expires it, the caller invalidates and gets a new one that works.
  g.expireTokens();
  assert.equal((await fetch(`${g.base}/calendar/v3/users/me/calendarList`, { headers: h1 })).status, 401);
  creds.invalidate(auth, [CAL_RO]);
  const h2 = await creds.headers(auth, { scopes: [CAL_RO] });
  assert.notDeepEqual(h2, h1);
  assert.equal(tokenCalls(), 3);
  assert.equal((await fetch(`${g.base}/calendar/v3/users/me/calendarList`, { headers: h2 })).status, 200);

  // A minute before expiry, the cache counts as stale.
  clock += (3600 - 59) * 1000;
  await creds.headers(auth, { scopes: [CAL_RO] });
  assert.equal(tokenCalls(), 4);

  // Refresh token and client secret were fetched per mint; every value is known for scrubbing.
  assert.ok(fetched.some(([item, f]) => item === "alex-google" && f === "refresh_token"));
  for (const v of [oauth.refresh_token, oauth.client_secret, h1.authorization.slice(7), h2.authorization.slice(7)]) {
    assert.ok(creds.secrets().includes(v), "known for scrubbing");
  }
  const logged = lines.join("\n");
  assert.ok(lines.length > 0);
  for (const v of creds.secrets()) assert.ok(!logged.includes(v), "no value in the log");
});

test("oauth: a revoked refresh token gives a readable, scrubbed error", async t => {
  const g = await startFakeGoogle(t);
  const oauth = { ...g.oauthItem(), refresh_token: "1//revoked-refresh-token-value" };
  const creds = new Credentials({ fetchItem: vault({ acct: oauth }).fetchItem });
  const err = await creds.headers({ type: "oauth", item: "acct" }, { scopes: [CAL_RO] }).catch(e => e);
  assert.ok(err instanceof CredentialError);
  assert.match(err.message, /^the token endpoint answered 400: invalid_grant/);
  assert.equal(err.oauthError, "invalid_grant");
  for (const v of [oauth.refresh_token, oauth.client_secret]) assert.ok(!err.message.includes(v) && !String(err.stack).includes(v));
});

test("service account: the fake verifies the JWT, with subject and scopes", async t => {
  const g = await startFakeGoogle(t);
  const sa = g.serviceAccount("alex@example.com");
  const creds = new Credentials({ fetchItem: vault({ "northwind-sa": sa }).fetchItem });
  const auth = { type: /** @type {const} */ ("service-account"), item: "northwind-sa", subject: "alex@example.com" };
  const h = await creds.headers(auth, { scopes: [CAL_RO, S + "gmail.readonly"] });
  const tok = g.tokens.get(h.authorization.slice(7));
  assert.equal(tok?.subject, "alex@example.com");
  assert.deepEqual(tok?.scopes, [CAL_RO, S + "gmail.readonly"]);

  const call = g.calls.find(c => c.path === "/token");
  assert.equal(call?.body.grant_type, "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const claims = JSON.parse(Buffer.from(call?.body.assertion.split(".")[1], "base64url").toString());
  assert.equal(claims.sub, "alex@example.com");
  assert.equal(claims.aud, g.tokenUri);
  assert.equal(claims.exp - claims.iat, 3600);

  // Reads work; a send needs gmail.send, which this token lacks.
  const list = await fetch(`${g.base}/gmail/v1/users/me/messages?q=from:dana`, { headers: h });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).messages[0].id, "mharlow1");
  assert.equal((await fetch(`${g.base}/gmail/v1/users/me/messages/send`, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: "{}" })).status, 403);

  // Cached per subject and scope set, in any order.
  await creds.headers(auth, { scopes: [S + "gmail.readonly", CAL_RO] });
  assert.equal(g.calls.filter(c => c.path === "/token").length, 1);

  // The private key, its lines, and the assertion are all known for scrubbing.
  const key = JSON.parse(sa).private_key;
  assert.ok(creds.secrets().includes(key));
  assert.ok(creds.secrets().includes(call?.body.assertion));
  const line = key.split("\n")[3];
  assert.equal(creds.scrub(`leak ${line} end`), "leak <concealed by vyre> end");
});

test("service account: a JWT signed with another key is refused", async t => {
  const g = await startFakeGoogle(t);
  const real = JSON.parse(g.serviceAccount());
  const other = JSON.parse(g.serviceAccount());
  const forged = JSON.stringify({ ...real, private_key: other.private_key });
  const creds = new Credentials({ fetchItem: vault({ sa: forged }).fetchItem });
  await assert.rejects(creds.headers({ type: "service-account", item: "sa" }, { scopes: [CAL_RO] }), /answered 400: invalid_grant \(Invalid JWT Signature\.\)/);
});

test("service account: DWD refusal names the subject and the scopes, and how to fix it", async t => {
  const g = await startFakeGoogle(t, { allowedScopes: [CAL_RO] });
  const creds = new Credentials({ fetchItem: vault({ sa: g.serviceAccount("alex@example.com") }).fetchItem });
  const auth = { type: /** @type {const} */ ("service-account"), item: "sa", subject: "alex@example.com" };
  assert.ok(await creds.headers(auth, { scopes: [CAL_RO] }));
  const err = await creds.headers(auth, { scopes: [MAIL_SEND] }).catch(e => e);
  assert.ok(err instanceof CredentialError);
  assert.match(err.message, /^the token endpoint answered 401: unauthorized_client/);
  assert.match(err.message, /not allowed to act as alex@example\.com with https:\/\/www\.googleapis\.com\/auth\/gmail\.send/);
  assert.match(err.message, /domain-wide delegation/);
  assert.deepEqual(err.scopes, [MAIL_SEND]);
  for (const v of creds.secrets()) assert.ok(!err.message.includes(v));
});

test("a refused scope Google names is the one reported", async t => {
  const g = await startFakeGoogle(t);
  const creds = new Credentials({ fetchItem: vault({ sa: g.serviceAccount() }).fetchItem });
  const err = await creds.headers({ type: "service-account", item: "sa" }, { scopes: [CAL_RO, "https://www.googleapis.com/auth/nope"] }).catch(e => e);
  assert.match(err.message, /invalid_scope.*Refused scope: https:\/\/www\.googleapis\.com\/auth\/nope\.$/);
  assert.deepEqual(err.scopes, ["https://www.googleapis.com/auth/nope"]);
});

test("service account: an unknown subject and a broken key are readable and never quote the key", async t => {
  const g = await startFakeGoogle(t);
  const sa = g.serviceAccount();
  const creds = new Credentials({ fetchItem: vault({ sa, junk: "{not json but a secret-ish blob}" }).fetchItem });
  await assert.rejects(creds.headers({ type: "service-account", item: "sa", subject: "kit@harlowlegal.com" }, { scopes: [CAL_RO] }),
    /invalid_grant \(Invalid email or User ID\)\. The key was refused, or kit@harlowlegal\.com is not a user/);
  const err = await creds.headers({ type: "service-account", item: "junk" }, { scopes: [CAL_RO] }).catch(e => e);
  assert.match(err.message, /is not a service-account key/);
  assert.ok(!err.message.includes("secret-ish"));
  await assert.rejects(creds.headers({ type: "service-account", item: "sa" }), /at least one scope/);
});

test("token endpoint: an echoed value is scrubbed, redirects are refused, and http off loopback is refused", async t => {
  // A token endpoint that echoes what it was sent, and one that redirects.
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      if (req.url === "/redirect") { res.writeHead(302, { location: "http://127.0.0.2/steal" }); return res.end(); }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_request", error_description: `got ${decodeURIComponent(body)}` }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  const port = /** @type {any} */ (server.address()).port;
  const item = uri => ({ client_id: "juno-client", client_secret: "juno-client-secret-9876", refresh_token: "1//juno-refresh-token-5432", token_uri: uri });
  const { fetchItem } = vault({ echo: item(`http://127.0.0.1:${port}/echo`), redir: item(`http://127.0.0.1:${port}/redirect`), far: item("http://harlowlegal.com/token") });
  const creds = new Credentials({ fetchItem });

  const err = await creds.headers({ type: "oauth", item: "echo" }).catch(e => e);
  assert.match(err.message, /answered 400: invalid_request/);
  assert.ok(err.message.includes("<concealed by vyre>"));
  for (const v of ["juno-client-secret-9876", "1//juno-refresh-token-5432", encodeURIComponent("1//juno-refresh-token-5432")]) assert.ok(!err.message.includes(v));

  await assert.rejects(creds.headers({ type: "oauth", item: "redir" }), /redirect \(302\), which is refused/);
  const farErr = await creds.headers({ type: "oauth", item: "far" }).catch(e => e);
  assert.match(farErr.message, /not https/);
  assert.equal(farErr.code, "config");
});

test("scrub and scrubAll catch raw, base64, base64url, URL-encoded and JSON-escaped forms", () => {
  const v = "s3cr3t/value+with=chars?";
  const pem = String(crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
  const body = pem.split("\n")[1];
  const b64 = Buffer.from(v).toString("base64");
  const text = [v, b64, b64.replace(/=+$/, ""), Buffer.from(v).toString("base64url"), encodeURIComponent(v),
    encodeURIComponent("a b secret words").replace(/%20/g, "+")].join(" | ");
  const out = scrub(text, [v, "a b secret words"]);
  assert.ok(!out.includes(v) && !out.includes(b64) && !out.includes(encodeURIComponent(v)) && !out.includes("secret+words"));
  assert.equal(out.split("<concealed by vyre>").length - 1, 6);
  assert.equal(scrub("abc and abc", ["abc"]), "abc and abc", "short values are left alone");

  const obj = { ok: true, nested: [{ [v]: `key ${v}`, pem }], json: JSON.stringify({ pem }), n: 3, e: null };
  const clean = scrubAll(obj, [v, pem]);
  const flat = JSON.stringify(clean);
  assert.ok(!flat.includes(v) && !flat.includes(body));
  assert.equal(clean.n, 3);
  assert.equal(clean.ok, true);
  assert.equal(clean.e, null);
});

test("no value appears in any thrown error across auth types", async t => {
  const g = await startFakeGoogle(t, { allowedScopes: [CAL_RO] });
  const oauth = { ...g.oauthItem(), refresh_token: "1//a-refresh-token-that-is-dead" };
  const creds = new Credentials({ fetchItem: vault({ o: oauth, sa: g.serviceAccount("alex@example.com"), b: "bearer-value-1234\n" }).fetchItem });
  const errors = await Promise.all([
    creds.headers({ type: "oauth", item: "o" }).catch(e => e),
    creds.headers({ type: "service-account", item: "sa", subject: "alex@example.com" }, { scopes: [MAIL_SEND] }).catch(e => e),
    creds.headers({ type: "bearer", item: "b" }).catch(e => e),
    creds.headers({ type: "bearer", item: "missing" }).catch(e => e),
  ]);
  for (const e of errors) {
    assert.ok(e instanceof CredentialError, String(e));
    const shown = `${e.message}\n${e.stack}\n${JSON.stringify(e)}`;
    for (const v of ALL(creds)) assert.ok(!shown.includes(v), `error leaked a value: ${e.message}`);
  }
});

test("the fake records calls and serves calendar and mail in the sample world", async t => {
  const g = await startFakeGoogle(t);
  const creds = new Credentials({ fetchItem: vault({ sa: g.serviceAccount("alex@example.com") }).fetchItem });
  const auth = { type: /** @type {const} */ ("service-account"), item: "sa", subject: "alex@example.com" };
  const ro = await creds.headers(auth, { scopes: [CAL_RO, S + "gmail.readonly"] });
  const rw = await creds.headers(auth, { scopes: [CAL_EV, S + "gmail.compose"] });
  const get = async (p, h = ro) => { const r = await fetch(g.base + p, { headers: h }); return { status: r.status, json: await r.json() }; };

  assert.equal((await get("/calendar/v3/users/me/calendarList", {})).status, 401);
  assert.equal(g.calls.at(-1)?.auth, false);

  const now = new Date().toISOString();
  const soon = await get(`/calendar/v3/calendars/primary/events?timeMin=${now}&singleEvents=true&orderBy=startTime&maxResults=1`);
  assert.equal(soon.json.items[0].summary, "Harlow Legal check-in");
  assert.equal((await get(`/calendar/v3/calendars/primary/events?q=northwind`)).json.items[0].summary, "Northwind Bakery tasting");
  assert.equal((await get(`/calendar/v3/calendars/primary/events?orderBy=startTime`)).status, 400);

  const post = (p, body, h) => fetch(g.base + p, { method: "POST", headers: { ...h, "content-type": "application/json" }, body: JSON.stringify(body) });
  const ev = { summary: "Harlow Legal signing", start: { dateTime: now }, end: { dateTime: now }, attendees: [{ email: "dana@harlowlegal.com" }] };
  assert.equal((await post("/calendar/v3/calendars/primary/events?sendUpdates=all", ev, ro)).status, 403);
  const made = await (await post("/calendar/v3/calendars/primary/events?sendUpdates=all", ev, rw)).json();
  assert.deepEqual(g.calendar.invites, [{ eventId: made.id, to: ["dana@harlowlegal.com"], sendUpdates: "all" }]);
  const patched = await fetch(`${g.base}/calendar/v3/calendars/primary/events/${made.id}`, { method: "PATCH", headers: { ...rw, "content-type": "application/json" }, body: JSON.stringify({ location: "Harlow Legal office" }) });
  assert.equal((await patched.json()).location, "Harlow Legal office");

  const msg = await get("/gmail/v1/users/me/messages/mharlow1?format=full");
  const plain = msg.json.payload.parts.find(p => p.mimeType === "text/plain");
  assert.match(Buffer.from(plain.body.data, "base64url").toString(), /engagement letter is attached/);
  const meta = await get("/gmail/v1/users/me/messages/mharlow1?format=metadata&metadataHeaders=Subject");
  assert.deepEqual(meta.json.payload.headers, [{ name: "Subject", value: "Harlow Legal engagement letter" }]);
  assert.equal((await get("/gmail/v1/users/me/threads/tharlow")).json.messages.length, 2);
  assert.deepEqual((await get("/gmail/v1/users/me/messages?q=" + encodeURIComponent("northwind newer_than:1d"))).json.messages.map(m => m.id), ["mnorthwind1"]);
  assert.deepEqual((await get("/gmail/v1/users/me/messages?q=" + encodeURIComponent('subject:"engagement letter" to:dana'))).json.messages.map(m => m.id), ["mharlow2"]);

  const raw = Buffer.from("To: dana@harlowlegal.com\r\nSubject: Signed\r\n\r\nSigned and attached.").toString("base64url");
  assert.equal((await post("/gmail/v1/users/me/drafts", { message: { raw } }, rw)).status, 200);
  assert.equal(g.mail.drafts[0].message.headers.Subject, "Signed");
  assert.equal((await post("/gmail/v1/users/me/messages/send", { raw }, ro)).status, 403);
  assert.equal(g.mail.sent.length, 0);
  const tx = await creds.headers(auth, { scopes: [MAIL_SEND] });
  assert.equal((await post("/gmail/v1/users/me/messages/send", { raw }, tx)).status, 200);
  assert.equal(g.mail.sent[0].headers.To, "dana@harlowlegal.com");
});

// ---- a vendor's sign-in kept by connectors: a public client, a stored access token, a rotation ----

/** Sign in against the fake authorization server the way the connect flow does, and give back the item it would save. */
async function signedIn(t, opts) {
  const { connector } = await import("./oauth.js");
  const fake = await startFakeAuthServer(t, opts);
  let item = null;
  const c = connector({ complete: async (flow, tokens) => { item = { client_id: tokens.client_id, token_uri: tokens.token_uri, access_token: tokens.access_token,
    refresh_token: tokens.refresh_token, expires_at: String(tokens.obtained_at + tokens.expires_in * 1000) }; return {}; }, emit() {} });
  t.after(() => c.stop());
  const s = await c.start({ name: "vendor", resource: fake.origin, scopes: [] });
  await c.finish({ id: s.id, url: fake.consent(s.url) });
  return { fake, item };
}

test("oauth: a public client with no secret refreshes, and a fresh sign-in uses its stored access token first", async t => {
  const { fake, item } = await signedIn(t, { dcr: true });
  assert.equal(item.client_secret, undefined);
  const store = { vendor: { ...item } };
  const creds = new Credentials({ fetchItem: async (i, f) => { const v = store[i]?.[f]; return v === undefined ? (() => { throw new Error("no field"); })() : v; } });
  const auth = { type: /** @type {const} */ ("oauth"), item: "vendor" };
  const h1 = await creds.headers(auth);
  assert.equal(h1.authorization, `Bearer ${item.access_token}`);
  assert.equal(fake.calls.filter(c => c.path === "/token").length, 1, "only the sign-in touched the token endpoint");
  // a 401 says the stored token is no good, so the next mint refreshes
  creds.invalidate(auth);
  const h2 = await creds.headers(auth);
  assert.notEqual(h2.authorization, h1.authorization);
  assert.equal(fake.calls.filter(c => c.path === "/token").length, 2);
});

test("oauth: a rotated refresh token is saved before it is needed again, and a failed save is an error", async t => {
  const { fake, item } = await signedIn(t, { dcr: true, rotate: true });
  const store = { vendor: { ...item, expires_at: "1" } };
  const saves = [];
  const creds = new Credentials({
    fetchItem: async (i, f) => { const v = store[i]?.[f]; if (v === undefined) throw new Error("no field"); return v; },
    save: async (i, fields) => { saves.push(fields); store[i] = { ...store[i], ...fields }; },
  });
  const auth = { type: /** @type {const} */ ("oauth"), item: "vendor" };
  await creds.headers(auth);
  assert.equal(saves.length, 1);
  assert.notEqual(saves[0].refresh_token, item.refresh_token);
  // the next refresh uses the new token and is accepted; the old one would now be refused
  store.vendor.expires_at = "1";
  creds.invalidate(auth);
  await creds.headers(auth);
  assert.equal(saves.length, 2);
  // a save that fails is loud and carries no value
  const failing = new Credentials({ fetchItem: async (i, f) => { const v = store[i]?.[f]; if (v === undefined) throw new Error("no field"); return v; },
    save: async () => { throw new Error("the vault is locked"); } });
  store.vendor.expires_at = "1";
  const err = await failing.headers(auth).catch(e => e);
  assert.match(err.message, /could not be saved: the vault is locked/);
  for (const v of failing.secrets()) assert.ok(!err.message.includes(v));
  // the rotated token is kept in memory, so the next call works and the save is tried again
  store.vendor.expires_at = "1";
  const retry = await failing.headers(auth).catch(e => e);
  assert.match(String(retry.message || ""), /could not be saved/, "it used the kept token (a stale one would be refused as invalid_grant)");
  // and with no way to save at all, a rotating vendor is refused up front rather than silently broken
  const again = await signedIn(t, { dcr: true, rotate: true });
  const bare = { vendor: { ...again.item, expires_at: "1" } };
  const none = new Credentials({ fetchItem: async (i, f) => { const v = bare[i]?.[f]; if (v === undefined) throw new Error("no field"); return v; } });
  assert.match((await none.headers(auth).catch(e => e)).message, /nothing can save it/);
  void fake;
});
