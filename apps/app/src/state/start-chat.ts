import { allowsMock } from "@vyre/ui";
import { tool } from "../real/box";
import { chatIdOf } from "./new-chat-model.js";
import { ringForNewChat } from "./chat-start";
import { ensurePersistent } from "./persistent-chat";

/** work.chat.create for these people and agents (the person is always in it); the new chat's id, or the line to show. */
export async function startChat(sel: { people: string[]; agents: string[] }): Promise<{ chat: string } | { say: string }> {
  // The sample world has no private ring to make: a chat with an agent opens its sample chat, one with a teammate the sample people chat.
  if (allowsMock()) return { chat: sel.agents.length ? "demo-ads" : "demo-people" };
  const made = await ringForNewChat();
  if ("say" in made) return made;
  const id = chatIdOf(await tool("work.chat.create", { people: sel.people, agents: sel.agents, ...made }));
  return id ? { chat: id } : { say: "The chat started but Vyre did not say which one. Open it from Chat." };
}

/** The route of the person's one assistant chat, started the first time. */
export async function assistantChatRoute(): Promise<string> {
  try { const r = await ensurePersistent("assistant"); if ("chat" in r) return `/u/chats/${encodeURIComponent(r.chat)}`; } catch { /* fall through to the list, where the pinned chat is first */ }
  return "/u/chats";
}
