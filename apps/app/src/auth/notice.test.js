// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { clearNotice, failureOf, noteRenewFailed, noteRenewed, noteStorageRefused, renewWords, sessionNotice, snapshot, subscribe } from "./notice.js";

const S = (/** @type {any} */ p) => ({ storageRefused: false, renewFailed: null, ...p });

test("nothing is said while renewal works: no expiry countdown, no sign-in-again", () => {
  assert.equal(sessionNotice(S({})), null);
});

test("a failed renewal says why in the words for its kind, never the server's text, and never tells the person to sign in from the phone when the phone lifts a lock", () => {
  assert.equal(failureOf("denied"), "denied");
  assert.equal(failureOf("offline"), "unreachable");
  assert.equal(failureOf("timeout"), "unreachable");
  assert.equal(failureOf("anything else"), "other");
  assert.match(renewWords("unreachable"), /Cannot reach your server right now. You stay signed in; this will retry\./);
  assert.match(renewWords("denied"), /could not sign in again.*locked after wrong answers, it unlocks by itself in 15 minutes.*removed, pair it again from your phone/);
  assert.doesNotMatch(renewWords("denied"), /Sign in again from your phone/);
  assert.match(renewWords("other"), /pair this device again from your phone/);
  assert.equal(sessionNotice(S({ renewFailed: "unreachable" }))?.tone, "plain");
  assert.equal(sessionNotice(S({ renewFailed: "denied" }))?.tone, "warn");
});

test("the storage notice stays, and a failed renewal comes first", () => {
  assert.match(/** @type {any} */ (sessionNotice(S({ storageRefused: true }))).text, /ends when you close this tab/);
  assert.match(/** @type {any} */ (sessionNotice(S({ storageRefused: true, renewFailed: "denied" }))).text, /could not sign in again/);
});

test("the store tells subscribers, a renewal lifts the failure, and clear forgets it", () => {
  let n = 0;
  const off = subscribe(() => { n++; });
  noteStorageRefused(); noteStorageRefused();
  noteRenewFailed("denied"); assert.equal(snapshot().renewFailed, "denied");
  noteRenewed(); assert.equal(snapshot().renewFailed, null);
  noteRenewed();
  noteRenewFailed("offline"); clearNotice(); assert.equal(snapshot().renewFailed, null);
  off();
  assert.equal(n, 5);
});
