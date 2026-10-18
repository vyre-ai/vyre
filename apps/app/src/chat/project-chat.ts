// ensureProjectChat(project): every project has one group chat for its team, and the first teammate whose device opens the project makes it (acct6's work.project.chat). It runs by itself, with no prompt:
// make the chat with a ring made on this device, add the teammates who are missing (this device holds the ring, so it wraps it for them), take out those who should not be in it (a new key epoch), and
// give back the chat. The project page calls it when it opens. The server never makes or holds a project chat's key.
import { getAgreeKey } from "../crypto/agree-key";
import { holdersFor, newChatRing, ringWithPeople, ringWithoutPeople } from "../crypto/chat-ring.js";
import { tool } from "../real/box";
import { projectChatPlan } from "./project-chat-model.js";

export type ProjectChat = { chat: string | null; state: "ready" | "waiting" | "none"; say?: string };

const call = (t: string, i?: Record<string, unknown>) => tool<any>(t, i ?? {});

/** The project's group chat, made or mended on this device when it needs it. `chat` is its id (null while a teammate's device has yet to make it); `say` is the line to show when the keys stopped it. */
export const ensureProjectChat = (project: string) => ensureGroupChat("work.project.chat", { project }, "The project's chat did not open.");

/** The same ring logic for any chat whose people the box decides (a project's team, the people who may use the Engineer): `tool` answers with the project chat's shape. `a` is the last answer, for the caller that needs its people. */
export async function ensureGroupChat(toolName: string, input: Record<string, unknown>, failed: string): Promise<ProjectChat & { answer?: any }> {
  try {
    let a = await call(toolName, input);
    let plan = projectChatPlan(a);
    if (plan.do === "make") {
      const me = await getAgreeKey();
      if (!me) return { chat: null, state: "none", say: "This device can't start private chats yet." };
      const r = await holdersFor(call, plan.people, me);
      if (!r.listed) return { chat: null, state: "none", say: "This device isn't ready for private chats yet." };
      if (r.without.length) return { chat: null, state: "none", say: "Some devices can't open private chats yet." };
      const made = await newChatRing(plan.id, r.holders);
      a = await call(toolName, { ...input, ring: made.ring });
      plan = projectChatPlan(a);
    }
    if (plan.do === "wait") return { chat: null, state: "waiting" };
    if (plan.do === "add" || plan.do === "drop") {
      const me = await getAgreeKey();
      if (!me) return { chat: String(a.chat), state: "ready", say: "This device can't change who is in the project's chat yet." };
      const r = plan.do === "add" ? await ringWithPeople(call, plan.chat, plan.people, me) : await ringWithoutPeople(call, plan.chat, plan.remaining, plan.people, me);
      if ("say" in r) return { chat: String(a.chat), state: "ready", say: r.say };
      await call("work.chat.change", { chat: plan.chat, ...(plan.do === "add" ? { add_people: plan.people } : { remove_people: plan.people }), ring: r.ring });
    }
    return a && a.chat ? { chat: String(a.chat), state: "ready", answer: a } : { chat: null, state: "none" };
  } catch (e) {
    if ((e as { code?: string })?.code === "not_found") return { chat: null, state: "none" }; // a person who may not see this chat sees nothing
    return { chat: null, state: "none", say: e instanceof Error && e.message ? e.message : failed };
  }
}
