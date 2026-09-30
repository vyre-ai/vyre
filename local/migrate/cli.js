#!/usr/bin/env node
// @ts-check
// The interface launch's install line calls, with the bundled node, as its first step on a Mac:
//
//   node local/migrate/cli.js [--old-home <path>] [--new-home <path>] [--json]
//
// With no flags: --old-home defaults to $VYRE_HOME or ~/.vyre (0.1.1's home), --new-home to
// $VYRE_NEW_HOME or "~/Library/Application Support/Vyre" (the 0.2 local node's home, ADR "From
// 0.1.1"). Prints one line for a person (the exact text `run()`'s summary gives back) unless
// --json is passed, which prints the full {report, plan, result, summary} instead, for the
// installer to log.
//
// Exit codes: 0 nothing to do or everything applied; 1 a step failed (result.result.ok === false,
// the message above already says which one); 2 bad usage.

import os from "node:os";
import path from "node:path";
import { run } from "./index.js";

function parseArgs(argv) {
  const o = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--old-home") o.oldHome = argv[++i];
    else if (a === "--new-home") o.newHome = argv[++i];
    else if (a === "--json") o.json = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else { o.badArg = a; }
  }
  return o;
}

const USAGE = "usage: migrate [--old-home <path>] [--new-home <path>] [--json]";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); return 0; }
  if (args.badArg) { console.error(`migrate: unknown argument "${args.badArg}"\n${USAGE}`); return 2; }

  const oldHome = args.oldHome || process.env.VYRE_HOME || path.join(os.homedir(), ".vyre");
  const newHome = args.newHome || process.env.VYRE_NEW_HOME || path.join(os.homedir(), "Library", "Application Support", "Vyre");

  const out = await run({ oldHome, newHome });

  if (args.json) console.log(JSON.stringify(out));
  else console.log(out.summary);

  return out.result.ok ? 0 : 1;
}

main().then(code => process.exit(code), err => {
  console.error(`migrate: ${err && err.stack || err}`);
  process.exit(1);
});
