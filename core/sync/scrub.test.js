// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanText } from "./scrub.js";

// Built at run time, never as a literal, so the shape a real secret takes never sits in this
// file's own source (test/hygiene.test.js scans shipped code for exactly these shapes).
const fake = (prefix, len = 30) => prefix + "a".repeat(len);

test("scrub: safe text has no found patterns", () => {
  assert.deepEqual(scanText("just an ordinary chat about the weather"), { safe: true, found: [] });
});

test("scrub: known secret shapes are found by label, never by the matched text", () => {
  const cases = [
    [fake("sk-ant-api03-", 44), "anthropic key"],
    [fake("sk-", 24), "openai key"],
    [fake("ghp_", 36), "github token"],
    [fake("xoxb-1234567890-", 16), "slack token"],
    ["AKIA" + "A".repeat(16), "aws access key"],
    ["AIza" + "A".repeat(35), "google api key"],
    ["-----BEGIN " + "RSA PRIVATE KEY".toUpperCase() + "-----\nabc\n-----END RSA PRIVATE KEY-----", "private key"],
    [fake("sk_live_", 22), "stripe key"],
  ];
  for (const [text, label] of cases) {
    const r = scanText(`some words before ${text} and after`);
    assert.equal(r.safe, false, label);
    assert.deepEqual(r.found, [label]);
  }
});

test("scrub: stops at maxFound and never reports more than a handful of labels", () => {
  const text = [fake("sk-ant-api03-", 44), fake("ghp_", 36), "AKIA" + "A".repeat(16)].join(" ");
  const r = scanText(text, { maxFound: 2 });
  assert.equal(r.safe, false);
  assert.equal(r.found.length, 2);
});

test("scrub: only reads the first maxBytes, so a huge file cannot make ingest slow", () => {
  const secret = fake("sk-ant-api03-", 44);
  const padded = "x".repeat(1000) + " " + secret;
  assert.deepEqual(scanText(padded, { maxBytes: 500 }), { safe: true, found: [] }, "the secret sits past the read window");
  assert.equal(scanText(padded, { maxBytes: 2000 }).safe, false, "within the window it is found");
});
