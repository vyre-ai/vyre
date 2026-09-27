// @ts-check
// behalf: whom a module's call is filed for, checked (ADR 0016 decision 8).
//
// mail passes the chat or agent it acts for as `on_behalf: {thread, agent}` to google.mail.send and
// mcp.call, so a held item lands in the thread that asked. That input is trusted only this far:
// - Only from one of Vyre's own modules. The registry sets `meta.firstParty` for a caller whose
//   folder is under core/, over anything passed in, so a module installed into a home cannot
//   claim it and gets nothing from `on_behalf`.
// - A thread must exist, and when it belongs to an agent, the agent named must be that one. A
//   mismatch is refused rather than filed, so a held item never lands in someone else's chat.
// No state; the one lookup goes through the `call` it is given (threads.get).

const fail = (msg, code = "bad_input") => Object.assign(new Error(msg), { code });
const named = v => (typeof v === "string" && v ? v : undefined);

/**
 * @param {(tool: string, input: any) => Promise<any>} call ctx.call
 * @param {{ firstParty?: boolean }} meta the registry's meta for this call
 * @param {any} behalf the input's on_behalf
 * @returns {Promise<{ thread?: string, agent?: string } | null>} null when on_behalf does not apply
 */
export async function checkBehalf(call, meta, behalf) {
  if (!meta || meta.firstParty !== true || !behalf || typeof behalf !== "object") return null;
  const thread = named(behalf.thread), agent = named(behalf.agent);
  if (!thread) return agent ? { agent } : null;
  const r = await call("threads.get", { thread, limit: 1 });
  const rec = r && r.data && (r.data.thread || r.data);
  if (!rec || r.error) throw fail(`on_behalf names thread ${thread.slice(0, 64)}, which does not exist`);
  const owner = named(rec.agent);
  if (agent && owner && owner !== agent) throw fail(`thread ${thread.slice(0, 64)} belongs to agent ${owner}, not ${agent}`, "denied");
  if (agent && !owner) throw fail(`thread ${thread.slice(0, 64)} is a person's session, not agent ${agent}'s`, "denied");
  return { thread, ...(agent || owner ? { agent: agent || owner } : {}) };
}
