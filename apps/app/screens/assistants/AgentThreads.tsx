import { useRouter } from "expo-router";
import { ThreadsTab } from "../../src/chat/ThreadsTab";
import { agentThreads } from "../../src/chat/threads-source";

/**
 * The first tab of an agent's page: every thread with this agent, newest first, from work.agent.threads, with New thread (work.agent.thread.new).
 * Rows are chat6's ThreadsTab; a thread opens in Chats. New thread makes the chat's id and key ring on this device, as every other new thread does, and opens it.
 */
export function AgentThreads({ name }: { name: string }) {
  const router = useRouter();
  const open = (thread: string) => router.push(`/u/chats/${encodeURIComponent(thread)}` as never);
  const onNew = async (): Promise<string | null> => {
    const r = await agentThreads.start(name).catch((e) => ({ problem: e instanceof Error && e.message ? e.message : "That did not work." }));
    if ("problem" in r) return r.problem;
    open(r.thread);
    return null;
  };
  return <ThreadsTab agent={name} onNew={onNew} onSwitch={open} />;
}
