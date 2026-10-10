// Project templates over an injected `call` (work.template.*): reads on open, every write the person's own or their assistant's draft. The box checks again.
import type { Call } from "../settings/real-source";
import type { Row, Version } from "./model.ts";

export function templatesSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    list: async (): Promise<Row[]> => (await ask<{ templates?: Row[] }>("work.template.list")).templates ?? [],
    versions: async (template: string): Promise<Version[]> => (await ask<{ versions?: Version[] }>("work.template.list", { template })).versions ?? [],
    get: (template: string, version?: number): Promise<Version> => ask("work.template.get", { template, ...(version ? { version } : {}) }),
    define: (body: unknown, template?: string, note?: string): Promise<Version> => ask("work.template.define", { body, ...(template ? { template } : {}), ...(note ? { note } : {}) }),
    goLive: (template: string, version: number) => ask("work.template.golive", { template, version }),
    test: (template: string, version: number, sample?: Record<string, unknown>) => ask<{ ok: boolean; lines?: string[]; totals?: string; errors?: { path: string; message: string }[] }>("work.template.test", { template, version, ...(sample ? { sample } : {}) }),
    library: async (): Promise<{ id: string; kit: string; name: string; description: string; stages: number; tasks: number }[]> => (await ask<{ templates?: any[] }>("work.template.library")).templates ?? [],
    install: (id: string) => ask<Version>("work.template.install", { id }),
    /** Start a project from the live version: its team, its pinned stages and the first stage's tasks. */
    start: (template: string, name: string) => ask<{ project: string; slug?: string; tasks_made?: number; tasks_skipped?: { task: string; why: string }[] }>("work.start-project", { template, name }),
  };
}
