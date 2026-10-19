// The agent computer's calls for the Computer tab: its status, wake and sleep. The names are fix53's (computers.agent.*); a box without them answers "unknown tool" and the tab says so in words.
import { callT } from "../../src/real/call-tool";
import { computerOf, computerProblem, type ComputerView } from "@vyre/ui";

// The server's words, made plain when an older server answers with its driver's own message (computerProblem).
const said = (e: { message: string; code: string }) => (e.message ? computerProblem(e.message) : "") || (/unknown_tool|no_such_tool|not_found/.test(e.code) ? "This server does not have agent computers yet. Update it." : "That did not go through.");

export const agentComputer = {
  async status(agent: string): Promise<{ view: ComputerView; problem?: string } | { problem: string }> {
    const r = await callT("computers.agent.status", { agent });
    if (r.error) return { problem: said(r.error) };
    // a server that cannot run the computer says why, in plain words: with no computers at all (code "unavailable") there is nothing to wake;
    // after a failed start (no image yet, its computer service refusing or not answering) Wake stays, to try again
    const d = (r.data || {}) as { problem?: unknown; problemCode?: unknown };
    const why = typeof d.problem === "string" ? computerProblem(d.problem) : "";
    if (why && d.problemCode === "unavailable") return { problem: why };
    return why ? { view: computerOf(r.data), problem: why } : { view: computerOf(r.data) };
  },
  async wake(agent: string): Promise<string | null> { const r = await callT("computers.agent.wake", { agent }); return r.error ? said(r.error) : null; },
  /** Empty this agent's home (its Chrome logins, files and terminal state): the right to edit the agent. */
  async reset(agent: string): Promise<string | null> { const r = await callT("computers.agent.reset", { agent }); return r.error ? said(r.error) : null; },
  async sleep(agent: string): Promise<string | null> { const r = await callT("computers.agent.sleep", { agent }); return r.error ? said(r.error) : null; },
};
