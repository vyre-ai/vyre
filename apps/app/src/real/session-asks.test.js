// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { withPending, ASK_LIFE_MS, SESSION_ANSWER, SESSION_ASKED, answerSession, askTitle, sessionRefusal, withAsk } from "./session-asks.js";

const ev = (id, label) => ({ type: SESSION_ASKED, payload: { id, device: "dev1", label } });

test("an ask event adds one card once, with the label in our title", () => {
  let l = withAsk([], ev("a1", "Vyre on browser"), 1000);
  l = withAsk(l, ev("a1", "Vyre on browser"), 2000);
  assert.equal(l.length, 1);
  assert.equal(askTitle(l[0]), "Let Vyre on browser sign in");
});

test("other events and unlabeled or odd asks are handled", () => {
  assert.deepEqual(withAsk([], { type: "device.added", payload: {} }, 1), []);
  assert.equal(askTitle(withAsk([], ev("a2", undefined), 1)[0]), "Let a browser sign in");
  assert.equal(askTitle(withAsk([], ev("a3", "<b>x</b>"), 1)[0]), "Let bxb sign in");
});

test("an ask older than five minutes is dropped", () => {
  const l = withAsk([], ev("a1", "x"), 0);
  assert.deepEqual(withAsk(l, { type: "other" }, ASK_LIFE_MS + 1), []);
});

test("Allow and Don't allow answer with the id and yes, and say what happened", async () => {
  /** @type {any[]} */ const seen = [];
  const call = async (/** @type {string} */ t, /** @type {any} */ i) => { seen.push([t, i]); return {}; };
  const a = { id: "a1", device: "d", label: "x", at: 0 };
  assert.match(await answerSession(a, true, call), /Allowed/);
  assert.match(await answerSession(a, false, call), /Not allowed/);
  assert.deepEqual(seen, [[SESSION_ANSWER, { id: "a1", yes: true }], [SESSION_ANSWER, { id: "a1", yes: false }]]);
});

test("a failed answer has our words", () => {
  assert.match(sessionRefusal("needs_presence"), /Face ID/);
  assert.match(sessionRefusal("expired"), /ended/);
  assert.match(sessionRefusal("ERR_CANCELED"), /Cancelled/);
});

test("the pending list fills in asks made while the app was closed, once each", () => {
  const l = withPending(withAsk([], ev("a1", "x"), 1), [{ id: "a1", label: "x" }, { id: "a2", label: "Vyre on browser" }], 2);
  assert.deepEqual(l.map((a) => a.id), ["a1", "a2"]);
  assert.equal(withPending([], { asks: [{ id: "b1" }] }, 1).length, 1);
  assert.deepEqual(withPending([], undefined, 1), []);
});
