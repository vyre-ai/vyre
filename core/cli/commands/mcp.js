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

/** The label printed for each connection line the daemon returns, by the key it returns it under. */
const SNIPPET_LABELS = [["claude", "Claude Code"], ["codex", "Codex"]];

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
  { verb: "connect", summary: "make a named key for one of your AIs so it acts as you (one yes); --hosted gives a URL and key for any MCP client", usage: "[--name NAME] [--hosted] [--json]" },
  { verb: "list", summary: "your AI keys: name, where, when each was last used", usage: "[--json]" },
  { verb: "revoke", summary: "end a connection at once", usage: "<id> [--json]" },
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

/** `vyre mcp connect [--name NAME] [--hosted]`: the person makes a key for one of their AIs and names it (one yes). The key is shown once. @param {string[]} args */
async function connect(args) {
  const { flags } = parse(args, { values: ["name"], bool: ["hosted"], cmd: "mcp" });
  await ensureUp();
  const made = await call("mcpconn.connect", { ...(flags.name ? { name: String(flags.name) } : {}), ...(flags.hosted ? { hosted: true } : {}) });
  if (made.error) return failTool(made.error);
  const d = made.data;
  if (json()) return emit(d);
  out(`  ${signal("key made")} ${bold(d.name)} ${dim("· it acts as you; sending and publishing still wait for you · vyre mcp revoke " + d.id + " ends it")}`);
  out("");
  if (d.local) {
    for (const [key, label] of SNIPPET_LABELS) out(`  ${bold(label.padEnd(11))}  ${d.snippets[key]}`);
    out(dim("  Run yours once, then in a new session run /mcp__vyre__setup-vyre, or tell it to call mcpconn_guide."));
  } else {
    out(`  ${bold("URL")}          ${d.url || "(shown when this server is reachable)"}`);
    out(`  ${bold("Key")}          ${d.key}   ${dim("shown only now")}`);
    for (const [key, label] of SNIPPET_LABELS) out(`  ${bold(label.padEnd(11))}  ${d.snippets[key]}`);
    out(dim("  Any MCP client takes the URL and the key as a Bearer token over HTTP. vyre mcp revoke " + d.id + " ends it."));
  }
  return 0;
}

/** `vyre mcp list`: the connections, newest first. */
async function list() {
  await ensureUp();
  const r = await call("mcpconn.list", {});
  if (r.error) return failTool(r.error);
  if (json()) return emit({ connections: r.data });
  if (!r.data.length) { out(dim("  nothing connected (vyre mcp connect)")); return 0; }
  for (const c of r.data) out(`  ${c.id}  ${bold(c.name)}  ${c.where}  ${dim(c.revoked ? "revoked" : c.lastUsed ? "last used " + new Date(c.lastUsed).toLocaleString() : "not used yet")}`);
  return 0;
}

/** `vyre mcp revoke ID`: end a connection at once. @param {string[]} args */
async function revoke(args) {
  const [id] = args;
  if (!id) return usage("vyre mcp revoke needs a connection id", "vyre mcp list");
  await ensureUp();
  const r = await call("mcpconn.revoke", { id });
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data);
  out(`  ${signal("revoked")} ${id}`);
  return 0;
}

export default {
  name: "mcp", order: 72, usage: "vyre mcp [serve | design | connect | list | revoke <id> | install [--yes]] [--json]",
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
    if (verb === "connect") return connect(rest);
    if (verb === "list") return list();
    if (verb === "revoke") return revoke(rest);
    return usage(`vyre mcp ${verb}: not a verb`, "vyre mcp to serve, vyre mcp install to add it to Claude Code");
  },
};
