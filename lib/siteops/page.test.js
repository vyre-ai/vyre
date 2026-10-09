// @ts-check
// page: the page-side pieces every rung with a browser shares: where a credential reference comes from, the page's own fetch, and a sign-in wall.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolverFor, fetchExpression, loginWall, STATE_EXPRESSION, LOGIN_PATH } from "./page.js";

const op = { match: { method: "GET", host: "app.example.com", path: "/api/v2/search" } };
const state = { cookie: { sid: "cookie-value-1234" }, local: { csrf: "local-csrf-value-1", auth: JSON.stringify({ user: { token: "nested-token-value" } }) }, session: { tab: "session-value-12" } };

test("a reference resolves from the page's cookie, then its storage (a key, or a path inside a JSON entry), then the newest request that carried it", () => {
  const r = resolverFor(state, [{ method: "GET", url: "https://app.example.com/api/v2/search?q=a", headers: { "X-Csrf-Token": "from-request-header", Cookie: "sid=old; other=header-cookie-1" } }], op);
  assert.equal(r("cookie:sid"), "cookie-value-1234", "the page's own cookie first");
  assert.equal(r("cookie:other"), "header-cookie-1", "or the cookie a recent request carried");
  assert.equal(r("session:csrf"), "local-csrf-value-1", "storage by key");
  assert.equal(r("session:auth/user/token"), "nested-token-value", "a path inside a JSON entry");
  assert.equal(r("session:tab"), "session-value-12");
  assert.equal(r("session:x-csrf-token"), "from-request-header", "the newest request's header of that name");
  assert.equal(r("session:nothing-here"), undefined, "nothing is invented");
  assert.equal(r("cookie:missing"), undefined);
});

test("a field of a recent request of the same operation resolves too, before any other request's", () => {
  const recent = [
    { method: "POST", url: "https://app.example.com/other", headers: {}, body: JSON.stringify({ fb_dtsg: "other-request-token-1" }) },
    { method: "GET", url: "https://app.example.com/api/v2/search?fb_dtsg=same-op-token-value", headers: {} },
  ];
  const r = resolverFor({ cookie: {}, local: {}, session: {} }, recent, op);
  assert.equal(r("session:fb_dtsg"), "same-op-token-value");
});

test("the page's fetch carries the page's cookies, drops what a browser sets itself, and refuses to run on another site", () => {
  const e = fetchExpression({ url: "https://app.example.com/api", method: "POST", headers: { "x-csrf-token": "t", cookie: "stolen", Origin: "x", "sec-fetch-mode": "cors", "content-type": "application/json" }, body: "{}" }, "https://app.example.com");
  const P = JSON.parse(e.match(/\}\)\((\{.*\})\)$/s)?.[1] || "{}");
  assert.equal(P.init.credentials, "include");
  assert.deepEqual(Object.keys(P.init.headers).sort(), ["content-type", "x-csrf-token"]);
  assert.equal(P.origin, "https://app.example.com");
  assert.match(e, /location\.origin !== P\.origin/);
  assert.ok(!/body/.test(JSON.stringify(JSON.parse(fetchExpression({ url: "https://a.test/x", method: "GET", headers: {}, body: "ignored" }, "https://a.test").match(/\}\)\((\{.*\})\)$/s)?.[1] || "{}").init)), "a GET sends no body");
  assert.match(STATE_EXPRESSION, /document\.cookie/);
});

test("a sign-in or checkpoint page the trigger did not mean to reach is a wall", () => {
  assert.equal(loginWall("https://www.site.test/login?next=/in/x", "https://www.site.test/in/x"), "/login");
  assert.equal(loginWall("https://www.site.test/checkpoint/challenge/abc", "https://www.site.test/in/x"), "/checkpoint/challenge/abc");
  assert.equal(loginWall("https://www.site.test/login", "https://www.site.test/login"), undefined, "the trigger was the login page itself");
  assert.equal(loginWall("https://www.site.test/in/x", "https://www.site.test/in/x"), undefined);
  assert.ok(LOGIN_PATH.test("/uas/login"));
});
