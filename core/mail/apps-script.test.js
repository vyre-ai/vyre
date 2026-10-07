// @ts-check
// Tests for the Apps Script mail adapter and for apps-script.gs itself. Only fakes on 127.0.0.1
// and stub fetches; nothing here reaches Google or sends a real email.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { appsScriptAdapter, MAX_RESPONSE } from "./apps-script.js";
import { startFakeAppsScript, loadScript, sampleMessages } from "./testing/fake-apps-script.js";

const TOKEN = "tok-3b7f0c9e1d2a4f6b8c0e2d4f6a8b0c1e";
const ALEX = "alex@harlow.example";
const DANA = "dana@northwind-bakery.example";
const cfg = { address: ALEX, auth: { item: "mail-alex-apps-script" } };

/** A field function over fixed values. @param {string} url @param {string} [token] */
const fields = (url, token = TOKEN) => async name => (name === "url" ? url : token);

/** Every place a credential could leak, as one string. @param {any} fake */
const traces = fake => JSON.stringify({ urls: fake.postUrls, echo: fake.echoGets });

async function rejects(p, code) {
  try { await p; } catch (e) { assert.equal(/** @type {any} */ (e).code, code, String(/** @type {any} */ (e).message)); return /** @type {any} */ (e); }
  assert.fail(`expected an error with code ${code}`);
}

test("check and items", () => {
  const a = appsScriptAdapter();
  assert.equal(a.check(cfg), null);
  assert.match(String(a.check({ address: "alex", auth: { item: "x" } })), /address/);
  assert.match(String(a.check({ address: ALEX, auth: {} })), /auth\.item/);
  assert.match(String(a.check(null)), /config/);
  assert.deepEqual(a.items(cfg), ["mail-alex-apps-script"]);
});

test("url rules: only script.google.com exec URLs or loopback, checked before any request", async () => {
  let calls = 0;
  /** @type {any} */
  const f = async () => { calls++; throw new Error("must not be called"); };
  const a = appsScriptAdapter({ fetch: f });
  for (const url of [
    "http://script.google.com/macros/s/AKfycbFakeDeployment0123/exec",
    "https://script.google.com/macros/s/AKfycbFakeDeployment0123/dev",
    "https://script.google.com/macros/s/AKfycbFakeDeployment0123/exec?token=x",
    "https://script.google.com:8443/macros/s/AKfycbFakeDeployment0123/exec",
    "https://user:pw@script.google.com/macros/s/AKfycbFakeDeployment0123/exec",
    "https://script.google.com.evil.example/macros/s/AKfycbFakeDeployment0123/exec",
    "https://evil.example/macros/s/AKfycbFakeDeployment0123/exec",
    "ftp://127.0.0.1/exec",
    "not a url",
  ]) {
    const r = await a.test(cfg, fields(url));
    assert.equal(r.ok, false, url);
    assert.equal(r.code, "bad_config", url);
    assert.ok(!String(r.error).includes("AKfycbFakeDeployment0123"), "the deployment id is not echoed");
  }
  const short = await a.test(cfg, fields("https://script.google.com/macros/s/AKfycbFakeDeployment0123/exec", "short"));
  assert.equal(short.code, "bad_config");
  assert.equal(calls, 0);
});

test("the real Google path: POST to script.google.com, one GET to script.googleusercontent.com", async () => {
  const url = "https://script.google.com/a/macros/harlow.example/s/AKfycbRealShape0123456789/exec";
  /** @type {{ url: string, init: any }[]} */ const seen = [];
  /** @type {any} */
  const f = async (u, init) => {
    seen.push({ url: String(u), init });
    if (seen.length === 1) return new Response(null, { status: 302, headers: { location: "https://script.googleusercontent.com/macros/echo?user_content_key=abc&lib=M1" } });
    return new Response(JSON.stringify({ ok: true, data: { address: "Alex@Harlow.example" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const r = await appsScriptAdapter({ fetch: f }).test(cfg, fields(url));
  assert.equal(r.ok, true);
  assert.deepEqual(r.can, { search: true, read: true, send: true });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.redirect, "manual");
  assert.equal(JSON.parse(seen[0].init.body).token, TOKEN);
  assert.equal(seen[0].url, url);
  assert.equal(seen[1].init.method, "GET");
  assert.equal(seen[1].init.body, undefined);
  assert.ok(!seen[1].url.includes(TOKEN) && !JSON.stringify(seen[1].init.headers).includes(TOKEN));
});

test("the real Google path: a redirect to Google sign-in is not_web_app, and not followed", async () => {
  let calls = 0;
  /** @type {any} */
  const f = async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://accounts.google.com/ServiceLogin?continue=x" } }); };
  const r = await appsScriptAdapter({ fetch: f }).test(cfg, fields("https://script.google.com/macros/s/AKfycbRealShape0123456789/exec"));
  assert.equal(r.code, "not_web_app");
  assert.match(String(r.error), /Anyone/);
  assert.equal(calls, 1);
});

test("the real Google path: a redirect to any other host is refused", async () => {
  let calls = 0;
  /** @type {any} */
  const f = async () => { calls++; return new Response(null, { status: 302, headers: { location: "https://script.googleusercontent.com.evil.example/echo" } }); };
  const r = await appsScriptAdapter({ fetch: f }).test(cfg, fields("https://script.google.com/macros/s/AKfycbRealShape0123456789/exec"));
  assert.equal(r.code, "redirect");
  assert.equal(calls, 1);
});

test("test(): ok through the fake, and the token is never in a URL or the echo GET", async t => {
  const fake = await startFakeAppsScript(t, { token: TOKEN, address: ALEX });
  const r = await appsScriptAdapter().test(cfg, fields(fake.url));
  assert.deepEqual(r, { ok: true, can: { search: true, read: true, send: true }, address: ALEX });
  assert.equal(fake.echoGets.length, 1);
  assert.equal(fake.echoGets[0].method, "GET");
  assert.equal(fake.echoGets[0].body, "");
  assert.ok(!traces(fake).includes(TOKEN));
  assert.deepEqual(fake.posts, [{ op: "test" }]);
});

test("test(): an address mismatch is not ok, with a clear error", async t => {
  const fake = await startFakeAppsScript(t, { token: TOKEN, address: DANA });
  const r = await appsScriptAdapter().test(cfg, fields(fake.url));
  assert.equal(r.ok, false);
  assert.equal(r.address, DANA);
  assert.deepEqual(r.can, { search: false, read: false, send: false });
  assert.match(String(r.error), new RegExp(`runs as ${DANA}, not ${ALEX}`));
});

test("a wrong token is code auth, and neither token appears in the error", async t => {
  const fake = await startFakeAppsScript(t, { token: TOKEN, address: ALEX });
  const wrong = "wrong-token-0000000000000000000000";
  const a = appsScriptAdapter();
  const r = await a.test(cfg, fields(fake.url, wrong));
  assert.equal(r.code, "auth");
  assert.ok(!String(r.error).includes(wrong) && !String(r.error).includes(TOKEN));
  const e = await rejects(a.search(cfg, fields(fake.url, wrong), { q: "" }), "auth");
  assert.ok(!JSON.stringify({ m: e.message, ...e }).includes(wrong));
  assert.ok(!String(e.message).includes(fake.url));
});

test("search through the redirect: newest first, the latest message per thread", async t => {
  const fake = await startFakeAppsScript(t, { token: TOKEN, address: ALEX });
  const a = appsScriptAdapter();
  const rows = await a.search(cfg, fields(fake.url), { q: "from:dana", limit: 5 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "18f0a3");
  assert.equal(rows[0].thread_id, "t-order");
  assert.equal(rows[0].subject, "Re: Order for Friday");
  assert.equal(rows[0]._at, Date.parse("2026-09-22T08:15:00.000Z"));
  assert.equal(rows[0].snippet, "Also, rye instead of spelt please.");
  const all = await a.search(cfg, fields(fake.url), { q: "", limit: 99 });
  assert.deepEqual(all.map(r => r.id), ["18f0a3", "18f0a2"]);
  assert.equal(fake.posts[1].limit, 25, "the limit is capped at 25");
  assert.equal(fake.posts[0].q, "from:dana", "q is passed as is");
  assert.ok(!traces(fake).includes(TOKEN));
});

test("read through the redirect", async t => {
  const fake = await startFakeAppsScript(t, { token: TOKEN, address: ALEX });
  const m = await appsScriptAdapter().read(cfg, fields(fake.url), { id: "18f0a1" });
  assert.deepEqual(m, {
    id: "18f0a1", thread_id: "t-order", from: `Dana Reyes <${DANA}>`, to: ALEX, cc: "", subject: "Order for Friday",
    date: "2026-09-20T09:00:00.000Z", message_id: "<order-1@northwind-bakery.example>",
    body: "Hi Alex, can we move the Friday order to 40 loaves? Dana", attachments: ["order.pdf"],
  });
  await rejects(appsScriptAdapter().read(cfg, fields(fake.url), { id: "nope" }), "not_found");
  await rejects(appsScriptAdapter().read(cfg, fields(fake.url), { id: "../x" }), "bad_input");
});

test("send, and a reply on the thread", async t => {
  const fake = await startFakeAppsScript(t, { token: TOKEN, address: ALEX });
  const a = appsScriptAdapter();
  assert.deepEqual(await a.send(cfg, fields(fake.url), { to: DANA, cc: ["ops@northwind-bakery.example"], subject: "Invoice", body: "Attached soon." }), { sent: true });
  assert.deepEqual(fake.sent[0], { kind: "send", to: DANA, cc: "ops@northwind-bakery.example", bcc: "", subject: "Invoice", body: "Attached soon." });
  await a.send(cfg, fields(fake.url), { to: [DANA], bcc: "files@harlow.example", subject: "Re: Order for Friday", body: "40 rye, done.", in_reply_to: "<order-2@northwind-bakery.example>" });
  assert.equal(fake.sent[1].kind, "reply");
  assert.equal(fake.sent[1].thread_id, "t-order");
  assert.equal(fake.sent[1].in_reply_to, "<order-2@northwind-bakery.example>");
  assert.equal(fake.sent[1].bcc, "files@harlow.example");
  assert.ok(!traces(fake).includes(TOKEN));
});

test("a reply whose sender is not in to is refused by the script", async t => {
  const fake = await startFakeAppsScript(t, { token: TOKEN, address: ALEX });
  await rejects(appsScriptAdapter().send(cfg, fields(fake.url), { to: "someone@harlow.example", subject: "Re", body: "x", in_reply_to: "<order-1@northwind-bakery.example>" }), "reply_mismatch");
  assert.equal(fake.sent.length, 0);
});

test("send refuses bad content before any request", async t => {
  const fake = await startFakeAppsScript(t, { token: TOKEN, address: ALEX });
  const a = appsScriptAdapter();
  await rejects(a.send(cfg, fields(fake.url), { to: "dana at bakery", subject: "Hi", body: "x" }), "bad_input");
  await rejects(a.send(cfg, fields(fake.url), { to: DANA, cc: "not-an-address", subject: "Hi", body: "x" }), "bad_input");
  await rejects(a.send(cfg, fields(fake.url), { to: DANA, subject: "Hi\r\nBcc: x@evil.example", body: "x" }), "bad_input");
  await rejects(a.send(cfg, fields(fake.url), { to: DANA, subject: "Hi", body: "x", in_reply_to: "no brackets" }), "bad_input");
  assert.equal(fake.posts.length, 0);
});

test("a redirect to a foreign origin is refused and never reached", async t => {
  let hits = 0;
  const other = http.createServer((req, res) => { hits++; res.end("{}"); });
  await new Promise(r => other.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => { other.closeAllConnections?.(); other.close(() => r(undefined)); }));
  const port = /** @type {import("node:net").AddressInfo} */ (other.address()).port;
  const fake = await startFakeAppsScript(t, { token: TOKEN, address: ALEX, redirectTo: `http://127.0.0.1:${port}` });
  await rejects(appsScriptAdapter().search(cfg, fields(fake.url), { q: "" }), "redirect");
  assert.equal(hits, 0);
  assert.equal(fake.echoGets.length, 0);
});

test("an HTML answer is not_web_app with a deploy hint", async t => {
  const fake = await startFakeAppsScript(t, { token: TOKEN, address: ALEX, html: true });
  const r = await appsScriptAdapter().test(cfg, fields(fake.url));
  assert.equal(r.code, "not_web_app");
  assert.match(String(r.error), /Who has access: Anyone/);
});

test("without the redirect the POST answer is read directly", async t => {
  const fake = await startFakeAppsScript(t, { token: TOKEN, address: ALEX, redirect: false });
  assert.equal((await appsScriptAdapter().test(cfg, fields(fake.url))).ok, true);
  assert.equal(fake.echoGets.length, 0);
});

test("timeout", async t => {
  const fake = await startFakeAppsScript(t, { token: TOKEN, address: ALEX, slow: 1000 });
  const e = await rejects(appsScriptAdapter({ timeout: 150 }).search(cfg, fields(fake.url), { q: "" }), "timeout");
  assert.match(e.message, /150 ms/);
});

test("an answer over the size cap is refused", async t => {
  const fake = await startFakeAppsScript(t, { token: TOKEN, address: ALEX, huge: true });
  const e = await rejects(appsScriptAdapter().search(cfg, fields(fake.url), { q: "" }), "too_large");
  assert.match(e.message, new RegExp(String(MAX_RESPONSE)));
});

test("results and errors are scrubbed of the url and the token", async () => {
  const url = "https://script.google.com/macros/s/AKfycbRealShape0123456789/exec";
  /** @type {any} */
  const f = async () => new Response(JSON.stringify({ ok: false, code: "gmail", error: `echo ${TOKEN} at ${url}` }), { status: 200 });
  const e = await rejects(appsScriptAdapter({ fetch: f }).read(cfg, fields(url), { id: "18f0a1" }), "gmail");
  assert.ok(!e.message.includes(TOKEN) && !e.message.includes("AKfycbRealShape0123456789"), e.message);
  /** @type {any} */
  const g = async () => new Response(JSON.stringify({ ok: true, data: { id: "1", subject: TOKEN, body: "AKfycbRealShape0123456789" } }), { status: 200 });
  const m = await appsScriptAdapter({ fetch: g }).read(cfg, fields(url), { id: "1" });
  assert.ok(!JSON.stringify(m).includes(TOKEN) && !JSON.stringify(m).includes("AKfycbRealShape0123456789"));
  /** @type {any} */
  const h = async () => new Response(JSON.stringify({ ok: false, code: "Not A Code!", error: "x" }), { status: 200 });
  await rejects(appsScriptAdapter({ fetch: h }).read(cfg, fields(url), { id: "1" }), "script");
});

test("a second redirect is refused", async () => {
  let calls = 0;
  /** @type {any} */
  const f = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "https://script.googleusercontent.com/macros/echo?again=" + calls } });
  };
  const r = await appsScriptAdapter({ fetch: f }).test(cfg, fields("https://script.google.com/macros/s/AKfycbRealShape0123456789/exec"));
  assert.equal(r.code, "redirect");
  assert.equal(calls, 2);
});

// The script itself, in node:vm with stub Gmail.

test("apps-script.gs: every op, the token check and the setup check", () => {
  const s = loadScript({ token: TOKEN, address: ALEX, messages: sampleMessages() });
  const ok = body => { const { json, mime } = s.doPost({ token: TOKEN, ...body }); assert.equal(mime, "application/json"); return json; };

  assert.deepEqual(ok({ op: "test" }), { ok: true, data: { address: ALEX } });

  const found = ok({ op: "search", q: "loaves", limit: 100 });
  assert.equal(found.ok, true);
  assert.deepEqual(found.data.map(m => m.id), ["18f0a3"]);
  assert.equal(found.data[0].date, "2026-09-22T08:15:00.000Z");

  const read = ok({ op: "read", id: "18f0a1" });
  assert.equal(read.data.message_id, "<order-1@northwind-bakery.example>");
  assert.deepEqual(read.data.attachments, ["order.pdf"]);
  assert.deepEqual(ok({ op: "read", id: "missing" }), { ok: false, error: "no message with that id", code: "not_found" });

  assert.deepEqual(ok({ op: "send", to: DANA, cc: "", bcc: "", subject: "Hi", body: "Hello" }), { ok: true, data: { sent: true } });
  assert.deepEqual(s.sent.at(-1), { kind: "send", to: DANA, cc: "", bcc: "", subject: "Hi", body: "Hello" });

  assert.deepEqual(ok({ op: "send", to: `${DANA}, extra@harlow.example`, subject: "Re", body: "Yes", in_reply_to: "<order-1@northwind-bakery.example>" }), { ok: true, data: { sent: true } });
  const reply = s.sent.at(-1);
  assert.equal(reply?.kind, "reply");
  assert.equal(reply?.in_reply_to, "<order-1@northwind-bakery.example>");
  assert.equal(reply?.cc, "extra@harlow.example", "other approved to addresses are copied");
  assert.equal(ok({ op: "send", to: "x@harlow.example", subject: "Re", body: "Yes", in_reply_to: "<order-1@northwind-bakery.example>" }).code, "reply_mismatch");
  assert.equal(ok({ op: "send", to: DANA, subject: "Re", body: "Yes", in_reply_to: "<nothing@here.example>" }).code, "not_found");
  assert.equal(ok({ op: "send", to: "bad", subject: "Hi", body: "x" }).code, "bad_input");
  assert.equal(ok({ op: "send", to: DANA, subject: "a\nb", body: "x" }).code, "bad_input");
  assert.equal(ok({ op: "delete" }).code, "bad_input");

  const sentBefore = s.sent.length;
  for (const token of ["wrong", TOKEN.slice(0, -1), TOKEN + "x", "", undefined]) {
    const { json } = s.doPost({ token, op: "send", to: DANA, subject: "Hi", body: "x" });
    assert.deepEqual(json, { ok: false, error: "wrong token", code: "auth" });
  }
  assert.equal(s.sent.length, sentBefore, "nothing sent with a wrong token");
  assert.equal(JSON.parse(s.raw("not json").getContent()).code, "bad_input");

  const unset = loadScript({ token: null, address: ALEX, messages: [] });
  assert.equal(unset.doPost({ token: "", op: "test" }).json.code, "setup");
});

test("apps-script.gs: Gmail errors become code gmail without the request", () => {
  const s = loadScript({ token: TOKEN, address: ALEX, messages: sampleMessages() });
  // A search query the stub cannot handle stands in for a Gmail failure.
  const boom = loadScript({ token: TOKEN, address: ALEX, messages: /** @type {any} */ ([{ get thread_id() { throw new Error("Service invoked too many times"); } }]) });
  const { json } = boom.doPost({ token: TOKEN, op: "search", q: "" });
  assert.equal(json.code, "gmail");
  assert.match(json.error, /too many times/);
  assert.ok(!JSON.stringify(json).includes(TOKEN));
  assert.equal(s.doPost({ token: TOKEN, op: "test" }).json.ok, true);
});
