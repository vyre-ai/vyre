// @ts-check
// Only first-party modules may reach another machine. An added module, a model or an agent is refused for every tool that carries a call to a server, before anything is forwarded.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

const CARRIERS = [["wink.server.call", { tool: "system.info", input: {} }], ["wink.server.home", {}]];

test("only first-party modules reach another machine: model callers, hooks and added modules are refused before the pairing check", { timeout: 90_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", machine: "device", transcripts: [] }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const open = [];
  for (const caller of ["module:zz-added", "module:added", "mcp", "mcp:agent:kit", "mcp:agent:", "harness", "session:mcp:agent:kit", "session:harness:agent:kit", "agent:kit", "hook", "anonymous", "unknown"]) {
    for (const [tool, input] of CARRIERS) {
      const r = await d.registry.call(tool, input, caller);
      if (!(r.error && r.error.code !== "no_link" && r.error.code !== "unpaired")) open.push(`${caller} ${tool}: ${r.error ? r.error.code : "OK"}`);
    }
  }
  assert.deepEqual(open, []);
  // Vyre's own modules and the person's own surface still get as far as the pairing check.
  for (const caller of ["module:planner", "module:files", "cli"]) {
    assert.equal((await d.registry.call("wink.server.call", { tool: "system.info", input: {} }, caller)).error.code, "no_link", caller);
  }
});
