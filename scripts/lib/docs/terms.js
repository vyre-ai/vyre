// @ts-check
// terms: the index of every Vyre thing the docs name, and the check that a page never names one
// that is gone.
//
// Things come from the code wherever the code has them:
//   command   `vyre <name>` and `vyre <name> <sub>`, from core/cli/commands (read, not run)
//   tool      every tool a module.json declares under does.tools
//   event     every event a module.json declares under watches.emits
//   config    the keys of config.json: the Config and Network typedefs in core/config, and the keys
//             modules read from their own section (ctx.config.vault.lock and the like)
//   env       every VYRE_ variable the shipped code, the box's files or the scripts read
//   screen    the Deck's routes (deck/js/app.js) and the onboarding pages
//   concept   the curated list below, each with the page that explains it
//
// Mentions come from every published page: inline code spans and fenced code for the code things,
// prose for concepts. Each is recorded as { page, line, anchor }, the anchor being the heading the
// line sits under. The generated reference pages are not mentions: they are where a code thing is
// defined, and give it its `page`.
//
// scripts/gen-docs-reference writes the result as docs/index.json and docs/reference/index.md;
// docs-check fails when either differs from what the code and the pages make now, and (kind
// `stale`) when a page's inline code or command line names a Vyre thing that does not exist.

import fs from "node:fs";
import path from "node:path";
import { manifests, environment, sources, balanced, literalKeys, typedef, typedefFields, SHIPPED, GENERATOR } from "./reference.js";
import { slugger } from "./slug.js";
import { loadDocs } from "./load.js";
import * as markdown from "./markdown.js";

// Page syntax the build and docs-check share: `:::` lines are not prose, and a `> [!SNAG] Title`
// makes an anchor from the same pool as the headings (the pattern is check.js's).
const isDirective = typeof markdown.isDirective === "function" ? markdown.isDirective : () => false;
const SNAG = /^\s*(?:>\s?)+\s*\[!SNAG\](?:[ \t]+(.*?))?\s*$/i;

export const INDEX_MD = "reference/index.md";
export const INDEX_JSON = "index.json";

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const KINDS = ["command", "tool", "event", "config", "env", "screen", "concept"];

// ---------------------------------------------------------------------------------------------
// Concepts: the words the docs teach. Each names the page (and heading) that explains it, a
// pattern for finding it in prose, and where it lives in the code when it has one home there.
// test/docs-index.test.js checks every page, anchor and file named here exists.

/** @type {{ name: string, page: string, match: RegExp, code?: string }[]} */
export const CONCEPTS = [
  { name: "agent", page: "using/agents.md", match: /\bagents?\b/i, code: "core/agents/index.js" },
  { name: "assistant", page: "using/agents.md#talk-to-the-assistant-or-an-agent", match: /\bassistant\b/i, code: "core/agents/index.js" },
  { name: "box", page: "concepts/box-and-mac.md", match: /\bbox(es)?\b/i },
  { name: "brief", page: "using/projects-and-threads.md#see-a-project-and-its-brief", match: /\bbriefs?\b/i, code: "core/harness/index.js" },
  { name: "Capsule", page: "using/capsule.md", match: /\bCapsule\b/, code: "local/capsule/index.js" },
  { name: "Chat", page: "using/chat.md", match: /\bChat\b/, code: "deck/chat/index.js" },
  { name: "computer", page: "using/agents.md#give-an-agent-a-computer", match: /\bcomputers?\b/i, code: "core/computers/index.js" },
  { name: "connector", page: "using/connectors.md", match: /\bconnectors?\b/i },
  { name: "Deck", page: "using/deck.md", match: /\bDeck\b/, code: "deck/index.html" },
  { name: "enforcement", page: "using/learning.md#enforcement", match: /\benforce(?:s|d|ment)?\b/i, code: "core/harness/rules.js" },
  { name: "escalation", page: "using/learning.md#escalation", match: /\bescalat(?:e|es|ed|ion|ions)\b/i, code: "core/learn/index.js" },
  { name: "event log", page: "concepts/floor.md#where-the-floor-lives", match: /\bevent log\b/i, code: "core/events/index.js" },
  { name: "floor", page: "concepts/floor.md", match: /\bfloor\b/i },
  { name: "Gate", page: "using/deck.md#approve-or-change-a-held-draft", match: /\bGate\b/, code: "core/gate/index.js" },
  { name: "Glass", page: "using/glass.md", match: /\bGlass\b/, code: "deck/glass/index.js" },
  { name: "gold marking", page: "using/memory.md#the-gold-marking", match: /\bgold\b/i },
  { name: "grant", page: "using/vault.md#let-an-agent-module-or-watcher-use-an-item", match: /\bgrant(?:s|ed|ing)?\b/i, code: "core/vault/index.js" },
  { name: "harness", page: "concepts/modules.md#kinds-of-module", match: /\bharness\b/i, code: "core/harness/index.js" },
  { name: "headless thread", page: "using/projects-and-threads.md#headless-threads", match: /\bheadless (?:thread|session)s?\b/i, code: "core/switchboard/index.js" },
  { name: "held draft", page: "using/deck.md#approve-or-change-a-held-draft", match: /\bheld drafts?\b|\bdrafts? (?:held|waits?|waiting) at the Gate\b/i, code: "core/gate/index.js" },
  { name: "lease", page: "concepts/floor.md#4-one-screen-types-into-a-thread-at-a-time", match: /\bleases?\b/i, code: "core/switchboard/index.js" },
  { name: "lesson", page: "using/learning.md#lessons-accept-edit-retire", match: /\blessons?\b/i, code: "core/learn/index.js" },
  { name: "Mac", page: "concepts/box-and-mac.md", match: /\bMacs?\b/ },
  { name: "MCP hub", page: "build/mcp-hub.md", match: /\bMCP hub\b/i },
  { name: "memory", page: "using/memory.md", match: /\bmemory\b/i, code: "core/memory/index.js" },
  { name: "module", page: "concepts/modules.md", match: /\bmodules?\b/i, code: "core/modules/index.js" },
  { name: "onboarding", page: "get-started/onboarding.md", match: /\bonboarding\b/i, code: "core/onboard/index.js" },
  { name: "owner", page: "concepts/tailnet.md#the-owner", match: /\bowner\b/i },
  { name: "pairing", page: "using/tailscale.md#connect-your-mac-to-the-box", match: /\bpair(?:s|ed|ing)?\b/i, code: "core/link/index.js" },
  { name: "pass", page: "using/vault.md#share-with-another-person", match: /\b(?:a|the|by|each|every|one|your|sealed|relayed|shared)\s+pass(?:es)?\b|\bpasses\b/i, code: "core/vault/index.js" },
  { name: "passkey", page: "concepts/presence.md#enroll-your-keys", match: /\bpasskeys?\b/i, code: "core/presence/index.js" },
  { name: "presence", page: "concepts/presence.md", match: /\bpresence\b/i, code: "core/presence/index.js" },
  { name: "project", page: "using/projects-and-threads.md", match: /\bprojects?\b/i, code: "core/projects/index.js" },
  { name: "recall", page: "using/memory.md#search-past-sessions", match: /\brecall\b/i, code: "core/recall/index.js" },
  { name: "room", page: "using/memory.md#how-projects-keep-memory-apart", match: /\brooms?\b/i, code: "core/memory/index.js" },
  { name: "signal", page: "using/learning.md#signals-what-vyre-hears", match: /\bsignals?\b/i, code: "core/learn/signals.js" },
  { name: "skill", page: "using/learning.md#skills-from-what-you-repeat", match: /\bskills?\b/i, code: "core/learn/skills.js" },
  { name: "tailnet", page: "concepts/tailnet.md", match: /\btailnets?\b/i },
  { name: "thread", page: "using/projects-and-threads.md", match: /\bthreads?\b/i, code: "core/switchboard/index.js" },
  { name: "vault", page: "using/vault.md", match: /\bvaults?\b/i, code: "core/vault/index.js" },
  { name: "vyred", page: "concepts/box-and-mac.md#one-process-per-machine", match: /\bvyred\b/, code: "core/daemon/index.js" },
  { name: "watcher", page: "using/watchers.md", match: /\bwatchers?\b/i, code: "core/watchers/index.js" },
  { name: "Watchtower", page: "using/vault.md#see-what-you-have", match: /\bWatchtower\b/ },
];

// Where each Deck view is explained, when not on the Deck page's list of views.
const SCREEN_PAGES = {
  agents: "using/agents.md", chat: "using/chat.md", glass: "using/glass.md", memory: "using/memory.md", vault: "using/vault.md",
  onboard: "get-started/onboarding.md",
};
const DECK_VIEWS_PAGE = "using/deck.md#what-is-on-each-view";

// Commands whose first word after the name must be one of their subcommands: anything else is an
// error there, so a page naming another one is stale. The rest take free words (a query, a name).
const STRICT = new Set(["agents", "box", "capsule", "learn", "link", "name", "presence", "vault", "watchers"]);

// Pages that legitimately name old or missing things: history, gaps and the spec. They are
// indexed, but never fail the stale check.
const HISTORY = [/^adr\//, /^changelog\.md$/, /^known-gaps\.md$/, /^architecture\/spec\.md$/];
const GENERATED = /^reference\//;
// A line carrying this comment is not checked, for a page that shows a stale name on purpose.
const IGNORE = "<!-- terms: ignore -->";

// TEMPORARY: stale mentions in pages that other teams are fixing now. Each is { page, text }:
// the page and the exact inline code or command line. Empty this list as the fixes land; a
// listed mention that is no longer on its page fails the check, so the list cannot rot.
/** @type {{ page: string, text: string }[]} */
export const STALE_ALLOWED = [
];

const SHELL = new Set(["sh", "bash", "shell", "zsh", "console", "shell-session"]);
const FILE_EXT = /\.(json|jsonl|js|mjs|cjs|ts|md|html|css|sh|txt|ya?ml|toml|db|sqlite|log|plist|swift|png|svg|jpg|zip|tgz|tar|gz|env|pem|key|crt|app|sock|service|socket|lock|test)$/i;
const DOTTED = /^[a-z][\w-]*(?:\.[a-z0-9][\w-]*)+$/;
const ENV_RE = /\bVYRE_[A-Z0-9_]*[A-Z0-9]\b(?![*<])/g;

// ---------------------------------------------------------------------------------------------
// The things, from the code

/** A string constant's value in a file: const NAME = "..." */
function constString(text, name) {
  const m = text.match(new RegExp(`\\bconst ${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return m ? m[1] : "";
}

/**
 * The subcommands a usage line names. Alternatives (a|b, or split by a middle dot) each give their
 * first word; a bracketed single word ([file], [name]) is a placeholder, not a subcommand.
 *   vyre name [check <n>|claim <n>|ts.net|release]   check, claim, ts.net, release
 *   vyre box add <user@host> | update | backup [file]  add, update, backup
 *   vyre watchers [test|create] [name]               test, create
 */
function usageWords(usage, cmd) {
  const out = [];
  for (const seg of usage.split(`vyre ${cmd}`).slice(1)) {
    const text = seg.split(/\bvyre\s/)[0].replace(/<[^>]*>/g, " ").replace(/\[[^\]|]*\]/g, " ");
    for (const piece of text.split(/[|\u00b7]/)) {
      const w = piece.replace(/[[\]()]/g, " ").trim().split(/\s+/)[0];
      if (w && /^[a-z][\w.-]*$/.test(w)) out.push(w);
    }
  }
  return out;
}

/** The source of the object literal around text[i]. */
function enclosing(text, i) {
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    if (text[j] === "}") depth++;
    else if (text[j] === "{") { if (depth === 0) return balanced(text, j) || text.slice(j); depth--; }
  }
  return text;
}

/** Subcommand words in a command's source. */
function subsIn(text) {
  const subs = new Set();
  const table = text.match(/\bconst SUBS\s*=\s*([[{])/);
  if (table) {
    const lit = balanced(text, /** @type {number} */ (table.index) + table[0].length - 1) || "";
    if (table[1] === "[") for (const m of lit.matchAll(/"([a-z][\w.-]*)"/g)) subs.add(m[1]);
    else for (const k of literalKeys(lit).always) subs.add(k);
    return subs;
  }
  for (const m of text.matchAll(/\b(?:sub|verb|action|args\[0\])\s*===\s*"([a-z][\w.-]*)"/g)) subs.add(m[1]);
  for (const m of text.matchAll(/\bcase\s+"([a-z][\w.-]*)"\s*:/g)) subs.add(m[1]);
  for (const m of text.matchAll(/\[((?:\s*"[a-z][\w.-]*"\s*,?)+)\]\.includes\((?:sub|verb|action)\)/g)) for (const w of m[1].matchAll(/"([^"]+)"/g)) subs.add(w[1]);
  for (const m of text.matchAll(/(\{[^{}]*\})\s*\[\s*(?:sub|verb|action)\b/g)) for (const k of literalKeys(m[1]).always) subs.add(k);
  return subs;
}

/**
 * Every `vyre` command, read from core/cli/commands without running it.
 * @returns {{ name: string, aliases: string[], file: string, subs: string[], strict: boolean, secret: boolean }[]}
 */
export function cliCommands(root) {
  const dir = path.join(root, "core/cli/commands");
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith(".js") && !f.endsWith(".test.js")).sort(byName); } catch { return []; }
  /** @type {Map<string, { name: string, aliases: Set<string>, file: string, order: number, subs: Set<string> }>} */
  const found = new Map();
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const objs = [];
    for (const m of text.matchAll(/\bname:\s*"([a-z][a-z-]*)"/g)) {
      const obj = enclosing(text, /** @type {number} */ (m.index));
      if (!/\bsummary\s*:/.test(obj) || !/\brun\b/.test(obj)) continue;
      objs.push({ name: m[1], obj });
    }
    for (const { name, obj } of objs) {
      const usageLit = obj.match(/\busage:\s*"((?:[^"\\]|\\.)*)"/);
      const usageRef = obj.match(/\busage(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*[,}]/);
      const usage = usageLit ? usageLit[1] : usageRef ? [constString(text, usageRef[1] || "usage"), constString(text, "USAGE")].join(" ") : "";
      const order = Number((obj.match(/\border:\s*(\d+)/) || [])[1] ?? 50);
      const secret = /\bsecret\s*:\s*true\b/.test(obj);
      const aliases = [...((obj.match(/\baliases:\s*\[([^\]]*)\]/) || [])[1] || "").matchAll(/"([^"]+)"/g)].map(a => a[1]);
      // Subcommands are compared in the command's own object, or in the run function it names
      // (box.js: `run` defined above the export). A file's SUBS table serves its one command.
      let body = obj;
      if (!/\brun\s*\(/.test(obj)) { const fnAt = text.search(/\bfunction run\s*\(/); if (fnAt >= 0) body += balanced(text, text.indexOf("{", text.indexOf(")", fnAt))) || ""; }
      if (objs.length === 1 && /\bconst SUBS\s*=/.test(text)) body = text;
      const subs = new Set([...subsIn(body), ...usageWords(usage, name)]);
      const rec = found.get(name);
      if (!rec) found.set(name, { name, aliases: new Set(aliases), file: `core/cli/commands/${f}`, order, subs, secret });
      else {
        for (const a of aliases) rec.aliases.add(a);
        for (const s of subs) rec.subs.add(s);
        if (order < rec.order) { rec.order = order; rec.file = `core/cli/commands/${f}`; }
      }
    }
  }
  // On a Docker box, the host's `vyre` (box/vyre) answers a few words itself and passes the rest
  // to the CLI in the container: `vyre update` and `vyre logs` exist only there.
  try {
    const wrapper = fs.readFileSync(path.join(root, "box/vyre"), "utf8");
    const block = wrapper.slice(wrapper.search(/\bcase "\$\{1:-\}" in\b/));
    for (const m of block.matchAll(/^\s{2}([a-z][a-z-]*)\)/gm)) if (!found.has(m[1])) found.set(m[1], { name: m[1], aliases: new Set(), file: "box/vyre", order: 99, subs: new Set() });
  } catch {}
  const out = [...found.values()].map(c => ({ name: c.name, aliases: [...c.aliases].sort(byName), file: c.file, subs: [...c.subs].filter(s => s !== c.name).sort(byName), strict: STRICT.has(c.name), secret: Boolean(c.secret) }));
  out.push({ name: "help", aliases: ["--help", "-h"], file: "core/cli/index.js", subs: [], strict: false });
  out.push({ name: "version", aliases: ["--version", "-v"], file: "core/cli/index.js", subs: [], strict: false });
  return out.sort((a, b) => byName(a.name, b.name));
}

/** Where a string literal first appears in a folder's sources, else the fallback. */
function firstFile(root, dir, literal, fallback) {
  const q = [`"${literal}"`, `'${literal}'`, "`" + literal + "`"];
  for (const file of sources(path.join(root, dir))) {
    const text = fs.readFileSync(file, "utf8");
    if (q.some(s => text.includes(s))) return path.relative(root, file).split(path.sep).join("/");
  }
  return fallback;
}

/** The keys of config.json: the typedefs, and what modules read from their own sections. */
export function configKeys(root) {
  /** @type {Map<string, string>} key -> file */
  const keys = new Map();
  const cfgFile = "core/config/index.js";
  let src = "";
  try { src = fs.readFileSync(path.join(root, cfgFile), "utf8"); } catch { return keys; }
  const top = typedef(src, "Config");
  for (const f of top) {
    keys.set(f.key, cfgFile);
    if (f.key === "network") for (const n of typedef(src, "Network")) keys.set(`network.${n.key}`, cfgFile);
    else if (/^\{/.test(f.type)) for (const inner of typedefFields(f.type)) keys.set(`${f.key}.${inner.key}`, cfgFile);
  }
  const parents = new Set([...top.map(f => f.key), ...manifests(root).map(m => m.manifest.name)]);
  const add = (segs, file) => {
    if (!parents.has(segs[0]) || segs.some(s => !/^[A-Za-z_$][\w$]*$/.test(s))) return;
    for (let i = 1; i <= segs.length; i++) { const k = segs.slice(0, i).join("."); if (!keys.has(k)) keys.set(k, file); }
  };
  const chain = /\bconfig\??\.([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)(\s*\()?/g;
  for (const file of SHIPPED.flatMap(d => sources(path.join(root, d)))) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(root, file).split(path.sep).join("/");
    for (const m of text.matchAll(chain)) { const segs = m[1].split(/\??\./); if (m[2]) segs.pop(); if (segs.length) add(segs, rel); }
    // const opts = (ctx.config && ctx.config.vault) || {}; then opts.keystore, opts().x, or { a, b } = opts
    for (const m of text.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(\(\)\s*=>\s*)?([^;\n]*?)\|\|\s*\{\}/g)) {
      const chains = [...m[3].matchAll(/\bconfig\??\.([\w$]+(?:\??\.[\w$]+)*)/g)];
      if (!chains.length) continue;
      const base = chains[chains.length - 1][1].split(/\??\./);
      if (!parents.has(base[0])) continue;
      const v = m[1].replace(/\$/g, "\\$"), call = m[2] ? "\\(\\)" : "";
      for (const r of text.matchAll(new RegExp(`(?<![\\w$.])${v}${call}\\??\\.([A-Za-z_$][\\w$]*)(\\s*\\()?`, "g"))) if (!r[2]) add([...base, r[1]], rel);
      for (const r of text.matchAll(new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${v}${call}(?![\\w$])`, "g"))) {
        for (const p of r[1].split(",")) { const k = p.trim().match(/^([A-Za-z_$][\w$]*)/); if (k) add([...base, k[1]], rel); }
      }
    }
  }
  return keys;
}

/** VYRE_ variables: what the shipped code reads, plus the box's files and the scripts. */
export function envVars(root) {
  /** @type {Map<string, string>} name -> first file */
  const out = new Map();
  for (const v of environment(root)) out.set(v.name, v.files[0]);
  const extra = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, d), { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => byName(a.name, b.name))) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "lib") continue;
      const r = `${d}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (!/\.(test\.js|png|svg|jpg|ico)$/.test(e.name)) extra.push(r);
    }
  };
  walk("box");
  walk("scripts");
  for (const r of extra) {
    const text = fs.readFileSync(path.join(root, r), "utf8");
    for (const m of text.matchAll(/\$\{?(VYRE_[A-Z0-9_]+)|\benv(?:\.|\[["'])(VYRE_[A-Z0-9_]+)/g)) {
      const name = m[1] || m[2];
      if (!out.has(name)) out.set(name, r);
    }
  }
  return out;
}

/** The Deck's views and their routes, and the onboarding pages. */
export function screens(root) {
  const out = [];
  let app = "";
  try { app = fs.readFileSync(path.join(root, "deck/js/app.js"), "utf8"); } catch { return out; }
  const routes = app.match(/\bconst ROUTES\s*=\s*\[/);
  if (!routes) return out;
  const lit = balanced(app, /** @type {number} */ (routes.index) + routes[0].length - 1) || "";
  /** @type {Map<string, string[]>} */ const byView = new Map();
  for (const m of lit.matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/g)) {
    if (!byView.has(m[2])) byView.set(m[2], []);
    /** @type {string[]} */ (byView.get(m[2])).push(m[1]);
  }
  const labels = new Map([...app.matchAll(/\{\s*href:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)].map(m => [m[1], m[2]]));
  for (const [view, paths] of byView) {
    out.push({ name: paths[0], label: labels.get(paths[0]) || view.charAt(0).toUpperCase() + view.slice(1), routes: paths,
      file: fs.existsSync(path.join(root, `deck/views/${view}.js`)) ? `deck/views/${view}.js` : "deck/js/app.js", page: SCREEN_PAGES[view] || DECK_VIEWS_PAGE });
  }
  if (fs.existsSync(path.join(root, "deck/onboard/index.html"))) out.push({ name: "/onboard", label: "Onboarding", routes: ["/onboard"], file: "deck/onboard/index.html", page: SCREEN_PAGES.onboard });
  if (fs.existsSync(path.join(root, "deck/onboard/passkey"))) out.push({ name: "/onboard/passkey", label: "Add a passkey", routes: ["/onboard/passkey"], file: "deck/onboard/passkey", page: "using/deck.md#add-a-passkey" });
  return out.sort((a, b) => byName(a.name, b.name));
}

/**
 * Everything the code knows, for matching mentions against.
 * @param {string} root
 */
export function known(root) {
  const mods = manifests(root);
  const commands = cliCommands(root);
  /** @type {Map<string, { module: string, file: string }>} */ const tools = new Map();
  /** @type {Map<string, { module: string, file: string }>} */ const events = new Map();
  for (const { dir, manifest: m } of mods) {
    for (const t of new Set(m.does?.tools || [])) if (!tools.has(t)) tools.set(t, { module: m.name, file: firstFile(root, dir, t, `${dir}/module.json`) });
    for (const e of new Set(m.watches?.emits || [])) if (!events.has(e)) events.set(e, { module: m.name, file: firstFile(root, dir, e, `${dir}/module.json`) });
  }
  const config = configKeys(root);
  const env = envVars(root);
  // The module context's own API (ctx.vault.fetch, ctx.store.migrate): named in the docs as
  // vault.fetch, and real, though neither a tool nor an event.
  const api = new Set();
  for (const file of SHIPPED.flatMap(d => sources(path.join(root, d)))) {
    for (const m of fs.readFileSync(file, "utf8").matchAll(/\bctx\.([a-z]\w*)\.([a-z]\w*)/g)) api.add(`${m[1]}.${m[2]}`);
  }
  // Every dotted name, and every prefix of one: `glass.files` is a real namespace.
  const names = new Set([...tools.keys(), ...events.keys(), ...config.keys(), ...api]);
  const prefixes = new Set();
  for (const n of names) { const s = n.split("."); for (let i = 1; i < s.length; i++) prefixes.add(s.slice(0, i).join(".")); }
  // Namespaces whose children the code lists in full: a tool's or an event's, and config.json's
  // own sections. A name under one of these that is not listed does not exist.
  const complete = new Set();
  for (const n of [...tools.keys(), ...events.keys()]) { const s = n.split("."); for (let i = 1; i < s.length; i++) complete.add(s.slice(0, i).join(".")); }
  for (const k of config.keys()) if (config.get(k) === "core/config/index.js" && k.includes(".")) complete.add(k.split(".")[0]);
  const cmd = new Map();
  for (const c of commands) { cmd.set(c.name, c); for (const a of c.aliases) if (!a.startsWith("-")) cmd.set(a, c); }
  return { commands, cmd, tools, events, config, env, api, names, prefixes, complete, screens: screens(root) };
}

// ---------------------------------------------------------------------------------------------
// Reading the pages

/**
 * Walk a page line by line: fences, headings and the anchor each line sits under.
 * @param {string} source @param {string} docsDir @param {string} rel
 * @param {(l: { n: number, raw: string, fence: string | null, anchor: string, heading: boolean, title?: string }) => void} fn
 *   title: set on each line that makes an anchor (a heading, a setext underline, a [!SNAG] title)
 */
function walkPage(source, docsDir, rel, fn) {
  const lines = source.split("\n");
  let i = 0;
  if (lines[0]?.trim() === "---") { for (i = 1; i < lines.length && lines[i].trim() !== "---"; i++); i++; }
  const slug = slugger();
  let fence = null, lang = "", anchor = "", prev = "";
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const f = raw.match(/^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !raw.trim().slice(f[1].length).trim()) { fence = null; continue; }
      fn({ n: i + 1, raw, fence: lang, anchor, heading: false });
      continue;
    }
    if (f) { fence = f[1]; lang = (f[2] || "").toLowerCase(); continue; }
    const inc = raw.match(/^\s*<!--\s*include:\s*(\S+)\s*-->\s*$/);
    if (inc) {
      // An included file's headings take slugs too, so a later heading's anchor counts them.
      const abs = path.resolve(path.dirname(path.join(docsDir, rel)), inc[1]);
      try {
        walkPage(fs.readFileSync(abs, "utf8"), docsDir, rel, l => { if (l.title !== undefined) slug(l.title); });
      } catch {}
      prev = "";
      continue;
    }
    if (isDirective(raw)) continue;
    const atx = raw.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (atx) { anchor = slug(atx[2]); fn({ n: i + 1, raw, fence: null, anchor, heading: true, title: atx[2] }); prev = raw; continue; }
    const snag = raw.match(SNAG);
    if (snag) { const title = snag[1] || "If this happens"; anchor = slug(title); fn({ n: i + 1, raw, fence: null, anchor, heading: false, title }); prev = raw; continue; }
    if (/^\s{0,3}(=+|-+)\s*$/.test(raw) && prev.trim() && !/^\s{0,3}([-*+]|\d+[.)])\s|^\s*\||^\s*>|^\s{0,3}#/.test(prev) && !/^\s*-+\s*$/.test(prev)) {
      anchor = slug(prev.trim());
      fn({ n: i + 1, raw: "", fence: null, anchor, heading: false, title: prev.trim() });
      prev = raw;
      continue;
    }
    fn({ n: i + 1, raw, fence: null, anchor, heading: false });
    prev = raw;
  }
}

/** Inline code spans in a line: their text, trimmed the way markdown does. */
function spans(raw) {
  return [...raw.matchAll(/(`+)((?:(?!\1)[\s\S])+?)\1(?!`)/g)].map(m => m[2].replace(/^ (.*) $/, "$1"));
}

/** A line with its code, links' targets, HTML and URLs taken out: the words a reader reads. */
function proseOf(raw) {
  return raw.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, " ").replace(/\]\([^)]*\)/g, "] ").replace(/<[^>]+>/g, " ").replace(/\bhttps?:\/\/\S+/g, " ");
}

/** Shell words, quotes kept together. */
function words(line) {
  return [...line.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map(m => m[0]);
}

/** The `vyre ...` commands in a line of shell: each as its words from `vyre` on. */
function commandLines(line) {
  const out = [];
  const text = line.replace(/^\s*[$%#>]\s+/, "").replace(/\s+#\s.*$/, "");
  for (const part of text.split(/\s*(?:&&|\|\||;|\|)\s*/)) {
    const w = words(part.trim());
    let i = 0;
    while (i < w.length && (/^[A-Z_][A-Z0-9_]*=/.test(w[i]) || w[i] === "sudo" || w[i] === "exec")) i++;
    if (w[i] === "vyre") out.push(w.slice(i));
  }
  return out;
}

const placeholder = w => /[<>[\]{}$*\u2026]|\.\.\./.test(w);

// ---------------------------------------------------------------------------------------------
// Mentions and stale names

/**
 * Scan pages. For each line, hands `found(key, where)` every thing it names and `stale(text, why,
 * where)` every inline code or command line that names a Vyre thing that does not exist.
 * @param {ReturnType<typeof known>} k
 * @param {{ rel: string, source: string }[]} pages
 * @param {string} docsDir
 * @param {{ found?: (key: string, at: { page: string, line: number, anchor: string }) => void,
 *   stale?: (text: string, why: string, at: { page: string, line: number, anchor: string }) => void }} on
 */
export function scan(k, pages, docsDir, on) {
  const found = on.found || (() => {});
  const stale = on.stale || (() => {});
  const conceptRes = CONCEPTS.map(c => ({ key: `concept\0${c.name}`, re: c.match }));
  const routeRes = k.screens.map(s => ({ key: `screen\0${s.name}`, res: s.routes.map(r => new RegExp("^" + r.split("/").map(seg => (seg.startsWith(":") ? "[^/\\s]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/") + "/?$")) }));
  const topKeys = [...k.config.keys()].filter(key => !key.includes("."));
  for (const { rel, source } of pages) {
    const checked = !HISTORY.some(re => re.test(rel)) && !GENERATED.test(rel);
    walkPage(source, docsDir, rel, ({ n, raw, fence, anchor }) => {
      const at = { page: rel, line: n, anchor };
      const check = checked && !raw.includes(IGNORE);
      const hit = key => found(key, at);

      /** A `vyre ...` command, as words. */
      const command = (w, text) => {
        const name = w[1];
        if (name === "--help" || name === "-h") { hit("command\0vyre help"); return; }
        if (name === "--version" || name === "-v") { hit("command\0vyre version"); return; }
        if (!name || placeholder(name) || !/^[a-z][a-z-]*$/.test(name)) return;
        const c = k.cmd.get(name);
        if (!c) { if (check) stale(text, `vyre ${name} is not a command`, at); return; }
        hit(`command\0vyre ${c.name}`);
        const rest = w.slice(2);
        const sub = rest.find(x => !x.startsWith("-"));
        if (sub && !placeholder(sub) && /^[a-z][\w.-]*$/.test(sub)) {
          if (c.subs.includes(sub)) hit(`command\0vyre ${c.name} ${sub}`);
          else if (c.strict && check && rest.indexOf(sub) === 0) stale(text, `vyre ${c.name} ${sub}: ${sub} is not a subcommand of vyre ${c.name}`, at);
        }
        if (c.name === "call") {
          const tool = rest.find(x => !x.startsWith("-"));
          if (tool && DOTTED.test(tool)) {
            // A tool under one of Vyre's own namespaces must exist; `invoices.list` is someone's module.
            if (k.tools.has(tool)) hit(`tool\0${tool}`);
            else if (check && k.complete.has(tool.split(".")[0])) stale(text, `vyre call ${tool}: there is no tool ${tool}`, at);
          }
        }
      };

      /** A dotted name: a tool, an event, a config key; or, under a namespace the code lists in full, stale. */
      const dotted = (name, strict) => {
        let any = false;
        if (k.tools.has(name)) { hit(`tool\0${name}`); any = true; }
        if (k.events.has(name)) { hit(`event\0${name}`); any = true; }
        if (k.config.has(name)) { hit(`config\0${name}`); any = true; }
        if (any || !strict || !check || k.names.has(name) || k.prefixes.has(name) || FILE_EXT.test(name)) return;
        const s = name.split(".");
        let p = "";
        for (let i = s.length - 1; i >= 1; i--) { const pre = s.slice(0, i).join("."); if (k.names.has(pre) || k.prefixes.has(pre)) { p = pre; break; } }
        if (p && k.complete.has(p)) stale(name, `${name}: no tool, event or config key has this name`, at);
      };

      const envs = (text, strict) => {
        for (const m of text.matchAll(ENV_RE)) {
          if (k.env.has(m[0])) hit(`env\0${m[0]}`);
          else if (strict && check) stale(m[0], `${m[0]} is not read anywhere in Vyre`, at);
        }
      };

      if (fence !== null) {
        const shell = SHELL.has(fence);
        if (shell) for (const w of commandLines(raw)) command(w, w.join(" "));
        for (const m of raw.matchAll(/(?<![\w.$/-])([a-z][\w-]*(?:\.[a-z0-9][\w-]*)+)(?![\w-]|\.\w)/g)) dotted(m[1], false);
        envs(raw, shell);
        return;
      }
      for (const s of spans(raw)) {
        const t = s.trim();
        for (const w of commandLines(t)) command(w, t);
        if (DOTTED.test(t)) dotted(t, true);
        else for (const m of t.matchAll(/(?<![\w.$/-])([a-z][\w-]*(?:\.[a-z0-9][\w-]*)+)(?![\w-]|\.\w)/g)) dotted(m[1], false);
        envs(t, true);
        if (t.startsWith("/")) for (const r of routeRes) if (r.res.some(re => re.test(t.replace(/<[^>]+>/g, "x")))) hit(r.key);
        if (topKeys.includes(t) && /\bconfig(\.json)?\b|\bsetting/i.test(raw)) hit(`config\0${t}`);
      }
      const prose = proseOf(raw);
      envs(prose, false);
      for (const c of conceptRes) if (c.re.test(prose)) hit(c.key);
    });
  }
}

/** The published pages under a root, as { rel, source }, leaving out the index itself. */
function publishedPages(root) {
  const docs = loadDocs(root);
  return docs.filter(p => p.path !== INDEX_MD).map(p => ({ rel: p.path, source: p.source }));
}

/**
 * Stale mentions: problems for docs-check, { file, line, kind: "stale", problem }.
 * @param {string} root
 * @param {{ rel: string, source: string }[]} [pages] default: every published page
 */
export function staleMentions(root, pages) {
  if (!fs.existsSync(path.join(root, "core/cli/commands"))) return [];
  const k = known(root);
  const list = pages || publishedPages(root);
  const out = [];
  const used = new Set();
  scan(k, list, path.join(root, "docs"), {
    stale(text, why, at) {
      const i = STALE_ALLOWED.findIndex(a => a.page === at.page && a.text === text);
      if (i >= 0) { used.add(i); return; }
      out.push({ file: `docs/${at.page}`, line: at.line, kind: "stale", problem: `stale mention: ${why}` });
    },
  });
  STALE_ALLOWED.forEach((a, i) => {
    if (!used.has(i)) out.push({ file: "scripts/lib/docs/terms.js", line: 1, kind: "stale", problem: `STALE_ALLOWED lists \`${a.text}\` on ${a.page}, which is no longer there; take it off the list` });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// The index

/**
 * Every thing with its mentions, sorted.
 * @param {{ root: string, reference?: Record<string, string> }} opts reference: the generated
 *   reference pages, where each code thing is defined (its `page`)
 */
export function buildIndex({ root, reference = {} }) {
  const k = known(root);
  /** @type {Map<string, { kind: string, name: string, definedIn: string | null, page: string | null, mentions: { page: string, line: number, anchor: string }[], [x: string]: any }>} */
  const things = new Map();
  const put = (kind, name, definedIn, page, extra = {}) => things.set(`${kind}\0${name}`, { kind, name, definedIn, page, ...extra, mentions: [] });
  // A `secret` command (core/cli/index.js) gets no index entry at all: found only by typing it,
  // never by reading a generated doc. known(root).commands still lists it, for the "terms: the
  // real tree" parity check against the CLI's own command list.
  for (const c of k.commands.filter(c => !c.secret)) {
    put("command", `vyre ${c.name}`, c.file, null, c.aliases.length ? { aliases: c.aliases } : {});
    for (const s of c.subs) put("command", `vyre ${c.name} ${s}`, c.file, null);
  }
  for (const [name, t] of k.tools) put("tool", name, t.file, null, { module: t.module });
  for (const [name, e] of k.events) put("event", name, e.file, null, { module: e.module });
  for (const [name, file] of k.config) put("config", name, file, null);
  for (const [name, file] of k.env) put("env", name, file, null);
  for (const s of k.screens) put("screen", s.name, s.file, s.page, { label: s.label, routes: s.routes });
  for (const c of CONCEPTS) put("concept", c.name, c.code || null, c.page);

  // Where each code thing is defined in the reference pages: its heading there, else its first line.
  const refPages = Object.entries(reference).filter(([r]) => r.startsWith("reference/") && r !== INDEX_MD && r.endsWith(".md")).sort(([a], [b]) => byName(a, b));
  /** @type {Map<string, { page: string, anchor: string, heading: boolean }>} */ const defs = new Map();
  const define = (key, page, anchor, heading) => {
    const d = defs.get(key);
    if (!d || (heading && !d.heading)) defs.set(key, { page, anchor, heading });
  };
  /** @type {Set<string>} "page:line" of every heading */ const headings = new Set();
  for (const [rel, source] of refPages) {
    walkPage(source, path.join(root, "docs"), rel, l => {
      if (!l.heading) return;
      headings.add(`${rel}:${l.n}`);
      // cli.md's headings are `### vyre up`, plain text.
      const c = l.raw.match(/^\s{0,3}#{1,6}\s+vyre ([a-z][a-z-]*)\s*$/);
      if (c) define(`command\0vyre ${c[1]}`, rel, l.anchor, true);
    });
    // config.md's tables: a row's first cell is the key or variable it describes.
    walkPage(source, path.join(root, "docs"), rel, l => {
      const row = l.fence === null && l.raw.match(/^\|\s*`([^`]+)`\s*\|/);
      if (!row) return;
      if (k.config.has(row[1])) define(`config\0${row[1]}`, rel, l.anchor, true);
      if (k.env.has(row[1])) define(`env\0${row[1]}`, rel, l.anchor, true);
    });
  }
  scan(k, refPages.map(([rel, source]) => ({ rel, source })), path.join(root, "docs"), {
    found(key, at) { define(key, at.page, at.anchor, headings.has(`${at.page}:${at.line}`)); },
  });
  for (const [key, t] of things) {
    if (t.page) continue;
    const d = defs.get(key) || (t.kind === "command" ? defs.get(`command\0${t.name.split(" ").slice(0, 2).join(" ")}`) : undefined);
    if (d) t.page = d.anchor ? `${d.page}#${d.anchor}` : d.page;
  }

  scan(k, publishedPages(root).filter(p => !GENERATED.test(p.rel)), path.join(root, "docs"), {
    found(key, at) {
      const t = things.get(key);
      if (!t) return;
      const last = t.mentions[t.mentions.length - 1];
      if (last && last.page === at.page && last.line === at.line) return;
      t.mentions.push({ ...at });
    },
  });
  const sortKey = t => t.name.toLowerCase().replace(/^[^a-z0-9]+/, "");
  return [...things.values()].sort((a, b) => byName(sortKey(a), sortKey(b)) || byName(a.name, b.name) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
}

/** docs/index.json: one line per thing, so a diff shows what changed. */
export function indexJson(things) {
  const counts = Object.fromEntries(KINDS.map(kind => [kind, things.filter(t => t.kind === kind).length]));
  const order = ["kind", "name", "definedIn", "page", "aliases", "module", "label", "routes", "mentions"];
  const line = t => JSON.stringify(Object.fromEntries(order.filter(key => t[key] !== undefined).map(key => [key, t[key]])));
  return [
    "{",
    `  "generated": ${JSON.stringify(GENERATOR)},`,
    `  "about": "Every Vyre command, tool, event, config key, environment variable, screen and concept, where the code defines it, the docs page that explains it, and every page, line and heading anchor that mentions it.",`,
    `  "counts": ${JSON.stringify(counts)},`,
    `  "things": [`,
    things.map(t => "    " + line(t)).join(",\n"),
    "  ]",
    "}",
    "",
  ].join("\n");
}

const KIND_WORD = { command: "command", tool: "tool", event: "event", config: "config key", env: "environment variable", screen: "screen", concept: "concept" };

/** docs/reference/index.md: A to Z. */
export function indexPage(things) {
  const link = (page, text) => {
    const [p, a] = page.split("#");
    const rel = path.posix.relative("reference", p) || path.posix.basename(p);
    // hygiene's secret pattern takes an anchor like #ask-your-assistant-or-a-model for an sk- key;
    const hash = a ? "#" + a : "";
    return `[${text}](${rel}${hash})`;
  };
  const letter = t => (t.name.match(/[A-Za-z0-9]/)?.[0] || "#").toUpperCase();
  const letters = [...new Set(things.map(letter))];
  const counts = KINDS.map(kind => `${things.filter(t => t.kind === kind).length} ${KIND_WORD[kind]}${things.filter(t => t.kind === kind).length === 1 ? "" : "s"}`).join(", ");
  const out = [
    "---",
    "title: Index",
    "summary: Every command, tool, event, config key, environment variable, screen and concept, with the page that explains it and every page and line that mentions it.",
    "audience: users, builders, operators, agents",
    "owner: docs",
    "status: stable",
    `generated: ${GENERATOR}`,
    "---",
    "",
    "# Index",
    "",
    `> Generated by \`${GENERATOR}\` from the code and every published page. Do not edit this page: run \`npm run docs:ref\` after changing either. The same data, for scripts and agents, is in \`docs/index.json\`.`,
    "",
    `${counts}. Each entry links to the page that explains it, then lists every line that mentions it, by page, each line number linking to the heading it is under. Code things are found in inline code and code blocks, concepts in the prose. \`npm run docs:check\` fails when a page names a command, subcommand, tool, config key or environment variable that no longer exists.`,
    "",
    letters.map(l => `[${l}](#${l.toLowerCase()})`).join(" "),
    "",
  ];
  for (const l of letters) {
    out.push(`## ${l}`, "");
    for (const t of things.filter(x => letter(x) === l)) {
      const explained = t.page ? link(t.page, "explained") : "not explained on any page yet";
      // By page, then by heading: the lines under one heading share its link.
      /** @type {Map<string, Map<string, number[]>>} */ const byPage = new Map();
      for (const m of t.mentions) {
        if (!byPage.has(m.page)) byPage.set(m.page, new Map());
        const anchors = /** @type {Map<string, number[]>} */ (byPage.get(m.page));
        if (!anchors.has(m.anchor)) anchors.set(m.anchor, []);
        /** @type {number[]} */ (anchors.get(m.anchor)).push(m.line);
      }
      const at = [...byPage].map(([page, anchors]) => `${page} ${[...anchors].map(([a, ls]) => link(a ? `${page}#${a}` : page, ls.join(", "))).join(", ")}`).join("; ");
      const n = t.mentions.length;
      out.push(`- \`${t.name.replace(/`/g, "'")}\` ${KIND_WORD[t.kind]}, ${explained}. ${n ? `${n} mention${n === 1 ? "" : "s"}: ${at}` : "No mentions."}`);
    }
    out.push("");
  }
  return out.join("\n");
}

/**
 * Both index files, keyed as the reference pages are (relative to docs/).
 * @param {{ root: string, reference: Record<string, string> }} opts
 */
export function generateIndex({ root, reference }) {
  const things = buildIndex({ root, reference });
  return { [INDEX_MD]: indexPage(things), [INDEX_JSON]: indexJson(things) };
}
