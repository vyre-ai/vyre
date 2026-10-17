// The agent computer's calls for the Computer tab: its status, wake and sleep. The names are fix53's (computers.agent.*); a box without them answers "unknown tool" and the tab says so in words.
import { callT } from "../../src/real/call-tool";
import { computerOf, type ComputerView } from "@vyre/ui";

const said = (e: { message: string; code: string }) => e.message || (/unknown_tool|no_such_tool|not_found/.test(e.code) ? "This server does not have agent computers yet. Update it." : "That did not go through.");

export const agentComputer = {
  async status(agent: string): Promise<{ view: ComputerView } | { problem: string }> {
    const r = await callT("computers.agent.status", { agent });
    return r.error ? { problem: said(r.error) } : { view: computerOf(r.data) };
  },
  async wake(agent: string): Promise<string | null> { const r = await callT("computers.agent.wake", { agent }); return r.error ? said(r.error) : null; },
  /** Empty this agent's home (its Chrome logins, files and terminal state): the right to edit the agent. */
  async reset(agent: string): Promise<string | null> { const r = await callT("computers.agent.reset", { agent }); return r.error ? said(r.error) : null; },
  async sleep(agent: string): Promise<string | null> { const r = await callT("computers.agent.sleep", { agent }); return r.error ? said(r.error) : null; },
};
