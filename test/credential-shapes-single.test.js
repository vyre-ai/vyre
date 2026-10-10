// @ts-check
// "What a vendor credential looks like" is written once, in lib/credential-shapes.js (consolidation inventory item 3, R031-00c). A new vendor key is one row there. This test fails when a source
// file outside a short, reasoned list writes a vendor prefix (sk-ant-, ghp_, AKIA, xox, dop_v1_ ...) into code of its own, and checks that every consumer sees the shapes the table holds.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { SHAPES, classify, credentialIn, finders, findSecrets, redact as redactShapes } from "../lib/credential-shapes.js";
import { redact, scan } from "../lib/sanitize.js";
import { secretIn } from "../core/memory/write.js";
import { scanText } from "../core/sync/scrub.js";
import { findInSource } from "./source-files.js";
import { text as extensionRedact } from "../local/hands-chrome-mac/extension/shared/sk/siteops/redact.js";
import { startsLikeCredential, mentionsCredentialPrefix, credentialAtTokenStart } from "../lib/credential-shapes.js";

/** Where a vendor prefix is still written by hand, and why. Each is a decision, not an oversight; the other runtimes are held to the table by the parity checks below. */
const ALLOWED = new Map([
  ["lib/credential-shapes.js", "the one table"],
  ["local/hands-chrome-mac/extension/shared/sk/", "generated from lib/credential-shapes.js (scripts/sync-copies.mjs, test/generated-copies.test.js)"],
  ["apps/app/src/store-core/credential-shapes.js", "generated from lib/credential-shapes.js for the phone app (scripts/sync-copies.mjs, test/generated-copies.test.js)"],
  ["core/onboard/index.js", "names Anthropic's two sign-in token KINDS (setup token and API key) for the picker; the table has one Anthropic row and does not distinguish them"],
  ["modules/vault-extension/keyfind.js", "runs in a web page and cannot import lib/; keyfind.test.js holds every row to classify()"],
  ["modules/vault-extension/testing/", "browser checks that mint fake keys"],
  ["lib/siteops/redact.js", "the source of the extension's redaction (copied to extension/shared/sk/siteops/ by scripts/sync-copies.mjs); the parity check below holds it to the table"],
  ["apps/app/screens/connections/model.ts", "runs in the phone app (no Buffer, TypeScript); redacts a connection's error text"],
  ["apps/app/screens/vault/data.ts", "mock data for screenshots"],
  ["web/onboard/onboard.js", "a placeholder in an input box"],
  ["core/runner/testing/", "test support: fake secrets"],
  ["lib/connectors/testing/", "test support: fake secrets"],
  ["lib/publish/test-kit.js", "test support: fake secrets"],
  ["records/testing/", "test support: fake secrets"],
  ["stores/twenty/live/", "live test scripts: sample secrets"],
]);
const PATTERNS = [/sk-ant-|\bghp_|\bAKIA|xox\[|\bxox[abprs]-|dop_v1_|\b[sr]k_live_|github_pat_|\bAIza|"SG\.|\bnpm_\[|\bglpat-|\bwhsec_|ya29\./];

test("no other source file writes a vendor credential prefix of its own", () => {
  assert.deepEqual(findInSource(PATTERNS, ALLOWED), [], "add the shape as a row in lib/credential-shapes.js and call finders(), credentialIn() or classify()");
});

// Strings built at run time, so no literal sits in this file for a scanner to report.
const fake = {
  anthropic: "sk-" + "ant-" + "a".repeat(24),
  github: "gh" + "p_" + "A1".repeat(20),
  slack: "xo" + "xb-" + "1234567890-abcdefghij",
  aws: "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  stripe: "sk_" + "live_" + "a1B2".repeat(6),
  google: "AI" + "za" + "A".repeat(35),
  npm: "np" + "m_" + "a1".repeat(18),
};

test("every consumer sees a key the table knows", () => {
  for (const [vendor, key] of Object.entries(fake)) {
    const where = `${vendor}: ${key.slice(0, 6)}...`;
    assert.equal(classify("X", key).secret, true, `classify: ${where}`);
    assert.notEqual(redact(`token ${key} here`).text, `token ${key} here`, `sanitize.redact: ${where}`);
    assert.ok(scan(`token ${key} here`).length > 0, `sanitize.scan: ${where}`);
    assert.ok(findSecrets(`a\n${key}\nb`).length > 0, `findSecrets (share): ${where}`);
    assert.equal(scanText(key).safe, false, `sync scanText: ${where}`);
    assert.ok(redactShapes(`has ${key} inside`).includes(key) === false, `shapes redact: ${where}`);
  }
  for (const k of ["anthropic", "github", "slack", "aws", "stripe", "google", "npm"]) assert.ok(secretIn(`see ${fake[k]}`), `memory write refuses ${k}`);
});

test("the table and its consumers agree on what is listed", () => {
  const ids = SHAPES.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, "row ids are unique");
  for (const s of SHAPES) assert.ok(s.value || s.find, `${s.id} has no shape`);
  for (const use of /** @type {const} */ (["share", "ingest", "memory", "push"])) {
    for (const f of finders(use)) assert.ok(!f.re.global, `${use}/${f.name}: matchers are stateless`);
  }
  assert.equal(credentialIn("nothing to see: plain words, an id 12345 and a hash deadbeef", "ingest"), null);
});

test("the extension's own redactor removes every vendor key the table knows", () => {
  for (const [vendor, key] of Object.entries(fake)) assert.ok(!extensionRedact(`see ${key} here`).includes(key), `extension redact: ${vendor}`);
});

test("the prefix checks (hub, sweep, about, waiting, the event bus) see the table's vendor prefixes", () => {
  for (const [vendor, key] of Object.entries(fake)) {
    assert.equal(startsLikeCredential(key), true, `startsLikeCredential: ${vendor}`);
    assert.equal(mentionsCredentialPrefix(`a title ${key.slice(0, 12)}`), true, `mentionsCredentialPrefix: ${vendor}`);
    assert.equal(credentialAtTokenStart(`{"x":"${key}"}`), true, `credentialAtTokenStart: ${vendor}`);
  }
  assert.equal(credentialAtTokenStart("task-" + "a".repeat(30)), false, "a prefix inside a longer word is not a key (FL-1)");
  assert.equal(startsLikeCredential("a sentence about keys"), false);
  assert.equal(mentionsCredentialPrefix("Bearer is just a word here"), false);
});
