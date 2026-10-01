// A socket client that claims to be an agent on a surface label gets none of that agent's powers. The daemon
// refuses a claim without the agent's key at the door; a claim spelled so the door misses (upper case) is
// neutralised by the registry (canonicalCaller), so a label that names the assistant grants nothing. Boots a
// daemon: runs on a runner or the test box.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

function call(socket, tool, headers) {
  return new Promise((resolve, reject) => {
    const data = "{}";
    const req = http.request({ socketPath: socket, path: `/v1/tools/${tool}`, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } }, res => {
      let out = ""; res.on("data", c => (out += c)); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(out) }); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("a socket client claiming cli:agent:assistant gets none of the assistant's powers", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {}, presence: present });
  t.after(() => d.stop());
  assert.ok(!(await d.registry.call("agents.create", { name: "juno", kind: "assistant" }, "local")).error);
  assert.ok(!(await d.registry.call("agents.create", { name: "kit" }, "local")).error);
  const socket = d.paths.socket;
  // The person at a terminal lists agents; that is the baseline.
  assert.equal((await call(socket, "agents.list", { "x-vyre-caller": "cli" })).status, 200);
  // Every claim spelling: refused at the door or neutralised, never the assistant.
  for (const label of ["cli:agent:juno", "local:agent:juno", "capsule:agent:juno", "cli agent:juno", "mcp:agent:juno", "harness:agent:juno", "CLI:AGENT:juno", "Cli:Agent:juno", "cli:thread:t1:agent:juno"]) {
    const r = await call(socket, "agents.list", { "x-vyre-caller": label });
    assert.notEqual(r.status, 200, `${label}: ${JSON.stringify(r.body).slice(0, 160)}`);
  }
  // And the assistant's own powers by tool: it may drive other agents; a claim of it may not.
  for (const label of ["cli:agent:juno", "CLI:AGENT:juno", "cli agent:juno"]) {
    const r = await call(socket, "agents.update", { "x-vyre-caller": label });
    assert.notEqual(r.status, 200, label);
  }
});
