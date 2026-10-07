// @ts-check
// The artifact frame: the sandbox it gets, and what it shows once the page has sent it somewhere else.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import fs from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("the sandbox is scripts only: no same origin, top navigation, popups, forms or modals", { skip: !strip }, async () => {
  const m = await import("./more-model.ts");
  assert.equal(m.FRAME_SANDBOX, "allow-scripts");
  for (const flag of ["allow-same-origin", "allow-top-navigation", "allow-popups", "allow-forms", "allow-modals"]) assert.ok(!m.FRAME_SANDBOX.includes(flag), flag);
  const src = fs.readFileSync(new URL("./ArtifactFrame.web.tsx", import.meta.url), "utf8");
  assert.match(src, /sandbox: FRAME_SANDBOX/, "the web frame uses the one sandbox string");
  const code = src.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  assert.ok(!/allow-same-origin|allow-top-navigation|allow-popups/.test(code), "no weaker flag is written in the frame");
  assert.match(src, /referrerPolicy: "no-referrer"/);
});

test("the first load is the artifact; a second load blanks the frame and stays blank", { skip: !strip }, async () => {
  const m = await import("./more-model.ts");
  let s = m.frameStart();
  assert.deepEqual(s, { loads: 0, left: false });
  s = m.frameLoaded(s);
  assert.deepEqual(s, { loads: 1, left: false });
  s = m.frameLoaded(s);
  assert.equal(s.left, true);
  const again = m.frameLoaded(s);
  assert.equal(again, s, "once left, further loads change nothing");
  assert.equal(m.BLANK_FRAME_TEXT, "This page tried to open another site");
});

test("the web frame shows the blank line instead of the iframe once it has left, and reports it once", { skip: !strip }, () => {
  const src = fs.readFileSync(new URL("./ArtifactFrame.web.tsx", import.meta.url), "utf8");
  assert.match(src, /if \(state\.left\) return[^;]*BLANK_FRAME_TEXT/, "the iframe is not rendered once left");
  assert.match(src, /onLoad: \(\) => setState\(frameLoaded\)/);
  assert.match(src, /if \(state\.left\) onLeft\?\.\(\)/);
  assert.match(src, /setState\(frameStart\(\)\)/, "a new version starts over");
});
