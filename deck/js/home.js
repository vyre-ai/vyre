// @ts-check
// Where "/" goes: the assistant's current thread, the daily one, so the welcome cards are the first
// thing after setup (team-lead ruling, 1 Oct). assistant.daily answers { thread } (rolling to a new
// day's thread when the day turned); when it defers (the assistant is mid-turn) or is missing, the
// assistant's own thread from agents.list stands in; with neither, Now, as before.

/** @param {(name: string, input?: any) => Promise<{ data?: any, error?: any }>} attempt @returns {Promise<string>} */
export async function homePath(attempt) {
  const id = (/** @type {any} */ t) => (typeof t === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(t) ? t : null);
  const daily = await attempt("assistant.daily", {});
  let thread = daily.error ? null : id(daily.data?.thread);
  if (!thread) {
    const list = await attempt("agents.list", {});
    const rows = Array.isArray(list.data) ? list.data : list.data?.agents || [];
    thread = list.error ? null : id(rows.find((/** @type {any} */ a) => a && a.kind === "assistant")?.thread);
  }
  return thread ? `/chat/thread/${encodeURIComponent(thread)}` : "/now";
}
