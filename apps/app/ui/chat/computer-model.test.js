import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { computerOf, computerProblem, computerWords, computerActions, DOCK } from "./computer-model.js";

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

test("a computer the server has never made says so while it starts the first time", () => {
  assert.equal(computerOf({ state: "none", firstStart: true }).first, true);
  assert.equal(computerOf({ state: "asleep" }).first, undefined);
  assert.equal(computerWords(computerOf({ state: "waking", firstStart: true }), "Ads"), "Starting this agent's computer for the first time…");
  assert.match(computerWords(computerOf({ state: "waking" }), "Ads"), /^Waking Ads's computer/);
  assert.deepEqual(computerActions(computerOf({ state: "none", firstStart: true })), ["wake"], "Wake makes it");
});

test("why a computer cannot run reads in plain words, even from an older server that answers with its driver's own message", () => {
  const NOT_ON = "Agent computers aren't set up on this server yet. Update the server to turn them on.";
  assert.equal(computerProblem("the agent computer is not set up on this machine: its container is not running, or this machine's driver cannot run commands in it"), NOT_ON);
  assert.equal(computerProblem("no computer driver is configured on this machine: set computers.docker in config.json to the restricted Docker proxy"), NOT_ON);
  assert.match(computerProblem("docker POST /containers/create: No such image: vyre/computer:0.1"), /^The agent computer's image isn't on this server yet\./);
  assert.match(computerProblem("docker POST /containers/create: vyre docker proxy: create: wrong image"), /refused to start the agent computer/);
  // a newer server's own words, and any other refusal, are shown as they are
  assert.equal(computerProblem(NOT_ON), NOT_ON);
  assert.equal(computerProblem("you cannot use that agent: ask its owner to share it with you"), "you cannot use that agent: ask its owner to share it with you");
  for (const raw of ["the agent computer is not set up on this machine: its container is not running, or this machine's driver cannot run commands in it", "docker POST /x: No such image: y"]) {
    assert.doesNotMatch(computerProblem(raw), /container is not running|driver|docker/i);
  }
});

test("the dock is Chrome, Files and Terminal, in that order (the product map names the desktop's apps)", () => {
  assert.deepEqual(DOCK.map((d) => d.id), ["chrome", "files", "terminal"]);
  assert.deepEqual(DOCK.map((d) => d.label), ["Chrome", "Files", "Terminal"]);
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
