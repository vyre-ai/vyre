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
  assert.equal((await cli("connections.create", FORM)).error?.code, "not_found", "the key must already be in the Vault");
  const KEY = "acme-secret-value-123456";
  assert.ok(!(await cli("vault.put", { name: "acme-key", kind: "secret", value: KEY })).error);

  assert.equal((await model("connections.create", FORM)).error?.code, "denied", "a model never connects an app");
  const made = await cli("connections.create", FORM);
  assert.deepEqual(made.data, { id: "acme-crm", credential: "conn-acme-crm" }, JSON.stringify(made));

  const item = (await cli("vault.list", {})).data.items.find(x => x.name === "conn-acme-crm");
  assert.equal(item.kind, "api-credential");
  assert.deepEqual(item.hosts, []);
  const listed = (await model("connections.list")).data.connections;
  assert.equal(listed.length, 1); assert.equal(listed[0].host, "api.acme-crm.invalid"); assert.equal(listed[0].light, "unknown");
  assert.ok(!JSON.stringify([made, listed, (await model("connections.get", { id: "acme-crm" }))]).includes(KEY));

  const chk = await model("connections.check", { id: "acme-crm" });
  assert.equal(chk.data.light, "red", JSON.stringify(chk));
  assert.match(chk.data.words, /does not resolve|could not run|no answer/);
  assert.equal((await model("connections.list")).data.connections[0].light, "red");

  assert.equal((await model("connections.delete", { id: "acme-crm" })).error?.code, "denied");
  assert.equal((await model("connections.update", FORM)).error?.code, "denied");
  assert.deepEqual((await cli("connections.delete", { id: "acme-crm" })).data, { id: "acme-crm", removed: true });
  assert.ok(!(await cli("vault.list", {})).data.items.some(x => x.name === "conn-acme-crm"));
  assert.ok((await cli("vault.list", {})).data.items.some(x => x.name === "acme-key"), "the key's own item stays");
});
