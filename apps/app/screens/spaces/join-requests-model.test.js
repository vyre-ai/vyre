import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { ASK_COPY, askAddressOf, entryWords, nextForAsk } from "./join-requests-model.js";

const WORDS = Array.from({ length: 2048 }, (_, i) => `w${i}`);

test("an address is a Space's name or name.vyre.run and never a link or a path", () => {
  assert.equal(askAddressOf("juniper"), "juniper");
  assert.equal(askAddressOf(" Juniper.vyre.run "), "juniper");
  assert.equal(askAddressOf("https://juniper.vyre.run/"), "juniper");
  for (const bad of ["https://vyre.run/i/abc", "juniper.vyre.run/join/x", "a b", "", "-x", "x..y", "juniper:80", "juniper.example.com"]) assert.equal(askAddressOf(bad), null, bad);
});

test("both sides read the same four words for one device key, and another key reads other words", () => {
  const a = entryWords(WORDS, "e".repeat(26)), b = entryWords(WORDS, "e".repeat(26)), c = entryWords(WORDS, "f".repeat(26));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.split(" ").length, 4);
  assert.equal(entryWords(WORDS.slice(0, 5), "e".repeat(26)), null);
  assert.equal(entryWords(WORDS, "not an entry"), null);
});

test("an answer is waited on, joined, or said in the fixed words, nothing else", () => {
  assert.deepEqual(nextForAsk({ state: "waiting" }), { kind: "wait" });
  assert.deepEqual(nextForAsk({ state: "approved", link: "https://x.vyre.run/join/inv_1" }), { kind: "join", link: "https://x.vyre.run/join/inv_1" });
  assert.deepEqual(nextForAsk({ state: "approved" }), { kind: "said", words: ASK_COPY.closed });
  assert.deepEqual(nextForAsk({ state: "not_accepted" }), { kind: "said", words: "Not accepted." });
  assert.deepEqual(nextForAsk({ state: "closed", words: "This Space only takes invites." }), { kind: "said", words: "This Space only takes invites." });
  assert.deepEqual(nextForAsk(null), { kind: "said", words: ASK_COPY.closed });
});
