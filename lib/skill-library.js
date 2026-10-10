// @ts-check
// The skills and plugins library (R031-18..21), the parts that need no store: what a skill or a plugin is, how it is checked, who sees which at which level, what a plugin declares (so the person is
// asked about exactly that), and how the approved ones are written for each AI. core/skills keeps the versions (records) and the approvals; this file never touches either.
//
//   a skill   a SKILL.md: front matter with `name` and `description`, then the instructions. Any AI that reads the open Agent Skills format uses it unchanged.
//   a plugin  JSON: { name, description, skills: [{ name, body }], commands: [{ name, body }], hooks: [{ id, event, script, network? }], mcp: [{ name, transport, command?, args?, url? }] }
//             Skills and commands are text. A hook is a short script run in Vyre's script sandbox (no network of its own, only the hosts it declares). An MCP server becomes a Connection.
//             A plugin with a hook or an MCP server has CODE: installing it needs its level's owner to say yes to exactly what it declares.
//
// Levels, widest first: space (everyone's agents), personal (one person's, and the agents working for them), agent (one agent's toolkit), project (inside one project). The narrower level wins a name.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { frontMatter } from "./docs-corpus.js";
import { credentialIn } from "./credential-shapes.js";
import { AIS } from "./ai-ids.js";

export const LEVELS = Object.freeze(["space", "personal", "agent", "project"]);
export { AIS };
export const LIMITS = Object.freeze({ body: 64 * 1024, plugin: 256 * 1024, skills: 40, commands: 40, hooks: 10, mcp: 10, hosts: 10, script: 32 * 1024 });
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const bad = (/** @type {string} */ message, code = "bad_input") => Object.assign(new Error(message), { code });
const sha = (/** @type {string} */ s) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const isObj = (/** @type {any} */ v) => v && typeof v === "object" && !Array.isArray(v);

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
  for (const [key, max] of [["skills", LIMITS.skills], ["commands", LIMITS.commands]]) {
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
      if (m.env !== undefined || m.auth !== undefined) out.push(`${at}: a plugin carries no credentials; the Connection it becomes is given one from the Vault by a person`);
    });
  }
  return out;
}

/** What a plugin declares it can do beyond text: the hosts each hook may reach and the MCP servers it adds. What the person is asked to say yes to. @param {any} p */
export function declared(p) {
  return { hooks: (p.hooks || []).map((/** @type {any} */ h) => ({ id: h.id, event: h.event, network: [...(h.network || [])].sort() })), mcp: (p.mcp || []).map((/** @type {any} */ m) => ({ name: m.name, transport: m.transport, ...(m.command ? { command: m.command, args: m.args || [] } : {}), ...(m.url ? { url: m.url } : {}) })) };
}
/** A plugin has code when it has a hook or an MCP server. Text-only plugins install like skills. @param {any} p */
export const hasCode = p => Boolean(p && ((p.hooks && p.hooks.length) || (p.mcp && p.mcp.length)));
/** The acknowledgement an approval of a plugin with code must carry: the hash of exactly what it declares, which the card shows. @param {any} p */
export const ackOf = p => sha(JSON.stringify(declared(p)));

/** The more specific level wins a name. */
const RANK = { space: 0, personal: 1, agent: 2, project: 3 };

/**
 * The approved items one caller sees. `who`: { person, agent, projects }. space: all; personal: the person's own (and the agents working for them); agent: that agent, and its people; project: those the
 * caller reaches. A name present at several levels resolves to the narrowest. @param {any[]} items rows { name, level, scope, state, ... } @param {{ person?: string | null, agent?: string | null, projects?: string[], agents?: string[], allAgents?: boolean }} who
 */
export function visibleFor(items, who) {
  const ok = items.filter(i => i.state === "approved" && (
    i.level === "space" ||
    (i.level === "personal" && who.person && i.scope === who.person) ||
    (i.level === "agent" && ((who.agent && i.scope === who.agent) || (!who.agent && who.person && (who.allAgents || (who.agents || []).includes(i.scope))))) ||
    (i.level === "project" && (who.projects || []).includes(i.scope))));
  const best = new Map();
  for (const i of ok) { const have = best.get(i.name); if (!have || RANK[/** @type {"space"} */ (i.level)] > RANK[/** @type {"space"} */ (have.level)]) best.set(i.name, i); }
  return [...best.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Write the items for one AI under `dir` and say what was written. Claude and Grok read the Claude plugin layout (Grok reads Claude plugins unchanged); Codex reads `<CODEX_HOME>/skills/<name>/SKILL.md`.
 * Plugins are flattened: their skills and commands are written beside the others; their hooks become entries that run through Vyre's script sandbox (`hookCommand`), never the script itself.
 * @param {string} dir @param {"claude" | "codex" | "grok"} ai @param {{ name: string, kind: string, body: string, level: string }[]} items @param {{ hookCommand?: (plugin: string, hook: string) => string, manifest?: string }} [o]
 * @returns {{ dir: string, skills: string[], commands: string[], hooks: number }}
 */
export function materialise(dir, ai, items, o = {}) {
  if (!AIS.includes(ai)) throw bad(`ai is one of ${AIS.join(", ")}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const skills = new Map(), commands = new Map(), hooks = [];
  for (const i of items) {
    if (i.kind === "plugin") {
      const p = JSON.parse(i.body);
      for (const s of p.skills || []) skills.set(s.name, s.body);
      for (const c of p.commands || []) commands.set(c.name, c.body);
      for (const h of p.hooks || []) hooks.push({ plugin: p.name, ...h });
    } else skills.set(i.name, i.body);
  }
  const put = (/** @type {string} */ rel, /** @type {string} */ text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  for (const [name, body] of skills) put(`skills/${name}/SKILL.md`, body);
  if (ai !== "codex") {
    put(o.manifest || "plugin.json", JSON.stringify({ name: "vyre-library", description: "The skills and plugins approved in this Space for this session.", version: "1.0.0" }, null, 2));
    for (const [name, body] of commands) put(`commands/${name}.md`, body);
    if (hooks.length) {
      const by = /** @type {Record<string, any[]>} */ ({});
      for (const h of hooks) (by[h.event] ||= []).push({ hooks: [{ type: "command", command: (o.hookCommand || ((p, id) => `vyre call skills.hook.run '{"plugin":"${p}","hook":"${id}"}'`))(h.plugin, h.id), timeout: 10 }] });
      put("hooks/hooks.json", JSON.stringify({ hooks: by }, null, 2));
    }
  }
  return { dir, skills: [...skills.keys()].sort(), commands: ai === "codex" ? [] : [...commands.keys()].sort(), hooks: ai === "codex" ? 0 : hooks.length };
}
