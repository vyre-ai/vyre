// @ts-check
// cli — the `vyre` command. Everything the Deck can do, this can do (docs/SPEC.md, principle 6).
//
// A thin client: every command is a call to vyred, so the terminal and the web app never
// disagree about what is true. Commands live one per file in ./commands and are found at run
// time, so a workstream adds a command by adding a file, never by editing this one.
//
// A command file exports default { name, aliases?, summary, usage?, help?, order?, run(args) }
// where run returns an exit code (see kit.js for what each code means). `help` is more text for
// `vyre help <name>`, or a function that prints the command's own help. `vyre` with no arguments
// runs the command named "home" when one exists, and "status" otherwise.
//
// Every run goes through here, so the same things hold for all of them: `vyre help <cmd>` and
// `vyre <cmd> --help` work, --json is noticed once, and nothing a command throws reaches the
// person as a stack trace (VYRE_DEBUG=1 shows it).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VERSION } from "../daemon/index.js";
import { out, dim, bold, beacon } from "./style.js";
import { EXIT, UsageError, closest, setJson, wantsJson, wantsView, setView, emit, fail, usage } from "./kit.js";
import { done, verbWords, textLines } from "./view.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "commands");

/** @typedef {{ name: string, aliases?: string[], summary: string, usage?: string, help?: string | (() => number | Promise<number>), order?: number, hidden?: boolean, run(args: string[]): Promise<number> }} Command */

/** @returns {Promise<Command[]>} */
export async function commands() {
  const found = [];
  for (const f of fs.readdirSync(DIR).filter(f => f.endsWith(".js") && !f.endsWith(".test.js")).sort()) {
    const mod = await import(pathToFileURL(path.join(DIR, f)).href);
    const list = Array.isArray(mod.default) ? mod.default : [mod.default];
    for (const c of list) if (c && c.name && typeof c.run === "function") found.push(c);
  }
  return found.sort((a, b) => (a.order ?? 50) - (b.order ?? 50) || a.name.localeCompare(b.name));
}

/** Where each command sits in `vyre help`. A command not named here goes under "More". */
export const GROUPS = [
  ["Start and connect", ["up", "status", "down", "box", "name", "link", "phone", "capsule"]],
  ["Projects and sessions", ["projects", "new", "open", "threads", "sessions", "resume", "start", "context", "pick", "unpick"]],
  ["Waiting on you", ["needs", "gate"]],
  ["Agents and watchers", ["agents", "watchers"]],
  ["Time and lists", ["agenda", "alarm", "timer", "remind", "snooze", "ringing", "dismiss", "todo", "notes"]],
  ["Memory", ["recall", "index", "memory", "why", "learn"]],
  ["Vault and presence", ["vault", "presence"]],
  ["Box care", ["backup", "restore"]],
  ["Under the hood", ["modules", "tools", "call", "commands"]],
];

const usageOf = c => c.usage || `vyre ${c.name}`;

/** `vyre help`: every command that is not hidden, in groups. */
export function help(all) {
  const shown = all.filter(c => !c.hidden);
  const placed = new Set(GROUPS.flatMap(([, names]) => names));
  const groups = [...GROUPS, ["More", shown.filter(c => !placed.has(c.name)).map(c => c.name)]];
  const blocks = [];
  for (const [title, names] of groups) {
    const rows = shown.filter(c => names.includes(c.name))
      .sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name) || (a.order ?? 50) - (b.order ?? 50))
      // A long usage gets its own line, so the summaries still line up in one column.
      .map(c => usageOf(c).length > 30 ? `    ${usageOf(c)}\n    ${" ".repeat(32)}${dim(c.summary)}` : `    ${usageOf(c).padEnd(31)} ${dim(c.summary)}`);
    if (rows.length) blocks.push(`  ${bold(String(title))}\n${rows.join("\n")}`);
  }
  return `\n  vyre ${VERSION}\n\n    ${"vyre".padEnd(31)} ${dim("your projects, threads, drafts and asks, live")}\n\n${blocks.join("\n\n")}\n\n`
    + dim(`  vyre help <command> for one command · --json on any read prints JSON\n`)
    + dim(`  exit codes: 0 ok · 1 failed · 2 usage · 3 presence · 4 vault locked · 5 vyred not running\n`);
}

/** `vyre help <cmd>`: its usage, summary, aliases and any longer help. Returns an exit code. */
export async function helpFor(all, name) {
  const cs = all.filter(c => c.name === name || (c.aliases || []).includes(name));
  if (!cs.length) return unknown(all, name);
  for (const c of cs) {
    if (typeof c.help === "function") { await c.help(); continue; }
    out(`\n  ${bold(usageOf(c))}\n  ${c.summary}`);
    if (c.help) out("\n" + String(c.help).split("\n").map(l => "  " + l).join("\n"));
    if (c.aliases && c.aliases.length) out(dim(`  also: ${c.aliases.map(a => "vyre " + a).join(", ")}`));
  }
  out("");
  return EXIT.OK;
}

function unknown(all, name) {
  const names = all.filter(c => !c.hidden).flatMap(c => [c.name, ...(c.aliases || [])]);
  const near = closest(name, names);
  return usage(`vyre ${name}: not a command`, near.length ? `did you mean ${near.map(n => "vyre " + n).join(" or ")}? · vyre help` : "vyre help");
}

/** `--help` or `-h` before any `--`, which means "tell me about this command", not an argument. */
const asksHelp = args => {
  const at = args.indexOf("--");
  return (at < 0 ? args : args.slice(0, at)).some(a => a === "--help" || a === "-h");
};

/** What a command threw, as one line: a person never sees a stack trace unless they ask. */
function crashed(name, err) {
  if (err instanceof UsageError) return usage(err.message, err.next || `vyre help ${name}`);
  const e = /** @type {Error} */ (err);
  if (process.env.VYRE_DEBUG) process.stderr.write(String(e && e.stack || e) + "\n");
  return fail(`vyre ${name} stopped: ${e && e.message ? e.message : String(e)}`,
    { next: process.env.VYRE_DEBUG ? undefined : "VYRE_DEBUG=1 shows the trace", code: "crashed" });
}

/** @param {string[]} argv */
export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "version" || cmd === "--version" || cmd === "-v") { out(VERSION); return 0; }
  const all = await commands();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    if (rest[0]) return helpFor(all, rest[0]);
    out(help(all));
    return 0;
  }
  const want = cmd ?? (all.some(c => c.name === "home") ? "home" : "status");
  // Two files may share a name (`vyre threads` has two halves): the first found runs, and it
  // hands on what it does not handle itself.
  const c = all.find(x => x.name === want || (x.aliases || []).includes(want));
  if (!c) return unknown(all, want);
  if (asksHelp(rest)) return helpFor(all, c.name);
  if (wantsView(rest)) return viewRun(c, rest);
  setJson(wantsJson(rest));
  return runOne(c, rest);
}

/** @param {Command} c @param {string[]} args */
async function runOne(c, args) {
  // A promise a command forgot to await still must not print a trace.
  const late = err => { process.exitCode = crashed(c.name, err); };
  process.on("unhandledRejection", late);
  try {
    const code = await c.run(args);
    return typeof code === "number" ? code : EXIT.OK;
  } catch (err) {
    return crashed(c.name, err);
  } finally {
    process.off("unhandledRejection", late);
    setJson(false);
  }
}

/**
 * `--view`: the verb runs in JSON mode and every line out is a frame (core/cli/view.js). What it
 * prints for a person instead (a verb with no JSON) comes out as one text frame, without colour.
 * Nothing is read from stdin: a verb that would ask says what to add to the command instead.
 * @param {Command} c @param {string[]} rest
 */
export async function viewRun(c, rest) {
  const at = rest.indexOf("--");
  const head = (at < 0 ? rest : rest.slice(0, at)).filter(a => a !== "--view");
  const args = [...(head.includes("--json") ? head : [...head, "--json"]), ...(at < 0 ? [] : rest.slice(at))];
  setView(verbWords(c.name, head));
  const write = process.stdout.write.bind(process.stdout);
  /** @type {string[]} */
  const text = [];
  process.stdout.write = /** @type {any} */ ((chunk, ...more) => {
    const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    if (s.startsWith('{"v":1,')) return write(chunk, ...more);
    text.push(s);
    const cb = more.find(m => typeof m === "function");
    if (cb) cb();
    return true;
  });
  let code = EXIT.FAILED;
  try {
    code = await runOne(c, args);
  } finally {
    const lines = textLines(text);
    if (lines.length) emit(null, { kind: "text", lines });
    process.stdout.write = write;
    write(JSON.stringify(done(code)) + "\n");
    setView(null);
    setJson(false);
  }
  return code;
}
