// @ts-check
// Views over a Connection's operations: a wrapped app's everyday screens are Vyre views. A view names { connection, operation, input } where a tool would go; it is written out as
// connectors.operation.run. A module reaches only the Connection of its own app and only the operations that Connection declares; a person's surface reaches any.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { withOperations } from "../../local/capsule/frames.js";
import { tempHome, present, writeModule } from "../../test/helpers.js";

test("withOperations: a Connection operation is written out as the one tool that runs it, in a list, a detail, an action and a form", () => {
  const out = withOperations({ title: "Docs", list: { connection: "docuseal", operation: "list", input: { query: { q: "{q}" } }, map: { rows: "data" },
    detail: { connection: "docuseal", operation: "get", input: { params: { id: "{id}" } } },
    actions: [{ id: "send", title: "Send", connection: "docuseal", operation: "create", input: { body: { id: "{id}" } } }, { id: "open", title: "Open", do: { open: "{url}" } }] },
  forms: { f: { submit: { title: "Go", connection: "docuseal", operation: "create" } } } });
  assert.deepEqual(out.list.tool, "connectors.operation.run");
  assert.deepEqual(out.list.input, { connection: "docuseal", operation: "list", input: { query: { q: "{q}" } } });
  assert.deepEqual(out.list.detail.input, { connection: "docuseal", operation: "get", input: { params: { id: "{id}" } } });
  assert.equal(out.list.actions[0].tool, "connectors.operation.run");
  assert.equal(out.list.actions[1].tool, undefined, "an action with no operation is left alone");
  assert.deepEqual(out.forms.f.submit.input, { connection: "docuseal", operation: "create" });
  const plain = { list: { tool: "bakery.orders", input: { q: "{q}" } } };
  assert.deepEqual(withOperations(plain), plain, "a declaration with a tool is untouched");
});

const VIEW = (module) => ({ "view:waiting": { title: "Waiting for signature", root: true, list: { connection: "docuseal", operation: "list", input: { query: { status: "pending" } }, map: { rows: "data", id: "id", title: "name" } } } });
const SRC = name => `export default { async start(ctx) { ctx.tool("${name}.noop", { effect: "read", input: { type: "object" }, run: async () => ({}) }); return {}; } };`;

test("connectors.operation.run: a module reaches only its own app's Connection and the operations it declares; a person reaches any", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "local", vault: { keystore: "file" } }));
  const mods = path.join(root, "modules");
  for (const name of ["docuseal", "stranger"]) writeModule(mods, name, { description: name, does: { tools: [{ name: `${name}.noop`, reach: "asked", effect: "read" }] }, shows: { capsule: VIEW(name) } }, SRC(name));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const cli = (tool, input = {}) => call(tool, input, { root, caller: "cli" });
  assert.ok(!(await cli("vault.put", { name: "docuseal-key", kind: "secret", value: "k-123456789012" })).error);
  const made = await cli("connectors.connection.create", { label: "DocuSeal", app: "docuseal", send: { how: "header", name: "X-Auth-Token" }, credential: { item: "docuseal-key" }, check: { path: "/api/templates" },
    operations: [{ name: "list", method: "GET", path: "/api/submissions" }, { name: "create", method: "POST", path: "/api/submissions" }] });
  assert.deepEqual(made.data, { id: "docuseal", credential: "conn-docuseal" }, JSON.stringify(made));
  for (const n of ["docuseal", "stranger"]) assert.equal(d.registry.modules.get(n).state, "running", String(d.registry.modules.get(n).error));

  const run = (caller, input, meta) => d.registry.call("connectors.operation.run", { connection: "docuseal", ...input }, caller, meta);
  // a module that is not the app's: refused, whatever its views say
  assert.equal((await run("module:stranger", { operation: "list" })).error?.code, "denied");
  // the app's own module: past the ownership and operation checks (the app is not running here, so the request itself says so, not a refusal of the module)
  const own = await run("module:docuseal", { operation: "list" });
  assert.notEqual(own.error?.code, "denied", JSON.stringify(own));
  assert.notEqual(own.error?.code, "not_found", JSON.stringify(own));
  // `self` is the calling module's own app (the manifest of a wrapped app names no id); another module's `self` is that module's app, so it reaches nothing of docuseal's
  const self = await d.registry.call("connectors.operation.run", { connection: "self", operation: "list" }, "module:docuseal");
  assert.notEqual(self.error?.code, "denied", JSON.stringify(self)); assert.notEqual(self.error?.code, "not_found", JSON.stringify(self));
  const other = await d.registry.call("connectors.operation.run", { connection: "self", operation: "list" }, "module:stranger");
  assert.equal(other.error?.code, "not_found", "stranger has no Connection of its own app: self does not become docuseal");
  // only declared operations: not the generic request, not a name it made up
  assert.equal((await run("module:docuseal", { operation: "request", input: { method: "GET", path: "/" } })).error?.code, "not_found");
  assert.equal((await run("module:docuseal", { operation: "nope" })).error?.code, "not_found");
  // a model never runs one, and nor does a hook or an anonymous caller
  for (const c of ["mcp", "mcp:agent:kit", "harness", "hook", "anonymous"]) assert.ok((await run(c, { operation: "list" })).error, c);
  // a person's surface reaches any Connection and any operation it declares
  const person = await cli("connectors.operation.run", { connection: "docuseal", operation: "list" });
  assert.notEqual(person.error?.code, "denied", JSON.stringify(person));
  assert.equal((await cli("connectors.operation.run", { connection: "nobody", operation: "list" })).error?.code, "not_found");

  // the Capsule runs the app module's view as that module, and the stranger's identical view is refused
  const view = async module => { const r = await d.registry.call("capsule.view", { module, command: "waiting" }, "capsule"); return r.data || { kind: "error", code: r.error && r.error.code, message: r.error && r.error.message }; };
  const mine = await view("docuseal");
  assert.notEqual(mine.code, "denied", JSON.stringify(mine));
  const theirs = await view("stranger");
  assert.equal(theirs.kind, "error", JSON.stringify(theirs));
  assert.equal(theirs.code, "denied", JSON.stringify(theirs));
});
