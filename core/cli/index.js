// @ts-check
// cli — the `vyre` command. Everything the Deck can do, this can do (docs/SPEC.md, principle 6).
//
// A thin client: every command is a call to vyred, so the terminal and the web app never
// disagree about what is true. Commands live one per file in ./commands and are found at run
// time, so a workstream adds a command by adding a file, never by editing this one.
//
// A command file exports default { name, aliases?, summary, usage?, order?, run(args) } where
// run returns an exit code. `vyre` with no arguments runs the command named "home" when one
// exists, and "status" otherwise.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { VERSION } from "../daemon/index.js";
import { out, dim, beacon } from "./style.js";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "commands");

/** @typedef {{ name: string, aliases?: string[], summary: string, usage?: string, order?: number, hidden?: boolean, run(args: string[]): Promise<number> }} Command */

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

function help(all) {
  const rows = all.filter(c => !c.hidden).map(c => `  ${(c.usage || `vyre ${c.name}`).padEnd(30)} ${dim(c.summary)}`);
  return `\n  vyre ${VERSION}\n\n${rows.join("\n")}\n  ${"vyre help".padEnd(30)} ${dim("this")}\n`;
}

/** @param {string[]} argv */
export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "version" || cmd === "--version" || cmd === "-v") { out(VERSION); return 0; }
  const all = await commands();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") { out(help(all)); return 0; }
  const want = cmd ?? (all.some(c => c.name === "home") ? "home" : "status");
  const c = all.find(x => x.name === want || (x.aliases || []).includes(want));
  if (!c) { out(beacon(`  vyre ${cmd}: not a command`)); out(help(all)); return 1; }
  return c.run(rest);
}
