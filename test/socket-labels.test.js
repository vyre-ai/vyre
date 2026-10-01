// Which labels a socket client may carry. A label is only a claim: "module:<name>" is what the registry uses
// between modules, and a bare "module" (no colon) used to read as a module through callerKind, which skips the
// presence check and satisfies a callers list that names module (reviewer-2, 2 Oct 2026). Every odd spelling
// is tried over the real socket against a presence-required tool, a tool whose callers list names module, and
// a tool open to modules only: none may run as a module. Boots a daemon: a runner or the test box.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

function call(socket, tool, label, input = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(input);
    const req = http.request({ socketPath: socket, path: `/v1/tools/${tool}`, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-vyre-caller": label } }, res => {
      let out = ""; res.on("data", c => (out += c)); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(out) }); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.end(data);
  });
}

/** Claim-carrying spellings: kept for route() to refuse or to rewrite to a nameless session, never a person, never a module. */
const CLAIMS = ["module agent:x", "module:agent:x", "module thread:x", "hook thread:x", "hook agent:x", "tailnet thread:x", "onboard thread:x", "link thread:x", "device thread:x", "cli:agent:x", "cli thread:x", "mcp thread:x", "CLI:AGENT:x"];
const LABELS = ["module", "Module", "MODULE", "module ", " module", "module:", "module:x", "module:vyred", "modules", "internal", "hook", "onboard", "link:box", "tailnet:alex@example.com", "device:abcdefghijklmnop", "anonymous", "vyred", "system", "core", "kernel", "root", "unknown", "harness", "mcp", "agent", "service"];

test("no odd socket label runs as a module: not a presence skip, not a module-only tool, not a callers list that names module", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const socket = d.paths.socket;
  const tools = [["presence.remove", { id: "x" }], ["sync.send", { files: [], mode: "once" }], ["projects.reach", { caller: "cli" }], ["projects.access.clear", { agent: "kit" }]];
  for (const label of [...LABELS, ...CLAIMS]) {
    for (const [tool, input] of tools) {
      const r = await call(socket, tool, label, input);
      // Refused before the tool ran: a bad_input, an internal error or a 200 would mean the tool was reached.
      assert.ok(r.status >= 400 && ["denied", "presence_required", "no_such_tool", "person_session_required", "not_found"].includes(r.body.error && r.body.error.code), `${JSON.stringify(label)} on ${tool}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
  }
});
