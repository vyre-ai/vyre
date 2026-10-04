// @ts-check
// UX-33: the phone app adds a secret and unlocks from the app itself. A paired phone calls as `mobile`; the presence floor (Face ID on the phone) proves the person; vault.state tells the app
// whether to show the empty state, the locked state or the list. Models, guests and agents still cannot. Every value is a sample.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present, absent } from "../../test/helpers.js";

async function daemon(/** @type {any} */ t, /** @type {any} */ vault = { keystore: "file" }, /** @type {any} */ presence = present) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault }));
  const d = await start({ root, presence, log: () => {} });
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

test("the personal vault from the phone: password plus presence unlocks it; a wrong password, a model, a module, a guest and a call with no presence do not", async t => {
  const reg = await daemon(t);
  const pw = "a long sample password for the phone test";
  assert.ok((await reg("vault.account.create", { password: pw }, "cli")).data, "account made at the desk");
  await reg("vault.account.lock", {}, "cli");
  assert.equal((await reg("vault.list", {}, "cli")).data.personal, "locked");
  const wrong = await reg("vault.account.unlock-phone", { password: "not the password at all" }, "mobile");
  assert.equal(wrong.error && wrong.error.code, "wrong_password", "a wrong password is refused with its own code");
  assert.equal((await reg("vault.list", {}, "cli")).data.personal, "locked", "and nothing opened");
  for (const [who, caller, meta] of /** @type {[string, string, any][]} */ ([["a model", "mcp", {}], ["a named agent", "mcp:agent:juno", { agent: "juno" }], ["a module", "module:probe", {}], ["a guest", "tailnet-guest:x@y.test", {}], ["a hook", "hook", {}]])) {
    assert.ok((await reg("vault.account.unlock-phone", { password: pw }, caller, meta)).error, `${who} is refused`);
  }
  assert.equal((await reg("vault.list", {}, "cli")).data.personal, "locked", "no refused caller opened it");
  assert.ok((await reg("vault.account.unlock-phone", { password: pw }, "mobile")).data, "the right password with presence unlocks it");
  assert.equal((await reg("vault.list", {}, "cli")).data.personal, "unlocked");
});

test("the personal vault from the phone with no presence (a browser session, a device key with nobody there): presence_required, still locked", async t => {
  const home = await daemon(t);
  const pw = "a long sample password for the phone test";
  await home("vault.account.create", { password: pw }, "cli");
  await home("vault.account.lock", {}, "cli");
  // the same daemon cannot be restarted with another verifier here, so ask a daemon whose verifier finds nobody: it has no account, but the refusal comes before the tool runs
  const none = await daemon(t, { keystore: "file" }, absent);
  const r = await none("vault.account.unlock-phone", { password: pw }, "mobile");
  assert.equal(r.error && r.error.code, "presence_required");
});

test("the personal vault from the phone: five wrong passwords lock further tries out with code throttled and a retry_after_s the app can name; a right password is refused too while locked out", async t => {
  const reg = await daemon(t);
  const pw = "a long sample password for the phone test";
  await reg("vault.account.create", { password: pw }, "cli"); await reg("vault.account.lock", {}, "cli");
  for (let n = 1; n <= 5; n++) assert.equal((await reg("vault.account.unlock-phone", { password: `wrong ${n}` }, "mobile")).error.code, "wrong_password", `try ${n}`);
  const locked = await reg("vault.account.unlock-phone", { password: pw }, "mobile");
  assert.equal(locked.error.code, "throttled");
  assert.ok(locked.error.detail && locked.error.detail.retry_after_s > 0 && locked.error.detail.retry_after_s <= 30, JSON.stringify(locked.error));
  assert.equal((await reg("vault.list", {}, "cli")).data.personal, "locked");
});
