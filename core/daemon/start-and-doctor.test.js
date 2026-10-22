// @ts-check
// A real vyred (core/daemon/main.js, the process `vyre up` starts) comes up with no warnings, and `vyre doctor` then runs to the end: 0 errors, 0 retries, no call over 2 s. A slow call or a retry stamped at or before "vyred ... up" is warmup and is not counted; an error still is.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "../../test/helpers.js";
import * as config from "../config/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, "main.js");
const BIN = path.resolve(HERE, "../../bin/vyre");
const FAKE_TAILSCALE = path.join(HERE, "..", "..", "web", "test", "fake-tailscale.js");

/** @param {string} root @param {string[]} args */
const doctor = (root, args) => new Promise(res => {
  execFile(process.execPath, [BIN, "doctor", ...args], { env: { ...process.env, VYRE_HOME: root, VYRE_NO_DIALOGS: "1" }, timeout: 30_000 }, (e, stdout, stderr) => {
    res({ code: e && /** @type {any} */ (e).code, stdout: String(stdout || ""), stderr: String(stderr || "") });
  });
});

test("start and doctor: the real daemon's start log has no warnings, and doctor counts only what happens after warmup", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ machine: "server", transcripts: [], vault: { keystore: "file" } }));
  const env = { ...process.env, VYRE_HOME: root, VYRE_NO_DIALOGS: "1", ...(fs.existsSync(FAKE_TAILSCALE) ? { VYRE_TAILSCALE_BIN: FAKE_TAILSCALE } : {}) };
  const child = spawn(process.execPath, [MAIN], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", d => { stderr += d; });
  /** @type {{ code: number | null, signal: NodeJS.Signals | null } | null} */
  let gone = null;
  const exited = new Promise(r => child.on("exit", (code, signal) => { gone = { code, signal }; r(gone); }));
  const logFile = path.join(config.paths(root).logs, new Date().toISOString().slice(0, 10) + ".log");
  const end = Date.now() + 120_000;
  let text = "";
  while (Date.now() < end && !gone) {
    try { text = fs.readFileSync(logFile, "utf8"); } catch { text = ""; }
    if (/vyred \S+ up /.test(text)) break;
    await new Promise(r => setTimeout(r, 250));
  }
  assert.match(text, /vyred \S+ up · role box /, `vyred did not come up as a server\n${text.slice(-1500)}\n${stderr.slice(-1500)}`);
  const warns = text.split("\n").filter(l => /\bwarn:/.test(l));
  assert.deepEqual(warns, [], `start log warnings\n${stderr.slice(-1500)}`);
  assert.doesNotMatch(stderr, /ExperimentalWarning|SQLite is an experimental feature/);
  const first = /** @type {{ code: number | null, stdout: string, stderr: string }} */ (await doctor(root, []));
  assert.match(first.stdout, /Server log, last 24 h/, `doctor did not reach the log\n${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /errors: 0(?:\D|$)/);
  assert.match(first.stdout, /retries: 0(?:\D|$)/);
  assert.match(first.stdout, /slow calls over 2 s: 0(?:\D|$)/);
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise(r => setTimeout(r, 8_000))]);
  if (!gone) { try { child.kill("SIGKILL"); } catch { /* already gone */ } await Promise.race([exited, new Promise(r => setTimeout(r, 2_000))]); }
  text = fs.readFileSync(logFile, "utf8");
  const up = text.split("\n").find(l => /^(\d{4}-\d\d-\d\dT[\d:.]+Z) vyred \S+ up /.test(l));
  assert.ok(up, "the up line");
  const stamp = up.slice(0, up.indexOf(" "));
  const later = new Date(Date.parse(stamp) + 1000).toISOString();
  const extra = [
    `${stamp} warn: slow call files.list took 2500 ms`,
    `${stamp} relay: the route moved; retrying in 1 s`,
    `${stamp} error: the store did not open`,
    up,
    `${later} warn: slow call threads.send took 3100 ms`,
    `${later} relay: another try; retrying in 1 s`,
    "",
  ].join("\n");
  fs.writeFileSync(logFile, text.replace(up, () => extra.trimEnd()));
  const second = /** @type {{ code: number | null, stdout: string, stderr: string }} */ (await doctor(root, []));
  assert.match(second.stdout, /Server log, last 24 h/, second.stdout + second.stderr);
  assert.match(second.stdout, /errors: 1(?:\D|$)/);
  assert.match(second.stdout, /slow calls over 2 s: 1(?:\D|$)/);
  assert.match(second.stdout, /retries: 1(?:\D|$)/);
});
