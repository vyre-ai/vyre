// Project templates over an injected `call` (work.template.*): reads on open, every write the person's own or their assistant's draft. The box checks again.
import type { Call } from "../settings/real-source";
import { projectIdOf, type Row, type Version } from "./model.ts";
import { seatCalls } from "./board.ts";

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
    define: (body: unknown, template?: string, note?: string, replace?: boolean): Promise<Version> => ask("work.template.define", { body, ...(template ? { template } : {}), ...(note ? { note } : {}), ...(replace ? { replace: true } : {}) }),
    goLive: (template: string, version: number) => ask("work.template.golive", { template, version }),
    test: (template: string, version: number, sample?: Record<string, unknown>) => ask<{ ok: boolean; lines?: string[]; totals?: string; errors?: { path: string; message: string }[] }>("work.template.test", { template, version, ...(sample ? { sample } : {}) }),
    library: async (): Promise<{ id: string; kit: string; name: string; description: string; stages: number; tasks: number; outline?: { name: string; tasks: string[] }[] }[]> => (await ask<{ templates?: any[] }>("work.template.library")).templates ?? [],
    install: (id: string) => ask<Version>("work.template.install", { id }),
    /** The Flows of this Space a template can attach (only the running ones run for a project). */
    flows: async (): Promise<{ id: string; name: string; active: boolean }[]> => {
      const r = await ask<any>("flows.list");
      const rows: any[] = Array.isArray(r) ? r : Array.isArray(r?.flows) ? r.flows : [];
      return rows.map((x) => ({ id: String(x.id), name: String(x.label || x.name || x.id), active: Boolean(x.active) }));
    },
    /** The assistants of this Space a task can be given to. */
    agents: async (): Promise<{ id: string; name: string }[]> => {
      const r = await ask<any>("agents.list");
      const rows: any[] = Array.isArray(r) ? r : Array.isArray(r?.agents) ? r.agents : [];
      return rows.map((x) => ({ id: String(x.name || x.id), name: String(x.label || x.name || x.id) })).filter((x) => x.id);
    },
    /** A draft template made from a project: its stages when it ran a template, else its tasks and team (a free-flow project). */
    fromProject: (project: string, name?: string): Promise<Version> => ask("work.template.from-project", { project, ...(name ? { name } : {}) }),
    /** Start a project from the live version: its team, its pinned stages and the first stage's tasks. */
    start: async (template: string, name: string, o: { client?: string; lead?: string; team?: string[]; names?: Record<string, string> } = {}) => {
      const r = await ask<{ project: string; slug?: string; tasks_made?: number; tasks_skipped?: { task: string; why: string }[] }>("work.start-project", { template, name, ...(o.client ? { client: o.client } : {}) });
      // the people chosen are seated on the new project (lead, or contributor); one who cannot be is said, the project stands
      const seats_failed: { person: string; why: string }[] = [];
      for (const c of seatCalls(r.slug || projectIdOf(r.project), o)) { try { await ask("work.project.level", c); } catch (e) { seats_failed.push({ person: o.names?.[c.person] || c.person, why: e instanceof Error && e.message ? e.message : "that did not work" }); } }
      return { ...r, seats_failed };
    },
  };
}
