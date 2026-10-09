// @ts-check
// lib/harness-caps: what a harness can do, detected from what it says about itself at session start (R031-85), and the one rule for whether a skill or a plugin fits it.
// "Detected, not assumed": a capability is true (the harness showed it), false (it showed it has none) or null (it did not say). Only a false hides anything; a harness never seen has no row.

/** The capabilities Vyre names, in the words a skill's `needs` uses. */
export const CAPS = Object.freeze(["skills", "plugins", "mcp", "subagents", "hooks", "images", "resume", "plan_mode", "steering"]);

/** @param {any} v */
const names = (v) => (Array.isArray(v) ? v.map((x) => (x && typeof x === "object" ? String(x.name || x.id || "") : String(x))).filter(Boolean) : null);

/**
 * The facts of one harness from its session-start message. Two shapes arrive on the same wire (core/sessions/conformance.js): Claude Code's init (`tools`, `skills`, `plugins`, `mcp_servers`,
 * `slash_commands`, `claude_code_version`) and an ACP driver's (`harness: { agent, caps, auth }`, built from the agent's `initialize` answer). Only names, counts and booleans are kept.
 * @param {string} provider @param {any} m the init message
 * @returns {{ provider: string, version: string | null, caps: Record<string, boolean | null>, counts: Record<string, number>, auth?: string[] } | null}
 */
export function capsFromInit(provider, m) {
  if (!m || typeof m !== "object") return null;
  const h = m.harness && typeof m.harness === "object" ? m.harness : null;
  const tools = names(m.tools), skills = names(m.skills), plugins = names(m.plugins), servers = names(m.mcp_servers), commands = names(m.slash_commands);
  /** @type {Record<string, boolean | null>} */ const caps = Object.fromEntries(CAPS.map((c) => [c, null]));
  if (skills) caps.skills = skills.length > 0 || (tools ? tools.includes("Skill") : false);
  else if (tools) caps.skills = tools.includes("Skill");
  if (plugins) caps.plugins = plugins.length > 0 || (commands ? commands.some((c) => c.includes(":")) : false);
  if (servers) caps.mcp = true; else if (h && h.caps && (h.caps.mcpHttp !== undefined || h.caps.mcpSse !== undefined)) caps.mcp = Boolean(h.caps.mcpHttp || h.caps.mcpSse);
  if (tools) { caps.subagents = tools.some((t) => t === "Task" || t === "Agent"); caps.plan_mode = tools.includes("ExitPlanMode") || tools.includes("EnterPlanMode"); }
  if (h && h.caps) {
    if (h.caps.image !== undefined) caps.images = Boolean(h.caps.image);
    if (h.caps.loadSession !== undefined) caps.resume = Boolean(h.caps.loadSession);
  }
  const version = typeof m.claude_code_version === "string" ? m.claude_code_version : h && h.agent && typeof h.agent.version === "string" ? h.agent.version : typeof m.version === "string" ? m.version : null;
  const counts = { tools: tools ? tools.length : 0, skills: skills ? skills.length : 0, plugins: plugins ? plugins.length : 0, mcp_servers: servers ? servers.length : 0, commands: commands ? commands.length : 0 };
  if (!tools && !skills && !plugins && !servers && !h) return null;
  return { provider: String(provider), version: version ? version.slice(0, 40) : null, caps, counts, ...(h && Array.isArray(h.auth) ? { auth: h.auth.map(String).slice(0, 8) } : {}) };
}

/**
 * Does a skill or plugin that declares `needs` work on a harness with these caps? `works` is true (everything it needs is shown), "degraded" (something it needs is missing but it says what it does
 * without it, `degrade`), or false (hidden, with the reason). A capability the harness did not say anything about (null) is not held against it.
 * @param {string[] | undefined} needs @param {Record<string, boolean | null> | null | undefined} caps @param {{ degrade?: string, harness?: string }} [o]
 * @returns {{ works: true | "degraded" | false, missing: string[], reason?: string }}
 */
export function fit(needs, caps, o = {}) {
  if (!Array.isArray(needs) || !needs.length || !caps) return { works: true, missing: [] };
  const missing = needs.filter((n) => caps[n] === false);
  if (!missing.length) return { works: true, missing: [] };
  const who = o.harness ? `${o.harness} does not offer` : "this harness does not offer";
  const what = `${who} ${missing.join(" or ")}`;
  return o.degrade ? { works: "degraded", missing, reason: `${what}; without it: ${o.degrade}` } : { works: false, missing, reason: `needs ${missing.join(" and ")}; ${what}` };
}
