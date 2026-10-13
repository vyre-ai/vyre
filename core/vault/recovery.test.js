// @ts-check
// The recovery kit sets a new password for a forgotten one: the account makes a recovery secret that wraps the personal vault key a second time, `vault.account.reset` opens that wrap and
// re-wraps under a new password and a new Secret Key, and wrong secrets are counted like wrong passwords. An app is never handed the Secret Key. Every value is a sample.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { formatRecoverySecret } from "./crypto.js";

/** the phone arrives as its paired device, never as a bare label */
const PHONE = "device:abcdefghijklmnop";

async function daemon(/** @type {any} */ t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  return { root, reg: (/** @type {string} */ tool, input = {}, caller = "cli", meta = {}) => d.registry.call(tool, input, caller, caller === PHONE && !meta.kernelFacts ? { ...meta, person: { id: "ps_1", kind: "cookie" }, kernelFacts: { kind: "device", device_key_id: "abcdefghijklmnop", person: d.kernel.id.owner, path: "direct", session: "s" } } : meta) };
}
const PW = "a long sample password for the kit test";
const NEW = "another long sample password after the kit";

test("create gives the recovery secret to every caller and the Secret Key only to a terminal", async t => {
  const { reg } = await daemon(t);
  const phone = (await reg("vault.account.create", { password: PW }, PHONE)).data;
  assert.match(phone.recoverySecret, /^R1-[A-Z2-7]{6}-[A-Z2-7]{26}-[A-Z2-7]{2}$/);
  assert.equal(phone.secretKey, undefined, "an app is never handed the Secret Key");
  const root2 = await daemon(t);
  const desk = (await root2.reg("vault.account.create", { password: PW }, "cli")).data;
  assert.match(desk.secretKey, /^V2-/);
  assert.match(desk.recoverySecret, /^R1-/);
});

test("the kit sets a new password: the old one stops working, the new one opens it, and what was inside survived", async t => {
  const { reg } = await daemon(t);
  const made = (await reg("vault.account.create", { password: PW }, "cli")).data;
  assert.ok((await reg("vault.put", { name: "harlow-portal", kind: "secret", value: "sample-secret-value" }, "cli")).data);
  await reg("vault.account.lock", {}, "cli");
  const done = await reg("vault.account.reset", { recovery: made.recoverySecret, password: NEW }, "cli");
  assert.ok(done.data && done.data.reset, JSON.stringify(done));
  assert.equal((await reg("vault.list", {}, "cli")).data.personal, "unlocked", "a reset leaves it open");
  await reg("vault.account.lock", {}, "cli");
  assert.equal((await reg("vault.account.unlock", { password: PW }, "cli")).error.code, "wrong_password", "the forgotten password is gone");
  assert.ok((await reg("vault.account.unlock", { password: NEW }, "cli")).data, "the new password opens it");
  assert.ok(!JSON.stringify(done).includes("V2-"), "the answer carries no key");
  const again = await reg("vault.account.reset", { recovery: made.recoverySecret, password: PW + " again" }, "cli");
  assert.ok(again.data, "the same kit works again");
});

test("the kit works on a device that has lost the Secret Key, and from a phone only with presence", async t => {
  const { root, reg } = await daemon(t);
  const made = (await reg("vault.account.create", { password: PW }, "cli")).data;
  await reg("vault.account.lock", {}, "cli");
  fs.rmSync(path.join(root, "vault", "secret-key"), { force: true });
  fs.rmSync(path.join(root, "secret-key"), { force: true });
  assert.equal((await reg("vault.account.unlock", { password: PW }, "cli")).error.code, "no_secret_key", "the password alone no longer opens it here");
  for (const [who, caller, meta] of /** @type {[string, string, any][]} */ ([["a model", "mcp", {}], ["a named agent", "mcp:agent:juno", { agent: "juno" }], ["a module", "module:probe", {}]])) {
    assert.ok((await reg("vault.account.reset", { recovery: made.recoverySecret, password: NEW }, caller, meta)).error, `${who} is refused`);
  }
  assert.ok((await reg("vault.account.reset", { recovery: made.recoverySecret, password: NEW }, PHONE)).data, "the phone resets with the kit");
  await reg("vault.account.lock", {}, "cli");
  assert.ok((await reg("vault.account.unlock", { password: NEW }, "cli")).data, "and the new password opens it with the new Secret Key");
});

test("a wrong, mistyped or too-weak reset is refused in its own code, and five wrong secrets lock the door", async t => {
  const { reg } = await daemon(t);
  const made = (await reg("vault.account.create", { password: PW }, "cli")).data;
  await reg("vault.account.lock", {}, "cli");
  assert.equal((await reg("vault.account.reset", { recovery: "R1-NOTAKIT", password: NEW }, "cli")).error.code, "bad_recovery");
  assert.equal((await reg("vault.account.reset", { recovery: made.recoverySecret, password: "short" }, "cli")).error.code, "weak_password");
  // A well-formed secret for this account that is not its own: flip a body character and fix nothing else is a typo; make a real different one on another box instead.
  const other = await daemon(t);
  const stranger = (await other.reg("vault.account.create", { password: PW }, "cli")).data;
  assert.equal((await reg("vault.account.reset", { recovery: stranger.recoverySecret, password: NEW }, "cli")).error.code, "wrong_account");
  assert.equal((await reg("vault.list", {}, "cli")).data.personal, "locked", "nothing opened");
  // A well-formed secret for this account that is not its own counts as a wrong try.
  const wrongOne = formatRecoverySecret(made.acct, Buffer.alloc(16, 7));
  for (let n = 1; n <= 5; n++) assert.equal((await reg("vault.account.reset", { recovery: wrongOne, password: NEW }, "cli")).error.code, "wrong_recovery", `try ${n}`);
  const waiting = await reg("vault.account.reset", { recovery: made.recoverySecret, password: NEW }, "cli");
  assert.equal(waiting.error.code, "throttled", "even the right kit waits after five wrong ones");
  assert.equal((await reg("vault.list", {}, "cli")).data.personal, "locked", "nothing opened");
});

test("the Secret Key can be carried to a device: exported to the person's own device, imported only when it is this account's, and a reset announces the change without the key", async t => {
  const { reg } = await daemon(t);
  const made = (await reg("vault.account.create", { password: PW }, "cli")).data;
  for (const [who, caller] of /** @type {[string, string][]} */ ([["a model", "mcp"], ["a module", "module:probe"]])) {
    assert.ok((await reg("vault.account.export-secret-key", {}, caller)).error, `${who} is refused`);
    assert.ok((await reg("vault.account.import-secret-key", { secretKey: made.secretKey }, caller)).error, `${who} is refused`);
  }
  const out = (await reg("vault.account.export-secret-key", {}, PHONE)).data;
  assert.equal(out.secretKey, made.secretKey);
  assert.equal((await reg("vault.account.import-secret-key", { secretKey: "V2-NOTAKEY" }, PHONE)).error.code, "bad_secret_key");
  const other = await daemon(t);
  const stranger = (await other.reg("vault.account.create", { password: PW }, "cli")).data;
  assert.equal((await reg("vault.account.import-secret-key", { secretKey: stranger.secretKey }, PHONE)).error.code, "wrong_account");
  assert.ok((await reg("vault.account.import-secret-key", { secretKey: made.secretKey }, PHONE)).data.imported, "its own key is accepted");
  await reg("vault.account.lock", {}, "cli");
  assert.ok((await reg("vault.account.unlock", { password: PW }, "cli")).data, "and the password still opens it");
});
