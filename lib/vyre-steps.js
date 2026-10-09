// @ts-check
// lib/vyre-steps: what a Vyre tool call is, as a step of repeated work (R031-00s). Shared by the learn module's detector (core/learn/signals.js) and the switchboard's tool events
// (core/switchboard/translate.js), so both name a call the same way. Pure.

/** A Vyre MCP tool, under any prefix the plugin or a session gives it (mcp__vyre__x, mcp__plugin_vyre_vyre__x). @param {string} name */
export const isVyreTool = name => /^mcp__[^]*?vyre[^]*?__[a-z0-9_-]+$/i.test(String(name));
/** The wrappers that carry another tool: the tool that really runs is in their input. */
const WRAPPERS = new Set(["tools_call", "work_call", "tools_run"]);
const TOOLNAME = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * The steps a Vyre tool call is, for the repeated-work detector (R031-00s): `vyre:<tool>` for a tool, the tool that really ran for tools_call (`vyre:google.mail.search`), `vyre:work.call:<tool>` for a
 * records action, and one step per call of a tools_run. Only names, never an argument or a value, so nothing a person typed is kept. Not a Vyre tool, or one the detector must not learn from
 * (the finders and the handle reader: they are how a tool is found, not what the work is), gives [].
 * @param {string} toolName the name the hook saw @param {any} input
 * @returns {string[]}
 */
export function vyreSteps(toolName, input) {
  if (!isVyreTool(toolName)) return [];
  const bare = String(toolName).replace(/^mcp__.*?__/, "");
  const inner = (/** @type {any} */ t) => (typeof t === "string" && TOOLNAME.test(t) ? t : null);
  if (bare === "tools_find" || bare === "results_read" || bare === "vyre_core") return [];
  if (bare === "tools_call") { const t = inner(input && input.tool); return t && !/^results[._]drop$/.test(t) ? [`vyre:${t.replace(/_/g, ".")}`] : []; }
  if (bare === "work_call") { const t = inner(input && input.tool); return [t ? `vyre:work.call:${t}` : "vyre:work.call"]; }
  if (bare === "tools_run") {
    const steps = input && Array.isArray(input.steps) ? input.steps : [];
    return steps.flatMap((/** @type {any} */ x) => { const t = inner(x && x.call); return t ? [`vyre:${t.replace(/_/g, ".")}`] : []; }).slice(0, 20);
  }
  return WRAPPERS.has(bare) ? [] : [`vyre:${bare.replace(/_/g, ".")}`];
}
