// @ts-check
// A site Connection's pure half: learned operations become a declaration the checker accepts, a config the vault accepts and a Flow can be checked against, and a virtual address maps back.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { siteDeclaration, siteConfig, operationOf, opKey, opPath } from "./site.js";
import { checkDeclaration } from "./format.js";
import { normalize, classify } from "../../core/vault/api-request.js";
import { routeAllowed, ruleFor } from "../../core/vault/service.js";
import { learnOperation } from "../../lib/siteops/learn.js";
import * as F from "../../lib/siteops/fixtures.js";

const ORIGIN = "https://app.example.com";
const read = () => learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp"), exchanges2: F.pageRest("beta works"), examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/search?q={query}` } }).operation;
const send = () => learnOperation({ name: "sendMessage", kind: "send", exchanges: F.pageSend("ada-lovelace", "hello there friend"), exchanges2: F.pageSend("grace-hopper", "second text here"), examples: [{ recipient: "ada-lovelace", text: "hello there friend" }, { recipient: "grace-hopper", text: "second text here" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/inbox` } }).operation;
const entries = () => [{ name: "searchPeople", kind: "read", op: read() }, { name: "sendMessage", kind: "send", op: send() }];
const decl = () => siteDeclaration({ id: "linkedin", label: "LinkedIn", origin: ORIGIN, entries: entries() });

test("learned operations become a declaration the checker accepts, with a virtual address each: GET for a read, POST for the rest", () => {
  const d = decl();
  assert.deepEqual(checkDeclaration(d), []);
  assert.equal(d.transport, "site");
  assert.deepEqual(d.auth, { type: "browser" });
  assert.equal(opKey("searchPeople"), "search_people");
  assert.equal(opPath("searchPeople"), "/ops/search_people");
  assert.deepEqual(Object.keys(d.ops), ["search_people", "send_message"]);
  assert.deepEqual([d.ops.search_people.method, d.ops.search_people.kind, d.ops.search_people.site], ["GET", "read", { name: "searchPeople" }]);
  assert.deepEqual([d.ops.send_message.method, d.ops.send_message.kind], ["POST", "send"]);
  assert.deepEqual(d.ops.search_people.input, { query: { query: { type: "string", required: true } } });
  assert.deepEqual(d.ops.send_message.input.body, { recipient: { type: "string", required: true }, text: { type: "string", required: true } });
  assert.ok(!JSON.stringify(d).includes(F.CSRF) && !JSON.stringify(d).includes("/api/v2/search"), "the declaration holds names and shapes, not the learned request");
});

test("the config holds the host and the route rules and no key; nothing but the declared operations is allowed, and a send is classed a send", () => {
  const cfg = normalize(siteConfig(decl()));
  assert.deepEqual(cfg.auth, { type: "browser" });
  assert.deepEqual(cfg.hosts, ["app.example.com"]);
  assert.equal(classify("GET", "/ops/search_people", cfg.endpoints).kind, "read");
  assert.equal(classify("POST", "/ops/send_message", cfg.endpoints).kind, "send");
  assert.equal(routeAllowed(cfg.service, "GET", "/ops/search_people"), true);
  assert.equal(routeAllowed(cfg.service, "POST", "/ops/send_message"), true);
  assert.equal(routeAllowed(cfg.service, "GET", "/anything/else"), false, "there is no generic request on a browser's login");
  assert.equal(routeAllowed(cfg.service, "POST", "/ops/search_people"), false);
  assert.ok(ruleFor(cfg.service, "GET", "/ops/search_people"));
  assert.deepEqual(Object.keys(cfg.operations).sort(), ["search_people", "send_message"]);
});

test("a call to a virtual address maps back to the learned operation and its inputs", () => {
  const d = decl();
  assert.deepEqual(operationOf(d, { method: "GET", path: "/ops/search_people", query: { query: "gamma labs" } }), { name: "searchPeople", kind: "read", inputs: { query: "gamma labs" } });
  assert.deepEqual(operationOf(d, { method: "POST", path: "/ops/send_message", body: JSON.stringify({ recipient: "alan", text: "hello there" }) }), { name: "sendMessage", kind: "send", inputs: { recipient: "alan", text: "hello there" } });
  assert.equal(operationOf(d, { method: "POST", path: "/ops/search_people" }), null, "a read is not a POST");
  assert.equal(operationOf(d, { method: "GET", path: "/nope" }), null);
});

test("the checker keeps the browser sign-in for site Connections only, and wants each operation to name what it runs", () => {
  const d = JSON.parse(JSON.stringify(decl()));
  assert.ok(checkDeclaration({ ...d, transport: undefined }).some(p => /browser/.test(p)));
  assert.ok(checkDeclaration({ ...d, auth: { type: "bearer" } }).some(p => /browser/.test(p)));
  assert.ok(checkDeclaration({ ...d, app: "docs" }).some(p => /no app/.test(p)));
  const bare = structuredClone(d); delete bare.ops.search_people.site;
  assert.ok(checkDeclaration(bare).some(p => /site.name/.test(p)));
  assert.ok(checkDeclaration({ ...d, transport: "other" }).some(p => /transport/.test(p)));
});
