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
import { json, emit, fail, usage, failTool, parse } from "../kit.js";
import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "harness", "mcp", "server.js");
/** The Design and Module MCP: added when the work is design or building a module (harness/mcp/design-serve.js). */
const DESIGN = path.join(path.dirname(SERVER), "design-serve.js");
/** What `claude mcp add` is given, word by word. */
export const INSTALL = ["mcp", "add", "-s", "user", "vyre", "--", "vyre", "mcp"];
export const INSTALL_LINE = ["claude", ...INSTALL].join(" ");

/** The line that registers the same server with Codex. */
export const CODEX_LINE = "codex mcp add vyre -- vyre mcp";

/** Serve until stdin closes, the way Claude Code ends a stdio server. */
async function serve(server = SERVER) {
  const closed = new Promise(resolve => { process.stdin.once("end", resolve); process.stdin.once("close", resolve); });
  await import(pathToFileURL(server).href);
  await closed;
  return 0;
}

/** Every verb run() handles, for `vyre commands --json`. `vyre mcp` alone serves too. */
export const VERBS = [
  { verb: "serve", summary: "the MCP server on stdio, which Claude Code starts (vyre mcp alone is the same)", usage: "" },
  { verb: "design", summary: "the Design and Module MCP on stdio: blocks, screen checks, pictures, proposals, and the module kit", usage: "" },
  { verb: "connect", summary: "the lines that connect your own Claude Code or Codex to Vyre, and the one step that lets it set Vyre up", usage: "[--json]" },
  { verb: "setup", summary: "Set up mode for Claude Code on this computer: on (one yes, hours default 4), off, status", usage: "[on|off|status] [--hours N] [--json]" },
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

/** `vyre mcp connect`: both registration lines and what to say next. Nothing is run and nothing is changed. */
function connect() {
  const next = "vyre mcp setup on, then in a new session: /mcp__vyre__setup-vyre (Claude Code), or ask it to call pluginagent_setup_guide (Codex)";
  if (json()) return emit({ claude: INSTALL_LINE, codex: CODEX_LINE, next });
  out(`  ${bold("Claude Code")}  ${INSTALL_LINE}`);
  out(`  ${bold("Codex")}        ${CODEX_LINE}`);
  out("");
  out(dim("  Your AI then reads your memory and sessions. To let it set Vyre up from your work (projects, agents, records, flows)"));
  out(dim("  and bring your old sessions in, give it a few hours:"));
  out(`  vyre mcp setup on`);
  out(dim("  then start a new session and run /mcp__vyre__setup-vyre, or tell it to call pluginagent_setup_guide."));
  return 0;
}

/** `vyre mcp setup on|off|status`: Set up mode for Claude Code on this computer (core/pluginagent). @param {string[]} args */
async function setup(args) {
  const { flags, pos } = parse(args, { values: ["hours"], cmd: "mcp" });
  const word = pos[0] || "status";
  if (!["on", "off", "status"].includes(word)) return usage(`vyre mcp setup ${word}: not a word`, "vyre mcp setup on | off | status");
  await ensureUp();
  if (word === "status") {
    const r = await call("pluginagent.setup.status", {});
    if (r.error) return failTool(r.error);
    if (json()) return emit(r.data);
    out(r.data.on ? `  Set up mode is ${signal("on")} until ${new Date(r.data.until).toLocaleTimeString()}` : "  Set up mode is off");
    return 0;
  }
  if (word === "off") {
    const r = await call("pluginagent.setup.end", {});
    if (r.error) return failTool(r.error);
    if (json()) return emit(r.data);
    out(r.data.was ? `  Set up mode ${signal("off")}` : "  Set up mode was already off");
    return 0;
  }
  const hours = flags.hours !== undefined ? Number(flags.hours) : undefined;
  if (hours !== undefined && !(hours >= 0.25 && hours <= 24)) return usage("--hours is between 0.25 and 24", "vyre mcp setup on --hours 4");
  // Claude Code needs its one grant first (reads memory and sessions); the same yes covers it when it is not given yet.
  const st = await call("pluginagent.status", {});
  if (st.error) return failTool(st.error);
  if (!st.data.granted) { const g = await call("pluginagent.grant", {}); if (g.error) return failTool(g.error); }
  const r = await call("pluginagent.setup.begin", hours ? { hours } : {});
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  out(`  Set up mode ${signal("on")} for ${r.data.hours} hours ${dim("· vyre mcp setup off ends it")}`);
  return 0;
}

export default {
  name: "mcp", order: 72, usage: "vyre mcp [serve | design | connect | setup [on|off|status] | install [--yes]] [--json]",
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
    if (verb === "design") {
      if (json()) return usage("vyre mcp design serves MCP on stdio; it has no --json");
      return serve(DESIGN);
    }
    if (verb === "install") return install(rest);
    if (verb === "connect") return connect();
    if (verb === "setup") return setup(rest);
    return usage(`vyre mcp ${verb}: not a verb`, "vyre mcp to serve, vyre mcp install to add it to Claude Code");
  },
};
