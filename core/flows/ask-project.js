// @ts-check
// The project a Flow draft belongs to when the agent was asked in that project's chat and did not name one.
// threads.get returns the thread's project as the short name flows.list filters on. An explicit project on the call wins; this only fills a gap.

const SLUG = /^[a-z0-9][a-z0-9-]{0,119}$/;

/** @param {any} v */
export function projectSlug(v) {
  return typeof v === "string" && SLUG.test(v) ? v : "";
}

/**
 * The calling thread's project slug, or "" when the call already names one, the thread has none, or the lookup fails.
 * @param {any} ctx @param {any} meta @param {any} input
 */
export async function projectFromThread(ctx, meta, input) {
  if (!input || input.project !== undefined || (input.flow && input.flow.project !== undefined)) return "";
  const thread = meta && typeof meta.thread === "string" ? meta.thread : "";
  if (!thread || !ctx || typeof ctx.call !== "function") return "";
  const r = await ctx.call("threads.get", { thread, limit: 1 }).catch(() => null);
  const data = r && r.data !== undefined ? r.data : r;
  return projectSlug(data && data.thread && data.thread.project);
}
