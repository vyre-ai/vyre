// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { base32Decode, parseOtpauth, totp } from "./totp.js";

function b32(buf) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out += A[(value >>> bits) & 31]; }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}

const SEEDS = {
  SHA1: Buffer.from("12345678901234567890"),
  SHA256: Buffer.from("12345678901234567890123456789012"),
  SHA512: Buffer.from("1234567890123456789012345678901234567890123456789012345678901234"),
};

// RFC 6238 Appendix B
const VECTORS = [
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

test("RFC 6238 Appendix B vectors", () => {
  for (const [t, ...codes] of VECTORS) {
    ["SHA1", "SHA256", "SHA512"].forEach((alg, i) => {
      const uri = `otpauth://totp/Test:user?secret=${b32(SEEDS[alg])}&algorithm=${alg}&digits=8&period=30`;
      assert.equal(totp(uri, { at: Number(t) * 1000 }).code, codes[i], `${alg} at ${t}`);
    });
  }
});

test("base32 round trip, case and padding", () => {
  const s = b32(SEEDS.SHA1);
  assert.deepEqual(base32Decode(s), SEEDS.SHA1);
  assert.deepEqual(base32Decode(s.toLowerCase().replace(/(.{4})/g, "$1 ") + "===="), SEEDS.SHA1);
  assert.throws(() => base32Decode("ABC1"), /invalid base32/);
});

test("bare secret uses defaults", () => {
  const p = parseOtpauth(b32(SEEDS.SHA1));
  assert.equal(p.algorithm, "sha1");
  assert.equal(p.digits, 6);
  assert.equal(p.period, 30);
  assert.equal(totp(b32(SEEDS.SHA1), { at: 59_000 }).code, "287082");
});

test("remaining counts down to the next step", () => {
  const s = b32(SEEDS.SHA1);
  assert.equal(totp(s, { at: 59_000 }).remaining, 1);
  assert.equal(totp(s, { at: 60_000 }).remaining, 30);
  assert.equal(totp(s, { at: 75_500 }).remaining, 15);
  const r = totp(`otpauth://totp/x?secret=${s}&period=60`, { at: 61_000 });
  assert.equal(r.remaining, 59);
  assert.equal(r.period, 60);
});

test("hotp is refused", () => {
  assert.throws(() => parseOtpauth(`otpauth://hotp/x?secret=${b32(SEEDS.SHA1)}&counter=1`), /hotp.*not supported/);
});

test("errors never contain the secret", () => {
  const bad = "SUPERSECRETVALUE1890";
  for (const input of [bad, `otpauth://totp/x?secret=${bad}`, `otpauth://totp/x?secret=${b32(SEEDS.SHA1)}&digits=7`]) {
    try { totp(input); assert.fail("should throw"); }
    catch (e) {
      assert.ok(!String(e.message).includes(bad), e.message);
      assert.ok(!String(e.message).includes(b32(SEEDS.SHA1)), e.message);
    }
  }
});
