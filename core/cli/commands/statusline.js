// @ts-check
// `vyre statusline`: Vyre's line under every Claude Code session.
//
// A plugin cannot set statusLine; only the person's own settings.json can. So `install` writes it
// there, with their consent, and never over a status line they already have: `--chain` keeps
// theirs and puts Vyre's line under it. Every write keeps the other keys, and the first write
// leaves settings.json.vyre-backup next to it. `uninstall` undoes only what is Vyre's.
//
// --json: show prints { line, from }; install and uninstall print { state, file, ... } where state
// is installed, already, offered, would, declined (install) or removed, none, not_ours
// (uninstall). Under --view install never asks on a terminal: it answers with a yes/no prompt
// frame whose args are the command to run on yes.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { call } from "../../daemon/client.js";
import { REPO } from "../../daemon/index.js";
import * as config from "../../config/index.js";
import { out, dim, signal, beacon } from "../style.js";
import { EXIT, json, emit, fail, failTool, usage, viewing } from "../kit.js";
import { prompt } from "../view.js";

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

/** Every verb run() handles, for `vyre commands --json`. `vyre statusline` alone shows the line. */
export const VERBS = [
  { verb: "show", summary: "the line as it is now (the default)", usage: "[--json]", read: true },
  { verb: "install", summary: "put Vyre's line under every Claude Code session; --chain keeps yours above it", usage: "[--chain] [--yes] [--json]" },
  { verb: "uninstall", summary: "take Vyre's line out, putting yours back", usage: "[--json]" },
];

/**
 * The end of install or uninstall: the words for a person, or one JSON value under --json.
 * @param {number} code @param {Record<string, any>} data @param {string[]} lines
 */
function report(code, data, lines) {
  if (json()) emit(data);
  else for (const l of lines) out(l);
  return code;
}

/** settings.json did not parse: nothing was changed. @param {string} file @param {string} why */
const unreadable = (file, why) => json()
  ? fail(`${file} does not parse (${why}). Nothing was changed.`, { code: "bad_settings", next: "fix the JSON, then run it again" })
  : (out(beacon(`  ${file} does not parse (${why}). Nothing was changed.`)), EXIT.FAILED);

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
  if (!s.ok) return unreadable(file, s.why);
  const sl = s.data.statusLine;
  if (isOurs(sl, home)) { writeScript(home); return report(0, { state: "already", file }, [`  Vyre's status line is already installed ${dim("· " + file)}`]); }
  const theirs = sl && typeof sl === "object" && typeof sl.command === "string" && sl.command.trim() ? sl.command : null;
  if (sl && !chain) {
    return report(0, { state: "offered", file, theirs, next: "vyre statusline install --chain" },
      [`  you already have a status line; ${signal("vyre statusline install --chain")} keeps it and adds Vyre's line under it`, ...(theirs ? [dim(`  yours: ${theirs}`)] : [])]);
  }
  if (sl && !theirs) {
    const why = "your statusLine has no command to keep, so it cannot be chained. Nothing was changed.";
    return json() ? fail(why, { code: "cannot_chain" }) : (out(beacon("  " + why)), 1);
  }

  const what = theirs ? `set Claude Code's status line to Vyre's, keeping yours above it (${file})` : `set Claude Code's status line to Vyre's (${file})`;
  if (!yes) {
    // A surface has no terminal to answer y/N on: it is asked as a prompt, and runs args on yes.
    if (viewing()) {
      emit({ state: "asked", file, what }, prompt({ name: "yes", label: what[0].toUpperCase() + what.slice(1) + "?", choices: ["yes", "no"],
        args: ["statusline", "install", ...(chain ? ["--chain"] : []), "--yes"] , answer: "confirm" }));
      return EXIT.USAGE;
    }
    if (!io.tty) return report(0, { state: "would", file, what, next: `vyre statusline install${chain ? " --chain" : ""} --yes` }, [`  would ${what}`, dim("  run it again with --yes to do it. Nothing was changed.")]);
    const a = await io.ask(`  ${what}? [y/N] `);
    if (!/^y(es)?$/i.test(a)) return report(0, { state: "declined", file }, [dim("  Nothing was changed.")]);
  }
  writeScript(home);
  if (theirs) {
    fs.writeFileSync(f.prev, theirs + "\n", { mode: 0o600 });
    fs.writeFileSync(f.prevJson, JSON.stringify(sl) + "\n", { mode: 0o600 });
  }
  backup(file, s.exists);
  writeSettings(file, { ...s.data, statusLine: { type: "command", command: ours(home), padding: 0 } });
  fs.rmSync(f.declined, { force: true });
  return report(0, { state: "installed", file, chained: Boolean(theirs), backup: s.exists ? `${file}.vyre-backup` : null }, [
    signal("  installed") + ` Vyre's status line in ${file}${theirs ? dim(" · yours still shows, above it") : ""}`,
    ...(s.exists ? [dim(`  the old file is in ${file}.vyre-backup`)] : []),
    dim("  it shows in new Claude Code sessions; vyre statusline uninstall takes it out")]);
}

/**
 * @param {Deps} [deps]
 * @returns {Promise<number>}
 */
export async function uninstall(deps = {}) {
  const env = deps.env || process.env, home = deps.home || config.home();
  const file = settingsPath(env), f = files(home);
  const s = readSettings(file);
  if (!s.ok) return unreadable(file, s.why);
  const sl = s.data.statusLine;
  if (!sl) return report(0, { state: "none", file }, [`  no status line is installed ${dim("· " + file)}`]);
  if (!isOurs(sl, home)) return report(0, { state: "not_ours", file }, [`  your status line is not Vyre's, so it stays ${dim("· " + file)}`]);
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(f.prevJson, "utf8")); } catch {}
  if (!prev) { try { const c = fs.readFileSync(f.prev, "utf8").trim(); if (c) prev = { type: "command", command: c }; } catch {} }
  const next = { ...s.data };
  if (prev) next.statusLine = prev; else delete next.statusLine;
  backup(file, true);
  writeSettings(file, next);
  for (const p of [f.script, f.prev, f.prevJson]) fs.rmSync(p, { force: true });
  return report(0, { state: "removed", file, restored: Boolean(prev) }, [signal("  removed") + ` Vyre's status line from ${file}${prev ? dim(" · yours is back") : ""}`]);
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
  const shown = (/** @type {string} */ line, /** @type {string} */ from) => json() ? emit({ line, from }, { kind: "text", lines: [line] }) : (out(`  ${line}`), 0);
  if (!r.error && r.data && r.data.line) return shown(r.data.line, "vyred");
  try {
    const [pid, line] = fs.readFileSync(files(home).line, "utf8").split("\n");
    // kill(0) would signal our own process group and always succeed.
    if (!(Number(pid) > 0)) throw new Error("no pid");
    process.kill(Number(pid), 0);
    if (line) return shown(line, "file");
  } catch {}
  if (json()) return failTool(r.error || { code: "unreachable" });
  out(`  Vyre is not running ${dim("· vyre up to start it")}`);
  return 1;
}

export default {
  name: "statusline", order: 70, usage: "vyre statusline [show | install [--chain] [--yes] | uninstall] [--json]",
  summary: "Vyre's line under every Claude Code session",
  verbs: VERBS,
  async run(/** @type {string[]} */ args) {
    const [verb, ...rest] = args.filter(a => a !== "--json");
    if (!verb || verb === "show") return show();
    if (verb === "install") return install(rest);
    if (verb === "uninstall") return uninstall();
    return usage(`vyre statusline ${verb}: not a verb`, "vyre statusline [show | install [--chain] [--yes] | uninstall]");
  },
};
