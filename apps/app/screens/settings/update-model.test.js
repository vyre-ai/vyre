import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { aboutButton, aboutLine, appliedLine, howToLine, noticeLines, showNotice } from "./update-model.js";

const base = { current: "0.2.10", available: null, how: "command", command: "vyre update", canApply: true, pending: false, error: null };

test("Now shows the card only when a newer release is known and nothing is installing it", () => {
  assert.equal(showNotice(null), false);
  assert.equal(showNotice(base), false, "up to date");
  assert.equal(showNotice({ ...base, available: "0.2.11" }), true);
  assert.equal(showNotice({ ...base, available: "0.2.11", pending: true }), false, "already installing");
  assert.equal(showNotice({ ...base, available: "0.2.10" }), false, "the running version is not news");
});

test("the card says which version is out and what updating keeps, or how to update when the app cannot", () => {
  const n = noticeLines({ ...base, available: "0.2.11" });
  assert.equal(n.title, "Vyre 0.2.11 is out");
  assert.match(n.detail, /You are on 0\.2\.10\. Updating keeps your data/);
  assert.match(noticeLines({ ...base, available: "0.2.11", canApply: false }).detail, /To update, run vyre update on your server\./);
  assert.match(howToLine({ ...base, canApply: false, command: null, how: "app" }), /Update from the app that installed Vyre/);
});

test("About has one button: check when up to date, update when a release is out and this box can install it, none otherwise", () => {
  assert.deepEqual(aboutButton(base), { label: "Check for updates", action: "check" });
  assert.deepEqual(aboutButton({ ...base, available: "0.2.11" }), { label: "Update to 0.2.11", action: "apply" });
  assert.equal(aboutButton({ ...base, available: "0.2.11", canApply: false }), null);
  assert.equal(aboutButton({ ...base, available: "0.2.11", pending: true }), null);
  assert.equal(aboutButton(null), null);
});

test("About's line under the version", () => {
  assert.equal(aboutLine(null), "");
  assert.equal(aboutLine(base), "You are on the newest version.");
  assert.match(aboutLine({ ...base, available: "0.2.11" }), /^Vyre 0\.2\.11 is out\. Updating keeps/);
  assert.match(aboutLine({ ...base, error: "offline" }), /failed: offline/);
  assert.match(aboutLine({ ...base, pending: true }), /being installed/);
});

test("after update.apply: a started update says it restarts, a refused one says why", () => {
  assert.match(appliedLine({ requested: true }), /restarts/);
  assert.equal(appliedLine({ requested: false, reason: "an update is already running" }), "an update is already running");
  assert.equal(appliedLine({ requested: false }), "The update did not start.");
});
