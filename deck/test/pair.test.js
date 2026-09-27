// @ts-check
// The /pair screen's pure parts (deck/js/pair-steps.js): the one-time code, and each row's state
// from what the page knows. The view itself (deck/views/pair.js) only draws these.

import test from "node:test";
import assert from "node:assert/strict";
import { normalCode, showCode, pairSteps } from "../js/pair-steps.js";

test("pair: the code with or without its dash, in any case, is the one the box compares", () => {
  assert.equal(normalCode("7KQM-P4XD"), "7KQMP4XD");
  assert.equal(normalCode("7KQMP4XD"), "7KQMP4XD");
  assert.equal(normalCode("7kqm-p4xd"), "7KQMP4XD");
  assert.equal(normalCode(" 7kqm p4xd "), "7KQMP4XD");
  assert.equal(normalCode("7KQM-P4X"), "", "too short");
  assert.equal(normalCode("7KQM-P4XDZ"), "", "too long");
  assert.equal(normalCode("7KQM_P4XD"), "", "only letters, numbers and the dash");
  assert.equal(normalCode(""), "");
  assert.equal(showCode("7kqmp4xd"), "7KQM-P4XD");
  assert.equal(showCode("7kq"), "7KQ");
  assert.equal(showCode("7KQM-P4XD-extra"), "7KQM-P4XD");
});

/** @type {import("../js/pair-steps.js").PairInput} */
const base = { key: { ok: true, on: false }, push: { ok: true, on: false, permission: "default" }, ios: true, standalone: false, https: true, delivered: false };
const states = (/** @type {any} */ s) => Object.fromEntries(s.checks.map((/** @type {any} */ c) => [c.id, c.state]));

test("pair: a fresh iPhone in Safari: everything to do but the page and HTTPS", () => {
  const s = pairSteps({ ...base, push: { ok: false, why: "install" } });
  assert.equal(s.passkey.state, "todo");
  assert.equal(s.notify.state, "todo");
  assert.match(s.notify.reason || "", /Home Screen/);
  assert.equal(s.install.state, "todo");
  assert.equal(s.install.reason, "Tap Share, then Add to Home Screen. Open Vyre from the Home Screen to finish.");
  assert.deepEqual(states(s), { reached: "done", https: "done", app: "todo", test: "todo", key: "todo" });
});

test("pair: all done from the Home Screen app", () => {
  const s = pairSteps({ ...base, key: { ok: true, on: true }, push: { ok: true, on: true, permission: "granted" }, standalone: true, delivered: true });
  assert.deepEqual([s.passkey.state, s.notify.state, s.install.state], ["done", "done", "done"]);
  assert.deepEqual(states(s), { reached: "done", https: "done", app: "done", test: "done", key: "done" });
});

test("pair: failures say why", () => {
  const noKey = pairSteps({ ...base, key: { ok: false, on: false } });
  assert.equal(noKey.passkey.state, "failed");
  assert.match(noKey.passkey.reason || "", /cannot make a passkey/);
  const badCode = pairSteps({ ...base, keyError: "That code is not valid or has expired." });
  assert.deepEqual([badCode.passkey.state, badCode.passkey.reason], ["failed", "That code is not valid or has expired."]);
  const denied = pairSteps({ ...base, standalone: true, push: { ok: true, on: false, permission: "denied" }, denied: "Turn them on in Settings." });
  assert.deepEqual([denied.notify.state, denied.notify.reason], ["failed", "Turn them on in Settings."]);
  const unsupported = pairSteps({ ...base, ios: false, push: { ok: false, why: "unsupported" } });
  assert.equal(unsupported.notify.state, "failed");
  const http = pairSteps({ ...base, https: false });
  assert.equal(states(http).https, "failed");
  assert.match(http.checks.find(c => c.id === "https")?.reason || "", /https/);
});

test("pair: off iPhone, install is the browser menu; the test waits for push.delivered", () => {
  const s = pairSteps({ ...base, ios: false });
  assert.equal(s.install.state, "todo");
  assert.match(s.install.reason || "", /browser menu/);
  assert.equal(states(s).test, "todo");
  assert.equal(states(pairSteps({ ...base, ios: false, delivered: true })).test, "done");
});
