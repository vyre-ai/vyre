// @ts-check
// apilearn as pure code, against realistic traffic: a made-up Northwind Bakery order API and a
// made-up GoHighLevel-style contacts/workflows API. The rule under test: the catalog holds shapes,
// never a sample value.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { learn, templatePath, looksLikeId, shapeOf, mergeShape, authKind, mergeCatalog, buildCall, MAX_ENTRIES } from "./extension/shared/apilearn.js";

const UUID = "3f2b8c1e-9a47-4d55-b0c1-7e6d5a4c3b2a";
const LOC = "Xq3RtYuIoPaSdFgHjKlZ";
const CONTACT = "aB3dE5fG7hJ9kL1mN2pQ";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGV4In0.c2lnbmF0dXJlMTIzNDU";

const bakery = [
  { method: "GET", url: "https://bakery.example/api/orders?status=open&page=2&session=SESSIONQUERYVALUE9", status: 200, type: "XHR", requestHeaders: { Cookie: "sid=COOKIEVALUE123456; a=b" } },
  { method: "GET", url: "https://bakery.example/api/orders/1001", status: 200, type: "Fetch", requestHeaders: { Cookie: "sid=COOKIEVALUE123456" } },
  { method: "GET", url: "https://bakery.example/api/orders/1002", status: 404, type: "Fetch", requestHeaders: { Cookie: "sid=COOKIEVALUE123456" } },
  { method: "GET", url: `https://bakery.example/api/customers/${UUID}/orders/1001`, status: 200, type: "XHR", requestHeaders: {} },
  { method: "POST", url: "https://bakery.example/api/orders", status: 201, type: "XHR", requestHeaders: { "Content-Type": "application/json", Cookie: "sid=COOKIEVALUE123456" }, postData: JSON.stringify({ item: "sourdough", qty: 2, rush: true, notes: null, customer: { email: "alex@example.com", password: "hunter2hunter2" }, lines: [{ sku: "SD-1", price: 4.5 }] }) },
  { method: "GET", url: "https://bakery.example/static/app.js", status: 200, type: "Script", requestHeaders: {} },
  { method: "GET", url: "https://bakery.example/logo.png", status: 200, type: "Image", requestHeaders: {} },
];

const ghl = [
  { method: "GET", url: `https://services.gohighlevel.example/contacts/${CONTACT}?locationId=${LOC}`, status: 200, type: "XHR", requestHeaders: { Authorization: `Bearer ${JWT}`, Version: "2021-07-28" } },
  { method: "GET", url: `https://services.gohighlevel.example/contacts/other9Zx8Yw7Vu6Ts5Rq?locationId=${LOC}`, status: 200, type: "XHR", requestHeaders: { Authorization: `Bearer ${JWT}` } },
  { method: "GET", url: `https://services.gohighlevel.example/workflows/${UUID}/status?locationId=${LOC}&limit=20`, status: 200, type: "Fetch", requestHeaders: { Authorization: `Bearer ${JWT}` } },
  { method: "PUT", url: `https://services.gohighlevel.example/contacts/${CONTACT}`, status: 200, type: "XHR", requestHeaders: { Authorization: `Bearer ${JWT}`, "content-type": "application/json" }, postData: JSON.stringify({ firstName: "Alex", phone: "+15551230000", tags: ["lead", "probate"], customFields: [{ id: CONTACT, value: "x" }], apiKey: "KEYVALUEabcdef123456" }) },
  { method: "GET", url: "https://backend.gohighlevel.example/conversations/search?locationId=" + LOC, status: 200, type: "XHR", requestHeaders: { "token-id": "TOKENIDVALUE1234567890", Channel: "APP" } },
  { method: "GET", url: "https://backend.gohighlevel.example/ping", status: 200, type: "XHR", requestHeaders: {} },
];

const find = (list, method, tpl) => list.find(e => e.method === method && e.pathTemplate === tpl);
const ser = x => JSON.stringify(x);

test("looksLikeId and templatePath: numeric, uuid, long ids become {id}; words stay", () => {
  for (const s of ["1001", UUID, CONTACT, LOC, "deadbeefdeadbeef00", "550e8400e29b41d4a716446655440000"]) assert.ok(looksLikeId(s), s);
  for (const s of ["orders", "notifications-preferences", "internationalization", "v2", "status", ""]) assert.ok(!looksLikeId(s), s);
  assert.equal(templatePath("/api/orders/1001"), "/api/orders/{id}");
  assert.equal(templatePath(`/api/customers/${UUID}/orders/1001`), "/api/customers/{id}/orders/{id2}");
  assert.equal(templatePath("/"), "/");
});

test("bakery API: templates, query types, statuses, counts, auth kinds", () => {
  const c = learn(bakery);
  assert.equal(c.length, 4, "scripts and images are not API traffic");
  const list = find(c, "GET", "/api/orders");
  assert.deepEqual(list.query, { status: "string", page: "number", session: "secret" });
  assert.equal(list.authKind, "cookie");
  assert.equal(list.host, "bakery.example");
  const one = find(c, "GET", "/api/orders/{id}");
  assert.equal(one.count, 2);
  assert.deepEqual(one.statuses, [200, 404]);
  assert.ok(find(c, "GET", "/api/customers/{id}/orders/{id2}"));
  assert.equal(find(c, "GET", "/api/customers/{id}/orders/{id2}").authKind, "none");
  const post = find(c, "POST", "/api/orders");
  assert.deepEqual(post.statuses, [201]);
  assert.deepEqual(post.bodyShape, { item: "string", qty: "number", rush: "boolean", notes: "null", customer: { email: "string", password: "secret" }, lines: [{ sku: "string", price: "number" }] });
});

test("GoHighLevel-style API: bearer, custom token header, none, secret body keys, id keys", () => {
  const c = learn(ghl);
  const contact = find(c, "GET", "/contacts/{id}");
  assert.equal(contact.count, 2);
  assert.equal(contact.authKind, "bearer");
  assert.deepEqual(contact.query, { locationId: "id" });
  assert.ok(find(c, "GET", "/workflows/{id}/status"));
  assert.deepEqual(find(c, "GET", "/workflows/{id}/status").query, { locationId: "id", limit: "number" });
  const put = find(c, "PUT", "/contacts/{id}");
  assert.deepEqual(put.bodyShape, { firstName: "string", phone: "string", tags: ["string"], customFields: [{ id: "id", value: "string" }], apiKey: "secret" });
  assert.equal(find(c, "GET", "/conversations/search").authKind, "header:token-id");
  assert.equal(find(c, "GET", "/ping").authKind, "none");
  assert.equal(c.every(e => /^e_[0-9a-z]{7}$/.test(e.id)), true);
});

test("no sample value leaks into the catalog", () => {
  const s = ser([...learn(bakery), ...learn(ghl)]);
  for (const raw of [UUID, LOC, CONTACT, JWT, "1001", "1002", "COOKIEVALUE123456", "SESSIONQUERYVALUE9", "hunter2hunter2", "alex@example.com", "sourdough", "Alex", "+15551230000", "KEYVALUEabcdef123456", "TOKENIDVALUE1234567890", "SD-1", "lead", "probate", "other9Zx8Yw7Vu6Ts5Rq", "2021-07-28", "open"])
    assert.ok(!s.includes(raw), "leaked " + raw);
});

test("a body keyed by record ids does not leak the ids as keys", () => {
  const sh = shapeOf({ [UUID]: { n: 1 }, [CONTACT]: { n: 2 }, plain: 3 });
  assert.deepEqual(sh, { "{key}": { n: "number" }, plain: "number" });
});

test("mergeShape unions keys and marks conflicting types", () => {
  assert.deepEqual(mergeShape({ a: "string" }, { b: "number" }), { a: "string", b: "number" });
  assert.equal(mergeShape("string", "number"), "number|string");
  assert.deepEqual(mergeShape([{ a: "string" }], [{ b: "id" }]), [{ a: "string", b: "id" }]);
  assert.equal(mergeShape({ a: 1 }, "x"), "mixed");
});

test("authKind never returns a value and handles list-form headers", () => {
  assert.equal(authKind([{ name: "Authorization", value: `Bearer ${JWT}` }]), "bearer");
  assert.equal(authKind({ Authorization: "Basic dXNlcjpwYXNz" }), "header:authorization");
  assert.equal(authKind({ "X-API-Key": "k" }), "header:x-api-key");
  assert.equal(authKind({ "sec-ch-ua": "x", "x-requested-with": "XMLHttpRequest" }), "none");
  assert.equal(authKind(undefined), "none");
});

test("form bodies and non-JSON bodies become key types or opaque", () => {
  const c = learn([
    { method: "POST", url: "https://bakery.example/api/login", type: "XHR", status: 200, requestHeaders: { "content-type": "application/x-www-form-urlencoded" }, postData: "email=alex%40example.com&password=hunter2hunter2&remember=true&n=4" },
    { method: "POST", url: "https://bakery.example/api/blob", type: "XHR", status: 200, requestHeaders: {}, postData: "\u0000\u0001 binaryish" },
  ]);
  assert.deepEqual(find(c, "POST", "/api/login").bodyShape, { email: "string", password: "secret", remember: "boolean", n: "number" });
  assert.equal(find(c, "POST", "/api/blob").bodyShape, "opaque");
});

test("mergeCatalog folds counts, statuses, shapes and bounds size", () => {
  const a = learn([bakery[1]]);
  const b = learn([bakery[2]]);
  const m = mergeCatalog(a, b);
  assert.equal(m.length, 1);
  assert.equal(m[0].count, 2);
  assert.deepEqual(m[0].statuses, [200, 404]);
  const many = Array.from({ length: MAX_ENTRIES + 50 }, (_, i) => ({ id: "e" + i, count: i, statuses: [], query: {}, authKind: "none" }));
  assert.equal(mergeCatalog([], many).length, MAX_ENTRIES);
});

test("buildCall fills placeholders, encodes, and refuses a missing path parameter", () => {
  const e = find(learn(ghl), "PUT", "/contacts/{id}");
  const call = buildCall(e, { path: { id: "abc/def" }, query: { locationId: "L 1", skip: undefined }, body: { firstName: "Alex" } });
  assert.equal(call.method, "PUT");
  assert.equal(call.url, "https://services.gohighlevel.example/contacts/abc%2Fdef?locationId=L+1");
  assert.equal(call.body, '{"firstName":"Alex"}');
  assert.throws(() => buildCall(e, {}), /missing path parameter id/);
  const g = buildCall(find(learn(ghl), "GET", "/workflows/{id}/status"), { path: { id: UUID }, body: { x: 1 } });
  assert.equal(g.body, undefined, "a GET carries no body");
});
