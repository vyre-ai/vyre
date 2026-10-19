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
  assert.match(computerWords(computerOf({ state: "asleep" }), "Ads"), /^Ads's computer is asleep\./);
  // brand neutral: a person reads "browser", never a product name
  for (const st of ["asleep", "waking", "live"]) assert.doesNotMatch(computerWords(computerOf({ state: st }), "Ads"), /Chrome/);
  assert.match(computerWords(computerOf({ state: "waking" }), "Ads"), /Waking/);
  assert.match(computerWords(computerOf({ state: "live" }), "Ads"), /live/i);
});

test("asleep offers Wake; waking offers nothing; live offers Open and Sleep", () => {
  assert.deepEqual(computerActions(computerOf({ state: "asleep" })), ["wake"]);
  assert.deepEqual(computerActions(computerOf({ state: "waking" })), []);
  assert.deepEqual(computerActions(computerOf({ state: "live" })), ["open", "sleep"]);
});

test("the dock is the browser, Files and Terminal, in that order", () => {
  assert.deepEqual(DOCK.map((d) => d.id), ["chrome", "files", "terminal"]);
  assert.deepEqual(DOCK.map((d) => d.label), ["Browser", "Files", "Terminal"]);
});

test("asleep, the whole screen wakes it: no separate Wake button, a gently breathing sleep mark (still with reduced motion), and Press to wake", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("./AgentComputerPane.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /label="Wake"/, "no Wake button");
  assert.match(src, /Press to wake/);
  assert.match(src, /onPress=\{onWake\}/, "pressing the screen wakes it");
  assert.match(src, /<Pulse active=\{!busy\}><Icon name="moon"/, "the sleep mark breathes through Pulse, which holds still under reduced motion");
  const pulse = fs.readFileSync(new URL("../motion/Pulse.tsx", import.meta.url), "utf8");
  assert.match(pulse, /useReducedMotion\(\)/);
  assert.match(pulse, /if \(reduced\) \{ o\.value = 0\.55; return; \}/);
});
