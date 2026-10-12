import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DEMO, SCREENS, addressOf, afterSpace, apiKeyStatus, inviteStatus, knownName, masterStatus, nameStatus, reach, recoveryStatus, spaceCodeStatus, stepLabels, wordsMatch } from "./flow-model.js";

test("every screen is reachable from the start and every target exists", () => {
  const seen = reach("start");
  for (const id of Object.keys(SCREENS)) assert.ok(seen.has(id), `${id} is not reachable`);
  for (const [id, s] of Object.entries(SCREENS)) for (const t of s.to) assert.ok(SCREENS[t], `${id} leads to ${t}, which is not a screen`);
});
test("no dead end: every screen can still reach Ready, and Ready can start again", () => {
  for (const id of Object.keys(SCREENS)) assert.ok(reach(id).has("ready"), `${id} cannot reach ready`);
  assert.ok(reach("ready").has("start"));
});
test("a failure has a way forward: each screen that can fail leads on or back", () => {
  for (const id of ["id.approve", "id.recover", "master.enter", "create.confirm"]) assert.ok(SCREENS[id].to.length >= 2, `${id} needs a second way`);
});
test("steps follow the device and the space", () => {
  assert.deepEqual(stepLabels({ device: "computer", allowed: true }), ["Identity", "Master password", "Inference", "Space", "Compute", "Ready"]);
  assert.deepEqual(stepLabels({ device: "phone", allowed: true }), ["Identity", "Master password", "Inference", "Space", "Ready"]);
  assert.deepEqual(stepLabels({ device: "computer", allowed: true, later: true }), ["Space", "Compute", "Ready"]);
  assert.equal(afterSpace({ device: "computer", allowed: false }), "ready");
  assert.equal(afterSpace({ device: "computer", allowed: true }), "compute");
});
test("the pretend answers", () => {
  assert.equal(nameStatus("alex"), "taken");
  assert.equal(nameStatus("ab"), "invalid");
  assert.equal(nameStatus("morgan"), "free");
  assert.equal(knownName(" Alex "), true);
  assert.equal(recoveryStatus(DEMO.recoveryCode), "ok");
  assert.equal(recoveryStatus("KIT-0000-0000-0000"), "wrong");
  assert.equal(masterStatus(DEMO.master), "ok");
  assert.equal(masterStatus("nope"), "wrong");
  assert.equal(masterStatus("mine", "mine"), "ok");
  assert.equal(apiKeyStatus("sk-ant-abcdefgh12"), "ok");
  assert.equal(apiKeyStatus("hello"), "bad");
  assert.equal(spaceCodeStatus(DEMO.spaceCode), "ok");
  assert.equal(spaceCodeStatus("WINK-0000-0000"), "expired");
  assert.equal(spaceCodeStatus("WINK-1111-2222"), "wrong");
  assert.equal(inviteStatus("https://web.vyre.run/join/abc"), "ok");
  assert.equal(inviteStatus("my expired invite"), "expired");
  assert.equal(inviteStatus("abc"), "short");
  assert.equal(wordsMatch("River amber, stone quiet"), true);
  assert.equal(wordsMatch("river amber stone"), false);
  assert.equal(addressOf("Harlow Legal"), "harlow-legal");
});
