// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFollow, follow, pillLabel } from "./follow.js";

test("follows by default and stays following while at the bottom", () => {
  let s = createFollow();
  s = follow(s, { type: "rows", added: 3 });
  assert.deepEqual(s, { following: true, unread: 0 });
  assert.equal(follow(s, { type: "scroll", atBottom: true }), s);
});

test("scrolling up stops following; new rows count; the pill says how many", () => {
  let s = createFollow();
  s = follow(s, { type: "scroll", atBottom: false });
  assert.equal(s.following, false);
  s = follow(s, { type: "rows", added: 2 });
  s = follow(s, { type: "rows", added: 1 });
  assert.equal(s.unread, 3);
  assert.equal(pillLabel(s.unread), "3 new, jump to latest");
  assert.equal(pillLabel(0), "Jump to latest");
});

test("jump or scrolling back to the bottom resumes following", () => {
  let s = follow(createFollow(), { type: "scroll", atBottom: false });
  s = follow(s, { type: "rows", added: 4 });
  assert.deepEqual(follow(s, { type: "jump" }), { following: true, unread: 0 });
  assert.deepEqual(follow(s, { type: "scroll", atBottom: true }), { following: true, unread: 0 });
});

test("rows arriving while following never move the reader into away", () => {
  const s = follow(createFollow(), { type: "rows", added: 10 });
  assert.equal(s.following, true);
});
