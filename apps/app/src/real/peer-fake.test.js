// @ts-check
// The wire stand-in (peer.ts setPeerFake) works only in a build made for the proof. In any other build the call is ignored, so a release cannot be given a fake wire.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("a build without the proof flag ignores setPeerFake and leaves no marker", { skip: !strip }, async () => {
  delete process.env.EXPO_PUBLIC_VYRE_PROOF;
  delete (/** @type {any} */ (globalThis)).__vyrePeerFake;
  const m = await import("./peer.ts?plain");
  m.setPeerFake(async () => ({}));
  assert.equal(m.peerFakeActive(), false);
  assert.equal(/** @type {any} */ (globalThis).__vyrePeerFake, undefined);
});

test("only EXPO_PUBLIC_VYRE_PROOF=1 turns it on", { skip: !strip }, async () => {
  process.env.EXPO_PUBLIC_VYRE_PROOF = "1";
  const m = await import("./peer.ts?proof");
  m.setPeerFake(async () => ({}));
  assert.equal(m.peerFakeActive(), true);
  m.setPeerFake(null);
  assert.equal(m.peerFakeActive(), false);
  delete process.env.EXPO_PUBLIC_VYRE_PROOF;
  delete (/** @type {any} */ (globalThis)).__vyrePeerFake;
});

test("the proof page and the app workflow are gated the same way: the page draws nothing without the flag, the release export is checked for the marker, the proof runs on its own export", () => {
  const page = fs.readFileSync(new URL("../../app/two-servers-proof.tsx", import.meta.url), "utf8");
  assert.match(page, /process\.env\.EXPO_PUBLIC_VYRE_PROOF === "1" \? <TwoServersProof \/> : null/);
  const wf = fs.readFileSync(new URL("../../../../.github/workflows/app.yml", import.meta.url), "utf8");
  assert.match(wf, /EXPO_PUBLIC_VYRE_PROOF=1 npx expo export -p web --output-dir dist-proof/);
  assert.match(wf, /two-server-proof\.mjs --dist dist-proof/);
  assert.match(wf, /grep -rl "vyre-peer-fake-enabled" dist\b/, "the release web export is searched for the marker");
  assert.match(wf, /grep -rl "vyre-peer-fake-enabled" "\$RUNNER_TEMP\/apk"/, "the release APK is searched for it");
  assert.match(wf, /grep -rl "vyre-peer-fake-enabled" "\$app"/, "and the iOS release build");
  assert.match(wf, /EXPO_PUBLIC_VYRE_PROOF=1 npx expo export -p \$os --output-dir "dist-hermes-\$os"/, "a flagged Hermes bundle must SHOW the marker (the positive control)");
});
