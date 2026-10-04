// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { seedToWords, wordsToSeed, seedQrText, parseSeedText, newSeed, SEED_BYTES } from "./seedwords.js";
import { nodeCrypto } from "./nodecrypto.js";
import { WORDS } from "./words.js";

const c = nodeCrypto();

test("seed words: 13 words round trip for any seed, and the words are all in the list", async () => {
  for (let i = 0; i < 200; i++) {
    const seed = newSeed(c);
    const words = await seedToWords(seed, c);
    assert.equal(words.length, 13);
    for (const w of words) assert.ok(WORDS.includes(w), w);
    assert.deepEqual(await wordsToSeed(words, c), seed);
  }
  const zero = new Uint8Array(SEED_BYTES);
  assert.deepEqual(await wordsToSeed(await seedToWords(zero, c), c), zero);
  const ones = new Uint8Array(SEED_BYTES).fill(255);
  assert.deepEqual(await wordsToSeed(await seedToWords(ones, c), c), ones);
});

test("seed words: typing is forgiving, and one wrong word, a swap, a missing or an extra word is caught", async () => {
  const seed = newSeed(c);
  const words = await seedToWords(seed, c);
  assert.deepEqual(await wordsToSeed("  " + words.map(w => w.toUpperCase()).join(",  "), c), seed, "case, commas and spaces");
  assert.deepEqual(await wordsToSeed(words.join("-"), c), seed, "dashes");
  assert.deepEqual(await wordsToSeed(words.map(w => w.slice(0, 4)), c), seed, "the first four letters are enough");
  const other = WORDS.find(w => !words.includes(w) && w !== words[3]);
  await assert.rejects(wordsToSeed(words.map((w, i) => (i === 3 ? /** @type {string} */ (other) : w)), c), e => ["bad_checksum"].includes(/** @type {any} */ (e).code));
  const swapped = [...words]; [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  if (swapped[0] !== words[0]) await assert.rejects(wordsToSeed(swapped, c), e => /** @type {any} */ (e).code === "bad_checksum");
  await assert.rejects(wordsToSeed(words.slice(0, 12), c), e => /** @type {any} */ (e).code === "word_count");
  await assert.rejects(wordsToSeed([...words, "abandon"], c), e => /** @type {any} */ (e).code === "word_count");
  await assert.rejects(wordsToSeed(words.map((w, i) => (i === 5 ? "zzzzzz" : w)), c), e => /** @type {any} */ (e).code === "unknown_word" && /** @type {any} */ (e).word === "zzzzzz");
  // the padding bits must be zero: a real word list entry in the last data slot with a set pad is not a code
  const padded = [...words]; padded[11] = WORDS[(WORDS.indexOf(words[11]) ^ 1)];
  await assert.rejects(wordsToSeed(padded, c), e => /** @type {any} */ (e).code === "bad_checksum");
});

test("seed words: the QR text and the bare 22 characters give the same seed, and junk is refused", async () => {
  const seed = newSeed(c);
  const qr = seedQrText(seed);
  assert.match(qr, /^vyre-pc:[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(await parseSeedText(qr, c), seed);
  assert.deepEqual(await parseSeedText(qr.slice("vyre-pc:".length), c), seed);
  assert.deepEqual(await parseSeedText((await seedToWords(seed, c)).join(" "), c), seed);
  for (const bad of ["", "vyre-pc:short", "vyre-pc:" + "!".repeat(22), "https://example.com"]) await assert.rejects(parseSeedText(bad, c), /./, bad);
});

test("seed words: the word list is the setup page's, and its first four letters are unique", () => {
  assert.equal(WORDS.length, 2048);
  assert.equal(new Set(WORDS.map(w => w.slice(0, 4))).size, 2048);
});
