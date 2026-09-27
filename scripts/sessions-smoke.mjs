#!/usr/bin/env node
// @ts-check
// sessions-smoke: the Agent SDK's bundled Claude Code starts, initialises and idles (ADR 0030).
//
//   VYRE_SESSIONS_SDK_DIR=<dir with the pinned SDK, installed WITH its optional binary> node scripts/sessions-smoke.mjs
//
// No credentials, no turn, no API call: a temp HOME and CLAUDE_CONFIG_DIR, and the process is
// only asked to initialise. Prints JSON (init time, RSS and CPU of the child after IDLE_MS) and
// exits non-zero if the SDK is missing, the binary is missing, or it does not initialise.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installed, load, bundledBinary, VERSION } from "../core/sessions/sdk.js";
import { run } from "../core/sessions/claude.js";

const dir = process.env.VYRE_SESSIONS_SDK_DIR || "";
const IDLE_MS = Number(process.env.IDLE_MS || 10_000);
const fail = why => { console.error(`sessions-smoke: ${why}`); process.exit(1); };
if (!dir || !installed(dir, { bundled: true })) fail(`no SDK ${VERSION} with its bundled Claude Code in VYRE_SESSIONS_SDK_DIR (${dir || "unset"})`);
const sdk = await load(dir);
if (!sdk) fail("the SDK did not load");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-sessions-smoke-"));
const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude") };
/** RSS in MB and CPU seconds of a pid, Linux only (elsewhere null). */
const stat = pid => {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    const rss = Number(fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)?.[1] || 0) / 1024;
    return { rss_mb: Math.round(rss), cpu_s: (Number(s[11]) + Number(s[12])) / 100 };
  } catch { return null; }
};

let group = null, exited = false;
const t0 = Date.now();
const s = run(sdk, { id: crypto.randomUUID(), cwd: home, env, bin: bundledBinary(dir), settings: false, onSpawn: g => { group = g; },
  onMessage: () => {}, onExit: () => { exited = true; } });
// Initialise without a turn: the SDK sends initialize when its query starts reading input.
const out = { version: VERSION, binary: bundledBinary(dir) };
try {
  const q = /** @type {any} */ (s);
  await new Promise(r => setTimeout(r, 200));
  out.spawned = Boolean(group);
  const until = Date.now() + 20_000;
  while (!group && Date.now() < until) await new Promise(r => setTimeout(r, 50));
  out.init_ms = Date.now() - t0;
  const a = group && stat(group.pid);
  await new Promise(r => setTimeout(r, IDLE_MS));
  const b = group && stat(group.pid);
  out.idle = a && b ? { rss_mb: b.rss_mb, cpu_pct: +((100 * (b.cpu_s - a.cpu_s)) / (IDLE_MS / 1000)).toFixed(2) } : null;
  out.alive = !exited;
  await q.stop(2000);
} finally { fs.rmSync(home, { recursive: true, force: true }); }
console.log(JSON.stringify(out, null, 2));
process.exit(out.spawned && out.alive ? 0 : 1);
