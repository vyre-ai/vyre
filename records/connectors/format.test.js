import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DECLARATIONS } from "./index.js";
import { checkDeclaration, defineConnector, toCredentialConfig, mergedCredentialConfig, serviceOf, buildRequest, opFor, readbackRequest, compareReadback, parseResponse, isOutward } from "./format.js";
import { normalize, classify } from "../../core/vault/api-request.js";

const stripe = DECLARATIONS.stripe;
// Gmail and Calendar ship as `auth.type: "google"` (signed in through the google module, no vault credential). These tests exercise the format's OAuth and service-account ways of signing in, so they use the
// same declarations with an OAuth sign-in, as a service like Clio would have.
const OAUTH = { type: "oauth", authorize_uri: "https://accounts.google.com/o/oauth2/v2/auth", token_uri: "https://oauth2.googleapis.com/token", also: ["service-account"] };
const asOauth = (/** @type {any} */ d) => ({ ...d, auth: { ...OAUTH, scopes: d.auth.scopes } });
const gmail = asOauth(DECLARATIONS.gmail), cal = asOauth(DECLARATIONS["google-calendar"]);
const minimal = (o = {}) => ({ id: "clio", label: "Clio", version: 1, base_url: "https://app.clio.com", auth: { type: "bearer" }, ops: { "matters.list": { method: "GET", path: "/api/v4/matters", kind: "read" } }, ...o });

test("the shipped declarations are clean, and each becomes a credential the vault accepts", () => {
  for (const d of Object.values(DECLARATIONS)) {
    assert.deepEqual(checkDeclaration(d), [], d.id);
    // a Google connector is not made in the vault at all: the google module signs in and holds the token
    if (d.auth.type === "google") { assert.throws(() => toCredentialConfig(d, { client: "google-app" }), /Google module/, d.id); continue; }
    const cfg = d.auth.type === "bearer" ? toCredentialConfig(d, { item: d.id }) : toCredentialConfig(d, { client: "google-app" });
    const n = normalize(cfg);
    assert.deepEqual(n.hosts, [new URL(d.base_url).hostname]);
    assert.equal(n.service.allow.length, Object.keys(d.ops).length, "one rule per op, and nothing else is reachable");
  }
  // a Google connector may also sign in as a service account acting as one address, fixed at install
  const sa = normalize(toCredentialConfig(gmail, { as: "service-account", subject: "office@harlow.test" }));
  assert.equal(sa.auth.type, "service-account"); assert.equal(sa.auth.subject, "office@harlow.test");
  assert.throws(() => toCredentialConfig(gmail, { as: "service-account" }), /which address/);
  assert.throws(() => toCredentialConfig(stripe, { as: "service-account", subject: "x@y.test" }), /does not sign in as a service account/);
  assert.throws(() => toCredentialConfig(gmail, {}), /own|app/);
});

test("outward comes only from the op's kind: reads run, a draft is not outward, send, spend, delete and change are held by the vault's own classes", () => {
  const cfg = toCredentialConfig(gmail, { client: "g" });
  const cls = (op) => classify(op.method, op.path.replace(/\{[^}]*\}/g, "x"), cfg.endpoints).kind;
  assert.equal(cls(gmail.ops["messages.list"]), "read");
  assert.equal(cls(gmail.ops["drafts.create"]), "read", "a draft is prepared at once: nothing leaves the mailbox");
  assert.equal(isOutward(gmail.ops["drafts.create"]), false);
  assert.equal(cls(gmail.ops["messages.send"]), "send");
  assert.equal(cls(gmail.ops["drafts.send"]), "send");
  const s = toCredentialConfig(stripe, { item: "stripe" });
  assert.equal(classify("POST", "/v1/refunds", s.endpoints).kind, "spend");
  assert.equal(classify("POST", "/v1/customers", s.endpoints).kind, "send", "a change in the service is held like a send");
  assert.equal(classify("GET", "/v1/customers/cus_1", s.endpoints).kind, "read");
  const c = toCredentialConfig(cal, { client: "g" });
  assert.equal(classify("DELETE", "/calendar/v3/calendars/primary/events/e1", c.endpoints).kind, "delete");
  assert.equal(classify("POST", "/calendar/v3/calendars/primary/events", c.endpoints).kind, "send", "an invitation reaches other people");
  // nothing undeclared is reachable at all (the vault's service rules)
  const { allow } = normalize(cfg).service;
  assert.ok(!allow.some(r => /settings|filters|forwarding/.test(r.path)));
});

test("the service block carries what the step runner needs: draft op, idempotency header, rate, and each op's flags and read-back", () => {
  const sv = serviceOf(stripe);
  assert.deepEqual(sv.idempotency, { header: "Idempotency-Key" });
  assert.deepEqual(sv.rate, { per_minute: 6000, retry_after: true });
  const create = sv.ops.find(o => o.name === "customers.create");
  assert.equal(create.outward, true); assert.equal(create.read, false);
  assert.deepEqual(create.readback, { method: "GET", path: "/v1/customers/{id}", vars: { id: "response.json.id" }, compare: { email: "request.body.email", name: "request.body.name" } });
  assert.equal(sv.ops.find(o => o.name === "customers.get").read, true);
  const g = serviceOf(gmail);
  assert.deepEqual(g.draft, { method: "POST", path: "/gmail/v1/users/me/drafts", wrap: "message" });
  assert.equal(g.idempotency, undefined, "a provider with no idempotency key says none");
  // the vault keeps all of it
  const kept = normalize(toCredentialConfig(stripe, { item: "stripe" })).service;
  assert.deepEqual(kept.ops.find(o => o.name === "customers.create").readback.vars, { id: "response.json.id" });
  assert.deepEqual(kept.idempotency, { header: "Idempotency-Key" });
  assert.deepEqual(normalize(toCredentialConfig(gmail, { client: "g" })).service.draft, { method: "POST", path: "/gmail/v1/users/me/drafts", wrap: "message" });
});

test("a declaration with a mistake is refused with every problem named", () => {
  const bad = (o, re) => assert.ok(checkDeclaration(minimal(o)).some(p => re.test(p)), JSON.stringify(Object.keys(o)) + " -> " + checkDeclaration(minimal(o)).join(" | "));
  bad({ base_url: "http://api.clio.com" }, /base_url/);
  bad({ base_url: "https://*.clio.com" }, /base_url/);
  bad({ base_url: "https://app.clio.com/v4" }, /base_url/);
  bad({ id: "Clio!" }, /^id/);
  bad({ auth: { type: "cookie" } }, /auth.type/);
  bad({ auth: { type: "oauth" } }, /authorize_uri/);
  bad({ rate: { per_minute: 0 } }, /rate/);
  bad({ idempotency: { header: "bad header" } }, /idempotency/);
  bad({ ops: {} }, /at least one/);
  bad({ ops: { "a.b": { method: "POST", path: "/x", kind: "read" } } }, /a read is a GET/);
  bad({ ops: { "a.b": { method: "GET", path: "/x", kind: "send" } } }, /not a GET/);
  bad({ ops: { "a.b": { method: "GET", path: "/x/*", kind: "read" } } }, /no wildcard/);
  bad({ ops: { "a.b": { method: "GET", path: "/x/{id}", kind: "read" } } }, /{id}/);
  bad({ ops: { "a.b": { method: "GET", path: "/x", kind: "read" }, "a.c": { method: "GET", path: "/x", kind: "read" } } }, /declared twice/);
  bad({ ops: { "a.b": { method: "POST", path: "/x", kind: "send", readback: { op: "nope", args: {} } } } }, /readback.op/);
  bad({ ops: { "a.b": { method: "GET", path: "/x", kind: "read", readback: { op: "a.b", args: {} } } } }, /nothing to read back/);
  bad({ ops: { "a.r": { method: "GET", path: "/r/{id}", kind: "read", input: { params: { id: { type: "string" } } } }, "a.w": { method: "POST", path: "/w", kind: "send", readback: { op: "a.r", args: {} } } } }, /no value for {id}/);
  bad({ ops: { "a.d": { method: "POST", path: "/d/{x}", kind: "draft", input: { params: { x: { type: "string" } } } } } }, /fixed path/);
  bad({ ops: { "a.w": { method: "POST", path: "/w", kind: "send", wrap: "message" } } }, /wrap/);
  bad({ ops: { "a.b": { method: "GET", path: "/x", kind: "read", input: { smuggled: {} } } } }, /not part of an op's input/);
  bad({ poll: { "p.q": { op: "nope", id: "id", map: {} } } }, /read op/);
  bad({ poll: { "p.q": { op: "matters.list", id: "id", map: { x: 5 } } } }, /mapped field/);
  assert.throws(() => defineConnector(minimal({ id: "X" })), e => e.code === "bad_input" && Array.isArray(e.problems));
  assert.deepEqual(checkDeclaration(minimal()), [], "and a plain read-only connector is one op and a base url");
});

test("buildRequest: the path is filled and encoded, undeclared input is refused, forms and a draft's wrapper are applied", () => {
  assert.deepEqual(buildRequest(stripe, "customers.get", { params: { id: "cus 1/x" } }), { method: "GET", path: "/v1/customers/cus%201%2Fx" });
  assert.deepEqual(buildRequest(stripe, "customers.create", { body: { email: "a@b.test", metadata: { matter: "m1" } } }),
    { method: "POST", path: "/v1/customers", body: { email: "a@b.test", metadata: { matter: "m1" } }, headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.throws(() => buildRequest(stripe, "customers.create", { body: { email: "a@b.test", admin: true } }), /admin: not part of this/);
  assert.throws(() => buildRequest(stripe, "customers.create", { body: { email: "not an email" } }), /an email address/);
  assert.throws(() => buildRequest(stripe, "customers.get", {}), /id: needed/);
  assert.throws(() => buildRequest(stripe, "customers.get", { params: { id: "c" }, body: { x: 1 } }), /takes none/);
  assert.throws(() => buildRequest(stripe, "refunds.create", { body: { payment_intent: "pi_1", reason: "because" } }), /one of duplicate/);
  assert.throws(() => buildRequest(stripe, "nope", {}), /no op nope/);
  assert.deepEqual(buildRequest(gmail, "drafts.create", { body: { raw: "UkFX" } }), { method: "POST", path: "/gmail/v1/users/me/drafts", body: { message: { raw: "UkFX" } } });
  assert.equal(buildRequest(cal, "events.list", { params: { calendar: "alex@harlow.test" }, query: { updatedMin: "2026-10-01T00:00:00Z" } }).path, "/calendar/v3/calendars/alex%40harlow.test/events");
  assert.equal(opFor(stripe, "GET", "/v1/customers/cus_1").name, "customers.get");
  assert.equal(opFor(stripe, "POST", "/v1/customers").name, "customers.create");
  assert.equal(opFor(stripe, "DELETE", "/v1/customers/cus_1"), null);
});

test("read-back: the paired read is built from the write, and a differing value is named", () => {
  const done = { request: { body: { email: "a@b.test", name: "Alex" } }, response: { json: { id: "cus_9" } } };
  const rb = readbackRequest(stripe, "customers.create", done);
  assert.deepEqual(rb, { op: "customers.get", request: { method: "GET", path: "/v1/customers/cus_9" } });
  assert.deepEqual(compareReadback(stripe, "customers.create", done, { json: { id: "cus_9", email: "a@b.test", name: "Alex" } }), { ok: true, mismatches: [] });
  const off = compareReadback(stripe, "customers.create", done, { json: { id: "cus_9", email: "other@b.test", name: "Alex" } });
  assert.equal(off.ok, false); assert.deepEqual(off.mismatches, [{ field: "email", wrote: "a@b.test", read: "other@b.test" }]);
  assert.equal(compareReadback(stripe, "customers.create", { request: { body: { email: "a@b.test" } }, response: done.response }, { json: { email: "a@b.test", name: null } }).ok, true, "a field the write did not send is not checked");
  assert.equal(readbackRequest(stripe, "customers.get", done), null, "a read has none");
  const ev = readbackRequest(cal, "events.insert", { request: { params: { calendar: "primary" }, body: { summary: "Signing" } }, response: { json: { id: "ev1" } } });
  assert.equal(ev.request.path, "/calendar/v3/calendars/primary/events/ev1");
});

test("parseResponse: a named output field that is missing is a problem, an extra one is not, a failed status says so", () => {
  assert.equal(parseResponse(stripe, "customers.get", { status: 200, json: { id: "c", livemode: false } }).ok, true);
  assert.deepEqual(parseResponse(stripe, "customers.get", { status: 200, json: { email: "x" } }).problems, ["response.id: needed"]);
  assert.equal(parseResponse(stripe, "customers.get", { status: 404, json: {} }).ok, false);
});

test("one sign-in for several declarations: Gmail and Calendar share a credential that names both hosts, each route says which host it is on", () => {
  const cfg = toCredentialConfig([gmail, cal], { as: "service-account", subject: "office@harlow.test" });
  assert.deepEqual(cfg.hosts, ["gmail.googleapis.com", "www.googleapis.com"]);
  assert.equal(cfg.auth.type, "service-account");
  assert.ok(cfg.auth.scopes.includes("https://www.googleapis.com/auth/gmail.compose") && cfg.auth.scopes.some(s => /calendar/.test(s)), "the scopes are joined");
  const n = normalize(cfg);
  const host = (method, path) => n.service.allow.find(r => r.method === method && r.path === path).host;
  assert.equal(host("GET", "/gmail/v1/users/me/messages"), "gmail.googleapis.com");
  assert.equal(host("POST", "/calendar/v3/calendars/*/events"), "www.googleapis.com");
  assert.equal(n.service.ops.length, Object.keys(gmail.ops).length + Object.keys(cal.ops).length);
  assert.deepEqual(n.service.draft, { method: "POST", path: "/gmail/v1/users/me/drafts", wrap: "message" });
  assert.equal(classify("POST", "/gmail/v1/users/me/drafts", n.endpoints).kind, "read", "a draft is not held");
  assert.equal(classify("POST", "/calendar/v3/calendars/primary/events", n.endpoints).kind, "send");
  // refused: a connector that signs in another way, a repeated op, a rule naming a host the credential lacks
  assert.throws(() => mergedCredentialConfig([gmail, stripe], {}), /does not sign in the way/);
  assert.throws(() => mergedCredentialConfig([gmail, gmail], { client: "g" }), /two connectors/);
  assert.throws(() => normalize({ ...cfg, service: { ...cfg.service, allow: [{ method: "GET", path: "/x", host: "elsewhere.example.test" }] } }), /not one of the credential's hosts/);
});
