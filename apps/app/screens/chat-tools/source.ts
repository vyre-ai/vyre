// The chat tools over an injected `call` (the Deck's chat/composer.js and session.js calls, ported). Every tool name and input here is the one the Deck sent.
import type { Call } from "../settings/real-source";
import { appliedOr, failure, historyOf, linkOf, mentionsOf, prCall, redoneLine, sharedRows, tasksOf, transcriptLines, undoneLine, versionsOf, type PrAct, type Result } from "./model.ts";

export function chatToolsSource(call: Call) {
  async function ask<T = any>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  const guard = async (fn: () => Promise<Result>, fallback?: string): Promise<Result> => { try { return await fn(); } catch (e) { return failure(e, fallback); } };
  return {
    /** From the next turn. A null effort is the model's own default. */
    effort: (thread: string, effort: string | null) => guard(async () => { await ask("threads.effort", { thread, ...(effort ? { effort } : {}) }); return { ok: true }; }),
    thinking: (thread: string, on: boolean) => guard(async () => appliedOr(await ask("threads.thinking", { thread, on }), "thinking", "Thinking switches on a running session.")),
    mode: (thread: string, mode: string) => guard(async () => appliedOr(await ask("threads.mode", { thread, mode }), "mode", "The mode applies to a running session.")),
    /** "Fork this chat": a copy from here, or from one message when `at` names it. Answers the new thread. */
    fork: async (thread: string, at?: string): Promise<{ ok: true; thread: string } | { ok: false; reason: string }> => {
      try { const d = await ask<any>("threads.fork", { thread, ...(at ? { at } : {}) }); const t = String(d?.thread ?? d?.id ?? ""); return t ? { ok: true, thread: t } : { ok: false, reason: "The copy did not start." }; } catch (e) { const f = failure(e); return { ok: false, reason: (f as any).reason }; }
    },
    /** A queued message goes now, steering the turn that is running (`queued` is the row's id). */
    sendNow: (thread: string, queued: number) => guard(async () => { const d = await ask<any>("threads.send-now", { thread, queued }); return d?.sent === false ? { ok: false, reason: String(d.note || "It was already sent.") } : { ok: true }; }),
    takeBack: (thread: string, queued: number) => guard(async () => { await ask("threads.unqueue", { thread, queued }); return { ok: true }; }),
    /** Take over a chat another device has, then carry on here. */
    continueHere: (thread: string, machine?: string) => guard(async () => { await ask("threads.continue-here", { thread, ...(machine ? { machine } : {}) }); return { ok: true }; }),
    lease: (thread: string) => ask("threads.lease", { thread }).then(() => undefined, () => undefined),
    tasks: async (thread: string) => tasksOf(await ask("threads.tasks", { thread })),
    stopTask: (thread: string, task: string) => guard(async () => { await ask("threads.kill-task", { thread, task }); return { ok: true }; }),
    /** @ and # in the draft. */
    mentions: async (q: string) => mentionsOf(await ask("mentions.search", { q, limit: 30 })),
    /** What Vyre can see from this chat. Reports where the person is, then reads it back. */
    context: async (thread: string, project?: string | null, cwd?: string | null) => {
      await ask("context.report", { surface: "chat", view: "chat", thread, ...(project ? { project } : {}), ...(cwd ? { cwd } : {}) }).catch(() => undefined);
      return ask<any>("context.now", { surface: "chat" });
    },
    transcript: async (thread: string, limit = 40) => transcriptLines(await ask("recall.transcript", { session: thread, limit })),
    /** Go back to earlier work in this chat's folder, and forward again. */
    history: async (project: string, session: string) => historyOf(await ask("github.session.history", { project, session })),
    undo: (project: string, session: string, to?: string | null) => guard(async () => ({ ok: true, note: undoneLine(await ask("github.session.undo", { project, session, ...(to ? { to } : {}) })) })),
    redo: (project: string, session: string, n?: number) => guard(async () => ({ ok: true, note: redoneLine(await ask("github.session.redo", { project, session, ...(n ? { n } : {}) })) })),
    /** Merge, ask for changes or comment on a pull request; the box asks the person's yes itself. */
    pr: (act: PrAct, base: { project: string; pr: number }, note = "", replyTo?: number | null) => guard(async () => {
      const c = prCall(act, base, note, replyTo);
      if ("problem" in c) return { ok: false, reason: c.problem };
      await ask(c.tool, c.input);
      return { ok: true };
    }),
    /** Teammates of a project, and a question put to one. */
    team: (project: string) => ask("team.list", { project }),
    askTeammate: (to: string, text: string, project?: string) => guard(async () => { await ask("team.ask", { to, text, ...(project ? { project } : {}) }); return { ok: true }; }),
    shared: async () => sharedRows(await ask("artifacts.list", {})),
    artifact: (id: string) => ask<any>("artifacts.get", { id }),
    versions: async (id: string) => versionsOf(await ask("artifacts.versions", { id })),
    /** A public link; the box waits for the person's yes. */
    share: async (id: string, expires?: string): Promise<{ ok: true; url: string } | { ok: false; reason: string }> => {
      try { const url = linkOf(await ask("artifacts.share", { id, ...(expires ? { expires } : {}) })); return url ? { ok: true, url } : { ok: false, reason: "The link is not ready." }; } catch (e) { return { ok: false, reason: (failure(e) as any).reason }; }
    },
    /** A tip the chat showed, and what the person did with it. */
    tip: (how: "seen" | "dismiss" | "used", id: string) => ask(`tips.${how}`, { id }).then(() => undefined, () => undefined),
  };
}
