// @ts-check
// `vyre statusline`: Vyre's line under every Claude Code session.
//
// A plugin cannot set statusLine; only the person's own settings.json can. So `install` writes it
// there, with their consent, and never over a status line they already have: `--chain` keeps
// theirs and puts Vyre's line under it. Every write keeps the other keys, and the first write
// leaves settings.json.vyre-backup next to it. `uninstall` undoes only what is Vyre's.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { call } from "../../daemon/client.js";
import { REPO } from "../../daemon/index.js";
import * as config from "../../config/index.js";
import { out, dim, signal, beacon } from "../style.js";

export const TEMPLATE = path.join(REPO, "harness", "statusline", "statusline.sh");

/** Claude Code's user settings, where statusLine lives. CLAUDE_CONFIG_DIR moves the whole folder. */
export const settingsPath = (env = process.env) =>
  path.join(env.CLAUDE_CONFIG_DIR ? config.untilde(env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude"), "settings.json");

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const files = home => ({ script: path.join(home, "statusline.sh"), line: path.join(home, "statusline"),
  prev: path.join(home, "statusline.prev"), prevJson: path.join(home, "statusline.prev.json"), declined: path.join(home, "statusline.declined") });

/** The statusLine command Vyre installs for a home. */
export const ours = home => `sh ${q(files(home).script)}`;
const isOurs = (sl, home) => Boolean(sl && typeof sl.command === "string" && sl.command.includes(files(home).script));

/**
 * settings.json as it is: { ok, exists, data } or { ok: false, why } when it does not parse.
 * @param {string} file
 */
export function readSettings(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) {
    if (/** @type {any} */ (e).code === "ENOENT") return { ok: true, exists: false, data: {} };
    return { ok: false, why: /** @type {Error} */ (e).message };
  }
  if (!text.trim()) return { ok: true, exists: true, data: {} };
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, why: "it is not a JSON object" };
    return { ok: true, exists: true, data };
  } catch (e) { return { ok: false, why: /** @type {Error} */ (e).message }; }
}

/** Write through a symlink (a dotfiles setup), by rename, keeping the file's mode. */
function writeSettings(file, data) {
  let real = file, mode = 0o644;
  try { real = fs.realpathSync(file); mode = fs.statSync(real).mode & 0o777; } catch { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  const tmp = `${real}.vyre-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  fs.renameSync(tmp, real);
}

function backup(file, exists) {
  if (exists) fs.copyFileSync(fs.realpathSync(file), `${file}.vyre-backup`);
}

/** The script copy with this home baked in. Rewritten only when it differs. */
function writeScript(home) {
  const f = files(home).script;
  const text = fs.readFileSync(TEMPLATE, "utf8").replace("'@VYRE_HOME@'", q(home));
  let now = null;
  try { now = fs.readFileSync(f, "utf8"); } catch {}
  if (now !== text) { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(f, text, { mode: 0o755 }); }
}

const terminal = {
  get tty() { return Boolean(process.stdin.isTTY && process.stdout.isTTY); },
  async ask(/** @type {string} */ question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question(question)).trim(); } finally { rl.close(); }
  },
};

/** @typedef {{ tty: boolean, ask(q: string): Promise<string> }} IO */
/** @typedef {{ env?: NodeJS.ProcessEnv, home?: string, io?: IO }} Deps */

/**
 * @param {string[]} args
 * @param {Deps} [deps]
 * @returns {Promise<number>}
 */
export async function install(args, deps = {}) {
  const env = deps.env || process.env, home = deps.home || config.home(), io = deps.io || terminal;
  const chain = args.includes("--chain"), yes = args.includes("--yes") || args.includes("-y");
  const file = settingsPath(env), f = files(home);
  const s = readSettings(file);
  if (!s.ok) { out(beacon(`  ${file} does not parse (${s.why}). Nothing was changed.`)); return 1; }
  const sl = s.data.statusLine;
  if (isOurs(sl, home)) { writeScript(home); out(`  Vyre's status line is already installed ${dim("· " + file)}`); return 0; }
  const theirs = sl && typeof sl === "object" && typeof sl.command === "string" && sl.command.trim() ? sl.command : null;
  if (sl && !chain) {
    out(`  you already have a status line; ${signal("vyre statusline install --chain")} keeps it and adds Vyre's line under it`);
    if (theirs) out(dim(`  yours: ${theirs}`));
    return 0;
  }
  if (sl && !theirs) { out(beacon("  your statusLine has no command to keep, so it cannot be chained. Nothing was changed.")); return 1; }

  const what = theirs ? `set Claude Code's status line to Vyre's, keeping yours above it (${file})` : `set Claude Code's status line to Vyre's (${file})`;
  if (!yes) {
    if (!io.tty) { out(`  would ${what}`); out(dim("  run it again with --yes to do it. Nothing was changed.")); return 0; }
    const a = await io.ask(`  ${what}? [y/N] `);
    if (!/^y(es)?$/i.test(a)) { out(dim("  Nothing was changed.")); return 0; }
  }
  writeScript(home);
  if (theirs) {
    fs.writeFileSync(f.prev, theirs + "\n", { mode: 0o600 });
    fs.writeFileSync(f.prevJson, JSON.stringify(sl) + "\n", { mode: 0o600 });
  }
  backup(file, s.exists);
  writeSettings(file, { ...s.data, statusLine: { type: "command", command: ours(home), padding: 0 } });
  fs.rmSync(f.declined, { force: true });
  out(signal("  installed") + ` Vyre's status line in ${file}${theirs ? dim(" · yours still shows, above it") : ""}`);
  if (s.exists) out(dim(`  the old file is in ${file}.vyre-backup`));
  out(dim("  it shows in new Claude Code sessions; vyre statusline uninstall takes it out"));
  return 0;
}

/**
 * @param {Deps} [deps]
 * @returns {Promise<number>}
 */
export async function uninstall(deps = {}) {
  const env = deps.env || process.env, home = deps.home || config.home();
  const file = settingsPath(env), f = files(home);
  const s = readSettings(file);
  if (!s.ok) { out(beacon(`  ${file} does not parse (${s.why}). Nothing was changed.`)); return 1; }
  const sl = s.data.statusLine;
  if (!sl) { out(`  no status line is installed ${dim("· " + file)}`); return 0; }
  if (!isOurs(sl, home)) { out(`  your status line is not Vyre's, so it stays ${dim("· " + file)}`); return 0; }
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(f.prevJson, "utf8")); } catch {}
  if (!prev) { try { const c = fs.readFileSync(f.prev, "utf8").trim(); if (c) prev = { type: "command", command: c }; } catch {} }
  const next = { ...s.data };
  if (prev) next.statusLine = prev; else delete next.statusLine;
  backup(file, true);
  writeSettings(file, next);
  for (const p of [f.script, f.prev, f.prevJson]) fs.rmSync(p, { force: true });
  out(signal("  removed") + ` Vyre's status line from ${file}${prev ? dim(" · yours is back") : ""}`);
  return 0;
}

/**
 * For `vyre up`: offer the status line once. Interactive asks y/N and remembers a no; otherwise it
 * prints the one command that would do it. Silent when Claude Code has no config folder, when it
 * is already installed, or after a no.
 * @param {{ interactive: boolean, env?: NodeJS.ProcessEnv, home?: string, io?: IO }} o
 * @returns {Promise<"installed"|"declined"|"offered"|"skipped">}
 */
export async function offerStatusline({ interactive, env = process.env, home = config.home(), io = terminal }) {
  const file = settingsPath(env), f = files(home);
  if (!fs.existsSync(path.dirname(file)) || fs.existsSync(f.declined)) return "skipped";
  const s = readSettings(file);
  if (!s.ok || isOurs(s.data.statusLine, home)) return "skipped";
  if (s.data.statusLine) {
    out(dim("  you already have a Claude Code status line; ") + "vyre statusline install --chain" + dim(" adds Vyre's line under it"));
    return "offered";
  }
  if (!interactive || !io.tty) { out(dim("  Vyre can show what needs you under every Claude Code session: ") + "vyre statusline install"); return "offered"; }
  const a = await io.ask(`  Show Vyre's line under every Claude Code session? It edits ${file} [y/N] `);
  if (!/^y(es)?$/i.test(a)) { try { fs.writeFileSync(f.declined, new Date().toISOString() + "\n"); } catch {} out(dim("  ok. vyre statusline install does it later.")); return "declined"; }
  return (await install(["--yes"], { env, home, io })) === 0 ? "installed" : "skipped";
}

/** The line now: from vyred, or from the file it keeps when vyred does not answer. */
async function show(home = config.home()) {
  const r = await call("statusline.line", {}, { timeout: 3000 });
  if (!r.error && r.data && r.data.line) { out(`  ${r.data.line}`); return 0; }
  try {
    const [pid, line] = fs.readFileSync(files(home).line, "utf8").split("\n");
    // kill(0) would signal our own process group and always succeed.
    if (!(Number(pid) > 0)) throw new Error("no pid");
    process.kill(Number(pid), 0);
    if (line) { out(`  ${line}`); return 0; }
  } catch {}
  out(`  vyred is not running ${dim("· vyre up to start it")}`);
  return 1;
}

export default {
  name: "statusline", order: 70, usage: "vyre statusline [install|uninstall]",
  summary: "Vyre's line under every Claude Code session",
  async run(/** @type {string[]} */ args) {
    const [verb, ...rest] = args;
    if (!verb) return show();
    if (verb === "install") return install(rest);
    if (verb === "uninstall") return uninstall();
    out("  vyre statusline [install [--chain] [--yes] | uninstall]");
    return 1;
  },
};
