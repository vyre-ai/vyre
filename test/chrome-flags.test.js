// @ts-check
// Hygiene: every Chrome a test, shot script or build launches carries the mock-keychain flags
// (lib/chrome-flags). Without them Chrome on macOS asks for the login Keychain and puts a real dialog
// on the user's screen. A file that launches Chrome must spread CHROME_SAFE or spell out both flags.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "docs", "docs-site", "vendor", "build", "dist"]);
const LAUNCH = /--remote-debugging-port|--headless|chromium\.launch\(|--user-data-dir/;
const OK = /CHROME_SAFE|--use-mock-keychain[\s\S]*--password-store=basic|--password-store=basic[\s\S]*--use-mock-keychain/;

/** Files that mention a Chrome flag without launching Chrome on the person's machine, each with why. */
const EXEMPT = {
  "lib/chrome-flags/index.js": "the flags themselves",
  "test/chrome-flags.test.js": "this test",
  "core/computers/image/computerd/index.js": "runs inside the agent's container, never on a Mac",
  "core/computers/image/computerd/index.test.js": "asserts on the container's Chrome arguments; launches nothing",
  "core/computers/image/computerd/cdpmux.test.js": "a fake CDP endpoint; launches nothing",
  "core/computers/image/entrypoint.sh": "runs inside the agent's container, never on a Mac",
  "core/computers/image/isolation.test.js": "reads the container's launch line; launches nothing",
  "core/computers/image/Dockerfile": "the container image",
  "core/computers/image/computerd/testing/fake-chrome.js": "a stand-in for the container's Chrome; launches nothing real",
};

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(path.join(dir, e.name)); continue; }
    if (/\.(js|mjs|cjs|sh)$/.test(e.name) || e.name === "design-audit") yield path.join(dir, e.name);
  }
}

test("every Chrome launch carries --use-mock-keychain and --password-store=basic", () => {
  const bad = [];
  for (const f of walk(ROOT)) {
    const rel = path.relative(ROOT, f);
    if (rel in EXEMPT || rel.startsWith("apps/app/") || rel.includes("/e2e-headscale/")) continue;
    const s = fs.readFileSync(f, "utf8");
    if (LAUNCH.test(s) && !OK.test(s)) bad.push(rel);
  }
  assert.deepEqual(bad, [], `launch Chrome through lib/chrome-flags (CHROME_SAFE): ${bad.join(", ")}`);
});
