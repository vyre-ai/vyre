// @ts-check
// `vyre mcp`: the Vyre MCP server on stdio, for a plain `claude` that is not a Vyre thread
// (ADR 0016 decision 5). It is the same server the harness plugin loads, so it offers every
// module tool and every hub tool the session may use.
//
// The server is imported, not spawned: Claude Code starts `vyre mcp` as its own child, and the
// server finds its session by its parent's pid, which a second process would hide. Nothing else
// in this command may write to stdout while it serves, since stdout carries only JSON-RPC.
//
// `vyre mcp install` prints the one line that registers it with Claude Code, and runs it only
// with --yes. Vyre never edits a Claude config itself: the person's `claude` does, when asked.
// --json prints { command, ran } and, once it ran, { exit, output }. Serving has no --json or
// --view: stdout is JSON-RPC then, so the CLI refuses it (exit 2) rather than wait on stdin.

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { out, dim, bold, signal, beacon } from "../style.js";
import { json, emit, fail, usage } from "../kit.js";

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

/** Every verb run() handles, for `vyre commands --json`. `vyre mcp` alone serves too. */
export const VERBS = [
  { verb: "serve", summary: "the MCP server on stdio, which Claude Code starts (vyre mcp alone is the same)", usage: "" },
  { verb: "install", summary: "print the claude mcp add line; --yes runs it", usage: "[--yes] [--json]" },
];

/** @param {string[]} flags */
async function install(flags) {
  const yes = flags.includes("--yes");
  if (!json()) out(`  ${INSTALL_LINE}`);
  if (!yes) {
    if (json()) return emit({ command: INSTALL_LINE, ran: false });
    out(dim("  run it yourself, or vyre mcp install --yes to have Vyre run it for you"));
    return 0;
  }
  // Under --json claude's own words are kept, not printed, so stdout holds only the answer.
  const chunks = [];
  const { code, missing } = await new Promise(resolve => {
    const p = spawn("claude", INSTALL, { stdio: json() ? ["ignore", "pipe", "pipe"] : "inherit" });
    if (json()) for (const s of [p.stdout, p.stderr]) s?.on("data", d => chunks.push(String(d)));
    p.on("error", e => {
      const why = /** @type {any} */ (e).code === "ENOENT" ? "it is not on PATH" : e.message;
      if (!json()) out(beacon(`  could not run claude: ${why}`));
      resolve({ code: 1, missing: why });
    });
    p.on("close", c => resolve({ code: c ?? 1 }));
  });
  if (json()) {
    if (missing) return fail(`could not run claude: ${missing}`, { code: "no_claude", next: `install Claude Code, or run ${INSTALL_LINE} yourself` });
    emit({ command: INSTALL_LINE, ran: true, exit: code, output: chunks.join("").trim() });
    return code;
  }
  if (code === 0) out(`  ${signal("added")} ${bold("vyre")} ${dim("· a new claude session sees Vyre's tools")}`);
  return code;
}

export default {
  name: "mcp", order: 72, usage: "vyre mcp [serve | install [--yes]] [--json]",
  summary: "the Vyre MCP server on stdio, for plain claude",
  verbs: VERBS,
  /** @param {string[]} args */
  async run(args) {
    const [verb, ...rest] = args.filter(a => a !== "--json");
    if (!verb || verb === "serve") {
      // Claude Code starts `vyre mcp` with no flags. Asked for --json or --view, it would sit on
      // stdin for ever and answer JSON-RPC to no one.
      if (json()) return usage("vyre mcp serves MCP on stdio for Claude Code; it has no --json", "vyre mcp install --json");
      if (rest.length) return usage(`vyre mcp serve takes no arguments (got ${rest[0]})`);
      return serve();
    }
    if (verb === "install") return install(rest);
    return usage(`vyre mcp ${verb}: not a verb`, "vyre mcp to serve, vyre mcp install to add it to Claude Code");
  },
};
