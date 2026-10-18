// @ts-check
// A key the hub gives a plugin's MCP server lives in that child's environment, and the child runs on the daemon side. A session in the real sandbox cannot read that environment, by pid or by looking through /proc,
// and its own environment does not hold the key. (sec53, Vault-backed env, condition 4a.)
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import "./testing/require-sandbox.js";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rig, waitFor, SKIP } from "./testing/runner-test-lib.js";

const MARKER = "fixture-plugin-key-4d3c2b1a-hidden";

test("a session cannot read a daemon-side child's environment, by pid or through /proc", { skip: SKIP || false, timeout: 90_000 }, async t => {
  // the hub's child: the daemon's user, the key in its environment only
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env: { PATH: process.env.PATH, NOTES_API_KEY: MARKER }, stdio: "ignore" });
  t.after(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
  const r = await rig(t);
  const h = await r.launch(r.runner, "s1");
  const events = /** @type {any[]} */ ([]);
  h.child.stdout.on("data", (/** @type {Buffer} */ d) => { for (const l of String(d).split("\n").filter(Boolean)) events.push(JSON.parse(l)); });
  h.send(`environ ${child.pid} ${MARKER}`);
  const e = await waitFor(() => events.find(x => x.type === "environ"), 60_000);
  assert.notEqual(e.byPid, "READ", "its environment is not readable by pid: " + JSON.stringify(e));
  assert.equal(e.anywhere, false, "and no /proc entry the session can see holds it");
  assert.equal(e.ownEnvHasIt, false, "the session's own environment does not hold it");
});
