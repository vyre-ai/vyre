import { agreeKeyResult, chatKeyProblem } from "../crypto/agree-key";
import { holdersFor, newChatRing } from "../crypto/chat-ring.js";
import { newUuid } from "@vyre/chat-core/composer-state.js";
import { tool } from "../real/box";

/**
 * Every chat is private: this device makes the ring (the server never makes a key). It does not start the chat quietly short of that: no key on this device, this device's agree point not yet published on its
 * identity list, or a participant whose devices cannot agree each stop it with a plain line. Shared by a new chat and by the persistent chats (assistant, Engineer).
 */
export async function ringForNewChat(): Promise<{ id: string; ring: unknown } | { say: string }> {
  const gate = await deviceGate();
  if ("say" in gate) return gate;
  return newChatRing(`chat_${newUuid()}`, gate.holders);
}

/** Whether this device can start a private chat right now, without making one: null when it can, else the line that says why. Cheap enough to ask again when the person comes back or on a timer. */
export async function deviceReadiness(): Promise<string | null> {
  const gate = await deviceGate().catch(() => ({ say: "Vyre did not answer." }));
  return "say" in gate ? gate.say : null;
}

async function deviceGate(): Promise<{ holders: Record<string, any> } | { say: string }> {
  // No store kept this device's key: say which store refused and why, not a vague "not ready" on a timer (the ad-hoc Mac app, v0.6.2).
  const got = await agreeKeyResult();
  if (!got.key) return { say: chatKeyProblem(got.reason) };
  const me = got.key;
  const who = await tool<{ person?: string }>("records.me", {}).catch(() => null);
  if (!who?.person) return { say: "Vyre could not tell who you are, so the chat did not start." };
  const r = await holdersFor((t, i) => tool(t, i ?? {}), [who.person], me);
  if (!r.listed) return { say: "This device isn't ready for private chats yet." };
  if (r.without.length) return { say: "Some devices can't open private chats yet." };
  return { holders: r.holders };
}
