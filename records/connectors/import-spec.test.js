// @ts-check
// A draft Connection from an OpenAPI or Postman file: the operations as the form takes them, never saved, never relabeled, nothing of the file's examples or keys carried over; and the draft
// goes through the same form and format checks as anything the person types.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { importSpec, opName } from "./import-spec.js";
import { fromForm } from "./connection.js";
import { checkDeclaration } from "./format.js";

const openapi = () => ({
  openapi: "3.0.3", info: { title: "Acme CRM API" }, servers: [{ url: "https://api.acme.example/v2" }],
  paths: {
    "/contacts": {
      get: { operationId: "listContacts", summary: "List contacts", parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }, { $ref: "#/components/parameters/Since" }] },
      post: { operationId: "createContact", summary: "Add a contact", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/NewContact" } } } } },
    },
    "/contacts/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      get: { operationId: "getContactById" }, delete: { operationId: "deleteContact" },
    },
    "/contacts/search": { post: { operationId: "searchContacts", summary: "Search", requestBody: { content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } } } } },
  },
  components: { parameters: { Since: { name: "since", in: "query", schema: { type: "string" } } }, schemas: { NewContact: { type: "object", required: ["name"], properties: { name: { type: "string" }, tags: { type: "array" }, vip: { type: "boolean" } } } } },
});

test("names: camel case and folders become the dotted lower case words the format takes", () => {
  assert.equal(opName("getContactById"), "get_contact_by_id");
  assert.equal(opName("Contacts / Create"), "contacts.create");
  assert.equal(opName("  "), "operation");
  assert.equal(opName("123abc"), "abc");
});

test("OpenAPI 3: operations with their shapes, the method sets the kind later, a POST is never a read here, the server gives the host and its path prefix", () => {
  const d = importSpec(JSON.stringify(openapi()));
  assert.equal(d.source, "openapi"); assert.equal(d.label, "Acme CRM API"); assert.equal(d.base_url, "https://api.acme.example");
  const by = Object.fromEntries(d.operations.map(o => [o.name, o]));
  assert.deepEqual(Object.keys(by).sort(), ["create_contact", "delete_contact", "get_contact_by_id", "list_contacts", "search_contacts"]);
  assert.equal(by.list_contacts.path, "/v2/contacts");
  assert.deepEqual(by.list_contacts.input.query, { limit: { type: "number" }, since: { type: "string" } });
  assert.deepEqual(by.get_contact_by_id.input.params, { id: { type: "string", required: true } });
  assert.deepEqual(by.create_contact.input.body, { name: { type: "string", required: true }, tags: { type: "array" }, vip: { type: "boolean" } });
  assert.deepEqual(by.search_contacts.input.body, { query: { type: "string", required: true } });
  for (const o of d.operations) { assert.equal(o.kind, undefined, "the draft sets no kind: the method does"); assert.equal(o.relabeled, undefined); }
  // the draft goes through the form: a POST is a change, the delete is a delete, and the declaration is clean
  const m = fromForm({ label: d.label, base_url: d.base_url, send: { how: "bearer" }, credential: { item: "acme-key" }, check: { path: "/v2/contacts" }, operations: d.operations });
  assert.deepEqual(checkDeclaration(m.declaration), []);
  assert.equal(m.declaration.ops.search_contacts.kind, "change");
  assert.equal(m.declaration.ops.delete_contact.kind, "delete");
  assert.equal(m.declaration.ops.list_contacts.kind, "read");
});

test("Swagger 2 gives host, base path and https; a server with variables or http gives no address and a note", () => {
  const s2 = importSpec({ swagger: "2.0", info: { title: "Old" }, host: "api.old.example", basePath: "/v1", schemes: ["https"], paths: { "/things": { get: { operationId: "things" } } } });
  assert.equal(s2.base_url, "https://api.old.example"); assert.equal(s2.operations[0].path, "/v1/things");
  const none = importSpec({ openapi: "3.0.0", servers: [{ url: "http://insecure.example" }, { url: "https://{tenant}.example.com" }], paths: { "/x": { get: {} } } });
  assert.equal(none.base_url, ""); assert.ok(none.notes.some(n => /no https server address/.test(n)));
});

test("Postman: folders name the operations, :id and {{var}} become path parameters, the host comes from a plain https address, a sample body lists its fields", () => {
  const c = { info: { name: "GoHighLevel" }, item: [
    { name: "Contacts", item: [
      { name: "Get contact", request: { method: "GET", url: { raw: "https://services.leadconnectorhq.com/contacts/:id", host: ["services", "leadconnectorhq", "com"], path: ["contacts", ":id"], protocol: "https" } } },
      { name: "Create contact", request: { method: "POST", url: { raw: "https://services.leadconnectorhq.com/contacts", host: ["services", "leadconnectorhq", "com"], path: ["contacts"], query: [{ key: "dry", value: "1" }, { key: "off", disabled: true }] }, body: { mode: "raw", raw: "{\"firstName\":\"Dana\",\"tags\":[\"a\"],\"dnd\":false}" } } },
    ] },
    { name: "Odd", request: { method: "TRACE", url: "https://x.example/y" } },
  ] };
  const d = importSpec(JSON.stringify(c));
  assert.equal(d.source, "postman"); assert.equal(d.base_url, "https://services.leadconnectorhq.com"); assert.equal(d.skipped, 1);
  const by = Object.fromEntries(d.operations.map(o => [o.name, o]));
  assert.deepEqual(Object.keys(by), ["contacts.get_contact", "contacts.create_contact"]);
  assert.equal(by["contacts.get_contact"].path, "/contacts/{id}");
  assert.deepEqual(by["contacts.get_contact"].input.params, { id: { type: "string", required: true } });
  assert.deepEqual(by["contacts.create_contact"].input.body, { firstName: { type: "string" }, tags: { type: "array" }, dnd: { type: "boolean" } });
  assert.deepEqual(by["contacts.create_contact"].input.query, { dry: { type: "string" } });
  const m = fromForm({ label: "GoHighLevel", base_url: d.base_url, send: { how: "bearer" }, credential: { item: "k" }, check: { path: "/contacts" }, operations: d.operations });
  assert.deepEqual(checkDeclaration(m.declaration), []);
});

test("what is not a description is refused in words, and a file is never fetched or run here", () => {
  assert.throws(() => importSpec(""), /give the API description/);
  assert.throws(() => importSpec("openapi: 3.0.0\npaths: {}"), /convert it to JSON/);
  assert.throws(() => importSpec("{ nope"), /not valid JSON/);
  assert.throws(() => importSpec({ hello: 1 }), /neither an OpenAPI file/);
  assert.throws(() => importSpec({ openapi: "3.0.0", paths: {} }), /lists no operations/);
  assert.throws(() => importSpec({ info: {}, item: [] }), /lists no requests/);
  // a path that climbs, and an example value, are not carried over
  const d = importSpec({ openapi: "3.0.0", servers: [{ url: "https://a.example" }], paths: { "/ok": { get: { operationId: "ok", parameters: [{ name: "token", in: "query", example: "sk_live_SECRET", schema: { type: "string" } }] } }, "/../etc": { get: {} } } });
  assert.equal(d.operations.length, 1); assert.equal(d.skipped, 1);
  assert.ok(!JSON.stringify(d).includes("sk_live_SECRET"));
});
