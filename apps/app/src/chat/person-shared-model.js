// @ts-check
// What you and one person share (acct6's work.person.shared): your chat with them, the threads you are both in and the projects you are both on. Pure: the answer in rows.

/** @param {unknown} data work.person.shared's answer @returns {{ chat: string, threads: { id: string, title: string }[], count: number, projects: string[] }} */
export function sharedView(data) {
  const d = /** @type {any} */ (data && typeof data === "object" ? data : {});
  const threads = (Array.isArray(d.threads) ? d.threads : []).filter((/** @type {any} */ t) => t && typeof t.thread === "string").map((/** @type {any} */ t) => ({ id: String(t.thread), title: String(t.title || "New thread") }));
  return {
    chat: d.chat && typeof d.chat.chat === "string" ? d.chat.chat : "",
    threads,
    count: Number.isFinite(d.shared_threads) ? Number(d.shared_threads) : threads.length,
    projects: (Array.isArray(d.projects) ? d.projects : []).filter((/** @type {any} */ p) => p && p.name).map((/** @type {any} */ p) => String(p.name)),
  };
}
