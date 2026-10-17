// @ts-check
// The "wink" path fact is the kernel's mark that a call came through the owner's verified direct (tailnet) node, and it carries the device enrolment exemption. Only the daemon's own door builder may set
// it: no other chain builder may write `path: "wink"` on a device's facts, or it would inherit that exemption (review of 014f04a12). This scans the source for any other place that does.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
/** The files that may say it: the daemon's kernelFactsFor (the one builder), and the wink host that decides which leg a call came in on. */
const ALLOWED = new Set(["core/daemon/index.js", "core/wink/node/host.js"]);

test("only the daemon's door builder sets the wink path fact on a device", () => {
  const files = execFileSync("git", ["ls-files", "kernel", "core", "lib", "local", "modules", "box", "relay", "harness", "scripts"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(f => /\.(js|mjs|ts)$/.test(f) && !/\.test\.(js|mjs)$/.test(f) && !/\.d\.ts$/.test(f) && !f.includes("/vendor/") && !f.includes("/testing/"));
  const hits = [];
  for (const f of files) {
    if (ALLOWED.has(f)) continue;
    let text; try { text = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    // `path: "wink"` in facts, or a conditional that yields it (`? "relay" : "wink"`)
    if (/\bpath:\s*["']wink["']/.test(text) || /["']relay["']\s*:\s*["']wink["']/.test(text)) hits.push(f);
  }
  // an e2e script of the stream's own fakes names it for its fake kernel, outside the daemon: listed so a new one is noticed
  const known = ["core/stream/e2e-step7-vyred.js"];
  assert.deepEqual(hits.filter(f => !known.includes(f)), [], "another file builds a device chain with path wink: only core/daemon/index.js may");
  assert.ok(ALLOWED.size === 2 && fs.readFileSync(path.join(ROOT, "core/daemon/index.js"), "utf8").includes('"wink"'), "the one builder is still where this test expects it");
});
