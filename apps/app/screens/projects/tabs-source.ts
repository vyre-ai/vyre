// The project page's Brief, Files and Memory on a real vyred, over an injected `call`: projects.list (the project's home and folders), projects.context (the brief), projects.threads and threads.list
// (its chats), harness.touched (the files each thread changed), memory.facts (what was learned in its folders) and github.project.detect and .add-repo (its repos).
import { factsOf, foldersOf, isRecordId, itemsOf, noSlugLine, projectOf, reposOf, touchedRows, type Item } from "./tabs-model.ts";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function projectTabsSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    /** The Project record id and short name a reference names (work.project.ref); null when the box does not know it (an older box without the tool, or a project the caller may not read). */
    async ref(project: string): Promise<{ id: string; slug: string; name: string } | null> {
      const r = await call<{ id?: string; slug?: string; name?: string }>("work.project.ref", { project });
      return r.error || !r.data?.id ? null : { id: String(r.data.id), slug: String(r.data.slug ?? ""), name: String(r.data.name ?? "") };
    },
    /** The short name the box's slug-keyed tools take (projects.context, threads, memory, GitHub), for a Project record id or a short name. Throws plainly when the record has none. */
    async slugOf(project: string): Promise<string> {
      if (!isRecordId(project)) return project;
      const r = await this.ref(project);
      if (!r?.slug) throw Object.assign(new Error(noSlugLine), { code: "no_slug" });
      return r.slug;
    },
    info: async (slug: string) => projectOf(await ask("projects.list"), slug),
    /** The brief text, and the folders the project lives in. */
    async brief(project: string) {
      const slug = await this.slugOf(project);
      const [p, cx] = await Promise.all([this.info(slug), ask<{ text?: string }>("projects.context", { project: slug })]);
      return { project: p, text: String(cx?.text ?? "") };
    },
    /** The project's threads: the Switchboard's live ones on this machine and the recorded ones. A box without the Switchboard has none. */
    async items(project: string): Promise<Item[]> {
      const slug = await this.slugOf(project);
      const [rec, live] = await Promise.all([ask("projects.threads", { project: slug }).catch(() => []), ask("threads.list", { machines: "local" }).catch(() => [])]);
      return itemsOf(live, rec, slug);
    },
    /** The files the project's most recent threads touched. */
    async touched(project: string) {
      const items = (await this.items(project)).slice(0, 12);
      const results = await Promise.all(items.map((it) => call("harness.touched", { session: it.id, limit: 50 })));
      const err = results.find((r) => r.error)?.error;
      return { rows: touchedRows(items, results.map((r) => r.data ?? [])), error: err ? err.message : "" };
    },
    async facts(project: string) {
      const p = await this.info(await this.slugOf(project));
      if (!p) return [];
      return factsOf(await ask("memory.facts", { project_cwds: foldersOf(p), limit: 100 }));
    },
    /** The repos: one row per workspace folder. A box without GitHub has none (null). */
    async repos(project: string) { const r = await call("github.project.detect", { project: await this.slugOf(project) }); return r.error ? null : reposOf(r.data); },
    /** Add a repo to the project as a brand-new folder: it never touches an existing one. */
    async addRepo(project: string, full: string, account: string) { return ask("github.project.add-repo", { project: await this.slugOf(project), repo: full, ...(account ? { account } : {}) }); },
  };
}
