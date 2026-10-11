// @ts-check
// The person narrowed their own assistant (G23, lib/assistant-access.js): a tool, a family of tools or a whole area they turned off is refused for the assistant acting for them, with the reason in plain words.
// Only the proven default assistant (a session the daemon bound the call to, no named agent: a named agent has its own grants) and only for tools it may otherwise reach; the check is the assistant module's, which
// keeps the person's rows. No assistant module running means nothing was narrowed. `proven` is the daemon's own binding of the call to a session; the module then limits only a chain that has an assistant hop, so
// the person's own calls are never limited. A check that fails is a refusal: never a way round the person's limit.
/** Whether the caller label claims a named agent (the registry's own agentClaim, read here without importing the registry). */
const claimsNamed = (/** @type {unknown} */ caller) => /(?:^|[\s:])agent:/.test(String(caller ?? ""));

/**
 * @param {Map<string, any>} tools the registry's tools @param {{ tool: string, door: boolean, caller: string, meta: any }} c
 * @returns {Promise<{ error: { code: string, message: string } } | null>}
 */
export async function assistantLimit(tools, { tool, door, caller, meta }) {
  const proven = Boolean(meta && typeof meta.thread === "string" && meta.thread);
  if (door || !proven || (meta.agent && meta.agentKind !== "assistant") || (claimsNamed(caller) && meta.agentKind !== "assistant")) return null;
  const chk = tools.get("assistant.access.check");
  if (!chk) return null;
  let said = null;
  try { said = await chk.run({ tool }, { ...meta, caller: "module:registry" }); }
  catch { return { error: { code: "denied", message: `${tool} could not be checked against what you let your assistant do, so it did not run` } }; }
  return said && said.stopped ? { error: { code: "access_narrowed", message: said.words } } : null;
}
