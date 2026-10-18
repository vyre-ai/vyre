// Starts a NEW thread with an agent (work.agent.thread.new: agents are persistent and keep many threads), puts the first words in its composer as a draft, and opens it. Used by Files: "Ask about this" starts
// one with the Assistant, "Change it with Engineer" and "New site" start one with Engineer. A thread that cannot be made says so in a toast and nothing opens.
import { showToast } from "@vyre/ui";
import { tool } from "../../src/real/box";
import { writeDraft, type DraftMention } from "../../src/chat/drafts";

type Router = { push: (href: never) => void };

export async function startThread(router: Router, agent: string, text: string, title: string, mentions?: DraftMention[]): Promise<void> {
  try {
    const r = await tool<{ thread?: string }>("work.agent.thread.new", { agent, title: title.slice(0, 120) });
    if (!r || typeof r.thread !== "string" || !r.thread) { showToast("The thread started but Vyre did not say which one. Open it from Chat."); return; }
    writeDraft(r.thread, text, mentions);
    router.push(`/u/chats/${encodeURIComponent(r.thread)}` as never);
  } catch (e) {
    showToast(e instanceof Error && e.message ? e.message : `Could not start a thread with ${agent}.`);
  }
}
