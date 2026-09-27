#!/usr/bin/env node
// @ts-check
// Every Harness hook starts here: `node run.js <piece>`. With Vyre on this machine it runs that
// package's hook.js, which reads stdin itself. Without it, the session's first SessionStart says
// in one line how to install Vyre, and every other hook exits 0 at once, printing nothing.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { locate, hint } from "../lib/vyre.js";

const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function stdin() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}

async function main() {
  const { state, root } = locate(pluginRoot);
  if (state === "ready" && root) {
    await import(pathToFileURL(path.join(root, "harness", "hooks", "hook.js")).href);
    return;
  }
  // Only a fresh session hears it: not on resume, /clear or compaction, and never from a hook
  // that runs on every prompt or tool call.
  if (process.argv[2] !== "brief") return;
  const h = await stdin();
  if (h.source && h.source !== "startup") return;
  process.stdout.write(JSON.stringify({ systemMessage: hint(/** @type {"setup"|"missing"} */ (state)) }));
}

main().catch(() => {}).finally(() => { process.exitCode = 0; });
