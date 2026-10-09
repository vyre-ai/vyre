import { tool } from "../real/box";
import { chatIdOf } from "./new-chat-model.js";
import { ringForNewChat } from "./chat-start";

export type Persistent = { kind: "assistant" | "engineer"; chat: string | null; allowed: boolean };

/** The person's one chat of this kind (R031-94): the pinned one, else it is started now (the assistant's with nobody listed: it acts as the person; the Engineer's with the engineer agent) and pinned. */
export async function ensurePersistent(kind: "assistant" | "engineer"): Promise<{ chat: string } | { say: string }> {
  const have = await tool<Persistent>("work.chat.persistent", { kind });
  if (!have.allowed) return { say: kind === "engineer" ? "@Engineer is for an owner or an admin of this Space." : "You cannot have that chat." };
  if (have.chat) return { chat: have.chat };
  const made = await ringForNewChat();
  if ("say" in made) return made;
  const id = chatIdOf(await tool("work.chat.create", { title: kind === "engineer" ? "@Engineer" : "Assistant", people: [], agents: kind === "engineer" ? ["engineer"] : [], ...made }));
  if (!id) return { say: "The chat started but Vyre did not say which one." };
  await tool("work.chat.pin", { kind, chat: id });
  return { chat: id };
}
