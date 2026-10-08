// @ts-check
// A Connection's pure half: the quick form becomes a declaration the existing checker accepts, the declaration compiles to a config the vault accepts, and a check's answer is said in plain words.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fromForm, toConfig, outcomeOf, slug, credentialName } from "./connection.js";
import { checkDeclaration } from "./format.js";
import { normalize, classify } from "../../core/vault/api-request.js";
import { routeAllowed } from "../../core/vault/service.js";
import { defineConnector } from "./format.js";

const ghl = (o = {}) => ({
  label: "GoHighLevel Sales", base_url: "https://services.leadconnectorhq.com/", send: { how: "bearer" }, credential: { item: "ghl-sales-pat" },
  headers: { Version: "2021-07-28" }, vars: { locationId: "loc_123" }, check: { path: "/locations/{locationId}" }, ...o,
});

test("the GoHighLevel form becomes a clean declaration and a config the vault accepts", () => {
  const m = fromForm(ghl());
  assert.equal(m.id, "gohighlevel-sales");
  assert.deepEqual(checkDeclaration(m.declaration), []);
  assert.equal(m.declaration.base_url, "https://services.leadconnectorhq.com");
  assert.equal(m.check.path, "/locations/loc_123");
  assert.deepEqual(m.declaration.headers, { Version: "2021-07-28" });
  const n = normalize(toConfig(m));
  assert.deepEqual(n.hosts, ["services.leadconnectorhq.com"]);
  assert.deepEqual(n.auth, { type: "bearer", item: "ghl-sales-pat" });
  assert.deepEqual(n.headers, { version: "2021-07-28" });
  assert.deepEqual(n.readers, [{ module: "connectors", paths: ["/locations/loc_123"] }]);
  assert.equal(credentialName(m.id), "conn-gohighlevel-sales");
  assert.ok(!JSON.stringify(n).includes("loc_123_secret"));
});

test("each way of sending the key is one auth the vault takes", () => {
  const cfg = send => normalize(toConfig(fromForm(ghl({ send, headers: undefined }))));
  assert.equal(cfg({ how: "basic" }).auth.type, "basic");
  assert.deepEqual(cfg({ how: "header", name: "X-Api-Key" }).auth, { type: "api-key", item: "ghl-sales-pat", header: "x-api-key" });
  assert.deepEqual(cfg({ how: "query", name: "api_key" }).auth, { type: "api-key", item: "ghl-sales-pat", in: "query", param: "api_key" });
  assert.throws(() => fromForm(ghl({ send: { how: "header" } })), /send.name/);
  assert.throws(() => fromForm(ghl({ send: { how: "oauth-client" } })), /not available yet/);
});

test("the form refuses what would be a hole", () => {
  assert.throws(() => fromForm(ghl({ base_url: "http://x.example.com" })), /https/);
  assert.throws(() => fromForm(ghl({ base_url: "https://x.example.com/api" })), /host/);
  assert.throws(() => fromForm(ghl({ headers: { Authorization: "Bearer x" } })), /authenticates or frames/);
  assert.throws(() => fromForm(ghl({ headers: { "X-Auth-Token": "x" } })), /authenticates or frames/);
  assert.throws(() => fromForm(ghl({ headers: { Version: "a\r\nHost: evil" } })), /single-line/);
  assert.throws(() => fromForm(ghl({ vars: {} })), /\{locationId\} has no value/);
  assert.throws(() => fromForm(ghl({ check: { path: "/x?y=1" } })), /path only/);
  assert.throws(() => fromForm(ghl({ check: { path: "locations" } })), /check.path/);
  assert.throws(() => fromForm(ghl({ credential: {} })), /credential.item/);
  assert.throws(() => fromForm(ghl({ vars: { locationId: "../admin" } })), /./, "a value that would climb out of the path is refused by the path check");
  assert.equal(slug("  My CRM!! "), "my-crm");
});

test("a check's answer is said in plain words", () => {
  const w = r => outcomeOf(r).words, l = r => outcomeOf(r).light;
  assert.deepEqual(outcomeOf({ reply: { status: 200 } }), { light: "green", words: "connected" });
  assert.equal(w({ reply: { status: 401 } }), "the key was refused (401)");
  assert.equal(w({ reply: { status: 403 } }), "the key is not allowed to do that (403)");
  assert.equal(w({ reply: { status: 404 } }), "that id was not found (404)");
  assert.equal(w({ reply: { status: 503 } }), "the service is having trouble (503)");
  assert.equal(w({ error: { message: "request timed out after 20s" } }), "no answer from the host (timeout)");
  assert.equal(w({ error: { message: "getaddrinfo ENOTFOUND nope.example.com" } }), "that address does not resolve");
  assert.match(w({ error: { code: "config", message: "conn-x names the vault item k, which is not there" } }), /could not be read from the Vault/);
  for (const s of [301, 401, 404, 500]) assert.equal(l({ reply: { status: s } }), "red");
});

test("the generic request: any method and path on the pinned host, classified by its method; a declared operation sits on top and wins", () => {
  const m = fromForm(ghl());
  const decl = defineConnector({ ...m.declaration, ops: { ...m.declaration.ops,
    "contacts.search": { method: "POST", path: "/contacts/search", kind: "read", relabeled: true, label: "Search contacts" },
    "contacts.create": { method: "POST", path: "/contacts", kind: "change", label: "Add a contact" } } });
  const n = normalize(toConfig({ ...m, declaration: decl }));
  const kind = (/** @type {string} */ method, /** @type {string} */ path) => classify(method, path, n.endpoints).kind;
  // nothing declared about these: the method decides
  assert.equal(kind("GET", "/anything/at/all"), "read");
  assert.equal(kind("HEAD", "/x"), "read");
  assert.equal(kind("POST", "/x"), "send");
  assert.equal(kind("PUT", "/x/1"), "send");
  assert.equal(kind("PATCH", "/x/1"), "send");
  assert.equal(kind("DELETE", "/x/1"), "delete");
  // a declared operation wins: the search is a read because the person relabeled it, the create is held
  assert.equal(kind("POST", "/contacts/search"), "read");
  assert.equal(kind("POST", "/contacts"), "send");
  // the Flow rules: every method on any path of the host is reachable by the generic request
  assert.equal(routeAllowed(n.service, "DELETE", "/deep/er/path"), true);
  assert.equal(routeAllowed(n.service, "GET", "/"), true);
  // only the person's word makes a write a read
  assert.throws(() => defineConnector({ ...m.declaration, ops: { ...m.declaration.ops, "x.go": { method: "POST", path: "/x", kind: "read" } } }), /a read is a GET or HEAD/);
  assert.throws(() => defineConnector({ ...m.declaration, ops: { ...m.declaration.ops, "x.go": { method: "GET", path: "/x", kind: "read", relabeled: false } } }), /relabeled/);
});
