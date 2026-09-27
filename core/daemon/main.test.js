// @ts-check
// vyred's foreground entry (core/daemon/main.js): a stop that arrives while it is still starting
// drains and exits 0, instead of the signal killing it half started (ADR 0029, R7).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../test/helpers.js";
import * as config from "../config/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, "main.js");
const FAKE_TAILSCALE = path.join(HERE, "..", "..", "deck", "test", "fake-tailscale.js");
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** @param {string} root @param {number} after ms before the SIGTERM */
async function stopAfter(root, after) {
  const env = { ...process.env, VYRE_HOME: root, VYRE_NO_DIALOGS: "1", ...(fs.existsSync(FAKE_TAILSCALE) ? { VYRE_TAILSCALE_BIN: FAKE_TAILSCALE } : {}) };
  const p = spawn(process.execPath, [MAIN], { env, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  p.stderr.on("data", d => { err += d; });
  const exited = new Promise(r => p.on("exit", (code, signal) => r({ code, signal })));
  await sleep(after);
  p.kill("SIGTERM");
  const r = /** @type {{ code: number|null, signal: string|null }} */ (await exited);
  return { ...r, err };
}

test("main: SIGTERM while vyred is still starting drains and exits 0, leaving no socket", { timeout: 30_000 }, async t => {
  // Early (while its modules load and start) and late (once it is up): both are a clean stop.
  for (const after of [150, 400, 2_500]) {
    const root = tempHome(t);
    const r = await stopAfter(root, after);
    assert.deepEqual([r.code, r.signal], [0, null], `SIGTERM after ${after} ms: ${r.err}`);
    assert.ok(!fs.existsSync(config.paths(root).socket), `the socket outlived vyred (SIGTERM after ${after} ms)`);
  }
});
