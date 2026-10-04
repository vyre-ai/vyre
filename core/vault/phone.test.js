// @ts-check
// UX-33: the phone app adds a secret and unlocks from the app itself. A paired phone calls as `mobile`; the presence floor (Face ID on the phone) proves the person; vault.state tells the app
// whether to show the empty state, the locked state or the list. Models, guests and agents still cannot. Every value is a sample.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

async function daemon(/** @type {any} */ t, /** @type {any} */ vault = { keystore: "file" }) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  return (/** @type {string} */ tool, input = {}, caller = "cli", meta = {}) => d.registry.call(tool, input, caller, meta);
}

test("the phone adds a login and reads the state; a model, a guest and an agent cannot add", async t => {
  const reg = await daemon(t);
  const empty = (await reg("vault.state", {}, "mobile")).data;
  assert.deepEqual([empty.locked, empty.items], [false, 0]);
  const put = await reg("vault.put", { name: "harlow-portal", kind: "secret", value: "sample-secret-value" }, "mobile");
  assert.ok(put.data, JSON.stringify(put));
  assert.equal((await reg("vault.state", {}, "mobile")).data.items, 1);
  assert.ok(!JSON.stringify((await reg("vault.state", {}, "mobile")).data).includes("sample-secret-value"), "no value in the state");
  for (const [caller, meta] of /** @type {[string, any][]} */ ([["mcp", {}], ["mcp:agent:juno", { agent: "juno" }], ["tailnet-guest:x@y.test", {}], ["hook", {}]])) {
    assert.ok((await reg("vault.put", { name: "x", value: "y" }, caller, meta)).error, `${caller} is refused`);
    assert.ok((await reg("vault.state", {}, caller, meta)).error, `${caller} gets no state`);
  }
});

test("a passphrase vault: the phone sees `locked`, unlocks with the passphrase, and the first unlock sets one", async t => {
  const reg = await daemon(t, { keystore: "passphrase" });
  const before = (await reg("vault.state", {}, "mobile")).data;
  assert.deepEqual([before.locked, before.unlock], [true, "passphrase"]);
  assert.ok((await reg("vault.unlock", { passphrase: "sample passphrase for a test" }, "mobile")).data);
  const after = (await reg("vault.state", {}, "mobile")).data;
  assert.deepEqual([after.locked, after.items], [false, 0]);
  assert.ok((await reg("vault.unlock", { passphrase: "x" }, "mcp")).error, "a model cannot unlock");
});
