// @ts-check
// cli — the `vyre` command. Everything the Deck can do, this can do (docs/SPEC.md, principle 6).
//
// It is a thin client: every command is a call to vyred, so the terminal and the web app can
// never disagree about what is true.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import * as config from "../config/index.js";
import { request, call } from "../daemon/client.js";
import { REPO, VERSION, ping } from "../daemon/index.js";

const tty = process.stdout.isTTY;
const dim = s => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const signal = s => (tty ? `\x1b[38;2;198;243;107m${s}\x1b[0m` : s);
const beacon = s => (tty ? `\x1b[38;2;255;122;89m${s}\x1b[0m` : s);
const out = (...a) => console.log(...a);

const HELP = `
  vyre ${VERSION}

  vyre up                 start vyred on this machine
  vyre down               stop it
  vyre status             is it running, and what is it running
  vyre modules            every module and whether it started
  vyre tools              every tool Claude and the surfaces can call
  vyre call <tool> [json] run a tool, e.g. vyre call system.echo '{"text":"hi"}'
  vyre help               this
`;

/** Start vyred detached and wait until it answers, or report why it did not. */
async function up() {
  const p = config.ensure();
  if (await ping(p.socket)) { out(`  vyred is already running ${dim("· " + p.socket)}`); return 0; }
  const logFile = path.join(p.logs, "vyred.out");
  const fd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [path.join(REPO, "core", "daemon", "main.js")], {
    detached: true, stdio: ["ignore", fd, fd], env: process.env,
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await ping(p.socket)) { out(`  vyred ${signal("running")} ${dim("· pid " + child.pid)}`); return 0; }
    if (child.exitCode !== null) break;
  }
  out(`  vyred did not start. Its output is in ${logFile}:`);
  try { out(dim(fs.readFileSync(logFile, "utf8").split("\n").slice(-8).join("\n"))); } catch {}
  return 1;
}

async function down() {
  const p = config.paths();
  let pid = 0;
  try { pid = Number(fs.readFileSync(p.pid, "utf8")); } catch {}
  if (!pid || !(await ping(p.socket))) { out("  vyred is not running"); return 0; }
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (!(await ping(p.socket))) { out("  vyred stopped"); return 0; }
  }
  out(beacon("  vyred did not stop within 5 seconds") + dim(` · pid ${pid}`));
  return 1;
}

async function status() {
  const h = await request("GET", "/v1/health");
  if (h.error) { out(`  vyred ${beacon("not running")} ${dim("· vyre up to start it")}`); return 1; }
  const d = h.data;
  out(`  vyred ${signal("running")} ${dim(`· ${d.version} · ${d.role} · pid ${d.pid} · up ${Math.round(d.uptime / 1000)}s`)}`);
  out(`  ${d.modules.running} modules running${d.modules.failed ? beacon(` · ${d.modules.failed} failed (vyre modules)`) : ""}`);
  return 0;
}

async function modules() {
  const r = await request("GET", "/v1/modules");
  if (r.error) { out("  " + r.error.message); return 1; }
  for (const m of r.data) {
    const state = m.state === "running" ? signal(m.state) : ["failed", "invalid"].includes(m.state) ? beacon(m.state) : dim(m.state);
    out(`  ${String(m.name).padEnd(20)} ${String(m.version || "").padEnd(8)} ${state}${m.error ? dim("  " + m.error) : ""}`);
  }
  return 0;
}

async function tools() {
  const r = await request("GET", "/v1/tools");
  if (r.error) { out("  " + r.error.message); return 1; }
  for (const t of r.data) out(`  ${t.name.padEnd(28)} ${dim(t.description)}`);
  return 0;
}

async function callTool(name, json) {
  if (!name) { out("  vyre call <tool> [json]"); return 1; }
  let input = {};
  if (json) { try { input = JSON.parse(json); } catch { out("  the input must be JSON"); return 1; } }
  const r = await call(name, input);
  if (r.error) { out(beacon(`  ${r.error.code}: `) + r.error.message); return 1; }
  out(JSON.stringify(r.data, null, 2));
  return 0;
}

/** @param {string[]} argv */
export async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined: case "status": return status();
    case "up": return up();
    case "down": return down();
    case "modules": return modules();
    case "tools": return tools();
    case "call": return callTool(rest[0], rest[1]);
    case "version": case "--version": case "-v": out(VERSION); return 0;
    case "help": case "--help": case "-h": out(HELP); return 0;
    default: out(`  vyre ${cmd}: not a command`); out(HELP); return 1;
  }
}
