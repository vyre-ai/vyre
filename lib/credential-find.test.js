// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findSecrets } from "./credential-shapes.js";

// Built at run time so this file never holds a string a scanner would flag as a real key.
const fake = (a, b) => a + b;

test("credential-shapes (find): finds vendor key shapes by kind and line, never echoing the value", () => {
  const text = [
    "# Intake report",
    fake("aws: AKIA", "ABCDEFGHIJKLMNOP"),
    "nothing here",
    fake("-----BEGIN OPENSSH PRIVATE", " KEY-----"),
    fake("token ghp_", "a".repeat(36)),
  ].join("\n");
  const found = findSecrets(text);
  assert.deepEqual(found, [
    { kind: "AWS access key", line: 2 },
    { kind: "private key", line: 4 },
    { kind: "GitHub token", line: 5 },
  ]);
  assert.ok(!JSON.stringify(found).includes("AKIA"), "the match itself is never returned");
});

test("credential-shapes (find): ordinary prose, numbers and look-alikes are not secrets", () => {
  const text = "Northwind Bakery sold 46 loaves. sk-short is not a key. password: see the vault. AKIA lowercase akiaabcdefghijklmnop.";
  assert.deepEqual(findSecrets(text), []);
  assert.deepEqual(findSecrets(""), []);
});
