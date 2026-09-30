// @ts-check
// keyfind tests: which values a page shows count as an API key. Table driven: a true positive per
// provider, and the false positives the design names (a UUID, a git sha, a base64 image, a
// placeholder). Every fake key is built at run time from a seeded generator, so no key-shaped
// literal sits in the source and none is a real credential. Parity with core/vault/detect.js is
// checked for every shape, so the page and the box agree on what a key is.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { classify } from "../../core/vault/detect.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const HEX = "0123456789abcdef";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const DIGITS = "0123456789";
let seed = 0x4b657946; // "KeyF"
/** @param {number} n @param {string} [alphabet] */
function fake(n, alphabet = ALNUM) {
  let s = "";
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    s += alphabet[(seed >>> 8) % alphabet.length];
  }
  return s;
}
/** Pieces joined at run time. @param {...string} parts */
const join = (...parts) => parts.join("");

const K = (() => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(HERE, "keyfind.js"), "utf8"), ctx);
  return /** @type {any} */ (vm.runInContext("globalThis.vyreKeyFind", ctx));
})();
const plain = x => JSON.parse(JSON.stringify(x));

/** [provider, value] per shape in the table. */
const POSITIVES = /** @type {Array<[string, string]>} */ ([
  ["anthropic", join("sk-", "ant-api03-", fake(48))],
  ["openrouter", join("sk-", "or-v1-", fake(48))],
  ["openai", join("sk-", "proj-", fake(48))],
  ["openai", join("sk-", fake(52))],
  ["stripe", join("sk", "_live_", fake(28))],
  ["stripe", join("rk", "_test_", fake(28))],
  ["stripe", join("whsec", "_", fake(32))],
  ["github", join("ghp", "_", fake(36))],
  ["github", join("github", "_pat_", fake(60))],
  ["github", join("gho", "_", fake(36))],
  ["gitlab", join("glpat", "-", fake(24))],
  ["slack", join("xox", "b-", fake(12, DIGITS), "-", fake(24))],
  ["slack", join("xapp", "-1-", fake(30))],
  ["aws", join("AK", "IA", fake(16, UPPER))],
  ["google", join("AI", "za", fake(35))],
  ["sendgrid", join("SG", ".", fake(22), ".", fake(43))],
  ["resend", join("re", "_", fake(28))],
  ["mailgun", join("key", "-", fake(32, HEX))],
  ["twilio", join("SK", fake(32, HEX))],
  ["npm", join("npm", "_", fake(36))],
  ["huggingface", join("hf", "_", fake(34))],
  ["digitalocean", join("dop", "_v1_", fake(64, HEX))],
  ["perplexity", join("pplx", "-", fake(48))],
  ["linear", join("lin", "_api_", fake(40))],
  ["sentry", join("sntrys", "_", fake(56))],
  ["pinecone", join("pcsk", "_", fake(30))],
  ["jina", join("jina", "_", fake(40))],
  ["apify", join("apify", "_api_", fake(32))],
  ["supabase", join("sb", "_secret_", fake(30))],
]);

test("a provider prefix is enough on its own, with the provider named, and detect.js agrees", () => {
  for (const [provider, value] of POSITIVES) {
    const c = plain(K.candidate({ value }));
    assert.ok(c, `${provider}: not recognised`);
    assert.equal(c.provider, provider);
    assert.equal(c.generic, false);
    assert.equal(c.value, value);
    const seen = classify("", value);
    assert.equal(seen.secret, true, `${provider}: detect.js does not call it a secret`);
    assert.equal(seen.provider, provider, `${provider}: detect.js names another provider`);
  }
  assert.equal(plain(K.shape(join("sk", "_live_", fake(28)))).mode, "live");
  assert.equal(plain(K.shape(join("sk", "_test_", fake(28)))).mode, "test");
});

test("surrounding spaces do not matter, and a value is never changed", () => {
  const v = join("ghp", "_", fake(36));
  assert.equal(K.candidate({ value: `  ${v}\n` }).value, v);
});

/** @type {Array<[string, string]>} */
const NEGATIVES = [
  ["a UUID", crypto.randomUUID()],
  ["an upper case UUID", crypto.randomUUID().toUpperCase()],
  ["a git sha", fake(40, HEX)],
  ["a sha-256", fake(64, HEX)],
  ["an md5", fake(32, HEX)],
  ["a base64 png", join("iVBORw0KGgo", fake(120))],
  ["a base64 jpeg", join("/9j/", fake(120))],
  ["a data uri", join("data:image/png;base64,", fake(80))],
  ["a masked openai key", "sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
  ["a masked anthropic key", join("sk-", "ant-", "x".repeat(40))],
  ["a masked github key", join("ghp", "_", "x".repeat(36))],
  ["a bullet mask", join("sk-", "•".repeat(30))],
  ["a starred key", join("sk-", "*".repeat(30))],
  ["YOUR_API_KEY", "YOUR_API_KEY"],
  ["a long YOUR_API_KEY", "YOUR_API_KEY_HERE_0123456789"],
  ["the aws docs key", join("AKIA", "IOSFODNN7EXAMPLE")],
  ["an angle placeholder", "<paste-your-api-key-here-now>"],
  ["a template", "{{ api_key }}{{ api_key }}"],
  ["a repeated character", join("ghp", "_", "a".repeat(36))],
  ["a short word", "secret"],
  ["prose", "the quick brown fox jumps over the lazy dog"],
  ["a url", "https://console.example.com/settings/keys?page=2"],
  ["an email", "alex@harlowlegal.example"],
  ["a plain long word", "internationalizationlocalization"],
];

test("a UUID, a hash, an image, a placeholder or prose never counts, even under a key label", () => {
  for (const [what, value] of NEGATIVES) {
    assert.equal(K.candidate({ value }), null, `${what}: no label`);
    assert.equal(K.candidate({ value, label: "Your API key" }), null, `${what}: labelled`);
    assert.equal(K.candidate({ value, label: "Secret key" }), null, `${what}: labelled secret`);
  }
});

test("a generic string counts only under a key, token or secret label", () => {
  const v = fake(44);
  assert.equal(K.candidate({ value: v }), null, "no label");
  assert.equal(K.candidate({ value: v, label: "Order number" }), null, "some other label");
  for (const [label, name] of [["API key", "api key"], ["Your new API Key", "api key"], ["Secret key", "secret key"], ["Access token", "access token"],
    ["Client secret", "client secret"], ["Token", "token"], ["api_key", "api key"], ["Auth token (shown once)", "auth token"]]) {
    const c = plain(K.candidate({ value: v, label }));
    assert.ok(c, label);
    assert.deepEqual([c.provider, c.generic, c.label], [null, true, name], label);
  }
  // Labels that name something else, however "key" or "token" they sound.
  for (const label of ["Publishable key", "Public key", "Site key", "reCAPTCHA secret key", "Password", "License key", "SSH key fingerprint", "CSRF token", "Invite token"]) {
    assert.equal(K.candidate({ value: v, label }), null, label);
  }
  // A short or plain value fails the shape check whatever the label.
  assert.equal(K.candidate({ value: fake(12), label: "API key" }), null, "too short");
  assert.equal(K.candidate({ value: "a".repeat(30) + "b", label: "API key" }), null, "no entropy");
  assert.equal(K.candidate({ value: `${fake(20)} ${fake(20)}`, label: "API key" }), null, "has a space");
  assert.equal(K.candidate({ value: fake(400), label: "API key" }), null, "too long");
});

test("a value in a password input is login save's, never a key", () => {
  for (const [, value] of POSITIVES.slice(0, 5)) assert.equal(K.candidate({ value, kind: "password" }), null);
  assert.equal(K.candidate({ value: fake(44), label: "API key", kind: "password" }), null);
  assert.equal(K.candidate({ value: "", label: "API key" }), null);
  assert.equal(K.candidate({ value: undefined, label: "API key" }), null);
});

test("the fingerprint is stable, short and not the value", () => {
  const v = join("ghp", "_", fake(36));
  const f = K.fingerprint(v);
  assert.equal(f, K.fingerprint(v));
  assert.notEqual(f, K.fingerprint(v + "a"));
  assert.match(f, /^[a-z0-9]{1,16}$/);
  assert.ok(!v.includes(f) && !f.includes(v.slice(0, 8)));
});
