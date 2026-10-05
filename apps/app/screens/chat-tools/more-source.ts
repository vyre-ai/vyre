// The chat tools the first pass left: watcher cards, a spend cap raise, the assistant's welcome, artifact activity, find's calls and the composer's suggestions.
// Every tool name and input is the one the Deck sent.
import type { Call } from "../settings/real-source";
import { activityOf, capDollars, factsOf, fileHitsOf, indexProblem, raiseInput, recallOf, recentFilesOf, watcherCardOf, watcherCall, welcomeOf, type WatcherCard } from "./more-model.ts";
import { editInput, failure, type Result } from "./model.ts";


export function moreToolsSource(call: Call) {
  async function ask<T = any>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  const guard = async (fn: () => Promise<Result>): Promise<Result> => { try { return await fn(); } catch (e) { return failure(e); } };
  return {
    /** A watcher's card: what it will do, before it runs on its own. */
    watcherCard: async (name: string): Promise<WatcherCard | null> => watcherCardOf(await ask("watchers.card", { name })),
    /** Turn on, pause or turn back on. `changed` is set when the code moved after the card was shown. */
    watcher: async (act: "on" | "pause" | "resume", card: Pick<WatcherCard, "name" | "hash">): Promise<{ ok: true } | { ok: false; reason: string; changed?: boolean }> => {
      const c = watcherCall(act, card);
      try { await ask(c.tool, c.input); return { ok: true }; } catch (e) {
        const f: any = failure(e);
        return { ok: false, reason: f.reason, ...(/changed after its card was shown/i.test(f.reason) ? { changed: true } : {}) };
      }
    },
    /** Raise a provider's daily cap (dollars, typed) or take it off (null). Answers the new cap. */
    raiseCap: async (provider: string, raw: string | null): Promise<{ ok: true; cap: number | null } | { ok: false; reason: string }> => {
      const dollars = raw === null ? null : capDollars(raw);
      if (raw !== null && dollars === null) return { ok: false, reason: "Enter an amount in dollars, more than zero." };
      try { const d = await ask<any>("spend.raise", raiseInput(provider, dollars)); return { ok: true, cap: typeof d?.cap === "number" ? d.cap : null }; } catch (e) { return { ok: false, reason: (failure(e) as any).reason }; }
    },
    welcome: async () => welcomeOf(await ask("assistant.welcome")),
    /** Something held at the gate, read for its card. */
    gate: (id: string) => ask<any>("gate.get", { id }),
    /** Change a queued message before it goes. */
    editQueued: (thread: string, queued: number, text: string, mentions: unknown[] = [], pasted: unknown[] = []) => guard(async () => { await ask("threads.edit", editInput(thread, queued, text, mentions, pasted)); return { ok: true }; }),
    closeTerm: (term: string) => guard(async () => { await ask("term.close", { term }); return { ok: true }; }),
    /** What happened to an artifact, and the note the box keeps when a frame leaves its page. */
    activity: async (id: string) => activityOf(await ask("artifacts.activity.log", { id })),
    frameLeft: (id: string) => ask("artifacts.activity.log", { id, kind: "navigated-away" }).then(() => undefined, () => undefined),
    /** Find. */
    searchChats: async (q: string, limit = 20) => recallOf(await ask("recall.search", { q, limit })),
    searchFiles: async (q: string, limit = 20) => fileHitsOf(await ask("files.search", { q, limit })),
    searchMemory: async (text: string, limit = 5) => factsOf(await ask("memory.relevant", { text, limit })),
    recentFiles: async (limit = 8) => recentFilesOf(await ask("files.recent", { limit })),
    related: async (cwd: string, text: string, limit = 3) => recallOf(await ask("recall.related", { project_cwds: [cwd], text, limit })),
    thread: (session: string, from = 0, limit = 400, source?: "mac") => ask<any>("recall.thread", { session, from, limit, ...(source ? { source } : {}) }),
    /** Read the history into recall: null, or the problem in plain words. */
    indexHistory: async (): Promise<string | null> => { try { await ask("recall.index"); return null; } catch (e) { return indexProblem({ code: (e as any).code, message: (e as Error).message }); } },
    preview: (path: string, source?: "mac" | "box") => ask<any>("files.preview", { path, ...(source ? { source } : {}) }),
    catalog: (limit = 300, machines?: "local") => ask<any>("projects.catalog", { limit, ...(machines ? { machines } : {}) }),
    agents: () => ask<any>("agents.list"),
    agentHistory: (limit = 6) => ask<any>("agents.history", { limit }),
    /** Watch a chat until it finishes (or a time), told on the Deck. */
    watch: (thread: string, until: string, notify = "deck") => guard(async () => { await ask("threads.watch", { thread, until, notify }); return { ok: true }; }),
    /** The composer's suggestions: what to ask, and the pick the box learns from. */
    suggest: (text: string, cursor: number) => ask<any>("suggest.query", { text, cursor: Math.max(0, Math.min(cursor, text.length)), surface: "chat" }),
    picked: (row: { kind: string; source: string; id: string }) => ask("suggest.picked", { kind: row.kind, source: row.source, id: row.id }).then(() => undefined, () => undefined),
  };
}
