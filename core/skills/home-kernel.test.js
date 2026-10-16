// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { personalSkillsOnHome, homeSpaceId } from "./home-kernel.js";

test("personal skills live on the home Space kernel when the running Space is hosted", () => {
  const home = "spc_homehomehome";
  const team = "spc_teamteamteam";
  assert.equal(personalSkillsOnHome({ kernel: { space: home }, homeSpacePinned: home }), false);
  assert.equal(personalSkillsOnHome({ kernel: { space: team }, homeSpacePinned: home }), true);
  assert.equal(homeSpaceId({ kernel: { space: team }, homeSpacePinned: home }), home);
});
