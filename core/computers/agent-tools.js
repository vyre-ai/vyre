// @ts-check
// agent-tools: the tools the Chat screen's Computer tab calls (agreed with chat6, 18 Oct 2026).
//
//   computers.agent.status {agent}  -> { agent, state: "none"|"asleep"|"waking"|"live", lastActive, display }
//   computers.agent.wake {agent}    -> the same, after the screen is up (a live agent only counts as used)
//   computers.agent.sleep {agent}   -> the same, after the screen is closed
//   computers.agent.reset {agent}   -> the same; empties THIS agent's home (needs the right to edit the agent)
//
// Who may call: someone with access to the agent. The agents module decides that on its own tools, so the probe is a call it already judges
// against the person behind this call: `agents.used` (Can use) for status, wake and sleep; `agents.docs.get` (Can edit) for reset. A caller
// the agents module refuses is refused here, in the same words. An agent calling for its own computer is allowed by the caller rule in
// index.js (resolve), not here.

const str = { type: "string" };
const obj = (properties, required = []) => ({ type: "object", properties, required });
const AGENT = /^[a-z][a-z0-9._-]{1,80}$/;

/**
 * @param {{ tool: (name: string, description: string, input: any, run: (i: any, meta: any) => Promise<any>, extra?: any) => void,
 *   users: import("./agent-users.js").AgentUsers, call: (tool: string, input: any) => Promise<any>, callers: string[],
 *   held?: (agent: string) => boolean, nameOf?: (agent: string) => Promise<string> }} d
 */
export function registerAgentTools(d) {
  /** @param {string} probe @param {string} agent */
  const mayUse = async (probe, agent) => {
    const r = await d.call(probe, { agent });
    if (r && r.error) throw Object.assign(new Error(r.error.message || "no access to that agent"), { code: r.error.code || "denied" });
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
    obj({ agent: str }, ["agent"]), async i => { const a = agentOf(i); await mayUse("agents.used", a); return shape(a); }, { callers: d.callers });

  d.tool("computers.agent.wake", "Open an agent's screen and Chrome where they were. A live agent is only counted as used. Needs access to the agent.",
    obj({ agent: str }, ["agent"]), async i => { const a = agentOf(i); await mayUse("agents.used", a); await place(a); await d.users.wake(a); return shape(a); }, { callers: d.callers });

  d.tool("computers.agent.sleep", "Close an agent's screen and Chrome now. Its terminal jobs and files stay. Needs access to the agent.",
    obj({ agent: str }, ["agent"]), async i => {
      const a = agentOf(i); await mayUse("agents.used", a);
      if (d.held && d.held(a)) throw Object.assign(new Error("someone is watching or has taken over this computer"), { code: "busy" });
      await d.users.sleep(a); return shape(a);
    }, { callers: d.callers });

  d.tool("computers.agent.reset", "Empty one agent's home on the computer: its Chrome profile and logins, files and terminal state. Nobody else's home is touched. Needs the right to edit the agent.",
    obj({ agent: str }, ["agent"]), async i => {
      const a = agentOf(i); await mayUse("agents.docs.get", a);
      if (!d.users.row(a)) return shape(a);
      await d.users.reset(a); return shape(a);
    }, { callers: d.callers });
}
