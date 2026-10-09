// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { secureSecrets, partsOf, nameFor, itemLabel } from "./secure-paste.js";
import { keyInText, refuseKey } from "../../../../lib/secure-paste.js";

// Built at run time so this file holds no string a scanner reads as a real key.
const anthropic = "sk-" + "ant-" + "a1B2".repeat(8);
const github = "gh" + "p_" + "Ab1".repeat(14);
const pem = "-----BEGIN OPENSSH PRIVATE" + " KEY-----\nabcDEF123\n-----END OPENSSH PRIVATE" + " KEY-----";

/** A fake Vault: what `put` was given, and which names exist. */
const fakeVault = (names = []) => {
  /** @type {any[]} */ const puts = [];
  return { puts, io: { list: async () => names, put: async (/** @type {any} */ i) => { puts.push(i); } } };
};

test("a message with no key passes through and touches nothing", async () => {
  const v = fakeVault();
  assert.deepEqual(await secureSecrets("hello, deploy the site", v.io), { text: "hello, deploy the site", secured: [] });
  assert.equal(v.puts.length, 0);
});

test("a pasted key is saved to the Vault and the text that goes on holds only a reference", async () => {
  const v = fakeVault();
  const r = await secureSecrets(`use this for the deploy: ${anthropic} thanks`, v.io);
  assert.ok(!("error" in r));
  assert.equal(r.text, "use this for the deploy: vault://anthropic-key thanks");
  assert.ok(!r.text.includes(anthropic), "the transcript never holds the value");
  assert.equal(v.puts.length, 1);
  assert.equal(v.puts[0].fields.value, anthropic);
  assert.equal(v.puts[0].name, "anthropic-key");
  assert.deepEqual(r.secured, [{ name: "anthropic-key", label: "Anthropic key" }]);
});

test("NAME=value, two different keys, and a private key block are each caught", async () => {
  const v = fakeVault();
  const r = await secureSecrets(`ANTHROPIC_API_KEY=${anthropic}\nand ${github}\n${pem}`, v.io);
  assert.ok(!("error" in r));
  for (const secret of [anthropic, github, "abcDEF123"]) assert.ok(!r.text.includes(secret), "no value left in the text");
  assert.equal(v.puts.length, 3);
  assert.match(r.text, /^ANTHROPIC_API_KEY=vault:\/\/anthropic-key\nand vault:\/\/github-token\nvault:\/\/private-key$/);
});

test("the same key pasted twice is one item; a taken name is never replaced", async () => {
  const v = fakeVault(["Anthropic-Key"]);
  const r = await secureSecrets(`${anthropic} and again ${anthropic}`, v.io);
  assert.ok(!("error" in r));
  assert.equal(v.puts.length, 1);
  assert.equal(v.puts[0].name, "anthropic-key-2");
  assert.equal(r.text, "vault://anthropic-key-2 and again vault://anthropic-key-2");
  assert.equal(nameFor({ label: "GitHub token" }, new Set()), "github-token");
});

test("when the Vault does not take the key, nothing is sent and the words say why", async () => {
  const io = { list: async () => [], put: async () => { throw Object.assign(new Error("raw box text"), { code: "locked" }); } };
  const r = await secureSecrets(`key ${anthropic}`, io);
  assert.ok("error" in r);
  assert.match(r.error, /Vault is locked, so nothing was sent/);
  assert.ok(!r.error.includes("raw box text") && !r.error.includes(anthropic));
});

test("ordinary ids, hashes and prose are left alone", async () => {
  const v = fakeVault();
  const text = "commit 9fceb02d0ae598e95dc970b74767f19372d61af8 and the order id ord_12345678901234567890 are fine";
  assert.equal((await secureSecrets(text, v.io)).text, text);
  assert.equal(v.puts.length, 0);
});

test("partsOf splits a message at its Vault references", () => {
  assert.deepEqual(partsOf("use vault://anthropic-key now"), [{ text: "use " }, { vault: "anthropic-key" }, { text: " now" }]);
  assert.deepEqual(partsOf("plain"), [{ text: "plain" }]);
});

test("the server's check: a key is refused with the kind named and never the value; a vault reference and prose pass", () => {
  const r = keyInText(`my key ${anthropic}`);
  assert.equal(r?.code, "secret_in_message");
  assert.deepEqual(r?.detail.found, [{ label: "Anthropic key" }]);
  assert.ok(!JSON.stringify(r).includes(anthropic));
  assert.equal(keyInText("use vault://anthropic-key for the deploy"), null);
  assert.equal(keyInText(""), null);
  assert.equal(keyInText(undefined), null);
  assert.throws(() => refuseKey(pem), (e) => /** @type {any} */ (e).code === "secret_in_message");
});

test("a chip names the item as a person would say it", () => {
  assert.equal(itemLabel("anthropic-key"), "Anthropic key");
  assert.equal(itemLabel("github-token-2"), "GitHub token 2");
  assert.equal(itemLabel("openai-key"), "OpenAI key");
  assert.equal(itemLabel("private-key"), "Private key");
  assert.equal(itemLabel("my.db_url"), "My db url");
});
