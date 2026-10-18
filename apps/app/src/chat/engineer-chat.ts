// ensureEngineerChat: the Engineer is one Space chat with everyone who may use it (acct6's work.engineer.chat, owners and admins). The first device that opens it makes the ring on this device; later devices add or
// drop people as the answer says, exactly as for a project's chat. Anyone else gets nothing back, so nothing shows. Each Engineer conversation is a thread in that chat (startEngineerThread).
import { tool } from "../real/box";
import { newEngineerThread } from "./add-people";
import { engineerThreadPeople } from "./engineer-chat-model.js";
import { ensureGroupChat, type ProjectChat } from "./project-chat";

export type EngineerChat = ProjectChat & { people?: string[] };

export async function ensureEngineerChat(): Promise<EngineerChat> {
  const r = await ensureGroupChat("work.engineer.chat", {}, "The Engineer's chat did not open.");
  const { answer, ...rest } = r;
  return { ...rest, ...(answer && Array.isArray(answer.people) ? { people: answer.people.map(String) } : {}) };
}

/** A new thread in the Engineer's chat: its id, or the line to show (and null when this person has no Engineer chat, so the caller falls back to its own). */
export async function startEngineerThread(): Promise<{ thread: string } | { say: string } | null> {
  const chat = await ensureEngineerChat();
  if (chat.state !== "ready" || !chat.chat) return chat.say ? { say: chat.say } : null;
  const me = await tool<{ person?: string }>("records.me", {}).catch(() => null);
  return newEngineerThread(engineerThreadPeople({ people: chat.people ?? [] }, String(me?.person ?? "")));
}
