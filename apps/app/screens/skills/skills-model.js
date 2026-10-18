// @ts-check
// Skills and plugins, in plain words: one quiet list per segment (Skills | Plugins) with the state of each in words, and what a plugin needs. Pure, so Node tests it.

/** @typedef {{ id: string, name: string, level: string, scope?: string, description?: string, kind?: string, declares?: any }} Skill */
/** @typedef {{ name: string, level: string, scope?: string, version: number, state: string, kind?: string, proposer?: string, ack?: string, declares?: any }} Version */

export const SEGMENTS = /** @type {const} */ ([["skills", "Skills"], ["plugins", "Plugins"]]);

/** A version's state as a person says it. @param {string} state */
export const stateWord = (state) => (state === "approved" ? "In use" : state === "draft" ? "Waiting for a yes" : state === "retired" ? "Retired" : "");

const isPlugin = (/** @type {{ kind?: string }} */ x) => x.kind === "plugin";

/**
 * The rows of one segment: what is in use, then the drafts waiting for a yes. Each row says its state in words and, for a draft, who proposed it.
 * @param {{ skills?: Skill[], drafts?: Version[] }} pack @param {"skills" | "plugins"} segment
 * @returns {{ key: string, name: string, sub: string, state: string, draft: boolean, skill?: Skill, version?: Version }[]}
 */
export function listRows(pack, segment) {
  const want = (/** @type {{ kind?: string }} */ x) => (segment === "plugins" ? isPlugin(x) : !isPlugin(x));
  const where = (/** @type {{ level: string, scope?: string }} */ x) => [x.level === "personal" ? "Yours" : x.level === "space" ? "This Space" : x.level, x.scope].filter(Boolean).join(", ");
  const inUse = (pack?.skills || []).filter(want).map((s) => ({ key: s.id, name: s.name, sub: [s.description, where(s)].filter(Boolean).join(" · "), state: stateWord("approved"), draft: false, skill: s }));
  const waiting = (pack?.drafts || []).filter(want).map((d) => ({ key: `${d.level}/${d.scope || ""}/${d.name}@${d.version}`, name: d.name, sub: [where(d), d.proposer ? `proposed by ${d.proposer}` : ""].filter(Boolean).join(" · "), state: stateWord("draft"), draft: true, version: d }));
  return [...inUse, ...waiting];
}

/** What a plugin needs, one line each: the hosts its hooks reach and the MCP servers it adds. @param {{ hooks?: { event: string, network?: string[] }[], mcp?: { name: string }[] } | undefined} declares */
export function needsLines(declares) {
  const out = [];
  const hosts = [...new Set((declares?.hooks || []).flatMap((h) => h.network || []))];
  if (hosts.length) out.push(`Reaches ${hosts.join(", ")}`);
  const servers = (declares?.mcp || []).map((m) => m.name).filter(Boolean);
  if (servers.length) out.push(`Adds ${servers.length === 1 ? "the MCP server" : "MCP servers"} ${servers.join(", ")}`);
  return out;
}

/** A version of a skill in the item sheet: "Version 3" and its state in words. @param {Version} v */
export const versionLine = (v) => `Version ${v.version}, ${stateWord(v.state).toLowerCase() || v.state}`;
