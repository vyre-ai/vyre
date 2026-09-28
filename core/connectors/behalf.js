// @ts-check
// behalf: whom a module's call is filed for, checked (ADR 0016 decision 8).
//
// mail passes the chat or agent it acts for as `on_behalf: {thread, agent}` to google.mail.send and
// mcp.call, so a held item lands in the thread that asked. That input is trusted only this far:
// - Only from one of Vyre's own modules. The registry sets `meta.firstParty` by the loader's own
//   rule, over anything passed in. Anyone else who passes `on_behalf` (a home module, a model, a
//   person's CLI) is refused, not quietly ignored, so a mistake shows.
// - A thread must exist, and when it belongs to an agent, the agent named must be that one. A
//   mismatch is refused rather than filed, so a held item never lands in someone else's chat.
// - An agent named without a thread must exist (agents.list).
// No state; the one lookup goes through the `call` it is given (threads.get or agents.list).

const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });
const named = v => (typeof v === "string" && v ? v : undefined);

/**
 * @param {(tool: string, input: any) => Promise<any>} call ctx.call
 * @param {{ firstParty?: boolean }} meta the registry's meta for this call
 * @param {any} behalf the input's on_behalf
 * @returns {Promise<{ thread?: string, agent?: string } | null>} null when there is no on_behalf
 */
export async function checkBehalf(call, meta, behalf) {
  if (behalf === undefined || behalf === null) return null;
  if (!meta || meta.firstParty !== true) throw fail("on_behalf is for Vyre's own modules only", "denied");
  if (typeof behalf !== "object") throw fail("on_behalf must be { thread, agent }");
  const thread = named(behalf.thread), agent = named(behalf.agent);
  if (!thread) {
    if (!agent) return null;
    // An agent with no thread must still be one vyred knows, so no made-up name lands on an item.
    const r = await call("agents.list", {});
    const list = r && Array.isArray(r.data) ? r.data : [];
    if (!list.some(a => a && a.name === agent)) throw fail(`on_behalf names agent ${agent.slice(0, 64)}, which does not exist`);
    return { agent };
  }
  const r = await call("threads.get", { thread, limit: 1 });
  const rec = r && r.data && (r.data.thread || r.data);
  if (!rec || r.error) throw fail(`on_behalf names thread ${thread.slice(0, 64)}, which does not exist`);
  const owner = named(rec.agent);
  if (agent && owner && owner !== agent) throw fail(`thread ${thread.slice(0, 64)} belongs to agent ${owner}, not ${agent}`, "denied");
  if (agent && !owner) throw fail(`thread ${thread.slice(0, 64)} is a person's session, not agent ${agent}'s`, "denied");
  return { thread, ...(agent || owner ? { agent: agent || owner } : {}) };
}
