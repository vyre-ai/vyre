// The project page's Brief, Files and Memory on a real vyred, over an injected `call`: projects.list (the project's home and folders), projects.context (the brief), projects.threads and threads.list
// (its chats), harness.touched (the files each thread changed), memory.facts (what was learned in its folders) and github.project.detect and .add-repo (its repos).
import { factsOf, foldersOf, itemsOf, projectOf, reposOf, touchedRows, type Item } from "./tabs-model.ts";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function projectTabsSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    info: async (slug: string) => projectOf(await ask("projects.list"), slug),
    /** The brief text, and the folders the project lives in. */
    async brief(slug: string) {
      const [p, cx] = await Promise.all([this.info(slug), ask<{ text?: string }>("projects.context", { project: slug })]);
      return { project: p, text: String(cx?.text ?? "") };
    },
    /** The project's threads: the Switchboard's live ones on this machine and the recorded ones. A box without the Switchboard has none. */
    async items(slug: string): Promise<Item[]> {
      const [rec, live] = await Promise.all([ask("projects.threads", { project: slug }).catch(() => []), ask("threads.list", { machines: "local" }).catch(() => [])]);
      return itemsOf(live, rec, slug);
    },
    /** The files the project's most recent threads touched. */
    async touched(slug: string) {
      const items = (await this.items(slug)).slice(0, 12);
      const results = await Promise.all(items.map((it) => call("harness.touched", { session: it.id, limit: 50 })));
      const err = results.find((r) => r.error)?.error;
      return { rows: touchedRows(items, results.map((r) => r.data ?? [])), error: err ? err.message : "" };
    },
    async facts(slug: string) {
      const p = await this.info(slug);
      if (!p) return [];
      return factsOf(await ask("memory.facts", { project_cwds: foldersOf(p), limit: 100 }));
    },
    /** The repos: one row per workspace folder. A box without GitHub has none (null). */
    async repos(slug: string) { const r = await call("github.project.detect", { project: slug }); return r.error ? null : reposOf(r.data); },
    /** Add a repo to the project as a brand-new folder: it never touches an existing one. */
    addRepo: (slug: string, full: string, account: string) => ask("github.project.add-repo", { project: slug, repo: full, ...(account ? { account } : {}) }),
  };
}
