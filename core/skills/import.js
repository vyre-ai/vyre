// @ts-check
// skills/import: turn an uploaded file into the draft the skills library already takes (skills.draft), and say which AI can use each part. Nothing here writes or runs: the result is { kind, name, body } for
// skills.draft (a SKILL.md, or plugin JSON), plus `worksWith`, and `leftOut` for the parts Vyre does not take. The level's owner approves the draft exactly as any other, and a plugin with code needs the owner's ack.
//
// Accepted files: a SKILL.md or any .md with front matter (one skill); a .zip holding one skill folder (SKILL.md at its top or one folder down) or a plugin (.claude-plugin/plugin.json).
// Strict, because the file is a stranger's: a size cap on the zip and on what it inflates to, no entry name with "..", an absolute path, a NUL or a drive letter, no link entry, only the known plugin parts, and the
// names the library allows. A part Vyre does not take is listed in `leftOut` with the reason, never silently dropped and never half-installed.

import path from "node:path";
import { unzip } from "../../lib/zip.js";
import { frontMatter } from "../../lib/docs-corpus.js";
import { validName, skillProblems, pluginProblems, LIMITS, hasCode } from "../../lib/skill-library.js";
import { PLUGIN_LAYOUT } from "../../lib/plugin-layout.js";
import { SKILL_HOMES } from "../../lib/skill-homes.js";

export const IMPORT_LIMITS = Object.freeze({ zip: 2 * 1024 * 1024, inflated: 6 * 1024 * 1024, entries: 400, file: LIMITS.body });
// Grok MCP: written as a Claude-layout .mcp.json (docs.x.ai says Grok reads Claude Code plugins and MCPs); Grok documents no MCP table of its own. Not yet run.
const bad = (/** @type {string} */ message) => Object.assign(new Error(message), { code: "bad_input" });
const KNOWN_TOP = new Set(["skills", "commands", "agents", "hooks", ".mcp.json", ".claude-plugin", "README.md", "LICENSE", "LICENSE.md", "LICENSE.txt", "CHANGELOG.md"]);
const text = (/** @type {Buffer} */ b, /** @type {string} */ what) => { if (b.length > IMPORT_LIMITS.file) throw bad(`${what} is larger than ${IMPORT_LIMITS.file / 1024} KB`); if (b.includes(0)) throw bad(`${what} is not text`); return b.toString("utf8"); };

/**
 * What each AI does with each part of a draft. A fact table, not a promise: `verified` says whether the claim was seen to work (Codex skills were run against Codex CLI 0.159.3; everything on Grok is from its docs and counts only after a real run).
 * @param {{ skills: number, commands: number, hooks: number, mcp: number }} parts
 */
export function worksWith(parts) {
  const homes = Object.keys(SKILL_HOMES);
  const row = (/** @type {number} */ n, /** @type {Record<string, [boolean, string]>} */ by) => n ? Object.fromEntries(homes.map(h => [h, { works: by[h][0], note: by[h][1] }])) : null;
  return {
    skills: row(parts.skills, { claude: [true, "read from the skills folder"], codex: [true, "verified against Codex CLI 0.159.3"], grok: [true, "from Grok's documentation, not yet run"] }),
    commands: row(parts.commands, { claude: [true, "slash commands"], codex: [false, "Codex has no plugin commands; the text is not placed"], grok: [true, "from Grok's documentation (it reads the Claude plugin layout), not yet run"] }),
    hooks: row(parts.hooks, { claude: [true, "run through Vyre's script sandbox"], codex: [false, "Codex has no matching hooks here"], grok: [true, "from Grok's documentation, not yet run"] }),
    mcp: row(parts.mcp, { claude: [true, "placed in the plugin's .mcp.json once approved"], codex: [true, "placed in Codex's config.toml once approved (stdio and http; an sse server is not placed)"], grok: [true, "placed in the plugin's .mcp.json once approved (Grok reads the Claude plugin layout; from its documentation, not yet run)"] }),
  };
}

/** @param {string} t @param {string} fallback */
function skillFrom(t, fallback) {
  const { data } = frontMatter(t);
  const name = String(data.name || fallback);
  const problems = skillProblems(name, t);
  if (problems.length) throw bad(`${name}: ${problems.join("; ")}`);
  return { name, body: t };
}

/**
 * @param {{ file: Buffer, filename?: string }} i
 * @returns {{ kind: "skill" | "plugin", name: string, body: string, worksWith: ReturnType<typeof worksWith>, leftOut: string[], code: boolean }}
 */
export function parseUpload({ file, filename = "" }) {
  if (!Buffer.isBuffer(file) || !file.length) throw bad("the file is empty");
  const isZip = file.length > 4 && file.readUInt32LE(0) === 0x04034b50 || /\.zip$/i.test(filename);
  if (!isZip) {
    const { name, body } = skillFrom(text(file, "the file"), path.basename(filename).replace(/\.md$/i, "").toLowerCase());
    return { kind: "skill", name, body, worksWith: worksWith({ skills: 1, commands: 0, hooks: 0, mcp: 0 }), leftOut: [], code: false };
  }
  if (file.length > IMPORT_LIMITS.zip) throw bad(`the zip is larger than ${IMPORT_LIMITS.zip / 1024 / 1024} MB`);
  /** @type {Map<string, Buffer>} */ let files;
  try { files = unzip(file, { maxEntries: IMPORT_LIMITS.entries, maxBytes: IMPORT_LIMITS.inflated, noLinks: true }); }
  catch (e) { throw bad(/** @type {Error} */ (e).message); }
  // one wrapping folder (what "zip this folder" makes) is looked through
  const tops = new Set([...files.keys()].map(k => k.split("/")[0]));
  let strip = "";
  if (tops.size === 1 && ![...files.keys()].some(k => !k.includes("/")) && !KNOWN_TOP.has([...tops][0])) strip = [...tops][0] + "/";
  /** @type {Map<string, Buffer>} */ const f = new Map([...files].map(([k, v]) => [k.slice(strip.length), v]));
  const manifest = f.get(PLUGIN_LAYOUT.manifest);
  if (!manifest) {
    const sk = f.get("SKILL.md");
    if (!sk) throw bad("this zip is neither a skill (SKILL.md at its top) nor a plugin (.claude-plugin/plugin.json)");
    const { name, body } = skillFrom(text(sk, "SKILL.md"), "");
    const extra = [...f.keys()].filter(k => k !== "SKILL.md");
    return { kind: "skill", name, body, worksWith: worksWith({ skills: 1, commands: 0, hooks: 0, mcp: 0 }), leftOut: extra.length ? [`${extra.length} other file(s) in the skill folder (a skill is its SKILL.md; point to a document for the rest)`] : [], code: false };
  }
  /** @type {string[]} */ const leftOut = [];
  /** @type {any} */ let meta;
  try { meta = JSON.parse(text(manifest, PLUGIN_LAYOUT.manifest)); } catch { throw bad(`${PLUGIN_LAYOUT.manifest} is not JSON`); }
  const plugin = /** @type {any} */ ({ name: String(meta.name || ""), description: String(meta.description || ""), skills: [], commands: [], hooks: [], mcp: [] });
  for (const k of f.keys()) if (!KNOWN_TOP.has(k.split("/")[0])) throw bad(`"${k.split("/")[0]}" is not a part of a plugin (known: skills, commands, agents, hooks, .mcp.json)`);
  for (const [k, v] of f) {
    let m;
    if ((m = /^skills\/([^/]+)\/SKILL\.md$/.exec(k))) { if (!validName(m[1])) throw bad(`the skill folder name ${m[1].slice(0, 40)} is not a valid name`); plugin.skills.push({ name: m[1], body: text(v, k) }); }
    else if ((m = /^commands\/([^/]+)\.md$/.exec(k))) { if (!validName(m[1])) throw bad(`the command name ${m[1].slice(0, 40)} is not a valid name`); plugin.commands.push({ name: m[1], body: text(v, k) }); }
    else if (k === ".mcp.json") {
      /** @type {any} */ let j; try { j = JSON.parse(text(v, k)); } catch { throw bad(".mcp.json is not JSON"); }
      const servers = j && typeof j === "object" ? (j.mcpServers || j) : {};
      for (const [n, s] of Object.entries(servers)) {
        const sv = /** @type {any} */ (s) || {};
        const transport = sv.url ? (sv.type === "sse" ? "sse" : "http") : "stdio";
        if (sv.env || sv.headers) leftOut.push(`mcp ${n}: its env/headers (credentials) were dropped; a person adds them through a Vyre Connection`);
        plugin.mcp.push({ name: String(n).toLowerCase().slice(0, 25), transport, ...(transport === "stdio" ? { command: String(sv.command || ""), args: Array.isArray(sv.args) ? sv.args.map(String) : [] } : { url: String(sv.url) }) });
      }
    }
    else if (k === "hooks/hooks.json") {
      /** @type {any} */ let j; try { j = JSON.parse(text(v, k)); } catch { throw bad("hooks/hooks.json is not JSON"); }
      const events = Object.keys((j && j.hooks) || {});
      const unknown = events.filter(e => !PLUGIN_LAYOUT.events.includes(e));
      if (unknown.length) throw bad(`hooks for ${unknown.join(", ")}: Vyre knows ${PLUGIN_LAYOUT.events.join(", ")}`);
      if (events.length) leftOut.push("hooks: a Claude hook is a shell command on files in the plugin, which Vyre does not run; only hooks written for Vyre's script sandbox are taken (draft it as a Vyre plugin)");
    }
    else if (k.startsWith("agents/")) { if (!leftOut.some(x => x.startsWith("agents"))) leftOut.push("agents: sub-agent definitions are not part of Vyre's library; make an agent in Vyre instead"); }
    else if (k.startsWith("hooks/") || /^(README|LICENSE|CHANGELOG)/.test(k) || k === PLUGIN_LAYOUT.manifest) { /* read above or not needed */ }
    else if (k.startsWith("skills/") || k.startsWith("commands/")) leftOut.push(`${k}: only <name>/SKILL.md and commands/<name>.md are taken`);
  }
  for (const key of ["skills", "commands", "hooks", "mcp"]) if (!plugin[key].length) delete plugin[key];
  const problems = pluginProblems(plugin);
  if (problems.length) throw bad(problems.slice(0, 6).join("; "));
  const counts = { skills: (plugin.skills || []).length, commands: (plugin.commands || []).length, hooks: (plugin.hooks || []).length, mcp: (plugin.mcp || []).length };
  return { kind: "plugin", name: plugin.name, body: JSON.stringify(plugin), worksWith: worksWith(counts), leftOut, code: hasCode(plugin) };
}
