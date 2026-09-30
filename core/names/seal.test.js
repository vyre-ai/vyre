// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { seal, open, inspect, isSealed, checkPassphrase, MIN_PASSPHRASE } from "./seal.js";

const CHEAP = { params: { N: 2, r: 1, p: 1 } };

test("seal/open: round-trips arbitrary bytes", () => {
  const bytes = Buffer.from("a fake tar.gz, could be anything", "utf8");
  const sealed = seal(bytes, "correct horse battery staple", CHEAP);
  assert.ok(isSealed(sealed));
  assert.ok(bytes.equals(open(sealed, "correct horse battery staple")));
});

test("seal: refuses a passphrase shorter than the minimum", () => {
  assert.equal(MIN_PASSPHRASE, 12);
  assert.throws(() => checkPassphrase("short"), /at least 12 characters/);
  assert.throws(() => seal(Buffer.from("x"), "short", CHEAP), /at least 12 characters/);
});

test("open: refuses the wrong passphrase", () => {
  const sealed = seal(Buffer.from("secret bytes"), "the right passphrase here", CHEAP);
  assert.throws(() => open(sealed, "the wrong passphrase here!"), /does not open/);
});

test("open: refuses a tampered ciphertext (AEAD tag check)", () => {
  const sealed = seal(Buffer.from("secret bytes"), "the right passphrase here", CHEAP);
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => open(tampered, "the right passphrase here"), /does not open/);
});

test("inspect/isSealed: refuses anything that isn't a sealed backup", () => {
  assert.equal(isSealed(Buffer.from("plain data")), false);
  assert.throws(() => inspect(Buffer.from("plain data")), /not a sealed vyre backup/);
  assert.throws(() => open(Buffer.from("plain data"), "whatever passphrase here"), /not a sealed vyre backup/);
});

test("inspect: the header is readable without the passphrase, and never carries the plaintext size lie", () => {
  const bytes = Buffer.from("x".repeat(500));
  const sealed = seal(bytes, "the right passphrase here", CHEAP);
  const { header } = inspect(sealed);
  assert.equal(header.bytes, 500);
  assert.equal(header.kdf, "scrypt");
  assert.ok(!("ct" in header), "the header itself never carries the ciphertext");
});

test("seal: a scrypt cost outside sane bounds is refused, even from a crafted header on open", () => {
  const sealed = seal(Buffer.from("x"), "the right passphrase here", CHEAP);
  const { header } = inspect(sealed);
  const bad = JSON.stringify({ ...header, N: 3 }); // not a power of two
  const magic = "vyre-box-backup:v1:";
  const rebuilt = Buffer.concat([Buffer.from(magic), Buffer.from(bad), Buffer.from("\n"), sealed.subarray(sealed.indexOf(0x0a, magic.length) + 1)]);
  assert.throws(() => open(rebuilt, "the right passphrase here"), /does not open/);
});
