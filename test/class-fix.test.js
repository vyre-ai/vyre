// @ts-check
// Tests and CI rule 15 (owner ruling of 16 Oct 2026): fix the class, everywhere. One shared
// implementation, and the test reads the set from its owner. Secret field names live in
// lib/secret-keys.js. This walks that table, not a hand-written list of names.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findInSource } from "./source-files.js";
import { SECRET_KEYS, egressNameIsSecret, jsonHasSecretField, keyIsSecret, nameIsSecret } from "../lib/secret-keys.js";
import { showable } from "../kernel/flows/runner.js";
import { secretName, value as redactValue } from "../lib/siteops/redact.js";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLANTED = "VYRE-CLASS-SECRET-7f3c1a";

test("Tests and CI rule 15 is recorded, and the secret-egress test reads the tool set from the registry", () => {
  const rules = fs.readFileSync(path.join(ROOT, "DEVELOPMENT-RULES.md"), "utf8");
  assert.match(rules, /Fix the class, everywhere/);
  assert.match(rules, /16 Oct 2026/);
  assert.match(rules, /test\/class-fix\.test\.js/);
  const egress = fs.readFileSync(path.join(ROOT, "test/mcp-secret-egress.test.js"), "utf8");
  assert.match(egress, /for \(const name of d\.registry\.tools\.keys\(\)\)/, "the sweep must walk the registry, not a hand-written tool list");
});

test("secret field names are defined once, in lib/secret-keys.js", () => {
  const allowed = new Map([
    ["lib/secret-keys.js", "the one list"],
    ["apps/app/src/store-core/secret-keys.js", "generated for the phone app, which cannot import lib/"],
    ["local/hands-chrome-mac/extension/shared/sk/secret-keys.js", "generated for the extension, which cannot import lib/"],
  ]);
  const copies = [
    /SECRET_KEY\s*=\s*\//,
    /CREDENTIAL_WORD\s*=/,
    /const KEY = \/\(/,
    /api\[_-]\?key\|authorization\|cookie\|private/,
    /pass\(word\|wd\|phrase\)\?/,
  ];
  assert.deepEqual(findInSource(copies, allowed), [], "Tests and CI rule 15: a second secret-name list. Add the name to lib/secret-keys.js");
  const own = [/function nameIsSecret\b/];
  assert.deepEqual(findInSource(own, allowed), [], "nameIsSecret is lib/secret-keys.js");
  for (const rel of ["kernel/flows/runner.js", "apps/app/screens/flows/run-model.ts", "lib/siteops/redact.js", "lib/siteops/learn.js", "kernel/bus.js"]) {
    assert.match(fs.readFileSync(path.join(ROOT, rel), "utf8"), /secret-keys\.js/, `${rel} reads the shared list`);
  }
});

test("every name in the secret-key table is hidden on a timeline and in a browser body", async () => {
  const shownValue = strip ? (await import("../apps/app/screens/flows/run-model.ts")).shownValue : null;
  assert.ok(SECRET_KEYS.length > 10, "the table is the set under test");
  for (const row of SECRET_KEYS) {
    assert.equal(nameIsSecret(row.key), true, row.key);
    assert.equal(secretName(row.key), true, row.key);
    assert.equal(keyIsSecret(row.key), row.egress, row.key);
    assert.equal(egressNameIsSecret(row.key), row.egress, row.key);
    const body = redactValue({ [row.key]: PLANTED });
    assert.equal(JSON.stringify(body).includes(PLANTED), false, `browser ${row.key}`);
    assert.equal(JSON.stringify(showable({ [row.key]: PLANTED })).includes(PLANTED), false, `timeline ${row.key}`);
    if (shownValue) assert.equal(String(shownValue(PLANTED, row.key)).includes(PLANTED), false, `phone ${row.key}`);
  }
  assert.equal(nameIsSecret("user_password"), true);
  assert.equal(egressNameIsSecret("user_password"), true);
  assert.equal(nameIsSecret("recoveryWrap"), true);
  assert.equal(egressNameIsSecret("mySecret"), true);
  assert.equal(nameIsSecret("secretary"), false);
  assert.equal(nameIsSecret("author"), false);
  assert.equal(nameIsSecret("tokenizer"), false);
  assert.equal(egressNameIsSecret("session"), false, "a chat session id is not stripped from a tool result");
  assert.equal(nameIsSecret("session"), true, "a browser storage key named session is still hidden");
  assert.equal(jsonHasSecretField(JSON.stringify({ password: PLANTED })), true);
  assert.equal(jsonHasSecretField(JSON.stringify({ recoveryWrap: PLANTED })), true);
  assert.equal(jsonHasSecretField(JSON.stringify({ session: PLANTED })), false);
  assert.equal(jsonHasSecretField(JSON.stringify({ name: "alex" })), false);
});
