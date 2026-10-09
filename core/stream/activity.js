// @ts-check
// activity: a hand-off to a teammate, and the teammate's work, in the asker's conversation (SPEC-0.3.0 11.1 and 11.2; the frames are in team/0.3/IFACE-activity.md).
//
// team.ask queues a request for a teammate; the team module says so with summon.queued / started / thread / finished (carrying reply_to, the asker's session). This module turns those into
// frames in the asker's conversation: one `handoff` row per request (queued, running, done, failed, cancelled; the teammate's session once it has one; its report on the way out), and the
// teammate's tool steps with `data.via = <request>` so a screen nests them under the row. The frames go into the log a screen already reads, with cursors, so a screen that was closed
// opens the conversation from its last cursor and receives all of it.
//
// Where they go: the chat's group log when the asking session belongs to a chat, else the asking session's own log. Only steps are projected, never a teammate's words: a teammate's text
// reaches the asker as the report (handoff.result, and the teammate-result message the team module posts), and a group's words are written through the kernel, which this does not touch.
import { createAdapter } from "./adapter.js";

/** The teammate frame kinds that go into the asker's conversation. */
const VIA = new Set(["tool-started", "tool-finished", "file-changed"]);
const THREAD_EVENTS = /^(thread\.|ask\.)/;

/**
 * @param {{ ctx: any, logs: import("./log.js").Logs, groups: ReturnType<typeof import("./group.js").createGroups> | null }} o
 */
export function createActivity({ ctx, logs, groups }) {
  /** request -> where its frames go and what the row says so far @type {Map<string, { log: any, author?: string, to: { agent: string, role: string, name: string, project: string }, text: string, model?: string }>} */
  const rows = new Map();
  /** teammate session -> its request and the adapter that reads its events @type {Map<string, { request: string, ad: ReturnType<typeof createAdapter>, author: string }>} */
  const sessions = new Map();

  /** The log a request's frames go into, from the asker's session. @param {string | null} replyTo */
  const targetOf = replyTo => {
    if (!replyTo) return null;
    const g = groups && groups.ofThread ? groups.ofThread(replyTo) : null;
    return g ? { log: logs.get(g.grp), author: g.who } : { log: logs.get(replyTo), author: undefined };
  };
  const agentName = (/** @type {string} */ agent, /** @type {string} */ project) => agent.endsWith(`-${project}`) ? agent.slice(0, -(project.length + 1)) : agent;

  /** Write the row's frame for this state. @param {string} request @param {string} state @param {Record<string, any>} [more] */
  const handoff = (request, state, more = {}) => {
    const r = rows.get(request);
    if (!r) return;
    try {
      r.log.append("handoff", { request, to: r.to, text: r.text, state, ...(r.model ? { model: r.model } : {}), ...more, at: Date.now() }, { ...(r.author ? { author: r.author } : {}) });
    } catch (e) { ctx.log(`stream: handoff ${request}: ${/** @type {Error} */ (e).message}`); }
  };

  /** @param {any} e an event from the bus */
  function onSummon(e) {
    const p = e && e.payload;
    if (!p || typeof p.request !== "string") return;
    if (e.type === "summon.queued") {
      const t = targetOf(p.reply_to || null);
      if (!t) return;
      const project = String(p.project || "");
      rows.set(p.request, { log: t.log, ...(t.author ? { author: t.author } : {}), to: { agent: String(p.teammate), role: String(p.role || agentName(String(p.teammate), project)), name: agentName(String(p.teammate), project), project }, text: String(p.text || ""), ...(p.model ? { model: String(p.model) } : {}) });
      handoff(p.request, "queued");
    } else if (e.type === "summon.started") handoff(p.request, "running");
    else if (e.type === "summon.thread") {
      if (!rows.has(p.request) || typeof p.thread !== "string") return;
      sessions.set(p.thread, { request: p.request, ad: createAdapter(), author: `assistant:${String(p.teammate)}` });
      handoff(p.request, "running", { thread: p.thread });
    } else if (e.type === "summon.finished" || e.type === "summon.cancelled") {
      const state = e.type === "summon.cancelled" ? "cancelled" : p.status === "done" ? "done" : "failed";
      const thread = [...sessions].find(([, s]) => s.request === p.request);
      handoff(p.request, state, { ...(thread ? { thread: thread[0] } : {}), ...(p.result ? { result: String(p.result).slice(0, 600) } : {}) });
      if (thread) sessions.delete(thread[0]);
      rows.delete(p.request);
    }
  }

  /** A switchboard event of a teammate's session: its steps go into the asker's conversation. @param {any} e */
  function onThread(e) {
    const s = e && e.thread ? sessions.get(e.thread) : null;
    if (!s || !THREAD_EVENTS.test(e.type)) return;
    const r = rows.get(s.request);
    if (!r) return;
    let specs = [];
    try { specs = s.ad.event(e); } catch (err) { ctx.log(`stream: ${e.type} for ${e.thread}: ${/** @type {Error} */ (err).message}`); return; }
    for (const sp of specs) {
      if (!VIA.has(sp.kind)) continue;
      try { r.log.append(sp.kind, { ...sp.data, via: s.request }, { turn: sp.turn ?? null, author: s.author }); } catch (err) { ctx.log(`stream: via ${s.request}: ${/** @type {Error} */ (err).message}`); }
    }
  }

  return { onSummon, onThread, open: () => rows.size };
}
