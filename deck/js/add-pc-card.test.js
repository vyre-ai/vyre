// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { addPc, seedProblem } from "./add-pc-card.js";
import { seedToWords, seedQrText, newSeed } from "../../relay/client/seedwords.js";
import { nodeCrypto } from "../../relay/client/nodecrypto.js";
import { base64url } from "../../relay/client/bytes.js";

const c = nodeCrypto();

test("Add a Windows PC: the words or the QR text reach relay.pair.ticket as the same seed, asking for presence", async () => {
  const seed = newSeed(c);
  const calls = [];
  const attempt = async (name, input, opts) => { calls.push([name, input, opts]); return { data: { ticket: input.seed, expiresAt: 1234 } }; };
  const words = (await seedToWords(seed, c)).join(" ");
  for (const text of [words, words.toUpperCase(), seedQrText(seed)]) {
    const r = await addPc(text, attempt);
    assert.deepEqual(r, { ok: true, expiresAt: 1234, confirmed: true });
  }
  assert.equal(calls.length, 3);
  for (const [name, input, opts] of calls) { assert.equal(name, "relay.pair.ticket"); assert.equal(input.seed, base64url(seed)); assert.deepEqual(opts, { presence: "asked" }); }
});

test("Add a Windows PC: a wrong code never reaches your server, and each failure says what to do", async () => {
  let asked = 0;
  const attempt = async () => { asked++; return { data: {} }; };
  const words = (await seedToWords(newSeed(c), c)).slice();
  const r1 = await addPc(words.slice(0, 12).join(" "), attempt);
  assert.equal(r1.ok, false); assert.match(String(/** @type {any} */ (r1).message), /13 words/);
  const r2 = await addPc(words.map((w, i) => (i === 2 ? "zzzzzz" : w)).join(" "), attempt);
  assert.match(String(/** @type {any} */ (r2).message), /"zzzzzz" is not one of the words/);
  const r3 = await addPc(words.map((w, i) => (i === 12 ? (w === "abandon" ? "ability" : "abandon") : w)).join(" "), attempt);
  assert.match(String(/** @type {any} */ (r3).message), /mistyped/);
  assert.equal(asked, 0);
  // the box's own refusals
  const seed = newSeed(c);
  const busy = await addPc(seedQrText(seed), async () => ({ error: { code: "conflict" } }));
  assert.match(String(/** @type {any} */ (busy).message), /already waiting/);
  assert.match(seedProblem({ code: "unavailable" }), /relay did not answer/);
  assert.equal(seedProblem(null), "Could not add the computer.");
});

test("Add a Windows PC: confirmed is false only when the relay says so; absent reads as confirmed", async () => {
  const seed = newSeed(c);
  const words = (await seedToWords(seed, c)).join(" ");
  const ask = data => addPc(words, async () => ({ data }));
  assert.equal((await ask({ expiresAt: 1, confirmed: false })).confirmed, false);
  assert.equal((await ask({ expiresAt: 1, confirmed: true })).confirmed, true);
  assert.equal((await ask({ expiresAt: 1 })).confirmed, true);
});
