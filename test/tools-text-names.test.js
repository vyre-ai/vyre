// @ts-check
// Claude Code and Codex call only the tools a server lists, and Vyre lists a small core (harness/mcp/core-tools.js). So any text an agent reads that tells it to call a tool outside the core by name
// would quietly fail. This test finds every such name in the agent-facing text and fails unless it is written as `tools_call <name>` (the tool is run with tools_call; tools_find finds it).
// A name after `vyre call` is the command line, which reaches every tool, so it is fine.
// Texts checked: the MCP server's own instructions, the descriptions of the listed tools, the plugin's skills and commands, the agent docs, the tips every module ships, and the session and assistant briefs in code.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { CORE, META, listing } from "../harness/mcp/core-tools.js";
import { broadCatalog } from "./tools-universe.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = broadCatalog();
const listed = new Set([...CORE, ...META]);
/** Every name an agent could write for a tool it is not listed: the MCP name and the dotted one. */
const outside = new Set(catalog.filter((c) => !listed.has(c.name)).flatMap((c) => [c.name, c.tool]));
const TOKEN = /(?<![A-Za-z0-9_.\-])[a-z][a-z0-9]*(?:[._][a-z0-9-]+)+(?![A-Za-z0-9_\-])/g;

/** The names in a text that are outside the core and are not written as `tools_call <name>`. @param {string} text */
export function unreached(text) {
  /** @type {string[]} */ const bad = [];
  for (const m of text.matchAll(TOKEN)) {
    if (!outside.has(m[0])) continue;
    const before = text.slice(Math.max(0, (m.index || 0) - 40), m.index).replace(/[`"'(\s]+$/, "");
    if (!before.endsWith("tools_call") && !before.endsWith("vyre call") && !/tools_call\s*\{\s*tool:\s*["']?$/.test(before)) bad.push(m[0]);
  }
  return [...new Set(bad)];
}

/** Text with the generated list of a service's operations left out: "threads.get" there is Gmail's, not a Vyre tool. @param {string} text */
const withoutOperations = (text) => text.replace(/<!-- agent:connections:start -->[\s\S]*?<!-- agent:connections:end -->/g, "");

/** @param {string} dir @param {RegExp} re */
const files = (dir, re) => { const out = []; for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) out.push(...files(p, re)); else if (re.test(e.name)) out.push(p); } return out; };

test("the check itself: a name outside the core must be written as tools_call", () => {
  assert.deepEqual(unreached("call `watchers_list` first"), ["watchers_list"]);
  assert.deepEqual(unreached("call `tools_call watchers_list` first"), []);
  assert.deepEqual(unreached("tools_call { tool: \"flows.simulate\" }"), []);
  assert.deepEqual(unreached("planner_add and memory_ask are listed"), []);
});

test("the plugin's skills and commands and the agent docs name outside tools only through tools_call", () => {
  const texts = [...files("harness/skills", /^SKILL\.md$/), ...files("harness/commands", /\.md$/), ...files("docs/agents", /\.md$/)];
  assert.ok(texts.length >= 18);
  const bad = texts.map((f) => [f, unreached(withoutOperations(fs.readFileSync(path.join(ROOT, f), "utf8")))]).filter(([, b]) => b.length);
  assert.deepEqual(bad, [], "write the tool as `tools_call <name>`, or add it to CORE if it is an everyday tool");
});

test("the descriptions of the listed tools name outside tools only through tools_call", () => {
  const bad = listing(catalog).map((t) => [t.name, unreached(`${t.description} ${JSON.stringify(t.inputSchema)}`)]).filter(([, b]) => b.length);
  assert.deepEqual(bad, []);
});

test("the briefs in code (the session environment, the assistant's prompt, the Gate's refusal) name outside tools only through tools_call", () => {
  // Lines of prose only: not comments, not SQL (where an underscored word is a table or a column) and not calls in code.
  const prose = (/** @type {string} */ f, /** @type {string} */ from = "", /** @type {string} */ to = "") => {
    let text = fs.readFileSync(path.join(ROOT, f), "utf8");
    if (from) text = text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));
    return text.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && !/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|FROM)\b|new Set\(|ctx\.call|ctx\.tool|\buse\(|\bcall\(|\.has\(|import /.test(l)).join("\n");
  };
  const bad = [
    ["core/sessions/environment.js", prose("core/sessions/environment.js")],
    ["core/agents/index.js", prose("core/agents/index.js", "const lines = a.kind === \"assistant\"", "return lines.join")],
    ["core/gate/gate.js", prose("core/gate/gate.js", "const how = names.length", "return { decision: \"deny\"")],
  ].map(([f, text]) => [f, unreached(text)]).filter(([, b]) => b.length);
  assert.deepEqual(bad, []);
});

// Tips on the cli, the Capsule, the Deck, the phone and Glass are read by the person, who has the command line; only a chat tip can reach a model.
test("the chat tips every module ships name outside tools only through tools_call or vyre call", () => {
  const bad = [];
  for (const f of files("core", /^module\.json$/).concat(files("local", /^module\.json$/), files("modules", /^module\.json$/))) {
    const tips = (JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")).teaches || {}).tips || [];
    for (const tip of tips) { if (!tip.surfaces.includes("chat")) continue; const b = unreached(`${tip.text} ${tip.command || ""}`); if (b.length) bad.push([`${f}:${tip.id}`, b]); }
  }
  assert.deepEqual(bad, []);
});

test("the MCP server's own instructions name outside tools only through tools_call", async (t) => {
  const env = { ...process.env, VYRE_HOME: fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "vyre-ins-")) };
  delete env.VYRE_SOCKET; delete env.VYRE_AGENT; delete env.VYRE_HUB_CHILD;
  const child = spawn(process.execPath, [path.join(ROOT, "harness", "mcp", "server.js")], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const reply = await new Promise((resolve) => { readline.createInterface({ input: /** @type {any} */ (child.stdout) }).on("line", (l) => resolve(JSON.parse(l))); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n"); });
  const text = /** @type {any} */ (reply).result.instructions;
  assert.ok(text.includes("tools_find"), "the instructions tell the model how to reach the rest");
  assert.deepEqual(unreached(text), []);
});
