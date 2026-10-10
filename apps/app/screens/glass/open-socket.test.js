// @ts-check
// GlassFrame's `openSocket` prop (the type declares it, the emulator proof page passes it): the native component must hand it to the socket shim, or the page's sockets go to the real box layer and fail at once
// (the Android proof showed "down 1006" for exactly that). A source-level check, because the component needs a WebView.
import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (/** @type {string} */ p) => fs.readFileSync(path.join(here, p), "utf8");

test("GlassFrame.native takes openSocket and uses it for the page's sockets before the box layer", () => {
  const src = read("GlassFrame.native.tsx");
  assert.match(src, /function GlassFrame\(\{[^}]*\bopenSocket\b[^}]*\}: GlassFrameProps\)/, "the component destructures openSocket");
  assert.match(src, /lazySocket\(\(p\) => Promise\.resolve\(openSocket \? openSocket\(p\) : socket\(p\)\), path\)/, "openSocket wins over the box layer");
  assert.match(read("GlassFrame.d.ts"), /openSocket\?: \(path: string\) => any/, "the type declares it");
});

test("the proof page passes openSocket and says what its socket does; the fake screen server logs a plain request", () => {
  const page = fs.readFileSync(path.join(here, "../../app/glass-relay-proof.tsx"), "utf8");
  assert.match(page, /openSocket=\{/);
  assert.match(page, /glass-proof socket (open|error|close)/);
  const world = fs.readFileSync(path.join(here, "../../scripts/glass-relay-world.mjs"), "utf8");
  assert.match(world, /http probe/);
});
