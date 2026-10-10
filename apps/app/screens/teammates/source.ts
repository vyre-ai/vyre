// A project's teammates over an injected `call`, keyed by the Project record id (cleanup's team.* change; the box refuses a short name): reads on open and after each action, writes all the person's own. The box has no tool that lists a
// teammate's queued asks, so the pane shows how many are queued (team.list) and the one running (team.status).
import type { Call } from "../settings/real-source";
import { dutiesOf, membersOf, teammatesOf, type Duty, type Member, type Pane, type Teammate } from "./model.ts";

export function teammatesSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  const soft = async <T>(tool: string, input: Record<string, unknown>): Promise<{ data?: T; failed: boolean }> => {
    const r = await call<T>(tool, input);
    return r.error ? { failed: true } : { data: r.data, failed: false };
  };
  return {
    list: async (project: string): Promise<Teammate[]> => teammatesOf(await ask("team.list", { project })),
    /** Who is on the project's team by its roles (a template's roster), or nothing when the box cannot say. */
    members: async (project: string): Promise<Member[]> => { const r = await soft<unknown>("work.project.members", { project }); return r.failed ? [] : membersOf(r.data); },
    /** Every teammate the person can see, across projects. */
    all: async (): Promise<Teammate[]> => teammatesOf(await ask("team.list", { all: true })),
    /** Whether new work steers to teammates in this project; null when the box does not say. */
    steer: async (project: string): Promise<boolean | null> => { const r = await soft<{ enabled?: boolean }>("team.default.get", { project }); return r.failed ? null : r.data?.enabled !== false; },
    setSteer: (project: string, enabled: boolean) => ask("team.default.set", { project, enabled }),
    pane: async (t: Teammate): Promise<Pane> => {
      const [notes, charter, duties, status] = await Promise.all([
        soft<{ text?: string }>("team.notes", { action: "get", agent: t.agent }),
        soft<{ charter?: { text?: string } }>("team.charter.get", { teammate: t.agent }),
        soft<unknown>("team.duties.list", { teammate: t.agent }),
        t.current ? soft<{ state?: string; position?: number }>("team.status", { request: t.current }) : Promise.resolve({ data: undefined, failed: false }),
      ]);
      return {
        notes: notes.failed ? null : String(notes.data?.text ?? ""),
        charter: charter.failed ? null : String(charter.data?.charter?.text ?? ""),
        duties: duties.failed ? [] : dutiesOf(duties.data),
        status: status.failed || !status.data ? null : { state: String(status.data.state || ""), position: status.data.position == null ? null : Number(status.data.position) },
        errors: [notes, charter, duties].filter((r) => r.failed).length,
      };
    },
    /** Each project's name, by record id (work.project.ref): one read per id, a refused one is left out. */
    names: async (ids: string[]): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      await Promise.all([...new Set(ids.filter(Boolean))].map(async (id) => { const r = await soft<{ name?: string }>("work.project.ref", { project: id }); if (!r.failed && r.data?.name) out[id] = String(r.data.name); }));
      return out;
    },
    /** The agents that can fill a role (never the person's own assistant). */
    fillers: async (): Promise<string[]> => {
      const r = await soft<any>("agents.list", {});
      const list = Array.isArray(r.data) ? r.data : r.data?.agents || [];
      return list.filter((x: any) => x && x.kind !== "assistant").map((x: any) => String(x.name));
    },
    add: (project: string, role: string, brief = "") => ask("team.add", { project, role, ...(brief.trim() ? { brief: brief.trim() } : {}) }),
    retire: (teammate: string) => ask("team.retire", { teammate }),
    setNotes: (agent: string, text: string) => ask("team.notes", { action: "set", agent, text }),
    setCharter: (teammate: string, text: string) => ask("team.charter.set", { teammate, text }),
    draftCharter: (teammate: string) => ask("team.charter.draft", { teammate }),
    fill: (teammate: string, agent = "") => ask("team.role.fill", { teammate, ...(agent ? { agent } : {}) }),
    dutyOn: (d: Duty) => ask("team.duties.enable", { id: d.id, expect: d.instruction }),
    dutyOff: (d: Duty) => ask("team.duties.disable", { id: d.id }),
    dutyRun: (d: Duty) => ask("team.duties.run-now", { id: d.id }),
  };
}
