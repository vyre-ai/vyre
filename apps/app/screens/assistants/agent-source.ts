// An assistant's page on the real box, over an injected `call` (the app's box connection, or a fake box in a test).
import type { Call } from "../settings/real-source";
import type { Permission } from "./standing-model.js";
import { limitsInput, projectsOf, watchersFor, type Computer, type UsageFull, type Watcher, type AgentFull } from "./agent-model.ts";

export function agentSource(call: Call) {
  async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
    const r = await call<T>(tool, input);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.data as T;
  }
  return {
    get: async (name: string): Promise<AgentFull | null> => {
      const d = await ask<any>("agents.list");
      return (Array.isArray(d) ? d : d?.agents || []).find((x: AgentFull) => x.name === name) ?? null;
    },
    /** The box's one model list (sessions.models.get aliases). */
    models: async (): Promise<unknown> => (await ask<any>("sessions.models.get"))?.aliases,
    projects: async () => projectsOf(await ask("projects.list")),
    setJob: (name: string, instructions: string) => ask("agents.update", { name, instructions: instructions.trim() }),
    setModel: (name: string, model: string, effort: string) => ask("agents.update", { name, model, effort }),
    /** Say something to the agent, or give it a task. Returns the thread it landed in. */
    talk: (agent: string, text: string) => ask<{ thread?: string; project?: string }>("agents.ask", { agent, text: text.trim() }),
    wakes: async (agent: string): Promise<Watcher[]> => watchersFor(await ask("watchers.list", {}), agent),
    /** On is watchers.resume, off is watchers.pause; neither takes more than the name. */
    wake: (name: string, on: boolean) => ask(on ? "watchers.resume" : "watchers.pause", { name }),
    usage: async (agent: string): Promise<UsageFull | undefined> => {
      const d = await ask<UsageFull[]>("agents.usage", { agent });
      const list = Array.isArray(d) ? d : [];
      return list.find((x) => x.agent === agent) || list[0];
    },
    computer: (agent: string) => ask<Computer>("computers.get", { agent }),
    giveComputer: (name: string) => ask("agents.update", { name, computer: true }),
    /** Throws the line to show when the numbers are not allowed. */
    setLimits: (agent: string, cores: string, memory: string) => {
      const l = limitsInput(cores, memory);
      if ("problem" in l) return Promise.reject(new Error(l.problem));
      return ask<Computer>("computers.limits", { agent, ...l.input });
    },
    restart: (agent: string) => ask("computers.restart", { agent }),
    /** What the agent may do by itself (gate.standing.*): the list, a new one built by standing-model's addCall, and revoke. */
    standing: async (agent: string): Promise<Permission[]> => (await ask<{ permissions?: Permission[] }>("gate.standing.list", { agent }))?.permissions || [],
    /** Every way out the Gate holds (gate.senders): the name an act goes out under, and what it takes. */
    senders: async (): Promise<{ name: string; kinds: string[] }[]> => { const d = await ask<any>("gate.senders"); return (Array.isArray(d) ? d : d?.senders || []).filter((x: any) => x && typeof x.name === "string").map((x: any) => ({ name: x.name, kinds: Array.isArray(x.kinds) ? x.kinds : [] })); },
    addStanding: (input: Record<string, unknown>) => ask<Record<string, any>>("gate.standing.add", input),
    revokeStanding: (id: string) => ask("gate.standing.revoke", { id }),
    rename: (agent: string, name: string) => ask("computers.rename", { computer: agent, name }),
    /**
     * agents.create, then the computer: a box whose agents.create dropped `computer` made the agent without one,
     * so when it asked for one and the agent came back without, the same agents.update the page's button sends.
     */
    create: async (input: Record<string, unknown> & { name: string; computer?: boolean }): Promise<{ made: AgentFull; computerError: string }> => {
      const made = (await ask<AgentFull>("agents.create", input)) || ({ name: input.name } as AgentFull);
      if (!input.computer || (made as any).computer === true) return { made, computerError: "" };
      try { await ask("agents.update", { name: input.name, computer: true }); return { made: { ...made, computer: true }, computerError: "" }; }
      catch (e) { return { made: { ...made, computer: false }, computerError: e instanceof Error ? e.message : "the box refused" }; }
    },
  };
}
