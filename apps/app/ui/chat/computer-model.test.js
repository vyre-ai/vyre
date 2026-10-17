import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { computerOf, computerWords, computerActions, DOCK } from "./computer-model.js";

test("the box's answer becomes one of three states; anything else reads as asleep", () => {
  assert.equal(computerOf({ state: "live", lastActive: 5, thumbnail: "data:image/png;base64,AAAA" }).state, "live");
  assert.equal(computerOf({ state: "waking" }).state, "waking");
  assert.equal(computerOf({ state: "asleep" }).state, "asleep");
  assert.equal(computerOf({ state: "stopped" }).state, "asleep");
  assert.equal(computerOf({ state: "none" }).state, "asleep");
  assert.equal(computerOf({ state: "live", lastActive: 7 }).lastActive, 7);
  assert.equal(computerOf(null).state, "asleep");
  assert.equal(computerOf(undefined).state, "asleep");
});

test("a thumbnail is kept only when it is an image data URL", () => {
  assert.equal(computerOf({ state: "live", thumbnail: "data:image/png;base64,AAAA" }).thumbnail, "data:image/png;base64,AAAA");
  assert.equal(computerOf({ state: "live", thumbnail: "https://example.com/x.png" }).thumbnail, "");
  assert.equal(computerOf({ state: "live", thumbnail: "javascript:alert(1)" }).thumbnail, "");
});

test("the words under the screen say what is happening and what to do", () => {
  assert.match(computerWords(computerOf({ state: "asleep" }), "Ads"), /Ads is asleep/);
  assert.match(computerWords(computerOf({ state: "waking" }), "Ads"), /Waking/);
  assert.match(computerWords(computerOf({ state: "live" }), "Ads"), /live/i);
});

test("asleep offers Wake; waking offers nothing; live offers Open and Sleep", () => {
  assert.deepEqual(computerActions(computerOf({ state: "asleep" })), ["wake"]);
  assert.deepEqual(computerActions(computerOf({ state: "waking" })), []);
  assert.deepEqual(computerActions(computerOf({ state: "live" })), ["open", "sleep"]);
});

test("the dock is Chrome, Files and Terminal, in that order", () => {
  assert.deepEqual(DOCK.map((d) => d.id), ["chrome", "files", "terminal"]);
});
