import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { endsSession } from "./identity-change.js";
import { createMessageIndex } from "../../src/chat/message-index.js";

const open = (username) => ({ exists: true, unlocked: true, username });

test("an unlocked identity that becomes locked, gone or another person's ends the session", () => {
  assert.equal(endsSession(open("dana"), { exists: true, unlocked: false, username: "dana" }), true, "locked");
  assert.equal(endsSession(open("dana"), { exists: false }), true, "forgotten or signed out");
  assert.equal(endsSession(open("dana"), open("sam")), true, "another person on the same device");
});

test("nothing ends when it stays the same, is first read, or the box cannot be reached", () => {
  assert.equal(endsSession(open("dana"), open("dana")), false);
  assert.equal(endsSession(null, open("dana")), false, "a first read");
  assert.equal(endsSession(open("dana"), { unreachable: true }), false, "the app has not lost its session, it cannot tell");
  assert.equal(endsSession(open("dana"), null), false);
  assert.equal(endsSession({ exists: true, unlocked: false }, open("dana")), false, "unlocking is not an end");
});

test("a state change to another identity empties the message index", () => {
  const ix = createMessageIndex();
  ix.index("c1", [{ id: "u:1", who: "Dana", text: "the lease for Park Lane" }]);
  const next = open("sam");
  if (endsSession(open("dana"), next)) ix.clear();
  assert.deepEqual(ix.search("lease"), [], "the previous person's words are gone");
});
