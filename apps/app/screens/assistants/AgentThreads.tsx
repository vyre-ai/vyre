import { useRouter } from "expo-router";
import { ThreadsTab } from "../../src/chat/ThreadsTab";
import { tool } from "../../src/real/box";

/**
 * The first tab of an agent's page: every thread with this agent, newest first, from work.agent.threads, with New thread (work.agent.thread.new).
 * Rows are chat6's ThreadsTab; a thread opens in Chats. Nothing here builds a second row.
 */
export function AgentThreads({ name }: { name: string }) {
  const router = useRouter();
  const onNew = async (): Promise<string | null> => {
    try {
      await tool("work.agent.thread.new", { agent: name });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "That did not work.";
    }
  };
  return <ThreadsTab agent={name} onNew={onNew} onSwitch={(thread: string) => router.push(`/u/chats/${thread}` as any)} />;
}
