// @ts-check
// The outbound test hook (lib/http.js testHooks.fetch) works in a test process and is inert anywhere else: a process that did not load the test guard cannot set it, and what it would redirect stays real.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { testHooks } from "./http.js";

test("in a test process the hook can be set and read, and clearing it restores nothing", () => {
  const f = async () => new Response("x");
  testHooks.fetch = f;
  assert.equal(testHooks.fetch, f);
  testHooks.fetch = null;
  assert.equal(testHooks.fetch, null);
});

test("outside a test process, setting the hook throws and reading it is null", () => {
  const code = `import("${new URL("./http.js", import.meta.url).href}").then(({ testHooks }) => {
    let refused = false;
    try { testHooks.fetch = async () => new Response("x"); } catch { refused = true; }
    process.stdout.write(JSON.stringify({ refused, read: testHooks.fetch }));
  });`;
  const out = JSON.parse(execFileSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } }));
  assert.deepEqual(out, { refused: true, read: null });
});
