// @ts-check
// vyre-tile on a real Mac, against two testwin windows this test opens unfocused and owns. Only
// those two pids are listed and moved, into a small region in the corner of the main display,
// and both windows close within two seconds. Runs only with VYRE_MAC_REAL=1 (the lead says when
// the Mac is free), the helpers built, and the Accessibility grant in place.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTile } from "./runner.js";
import { leftFrame, rightFrame } from "./layout.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TILE = path.join(HERE, "bin", "vyre-tile");
const TESTWIN = path.join(HERE, "..", "screen-mac", "bin", "testwin");

async function unavailable() {
  if (process.env.VYRE_MAC_REAL !== "1") return "set VYRE_MAC_REAL=1 when the Mac is free";
  if (process.platform !== "darwin") return "not macOS";
  if (!fs.existsSync(TILE) || !fs.existsSync(TESTWIN)) return "helpers not built; run local/sideview/build.sh and local/screen-mac/build.sh";
  try { return (await makeTile({ bin: TILE }).request({ cmd: "trust" })).trusted ? null : "no Accessibility grant"; }
  catch (e) { return String(/** @type {any} */ (e).code || e); }
}

/** A tiny testwin in the bottom-left corner, closed when the test ends (it exits on stdin EOF). */
async function testwin(t) {
  const p = spawn(TESTWIN, ["--title", "vyre-test", "--x", "0", "--y", "0", "--w", "120", "--h", "80"], { stdio: ["pipe", "pipe", "ignore"] });
  const kill = setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 2000);
  t.after(() => { clearTimeout(kill); p.stdin.end(); setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 300).unref(); });
  return new Promise((ok, no) => { p.stdout.once("data", d => ok(JSON.parse(String(d).split("\n")[0]))); p.once("error", no); });
}

test("real: two owned windows tiled into a corner region, left then right, edge to edge", async t => {
  const why = await unavailable();
  if (why) return t.skip(why);
  const tile = makeTile({ bin: TILE });
  const [a, b] = await Promise.all([testwin(t), testwin(t)]);
  const f = await tile.request({ cmd: "frames", bundles: [], pids: [a.pid, b.pid] });
  const wa = f.windows.find(w => w.pid === a.pid), wb = f.windows.find(w => w.pid === b.pid);
  assert.ok(wa && wb, "both test windows are listed");
  assert.equal(f.windows.every(w => w.pid === a.pid || w.pid === b.pid), true, "nothing else is listed");

  const main = f.screens[0].frame;
  const area = { x: main.x, y: main.y + main.h - 140, w: 700, h: 120 };
  const l = await tile.request({ cmd: "set", moves: [{ pid: wa.pid, index: wa.index, title: wa.title, frame: leftFrame(area, 0.29) }] });
  const la = l.results[0].frame;
  assert.equal(la.x, area.x);
  const r = await tile.request({ cmd: "set", moves: [{ pid: wb.pid, index: wb.index, title: wb.title, frame: rightFrame(area, la) }] });
  const ra = r.results[0].frame;
  assert.equal(ra.x, la.x + la.w, "no gap and no overlap");
  assert.equal(ra.x + ra.w <= area.x + area.w + 2 || r.results[0].exact === false, true);
});
