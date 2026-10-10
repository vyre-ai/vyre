// @ts-check
// The golden refresh of 10 Oct found names.domain.check (a live DNS lookup the server makes) open to every caller, an anonymous one included, with no ruling behind it. It is for the person's surfaces.
// A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present, asOwner } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

test("names.domain.check answers the person's surfaces and refuses everyone else", { timeout: 180_000 }, async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box" }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  for (const who of ["anonymous", "tailnet-guest", "unknown", "onboard", "mcp", "harness", "mcp:agent:kit"]) {
    const r = await d.registry.call("names.domain.check", { domain: "firm.example.test" }, who, {});
    assert.equal(r.error && r.error.code, "denied", who);
  }
  const mine = await d.registry.call("names.domain.check", { domain: "firm.example.test" }, "cli", {});
  assert.notEqual(mine.error && mine.error.code, "denied", "the person's own surface is not refused");
});
