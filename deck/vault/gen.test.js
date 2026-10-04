// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePayload, settingsBits, strengthWord, luhn, brand, group, expiry } from "./gen.js";

test("generator: the payload carries settings, never a value, clamped to vyred's limits", () => {
  assert.deepEqual(generatePayload({ field: "password" }), { field: "password", length: 24, symbols: true });
  assert.deepEqual(generatePayload({ field: "password", length: 3, symbols: false }), { field: "password", length: 8, symbols: false });
  assert.deepEqual(generatePayload({ field: "password", length: 500 }), { field: "password", length: 64, symbols: true });
  assert.deepEqual(generatePayload({ field: "value", mode: "words", words: 5 }), { field: "value", words: 5 });
  assert.deepEqual(generatePayload({ field: "value", mode: "words", words: 1 }), { field: "value", words: 3 });
  assert.throws(() => generatePayload({ field: "" }));
  for (const p of [generatePayload({ field: "password" }), generatePayload({ field: "x", mode: "words" })])
    assert.ok(Object.keys(p).every(k => ["field", "length", "symbols", "words"].includes(k)));
});

test("generator: bits of the settings match vyred's generate.js", () => {
  assert.equal(settingsBits({ length: 24, symbols: true }), 149.4);
  assert.equal(settingsBits({ length: 20, symbols: false }), 119);
  assert.equal(settingsBits({ words: 5 }), 94.8);
  assert.equal(strengthWord(150), "Very strong");
  assert.equal(strengthWord(40), "Weak");
});

test("cards: Luhn, brand, grouping, expiry", () => {
  assert.equal(luhn("4242 4242 4242 4242"), true);
  assert.equal(luhn("4242 4242 4242 4241"), false);
  assert.equal(luhn("1234"), false);
  assert.equal(brand("4242"), "Visa");
  assert.equal(brand("5555 5555"), "Mastercard");
  assert.equal(brand("2223 0031"), "Mastercard");
  assert.equal(brand("3782 822463"), "Amex");
  assert.equal(brand("6011 1111"), "Discover");
  assert.equal(brand("9999"), "");
  assert.equal(group("4242424242424242"), "4242 4242 4242 4242");
  assert.equal(group("378282246310005"), "3782 822463 10005");
  assert.equal(group("42424"), "4242 4");
  assert.equal(expiry("0928"), "09/28");
  assert.equal(expiry("09"), "09");
});
