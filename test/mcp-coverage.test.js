// @ts-check
// An onboarding, device or invite tool the screens call must be a kernel tool an MCP caller can
// reach. The scanner is the same one the Needs-you hold uses, so the two cannot drift.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { surfaceNames } from "../lib/surface-tools.js";
import { offeredTool } from "../harness/mcp/offered.js";

test("every onboarding, device and invite tool is offered through MCP", async (t) => {
  const names = surfaceNames();
  for (const extra of ["onboard.machine", "onboard.windows", "releases.info"]) {
    assert.ok(names.includes(extra), `${extra} is part of the surface`);
  }
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const offered = new Set(d.registry.listTools("mcp").filter((x) => offeredTool(x)).map((x) => x.name));
  const missing = [];
  for (const name of names) {
    if (!d.registry.tools.has(name)) continue;
    if (!offered.has(name)) missing.push(name);
  }
  assert.deepEqual(missing, [], `not offered via MCP: ${missing.join(", ")}`);
});
