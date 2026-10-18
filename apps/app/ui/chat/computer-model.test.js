import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { computerOf, computerWords, computerActions, DOCK, whereWords, agentComputerView } from "./computer-model.js";

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

test("where it runs is said per viewer: My Computer only on the viewer's own server (Vyre Home), Space's Cloud for everyone else", () => {
  assert.equal(whereWords({ role: "local", owner: "per_a" }, "per_a"), "My Computer");
  assert.equal(whereWords({ role: "local", owner: "per_a" }, "per_b"), "Space's Cloud", "a member of a Space whose server is the owner's own Mac");
  assert.equal(whereWords({ role: "box", owner: "per_a" }, "per_a"), "Space's Cloud", "a hosted server is the Space's, even for its owner");
  for (const bad of [null, undefined, {}, { role: "local" }, { role: "local", owner: "per_a" }]) assert.equal(whereWords(/** @type {any} */ (bad), null), "Space's Cloud");
});

test("the tab's view of one agent: the picture, who holds the screen, where it runs and which buttons apply", () => {
  const jpeg = "data:image/jpeg;base64,AAAA";
  const live = agentComputerView({ state: "live", lastActive: 9, thumbnail: jpeg, runs_on: { role: "local", owner: "per_a" } }, { viewer: "per_a", canEdit: true });
  assert.deepEqual([live.state, live.frame, live.where, live.heldBy, live.withheld, live.canWatch, live.canTakeOver], ["live", jpeg, "My Computer", null, null, true, true]);
  const member = agentComputerView({ state: "live", thumbnail: jpeg, runs_on: { role: "local", owner: "per_a" } }, { viewer: "per_b", canEdit: false });
  assert.deepEqual([member.where, member.canWatch, member.canTakeOver], ["Space's Cloud", true, false], "use alone can watch, not take over");
  const typing = agentComputerView({ state: "live", held_by: "taken-over", withheld: "typing", runs_on: { role: "box" } }, { viewer: "per_a", canEdit: true });
  assert.deepEqual([typing.frame, typing.heldBy, typing.withheld, typing.canTakeOver], ["", "taken-over", "typing", false], "no picture and no second take-over while someone types");
  const asleep = agentComputerView({ state: "asleep", thumbnail: jpeg }, {});
  assert.deepEqual([asleep.canWatch, asleep.canTakeOver, asleep.frame], [false, false, jpeg], "the latest picture stays visible while asleep");
  assert.equal(agentComputerView(null).state, "asleep");
  assert.equal(agentComputerView({ state: "live", thumbnail: "javascript:alert(1)" }).frame, "", "only an image data URL is ever a picture");
});
