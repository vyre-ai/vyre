// An assistant's page on the real box, over an injected `call` (the app's box connection, or a fake box in a test).
import type { Call } from "../settings/real-source";
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
