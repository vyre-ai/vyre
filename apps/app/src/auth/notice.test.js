// @ts-check
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearNotice, noteEnded, noteExpires, noteStorageRefused, sessionNotice, snapshot, subscribe } from "./notice.js";

const NOW = 1_800_000_000_000, DAY = 86_400_000;
const S = (/** @type {any} */ p) => ({ storageRefused: false, expires: null, ended: false, ...p });

test("nothing to say while the session is healthy and the browser keeps it", () => {
  assert.equal(sessionNotice(S({}), NOW), null);
  assert.equal(sessionNotice(S({ expires: NOW + 20 * DAY }), NOW), null);
});

test("a session that ends within three days says how many, and one that has ended says to sign in again from the phone", () => {
  assert.match(/** @type {any} */ (sessionNotice(S({ expires: NOW + 2 * DAY }), NOW)).text, /ends in 2 days/);
  assert.match(/** @type {any} */ (sessionNotice(S({ expires: NOW + DAY / 2 }), NOW)).text, /ends in 1 day\./);
  assert.match(/** @type {any} */ (sessionNotice(S({ expires: NOW - 1 }), NOW)).text, /has ended.*from your phone/);
  assert.match(/** @type {any} */ (sessionNotice(S({ ended: true }), NOW)).text, /has ended/);
});

test("a browser that refuses storage says the sign-in ends with the tab, but an ended or ending session comes first", () => {
  assert.match(/** @type {any} */ (sessionNotice(S({ storageRefused: true }), NOW)).text, /ends when you close this tab/);
  assert.match(/** @type {any} */ (sessionNotice(S({ storageRefused: true, ended: true }), NOW)).text, /has ended/);
});

test("the store tells subscribers, a new expiry lifts an ended state, and clear forgets it", () => {
  let n = 0;
  const off = subscribe(() => { n++; });
  noteStorageRefused(); noteStorageRefused();
  assert.equal(snapshot().storageRefused, true);
  noteEnded(); assert.equal(snapshot().ended, true);
  noteExpires(NOW + 30 * DAY); assert.deepEqual([snapshot().ended, snapshot().expires], [false, NOW + 30 * DAY]);
  noteExpires(Number.NaN); assert.equal(snapshot().expires, NOW + 30 * DAY);
  clearNotice(); assert.equal(snapshot().expires, null);
  off();
  assert.equal(n, 4);
});
