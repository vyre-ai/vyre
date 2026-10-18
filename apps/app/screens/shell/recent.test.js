import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { recentChats, RECENT_SHOWN } from "./recent.js";

test("Recent is the latest few chats, newest first, each opening its chat", () => {
  const threads = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, name: `Chat ${i}`, last: 1000 + i }));
  const r = recentChats(threads);
  assert.equal(r.length, RECENT_SHOWN);
  assert.deepEqual(r.map(x => x.id), ["t7", "t6", "t5", "t4", "t3"]);
  assert.equal(r[0].href, "/u/chats/t7");
  assert.equal(r[0].label, "Chat 7");
});

test("nothing yet is an empty list, and the { threads } answer is read too", () => {
  assert.deepEqual(recentChats([]), []);
  assert.deepEqual(recentChats(null), []);
  assert.equal(recentChats({ threads: [{ id: "a", name: "A", last: 1 }] })[0].id, "a");
});
