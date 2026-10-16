import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NO_VYRE, deviceKind, offersNoVyre } from "./first-run.js";
import { backOf } from "./flow.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");

test("I don't have Vyre running yet is a phone's connect-step action only", () => {
  assert.equal(offersNoVyre(deviceKind("ios", false), false), true);
  assert.equal(offersNoVyre(deviceKind("android", false), false), true);
  assert.equal(offersNoVyre(deviceKind("web", true), false), false); // a Mac
  assert.equal(offersNoVyre(deviceKind("web", false), false), false); // a browser
  assert.equal(offersNoVyre(deviceKind("android", false), true), false); // a mock walk
});

test("the share text is the setup link and no install command; Back from the step returns to the connect step", () => {
  assert.match(NO_VYRE.share, /https:\/\/vyre\.run/);
  assert.doesNotMatch(NO_VYRE.share, /curl|\| sh|sudo/);
  assert.equal(backOf("novyre"), "scan");
});

