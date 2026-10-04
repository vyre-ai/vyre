import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAMERA_SCAN, NO_VYRE, deviceKind, offersNoVyre } from "./first-run.js";
import { backOf } from "./flow.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), "utf8");

test("RC1 pairing offers no camera view: the flag is off and PairEntry reads it before it asks for the camera or draws one", () => {
  assert.equal(CAMERA_SCAN, false);
  const src = read("../devices/PairParts.tsx");
  assert.match(src, /import \{ CAMERA_SCAN \} from "\.\.\/install\/first-run\.js"/);
  assert.match(src, /if \(CAMERA_SCAN && canScanLive\) requestCamera\(\)/);
  assert.match(src, /\{CAMERA_SCAN && canScanLive && ScanCamera && cam\?\.state === "granted"/);
  // the permission line is only drawn for a camera that was asked for
  assert.doesNotMatch(src, /\) : cam && cam\.state !== "granted"/);
});

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

test("the step shares NO_VYRE.share through the system share sheet, and Not now keeps the skip flag then opens the landing", () => {
  const src = read("./InstallScreen.tsx");
  const step = src.slice(src.indexOf('step === "novyre"'), src.indexOf('step === "scanwords"'));
  assert.match(step, /Share\.share\(\{ message: NO_VYRE\.share \}\)/);
  assert.match(step, /label=\{NO_VYRE\.send\}/);
  assert.match(step, /writeSkipped\(true\)\.finally\(\(\) => router\.replace\("\/u\/now"/);
  assert.match(src, /offersNoVyre\(dk, MOCK\) \? <Button kind="ghost" label=\{NO_VYRE\.have\} onPress=\{\(\) => setStep\("novyre"\)\}/);
});
