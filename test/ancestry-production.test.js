import "../scripts/mac-test-guard.mjs";
// @ts-check
// The production peer read: a real vyred in its own process (core/daemon/main.js), 50 concurrent real CLI-labelled calls from this process's children on a busy box, all classified the same
// way and none refused as "not available to mcp callers" because a peer read ran late. The probe is signin.ask, a cli/local-only tool: a call taken as cli answers `no_terminal` or `unavailable`
// (it has no login to name), one demoted to a model's shell answers `denied`. A call whose peer could not be read after the bounded retries says "could not tell who is calling" instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";
import * as config from "../core/config/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, "..", "core", "daemon", "main.js");
const FAKE_TAILSCALE = path.join(HERE, "..", "web", "test", "fake-tailscale.js");
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/** @param {string} socketPath */
const ask = socketPath => new Promise(resolve => {
  const req = http.request({ socketPath, path: "/v1/tools/signin.ask", method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": 2, "x-vyre-caller": "cli" } }, res => {
    let b = ""; res.on("data", c => { b += c; }); res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({ error: { code: "bad_response", message: b.slice(0, 80) } }); } });
  });
  req.on("error", e => resolve({ error: { code: "unreachable", message: String(e.message) } })); req.end("{}");
});

test("50 concurrent real CLI calls on a busy box, through the production peer read, are all classified alike and none is refused for a late helper", { timeout: 300_000, skip: process.platform === "win32" }, async t => {
  const root = tempHome(t);
  const env = { ...process.env, VYRE_HOME: root, VYRE_NO_DIALOGS: "1", VYRE_KERNEL: "1", VYRE_SEAL_DEV: "1", VYRE_KERNEL_PATH_RULE: "1", ...(fs.existsSync(FAKE_TAILSCALE) ? { VYRE_TAILSCALE_BIN: FAKE_TAILSCALE } : {}) };
  const daemon = spawn(process.execPath, [MAIN], { env, stdio: "ignore" });
  t.after(() => { daemon.kill("SIGTERM"); });
  const socket = config.paths(root).socket;
  for (let i = 0; i < 300 && !fs.existsSync(socket); i++) await sleep(100);
  assert.ok(fs.existsSync(socket), "the daemon came up");
  for (let i = 0; i < 100; i++) { const r = /** @type {any} */ (await ask(socket)); if (!(r.error && r.error.code === "unreachable")) break; await sleep(100); }
  const burners = Array.from({ length: Number(process.env.VYRE_DET_BURN || 6) }, () => spawn(process.execPath, ["-e", "const t=Date.now();while(Date.now()-t<90000){}"], { stdio: "ignore" }));
  t.after(() => burners.forEach(b => b.kill("SIGKILL")));
  const answers = /** @type {any[]} */ (await Promise.all(Array.from({ length: 50 }, () => ask(socket))));
  /** @type {Record<string, number>} */ const counts = {};
  for (const a of answers) { const k = a.error ? a.error.code : "ok"; counts[k] = (counts[k] || 0) + 1; }
  if (process.env.VYRE_DET_SHOW) console.error("classes:", JSON.stringify(counts));
  assert.equal(counts.denied || 0, 0, "no call was demoted to a model's shell: " + JSON.stringify(counts));
  assert.equal(Object.keys(counts).length, 1, "every call was classified the same: " + JSON.stringify(counts));
});
