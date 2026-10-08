// @ts-check
// Connections inside a real vyred, in a temp home with the real vault and Gate: a person connects an app from a key already in the Vault, a model cannot, the derived credential is an
// api-credential bound to the one host, and the check answers in plain words (the host here never resolves, so nothing leaves the machine).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";

const FORM = { label: "Acme CRM", base_url: "https://api.acme-crm.invalid", send: { how: "bearer" }, credential: { item: "acme-key" }, headers: { Version: "2021-07-28" }, vars: { loc: "l_1" }, check: { path: "/locations/{loc}" } };

test("connections: a person connects an app from a Vault key, a model cannot, and the check speaks plainly", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const cli = (tool, input = {}) => call(tool, input, { root, caller: "cli" });
  const model = (tool, input = {}) => d.registry.call(tool, input, "mcp", { thread: "t-1" });

  assert.equal(d.registry.status().find(m => m.name === "connectors")?.state, "running");
  assert.equal((await cli("connectors.connection.create", FORM)).error?.code, "not_found", "the key must already be in the Vault");
  const KEY = "acme-secret-value-123456";
  assert.ok(!(await cli("vault.put", { name: "acme-key", kind: "secret", value: KEY })).error);

  assert.equal((await model("connectors.connection.create", FORM)).error?.code, "denied", "a model never connects an app");
  const made = await cli("connectors.connection.create", FORM);
  assert.deepEqual(made.data, { id: "acme-crm", credential: "conn-acme-crm" }, JSON.stringify(made));

  const item = (await cli("vault.list", {})).data.items.find(x => x.name === "conn-acme-crm");
  assert.equal(item.kind, "api-credential");
  assert.deepEqual(item.hosts, []);
  const lr = await model("connectors.connection.list"); assert.ok(lr.data, JSON.stringify(lr)); const listed = lr.data.connections;
  assert.equal(listed.length, 1); assert.equal(listed[0].host, "api.acme-crm.invalid"); assert.equal(listed[0].light, "unknown");
  assert.ok(!JSON.stringify([made, listed, (await model("connectors.connection.get", { id: "acme-crm" }))]).includes(KEY));

  const chk = await model("connectors.connection.check", { id: "acme-crm" });
  assert.equal(chk.data.light, "red", JSON.stringify(chk));
  assert.match(chk.data.words, /does not resolve|could not run|no answer/);
  assert.equal((await model("connectors.connection.list")).data.connections[0].light, "red");

  // an assistant proposes another app; only the person sees the proposals and approves
  const prop = await model("connectors.connection.propose", { ...FORM, label: "Acme Billing", why: "from their docs" });
  assert.ok(prop.data && prop.data.proposal, JSON.stringify(prop));
  assert.equal((await model("connectors.connection.proposals")).error?.code, "denied");
  assert.equal((await model("connectors.connection.approve", { proposal: prop.data.proposal })).error?.code, "denied");
  assert.equal((await model("connectors.connection.decline", { proposal: prop.data.proposal })).error?.code, "denied");
  assert.equal((await model("connectors.connection.list")).data.connections.length, 1, "proposing made nothing");
  const mine = await cli("connectors.connection.proposals");
  assert.equal(mine.data.proposals.length, 1); assert.equal(mine.data.proposals[0].card.title, "Connect Acme Billing?");
  assert.deepEqual((await cli("connectors.connection.approve", { proposal: prop.data.proposal })).data, { id: "acme-billing", credential: "conn-acme-billing" });
  assert.equal((await model("connectors.connection.list")).data.connections.length, 2);
  assert.ok(!JSON.stringify([prop, mine]).includes(KEY));
  assert.ok((await cli("connectors.connection.delete", { id: "acme-billing" })).data);
  // an inbound delivery on this Connection's route is told to its listeners; another route is not
  const heard = () => d.registry.deps.events.since(0, { limit: 5000 }).filter(e => e.type === "connectors.connection-received");
  d.registry.deps.events.emit("hooks", "hook.received", { route: "conn-acme-crm", id: "dlv_1", bytes: 42 });
  d.registry.deps.events.emit("hooks", "hook.received", { route: "conn-nobody", id: "dlv_2", bytes: 1 });
  d.registry.deps.events.emit("hooks", "hook.received", { route: "stripe", id: "dlv_3", bytes: 1 });
  assert.deepEqual(heard().map(e => e.payload), [{ id: "acme-crm", delivery: "dlv_1", bytes: 42 }]);
  const draft = await model("connectors.connection.import", { text: JSON.stringify({ openapi: "3.0.0", servers: [{ url: "https://api.acme-crm.invalid" }], paths: { "/contacts": { get: { operationId: "list" }, post: { operationId: "create" } } } }) });
  assert.deepEqual(draft.data.operations.map(o => [o.name, o.method]), [["list", "GET"], ["create", "POST"]]);
  assert.equal((await model("connectors.connection.import", { text: "nope" })).error?.code, "bad_input");
  assert.equal((await model("connectors.connection.list")).data.connections.length, 1, "a draft saves nothing");
  const tpl = (await model("connectors.connection.export", { id: "acme-crm" })).data;
  assert.equal(tpl.credential.item, ""); assert.ok(!JSON.stringify(tpl).includes(KEY));

  assert.equal((await model("connectors.connection.delete", { id: "acme-crm" })).error?.code, "denied");
  assert.equal((await model("connectors.connection.update", FORM)).error?.code, "denied");
  assert.deepEqual((await cli("connectors.connection.delete", { id: "acme-crm" })).data, { id: "acme-crm", removed: true });
  assert.ok(!(await cli("vault.list", {})).data.items.some(x => x.name === "conn-acme-crm"));
  assert.ok((await cli("vault.list", {})).data.items.some(x => x.name === "acme-key"), "the key's own item stays");
});
