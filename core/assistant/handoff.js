// @ts-check
// handoff: the one notification for work the assistant handed to a teammate (plan 2.6, case 2).
//
// A request the assistant's own thread asked for (reply_to is that thread) files one
// push.proactive when it ends, done or failed. The title is a fixed sentence built from names
// Vyre holds, never the teammate's result text: what it wrote is untrusted and stays in the
// thread. A cancelled request files nothing (the person or the assistant cancelled it). The tag
// is the request, so a re-delivered event is one push. core/push owns the daily cap and quiet
// hours.

const slug = v => String(v ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60);

/**
 * @param {{ request?: string, project?: string, status?: string, reply_to?: string|null }} p summon.finished payload
 * @param {boolean} fromAssistant whether reply_to is a thread of the assistant
 * @returns {{ title: string, path: string, tag: string } | null}
 */
export function handoffPush(p, fromAssistant) {
  if (!p || !fromAssistant || !p.reply_to || !p.request) return null;
  if (p.status !== "done" && p.status !== "failed") return null;
  const project = slug(p.project);
  const where = project ? ` in ${project}` : "";
  return {
    title: p.status === "done" ? `A teammate${where} finished` : `A teammate${where} could not finish`,
    path: `/threads/${encodeURIComponent(String(p.reply_to))}`,
    tag: `handoff-${slug(p.request)}`,
  };
}
