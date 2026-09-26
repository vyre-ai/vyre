// @ts-check
// `vyre mcp`: the Vyre MCP server on stdio, for a plain `claude` that is not a Vyre thread
// (ADR 0015 decision 5). It is the same server the harness plugin loads, so it offers every
// module tool and every hub tool the session may use.
//
// The server is imported, not spawned: Claude Code starts `vyre mcp` as its own child, and the
// server finds its session by its parent's pid, which a second process would hide. Nothing else
// in this command may write to stdout while it serves, since stdout carries only JSON-RPC.
//
// `vyre mcp install` prints the one line that registers it with Claude Code, and runs it only
// with --yes. Vyre never edits a Claude config itself: the person's `claude` does, when asked.

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { out, dim, bold, signal, beacon } from "../style.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "harness", "mcp", "server.js");
/** What `claude mcp add` is given, word by word. */
export const INSTALL = ["mcp", "add", "-s", "user", "vyre", "--", "vyre", "mcp"];
export const INSTALL_LINE = ["claude", ...INSTALL].join(" ");

/** Serve until stdin closes, the way Claude Code ends a stdio server. */
async function serve() {
  const closed = new Promise(resolve => { process.stdin.once("end", resolve); process.stdin.once("close", resolve); });
  await import(pathToFileURL(SERVER).href);
  await closed;
  return 0;
}

/** @param {string[]} flags */
async function install(flags) {
  out(`  ${INSTALL_LINE}`);
  if (!flags.includes("--yes")) { out(dim("  run it yourself, or vyre mcp install --yes to have Vyre run it for you")); return 0; }
  const code = await new Promise(resolve => {
    const p = spawn("claude", INSTALL, { stdio: "inherit" });
    p.on("error", e => { out(beacon(`  could not run claude: ${/** @type {any} */ (e).code === "ENOENT" ? "it is not on PATH" : e.message}`)); resolve(1); });
    p.on("close", c => resolve(c ?? 1));
  });
  if (code === 0) out(`  ${signal("added")} ${bold("vyre")} ${dim("· a new claude session sees Vyre's tools")}`);
  return code;
}

export default {
  name: "mcp", order: 72, usage: "vyre mcp [install [--yes]]",
  summary: "the Vyre MCP server on stdio, for plain claude",
  /** @param {string[]} args */
  async run(args) {
    const [verb, ...rest] = args;
    if (!verb) return serve();
    if (verb === "install") return install(rest);
    out(`  vyre mcp ${verb}: not a verb ${dim("· vyre mcp to serve, vyre mcp install to add it to Claude Code")}`);
    return 1;
  },
};
