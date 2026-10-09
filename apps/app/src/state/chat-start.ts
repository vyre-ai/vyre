import { getAgreeKey } from "../crypto/agree-key";
import { holdersFor, newChatRing } from "../crypto/chat-ring.js";
import { newUuid } from "@vyre/chat-core/composer-state.js";
import { tool } from "../real/box";

/**
 * Every chat is private: this device makes the ring (the server never makes a key). It does not start the chat quietly short of that: no key on this device, this device's agree point not yet published on its
 * identity list, or a participant whose devices cannot agree each stop it with a plain line. Shared by a new chat and by the persistent chats (assistant, Engineer).
 */
export async function ringForNewChat(): Promise<{ id: string; ring: unknown } | { say: string }> {
  const me = await getAgreeKey();
  if (!me) return { say: "This device can't start private chats yet." };
  const who = await tool<{ person?: string }>("records.me", {}).catch(() => null);
  if (!who?.person) return { say: "Vyre could not tell who you are, so the chat did not start." };
  const r = await holdersFor((t, i) => tool(t, i ?? {}), [who.person], me);
  if (!r.listed) return { say: "This device isn't ready for private chats yet." };
  if (r.without.length) return { say: "Some devices can't open private chats yet." };
  return newChatRing(`chat_${newUuid()}`, r.holders);
}
