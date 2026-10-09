// @ts-check
// "Call a service" for a Connection ({ connection, operation, input }): written out as the one service step the runner runs, when the Flow is defined. The Connection's catalog entry here is the one
// the vault would give (records/connectors/connection.js compiled and normalised), not a stand-in.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { compileFlow } from "./compile.js";
import { catalog, onPayment } from "./testing/fixtures.js";
import { fromForm, toConfig } from "../../records/connectors/connection.js";
import { defineConnector } from "../../records/connectors/format.js";
import { normalize } from "../../core/vault/api-request.js";

const m = fromForm({ label: "CRM", base_url: "https://api.example.com", send: { how: "bearer" }, credential: { item: "crm-key" }, check: { path: "/me" } });
const decl = defineConnector({ ...m.declaration, ops: { ...m.declaration.ops,
  "contacts.get": { method: "GET", path: "/contacts/{id}", kind: "read", input: { params: { id: { type: "string", required: true } }, query: { fields: { type: "string" } } } },
  "contacts.search": { method: "POST", path: "/contacts/search", kind: "read", relabeled: true, input: { body: { query: { type: "string", required: true } } } },
  "contacts.create": { method: "POST", path: "/contacts", kind: "change", input: { body: { name: { type: "string", required: true } } } } } });
const cfg = normalize(toConfig({ ...m, declaration: decl }));
const cat = () => { const c = catalog(); return { ...c, connectors: { ...c.connectors, "conn-crm": { ...cfg.service, operations: cfg.operations } } }; };
const withStep = (/** @type {any} */ step) => { const f = structuredClone(onPayment()); f.steps.push({ id: "call", kind: "service", ...step }); return f; };
const bad = (/** @type {any} */ step, /** @type {RegExp} */ re) => {
  const r = compileFlow(withStep(step), cat());
  assert.equal(r.ok, false, "should not compile");
  assert.ok(r.errors.some(e => re.test(e.message)), `expected ${re}, got ${JSON.stringify(r.errors)}`);
};
const stored = (/** @type {any} */ step) => {
  const r = compileFlow(withStep(step), cat());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return { r, step: r.flow.steps.find((/** @type {any} */ s) => s.id === "call") };
};

test("a read operation is written out as the service step: connector, method, filled path, the rest of the input", () => {
  const { r, step } = stored({ connection: "crm", operation: "contacts.get", input: { params: { id: "ab 12" }, query: { fields: "name" } } });
  assert.deepEqual(step, { id: "call", kind: "service", connector: "conn-crm", method: "GET", path: "/contacts/ab%2012", query: { fields: "name" }, connection: "crm", operation: "contacts.get" });
  assert.equal(r.effects.services.find((/** @type {any} */ x) => x.step === "call").outward, false, "a read runs at once");
});

test("the Gate's kinds carry through: a relabeled search is a read, a create is held, the generic request is judged by its method", () => {
  const out = (/** @type {any} */ step) => stored(step).r.effects.services.find((/** @type {any} */ x) => x.step === "call").outward;
  assert.equal(out({ connection: "crm", operation: "contacts.search", input: { body: { query: "dana" } } }), false);
  assert.equal(out({ connection: "crm", operation: "contacts.create", input: { body: { name: "Dana" } } }), true);
  assert.equal(out({ connection: "crm", operation: "request", input: { method: "GET", path: "/anything" } }), false);
  assert.equal(out({ connection: "crm", operation: "request", input: { method: "POST", path: "/anything", body: { a: 1 } } }), true);
  assert.equal(out({ connection: "crm", operation: "request", input: { method: "DELETE", path: "/anything/1" } }), true);
  const r = stored({ connection: "crm", operation: "contacts.create", input: { body: { name: "Dana" } } }).r;
  assert.ok(r.effects.outward.some((/** @type {any} */ o) => o.step === "call" && o.action === "service.call"), "the approval card lists it");
});

test("a value may be an expression in the query and the body, but the address is written out", () => {
  const ok = stored({ connection: "crm", operation: "contacts.create", input: { body: { name: { expr: "steps.open.record.client" } } } });
  assert.deepEqual(ok.step.body, { name: { expr: "steps.open.record.client" } });
  bad({ connection: "crm", operation: "contacts.get", input: { params: { id: { expr: "steps.open.record.id" } } } }, /address of an outward call is constant/);
  bad({ connection: "crm", operation: "request", input: { method: "GET", path: "/a?x=1" } }, /path starts with/);
  bad({ connection: "crm", operation: "request", input: { method: "GET" } }, /path starts with/);
});

test("mistakes are named at define time: no such Connection, no such operation, an input the operation does not take, a missing one", () => {
  bad({ connection: "ghost", operation: "request", input: { method: "GET", path: "/x" } }, /no Connection ghost/);
  bad({ connection: "crm", operation: "nope.go" }, /has no operation nope\.go/);
  bad({ connection: "crm", operation: "contacts.get", input: { params: { id: "1", extra: "x" } } }, /does not take extra in params/);
  bad({ connection: "crm", operation: "contacts.get", input: { params: { id: "1" }, query: { sneak: "x" } } }, /does not take sneak in query/);
  bad({ connection: "crm", operation: "contacts.create", input: {} }, /needs name in body/);
  bad({ connection: "crm", operation: "contacts.get", input: { cookies: {} } }, /input is \{ params, query, headers, body \}/);
  bad({ connection: "crm", operation: "contacts.get", input: { params: { id: "1" }, headers: { Authorization: "x" } } }, /does not take Authorization in headers|never sets/);
});

test("the stored step is an ordinary service step: it compiles again as it is, and a connector step is untouched", () => {
  const { step } = stored({ connection: "crm", operation: "contacts.get", input: { params: { id: "7" } } });
  const again = compileFlow(withStep(step), cat());
  assert.equal(again.ok, true, JSON.stringify(again.errors));
  const plain = compileFlow(withStep({ connector: "practice", method: "GET", path: "/matters/1" }), cat());
  assert.equal(plain.ok, true, JSON.stringify(plain.errors));
});
