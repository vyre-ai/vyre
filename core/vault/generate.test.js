// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "./generate.js";

const SYM = /[!@#$%^&*\-_=+?]/;

test("default is 24 characters with every class", () => {
  const { value, bits } = generate();
  assert.equal(value.length, 24);
  assert.match(value, /[a-z]/); assert.match(value, /[A-Z]/); assert.match(value, /[0-9]/); assert.match(value, SYM);
  assert.match(value, /^[A-Za-z0-9!@#$%^&*\-_=+?]+$/);
  assert.equal(bits, 149.4); // 24 * log2(75)
});

test("lengths and classes hold across many draws", () => {
  for (const length of [8, 9, 16, 64, 128]) {
    for (let i = 0; i < 50; i++) {
      const { value } = generate({ length });
      assert.equal(value.length, length);
      assert.match(value, /[a-z]/); assert.match(value, /[A-Z]/); assert.match(value, /[0-9]/); assert.match(value, SYM);
    }
  }
});

test("symbols off", () => {
  for (let i = 0; i < 50; i++) {
    const { value, bits } = generate({ length: 20, symbols: false });
    assert.match(value, /^[A-Za-z0-9]{20}$/);
    assert.match(value, /[a-z]/); assert.match(value, /[A-Z]/); assert.match(value, /[0-9]/);
    assert.equal(bits, 119); // 20 * log2(62) = 119.08
  }
});

test("word mode format and bits", () => {
  const { value, bits } = generate({ words: 5 });
  assert.match(value, /^([bdfghjklmnprstvz][aeiou]){3}(-([bdfghjklmnprstvz][aeiou]){3}){4}$/);
  assert.equal(bits, 94.8); // 5 * 18.966
  assert.equal(generate({ words: 3 }).bits, 56.8);
  assert.equal(generate({ words: 4, separator: "." }).value.split(".").length, 4);
});

test("range errors", () => {
  for (const length of [7, 129, 10.5, NaN]) assert.throws(() => generate({ length }), /length must be/);
  for (const words of [2, 21, 3.5]) assert.throws(() => generate({ words }), /words must be/);
});

test("200 values are distinct", () => {
  const chars = new Set(Array.from({ length: 200 }, () => generate({ length: 12 }).value));
  const words = new Set(Array.from({ length: 200 }, () => generate({ words: 3 }).value));
  assert.equal(chars.size, 200);
  assert.equal(words.size, 200);
});
