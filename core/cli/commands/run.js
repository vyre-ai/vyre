// @ts-check
// `vyre run [items] -- <command>`: `vyre vault run`, one word shorter, reading ./.env by itself.
//
// A project whose .env was rewritten to vault:// references (vyre vault import --rewrite) runs
// with `vyre run -- npm start`: the .env in this folder is read when nothing else was named, its
// references are released after presence, and the child's output is scrubbed of them. Without a
// `--`, everything is the command. Everything else is vault run's, so the two never differ.

import fs from "node:fs";
import path from "node:path";
import vault from "./vault.js";
import { isRef, templateRefs } from "../../vault/refs.js";
import { out, dim } from "../style.js";

const USAGE = "vyre run [--env-file f] [<item...>] -- <command...>";

/** Does this file hold at least one vault reference? A file that doesn't is left to the program. */
function holdsRefs(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return false; }
  return text.split(/\r?\n/).some(l => {
    const v = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(l)?.[1]?.trim() ?? "";
    try { return isRef(v) || templateRefs(v).length > 0; } catch { return false; }
  });
}

/** The arguments vault run gets: a `--` added when missing, and ./.env when nothing was named. */
export function runArgs(args, cwd = process.cwd()) {
  const at = args.indexOf("--");
  const left = at < 0 ? [] : args.slice(0, at);
  const cmd = at < 0 ? args : args.slice(at + 1);
  const named = left.some(a => a !== "--json");
  const dotenv = path.join(cwd, ".env");
  const extra = !named && holdsRefs(dotenv) ? ["--env-file", dotenv] : [];
  return ["run", ...left, ...extra, "--", ...cmd];
}

export default {
  name: "run", order: 41, usage: USAGE, summary: "run a program with vault values in its environment; reads ./.env references",
  /** @param {string[]} argv */
  async run(argv) {
    if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
      out(`  ${USAGE}\n  ${dim("with no items, a ./.env holding vault:// references is read")}`);
      return argv.length ? 0 : 2;
    }
    return vault.run(runArgs(argv));
  },
};
