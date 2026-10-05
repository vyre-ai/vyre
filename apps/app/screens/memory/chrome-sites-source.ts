// Memory's Sites tab on a real vyred, over an injected `call`: memory.site.list (the sites and what can still be brought back), memory.site.detail (a site's rows),
// memory.site.forget (a site, one row, or all) and memory.site.restore (its Undo, good for a day). Forget never asks first: every Forget can be undone.
import { forgottenOf, sitesOf, type Detail, type Forgotten, type SiteRow } from "./chrome-sites-model.ts";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;

export function chromeSitesSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    async list(): Promise<{ sites: SiteRow[]; forgotten: Forgotten[] }> {
      const d = await ask("memory.site.list", {});
      return { sites: sitesOf(d), forgotten: forgottenOf(d) };
    },
    detail: (key: string) => ask<Detail>("memory.site.detail", { key }),
    forgetSite: (key: string) => ask("memory.site.forget", { key }),
    forgetAll: () => ask("memory.site.forget", { all: true }),
    forgetRow: (key: string, part: string, id: string) => ask("memory.site.forget", { key, part, id }),
    /** Bring one thing back: a site ({ key }) or a row ({ key, part, id }). True when the box still had it. */
    async restore(k: { key: string; part?: string | null; id?: string | null }): Promise<boolean> {
      const r = await ask<{ restored?: number }>("memory.site.restore", k.part ? { key: k.key, part: k.part, id: k.id } : { key: k.key });
      return Number(r?.restored) > 0;
    },
  };
}
