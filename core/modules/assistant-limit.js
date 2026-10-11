// @ts-check
// The person narrowed their own assistant (G23, lib/assistant-access.js): a tool, a family of tools or a whole area they turned off is refused for the assistant acting for them, with the reason in plain words.
// Only the default assistant (no named agent: a named agent has its own grants), judged by the call's kernel chain, which cannot be forged, and only for tools it may otherwise reach; the check is the assistant module's,
// which keeps the person's rows. A door call (the daemon's own internal calls) is checked too: it carries no session of its own, and one that did would be limited like any other. A chat on a lent computer asks the home for its tools as the session's own call (core/runner/lent-home.js), so it passes this same gate. No assistant module running means nothing was narrowed. `proven` is the daemon's own binding of the call to a session; the module then limits only a chain that has an assistant hop, so
// the person's own calls are never limited. A check that fails is a refusal: never a way round the person's limit.
/** Whether the caller label claims a named agent (the registry's own agentClaim, read here without importing the registry). */
const claimsNamed = (/** @type {unknown} */ caller) => /(?:^|[\s:])agent:/.test(String(caller ?? ""));

/**
 * @param {Map<string, any>} tools the registry's tools @param {{ tool: string, caller: string, meta: any }} c
 * @returns {Promise<{ error: { code: string, message: string } } | null>}
 */
export async function assistantLimit(tools, { tool, caller, meta }) {
  // A call that carries no chain at all (a module's own call, a bare label) acts as nobody: no person's limit applies to it. A call in another Space (callInSpace: a team turn, the member door) carries its chain as
  // meta.in_space_chain and no thread, so the thread is not the proof: the chain is, and the module judges it.
  if (!meta || !(meta.in_space_chain || meta.token || meta.kernelFacts || meta.thread)) return null;
  if ((meta.agent && meta.agentKind !== "assistant") || (claimsNamed(caller) && meta.agentKind !== "assistant")) return null;
  const chk = tools.get("assistant.access.check");
  if (!chk) return null;
  let said = null;
  try { said = await chk.run({ tool }, { ...meta, caller: "module:registry" }); }
  catch { return { error: { code: "denied", message: `${tool} could not be checked against what you let your assistant do, so it did not run` } }; }
  return said && said.stopped ? { error: { code: "access_narrowed", message: said.words } } : null;
}
