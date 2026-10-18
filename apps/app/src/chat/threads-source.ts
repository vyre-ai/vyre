// An agent's threads for the panel's Threads tab. The names are the ones agreed with acct6 (agents.threads { agent } -> { threads }, agents.thread.new { agent } -> { thread }); until the box has them
// the tab says so in words. The sample world answers both from memory (mock-computers.ts).
import { callT } from "../real/call-tool";
import { threadRows } from "./threads-model.js";

export type ThreadRow = ReturnType<typeof threadRows>[number];
const said = (e: { message: string; code: string }) => (/unknown_tool|no_such_tool|not_found/.test(e.code) ? "This server does not keep an agent's threads yet. Update it." : e.message || "That did not go through.");

export const agentThreads = {
  async list(agent: string): Promise<{ rows: ThreadRow[] } | { problem: string }> {
    const r = await callT("agents.threads", { agent });
    return r.error ? { problem: said(r.error) } : { rows: threadRows(r.data) };
  },
  /** A new thread with this agent; the old ones stay saved. */
  async start(agent: string): Promise<{ thread: string } | { problem: string }> {
    const r = await callT("agents.thread.new", { agent });
    const id = (r.data as { thread?: unknown } | null)?.thread;
    return r.error ? { problem: said(r.error) } : typeof id === "string" && id ? { thread: id } : { problem: "No thread came back." };
  },
};
