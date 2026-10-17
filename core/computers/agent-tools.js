// @ts-check
// agent-tools: the tools the Chat screen's Computer tab calls (agreed with chat6, 18 Oct 2026).
//
//   computers.agent.status {agent}  -> { agent, state: "none"|"asleep"|"waking"|"live", lastActive, display }
//   computers.agent.wake {agent}    -> the same, after the screen is up (a live agent only counts as used)
//   computers.agent.sleep {agent}   -> the same, after the screen is closed
//   computers.agent.watch {agent, slow?} -> { ticket, path, width, height }; wakes the agent, and the one-use ticket opens ITS screen in Glass (needs use of the agent)
//   computers.agent.terminals {agent} -> { terminals: [{ name, windows }] }; the agent's tmux sessions (needs use of the agent)
//   computers.agent.terminal.open {agent, session} -> { ticket, path }; a one-use ticket for ONE terminal; it types as the agent, so it needs the right to edit the agent
//   computers.agent.reset {agent}   -> the same; empties THIS agent's home (needs the right to edit the agent)
//
// Who may call: someone with access to the agent. The agents module decides that and says it in one tool, `agents.level` (edit, use or none), judged against the
// person behind this call: any level above none for status, wake and sleep; edit for reset (it deletes a home). Nothing here reads an agent's files to find out. An agent calling for its own computer is allowed by the caller rule in
// index.js (resolve), not here.

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const AGENT = /^[a-z][a-z0-9._-]{1,80}$/;

/**
 * @param {{ tool: (name: string, description: string, input: any, run: (i: any, meta: any) => Promise<any>, extra?: any) => void,
 *   users: import("./agent-users.js").AgentUsers, call: (tool: string, input: any) => Promise<any>, callers: string[],
 *   held?: (agent: string) => boolean, terminal?: (agent: string, session: string) => { ticket: string, path: string }, watch?: (agent: string, slow: boolean, surface: string) => { ticket: string, path: string, width: number, height: number }, nameOf?: (agent: string) => Promise<string> }} d
 */
export function registerAgentTools(d) {
  /** @param {"use" | "edit"} need @param {string} agent */
  const mayUse = async (need, agent) => {
    const r = await d.call("agents.level", { agent });
    if (r && r.error) throw Object.assign(new Error(r.error.message || "no access to that agent"), { code: r.error.code || "denied" });
    const level = r && r.data && r.data.level;
    const ok = need === "edit" ? level === "edit" : level === "edit" || level === "use";
    if (!ok) throw Object.assign(new Error(need === "edit" ? "you cannot change that agent, so you cannot reset its computer: ask its owner" : "you cannot use that agent: ask its owner to share it with you"), { code: "denied" });
  };
  /** @param {any} i */
  const agentOf = i => {
    const agent = String(i && i.agent || "");
    if (!AGENT.test(agent)) throw Object.assign(new Error(`"${agent}" is not an agent`), { code: "bad_input" });
    return agent;
  };
  /** The agent's place on the computer, made on first use so a new agent needs no setup step. @param {string} agent */
  const place = async agent => d.users.row(agent) || d.users.add(agent, d.nameOf ? await d.nameOf(agent) : agent);
  const shape = (/** @type {string} */ agent) => d.users.status(agent);

  d.tool("computers.agent.status", "Where an agent's computer is: none (not set up), asleep, waking or live. Needs access to the agent.",
    obj({ agent: str }, ["agent"]), async i => { const a = agentOf(i); await mayUse("use", a); return shape(a); }, { callers: d.callers });

  d.tool("computers.agent.wake", "Open an agent's screen and Chrome where they were. A live agent is only counted as used. Needs access to the agent.",
    obj({ agent: str }, ["agent"]), async i => { const a = agentOf(i); await mayUse("use", a); await place(a); await d.users.wake(a); return shape(a); }, { callers: d.callers });

  d.tool("computers.agent.watch", "A one-use ticket (30 s) to open this agent's own screen in Glass; it wakes the agent first. slow: the viewer's link is relayed or slow. Needs access to the agent.",
    obj({ agent: str, slow: { type: "boolean" }, surface: str }, ["agent"]), async i => {
      const a = agentOf(i); await mayUse("use", a);
      if (!d.watch) throw new Error("this machine cannot open an agent's screen");
      await place(a); await d.users.wake(a);
      return d.watch(a, i.slow === true, String(i.surface || ""));
    }, { callers: d.callers });

  d.tool("computers.agent.terminals", "The agent's terminals (its tmux sessions), by name. They outlive the screen. Needs access to the agent.",
    obj({ agent: str }, ["agent"]), async i => { const a = agentOf(i); await mayUse("use", a); return { terminals: await d.users.terminals(a) }; }, { callers: d.callers });

  d.tool("computers.agent.terminal.open", "A one-use ticket (30 s) to open one terminal of the agent in Glass; a new name makes the terminal. Typing there is typing as the agent, so it needs the right to edit the agent.",
    obj({ agent: str, session: str }, ["agent", "session"]), async i => {
      const a = agentOf(i); await mayUse("edit", a);
      const session = String(i.session || "");
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(session)) throw Object.assign(new Error("a terminal name is 1 to 40 letters, digits, dots, dashes or underscores"), { code: "bad_input" });
      if (!d.terminal) throw new Error("this machine cannot open an agent's terminal");
      await place(a);
      return d.terminal(a, session);
    }, { callers: d.callers });

  d.tool("computers.agent.sleep", "Close an agent's screen and Chrome now. Its terminal jobs and files stay. Needs access to the agent.",
    obj({ agent: str }, ["agent"]), async i => {
      const a = agentOf(i); await mayUse("use", a);
      if (d.held && d.held(a)) throw Object.assign(new Error("someone is watching or has taken over this computer"), { code: "busy" });
      await d.users.sleep(a); return shape(a);
    }, { callers: d.callers });

  d.tool("computers.agent.reset", "Empty one agent's home on the computer: its Chrome profile and logins, files and terminal state. Nobody else's home is touched. Needs the right to edit the agent.",
    obj({ agent: str }, ["agent"]), async i => {
      const a = agentOf(i); await mayUse("edit", a);
      if (!d.users.row(a)) return shape(a);
      await d.users.reset(a); return shape(a);
    }, { callers: d.callers });
}
