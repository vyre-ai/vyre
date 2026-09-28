// @ts-check
// reference: the pages under docs/reference/, built from the code so they cannot drift from it.
// scripts/gen-docs-reference writes them; scripts/docs-check builds them in memory and fails when
// the committed pages differ.
//
// Sources:
//   cli.md      the command list in core/cli (the same data `vyre help` prints)
//   modules.md  every module.json vyred would load (core/, local/, modules/)
//   tools.md    every ctx.tool definition, recorded by loading each module with a context that
//               only records (harvest.mjs); a tool the manifest declares but no start registered
//               falls back to reading the source, and says so when even that finds nothing
//   events.md   each manifest's watches, with the payload fields read from the emit calls
//   config.md   core/config/index.js (the Config and Network typedefs, and the defaults) and every
//               process.env.VYRE_ read in the shipped code
//   index.md    and docs/index.json: every thing above plus screens and concepts, with every page
//               and line that mentions it (terms.js)
//
// Everything is sorted and nothing depends on the machine: the harvest runs with a temporary
// HOME, which the pages show as ~, and platform-dependent defaults are shown as their source.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { slugger } from "./slug.js";
import { generateIndex, INDEX_JSON } from "./terms.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, "../../..");
export const GENERATOR = "scripts/gen-docs-reference";
export const PAGES = ["reference/cli.md", "reference/tools.md", "reference/events.md", "reference/config.md", "reference/modules.md"];
const MODULE_ROOTS = ["core", "local", "modules"];
export const SHIPPED = ["bin", "core", "harness", "local", "modules"];

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const code = s => "`" + String(s).replace(/`/g, "'") + "`";
const cell = s => String(s).replace(/\|/g, "\\|").replace(/\n+/g, " ");
const list = (xs, none = "none") => (xs.length ? xs.map(code).join(", ") : none);

// ---------------------------------------------------------------------------------------------
// Reading the code

/** Every module folder vyred would load: one level under each module root, holding a module.json. */
export function manifests(root = REPO) {
  const out = [];
  for (const r of MODULE_ROOTS) {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, r), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules") continue;
      const file = path.join(root, r, e.name, "module.json");
      if (!fs.existsSync(file)) continue;
      out.push({ dir: path.join(r, e.name), manifest: JSON.parse(fs.readFileSync(file, "utf8")) });
    }
  }
  return out.sort((a, b) => byName(a.manifest.name, b.manifest.name));
}

/** Source files under a folder, leaving out tests, fixtures, build output and dependencies. */
export function sources(dir, exts = /\.(js|mjs)$/) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => byName(a.name, b.name))) {
    if (["node_modules", "dist", "fixtures", "test", "testing", "vendor"].includes(e.name) || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p, exts));
    else if (exts.test(e.name) && !/\.test\.(js|mjs)$/.test(e.name) && e.name !== "testing.js") out.push(p);
  }
  return out;
}

/**
 * Run the harvest worker in a child process with a throwaway home.
 * @param {{ root?: string, tmp?: string }} [opts] tmp: the folder to make the throwaway home in
 */
export function harvest({ root = REPO, tmp = os.tmpdir() } = {}) {
  const home = fs.mkdtempSync(path.join(tmp, "vyre-docs-ref-"));
  try {
    const out = path.join(home, "harvest.json");
    const none = path.join(home, "no-such-binary");
    const env = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: home, TMPDIR: path.join(home, "tmp"), VYRE_HOME: path.join(home, ".vyre"),
      VYRE_NO_DIALOGS: "1", VYRE_TAILSCALE_BIN: none, VYRE_CLAUDE_BIN: none, VYRE_OPEN_BIN: none, VYRE_SSH_BIN: none,
      VYRE_HANDS_BIN: none, VYRE_NO_OPEN: "1", VYRE_NO_UP: "1" };
    fs.mkdirSync(env.TMPDIR);
    const r = spawnSync(process.execPath, [path.join(HERE, "harvest.mjs"), root, out], { env, encoding: "utf8", timeout: 120_000 });
    if (r.status !== 0 || !fs.existsSync(out)) throw new Error(`the tool harvest failed (exit ${r.status}): ${(r.stderr || r.error?.message || "").trim().slice(0, 500)}`);
    return JSON.parse(fs.readFileSync(out, "utf8"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** The text of a balanced {...} starting at text[i], skipping strings and comments. */
export function balanced(text, i) {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const c = text[j];
    if (c === '"' || c === "'" || c === "`") {
      for (j++; j < text.length && text[j] !== c; j++) if (text[j] === "\\") j++;
      continue;
    }
    if (c === "/" && text[j + 1] === "/") { j = text.indexOf("\n", j); if (j < 0) return null; continue; }
    if (c === "/" && text[j + 1] === "*") { j = text.indexOf("*/", j); if (j < 0) return null; j++; continue; }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") { depth--; if (depth === 0) return text.slice(i, j + 1); }
  }
  return null;
}

/** Split the inside of an object literal at its top-level commas. */
export function topLevel(inner) {
  const parts = [];
  let depth = 0, start = 0;
  for (let j = 0; j < inner.length; j++) {
    const c = inner[j];
    if (c === '"' || c === "'" || c === "`") { for (j++; j < inner.length && inner[j] !== c; j++) if (inner[j] === "\\") j++; continue; }
    if ("{([".includes(c)) depth++;
    else if ("})]".includes(c)) depth--;
    else if (c === "," && depth === 0) { parts.push(inner.slice(start, j)); start = j + 1; }
  }
  parts.push(inner.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

/** The keys of an object literal's source: { always: [...], sometimes: [...] }. */
export function literalKeys(src) {
  const always = [], sometimes = [];
  for (const part of topLevel(src.slice(1, -1))) {
    if (part.startsWith("...")) {
      for (let k = part.indexOf("{"); k >= 0; k = part.indexOf("{", k + 1)) {
        const inner = balanced(part, k);
        if (!inner) break;
        sometimes.push(...literalKeys(inner).always);
        k += inner.length - 1;
      }
      continue;
    }
    const m = part.match(/^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*(:|$)/);
    if (m) always.push(m[1] || m[2] || m[3]);
  }
  return { always, sometimes };
}

/** Payload fields for each event type a module's source emits. */
function payloads(root, dir, types) {
  /** @type {Map<string, { sites: number, counts: Map<string, number>, sometimes: Set<string> }>} */
  const found = new Map();
  for (const file of sources(path.join(root, dir))) {
    const text = fs.readFileSync(file, "utf8");
    // A type is found as a string literal followed by its payload: emit("a.b", { ... }), and also
    // a ternary emit(on ? "a.b" : "a.c", { ... }) or a helper send("a.b", { ... }).
    for (const m of text.matchAll(/["']([a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)["'](?=((?:\s*:\s*["'][a-z0-9.-]+["'])?\s*,\s*))/g)) {
      const type = m[1];
      if (!types.includes(type)) continue;
      const rec = found.get(type) || { sites: 0, counts: new Map(), sometimes: new Set() };
      found.set(type, rec);
      const at = /** @type {number} */ (m.index) + m[0].length + m[2].length;
      if (text[at] !== "{") continue;
      const lit = balanced(text, at);
      if (!lit) continue;
      rec.sites++;
      const { always, sometimes } = literalKeys(lit);
      for (const k of new Set(always)) rec.counts.set(k, (rec.counts.get(k) || 0) + 1);
      for (const k of sometimes) rec.sometimes.add(k);
    }
  }
  const out = new Map();
  for (const [type, r] of found) {
    const always = [...r.counts].filter(([, n]) => n === r.sites).map(([k]) => k).sort(byName);
    const sometimes = [...new Set([...[...r.counts].filter(([, n]) => n < r.sites).map(([k]) => k), ...r.sometimes])].filter(k => !always.includes(k)).sort(byName);
    out.set(type, { always, sometimes, literal: r.sites > 0 });
  }
  return out;
}

/** A tool's description read from its module's source, for a tool no start registered. */
function staticDescription(root, dir, name) {
  for (const file of sources(path.join(root, dir))) {
    const text = fs.readFileSync(file, "utf8");
    const i = text.indexOf(`"${name}"`);
    if (i < 0) continue;
    const after = text.slice(i + name.length + 2, i + name.length + 600);
    const m = after.match(/^\s*,\s*(?:\[[^\]]*\]\s*,\s*|[A-Z_]+\s*,\s*)?(?:\{\s*description:\s*)?"((?:[^"\\]|\\.)*)"/);
    if (m) return JSON.parse(`"${m[1]}"`);
  }
  return "";
}

/** Every VYRE_ environment variable the shipped code reads, the files that read it, and whether Vyre sets it too. */
export function environment(root = REPO) {
  /** @type {Map<string, Set<string>>} */
  const reads = new Map();
  const sets = new Set();
  const files = SHIPPED.flatMap(d => sources(path.join(root, d), /(\.(js|mjs)$|^vyre[a-z-]*$|^git-credential-vyre$)/));
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/\benv(?:\.|\[["'])(VYRE_[A-Z0-9_]+)(["']\])?/g)) {
      const after = text.slice(/** @type {number} */ (m.index) + m[0].length).match(/^\s*(\S\S?)/);
      if (after && after[1][0] === "=" && after[1] !== "==") { sets.add(m[1]); continue; }
      if (!reads.has(m[1])) reads.set(m[1], new Set());
      /** @type {Set<string>} */ (reads.get(m[1])).add(path.relative(root, file));
    }
    for (const m of text.matchAll(/(?<![.\w])(VYRE_[A-Z0-9_]+)\s*:\s*[^\s]/g)) sets.add(m[1]);
  }
  // A few Vyre passes along but people set too; they belong with the ones people set.
  const people = new Set(["VYRE_HOME", "VYRE_NO_UP"]);
  return [...reads].map(([name, f]) => ({ name, files: [...f].sort(byName), set: sets.has(name) && !people.has(name), note: ENV_MEANING[name.slice(5)] || "" }))
    .sort((a, b) => byName(a.name, b.name));
}

// What each variable is for, keyed without the VYRE_ prefix. A variable the code starts reading
// without a line here shows as "not described yet".
const ENV_MEANING = {
  ACME_DIRECTORY: "The ACME server certificates come from, in place of Let's Encrypt. With it set, Vyre does not wait for DNS.",
  AGENT: "The agent a thread runs as.",
  AGENT_KEY: "The key that proves a thread's calls come from its agent.",
  AGENT_KIND: "`assistant` or `agent`. Only the assistant is offered the tools that drive other threads.",
  ALLOW_REAL_TRANSCRIPTS: "`1`: a home other than `~/.vyre` reads the transcripts in `~/.claude` too. Never under tests.",
  CLAUDE_HOME: "Claude Code's folder for a home other than `~/.vyre`. Without it such a home uses its own `claude` folder and never reads `~/.claude`.",
  ALLOW_DIALOGS: "`1`: a home other than `~/.vyre` that you keep on purpose may raise Touch ID and other prompts. Never under tests; `VYRE_NO_DIALOGS` still wins.",
  BOX_INSTALLER: "The installer `vyre box add` runs on the server, in place of the published one.",
  BOX_POLL_MS: "How often `vyre box` checks on an install in progress. Default 5000.",
  BOX_PROBE_MS: "How long `vyre box` waits for the box's address to answer. Default two minutes.",
  BOX_WAIT_MS: "How long `vyre box` waits for an install to finish. Default 65 minutes.",
  CAPSULE_DRIVE: "In a development build, lets a script drive the Capsule.",
  DRIVE_ACCESS: "`ro` (default) or `rw`: how box/compose.yml mounts `/work` into the tailscale container for VyreDrive (built on Tailscale's Taildrive). `rw` only while some share is rw (`files.drive.access`). When vyred sees it too, `files.drive.access` can tell whether the mount must change.",
  CLAUDE_BIN: "The `claude` binary to run. Default `claude` on the PATH.",
  CLOUDFLARE_API: "The Cloudflare API base URL, in place of the real one.",
  COMPUTERS_CAP_ADD: "Extra Linux capabilities for agent computers, comma separated.",
  COMPUTERS_IMAGE: "The container image agent computers run. Default `vyre/computer:0.1`.",
  COMPUTERS_LABEL_PREFIX: "The label prefix that marks Vyre's containers. Default `run.vyre.computers`.",
  COMPUTERS_NETWORK: "The Docker network agent computers join. Default `vyre-computers`.",
  DOCKER_PROXY_PORT: "The port the Docker proxy listens on. Default 2375.",
  DTACH_BIN: "The `dtach` binary terminals run under so they outlive a vyred restart. Default `dtach` on the PATH. Empty: plain terminals that end with vyred.",
  HANDS_BIN: "Another build of the Mac hands helper.",
  HARNESS_DIR: "The Harness plugin folder threads load. Default the one beside this install.",
  HOME: "Where Vyre keeps its data. Default `~/.vyre`.",
  HOST_USER: "The user name in the `ssh -L` line `vyre up` prints for reaching the box.",
  NO_DIALOGS: "`1`: never raise anything on screen (Touch ID, a keychain prompt, a browser tab).",
  NO_OPEN: "Never open a browser tab from the terminal.",
  NO_UP: "`vyre box add` installs Vyre without starting it.",
  NPM_BIN: "The `npm` that `vyre update` installs a release with. Tests point it at a fake.",
  ONBOARD_HOST: "The address onboarding listens on. Default `127.0.0.1`.",
  OPEN_BIN: "The command that opens links. Tests point it at a fake.",
  PROJECT: "The project a thread belongs to, for its brief.",
  RELEASES_API: "Where `vyre update` reads releases. Default `https://api.github.com`. Tests point it at a local server.",
  PROJECTS: "The projects an agent's thread is limited to, comma separated, or `*` for all of them.",
  SCOPE_CWDS: "The folders an agent's `recall.search` is held to, as JSON.",
  SOCKET: "The path of vyred's socket, for the Capsule.",
  SSH_BIN: "The `ssh` binary to run.",
  SUPERVISOR: "What runs vyred: `docker` inside the box container, which changes how `vyre up` restarts it.",
  TAILSCALE_BIN: "The `tailscale` binary to run. A path that does not exist means no tailnet.",
  TAILSCALE_UP_FLAGS: "Extra flags for `tailscale up`, space separated.",
  TEXT_PRUNE_MS: "How long a thread's streamed text events are kept before they are pruned.",
  THREAD: "The session id of a headless thread vyred runs.",
  WRAPPER: "Where `vyre box add` puts the `vyre` command on the server. Default `/usr/local/bin/vyre`.",
  TEST_DIALOGS: "`1`: allow dialogs under tests, for a person at the machine running one test on purpose.",
  TEST_REAL_TAILSCALE: "`1`: let a test use the real tailscale binary.",
};

// ---------------------------------------------------------------------------------------------
// Rendering

function page({ title, summary, audience, owner = "docs", from, body }) {
  return [
    "---",
    `title: ${title}`,
    `summary: ${summary}`,
    `audience: ${audience}`,
    `owner: ${owner}`,
    "status: stable",
    `generated: ${GENERATOR}`,
    "---",
    "",
    `# ${title}`,
    "",
    `> Generated by \`${GENERATOR}\` from ${from}. Do not edit this page: edit the code, then run \`npm run docs:ref\`.`,
    "",
    body.trim(),
    "",
  ].join("\n");
}

function cliPage(commands) {
  const builtins = [
    { name: "help", aliases: ["--help", "-h"], summary: "every command, with a line on what it does", usage: "vyre help", hidden: false, help: "" },
    { name: "version", aliases: ["--version", "-v"], summary: "the version of Vyre installed", usage: "vyre version", hidden: false, help: "" },
  ];
  // A `secret` command (core/cli/index.js) never reaches this page at all: harvest.mjs drops it
  // before writing docs/index.json, so there is nothing here to filter further.
  const shown = [...commands.filter(c => !c.hidden), ...builtins];
  const hidden = commands.filter(c => c.hidden);
  const section = c => {
    const out = [`### vyre ${c.name}`, "", c.summary.charAt(0).toUpperCase() + c.summary.slice(1) + (/[.?!]$/.test(c.summary) ? "" : "."), ""];
    out.push("```", c.usage || `vyre ${c.name}`, "```", "");
    if (c.aliases.length) out.push(`Also: ${c.aliases.map(a => code(a.startsWith("-") ? `vyre ${a}` : `vyre ${a}`)).join(", ")}.`, "");
    if (c.help) out.push(c.help.trim(), "");
    return out.join("\n");
  };
  // Anchors as the page's headings get them: a name used twice (two commands called threads)
  // gets -1 the second time.
  const anchor = slugger();
  const anchors = new Map([...shown, ...hidden].map(c => [c, anchor(`vyre ${c.name}`)]));
  const table = cs => ["| Command | What it does |", "| --- | --- |", ...cs.map(c => `| [${code("vyre " + c.name)}](#${anchors.get(c)}) | ${cell(c.summary)} |`)].join("\n");
  const body = [
    "`vyre` is a thin client: every command is a call to vyred, so the terminal, the Deck and the Capsule never disagree about what is true. With no arguments, `vyre` runs `vyre home` (your projects, a new session and your agents).",
    "",
    "## Commands",
    "",
    "In the order `vyre help` lists them.",
    "",
    table(shown),
    "",
    ...shown.map(section),
    "## Not listed by vyre help",
    "",
    "These work, but `vyre help` leaves them out: they are for the box's service manager, for setup and recovery, or what `vyre` runs with no arguments.",
    "",
    table(hidden),
    "",
    ...hidden.map(section),
  ].join("\n");
  return page({ title: "CLI reference", summary: "Every vyre command, how to call it and what it does, taken from the CLI's own command list.",
    audience: "users, operators, agents", owner: "polish-cli", from: "the command files in `core/cli/commands/`", body });
}

const roleText = roles => (roles || ["box", "local"]).map(code).join(", ");
const surfaces = shows => Object.keys(shows || {}).filter(k => k !== "streams").sort(byName);

function modulesPage(mods, tools) {
  const rows = mods.map(({ dir, manifest: m }) => `| [${code(m.name)}](#${m.name}) | ${code(dir)} | ${roleText(m.roles)} | ${(m.does?.tools || []).length} | ${(m.watches?.emits || []).length} | ${surfaces(m.shows).join(", ") || "none"} |`);
  const sections = mods.map(({ dir, manifest: m }) => {
    const out = [`## ${m.name}`, ""];
    if (m.description) out.push(m.description, "");
    out.push(`- Folder: ${code(dir)}, version ${m.version}`);
    out.push(`- Runs on: ${roleText(m.roles)}`);
    out.push(`- Requires: ${list(m.requires || [])}`);
    const n = (m.does?.tools || []).length;
    out.push(`- Tools: ${n ? `[${n}](tools.md#${m.name})` : "none"}${n && tools.internal(m.name) ? `, ${tools.internal(m.name)} of them only for other modules` : ""}`);
    const emits = m.watches?.emits || [];
    out.push(`- Emits: ${emits.length ? `[${emits.length} events](events.md#${m.name})` : "no events"}`);
    if (m.watches?.on?.length) out.push(`- Listens for: ${list(m.watches.on)}`);
    out.push(`- Shows on: ${surfaces(m.shows).join(", ") || "no surface"}`);
    if (m.shows?.streams?.length) out.push(`- Streams: ${list(m.shows.streams)}`);
    for (const [k, v] of Object.entries(m.needs || {}).sort(([a], [b]) => byName(a, b))) if (Array.isArray(v) ? v.length : v) out.push(`- Needs ${k}: ${Array.isArray(v) ? list(v) : code(JSON.stringify(v))}`);
    for (const [k, v] of Object.entries(m.teaches || {}).sort(([a], [b]) => byName(a, b))) if (Array.isArray(v) ? v.length : v) out.push(`- Teaches ${k}: ${Array.isArray(v) ? list(v) : code(JSON.stringify(v))}`);
    return out.join("\n") + "\n";
  });
  const body = [
    "Everything in Vyre is a module on one contract: core services, Harness pieces, the surfaces and whatever a user installs. Each declares what it does, watches, shows, needs and teaches in its `module.json` and exports `start(ctx)`. See [the module contract](../build/module-contract.md).",
    "",
    "A module runs on the `box` (the always-on server), on `local` (the Mac), or on both. Shows on lists the surfaces it offers itself to: `cli`, `deck`, `capsule`.",
    "",
    "| Module | Folder | Runs on | Tools | Events | Shows on |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    ...sections,
  ].join("\n");
  return page({ title: "Modules", summary: "Every module Vyre ships: where it runs, what it requires, and the tools, events and surfaces it offers.",
    audience: "builders, operators", from: "every `module.json` under `core/`, `local/` and `modules/`", body });
}

/** A schema's type in words. */
function typeOf(s) {
  if (!s || typeof s !== "object") return "any";
  if (Array.isArray(s.enum)) return s.enum.length > 2 ? `one of ${s.enum.map(v => JSON.stringify(v)).join(", ")}` : s.enum.map(v => JSON.stringify(v)).join(" or ");
  const alts = s.oneOf || s.anyOf;
  if (Array.isArray(alts)) return alts.map(typeOf).join(" or ");
  if (Array.isArray(s.type)) return s.type.join(" or ");
  if (s.type === "array") return s.items ? `list of ${typeOf(s.items)}` : "list";
  return s.type || "any";
}

/** The input fields of a tool, one level of nesting deep. */
function fields(schema, prefix = "", depth = 0) {
  const out = [];
  if (!schema || typeof schema !== "object" || !schema.properties) return out;
  const required = new Set(schema.required || []);
  for (const [k, s] of Object.entries(schema.properties).sort(([a], [b]) => (required.has(a) === required.has(b) ? byName(a, b) : required.has(a) ? -1 : 1))) {
    const desc = s && typeof s.description === "string" ? `: ${s.description}` : "";
    out.push(`${"  ".repeat(depth)}- ${code(prefix + k)} ${typeOf(s)}${required.has(k) ? ", required" : ""}${desc}`);
    if (depth < 1 && s && s.type === "object") out.push(...fields(s, "", depth + 1));
    if (depth < 1 && s && s.type === "array" && s.items && s.items.type === "object") out.push(...fields(s.items, "", depth + 1));
  }
  return out;
}

function callersText(t) {
  if (t.internal) return "other modules only (internal: `vyre call` answers no_such_tool)";
  if (t.hook) return "its webhook route only, `POST /v1/<module>/<name>/hook`";
  if (!t.callers) return "any caller";
  return t.callers.slice().sort(byName).map(code).join(", ");
}

/** Every tool, merged across the two role runs, keyed by module. */
function collectTools(root, mods, harvested) {
  /** @type {Map<string, any[]>} */
  const byModule = new Map();
  for (const { dir, manifest: m } of mods) {
    const box = new Map((harvested.box[m.name]?.tools || []).map(t => [t.name, t]));
    const local = new Map((harvested.local[m.name]?.tools || []).map(t => [t.name, t]));
    const both = (m.roles || ["box", "local"]).length > 1;
    const out = [];
    for (const name of [...new Set(m.does?.tools || [])].sort(byName)) {
      const t = box.get(name) || local.get(name);
      if (t) out.push({ ...t, only: both && !(box.has(name) && local.has(name)) ? (box.has(name) ? "box" : "local") : null });
      else out.push({ name, description: staticDescription(root, dir, name), input: null, callers: null, internal: false, hook: false, presence: false, only: null, unregistered: true });
    }
    byModule.set(m.name, out);
  }
  return byModule;
}

function toolsPage(mods, byModule) {
  const sections = [];
  for (const { manifest: m } of mods) {
    const tools = byModule.get(m.name) || [];
    if (!tools.length) continue;
    const out = [`## ${m.name}`, ""];
    for (const t of tools) {
      out.push(`### ${code(t.name)}`, "");
      out.push(t.description ? t.description.trim() : "No description.", "");
      const f = fields(t.input);
      if (t.unregistered) out.push("- Input: not known. The module did not register this tool when started without a live box, so its schema could not be read.");
      else if (f.length) out.push("- Input:", ...f.map(l => "  " + l));
      else out.push("- Input: none");
      out.push(`- Callers: ${callersText(t)}`);
      if (t.presence) out.push("- Needs a person present.");
      if (t.only) out.push(`- Registered only on the ${t.only === "box" ? "box" : "Mac (local)"}.`);
      out.push("");
    }
    sections.push(out.join("\n"));
  }
  const total = [...byModule.values()].reduce((n, ts) => n + ts.length, 0);
  const body = [
    `${total} tools across ${[...byModule.values()].filter(ts => ts.length).length} modules. Every caller reaches a tool through the same path: Claude through MCP, a surface through HTTP, the CLI with \`vyre call <tool> [json]\`. The input is checked against the schema below, then the rules run, then the tool.`,
    "",
    "Callers are the kinds of caller that may use a tool: `cli` (the terminal), `local` (the Mac's own surfaces), `deck`, `capsule`, `mcp` (Claude and agents), `module` (another module). Any caller means the tool does not limit them. See [tools and events](../build/tools-and-events.md).",
    "A tool marked internal is registered, but only another module can call it: `vyre call`, MCP and HTTP answer `no_such_tool`, and `vyre tools` never lists it. A person reaches what it does through a public tool (`agents.history` reads `threads.history`, for example).",
    "",
    "A tool marked \"needs a person present\" runs only after someone proves they are at the machine, with Touch ID, a passkey or the terminal: see [presence](../concepts/presence.md). A call from Claude alone cannot pass it.",
    "",
    ...sections,
  ].join("\n");
  return page({ title: "Tools", summary: "Every tool Vyre's modules offer, grouped by module, with its input and the callers that may use it.",
    audience: "builders, agents", from: "each module's `ctx.tool` definitions and `module.json`", body });
}

function eventsPage(root, mods) {
  const sections = [];
  let total = 0;
  for (const { dir, manifest: m } of mods) {
    const emits = [...new Set(m.watches?.emits || [])].sort(byName);
    const on = [...new Set(m.watches?.on || [])].sort(byName);
    if (!emits.length && !on.length) continue;
    total += emits.length;
    const found = payloads(root, dir, emits);
    const out = [`## ${m.name}`, ""];
    if (emits.length) {
      out.push("| Event | Fields |", "| --- | --- |");
      for (const e of emits) {
        const p = found.get(e);
        const text = !p ? "not found in the source (the type is built at run time)"
          : !p.literal ? "built in a variable before the emit; see the source"
          : [p.always.map(code).join(", ") || "none", p.sometimes.length ? `sometimes ${p.sometimes.map(code).join(", ")}` : ""].filter(Boolean).join("; ");
        out.push(`| ${code(e)} | ${cell(text)} |`);
      }
      out.push("");
    }
    if (on.length) out.push(`Listens for: ${list(on)}`, "");
    sections.push(out.join("\n"));
  }
  const body = [
    `${total} event types. A module may emit only what its manifest declares under \`watches.emits\`; anything else throws. Events land in vyred's event log, where watchers, surfaces and other modules read them. Fields are the payload keys the source passes to \`emit\`; "sometimes" marks keys only some emits carry.`,
    "",
    "See [tools and events](../build/tools-and-events.md) for how to listen.",
    "",
    ...sections,
  ].join("\n");
  return page({ title: "Events", summary: "Every event a module may emit, grouped by module, with the payload fields it carries.",
    audience: "builders", from: "each `module.json`'s `watches` and the `emit` calls in the module's source", body });
}

// What each setting is for. The code has types and defaults but not the why, so the why lives
// here; a key the code gains without a line here shows as "not described yet".
const MEANING = {
  theme: "Your colours, over the defaults in `core/config/theme.js`. The box serves them as `/theme.css`.",
  "theme.colors": "`{ dark: { token: colour }, light: { role: colour } }`, keys as on the design tokens page. A value that is not a plain CSS colour is ignored. Reload the Deck to see a change.",
  name: "This box's name: its address is `<name>.vyre.run`. Set by `vyre name claim`.",
  role: "`box` for the always-on server, `local` for a Mac. Decides which modules start.",
  projectsDir: "The folder new projects are made in. On a box with a `/work` folder and no projectsDir set, `/work/projects` when the box is new (nothing in `~/Vyre/projects`) or its homes were moved with `projects.move`; otherwise `~/Vyre/projects`.",
  roots: "More folders to look in for projects.",
  me: "Who you are, so memory can tell your own people and domains from everyone else's.",
  "me.domains": "Domains that are yours.",
  "me.emails": "Email addresses that are yours. Their domains count as yours too.",
  transcripts: "Where Claude Code keeps session transcripts. Recall indexes these.",
  modules: "Modules to start or stop against their role.",
  "modules.enable": "Modules to start even where their role says not to.",
  "modules.disable": "Modules never to start.",
  network: "How this machine is reached. See [Tailscale](../using/tailscale.md).",
  onboard: "Onboarding's own settings.",
  "network.tailscale": "Whether this machine serves over Tailscale.",
  "network.address": "The https URL the Deck is served at.",
  "network.owner": "The one Tailscale login this box serves (ADR 0002). Set by `vyre owner`.",
  "network.domain": "The domain the box's name is under.",
  "network.via": "`vyre.run` for a name under vyre.run, `ts.net` for the tailnet's own name.",
  "network.port": "The port the tailnet listener serves on.",
  "network.acme": "`staging` to get test certificates while trying things out; `production` otherwise.",
  "network.box": "On a Mac: the address of the box it is paired with.",
  "network.onboardPort": "The loopback port onboarding listens on. 7300 when unset, except 7301 on a Mac chosen as server, which never binds 7300.",
  "network.ownerSeen": "When the owner was first seen on the tailnet. Written by Vyre.",
  "network.origins": "Other sites whose pages may call this box from the owner's browser, with CORS: Vyre's hosted app. `[\"https://app.vyre.run\"]` when unset; `[]` turns it off. Each call but the reachability probe and the token exchange needs a person session.",
  term: "Terminals in the browser. `keep_hours`: how long a terminal nobody is looking at is kept before it ends (12). `max`: how many may be open at once (8). `shell`: the shell to run, in place of your login shell.",
};

/** The fields of a JSDoc object type, top level only: [{ key, optional, type }]. */
export function typedefFields(text) {
  const body = text.trim().replace(/^\{/, "").replace(/\}$/, "");
  return topLevel(body.replace(/\n\s*\*/g, " ")).map(part => {
    const m = part.match(/^([A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/);
    return m ? { key: m[1], optional: Boolean(m[2]), type: m[3].replace(/\s+/g, " ").trim() } : null;
  }).filter(Boolean);
}

export function typedef(src, name) {
  const re = new RegExp(`@typedef\\s*\\{(\\{(?:(?!@typedef)[\\s\\S])*?\\})\\}\\s*${name}\\b`);
  const m = src.match(re);
  return m ? typedefFields(m[1]) : [];
}

/** Each top-level key of the object returned by `function defaults()`, as source text. */
function defaultsSource(src) {
  const i = src.indexOf("function defaults()");
  if (i < 0) return new Map();
  const ret = src.indexOf("return {", i);
  const lit = balanced(src, ret + "return ".length);
  const out = new Map();
  for (const part of topLevel((lit || "{}").slice(1, -1))) {
    const m = part.match(/^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/);
    if (m) out.set(m[1], m[2].replace(/\s+/g, " ").trim());
  }
  return out;
}

/** A default, from its source, in words a reader can use. */
function defaultText(expr) {
  if (!expr) return "unset";
  let s = expr.replace(/path\.join\(os\.homedir\(\),\s*/g, "path.join(\"~\", ");
  s = s.replace(/path\.join\(((?:"[^"]*"\s*,?\s*)+)\)/g, (_, args) => JSON.stringify([...args.matchAll(/"([^"]*)"/g)].map(a => a[1]).join("/")));
  s = s.replace(/process\.platform === "darwin" \? ("[^"]*") : ("[^"]*")/, (_, a, b) => `${a} on macOS, ${b} elsewhere`);
  return s;
}

function configPage(root) {
  const src = fs.readFileSync(path.join(root, "core/config/index.js"), "utf8");
  const cfg = typedef(src, "Config"), net = typedef(src, "Network");
  const defaults = defaultsSource(src);
  const netDefaults = new Map();
  const nd = defaults.get("network");
  if (nd) for (const part of topLevel(nd.slice(1, -1))) { const m = part.match(/^(\w+)\s*:\s*(.+)$/); if (m) netDefaults.set(m[1], m[2].trim()); }
  const meDefaults = new Map(), modDefaults = new Map();
  for (const [into, key] of [[meDefaults, "me"], [modDefaults, "modules"]]) {
    const d = defaults.get(key);
    if (d) for (const part of topLevel(d.slice(1, -1))) { const m = part.match(/^(\w+)\s*:\s*(.+)$/); if (m) into.set(m[1], m[2].trim()); }
  }
  const row = (key, type, optional, def, shown) => `| ${code(key)} | ${cell(code(type.replace(/"/g, "'")))} | ${cell(shown || (def === undefined ? (optional ? "unset" : "none") : code(defaultText(def))))} | ${cell(MEANING[key] || "Not described yet.")} |`;
  const rows = [];
  for (const f of cfg) {
    const sub = f.key === "me" ? meDefaults : f.key === "modules" ? modDefaults : f.key === "network" ? netDefaults : null;
    if (!sub) { rows.push(row(f.key, f.type, f.optional, defaults.get(f.key))); continue; }
    rows.push(row(f.key, "object", f.optional, undefined, f.key === "network" ? "see [network](#network)" : "see below"));
    if (f.key !== "network") for (const inner of typedefFields(f.type)) rows.push(row(`${f.key}.${inner.key}`, inner.type, inner.optional, sub.get(inner.key)));
  }
  const netRows = net.map(f => row(`network.${f.key}`, f.type, f.optional, netDefaults.get(f.key)));
  const env = environment(root);
  const isTest = v => /^VYRE_(TEST|PERF)_/.test(v.name);
  const envRow = v => `| ${code(v.name)} | ${cell(v.note || "Not described yet.")} | ${v.files.map(code).join(", ")} |`;
  const envTable = vs => ["| Variable | What it does | Read in |", "| --- | --- | --- |", ...vs.map(envRow)].join("\n");
  const body = [
    "Vyre keeps everything personal under `VYRE_HOME` (default `~/.vyre`), never in the repository. Settings live in `~/.vyre/config.json`. A missing file is fine: a fresh install has none, and every key has a default. A broken file does not stop vyred; it starts on the defaults and reports the problem.",
    "",
    "Onboarding and commands like `vyre name` and `vyre owner` write this file for you. Edit it by hand only for what they do not cover, then restart vyred with `vyre down` and `vyre up`.",
    "",
    "## config.json",
    "",
    "| Key | Type | Default | What it is for |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "### network",
    "",
    "| Key | Type | Default | What it is for |",
    "| --- | --- | --- | --- |",
    ...netRows,
    "",
    "Modules keep their own settings under a key named after them (`vault`, `recall`, `learn`, and so on). Their pages describe them.",
    "",
    "## Environment variables",
    "",
    "Vyre reads these when they are set. None is needed for normal use.",
    "",
    envTable(env.filter(v => !isTest(v) && !v.set)),
    "",
    "### Set by Vyre",
    "",
    "vyred sets these for the threads and helpers it starts, and the Harness reads them there. Setting them by hand is for tests.",
    "",
    envTable(env.filter(v => !isTest(v) && v.set)),
    "",
    "### For tests and development",
    "",
    envTable(env.filter(isTest)),
    "",
  ].join("\n");
  return page({ title: "Configuration", summary: "The settings in config.json with their types and defaults, and the environment variables Vyre reads.",
    audience: "operators, builders", from: "`core/config/index.js` and every `process.env.VYRE_` read in the shipped code", body });
}

/**
 * Every generated page, as { "reference/cli.md": text, ... }, including the index page
 * (reference/index.md, from terms.js). The index's data file is in generateAll.
 * @param {{ root?: string, tmp?: string, harvested?: any }} [opts]
 */
export function generate(opts = {}) {
  const all = generateAll(opts);
  delete all[INDEX_JSON];
  return all;
}

/**
 * Every generated file under docs/: the reference pages, docs/reference/index.md and
 * docs/index.json. The index reads every published page, so it changes when a page does.
 * @param {{ root?: string, tmp?: string, harvested?: any }} [opts]
 */
export function generateAll({ root = REPO, tmp, harvested } = {}) {
  const data = harvested || harvest({ root, tmp });
  const mods = manifests(root);
  const byModule = collectTools(root, mods, data);
  const tools = { internal: name => (byModule.get(name) || []).filter(t => t.internal).length };
  /** @type {Record<string, string>} */
  const pages = {
    "reference/cli.md": cliPage(data.commands),
    "reference/tools.md": toolsPage(mods, byModule),
    "reference/events.md": eventsPage(root, mods),
    "reference/config.md": configPage(root),
    "reference/modules.md": modulesPage(mods, tools),
  };
  if (fs.existsSync(path.join(root, "docs/nav.json"))) Object.assign(pages, generateIndex({ root, reference: pages }));
  return pages;
}
