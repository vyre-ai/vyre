// @ts-check
// The skills and plugins library (R031-18..21), the parts that need no store: what a skill or a plugin is, how it is checked, who sees which at which level, what a plugin declares (so the person is
// asked about exactly that), and how the approved ones are written for each AI. core/skills keeps the versions (records) and the approvals; this file never touches either.
//
//   a skill   a SKILL.md: front matter with `name` and `description`, then the instructions. Any AI that reads the open Agent Skills format uses it unchanged.
//   a plugin  JSON: { name, description, skills: [{ name, body }], commands: [{ name, body }], hooks: [{ id, event, script, network? }], mcp: [{ name, transport, command?, args?, url?, connection? }] }
//             Skills and commands are text. A hook is a short script run in Vyre's script sandbox (no network of its own, only the hosts it declares). An MCP server becomes a Connection.
//             A plugin with a hook or an MCP server has CODE: installing it needs its level's owner to say yes to exactly what it declares.
//
// Levels, widest first: space (everyone's agents), personal (one person's, and the agents working for them), agent (one agent's toolkit), project (inside one project). The narrower level wins a name.

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import fs from "node:fs";
import path from "node:path";
import { frontMatter } from "./docs-corpus.js";
import { credentialIn } from "./credential-shapes.js";
import { AIS } from "./ai-ids.js";
import { resolveApproved } from "./skill-resolve.js";

export const LEVELS = Object.freeze(["space", "personal", "agent", "project"]);
export { AIS };
export const LIMITS = Object.freeze({ body: 64 * 1024, plugin: 256 * 1024, skills: 40, commands: 40, hooks: 10, mcp: 10, hosts: 10, script: 32 * 1024 });
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const bad = (/** @type {string} */ message, code = "bad_input") => Object.assign(new Error(message), { code });
const sha = (/** @type {string} */ s) => bytesToHex(sha256(new TextEncoder().encode(s))).slice(0, 24);
const isObj = (/** @type {any} */ v) => v && typeof v === "object" && !Array.isArray(v);

/**
 * A key a plugin's MCP server needs (Vault-backed env). The plugin names the variable, never a value. A server that is given a key runs registry code with it and the code can send it anywhere, so it must be
 * pinned (an exact version, or a container digest), and a variable that changes how a program loads or where it connects is refused (sec53, 18 Oct 2026).
 */
export const NEEDS_MAX = 5;
const NEEDS_VAR = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const NEEDS_DENY = /^(PATH|HOME|SHELL|IFS|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_EXTRA_CA_CERTS|VYRE_.*|LD_.*|DYLD_.*|PYTHON.*|SSL_CERT_.*|NPM_CONFIG_.*|NODE_TLS_.*|DOCKER_.*|GIT_.*|UV_.*|PIP_.*|XDG_.*)$/i;
const PKG = String.raw`(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*`, VER = String.raw`\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?`;
const PIN_AT = new RegExp(`^${PKG}@${VER}$`), PIN_EQ = new RegExp(`^${PKG}==${VER}$`), IMAGE = /^[A-Za-z0-9][\w.\/:-]*@sha256:[0-9a-f]{64}$/;

/**
 * The name of the hub row for a plugin server that needs keys. It carries a hash of the plugin, the server, the level and the scope, so two plugins whose names share a prefix (or join to the same text) never
 * share a row, and so never share the grants made to a row's watchers. The readable part is cut, never the hash. @param {{ plugin: string, server: string, level: string, scope?: string }} k
 */
export function keyRowName({ plugin, server, level, scope = "" }) {
  const h = sha([plugin, server, level, scope].join("\0")).slice(0, 8);
  const readable = `p-${plugin}-${server}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/-+$/, "").slice(0, 23).replace(/-+$/, "");
  return `${readable}-${h}`;
}

/** Why a server that is given keys is not pinned (an empty string: it is). @param {any} m */
export function pinProblem(m) {
  const cmd = String(m.command || ""), args = (Array.isArray(m.args) ? m.args : []).map(String);
  const how = "a server that is given a key must be pinned: npx, bunx or uvx with name@1.2.3, pipx run with name==1.2.3, or docker or podman run with an image@sha256:digest";
  if (!cmd || cmd.includes("/") || cmd.includes("\\")) return how;
  if (cmd === "npx" || cmd === "bunx" || cmd === "uvx") {
    const i = args.findIndex(a => !a.startsWith("-"));
    if (i < 0 || !args.slice(0, i).every(a => ["-y", "--yes", "-q", "--quiet"].includes(a))) return how;
    return PIN_AT.test(args[i]) ? "" : how;
  }
  if (cmd === "pipx") return args[0] === "run" && PIN_EQ.test(args[1] || "") ? "" : how;
  if (cmd === "docker" || cmd === "podman") {
    if (args[0] !== "run") return how;
    const vars = new Set((Array.isArray(m.needs) ? m.needs : []).map((/** @type {any} */ n) => String(n && n.var)));
    let i = 1;
    for (; i < args.length; i++) {
      const a = args[i];
      if (["--rm", "-i", "--interactive"].includes(a)) continue;
      if ((a === "-e" || a === "--env") && vars.has(args[i + 1] || "")) { i++; continue; }
      break;
    }
    return IMAGE.test(args[i] || "") ? "" : how;
  }
  return how;
}

/** The problems in a server's `needs`. @param {any} m @param {string} at */
function needsProblems(m, at) {
  const out = [];
  if (!Array.isArray(m.needs) || !m.needs.length || m.needs.length > NEEDS_MAX) return [`${at}.needs is a list of 1 to ${NEEDS_MAX} { var, label }`];
  if (m.transport !== "stdio") out.push(`${at}.needs is for a stdio server; an http server takes a Vyre Connection`);
  if (m.connection !== undefined) out.push(`${at} has needs and a connection: use one`);
  const seen = new Set();
  m.needs.forEach((/** @type {any} */ n, /** @type {number} */ j) => {
    const w = `${at}.needs[${j}]`;
    if (!isObj(n) || Object.keys(n).some(k => k !== "var" && k !== "label")) return out.push(`${w} is { var, label } and nothing else (a plugin never carries a value)`);
    if (typeof n.var !== "string" || !NEEDS_VAR.test(n.var)) return out.push(`${w}.var is an environment variable name`);
    if (NEEDS_DENY.test(n.var)) out.push(`${w}.var ${n.var} changes how a program loads or where it connects, so a plugin cannot ask for it`);
    if (seen.has(n.var)) out.push(`${w}.var ${n.var} is named twice`);
    seen.add(n.var);
    if (typeof n.label !== "string" || n.label.trim().length < 2 || n.label.length > 60) out.push(`${w}.label is a short phrase of 2 to 60 characters`);
  });
  if (m.transport === "stdio") { const pin = pinProblem(m); if (pin) out.push(`${at}: ${pin}`); }
  return out;
}

export const validName = (/** @type {unknown} */ n) => typeof n === "string" && NAME.test(n);
export const hashOf = (/** @type {string} */ body) => sha(String(body));

/** The problems in one SKILL.md (an empty list is a good one). @param {string} name @param {string} text @returns {string[]} */
export function skillProblems(name, text) {
  const out = [];
  if (!validName(name)) out.push("a skill's name is lower-case letters, digits, dots, dashes and underscores, up to 64");
  if (typeof text !== "string" || !text.trim()) return [...out, "a skill has text"];
  if (text.length > LIMITS.body) out.push(`a skill is at most ${LIMITS.body / 1024} KB; keep the instructions short and point to a document for the rest`);
  const { data, body } = frontMatter(text);
  if (!data.name || String(data.name) !== name) out.push(`the front matter says name: ${name}`);
  if (!data.description || String(data.description).trim().length < 10) out.push("the front matter has a description of when to use it (what the AI reads to choose it)");
  if (!String(body).trim()) out.push("a skill has instructions after the front matter");
  const secret = credentialIn(text, "share");
  if (secret) out.push(`it contains something that looks like a ${secret}: never write a key into a skill; it would be copied to every AI that uses it`);
  return out;
}

/** The problems in a plugin manifest. @param {any} p @returns {string[]} */
export function pluginProblems(p) {
  // a hook names the provider event it listens to (a capitalised word); which events a provider has is that provider's own list, so only the shape is checked here
  const EVENT = /^[A-Z][A-Za-z]{2,31}$/;
  const out = [];
  if (!isObj(p)) return ["a plugin is { name, description, skills?, commands?, hooks?, mcp? }"];
  for (const k of Object.keys(p)) if (!["name", "description", "skills", "commands", "hooks", "mcp"].includes(k)) out.push(`${k} is not part of a plugin`);
  if (!validName(p.name)) out.push("a plugin's name is lower-case letters, digits, dots, dashes and underscores");
  if (typeof p.description !== "string" || p.description.trim().length < 10) out.push("a plugin has a description");
  if (JSON.stringify(p).length > LIMITS.plugin) out.push(`a plugin is at most ${LIMITS.plugin / 1024} KB`);
  for (const [key, max] of /** @type {Array<[string, number]>} */ ([["skills", LIMITS.skills], ["commands", LIMITS.commands]])) {
    if (p[key] === undefined) continue;
    if (!Array.isArray(p[key]) || p[key].length > max) { out.push(`${key} is a list of at most ${max}`); continue; }
    const seen = new Set();
    p[key].forEach((/** @type {any} */ x, /** @type {number} */ i) => {
      if (!isObj(x) || !validName(x.name) || typeof x.body !== "string") return out.push(`${key}[${i}] is { name, body }`);
      if (seen.has(x.name)) out.push(`two ${key} are named ${x.name}`);
      seen.add(x.name);
      if (key === "skills") out.push(...skillProblems(x.name, x.body).map(m => `skills[${i}]: ${m}`));
      else if (x.body.length > LIMITS.body) out.push(`commands[${i}] is too long`);
      else if (credentialIn(x.body, "share")) out.push(`commands[${i}] contains something that looks like a key`);
    });
  }
  if (p.hooks !== undefined) {
    if (!Array.isArray(p.hooks) || p.hooks.length > LIMITS.hooks) out.push(`hooks are a list of at most ${LIMITS.hooks}`);
    else {
      const ids = new Set();
      p.hooks.forEach((/** @type {any} */ h, /** @type {number} */ i) => {
        const at = `hooks[${i}]`;
        if (!isObj(h) || !validName(h.id) || !EVENT.test(String(h.event)) || typeof h.script !== "string" || !h.script.trim()) return out.push(`${at} is { id, event (a provider event name), script, network? }`);
        for (const k of Object.keys(h)) if (!["id", "event", "script", "network"].includes(k)) out.push(`${at}.${k} is not part of a hook`);
        if (ids.has(h.id)) out.push(`two hooks are named ${h.id}`);
        ids.add(h.id);
        if (h.script.length > LIMITS.script) out.push(`${at}.script is too long`);
        if (credentialIn(h.script, "share")) out.push(`${at}.script contains something that looks like a key`);
        if (h.network !== undefined && (!Array.isArray(h.network) || h.network.length > LIMITS.hosts || h.network.some((/** @type {any} */ x) => typeof x !== "string" || !HOST.test(x)))) out.push(`${at}.network is a list of up to ${LIMITS.hosts} host names, like api.example.com`);
      });
    }
  }
  if (p.mcp !== undefined) {
    if (!Array.isArray(p.mcp) || p.mcp.length > LIMITS.mcp) out.push(`mcp is a list of at most ${LIMITS.mcp}`);
    else p.mcp.forEach((/** @type {any} */ m, /** @type {number} */ i) => {
      const at = `mcp[${i}]`;
      if (!isObj(m) || !/^[a-z][a-z0-9-]{0,24}$/.test(String(m.name)) || !["stdio", "http", "sse"].includes(m.transport)) return out.push(`${at} is { name, transport: stdio | http | sse, command+args | url }`);
      if (m.transport === "stdio" ? typeof m.command !== "string" : typeof m.url !== "string") out.push(`${at} needs ${m.transport === "stdio" ? "a command" : "a url"}`);
      if (m.needs !== undefined) out.push(...needsProblems(m, at));
      if (m.env !== undefined || m.auth !== undefined) out.push(`${at}: a plugin carries no credentials; the Connection it becomes is given one from the Vault by a person`);
      if (m.connection !== undefined && (typeof m.connection !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(m.connection))) out.push(`${at}.connection is the id of a Vault Connection (connectors.connection.list)`);
    });
  }
  return out;
}

/** What a plugin declares it can do beyond text: the hosts each hook may reach and the MCP servers it adds. What the person is asked to say yes to. @param {any} p */
export function declared(p) {
  return { hooks: (p.hooks || []).map((/** @type {any} */ h) => ({ id: h.id, event: h.event, network: [...(h.network || [])].sort() })), mcp: (p.mcp || []).map((/** @type {any} */ m) => ({ name: m.name, transport: m.transport, ...(m.command ? { command: m.command, args: m.args || [] } : {}), ...(m.needs && m.needs.length ? { needs: m.needs.map((/** @type {any} */ n) => ({ var: n.var, label: n.label })) } : {}), ...(m.url ? { url: m.url } : {}) })) };
}
/** A plugin has code when it has a hook or an MCP server. Text-only plugins install like skills. @param {any} p */
export const hasCode = p => Boolean(p && ((p.hooks && p.hooks.length) || (p.mcp && p.mcp.length)));
/** The acknowledgement an approval of a plugin with code must carry: the hash of exactly what it declares, which the card shows. @param {any} p */
export const ackOf = p => sha(JSON.stringify(declared(p)));

/**
 * The approved items one caller sees. Space-level names are enforced for every session: a personal, agent or project skill never replaces a space skill with the same name. Among the rest, the narrower level wins.
 * @param {any[]} items rows { name, level, scope, state, ... } @param {{ person?: string | null, agent?: string | null, projects?: string[], agents?: string[], allAgents?: boolean }} who
 */
export function visibleFor(items, who) {
  return resolveApproved(items, who);
}

/**
 * Write the items for one AI under `dir` and say what was written. Claude and Grok read the Claude plugin layout (Grok reads Claude plugins unchanged); Codex reads `<CODEX_HOME>/skills/<name>/SKILL.md`.
 * Plugins are flattened: their skills and commands are written beside the others; their hooks become entries that run through Vyre's script sandbox (`hookCommand`), never the script itself.
 * @param {string} dir @param {"claude" | "codex" | "grok"} ai @param {{ name: string, kind: string, body: string, level: string }[]} items @param {{ hookCommand?: (plugin: string, hook: string) => string, manifest?: string }} [o]
 * @returns {{ dir: string, skills: string[], commands: string[], hooks: number, mcp: number }}
 */
export function materialise(dir, ai, items, o = {}) {
  if (!AIS.includes(ai)) throw bad(`ai is one of ${AIS.join(", ")}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const skills = new Map(), commands = new Map(), hooks = [], mcp = new Map();
  for (const i of items) {
    if (i.kind === "plugin") {
      const p = JSON.parse(i.body);
      for (const s of p.skills || []) skills.set(s.name, s.body);
      for (const c of p.commands || []) commands.set(c.name, c.body);
      for (const h of p.hooks || []) hooks.push({ plugin: p.name, ...h });
      for (const m of p.mcp || []) if (!mcp.has(m.name)) mcp.set(m.name, m);   // the first plugin to name a server keeps the name
    } else skills.set(i.name, i.body);
  }
  const put = (/** @type {string} */ rel, /** @type {string} */ text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  for (const [name, body] of skills) put(`skills/${name}/SKILL.md`, body);
  // Sources: Claude Code reads a plugin's .mcp.json. Grok: docs.x.ai/build/features/skills-plugins-marketplaces (read 18 Oct 2026) says plugins may carry MCP servers and that Grok "automatically reads Claude Code marketplaces, plugins, skills, MCPs ..."; it
  // documents no MCP table of its own, so Grok gets the same .mcp.json: WRITTEN, NOT YET RUN (needs a real xAI run). Codex: [mcp_servers.<name>] with command/args or url in config.toml (Codex CLI's documented config).
  // The approved MCP servers, in the form each AI reads: Claude and Grok read a plugin's .mcp.json; Codex reads [mcp_servers] in its config.toml, which its driver builds from this neutral list (codexHomeFor).
  // Only the declared shape goes in: a command and its arguments, or a url. No environment and no header ever (a plugin carries no credentials).
  // A server that needs a key is reached only through the hub: written for an AI, its own CLI would start it without the key (and a key must never be in a file here).
  const servers = [...mcp.values()].filter(m => (m.transport === "stdio" || m.transport === "http" || m.transport === "sse") && !(m.needs && m.needs.length));
  if (servers.length) {
    if (ai === "codex") put("mcp.json", JSON.stringify({ servers: servers.map(m => ({ name: m.name, transport: m.transport, ...(m.transport === "stdio" ? { command: m.command, args: m.args || [] } : { url: m.url }) })) }, null, 2));
    else put(".mcp.json", JSON.stringify({ mcpServers: Object.fromEntries(servers.map(m => [m.name, m.transport === "stdio" ? { command: m.command, args: m.args || [] } : { type: m.transport, url: m.url }])) }, null, 2));
  }
  if (ai !== "codex") {
    put(o.manifest || "plugin.json", JSON.stringify({ name: "vyre-library", description: "The skills and plugins approved in this Space for this session.", version: "1.0.0" }, null, 2));
    for (const [name, body] of commands) put(`commands/${name}.md`, body);
    if (hooks.length) {
      const by = /** @type {Record<string, any[]>} */ ({});
      for (const h of hooks) (by[h.event] ||= []).push({ hooks: [{ type: "command", command: (o.hookCommand || ((p, id) => `vyre call skills.hook.run '{"plugin":"${p}","hook":"${id}"}'`))(h.plugin, h.id), timeout: 10 }] });
      put("hooks/hooks.json", JSON.stringify({ hooks: by }, null, 2));
    }
  }
  return { dir, skills: [...skills.keys()].sort(), commands: ai === "codex" ? [] : [...commands.keys()].sort(), hooks: ai === "codex" ? 0 : hooks.length, mcp: servers.length };
}
