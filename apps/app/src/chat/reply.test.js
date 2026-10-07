import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { excerpt, quoteOf, quoteFromData, replyInput, jumpIndex, QUOTE_MAX } from "./reply.js";

test("a quote is the message's words, folded and cut", () => {
  assert.equal(excerpt("  one\n two   three "), "one two three");
  const long = "x".repeat(300);
  assert.equal(excerpt(long).length, QUOTE_MAX);
  assert.ok(excerpt(long).endsWith("…"));
});

test("a reply frame's reply_to and quote become the row's quote; a plain message has none", () => {
  const d = { message: "m9", text: "yes", state: "sent", reply_to: "m3", quote: { message: "m3", author: "person:sam", text: "Did the form come through?" } };
  assert.deepEqual(quoteFromData(d), { replyTo: "m3", quote: { message: "m3", author: "person:sam", text: "Did the form come through?" } });
  assert.deepEqual(quoteOf(quoteFromData(d)), { message: "m3", author: "person:sam", text: "Did the form come through?" });
  assert.deepEqual(quoteFromData({ message: "m1", text: "hi" }), {});
  assert.equal(quoteOf({}), null);
  // reply_to with no quote: the row still points at the original
  assert.deepEqual(quoteOf(quoteFromData({ reply_to: "m3" })), { message: "m3", author: "", text: "" });
  assert.deepEqual(quoteFromData({ reply_to: 5, quote: { text: 3 } }), {}, "anything that is not a string is ignored");
});

test("a reply is sent with the id of the message answered", () => {
  assert.deepEqual(replyInput({ message: "m3" }), { reply_to: "m3" });
  assert.deepEqual(replyInput(null), {});
});

test("jumping to the original finds its row by id, whoever wrote it", () => {
  const keys = ["u:m1", "a:m2", "t:x", "u:m3"];
  assert.equal(jumpIndex(keys, "m2"), 1);
  assert.equal(jumpIndex(keys, "m3"), 3);
  assert.equal(jumpIndex(keys, "nope"), -1);
});
