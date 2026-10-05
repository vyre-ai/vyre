// @ts-check
// HD-3 (reviewer-2): wink.server.call forwards a tool to the paired server as this device, so a model or an agent must never reach it.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

test("HD-3: wink.server.call is refused for every model and agent caller before anything is forwarded, and not for the person's own surfaces", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", transcripts: [] }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  for (const caller of ["mcp", "mcp:thread:t1", "mcp:agent:kit", "harness", "tailnet-guest:sam@harlow.example", "anonymous"]) {
    const r = await d.registry.call("wink.server.call", { tool: "artifacts.share", input: {} }, caller);
    assert.ok(r.error && r.error.code !== "no_link" && r.error.code !== "unpaired", `${caller}: refused for what it is, got ${r.error ? r.error.code : "OK"}`);
  }
  // the person's own surface gets as far as the pairing check (this Mac has no box)
  assert.equal((await d.registry.call("wink.server.call", { tool: "artifacts.share", input: {} }, "cli")).error.code, "no_link");
});
