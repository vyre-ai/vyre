// An agent's threads for the panel's Threads tab, over acct6's tools: work.agent.threads { agent } -> { threads: [{ thread, title, last_active, state }] } and work.agent.thread.new { agent, id, ring } -> { thread }.
// A thread is a chat of the person and the agent: its id is the chat id, so opening one is opening that chat. Until the box has the tools the tab says so in words. The sample world answers both from memory (mock-computers.ts).
import { allowsMock } from "@vyre/ui";
import { callT } from "../real/call-tool";
import { ringForNewChat } from "../state/chat-start";
import { threadRows } from "./threads-model.js";

export type ThreadRow = ReturnType<typeof threadRows>[number];
const said = (e: { message: string; code: string }) => (/unknown_tool|no_such_tool|not_found/.test(e.code) ? "This server does not keep an agent's threads yet. Update it." : e.message || "That did not go through.");

export const agentThreads = {
  async list(agent: string): Promise<{ rows: ThreadRow[] } | { problem: string }> {
    const r = await callT("work.agent.threads", { agent });
    return r.error ? { problem: said(r.error) } : { rows: threadRows(r.data) };
  },
  /** A new thread with this agent; the old ones stay saved. */
  async start(agent: string): Promise<{ thread: string } | { problem: string }> {
    // the device chooses the chat's id and makes its key ring, as work.chat.create does; the sample world has no ring to make
    const made: { say?: string; id?: string; ring?: unknown } = allowsMock() ? {} : await ringForNewChat();
    if (made.say) return { problem: made.say };
    const r = await callT("work.agent.thread.new", { agent, ...made });
    const id = (r.data as { thread?: unknown } | null)?.thread;
    return r.error ? { problem: said(r.error) } : typeof id === "string" && id ? { thread: id } : { problem: "No thread came back." };
  },
};
