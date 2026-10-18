// @ts-check
// agent-brief: the one place a sentence in an agent's prompt names a tool (team/0.6/DESIGN-agent-prompt.md). A name is written only if the caller's own tool list holds it, and it is written the way
// that runtime can call it: directly when the tool is in the listed core (harness/mcp/core-tools.js), otherwise as `tools_call <name>`. A name the caller cannot reach drops its sentence, so the
// prompt never teaches a tool the agent does not have. The runtime changes only how a tool is NAMED, never what is said or what is allowed.
import { CORE, mcpName } from "../../harness/mcp/core-tools.js";

/** The runtimes a brief is rendered for. `mcp` is a person's own agent reading Vyre's server instructions. */
export const RUNTIMES = Object.freeze(["claude", "codex", "grok", "openrouter", "mcp"]);

const LISTED = new Set(CORE);

/**
 * @param {Iterable<string>} reachable the caller's tool names (registry dotted names or their MCP underscore aliases)
 * @param {string} [runtime]
 */
export function toolNamer(reachable, runtime = "claude") {
  if (!RUNTIMES.includes(runtime)) throw new Error(`no runtime ${JSON.stringify(String(runtime).slice(0, 40))}`);
  const have = new Set();
  for (const n of reachable || []) { have.add(String(n)); have.add(mcpName(String(n))); }
  /**
   * The text to write for a tool, or null when the caller cannot reach it.
   * @param {string} name a registry name such as "vault.request" or an MCP alias
   */
  const tool = name => {
    if (!have.has(name) && !have.has(mcpName(name))) return null;
    const alias = mcpName(name);
    return LISTED.has(alias) ? alias : `tools_call ${name}`;
  };
  /** One sentence built from tool names: the sentence is dropped (empty string) when any name is unreachable. @param {string[]} names @param {(...t: string[]) => string} make */
  const sentence = (names, make) => { const t = names.map(tool); return t.every(x => x !== null) ? make(.../** @type {string[]} */ (t)) : ""; };
  return { tool, sentence, runtime };
}
