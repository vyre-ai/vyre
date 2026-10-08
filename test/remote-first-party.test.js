// @ts-check
// Only first-party modules may reach another machine. An added module, a model or an agent is refused for every tool that carries a call to a server, a Mac or a peer, before anything is forwarded.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

const REFUSED = new Set(["denied", "undeclared", "forbidden", "not_allowed"]);

/** Every tool that carries a call to another machine, with an input that would be forwarded. */
const CARRIERS = [
  ["link.call", { tool: "system.info", input: {} }],
  ["link.remote", { tool: "system.info", input: {} }],
  ["link.upload", { upload: "11111111-1111-1111-1111-111111111111", offset: 0, data: "" }],
  ["link.macs.call", { tool: "system.info", input: {} }],
];

for (const config of [{ role: "local" }, { role: "box" }]) {
  test(`only first-party modules reach another machine (${config.role}): added modules and model callers are refused for every carrier`, { timeout: 90_000 }, async t => {
    const root = tempHome(t);
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ ...config, transcripts: [] }));
    const d = await start({ root, presence: present, log: () => {} });
    t.after(() => d.stop());
    const open = [];
    for (const caller of ["module:zz-added", "module:added", "mcp", "mcp:agent:kit", "harness", "session:mcp:agent:kit", "agent:kit", "hook", "anonymous", "unknown"]) {
      for (const [tool, input] of CARRIERS) {
        if (!d.registry.tools.has(tool)) continue;
        const r = await d.registry.call(tool, input, caller);
        if (!(r.error && (REFUSED.has(r.error.code) || r.error.code === "no_such_tool"))) open.push(`${caller} ${tool}: ${r.error ? r.error.code : "OK"}`);
      }
    }
    assert.deepEqual(open, []);
    // Vyre's own modules still get as far as the pairing check (Planner and Files reach the box this way).
    if (config.role === "local") for (const caller of ["module:planner", "module:files"]) {
      for (const [tool, input] of CARRIERS.slice(0, 2)) {
        const r = await d.registry.call(tool, input, caller);
        assert.ok(!(r.error && r.error.code === "denied"), `${caller} ${tool}: ${JSON.stringify(r)}`);
      }
    }
  });
}
